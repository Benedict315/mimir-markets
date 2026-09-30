# Mimir — Full Project Context for AI Agent

You are being onboarded to the Mimir codebase. This document is **self-contained** — it includes architecture, stack, and implementation status so you can work on this project efficiently.

`docs/STELLAR_NETWORK.md` is the one-page network reference; `docs/AGENTS.md` holds the working rules in more detail.

---

## What is Mimir?

Mimir is an **AI-settled prediction market** built on **Stellar Testnet** (network passphrase `Test SDF Network ; September 2015`, CAIP-2 `stellar:testnet`). Users create verifiable claims about real-world outcomes (sports, crypto, weather, culture), stake **USDC**, and share a link for opponents to challenge. When the deadline arrives, the Mimir oracle agent:

1. Fetches live evidence from the web (claim's `resolutionUrl`)
2. Evaluates the evidence via an LLM (Gemini preferred, Anthropic / Groq / OpenRouter fallbacks)
3. Sends a `resolve_claim` invocation to the Soroban contract with the verdict
4. The winning creator is paid on resolution; winning challengers pull their share — no committees, no disputes

**One-liner:** "An AI-settled claim market supporting head-to-head, 1-v-many, pool-odds, fixed-odds, and rivalry-linked rematches — settled in USDC on Stellar."

**License:** AGPL-3.0-or-later
**Default locale:** English (en)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16 (App Router), React 18, TypeScript 5 |
| Styling | Tailwind CSS 3.4, Framer Motion 12 |
| Blockchain | Stellar Testnet, `@stellar/stellar-sdk` 16 (Soroban RPC + Horizon) |
| Smart contracts | Rust / Soroban — `contracts-soroban/mimir-market`, `contracts-soroban/mimir-squad` |
| Stake / payout asset | Circle Testnet USDC via its Stellar Asset Contract (7 decimals) |
| Network fee | Native XLM (ledger fee + account reserve), self-funded, no sponsor |
| AI Oracle | `agents/oracle/index.ts` (off-chain, local Stellar seed) |
| Council | 10 AI personas — `agents/council/` (local seeds) |
| Payments | x402 v2 in USDC, Stellar-native `exact` scheme (`lib/x402/*`) |
| Messaging | XMTP Browser SDK v7 (encrypted peer-to-peer chat) |
| i18n | next-intl (English default) |
| Auth | Stellar Wallets Kit — Freighter, xBull, Albedo, Lobstr, Hana |
| Database | Neon Postgres (optional read-index cache) |
| Deployment | Vercel (frontend), Railway (workers), `deploy/deploy.ts` (contracts) |

---

## Project Structure (key paths)

```
mimir-markets/
├── app/                        # Next.js App Router
│   ├── [locale]/               # i18n routes (home, explorer, vs, dashboard, council, docs, …)
│   └── api/                    # Route handlers (vs, council, oracle, payments, cron)
├── agents/
│   ├── oracle/                 # Settler + optional auto-challenge
│   ├── market-creator/         # Autonomous market creation
│   └── council/                # 10 personas
├── components/                 # UI
├── contracts-soroban/
│   ├── mimir-market/           # Claim escrow, settlement, fee policy (Rust)
│   └── mimir-squad/            # Two-sided squad pools (Rust)
├── deploy/deploy.ts            # Build → deploy → initialize on Stellar Testnet
├── lib/
│   ├── stellar.ts              # Network config, RPC/Horizon, explorer links, getEvents scans
│   ├── usdc.ts                 # USDC SAC id, issuer, 7-decimal helpers
│   ├── contract.ts             # Contract client (reads + writes)
│   ├── content-hash.ts         # SHA-256 — the hash Soroban's host exposes
│   ├── stellar-message.ts      # SEP-43 signMessage verification (Ed25519, base64)
│   ├── stellar-trustline.ts    # One-off USDC trustline for a fresh account
│   ├── agent-wallets.ts        # Local keypairs for workers
│   ├── agents/                 # BYOA registry, wallet adapter, spend permissions
│   ├── x402/                   # config.ts (prices) / stellar-scheme.ts / server.ts / buyer.ts
│   ├── paid-revenue.ts         # atomic USDC ledger
│   ├── wallet.tsx / wallet-connectors.ts
│   └── xmtp/
├── scripts/                    # keys, faucet, bindings, fund wallets, seed, smoke tests
└── tests/node/                 # Smoke tests
```

---

## Environment Variables

**Public (browser-exposed):**
```
NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID   # Deployed mimir-market contract (C…)
NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID    # Deployed mimir-squad contract (C…)
NEXT_PUBLIC_STELLAR_USDC_SAC_ID          # USDC Stellar Asset Contract id (C…), derived
NEXT_PUBLIC_STELLAR_USDC_ISSUER          # Circle Testnet USDC issuer (G…)
NEXT_PUBLIC_STELLAR_NETWORK              # testnet
NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE   # Test SDF Network ; September 2015
NEXT_PUBLIC_STELLAR_RPC_URL              # Soroban RPC — set a provider in deployed envs
NEXT_PUBLIC_STELLAR_HORIZON_URL          # Horizon — set a provider in deployed envs
NEXT_PUBLIC_DEMO_MODE                    # "1" to enable demo relay
NEXT_PUBLIC_FEATURE_XMTP                 # Enable XMTP UI
NEXT_PUBLIC_XMTP_ENV                     # local | dev | production
```

**Server / workers only:**
```
STELLAR_DEPLOYER_SECRET             # Deploy + initialize (S…)
STELLAR_ORACLE_SECRET               # Oracle agent (S…)
CREATOR_SECRET                      # Market-creator agent (S…)
COUNCIL_<SLUG>_SECRET               # Each council persona (workers, S…)
COUNCIL_<SLUG>_ADDRESS              # Public addresses (web-safe, G…)
STELLAR_PLATFORM_FEE_BPS            # Initial platform fee at deploy (default 200)
STELLAR_AGENT_OWNER_FEE_BPS         # Initial agent-owner fee at deploy (default 0)
SELLER_ADDRESS                      # Default x402 payTo for paid endpoints (G…)
X402_NETWORK                        # CAIP-2 id (default stellar:testnet)
X402_PAYMENT_MAX_AGE_MS             # Payment-proof freshness window (default 300000)
DATABASE_URL                        # Neon pooler URL (optional)
GEMINI_API_KEY / ANTHROPIC_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY
```

See `.env.example` for the full list (`*_USDC` budget knobs, council settlement, etc.).

---

## Key NPM Scripts

```bash
npm run dev                     # Start dev server
npm run build                   # Production build
npm run typecheck               # tsc --noEmit
npm run oracle                  # Start AI oracle agent
npm run market-creator          # Start market creator
npm run council                 # Start council worker
npm run workers                 # oracle + creator + council + sync + traders concurrently
npm run stellar:keys            # Keypairs + Friendbot funding + USDC trustline
npm run stellar:usdc            # Testnet USDC faucet helper
npm run stellar:bindings        # Regenerate contract bindings
npm run agents:create-wallets   # Generate 12 keypairs → .env.local
npm run agents:fund             # Fund agent accounts from a master seed
npm run deploy:contract         # Build, deploy and initialize on Stellar Testnet
npm run verify:deployment       # Assert the deployed contracts match this repo's config
npm run smoke:onchain           # End-to-end on-chain smoke (add --resolve --squad for full)
npm run smoke:x402              # Stellar x402 payment scheme smoke
npm run test:contracts          # cargo test over contracts-soroban
npm run check:terms             # Guardrail: no pre-Stellar chain or bespoke-402 residue
npm run test:smoke              # Node smoke tests
```

---

## Smart Contract: `contracts-soroban/mimir-market`

### Key constants (`src/types.rs`)
- `MIN_STAKE = 2_0000000` — 2 USDC (7 decimals, as the USDC Stellar Asset Contract reports)
- `MAX_CHALLENGERS = 100`
- `DEFAULT_PAYOUT_BPS = 20_000` — 2x for fixed odds
- `CHALLENGE_LOCK_SECONDS = 60` — anti-sniping window before deadline: a challenge is accepted up to and including `deadline - CHALLENGE_LOCK_SECONDS`, so a market created with less than the window left to live can never be challenged
- `MAX_TOTAL_FEE_BPS = 1_000` — hard 10% ceiling on platform + agent-owner fee, immutable by construction
- `FEE_TIMELOCK_SECONDS = 172_800` — a queued fee policy cannot execute for 2 days
- `MAX_INVITE_KEY_BYTES = 128` — a Soroban `String` must be marshalled through a fixed host buffer to be hashed

### Enums
- `ClaimState`: `Open` | `Active` | `Resolved` | `Cancelled`
- `WinnerSide`: `None` | `Creator` | `Challengers` | `Draw` | `Unresolvable`

### Write functions
No allowance step: Soroban authorises per invocation, so a stake carries an authorisation entry permitting exactly one USDC transfer of exactly that amount.

```
initialize(owner, oracle, usdc_token, platform_fee_bps, agent_owner_fee_bps, platform_recipient)
create_claim(creator, params) → claim_id
challenge_claim(challenger, claim_id, stake_amount, invite_key)
resolve_claim(claim_id, winner_side, summary, confidence, evidence_hash)  // oracle-only
cancel_claim(claim_id)
claim_challenger_payout(challenger, claim_id) → net      // pull, once per challenger, O(1)
withdraw(who) → amount                                    // parked-payout pull
claim_fees(who) → amount                                  // fee-recipient pull
set_oracle / transfer_ownership                           // owner-gated
queue_fee_policy / cancel_fee_policy / execute_fee_policy  // timelocked; execute is permissionless
```

A rematch is a `create_claim` with `parent_id` set, not a separate entry point.

### Payout logic
- **`Creator`**: creator receives the entire pot, less fees on profit only
- **`Challengers` (pool)**: pro-rata share of the creator stake + own stake returned
- **`Challengers` (fixed)**: `stake * challenger_payout_bps / 10_000`; unspent creator liability is refunded without a fee
- **`Draw` / `Unresolvable`**: full refunds, zero fee

### Why challenger settlement is pull-based
`resolve_claim` deliberately does not loop over challengers: a Stellar transaction is capped on its ledger-entry footprint and ~100 challengers do not fit. Resolution seeds `remaining_escrow`; each winner calls `claim_challenger_payout` once, and the last claimant absorbs the truncation dust so nothing is stranded. Nothing expires.

---

## Network Config (`lib/stellar.ts`)

```typescript
export const STELLAR_NETWORK: string        // "testnet"
export const NETWORK_PASSPHRASE: string     // Test SDF Network ; September 2015
export const STELLAR_EXPLORER_URL: string   // https://stellar.expert/explorer/testnet
export function getSorobanServer(): rpc.Server
export function getHorizonServer(): Horizon.Server
export function isAccountAddress(v: string): boolean    // G…
export function isContractAddress(v: string): boolean   // C…
export function getExplorerTxUrl / getExplorerAccountUrl / getExplorerContractUrl
export function getExplorerAddressUrl(address)           // dispatches on address form
export function stroopsToXlm(stroops: bigint): number
```

There is no chain-switch helper: Stellar wallets have no equivalent of an EVM chain-switch request. The network is decided by the RPC and passphrase Mimir submits to, so a wallet on the wrong network fails at signature time, not pre-flight.

## Token Config (`lib/usdc.ts`)

```typescript
export const USDC_DECIMALS = 7;   // verified by invoking decimals() on the live SAC
export function usdcToUnits(usdc: number): bigint   // display → atomic
export function unitsToUsdc(units: bigint): number  // atomic → display
export function readUsdcDecimals(sacId): Promise<number>  // real call, for drift alarms
```

`getUsdcSacId()` in `lib/stellar.ts` returns the configured Stellar Asset Contract id. Do not hardcode it: it is *derived* from the issuer, not chosen.

---

## Oracle Agent (`agents/oracle/index.ts`)

1. Poll claims past deadline
2. Fetch `resolutionUrl` (optional x402 paid evidence, capped in USDC)
3. Optional council jury (`COUNCIL_SETTLEMENT=1`)
4. LLM verdict → `resolve_claim` signed with `STELLAR_ORACLE_SECRET`

```bash
npm run oracle
# requires: STELLAR_ORACLE_SECRET, LLM key, NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID
```

The evidence digest committed on chain is SHA-256, not keccak256, so a contract could verify it.

---

## Authentication

### Primary: Stellar Wallets Kit
1. Click "Connect Wallet" → connector modal (Freighter, xBull, Albedo, Lobstr, Hana)
2. Wallet must already be on Testnet — there is no chain-switch prompt to offer
3. Address available via `useWallet()`

Capabilities differ, and the connect modal reflects it: Albedo cannot sign off-chain
messages (its own scheme predates SEP-43), which baskets and agent registration need;
only Freighter and Hana can co-sign an authorisation entry for another submitter.

### Fallback: Demo Relay Mode
- `NEXT_PUBLIC_DEMO_MODE=1`
- Server-side demo signers for create / challenge

---

## What is IMPLEMENTED

- [x] Soroban contracts on Stellar Testnet (USDC escrow, oracle-only resolution)
- [x] Off-chain AI oracle + market-creator + 10 council personas (local Stellar seeds)
- [x] Pool odds and fixed odds
- [x] Market types: binary, moneyline, spread, total, prop, custom
- [x] Rivalry/rematch system (`parent_id`)
- [x] Public + private (invite-link) claims
- [x] x402 v2 agent micropayments in USDC, Stellar-native scheme (buyer pays, seller verifies off Horizon)
- [x] Stellar Wallets Kit auth; single-signature staking with no standing approval
- [x] Pull settlement for challengers, parked payouts and accrued fees
- [x] Timelocked, capped fee policy with a per-claim snapshot
- [x] XMTP encrypted chat (feature-flagged)
- [x] English i18n, explorer, dashboard, stats, revenue, council pages
- [x] Neon read-index (optional)
- [x] Anti-sniping challenge lock

## Working Rules

- `contracts-soroban/` is the source of truth — regenerate bindings (`npm run stellar:bindings`) and keep `lib/contract.ts` aligned
- Stakes need **no** approval: authorisation is per invocation. XLM is the ledger fee only, never a stake and never an argument
- Every account funds its own fees. There is no sponsorship — an operation costs ~100 stroops
- A fresh account needs a one-off USDC trustline, which cannot share a transaction with a Soroban operation
- Resolution is oracle-only — do not expose user-triggered `resolve_claim` in UI
- Hash with SHA-256 (`lib/content-hash.ts`), never keccak: `env.crypto().sha256()` is the host primitive
- `G…`/`C…` strkeys are case-sensitive base32 — never lowercase one for comparison
- Agents use local Stellar seeds in worker env only — never ship seeds to Vercel/browser
- Categories: `sports`, `weather`, `crypto`, `culture`, `custom`
- Network: **Stellar Testnet** — do not hardcode another passphrase or endpoint
- Money is accounted in atomic integers (`amount_atomic`), never floats
