/**
 * Offer evaluation against confirmed common ground.
 *
 * Policy (part of the application profile):
 *  - Requirements filter. An offer that fails one, OR gives too little
 *    information to show it meets one, is not acceptable ("missing means no").
 *  - Preferences rank. Score = sum of the weights of satisfied preferences;
 *    unknown counts as not satisfied.
 *  - Ties are broken by lower price, then by seller IRI (deterministic).
 *  - Sellers outside the mandate, and offers without a payable price in the
 *    mandate's currency and schemes, are not acceptable.
 */
import type { Criterion, Offer, PreferenceRecord, SpendingMandate } from "../model.js";
import type { OfferEvaluation } from "../rdf/evidence.js";
import { fmt, toAtomic } from "../util/money.js";
import type { Signed } from "../util/crypto.js";

export type Tri = true | false | "unknown";

export function compare(value: unknown, c: Criterion): Tri {
  if (value === undefined || value === null || value === "") return "unknown";
  const r = c.rightOperand;
  switch (c.operator) {
    case "eq": return String(value) === String(r);
    case "isAnyOf": return (Array.isArray(r) ? r : [r]).map(String).includes(String(value));
    default: {
      const a = Number(value), b = Number(r);
      if (Number.isNaN(a) || Number.isNaN(b)) return "unknown";
      return c.operator === "lt" ? a < b : c.operator === "lteq" ? a <= b : c.operator === "gt" ? a > b : a >= b;
    }
  }
}

/** Pre-purchase: what the offer promises. */
export function offerValue(offer: Offer, leftOperand: string): unknown {
  switch (leftOperand) {
    case "observationAgeMinutes": return offer.properties.observationMaxAgeMinutes; // a promise of "at most N minutes old"
    case "coverage": return offer.coverage;
    default: return offer.properties[leftOperand];
  }
}

/**
 * Anything carrying offer terms: a seller-signed offer, or a checkout candidate
 * (src/checkout) whose terms the gateway re-reads from the merchant before paying.
 */
export type OfferLike = { payload: Offer };

export interface Evaluated<S extends OfferLike = Signed<Offer>> { signed: S; evaluation: OfferEvaluation; option?: Offer["prices"][number] }

export function evaluateOffers<S extends OfferLike = Signed<Offer>>(
  offers: S[],
  input: { category: string; subject?: string; mandate: SpendingMandate; walletSchemes: string[]; requirements: Array<{ record: PreferenceRecord; criterion: Criterion }>; preferences: Array<{ record: PreferenceRecord; criterion: Criterion }> },
): Evaluated<S>[] {
  const { mandate } = input;
  const out = offers.map((signed): Evaluated<S> => {
    const o = signed.payload;
    const reasons: string[] = [];
    let acceptable = true;
    const no = (r: string) => { acceptable = false; reasons.push("✗ " + r); };
    if (!mandate.allowedSellers.includes(o.seller)) no(`seller ${o.sellerName} is not allowed by the mandate`);
    if (o.category !== input.category) no(`category ${o.category} ≠ ${input.category}`);
    if (input.subject && o.coverage.toLowerCase() !== input.subject.toLowerCase()) no(`covers ${o.coverage}, not ${input.subject}`);
    const option = o.prices.find((p) => mandate.allowedSchemes.includes(p.scheme) && input.walletSchemes.includes(p.scheme) && p.currency === mandate.currency);
    if (!option) no(`no price payable in ${mandate.currency} via ${mandate.allowedSchemes.join("/")}`);
    else if (BigInt(option.amount) > BigInt(toAtomic(mandate.maxPerTransaction, mandate.currency))) no(`price ${fmt(option.amount, option.currency)} above per-purchase limit`);
    for (const { record, criterion } of input.requirements) {
      const t = compare(offerValue(o, criterion.leftOperand), criterion);
      if (t === true) reasons.push(`✓ requirement ${criterion.leftOperand} ${criterion.operator} ${criterion.rightOperand}`);
      else no(`requirement ${criterion.leftOperand} ${criterion.operator} ${criterion.rightOperand} ${t === "unknown" ? "cannot be verified from the offer" : "not met"}${record.groundedIn ? " (agreed meaning)" : ""}`);
    }
    let score = 0;
    for (const { record, criterion } of input.preferences) {
      const t = compare(offerValue(o, criterion.leftOperand), criterion);
      if (t === true) { score += record.weight ?? 0.5; reasons.push(`+${record.weight ?? 0.5} preference ${criterion.leftOperand}`); }
      else reasons.push(`·  preference ${criterion.leftOperand} ${t === "unknown" ? "unknown" : "not met"}`);
    }
    return {
      signed, option,
      evaluation: { offerId: o.offerId, version: o.version, seller: o.seller, sellerName: o.sellerName, acceptable, score: Math.round(score * 100) / 100, reasons, price: option?.amount, currency: option?.currency },
    };
  });
  return out.sort((a, b) =>
    Number(b.evaluation.acceptable) - Number(a.evaluation.acceptable) ||
    b.evaluation.score - a.evaluation.score ||
    (a.option && b.option ? Number(BigInt(a.option.amount) - BigInt(b.option.amount)) : 0) ||
    a.signed.payload.seller.localeCompare(b.signed.payload.seller));
}
