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
import { validateInterpretation } from "./interpretation.js";
import { canonicalJson, newId } from "../util/crypto.js";

export interface GroundingContext {
  meanings: AgreedMeaning[];
  preferences: PreferenceRecord[];       // preferences + requirements
  mandates: SpendingMandate[];
  ignored: Array<{ id: string; reason: string }>;
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

  /** Load every record and keep only those with a valid user confirmation. */
  async load(): Promise<GroundingContext> {
    const ctx: GroundingContext = { meanings: [], preferences: [], mandates: [], ignored: [] };
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
    for (const e of validateInterpretation(interp)) out.notes.push(`Rejected interpreter output: ${e}`);
    const invalid = new Set(validateInterpretation(interp).map((e) => e.match(/"(.*)"/)?.[1]));
    for (const u of interp.unrecognized) out.notes.push(`Not understood (ask the user to rephrase): "${u}"`);

    for (const st of interp.statements) {
      if (invalid.has(st.text)) continue;
      const category = st.category ?? out.intention?.category;
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
        if (current && current.totalLimit === mandate.totalLimit && current.currency === mandate.currency && new Date(current.validUntil) > new Date()) {
          out.reused.push(current);
          out.notes.push("Existing mandate covers this request; no new spending authority requested.");
        } else {
          out.proposals.push(this.withRevision(mandate, ctx));
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

  /** If a record with this id exists, propose the next revision and link to the archived one. */
  private withRevision<T extends GroundRecord>(r: T, ctx: GroundingContext): T {
    const prev = [...ctx.meanings, ...ctx.preferences, ...ctx.mandates].find((x) => x.id === r.id);
    if (!prev) return r;
    const slug = r.id.split("/").pop()!.replace(/\.ttl#it$/, "");
    return { ...r, revision: prev.revision + 1, supersedes: this.layout.historyDoc(slug, prev.revision) };
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
