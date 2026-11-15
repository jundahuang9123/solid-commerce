# Running the web demo in a talk

The web demo (`src/web/`) shows the prototype on four screens: the weather report bought over HTTP 402, the approval device on a phone, "Break it", and repairable shoes bought through an ACP-style checkout. Every number, status code and Turtle document on screen comes from the running services or from a recording of them. Nothing is typed into the UI by hand.

> Payments are simulated (see the README). The phone page stands in for a passkey app: the demo server holds the approval key and signs when you press Approve.

## Before the talk

```bash
npm install
npm run demo:web
```

The terminal prints three things:

- the **dashboard URL**, `http://localhost:4400/?t=<token>`. Open it on the presenting laptop.
- the **phone URL**, `http://<lan-ip>:4400/phone?t=<token>`.
- a **QR code** of the phone URL.

Viewing needs no token. Every button (Next step, Approve, Run attack, ...) needs it, so someone else on the venue Wi-Fi can watch but cannot act.

The token survives restarts: the first run saves it in `recordings/.demo-token` (readable only by you, never committed), and later runs reuse it, so the open dashboard, the phone and the printed QR code keep working when you restart the server, also into `--replay`. To start over with a new token, delete that file (do this after a talk if the URL was shown on screen), or set `DEMO_TOKEN`. If the server does come back with another token, the open dashboard locks its controls and says so instead of showing buttons that fail: open the new URL from the terminal.

Options:

| Setting | Effect |
|---|---|
| `--port 5000` or `DEMO_PORT=5000` | Listen on another port (default 4400) |
| `DEMO_PUBLIC_URL=http://10.0.0.5:4400` | Base URL in the QR code, when the detected LAN address is wrong (several interfaces, VPN, a tunnel) |
| `POD_URL=http://localhost:3000/` | Use an already running Solid server instead of starting Community Solid Server |
| `INTERPRETER=claude` | Use Claude for interpretation, as in `npm run demo` |
| `DEMO_TOKEN=<12+ letters, digits, - or _>` | Use this session token instead of the one kept in `recordings/.demo-token` |

**Rehearse and record a fallback.** Run this on the laptop you will present from, close to the talk:

```bash
npm run demo:web -- --rehearse talk
```

It runs every screen unattended against the live services, with auto-approve on, and saves `recordings/talk.json` (replacing it: naming it on the command line is the request to). The repository ships one recording made this way. The rehearsal stops with an error, and saves nothing, if any step did not go as scripted: an action failed, a Break-it guardrail did not hold, a shoes checkout placed no order, or a shoes control found no order. A broken run never becomes your fallback.

You can also press **Record** in the toolbar at any point during a live session to save everything since the last Reset to `recordings/<name>.json`. The name defaults to `session-<HHMM>` (the time the dashboard was opened). Record never replaces an existing file silently: if the name is taken, the dashboard asks before overwriting (the API answers `409` unless the request says `"overwrite": true`), so the shipped `recordings/talk.json` is not lost by accident.

**Check the phone.** Scan the QR code. The phone must be on the same network as the laptop, and the network must allow device-to-device traffic (guest Wi-Fi often does not). If it does not work, use a phone hotspot for both devices, or rely on the on-screen phone (below).

## During the talk

- **Live by default.** Use **Next step** for one step at a time, or **Auto-play** for the rest. **Reset** starts a fresh Pod and environment in a few seconds. It also works while a step is waiting for an approval: the pending item counts as rejected.
- **Approvals.**
  - The phone shows each item as it arrives. Spending mandates appear in orange as **FINANCIAL AUTHORITY**, separate from meanings and preferences.
  - The **on-screen phone** opens by itself when an item is pending. It accepts Approve and Reject too, so it is the fallback if the phone loses the network.
  - **Auto-approve on the device** approves each item after about half a second, so the audience can still read it.
- **View toggle.** Choose **Research view** for audiences that want the mechanism: full wire details (decoded `PAYMENT-REQUIRED`, `WWW-Authenticate`, `PAYMENT-SIGNATURE`, receipts), offer reasons, the assistant log and the Turtle of each record. Choose **Business view** to lead with outcomes:
  - a row of results (delivered, paid, budget left, evidence, guardrails held);
  - the wire reduced to the payment flow;
  - the Break-it panel directly under the weather screen.
- **If something breaks live**, stop the server and restart it from the recording:

  ```bash
  npm run demo:web -- --replay recordings/talk.json
  ```

  The same UI and controls appear, marked **REPLAY**. The dashboard and phone you already have open reconnect by themselves and stay usable (same token, same QR code).
  - **Next step** and **Auto-play** play the recorded steps with their recorded timing (gaps capped at 1.2 s).
  - Each Break-it button, and each shoes button, plays its recorded run. Press them in the order they were recorded: buy, cancel, buy, advance, advance, accept.
  - Approvals are part of the recording and play without the phone.
  - Replay needs no Solid server and no network.

