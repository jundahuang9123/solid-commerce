/**
 * Scheme-neutral handling of HTTP 402. The status code is only the decision
 * point. One 402 response can offer several payment protocols at once; this
 * module collects them all into PaymentOption[].
 */
import type { OfferRef, PaymentOption } from "./types.js";
import { OFFER_LINK_REL } from "./types.js";
import { parseX402 } from "./schemes/x402.js";
import { parseL402 } from "./schemes/l402.js";
import { parseCardPsp } from "./schemes/cardPsp.js";

export interface PaymentChallengeSet { resource: string; options: PaymentOption[]; offer?: OfferRef; offerLink?: string }

export function parse402(res: Response, resourceUrl: string): PaymentChallengeSet {
  if (res.status !== 402) throw new Error(`Expected 402, got ${res.status}`);
  const x = parseX402(res, resourceUrl);
  const www = res.headers.get("www-authenticate");
  const link = res.headers.get("link") ?? "";
  const offerLink = link.split(/,\s*/).find((l) => l.includes(`rel="${OFFER_LINK_REL}"`))?.match(/<([^>]+)>/)?.[1];
  const offerHeader = res.headers.get("sc-offer");
  const offer = x.offer ?? (offerHeader ? (JSON.parse(offerHeader) as OfferRef) : undefined);
  return { resource: resourceUrl, options: [...x.options, ...parseL402(www, resourceUrl), ...parseCardPsp(www, resourceUrl)], offer, offerLink };
}
