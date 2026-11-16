# Design notes

## Separation of concerns

| Concern | Lives in | Trusted? |
|---|---|---|
| What the user means and prefers | Pod: agreed meanings, preferences, requirements | Only when user-confirmed (signature verified) |
| What the user allows to be spent | Pod: `sc:SpendingMandate` (ODRL) | Only when user-confirmed; checked by the gateway on every authorization |
| How much has been spent | Gateway ledger (SQLite) | Source of truth for money; mirrored to the Pod as evidence. In-memory (`:memory:`) in every entry point of this prototype, so a gateway restart forgets it |
| Keys and payment credentials | Signer / vault | Never visible to agents or stored in the Pod. A credential is handed only to the agent its authorization names |
| Which agent is calling | Per-agent bearer secrets, issued at setup (`src/trust/agentAuth.ts`) | The gateway and signer attribute a request to the agent whose secret it carries, never to an `agentId` in the body |
| What sellers commit to | Signed offers, signed receipts | Attributable to an approved seller key. Not proof that product claims are true |

An LLM can propose interpretations, but it cannot confirm them. It also cannot authorise a payment or touch a key.

## Grounding lifecycle

```
user text ─► interpreter (rules | any LLM provider, JSON schema) ─► vocabulary validation
          ─► existing common ground? ── yes ─► reuse (no question)
                                     └─ no ──► clarification question with executable candidates
          ─► proposals (Proposed) ─► SHACL ─► approval device ─► UserConfirmed + signature
          ─► Pod write; previous revision archived byte-for-byte in history/
```

- **Meanings vs requirements.** "Current" is an `AgreedMeaning` scoped to `WeatherReport`. "The report must be current" is a `PurchaseRequirement` grounded in that meaning. When the meaning is revised (60 → 15 minutes), grounded requirements follow it automatically (`CommonGround.effectiveCriterion`).
- **Missing information.** A requirement that an offer gives no data for is treated as **not met**. A preference with no data scores zero.
- **Conflicts.** Requirements dominate preferences. Ties are broken by lower price, then by seller IRI, so ranking is deterministic.
- **Rejections.** A rejected proposal is stored in `proposals/` with status `Rejected`, so the negotiation history is preserved.
- **Rollback.** `CommonGround.load` also reads the signed copies in `history/`. A revision is archived there only when a newer one is signed, so a valid archived copy of revision n proves that a newer revision exists. A live record whose revision is not newer than the highest valid archived one is refused and reported as `rolled back: …` in `ignored`; re-proposing it gets a revision above every archived one. If `history/` cannot be read, loading continues and `ignored` says the rollback check is unavailable.
- **Mandate reuse.** An existing confirmed mandate is reused only when every term matches the request: currency, total and per-purchase limits, targets, assignees, sellers and schemes. The one exception is an earlier, still-future expiry, because the requested expiry is recomputed on every request. Otherwise a new revision is proposed for approval, with a note listing each change (`mandateChanges`).
- **What the device shows.** The approval summary of a meaning includes its executable criterion (`leftOperand operator value unit`). Requirements and preferences name the meaning they are grounded in. Every summary ends with the record id, its revision, the revision it replaces and the user's words, all of which the signature covers.

## Authorization binding

A gateway authorization (`PaymentAuthorization`, `src/payments/types.ts`) is an Ed25519-signed envelope binding:

`authId, transactionId, mandateId, agentId, seller, offerId, offerVersion, offerDigest, resource, scheme, amount, currency, payTo, challengeDigest, railReference, x402 { network, asset, domainName, domainVersion }, issuedAt, expiresAt`

- `agentId` is the authenticated caller, not a value taken from the request body.
- `railReference` is the payment's identity on its rail, derived by the gateway: the EIP-3009 nonce `nonceFor(authId)` = `keccak256("sc-auth:" + authId)` for x402, the invoice's payment hash for L402, the intent id for card/PSP, the checkout session id for checkout. The ledger reconciles against it.
- `x402` (x402 only) pins the CAIP-2 network, the checksummed token contract and its EIP-712 domain name and version, taken from the signed offer and the pinned token table (`KNOWN_X402_TOKENS`, which holds only Base Sepolia test USDC).

The gateway checks, in order:

0. The caller presents an enrolled agent's secret (`401 AGENT_NOT_AUTHENTICATED` otherwise). A body `agentId` naming another agent is refused (`AGENT_MISMATCH`).
1. The mandate exists and its user confirmation verifies. It is not expired. This agent is an assignee. The category is a target. Its revision is not older than the newest revision of that mandate the gateway has verified (`MANDATE_SUPERSEDED`), and a different signed text at that same revision is refused (`MANDATE_REVISION_CONFLICT`).
2. The seller is in the mandate and is approved in the registry. The offer is signed by the pinned key and is not expired.
3. The challenge's amount, currency, payee and resource equal a price in the signed offer, always. They are read from the challenge itself, the object the signer will receive, not only from the agent's summary of it (`src/gateway/offerBinding.ts`): for x402 also the scheme `exact`, network, asset and EIP-712 domain; for L402 the invoice, checked against the Lightning node's own record, and the macaroon's caveats; for card/PSP the intent, read from the PSP. If the agent's option names a rail reference other than the challenge's, the gateway returns `RAIL_REFERENCE_MISMATCH`. When the agent forwards the offer reference from the 402 (the assistant always does), it must name exactly the evaluated offer version and digest; otherwise the gateway returns `OFFER_CHANGED`.
4. The scheme and currency are allowed by the mandate, and the per-transaction limit holds.
5. Inside `BEGIN IMMEDIATE`: no newer revision of the mandate has been seen meanwhile (`MANDATE_SUPERSEDED`), and committed (authorized + pending + settled) + amount ≤ total. Only then is the row inserted.