## Presenter script

### 1. Weather report, HTTP 402

1. **Ask.** "I ask my assistant for a current Berlin weather report, with up to 1 USDC to spend."
2. **Clarify.** "It does not guess what *current* means. It asks, and offers choices it can check against data." Pick 60 minutes.
3. **Approve.** "Four things go to my phone. Three describe what I want. The fourth, in orange, is the only thing that lets anyone spend money. It is a signed ODRL mandate." Approve on the phone.
4. **Compare.** "Three signed offers. Havel is cheaper, but its data can be 90 minutes old, which fails what I just agreed. Shady is cheapest, but it is not an approved seller."
5. **Pay.** Point at the wire:
   - "The seller answers `402 Payment Required` and offers three ways to pay in one response: x402, L402 and a card intent."
   - "The assistant cannot pay by itself. The gateway checks my signature, the seller's key and the price, then reserves the budget."
   - "The signer signs an EIP-3009 transfer, bound to that authorization. The seller settles with the facilitator, and only then does its API see the request."
6. **Deliver & check.** "The report is checked against my meaning of current, and against the seller's signed receipt."
7. **Evidence.** Click the evidence links: "This is in my Pod, in RDF: what was considered, what was used, and the gateway's ledger entry."

Research audiences: open a Turtle document and the `402` row. Business audiences: stay on the outcome row.

### 2. The approval device

"This phone stands in for a passkey app. My agent can propose. Only this device can make something *mine*. Watch what happens when I reject the mandate." (Optional: Reset, run to step 3, reject the orange item. The assistant stops: no mandate, no purchase.)

### 3. Break it

Run the cards left to right. Each verdict comes from the service that enforced it.

- **Raise own limit.** "The agent edits the mandate in my Pod to 100 USDC. The gateway answers `403 MANDATE_NOT_CONFIRMED`: the terms no longer match my signature."
- **Price change.** "The price goes up between comparing and paying. The assistant sees a new offer version, checks it again, and pays the new price only because it still fits the mandate."
- **Six at once.** "Two agents, six parallel purchases, a shared 0.05 USDC budget. Exactly two settle. The reservation is atomic."
- **Seller crash.** "Paid, but not delivered. That is a different state from 'payment failed'. **Recover** fetches the content with the same proof of payment. The signer's payment count does not change."
- **Replay elsewhere.** "The same payment, sent to another seller, is rejected. Sent three times to the right seller: delivered three times, one transfer."
- **Unapproved seller.** "A compromised agent tries to pay the cheapest seller anyway: `SELLER_NOT_IN_MANDATE`."

### 4. Repairable shoes, checkout

1. **Buy with the assistant.** "These shops have no HTTP 402. They have a checkout API. *Repairable* is agreed as *the soles can be replaced*, and the limit includes delivery." Approve on the phone.
2. **Products.** "The cheap sneaker fails the meaning. The welted derby fits, but it costs 123.90 EUR with delivery. The outlet is not approved."
3. **Checkout.** Point at the facts:
   - "The gateway read the session from the shop itself."
   - "The card token allows this amount, at this shop, for this session, once."
   - "My address went to this shop only."
4. **Cancel & refund** (first order). "The budget comes back only after the payment provider confirms the refund."
5. **Buy again, then Advance shipment twice** (the simulated shop's test control). Then answer **Yes, as agreed** or **No, not compliant**. "The carrier saying *delivered* is not acceptance. My signed verdict is, and it goes into the Pod."

## What is real here

- The dashboard is a view of the event log of one process. That process runs:
  - the environment of `src/demo/environment.ts`: a real Community Solid Server, the simulated rails, the sellers behind the 402 proxy, the checkout merchants, the gateway and the signer;
  - the scenarios in `src/web/scenarios/`, which call the same public APIs as `src/demo/run-demo.ts` and the tests.
- The wire panel is recorded by wrapping `fetch` in that process. Each service's HTTP server tags the requests it handles, so calls it makes, such as seller to facilitator or gateway to Pod, are attributed to it. The dashboard's own polling (Pod panel, budget meters) is left out, and so is what a service does to answer it, such as the gateway reading the mandate from the Pod for a budget meter.
- Only summaries are kept: decoded payment headers and the key fields of each answer. Card tokens, merchant API keys and wallet accounts are redacted, and delegated tokens, macaroons and preimages are shortened.
- Some steps use the simulations directly, and the UI says so:
  - "Advance shipment" uses the simulated shop's test control.
  - The Break-it fixtures (the shared 0.05 USDC mandate, and the weather mandate when Break it runs first) are approved automatically and marked as fixtures in the assistant log.
