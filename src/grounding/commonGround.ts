/**
 * Common ground: the evolving, user-controlled store of agreed meanings,
 * preferences and requirements, plus spending mandates. All of it is kept in
 * the buyer's Pod with revision history.
 *
 * Pipeline: interpretation -> validation -> clarification -> user confirmation
 * -> deterministic RDF -> SHACL check -> Pod write (previous revision archived).
 */
import type { AgreedMeaning, Criterion, GroundRecord, PreferenceRecord, SpendingMandate } from "../model.js";
import { confirmableTerms } from "../model.js";
import { PodClient } from "../pod/PodClient.js";
import { PodLayout, slugify } from "../pod/layout.js";
import { parseRecord, recordToTurtle, normalizeRecord } from "../rdf/records.js";
import { validateTurtle } from "../rdf/validate.js";
import { ApprovalDevice, verifyConfirmation } from "./approval.js";
import type { CandidateMeaning, Interpretation, InterpretedStatement } from "./interpretation.js";
import { checkInterpretation } from "./interpretation.js";
import { toAtomic } from "../util/money.js";
import { canonicalJson, newId } from "../util/crypto.js";

export interface GroundingContext {
  meanings: AgreedMeaning[];
  preferences: PreferenceRecord[];       // preferences + requirements
  mandates: SpendingMandate[];
  ignored: Array<{ id: string; reason: string }>;
  /**
   * Per record id: the highest revision for which the history container holds
   * a copy carrying a valid user signature. commit() archives a revision only
   * when it is superseded, so such a copy proves that a newer revision was
   * signed. A live record at or below this revision is a rollback.
   * Optional so contexts built by hand (tests, the comparison harness) stay valid.
   */
  supersededUpTo?: Record<string, number>;
}

export interface ClarificationQuestion {
  id: string;
  term: string;
  scope: string;
  statement: InterpretedStatement;
  options: CandidateMeaning[];
  prompt: string;
}

export interface NegotiationResult {
  intention?: { category: string; subject?: string; text: string };
  questions: ClarificationQuestion[];
  proposals: GroundRecord[];             // need user confirmation
  reused: GroundRecord[];                // already-confirmed common ground applied
  notes: string[];
}

export class CommonGround {
  constructor(
    private readonly pod: PodClient,
    readonly layout: PodLayout,
    private readonly enrolledApprovalKeys: JsonWebKey[],
    private readonly agentId = "agent",
  ) {}

  /**
   * Load every record and keep only those with a valid user confirmation that
   * is also the newest revision the Pod can prove the user signed.
   *
   * Rollback detection: commit() archives the previous revision byte for byte
   * in history/<slug>-r<n>.ttl, signature included. An agent with write access
   * could copy such an archived revision back over the live document; its
   * signature still verifies. So for every live record we look for archived
   * copies of the same record id that verify with an enrolled key. A valid
   * archived copy of revision n proves revision n was superseded, i.e. that a
   * revision > n was signed. A live record whose revision is not greater than
   * every such n is refused and reported in ctx.ignored.
   *
   * What this cannot detect from the Pod alone: an attacker who can write the
   * Pod can also delete the history documents (and any newer revision). Then
   * nothing in the Pod proves the rolled-back revision was ever superseded.
   * Closing that needs state the agent cannot write: the gateway pins the
   * highest mandate revision it has seen per mandate id (done in src/gateway,
   * not here; it only knows revisions it has seen), and meanings and
   * preferences would need a user-signed revision index or a device-held
   * high-water mark, which this prototype does not have.
   * Conversely, planting a validly signed copy of the current revision in
   * history makes the current revision look superseded: that is a denial of
   * service, which Pod write access allows anyway (it can delete the record).
   */
  async load(): Promise<GroundingContext> {
    const ctx: GroundingContext = { meanings: [], preferences: [], mandates: [], ignored: [], supersededUpTo: {} };
    let archived = new Map<string, string[]>();
    try {
      archived = await this.archivedRevisions();
    } catch (e) {
      // Unreadable history (e.g. an ACL that hides it from agents): records still load, but
      // rollbacks cannot be detected here. Say so rather than failing silently.
      ctx.ignored.push({ id: this.layout.history, reason: `history unreadable, rollback check unavailable: ${(e as Error).message}` });
    }
    for (const container of [this.layout.commonGround, this.layout.preferences, this.layout.mandates]) {
      for (const doc of await this.pod.list(container)) {
        if (!doc.endsWith(".ttl")) continue;
        const id = doc + "#it";
        try {
          const res = await this.pod.get(doc);
          if (!res) continue;
          const rec = parseRecord(res.text, id);
          const check = verifyConfirmation(rec, this.enrolledApprovalKeys);
          if (!check.ok) { ctx.ignored.push({ id, reason: check.reason }); continue; }
          const superseded = await this.highestArchived(archived, doc, id);
          if (superseded) ctx.supersededUpTo![id] = superseded.revision;
          if (superseded && !(rec.revision > superseded.revision)) {
            ctx.ignored.push({ id, reason: `rolled back: live revision ${rec.revision} is not newer than signed revision ${superseded.revision} archived as superseded in ${superseded.doc}` });
            continue;
          }
          if (rec.kind === "meaning") ctx.meanings.push(rec);
          else if (rec.kind === "mandate") ctx.mandates.push(rec);
          else ctx.preferences.push(rec);
        } catch (e) {
          ctx.ignored.push({ id, reason: (e as Error).message });
        }
      }
    }
    return ctx;
  }

