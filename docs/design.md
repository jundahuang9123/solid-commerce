# Design notes

## Separation of concerns

| Concern | Lives in | Trusted? |
|---|---|---|
| What the user means and prefers | Pod: agreed meanings, preferences, requirements | Only when user-confirmed (signature verified) |
| What the user allows to be spent | Pod: `sc:SpendingMandate` (ODRL) | Only when user-confirmed; checked by the gateway on every authorization |
| How much has been spent | Gateway ledger (SQLite) | Source of truth for money; mirrored to the Pod as evidence |
| Keys and payment credentials | Signer / vault | Never visible to agents or stored in the Pod |
| What sellers commit to | Signed offers, signed receipts | Attributable to an approved seller key. Not proof that product claims are true |

An LLM can propose interpretations, but it cannot confirm them. It also cannot authorise a payment or touch a key.

## Grounding lifecycle

```
user text ─► interpreter (rules | Claude, JSON schema) ─► vocabulary validation
          ─► existing common ground? ── yes ─► reuse (no question)
                                     └─ no ──► clarification question with executable candidates
          ─► proposals (Proposed) ─► SHACL ─► approval device ─► UserConfirmed + signature
          ─► Pod write; previous revision archived byte-for-byte in history/
```

- **Meanings vs requirements.** "Current" is an `AgreedMeaning` scoped to `WeatherReport`. "The report must be current" is a `PurchaseRequirement` grounded in that meaning. When the meaning is revised (60 → 15 minutes), grounded requirements follow it automatically (`CommonGround.effectiveCriterion`).
- **Missing information.** A requirement that an offer gives no data for is treated as **not met**. A preference with no data scores zero.
- **Conflicts.** Requirements dominate preferences. Ties are broken by lower price, then by seller IRI, so ranking is deterministic.
- **Rejections.** A rejected proposal is stored in `proposals/` with status `Rejected`, so the negotiation history is preserved.

## Authorization binding

A gateway authorization is an Ed25519-signed envelope binding:

`transactionId, mandateId, agentId, seller, offerId, offerVersion, offerDigest, resource, scheme, amount, currency, payTo, challengeDigest, expiresAt`

The gateway checks, in order:

1. The mandate exists and its user confirmation verifies. It is not expired. This agent is an assignee. The category is a target.
2. The seller is in the mandate and is approved in the registry. The offer is signed by the pinned key and is not expired.
3. The challenge's amount, currency, payee and resource equal a price in the signed offer, always. When the agent forwards the offer reference from the 402 (the assistant always does), it must name exactly the evaluated offer version and digest; otherwise the gateway returns `OFFER_CHANGED`.
4. The scheme and currency are allowed by the mandate, and the per-transaction limit holds.
5. Inside `BEGIN IMMEDIATE`: committed (authorized + pending + settled) + amount ≤ total. Only then is the row inserted.

The signer pays only if the gateway's signature verifies and the challenge it receives hashes to `challengeDigest`. That stops payee substitution after authorization.

### Checkout merchants (no 402, no signed offer)

For an ACP-style checkout there is no seller signature to check, so steps 2–3 change. The gateway takes only identifiers from the agent (merchant, session id, line items). It fetches the session itself, server to server, from the merchant's pinned API base URL. From that copy it derives the amount (the session total, which must include delivery and tax), the payee, the items, the category (from the merchant's own feed) and the shipping address, which must match the Pod.

The authorization is bound to a digest of the session snapshot. The signer copies that digest into the one-time delegated token's allowance, and the PSP charges the token only once, at most the authorized amount, for that merchant, session and snapshot, before expiry. Only one live authorization per session exists, so concurrent completions cannot mint two tokens.

What this does not cover: a merchant that ships something other than what its own session says. That is caught only after delivery, by the user's signed verdict.

### Proxy route binding (seller side)

The proxy (`src/payments/serverSide.ts`) binds each settled payment to one resource and one request target before money moves. x402's `resource` field is not signed, so this binding, not the signature, keeps an x402 credential on its route. Nonces are canonicalised before use. A settled credential re-delivers only for GET; for other methods a delivered payment is consumed. Route matching is canonical, so a paid path cannot be reached through a respelling.

## Idempotency and replay

| Layer | Mechanism |
|---|---|
| Gateway | `transactionId` is the idempotency key. The same request returns the same authorization; a different request returns `IDEMPOTENCY_CONFLICT` |
| Signer | One payment per `authId`; concurrent duplicates are coalesced; retries get the identical credential |
| x402 | EIP-3009 nonce = `keccak256(authId)`. The token rejects reuse, and the signature binds payee and amount |
| Seller | Keeps paid references and re-delivers on a repeated credential without charging. If a settlement was lost or raced, it checks `authorization-state` |
| L402 | The preimage is bound to the invoice; the macaroon is bound to resource and payment hash |
| PSP | Confirmation uses `Idempotency-Key: authId` |

## Uncertain outcomes

- `authorized` → `settled` when the seller-signed receipt verifies, or when reconciliation finds the payment on the rail.
- `authorized` / `pending` → `released` only when the rail shows no payment **and** the authorization has expired. After expiry the signer refuses to pay and an x402 signature's `validBefore` has passed, so the payment can never happen.
- Until then the reservation keeps counting against the budget.
- The delivery outcome (`Delivered` / `NonCompliant` / `NotDelivered`) is recorded separately from the payment status. "Paid but not delivered" is therefore never confused with "payment failed".

## Threats considered

| Threat | Mitigation |
|---|---|
| Agent or anyone with Pod write access raises a limit | Mandate signature no longer verifies → `MANDATE_NOT_CONFIRMED` |
| Agent invents a mandate | No valid signature from an enrolled approval key |
| Preference smuggles authority | Type separation, SHACL `PreferenceGrantsNothing`, interpretation validation, gateway reads only mandates |
| Malicious or unknown seller | Registry plus mandate allow-list; pinned key; forged or re-signed offers rejected |
| Bait-and-switch price | 402 must reference the evaluated offer version; amount must equal the signed price |
| Payee substitution | Challenge digest bound into the authorization; EIP-712 binds `to` |
| Double charge on retry | Idempotency at gateway, signer, rail and seller |
| Concurrent agents overspend | Atomic reservation in a single write transaction |

Out of scope for v1: compromised signer or gateway host, a seller lying about product properties (detected only after delivery), privacy of Pod contents (needs Solid-OIDC and the WAC policies), and legal or regulatory requirements.