The signer pays only if the caller is the agent the authorization names (`401 AGENT_NOT_AUTHENTICATED`, `403 NOT_YOUR_AUTHORIZATION`), the gateway's signature verifies, the challenge it receives hashes to `challengeDigest`, and the challenge's own rail reference (and for x402 its network, token and EIP-712 domain) equals the authorization's. An authorization without `railReference` is refused (`AUTHORIZATION_INCOMPLETE`). That stops payee substitution after authorization, and a swap of the payment the ledger later reconciles.

`GET /transactions/:id` returns the ledger row, including the signed authorization, only to that transaction's agent (`NOT_YOUR_TRANSACTION`) or to the operator's admin secret. The admin secret is accepted only there and on `POST /reconcile`; it cannot authorize or pay.

### Checkout merchants (no 402, no signed offer)

For an ACP-style checkout there is no seller signature to check, so steps 2–3 change. The gateway takes only identifiers from the agent (merchant, session id, line items). It fetches the session itself, server to server, from the merchant's pinned API base URL. From that copy it derives the amount (the session total, which must include delivery and tax), the payee, the items, the category (from the merchant's own feed) and the shipping address, which must match the Pod.

The authorization is bound to a digest of the session snapshot. The signer copies that digest into the one-time delegated token's allowance, and the PSP charges the token only once, at most the authorized amount, for that merchant, session and snapshot, before expiry. Only one live authorization per session exists, so concurrent completions cannot mint two tokens.

What this does not cover: a merchant that ships something other than what its own session says. That is caught only after delivery, by the user's signed verdict.

### Proxy route binding (seller side)

The proxy (`src/payments/serverSide.ts`) binds each settled payment to one resource and one request target before money moves. x402's `resource` field is not signed, so this binding, not the signature, keeps an x402 credential on its route. Nonces are canonicalised before use. A settled credential re-delivers only for GET. For other methods the paid request needs an `Idempotency-Key`, and the payment serves exactly one request: that key plus a digest of target, content type and body (`src/proxy/paymentProxy.ts`). Route matching is canonical, so a paid path cannot be reached through a respelling.

## Idempotency and replay

| Layer | Mechanism |
|---|---|
| Gateway | `transactionId` is the idempotency key. The same request returns the same authorization; a different request returns `IDEMPOTENCY_CONFLICT` |
| Signer | One payment per `authId`; concurrent duplicates are coalesced; retries get the identical credential, and only the authorization's own agent gets it. The state is in memory: after a restart the rails' own idempotency (rows below) is what stops a second transfer |
| x402 | EIP-3009 nonce = `keccak256("sc-auth:" + authId)` (`nonceFor`), also the authorization's `railReference`. The token rejects reuse, and the signature binds payee and amount |
| Seller, GET | Keeps paid references and re-delivers on a repeated credential without charging. If a settlement was lost or raced, it checks `authorization-state` |
| Seller, other methods | The paid request carries an `Idempotency-Key`; without one, a credential is refused with `400` before anything settles. The payment is bound to the key and a digest of target, content type and body. An identical retry is forwarded again (same key, so the upstream can recognise it) after a failure, or gets the stored response once delivered (`sc-idempotent-replay: true`). Any other request: `409 idempotency_conflict` before delivery, `402 credential_consumed` after. The bindings and stored responses are in memory |
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
| An agent acts as another agent, or takes another agent's credential | Per-agent secrets: identity comes from the secret (`AGENT_NOT_AUTHENTICATED`, `AGENT_MISMATCH`); transactions and credentials go only to their own agent (`NOT_YOUR_TRANSACTION`, `NOT_YOUR_AUTHORIZATION`). Residual: bearer secrets over plain loopback HTTP, no rotation or revocation |
| Paid transaction released and its budget reused by naming another payment | The gateway derives `railReference` from the challenge and signs it; the signer pays only that reference (`RAIL_REFERENCE_MISMATCH` at the gateway) |
| x402 challenge names another chain or token | Network, asset and EIP-712 domain must match the signed offer and the pinned token table; bound into the authorization and checked again by the signer |
| Rollback: an older signed revision copied back over a newer one | Assistant: refuses a live revision that is not newer than a signed copy in `history/`. Gateway: refuses mandate revisions older than the newest it has verified (`MANDATE_SUPERSEDED`, `MANDATE_REVISION_CONFLICT`). Residual: an agent that also deletes `history/` is not detected by the assistant; the gateway only knows revisions it has seen, and forgets them on restart (in-memory ledger); meanings and requirements have no check outside the Pod |
| A narrower request silently reuses a broader mandate | A mandate is reused only when all its terms match the request; otherwise a new revision goes to the device |
| User signs a meaning without seeing what it does | The device shows the executable criterion, the grounding meaning and the record id and revision |
| One payment buys many non-GET requests | `Idempotency-Key` plus request digest: one request per payment. Residual: an upstream that ignores the key can run the same job twice after a timeout; bindings are in memory, so after a proxy restart a consumed credential can deliver one more request |

Out of scope for v1: compromised signer or gateway host, a seller lying about product properties (detected only after delivery), privacy of Pod contents (needs Solid-OIDC and the WAC policies), and legal or regulatory requirements.
