/**
 * Approved sellers, each bound to a pinned offer-signing key.
 *
 * v1 policy: only explicitly approved sellers. A valid signature makes an
 * offer an attributable commitment by that seller. It does NOT prove the
 * product claims are true; delivery checks and receipts cover that.
 */
import type { Offer } from "../model.js";
import { digestOf, keyIdOf, verifyEnvelope, type Signed } from "../util/crypto.js";

export interface ApprovedSeller { webId: string; name: string; publicJwk: JsonWebKey; approvedAt: string }

export type OfferCheck = { ok: true; digest: string } | { ok: false; code: "SELLER_NOT_APPROVED" | "BAD_SIGNATURE" | "OFFER_EXPIRED" | "KEY_MISMATCH"; reason: string };

export class TrustRegistry {
  private sellers = new Map<string, ApprovedSeller>();
  approve(s: Omit<ApprovedSeller, "approvedAt">) { this.sellers.set(s.webId, { ...s, approvedAt: new Date().toISOString() }); }
  revoke(webId: string) { this.sellers.delete(webId); }
  get(webId: string) { return this.sellers.get(webId); }
  list() { return [...this.sellers.values()]; }
  isApproved(webId: string) { return this.sellers.has(webId); }

  checkOffer(signed: Signed<Offer>, now = new Date()): OfferCheck {
    const seller = this.sellers.get(signed?.payload?.seller);
    if (!seller) return { ok: false, code: "SELLER_NOT_APPROVED", reason: `${signed?.payload?.seller} is not an approved seller` };
    if (signed.sig.keyId !== keyIdOf(seller.publicJwk)) return { ok: false, code: "KEY_MISMATCH", reason: "offer signed with a key that is not pinned for this seller" };
    if (!verifyEnvelope(signed, seller.publicJwk)) return { ok: false, code: "BAD_SIGNATURE", reason: "offer signature invalid" };
    if (new Date(signed.payload.validUntil) <= now) return { ok: false, code: "OFFER_EXPIRED", reason: "offer expired" };
    return { ok: true, digest: offerDigest(signed.payload) };
  }

  /** Check a seller identity document's published key against the pinned key. */
  checkIdentity(webId: string, publishedJwk: JsonWebKey): boolean {
    const s = this.sellers.get(webId);
    return Boolean(s && keyIdOf(s.publicJwk) === keyIdOf(publishedJwk));
  }
}

export const offerDigest = (o: Offer) => digestOf(o);