  /** History documents grouped by slug (<slug>-r<n>.ttl). */
  private async archivedRevisions(): Promise<Map<string, string[]>> {
    const bySlug = new Map<string, string[]>();
    for (const doc of await this.pod.list(this.layout.history)) {
      const m = doc.slice(this.layout.history.length).match(/^(.+)-r\d+\.ttl$/);
      if (!m) continue;
      bySlug.set(m[1], [...(bySlug.get(m[1]) ?? []), doc]);
    }
    return bySlug;
  }

  /**
   * The highest revision of record `id` that the history holds with a valid
   * user signature. Copies that do not parse as this record, or do not verify,
   * prove nothing and are skipped. The revision is read from the signed
   * record, never from the file name.
   */
  private async highestArchived(archived: Map<string, string[]>, liveDoc: string, id: string): Promise<{ revision: number; doc: string } | undefined> {
    const slug = liveDoc.split("/").pop()!.replace(/\.ttl$/, "");
    let best: { revision: number; doc: string } | undefined;
    for (const doc of archived.get(slug) ?? []) {
      try {
        const res = await this.pod.get(doc);
        if (!res) continue;
        const old = parseRecord(res.text, id);
        if (!Number.isInteger(old.revision) || !verifyConfirmation(old, this.enrolledApprovalKeys).ok) continue;
        if (!best || old.revision > best.revision) best = { revision: old.revision, doc };
      } catch { /* not a copy of this record */ }
    }
    return best;
  }

  findMeaning(ctx: GroundingContext, term: string, scope: string): AgreedMeaning | undefined {
    return ctx.meanings.find((m) => m.term === term && m.scope === scope);
  }

  /** Effective criterion of a preference: a grounded preference follows its agreed meaning. */
  effectiveCriterion(ctx: GroundingContext, p: PreferenceRecord): Criterion {
    if (p.groundedIn) {
      const m = ctx.meanings.find((x) => x.id === p.groundedIn);
      if (m) return m.criterion;
    }
    return p.criterion;
  }

  /**
   * Turn an interpretation into questions and proposals, reusing confirmed
   * common ground wherever it already settles a meaning.
   */
  negotiate(interp: Interpretation, ctx: GroundingContext, owner: string, opts: { approvedSellers: string[]; agentIds: string[]; schemesFor: (currency: string) => string[] }): NegotiationResult {
    const out: NegotiationResult = { questions: [], proposals: [], reused: [], notes: [] };
    const check = checkInterpretation(interp);
    for (const e of check.errors) out.notes.push(`Rejected interpreter output: ${e}`);
    for (const u of interp.unrecognized) out.notes.push(`Not understood (ask the user to rephrase): "${u}"`);

    for (const [n, st] of interp.statements.entries()) {
      // By index: statement text is interpreter output and must not be matched back out of messages.
      if (check.invalid.has(n)) continue;
      // The category the statement was validated against (its own, else the latest valid intention's).
      const category = check.categories[n];
      if (st.role === "intention" && category) {
        out.intention = { category, subject: st.subject, text: st.text };
        continue;
      }
      if (st.ambiguousTerm && category) {
        const existing = this.findMeaning(ctx, st.ambiguousTerm.term, category);
        if (existing) {
          out.reused.push(existing);
          const req = this.groundedPreference(existing, st, owner, ctx);
          if (req) out.proposals.push(req);
          else out.reused.push(...ctx.preferences.filter((p) => p.groundedIn === existing.id));
        } else {
          out.questions.push({
            id: newId("q-"),
            term: st.ambiguousTerm.term,
            scope: category,
            statement: { ...st, category },
            options: st.ambiguousTerm.candidates,
            prompt: `You said "${st.ambiguousTerm.term}". For ${category}, what should that mean?`,
          });
        }
        continue;
      }
      if ((st.role === "preference" || st.role === "requirement") && st.criterion && category) {
        const rec = this.preferenceRecord(owner, category, st.role, st.criterion, st.text, st.weight);
        const same = ctx.preferences.find((p) => p.id === rec.id && sameTerms(p, rec));
        if (same) out.reused.push(same);
        else out.proposals.push(this.withRevision(rec, ctx));
        continue;
      }
      if (st.role === "authorization" && st.authorization) {
        const a = st.authorization;
        const targets = [category ?? out.intention?.category ?? "WeatherReport"];
        const validUntil = new Date(Date.now() + (a.validDays ?? 30) * 86_400_000);
        validUntil.setUTCHours(0, 0, 0, 0);
        const slug = slugify(`${targets.join("-")}-${a.currency}`);
        const mandate: SpendingMandate = {
          kind: "mandate", id: this.layout.mandate(slug), owner, revision: 1, status: "Proposed",
          assignees: [...opts.agentIds].sort(), targets,
          currency: a.currency,
          maxPerTransaction: a.maxPerTransaction ?? a.totalLimit,
          totalLimit: a.totalLimit,
          // v1 policy: mandates are always limited to explicitly approved sellers.
          allowedSellers: [...opts.approvedSellers].sort(),
          allowedSchemes: opts.schemesFor(a.currency).sort() as SpendingMandate["allowedSchemes"],
          validUntil: validUntil.toISOString(),
          derivedFrom: st.text, proposedBy: this.agentId,
        };
        const current = ctx.mandates.find((m) => m.id === mandate.id);
        const changes = current ? mandateChanges(current, mandate) : [];
        if (current && changes.length === 0) {
          out.reused.push(current);
          out.notes.push("Existing mandate covers this request; no new spending authority requested.");
        } else {
          const proposal = this.withRevision(mandate, ctx);
          if (current) out.notes.push(`Existing mandate ${current.id} (revision ${current.revision}) does not match this request; proposing revision ${proposal.revision} for approval. Changes: ${changes.join("; ")}`);
          out.proposals.push(proposal);
        }
      }
    }
    return out;
  }

