/**
 * Mimir Read-Index Sync Worker
 *
 * Reconciles the Neon read index against on-chain state. Contract state is the
 * source of truth; this keeps /explorer, /dashboard and the VS APIs from serving
 * stale claims, and it is the `sync` worker /api/health monitors.
 *
 * Lives in the worker fleet rather than behind a platform cron: Railway already
 * runs this fleet as a long-lived process, so an in-process interval needs no
 * scheduler, no HTTP hop and no shared secret to go wrong.
 *
 * Read-only: this worker signs nothing. Everything it needs comes from Soroban RPC
 * through `lib/contract.ts` (claims) and `lib/stellar.ts` (`getEvents`, for the
 * settlement projection), so it needs no keypair and holds no secret.
 *
 * Run: npx tsx agents/sync/index.ts
 * Env: DATABASE_URL, NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID,
 *      NEXT_PUBLIC_STELLAR_RPC_URL
 *      SYNC_POLL_INTERVAL_MS=300000 (poll cadence in ms, default 5m)
 */

import { getMarketContractId, getStellarRpcUrl } from "../../lib/stellar";
import { reportingPoll } from "../../lib/ops/heartbeat";
import { reconcileSettlements } from "../../lib/server/settlement-index";
import { reconcileVsIndex } from "../../lib/server/vs-index";
import {
  BackoffError,
  DependencyFailureError,
  StaleStateError,
  SYNC_BACKOFF,
  describeBackoffError,
  withBackoff,
} from "../../lib/ops/backoff-policies";

// Default 5m: the health probe warns when the index is over 300s stale, so a
// slower cadence would report a working sync as degraded.
const POLL_INTERVAL_MS = Number(process.env.SYNC_POLL_INTERVAL_MS ?? "300000");

async function poll(): Promise<void> {
  let rawSummary: unknown;
  try {
    rawSummary = await withBackoff("sync", () => reconcileVsIndex(), { policy: SYNC_BACKOFF });
  } catch (err) {
    if (err instanceof BackoffError) {
      console.warn(`[sync] ${describeBackoffError(err)}`);
      return;
    }
    throw err;
  }
  if (!rawSummary || typeof rawSummary !== "object") return;
  const summary = rawSummary as { synced: number; new: number; stateChanges: number };
  console.log(
    `[sync] ── Reconciled at ${new Date().toISOString()} — ` +
      `${summary.synced} synced, ${summary.new} new, ${summary.stateChanges} state change(s)`,
  );

  let rawFees: unknown;
  try {
    rawFees = await withBackoff("sync", () => reconcileSettlements(), { policy: SYNC_BACKOFF });
  } catch (err) {
    if (err instanceof BackoffError) {
      console.warn(`[sync] ${describeBackoffError(err)}`);
      return;
    }
    throw err;
  }
  if (!rawFees || typeof rawFees !== "object") return;
  const fees = rawFees as { settlements: number; accruals: number; payouts: number; claims: number; fromLedger: number; toLedger: number; truncated?: boolean };
  console.log(
    `[sync]    settlements: ${fees.settlements} market(s), ${fees.accruals} accrual(s), ` +
      `${fees.payouts} pull payout(s), ${fees.claims} fee claim(s) · ` +
      `ledgers ${fees.fromLedger}→${fees.toLedger}${fees.truncated ? " (truncated — will resume)" : ""}`,
  );
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required — the read index has nowhere to live");
  }

  console.log("═══════════════════════════════════════════════");
  console.log("  Mimir Read-Index Sync Worker");
  console.log(`  Contract   : ${getMarketContractId() || "(unset)"}`);
  console.log(`  Soroban RPC: ${getStellarRpcUrl()}`);
  console.log(`  Poll every : ${POLL_INTERVAL_MS / 1000}s`);
  console.log("═══════════════════════════════════════════════\n");

  // Reports a heartbeat either way, so a crash-looping sync shows as alive and
  // failing on /api/health rather than merely stale.
  const safePoll = () => reportingPoll("sync", "sync", POLL_INTERVAL_MS / 1000, poll);

  await safePoll();
  setInterval(safePoll, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[sync] Fatal:", err);
  process.exit(1);
});
