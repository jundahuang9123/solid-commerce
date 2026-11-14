/**
 * The user's trusted approval device (e.g. a phone app holding a passkey).
 *
 * A record only becomes "UserConfirmed" when this device signs the canonical
 * digest of its terms. Agents can propose records but cannot produce this
 * signature. Signed by RDF syntax alone, consent would mean nothing.
 *
 * In the prototype the device is in-process. The gateway and the agents only
 * ever see its public key (enrolled out of band).
 */
import { Ed25519Key, digestOf, verifyJsonSignature, keyIdOf } from "../util/crypto.js";
import { confirmableTerms, type Confirmation, type GroundRecord } from "../model.js";
import { normalizeRecord } from "../rdf/records.js";

/**
 * A user's verdict on physically delivered goods (e.g. "the soles are not
 * replaceable after all"). Signed on the device like a record confirmation,
 * so the evidence shows the user, not an agent, made the call. It grants nothing.
 */
export interface DeliveryAttestation { kind: "deliveryAcceptance"; owner: string; transactionId: string; orderId: string; verdict: "Delivered" | "NonCompliant"; checks: string[] }

export type Decider = (summary: string, record: GroundRecord | DeliveryAttestation) => Promise<boolean>;

export const autoApprove: Decider = async () => true;

export function summarize(r: GroundRecord): string {
  switch (r.kind) {
    case "meaning":
      return `AGREED MEANING  "${r.term}" for ${r.scope}: ${r.definition}`;
    case "preference":
    case "requirement": {
      const c = r.criterion;
      return `${r.kind.toUpperCase()} for ${r.appliesTo}: ${c.leftOperand} ${c.operator} ${JSON.stringify(c.rightOperand)}${c.unit ? " " + c.unit : ""}` +
        (r.kind === "preference" ? ` (weight ${r.weight ?? 0.5}; ranking only, grants no spending authority)` : " (offers failing this are rejected)");
    }
    case "mandate":
      return [
        `FINANCIAL AUTHORITY: allow agents [${r.assignees.join(", ")}] to purchase ${r.targets.join(", ")}`,
        `  up to ${r.maxPerTransaction} ${r.currency} per purchase, ${r.totalLimit} ${r.currency} in total,`,
        `  only from: ${r.allowedSellers.join(", ")}`,
        `  via: ${r.allowedSchemes.join(", ")}; valid until ${r.validUntil}`,
      ].join("\n");
  }
}

export class ApprovalDevice {
  private readonly key = Ed25519Key.generate();
  constructor(readonly userWebId: string, private decide: Decider = autoApprove) {}

  get publicJwk() { return this.key.publicJwk; }
  get keyId() { return this.key.keyId; }
  setDecider(d: Decider) { this.decide = d; }

  /** Ask the user to sign a delivery verdict. Returns the signature, or undefined if they decline. */
  async attest(a: DeliveryAttestation): Promise<Confirmation | undefined> {
    if (a.owner !== this.userWebId) throw new Error("Device only attests for its user");
    if (!(await this.decide(summarizeAttestation(a), a))) return undefined;
    return { by: this.userWebId, at: new Date().toISOString(), keyId: this.key.keyId, termsDigest: digestOf(a), signature: this.key.signJson(a) };
  }

  /** Ask the user. Returns the confirmed record, or undefined if rejected. */
  async review<T extends GroundRecord>(proposal: T): Promise<T | undefined> {
    if (proposal.owner !== this.userWebId) throw new Error("Device only approves records owned by its user");
    const record = normalizeRecord(proposal);
    const ok = await this.decide(summarize(record), record);
    if (!ok) return undefined;
    const terms = confirmableTerms(record);
    return {
      ...record,
      status: "UserConfirmed",
      confirmation: {
        by: this.userWebId,
        at: new Date().toISOString(),
        keyId: this.key.keyId,
        termsDigest: digestOf(terms),
        signature: this.key.signJson(terms),
      },
    };
  }
}

export function summarizeAttestation(a: DeliveryAttestation): string {
  return [`DELIVERY ${a.verdict === "Delivered" ? "ACCEPTED" : "NOT AS AGREED"}: order ${a.orderId} (transaction ${a.transactionId})`, ...a.checks.map((c) => "  " + c)].join("\n");
}

export function verifyAttestation(a: DeliveryAttestation, c: Confirmation, enrolledKeys: JsonWebKey[]): boolean {
  const key = enrolledKeys.find((k) => keyIdOf(k) === c.keyId);
  return Boolean(key && c.by === a.owner && c.termsDigest === digestOf(a) && verifyJsonSignature(a, c.signature, key));
}

export type ConfirmationCheck = { ok: true } | { ok: false; reason: string };

/**
 * Verify that a record read back from the Pod was really confirmed by its
 * owner through an enrolled approval key, and has not been edited since.
 */
export function verifyConfirmation(r: GroundRecord, enrolledKeys: JsonWebKey[]): ConfirmationCheck {
  if (r.status !== "UserConfirmed") return { ok: false, reason: `status is ${r.status}` };
  const c = r.confirmation;
  if (!c) return { ok: false, reason: "no confirmation" };
  if (c.by !== r.owner) return { ok: false, reason: "confirmed by someone other than the owner" };
  const key = enrolledKeys.find((k) => keyIdOf(k) === c.keyId);
  if (!key) return { ok: false, reason: "approval key not enrolled" };
  const terms = confirmableTerms(normalizeRecord(r));
  if (digestOf(terms) !== c.termsDigest) return { ok: false, reason: "terms changed after confirmation" };
  if (!verifyJsonSignature(terms, c.signature, key)) return { ok: false, reason: "invalid signature" };
  return { ok: true };
}
