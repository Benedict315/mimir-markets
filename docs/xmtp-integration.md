# XMTP Integration — Mimir

**Status:** Steps 1–7 complete — live reference for the XMTP integration.
**Docs index:** `https://docs.xmtp.org/llms.txt` (re-check before implementing new API calls; the SDK evolves).

---

## 1. Package and upstream repository

| Field | Value |
|-------|-------|
| **npm package** | `@xmtp/browser-sdk` |
| **Stable version** | `7.0.0` |
| **Description** | XMTP client SDK for browsers written in TypeScript |
| **Source** | [github.com/xmtp/xmtp-js](https://github.com/xmtp/xmtp-js) (tree `sdks/browser-sdk`) |

> Before `npm install`, run `npm view @xmtp/browser-sdk version` to check for patch bumps. Always verify method signatures against that version's docs, not static memory.

---

## 2. Topic → official docs table (llms.txt)

Base URL: `https://docs.xmtp.org`

| Topic | Path (relative) | Usage in Mimir |
|-------|-----------------|----------------|
| Browser SDK (entry) | `/chat-apps/sdks/browser` | Installation, quickstart, browser overview |
| Create signer | `/chat-apps/core-messaging/create-a-signer` | What shape XMTP requires of a `Signer`. Mimir satisfies it from its own internal identity, not from the user's Stellar wallet — see 3.1 |
| Create client | `/chat-apps/core-messaging/create-a-client` | `Client.create` / init after wallet connected |
| Create conversations | `/chat-apps/core-messaging/create-conversations` | 1:1 DM with the other side of a claim |
| Send messages | `/chat-apps/core-messaging/send-messages` | Chat input in claim detail panel |
| List conversations | `/chat-apps/list-stream-sync/list` | Messages hub |
| List messages | `/chat-apps/list-stream-sync/list-messages` | Active thread history |
| Stream | `/chat-apps/list-stream-sync/stream` | Real-time messages / conversations |
| Sync / SyncAll | `/chat-apps/list-stream-sync/sync-and-syncall` | On panel open or tab focus |
| History sync | `/chat-apps/list-stream-sync/history-sync` | Optional (multi-device) |
| Consent (concept) | `/chat-apps/user-consent/user-consent` | Spam / preference model |
| Consent (implement) | `/chat-apps/user-consent/support-user-consent` | Consent methods in UI |
| Rate limits | `/chat-apps/core-messaging/rate-limits` | Errors and backoff in production |
| User signatures | `/protocol/signatures` | What signatures the wallet will request |
| Identity / inboxes | `/chat-apps/core-messaging/manage-inboxes` | Inbox ID, installations (advanced debug) |
| Wallet signature payloads | `/chat-apps/use-signatures` | Sign / verify payloads if extended |

**Useful but non-blocking for MVP**
- `/chat-apps/content-types/content-types` — content types (text first).
- `/chat-apps/debug/debug-your-app` — debugging.
- `/fund-agents-apps/*` — agent funding utilities; revisit only if required on testnet/mainnet.

---

## 3. Mimir project inventory

### 3.1 Wallet (signer integration point)

| File | Role |
|------|------|
| [`app/layout.tsx`](../app/layout.tsx) | `WalletProvider` wraps `{children}` + Toaster; the entire app tree has wallet context. |
| [`lib/wallet.tsx`](../lib/wallet.tsx) | Context: `address`, `isConnected`, `connect`, `disconnect`, `error`; Stellar Wallets Kit on Stellar Testnet (connector picker; no chain-switch request exists on Stellar). |

**XMTP implication, and the one deliberate exception in this codebase:** XMTP's own
auth handshake needs a protocol-level signing identity that is not Stellar-shaped,
so it cannot be satisfied by the user's `G…` account or by `useWallet()`. That
identity lives in `lib/xmtp/identity.ts`, is internal-only, is never surfaced to the
user, and never touches a Mimir contract or any trading path — it exists solely to
satisfy XMTP. It is the single allowlisted file in
`scripts/check-forbidden-terms.mjs` for exactly that reason. The XMTP signer is
imported only from client components.

### 3.2 Framework constraints

- **Next.js 16** App Router: the SDK must **not** be imported in Server Components.
- **i18n:** `next-intl` in [`app/[locale]/layout.tsx`](../app/[locale]/layout.tsx); chat strings in `messages/en.json`.

### 3.3 Folder structure (XMTP)

```
lib/xmtp/
  config.ts               # public env, feature flag, options for Client.create
  identity.ts             # the internal-only XMTP signing identity (see 3.1)
  signer.ts               # XMTP Signer over that identity (client-only)
  XmtpProvider.tsx        # React context: Client.create / close / states
  failure-state.ts        # failure classification + retry policy (no SDK)
  vs-chat-eligibility.ts  # 1v1 accepted rules + peer resolution (no SDK)
  optimistic-send.ts      # remote + pending message merge (Step 7)
  index.ts                # safe barrel: re-exports config only
components/xmtp/
  VsXmtpPanel.tsx         # DM panel + messages + stream + optimistic send (Steps 5–7)
  XmtpFailureNotice.tsx   # shared failure + retry notice (accessibility, i18n)
  MessagesHub.tsx         # /messages hub: list claims with active XMTP chat
```

Import **`XmtpProvider` and `useXmtp`** from `@/lib/xmtp/XmtpProvider` (not from `index.ts`) to avoid accidentally loading the SDK in Server Components.

---

## 4. Product decisions (agreed MVP)

| Question | Decision |
|----------|----------|
| Where does chat live in MVP? | **Panel on the claim detail page** `/vs/[id]` (no global inbox in header for first delivery). |
| Who can use chat? | User with **connected wallet** whose address matches **`creator` or `opponent`** of the claim. |
| In which claim state? | Only when the claim is **`accepted`** (opponent != `ZERO_ADDRESS`). |
| Sample VS (negative IDs)? | **No** XMTP conversations; show i18n message "available on real claims" or hide panel. |
| DM vs group? | **1:1 DM** between the two addresses of the claim. |
| Feature flag | `NEXT_PUBLIC_FEATURE_XMTP` for gradual rollout. |

---

## 5. Step 1 — Done ✓

- [x] Official index (`llms.txt`) consulted, route table documented.
- [x] `@xmtp/browser-sdk` version recorded.
- [x] Wallet and layout inventory updated.
- [x] Product decisions written.
- [x] Folder structure proposed.

## 6. Step 2 — Done ✓

| Deliverable | Location |
|-------------|----------|
| npm dependency | `@xmtp/browser-sdk` in `package.json` |
| Documented env vars | [`.env.example`](../.env.example) — `NEXT_PUBLIC_XMTP_ENV`, `NEXT_PUBLIC_FEATURE_XMTP`, `NEXT_PUBLIC_XMTP_APP_VERSION` |
| Typed client options | [`lib/xmtp/config.ts`](../lib/xmtp/config.ts) → `getXmtpClientCreateOptions()` |
| Barrel | [`lib/xmtp/index.ts`](../lib/xmtp/index.ts) |

**Rules:** Do not import `@xmtp/browser-sdk` in Server Components. SDK only in modules under `"use client"`.

## 7. Step 3 — Done ✓

| Deliverable | Location |
|-------------|----------|
| Local identity signer | [`lib/xmtp/signer.ts`](../lib/xmtp/signer.ts) — `createXmtpSignerFromIdentity(identity)`, over the internal-only identity in [`lib/xmtp/identity.ts`](../lib/xmtp/identity.ts) |
| Typed errors | `XmtpSignerError` (`rejected`, `invalid_address`, `invalid_signature`, `unknown`) |
| Test utilities | `utf8MessageToHexData`, `hexSignatureToUint8Array` |

**Technical details** — these describe the shape *XMTP's own protocol* demands, which is why the identity in 3.1 exists. None of it is a Mimir address and none of it reaches a Mimir contract.
- `Signer` interface from `@xmtp/browser-sdk@7`: `type: "EOA"`, `getIdentifier`, `signMessage` → `Uint8Array`.
- Identifier: `IdentifierKind.Ethereum`, address in **lowercase**.
- Signature: `personal_sign` with UTF-8 message passed as hex DATA (`0x` + bytes), signature converted to bytes.

## 8. Step 4 — Done ✓

| Deliverable | Location |
|-------------|----------|
| React context + lifecycle | [`lib/xmtp/XmtpProvider.tsx`](../lib/xmtp/XmtpProvider.tsx) |
| Hook | `useXmtp()` → `{ client, status, error, activeAddress, featureEnabled, retry }` |
| Mount | [`app/layout.tsx`](../app/layout.tsx): `WalletProvider` → **`XmtpProvider`** → `{children}` |

**Status values**

| `status` | Meaning |
|----------|---------|
| `disabled` | `NEXT_PUBLIC_FEATURE_XMTP` not active → `Client.create` not called. |
| `idle` | Feature active but no wallet connected. |
| `initializing` | `Client.create` in progress (may prompt signature to register XMTP inbox). |
| `ready` | `client` ready for `conversations`, streams, etc. |
| `error` | Init failed; `retry()` increments a trigger to retry. |
| `blocked_by_tab` | XMTP is already active in another tab (OPFS lock conflict). |
| `disabled`/`idle` above | No client is ever created, so no failure is possible. |

Every failing state also sets `failure` (an `XmtpFailure` from `lib/xmtp/failure-state.ts`): the `kind` the UI maps to copy, plus the attempt count, whether a retry is safe, and the raw `technical` string for support. `error` is still exposed for logs.

## 9. Step 5 — Done ✓

| Deliverable | Location |
|-------------|----------|
| 1v1 business rules | [`lib/xmtp/vs-chat-eligibility.ts`](../lib/xmtp/vs-chat-eligibility.ts) — `canOpenVsXmtpChat`, `getVsXmtpPeerAddress` |
| UI + DM + messages + stream | [`components/xmtp/VsXmtpPanel.tsx`](../components/xmtp/VsXmtpPanel.tsx) |
| Integration | [`app/[locale]/vs/[id]/page.tsx`](../app/[locale]/vs/[id]/page.tsx) |
| i18n | `messages/en.json` → namespace **`xmtpVs`** |

**Product rules**
- Chat only if `vs.state === "accepted"`, `opponent !== ZERO`, **`getVSChallengerCount(vs) === 1`** (no multi-challenger).
- Peer: the other address (case-insensitive) relative to the connected wallet.
- **`NEXT_PUBLIC_FEATURE_XMTP`:** panel not rendered if off.

**Technical flow (SDK v7)**
1. `conversations.sync()` → `fetchDmByIdentifier` → if absent, `Client.canMessage` → `createDmWithIdentifier`.
2. `conversation.sync()` → `messages({ limit: 40 })` ordered by `sentAt`.
3. `conversation.stream({ onValue })` for new messages; cleanup: `stream.end()`.

## 10. Step 6 — Done ✓

| Deliverable | Location |
|-------------|----------|
| Client instance type | [`lib/xmtp/types.ts`](../lib/xmtp/types.ts) — `XmtpClientInstance` |
| Thread logic | [`lib/xmtp/chat-thread.ts`](../lib/xmtp/chat-thread.ts) — `ensureVsDmThread`, `loadThreadMessages`, `classifyXmtpThreadError` |
| Lifecycle hook | [`hooks/useVsXmtpThread.ts`](../hooks/useVsXmtpThread.ts) |
| UI | [`components/xmtp/VsXmtpPanel.tsx`](../components/xmtp/VsXmtpPanel.tsx) — Refresh button |

**Behavior**
- **Global sync:** `conversations.syncAll([ConsentState.Allowed])` on thread open and manual refresh.
- **Consent:** if DM exists with `consentState === Unknown`, call `updateConsentState(Allowed)` before `conversation.sync()`.
- **Errors:** `classifyXmtpThreadError` distinguishes `peer_unreachable`, `rate_limit`, `network`, `unknown`. That `kind` is kept for the 1v1 demo preview only; the copy and the retry policy come from `classifyXmtpFailureKind`.
- **Tab focus refresh:** `visibilitychange` (hidden → visible only) with ~4s throttle.
- **Retry after thread error:** `retryOpenThread` (nonce) restarts thread opening.
- **Stream loss is non-destructive:** `onError` records `streamFailure` and keeps the loaded messages. The panel says live updates are paused and offers a reconnect. A successful refresh or a live `onValue` clears it. Before this, a dead stream was only `console.warn`ed and the thread silently froze.

## 11. Messages hub (navbar)

| Deliverable | Location |
|-------------|----------|
| Route | [`app/[locale]/messages/page.tsx`](../app/[locale]/messages/page.tsx) |
| UI | [`components/xmtp/MessagesHub.tsx`](../components/xmtp/MessagesHub.tsx) |
| Nav | [`components/Header.tsx`](../components/Header.tsx) — **Messages** chip, shown only if `NEXT_PUBLIC_FEATURE_XMTP` is active |

**Rules**
- **No claims** for user: empty state with CTA to Explore / Challenge.
- **Claims but none XMTP-eligible** (not accepted 1v1, multi-challenger, etc.): notice + list with i18n reason.
- **Active chats:** links to `/vs/[id]#mimir-xmtp-vs-chat` for claims passing `canOpenVsXmtpChat`.

## 12. Step 7 — Done ✓ (optimistic send)

| Deliverable | Location |
|-------------|----------|
| Remote + pending message merge | [`lib/xmtp/optimistic-send.ts`](../lib/xmtp/optimistic-send.ts) — `mergeThreadDisplayRows`, `OptimisticPendingMessage` |
| Panel | [`components/xmtp/VsXmtpPanel.tsx`](../components/xmtp/VsXmtpPanel.tsx) — draft cleared on send, `sendText(text, true)`, dedup by `serverMessageId` vs stream |

**Behavior**
- Message bubble appears instantly; SDK sends with `isOptimistic: true`.
- After `sendText`, the returned ID is saved; when the thread stream receives the same `DecodedMessage.id`, the pending row is removed (no duplicate).
- Send failure: pending row removed and a `send_failed` notice appears **with the text restored to the draft**, so a failed message can be resent instead of being retyped.

---

## 12.1 Failure and retry states (#90)

| Deliverable | Location |
|-------------|----------|
| Classification + retry policy | [`lib/xmtp/failure-state.ts`](../lib/xmtp/failure-state.ts) — no SDK import, so node tests can reach it |
| Shared notice | [`components/xmtp/XmtpFailureNotice.tsx`](../components/xmtp/XmtpFailureNotice.tsx) |
| Provider state | [`lib/xmtp/XmtpProvider.tsx`](../lib/xmtp/XmtpProvider.tsx) — `failure` on the context |
| Thread + stream state | [`hooks/useVsXmtpThread.ts`](../hooks/useVsXmtpThread.ts) — `threadFailure`, `streamFailure` |
| i18n | `messages/en.json` → namespace **`xmtpVs`** (`failure*`, `retrying`) |
| Tests | [`tests/node/xmtp-failure-state.test.ts`](../tests/node/xmtp-failure-state.test.ts), [`tests/node/xmtp-failure-ui.test.ts`](../tests/node/xmtp-failure-ui.test.ts) |

**Kinds** — `signature_declined`, `unsupported_wallet`, `invalid_identity`, `installations_limit`, `blocked_by_tab`, `peer_unreachable`, `rate_limit`, `network`, `timeout`, `stream_lost`, `send_failed`, `unknown`.

**Rules that must not regress**
- **Technical text is never the headline.** The raw SDK/wallet message goes in a `<details>` support disclosure: it can carry the InboxID (a stable identifier) or OPFS paths. `lib/xmtp/XmtpProvider.tsx` still exposes the raw `error` for logs, but the UI maps `failure.kind`.
- **A declined signature is never retried unattended.** `autoRetryable` is false for it, so the backoff cannot reopen the wallet dialog without the user asking. The user can still press Retry themselves.
- **Unattended retry is bounded.** At most `XMTP_MAX_AUTO_RETRIES` (2) with a 1.5s / 6s backoff, and never while an attempt is already in flight — a second trigger would cancel `Client.create` mid-flight.
- **Attempt counting resets across kinds and on success.** A `network` timeout followed by a `rate_limit` is attempt 1 of a new problem, not attempt 3 of the old one.
- **A retry keeps the notice on screen** with a busy button until it lands, instead of dropping the error into an anonymous spinner.
- **Unrecoverable failures say so.** `unsupported_wallet` and `invalid_identity` are not retryable, and the notice states that instead of offering a button that cannot work.
- **`blocked_by_tab` has a real Retry button.** The old copy promised an automatic reconnect, which only happens if the other tab broadcasts its release; a forced tab close never broadcasts.

**No money, permissions or contracts** are touched anywhere in this path. XMTP is message transport; the chain remains the source of truth.

---

## 13. Environment variables

| Variable | Role |
|----------|------|
| `NEXT_PUBLIC_XMTP_ENV` | Network: `local` \| `dev` \| `production` (default: `dev`). |
| `NEXT_PUBLIC_FEATURE_XMTP` | If not `1`, `true`, or `yes` — provider skips `Client.create` and panel shows nothing. |
| `NEXT_PUBLIC_XMTP_APP_VERSION` | String like `mimir/1.0.0` for XMTP client telemetry. |

Recommended values for local development:
```bash
NEXT_PUBLIC_XMTP_ENV=dev
NEXT_PUBLIC_FEATURE_XMTP=1
NEXT_PUBLIC_XMTP_APP_VERSION=mimir/0.1
```

After editing `.env.local`, restart the dev server (`npm run dev`).

---

## 14. Quick references

- Docs index: <https://docs.xmtp.org/llms.txt>
- Browser SDK: <https://docs.xmtp.org/chat-apps/sdks/browser>
