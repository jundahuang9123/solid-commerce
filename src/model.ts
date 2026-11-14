/**
 * Domain model. These TypeScript types are the single source for both RDF
 * generation (src/rdf/records.ts) and validation (ontology/shapes.ttl).
 */

export type RecordStatus = "Proposed" | "UserConfirmed" | "Rejected" | "Superseded";
export type Operator = "eq" | "lt" | "lteq" | "gt" | "gteq" | "isAnyOf";
export type SchemeId = "x402" | "l402" | "card-psp";
export const SCHEME_IRI_NAME: Record<SchemeId, string> = { x402: "X402", l402: "L402", "card-psp": "CardPSP" };

/** A machine-checkable condition. leftOperand is a local name in the sc: vocabulary. */
export interface Criterion {
  leftOperand: string;            // e.g. "observationAgeMinutes", "coverage", "price"
  operator: Operator;
  rightOperand: string | number | string[];
  unit?: string;                  // e.g. "minute"
}

/** A user approval produced on the trusted approval device (src/grounding/approval.ts). */
export interface Confirmation {
  by: string;                     // WebID of the person who approved
  at: string;                     // ISO time
  keyId: string;                  // enrolled approval key
  termsDigest: string;            // digest of the canonical terms
  signature: string;              // Ed25519 over the canonical terms
}

interface RecordBase {
  id: string;                     // resource IRI (document#fragment)
  owner: string;                  // WebID
  revision: number;
  status: RecordStatus;
  confirmation?: Confirmation;
  derivedFrom?: string;           // verbatim user statement
  supersedes?: string;            // IRI of the previous revision
  proposedBy?: string;            // agent id that proposed it
}

/** Common ground: what a term means for this user in this scope. */
export interface AgreedMeaning extends RecordBase {
  kind: "meaning";
  term: string;
  scope: string;                  // category local name, e.g. "WeatherReport"
  definition: string;             // human-readable, shown at approval time
  criterion: Criterion;
}

/** Preference (ranking) or requirement (filter). Never carries financial authority. */
export interface PreferenceRecord extends RecordBase {
  kind: "preference" | "requirement";
  appliesTo: string;
  criterion: Criterion;
  weight?: number;
  groundedIn?: string;            // IRI of an AgreedMeaning
}

/** ODRL-based spending mandate. The only record the gateway accepts as financial authority. */
export interface SpendingMandate extends RecordBase {
  kind: "mandate";
  assignees: string[];            // agent ids allowed to act
  targets: string[];              // categories, e.g. ["WeatherReport"]
  currency: string;               // e.g. "USDC"
  maxPerTransaction: string;      // major units, decimal string ("0.10")
  totalLimit: string;             // major units
  allowedSellers: string[];       // seller WebIDs
  allowedSchemes: SchemeId[];
  validUntil: string;             // ISO
}

export interface PurchaseIntention {
  id: string;
  owner: string;
  category: string;
  subject?: string;               // e.g. "Berlin"
  text: string;
  mandate?: string;               // IRI
  createdAt: string;
}

export type GroundRecord = AgreedMeaning | PreferenceRecord | SpendingMandate;

/** The fields covered by a user's signature: everything except status and confirmation. */
export function confirmableTerms(r: GroundRecord): Record<string, unknown> {
  const { status: _s, confirmation: _c, proposedBy: _p, ...terms } = r as GroundRecord & Record<string, unknown>;
  return terms;
}

// ----------------------------------------------------------------- Offers

export interface PriceOption {
  scheme: SchemeId;
  amount: string;                 // atomic units
  currency: string;
  // x402-specific
  network?: string;
  asset?: string;
  payTo?: string;
  // L402 / PSP: the payee as known to the provider
  merchantId?: string;
}

/** A seller's offer. Signed by the seller's approved key (see src/seller/offers.ts). */
export interface Offer {
  offerId: string;                // IRI
  version: number;
  seller: string;                 // seller WebID
  sellerName: string;
  category: string;
  resource: string;               // URL of the paid resource (the HTTP 402 endpoint)
  coverage: string;               // e.g. "Berlin"
  properties: Record<string, number | string>; // e.g. { observationMaxAgeMinutes: 10 }
  prices: PriceOption[];
  validUntil: string;
}

// ----------------------------------------------------------------- Delivery

export interface WeatherReport {
  location: string;
  observedAt: string;
  temperatureC: number;
  conditions: string;
  provider: string;
}