  /** The user picked an option (index) or described the meaning in their own words (criterion). */
  answer(q: ClarificationQuestion, choice: number | { definition: string; criterion: Criterion }, owner: string, ctx: GroundingContext): GroundRecord[] {
    const picked = typeof choice === "number" ? q.options[choice] : { label: "user-defined", ...choice };
    if (!picked) throw new Error("Invalid choice");
    const meaning: AgreedMeaning = this.withRevision({
      kind: "meaning", id: this.layout.meaning(slugify(`${q.scope}-${q.term}`)), owner, revision: 1, status: "Proposed",
      term: q.term, scope: q.scope, definition: picked.definition, criterion: picked.criterion,
      derivedFrom: q.statement.text, proposedBy: this.agentId,
    }, ctx);
    const pref = this.groundedPreference(meaning, q.statement, owner, ctx, true);
    return pref ? [meaning, pref] : [meaning];
  }

  private groundedPreference(m: AgreedMeaning, st: InterpretedStatement, owner: string, ctx: GroundingContext, force = false): PreferenceRecord | undefined {
    const role = st.role === "preference" ? "preference" : "requirement";
    const rec = { ...this.preferenceRecord(owner, m.scope, role, m.criterion, st.text, st.weight), groundedIn: m.id };
    const existing = ctx.preferences.find((p) => p.id === rec.id);
    if (!force && existing && sameTerms(existing, rec)) return undefined;
    return this.withRevision(rec, ctx);
  }

  private preferenceRecord(owner: string, category: string, role: "preference" | "requirement", c: Criterion, text: string, weight?: number): PreferenceRecord {
    return {
      kind: role, id: this.layout.preference(slugify(`${category}-${c.leftOperand}`)), owner, revision: 1, status: "Proposed",
      appliesTo: category, criterion: c, derivedFrom: text, proposedBy: this.agentId,
      ...(role === "preference" ? { weight: Math.round((weight ?? 0.5) * 100) / 100 } : {}),
    };
  }

