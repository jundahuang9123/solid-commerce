import type { SchemeId } from "../model.js";

/** A scheme-neutral view of one way to pay, parsed from an HTTP 402 response. */
export interface PaymentOption {
  scheme: SchemeId;
  amount: string;           // atomic units
  currency: string;
  payTo: string;            // x402: address; L402/PSP: merchant id
  resource: string;
  /** The scheme-specific challenge, passed unchanged to the signer. */
  challenge: unknown;
  /** Rail-level reference used for reconciliation (payment hash, intent id...). */
  railReference?: string;
}

/** Reference to the seller's signed offer that an HTTP 402 response claims to implement. */
export interface OfferRef { offerId: string; version: number; digest: string }

/** What the signer returns: the header to attach on the retry. */
export interface PaymentCredential {
  scheme: SchemeId;
  header: { name: string; value: string };
  railReference: string;
  payer?: string;
}

/** x402 terms an authorization pins: CAIP-2 network, checksummed token address and its EIP-712 domain. */
export interface X402Terms { network: string; asset: string; domainName: string; domainVersion: string }

/** Gateway-issued, signed, single-purpose authorization to pay. */
export interface PaymentAuthorization {
  authId: string;
  transactionId: string;
  mandateId: string;
  agentId: string;
  seller: string;
  offerId: string;
  offerVersion: number;
  offerDigest: string;
  resource: string;
  scheme: SchemeId;
  amount: string;
  currency: string;
  payTo: string;
  challengeDigest: string;
  /**
   * The payment's identity on its rail, derived by the GATEWAY from the challenge it binds (never
   * taken from the agent): x402 EIP-3009 nonce, L402 payment hash, card intent id, checkout session
   * id. The ledger reconciles against it, and the signer refuses a challenge whose own reference
   * differs, so reconciliation always asks the rail about the payment that was actually made.
   * Optional in the type only for authorizations issued before it existed; the signer requires it.
   */
  railReference?: string;
  /** x402 only: the chain, token contract and EIP-712 domain the signer may sign for (from the signed offer). */
  x402?: X402Terms;
  issuedAt: string;
  expiresAt: string;
}

/** Seller-signed receipt returned with the delivered resource. */
export interface Receipt {
  receiptId: string;
  seller: string;
  offerId: string;
  offerVersion: number;
  resource: string;
  scheme: SchemeId;
  amount: string;
  currency: string;
  railReference: string;
  contentDigest: string;
  deliveredAt: string;
}

export const OFFER_LINK_REL = "https://w3id.org/solid-commerce#offer";
export const RECEIPT_HEADER = "sc-receipt";