  /**
   * If a record with this id exists, propose the next revision and link to the archived one.
   * If the live record was refused as a rollback, the next revision must still be newer than
   * anything the history proves was signed: revision n archived means n+1 existed, so propose
   * n+2. The refused live bytes are then archived in the slot of revision n+1 (whose own
   * document is gone); load() reads revisions from the signed content, not the file name.
   */
  private withRevision<T extends GroundRecord>(r: T, ctx: GroundingContext): T {
    const prev = [...ctx.meanings, ...ctx.preferences, ...ctx.mandates].find((x) => x.id === r.id);
    const slug = r.id.split("/").pop()!.replace(/\.ttl#it$/, "");
    if (prev) return { ...r, revision: prev.revision + 1, supersedes: this.layout.historyDoc(slug, prev.revision) };
    const archived = ctx.supersededUpTo?.[r.id];
    if (archived === undefined) return r;
    return { ...r, revision: archived + 2, supersedes: this.layout.historyDoc(slug, archived + 1) };
  }

  /**
   * Ask the user to confirm a proposal on the approval device, then write it.
   * Rejected proposals are kept (status Rejected) as part of the negotiation record.
   */
  async commit<T extends GroundRecord>(proposal: T, device: ApprovalDevice): Promise<T | undefined> {
    const proposalTtl = await recordToTurtle(proposal);
    const check = await validateTurtle(proposalTtl, proposal.id.split("#")[0]);
    if (!check.conforms) throw new Error("Proposal fails SHACL: " + check.messages.join(" | "));

    const confirmed = await device.review(proposal);
    const proposalDoc = this.layout.proposals + newId() + ".ttl";
    if (!confirmed) {
      const rejected = { ...proposal, id: proposalDoc + "#it", status: "Rejected" as const };
      await this.pod.putTurtle(proposalDoc, await recordToTurtle(rejected));
      return undefined;
    }
    const doc = confirmed.id.split("#")[0];
    const ttl = await recordToTurtle(confirmed);
    const final = await validateTurtle(ttl, doc);
    if (!final.conforms) throw new Error("Confirmed record fails SHACL: " + final.messages.join(" | "));

    const existing = await this.pod.get(doc);
    if (existing && confirmed.supersedes) {
      // Archive the previous revision byte-for-byte: it keeps its original subject IRI,
      // so its user signature remains verifiable from the history document.
      await this.pod.putTurtle(confirmed.supersedes, existing.text);
      await this.pod.putTurtle(doc, ttl, { ifMatch: existing.etag });
    } else {
      await this.pod.putTurtle(doc, ttl, existing ? {} : { ifNoneMatch: true });
    }
    return confirmed;
  }
}

function sameTerms(a: GroundRecord, b: GroundRecord): boolean {
  const strip = (r: GroundRecord) => {
    const { revision: _r, supersedes: _s, derivedFrom: _d, ...t } = confirmableTerms(normalizeRecord(r)) as Record<string, unknown>;
    return canonicalJson(t);
  };
  return strip(a) === strip(b);
}

/**
 * How a requested mandate differs from the confirmed one with the same id.
 * Empty means the existing mandate can be reused: it grants nothing beyond the
 * request in any term (total, per purchase, expiry, targets, agents, sellers,
 * schemes), and it is not narrower than the request either, except that an
 * earlier (still future) expiry is accepted, since the requested expiry is
 * recomputed from "now" on every request.
 * A broader existing term would silently keep authority the user did not just
 * ask for; a narrower one would silently drop what the user asked for. Both are
 * shown to the user as a new revision instead.
 */
export function mandateChanges(current: SpendingMandate, requested: SpendingMandate, now = new Date()): string[] {
  const changes: string[] = [];
  const amount = (v: string, cur: string) => { try { return BigInt(toAtomic(v, cur)); } catch { return undefined; } };
  const sameAmount = (a: string, b: string, cur: string) => { const x = amount(a, cur), y = amount(b, cur); return x !== undefined && x === y; };
  const sorted = (a: readonly string[]) => [...a].sort();
  const sameSet = (a: readonly string[], b: readonly string[]) => canonicalJson(sorted(a)) === canonicalJson(sorted(b));
  const list = (a: readonly string[]) => `[${sorted(a).join(", ")}]`;
  if (current.currency !== requested.currency) changes.push(`currency ${current.currency} -> ${requested.currency}`);
  else {
    if (!sameAmount(current.totalLimit, requested.totalLimit, current.currency)) changes.push(`total ${current.totalLimit} -> ${requested.totalLimit} ${requested.currency}`);
    if (!sameAmount(current.maxPerTransaction, requested.maxPerTransaction, current.currency)) changes.push(`per purchase ${current.maxPerTransaction} -> ${requested.maxPerTransaction} ${requested.currency}`);
  }
  const until = new Date(current.validUntil).getTime();
  if (!(until > now.getTime())) changes.push(`expired ${current.validUntil}; new expiry ${requested.validUntil}`);
  else if (!(until <= new Date(requested.validUntil).getTime())) changes.push(`valid until ${current.validUntil} -> ${requested.validUntil}`);
  if (!sameSet(current.targets, requested.targets)) changes.push(`targets ${list(current.targets)} -> ${list(requested.targets)}`);
  if (!sameSet(current.assignees, requested.assignees)) changes.push(`agents ${list(current.assignees)} -> ${list(requested.assignees)}`);
  if (!sameSet(current.allowedSellers, requested.allowedSellers)) changes.push(`sellers ${list(current.allowedSellers)} -> ${list(requested.allowedSellers)}`);
  if (!sameSet(current.allowedSchemes, requested.allowedSchemes)) changes.push(`schemes ${list(current.allowedSchemes)} -> ${list(requested.allowedSchemes)}`);
  return changes;
}
