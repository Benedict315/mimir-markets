import {
  getClaim,
  getClaimCount,
  getClaimSummaries,
  getClaimWithAccess,
  getUserClaimSummaries,
  mapClaimToVS,
  type ClaimChallenger,
  type ClaimData,
  type VSData,
} from "@/lib/contract";
import {
  getAllVSFast as getVsFeedFromCache,
  getUserVSFast as getUserVsFromCache,
  getVSByIdFast as getVsByIdFromCache,
  refreshVSIndex,
} from "@/lib/server/vs-cache";
import {
  getClaimById,
  getClaimsByChallenger,
  getClaimsByFilter,
  getChallengersByClaimId,
  getSyncMeta,
  setSyncMeta,
  upsertClaim,
  upsertClaimsBatch,
  upsertChallengers,
  type ChallengerRow,
  type ClaimRow,
} from "@/lib/db";
import {
  buildVSCacheFreshness,
  makeContractFreshness,
  type VSCacheFreshness,
} from "@/lib/vs-freshness";

const LIST_FRESHNESS_MS = 60_000;
const DETAIL_FRESHNESS_MS = 15_000;
const CLAIM_SYNC_PAGE_SIZE = 50;
const POST_WRITE_REFRESH_ATTEMPTS = 5;
const POST_WRITE_REFRESH_DELAY_MS = 1_500;
const BACKGROUND_REFRESH_COOLDOWN_MS = 30_000;

// ── Chain-state reconciliation and validation ───────────────────────────────

/**
 * Compare indexed claim state with chain state to detect inconsistencies.
 *
 * This is the contract-first accounting check: if the indexed state differs
 * from chain state, the index is wrong and must be corrected. Common drift
 * sources include RPC failures during sync, manual DB edits, or stale cache
 * reads that were persisted.
 */
export interface ClaimDiscrepancy {
  claimId: number;
  field: string;
  indexed: unknown;
  chain: unknown;
  severity: "critical" | "warning";
}

export function compareClaimStates(
  indexed: ClaimRow,
  chain: ClaimData
): ClaimDiscrepancy[] {
  const discrepancies: ClaimDiscrepancy[] = [];
  
  // Critical fields that must match exactly
  if (indexed.state !== chain.state) {
    discrepancies.push({
      claimId: indexed.id,
      field: "state",
      indexed: indexed.state,
      chain: chain.state,
      severity: "critical"
    });
  }
  
  if (indexed.creator !== chain.creator) {
    discrepancies.push({
      claimId: indexed.id,
      field: "creator",
      indexed: indexed.creator,
      chain: chain.creator,
      severity: "critical"
    });
  }
  
  // Financial fields that must match exactly (accounting correctness)
  if (Math.abs(indexed.creator_stake - chain.creator_stake) > 0.001) {
    discrepancies.push({
      claimId: indexed.id,
      field: "creator_stake",
      indexed: indexed.creator_stake,
      chain: chain.creator_stake,
      severity: "critical"
    });
  }
  
  if (Math.abs(indexed.total_challenger_stake - chain.total_challenger_stake) > 0.001) {
    discrepancies.push({
      claimId: indexed.id,
      field: "total_challenger_stake",
      indexed: indexed.total_challenger_stake,
      chain: chain.total_challenger_stake,
      severity: "critical"
    });
  }
  
  if (indexed.challenger_count !== chain.challenger_count) {
    discrepancies.push({
      claimId: indexed.id,
      field: "challenger_count",
      indexed: indexed.challenger_count,
      chain: chain.challenger_count,
      severity: "critical"
    });
  }
  
  // Warning-level fields (non-critical but indicate drift)
  if (indexed.category !== chain.category) {
    discrepancies.push({
      claimId: indexed.id,
      field: "category",
      indexed: indexed.category,
      chain: chain.category,
      severity: "warning"
    });
  }
  
  if (indexed.market_type !== chain.market_type) {
    discrepancies.push({
      claimId: indexed.id,
      field: "market_type",
      indexed: indexed.market_type,
      chain: chain.market_type,
      severity: "warning"
    });
  }
  
  return discrepancies;
}

/**
 * Validate Stellar addresses for correctness.
 *
 * Case-sensitive base32 validation ensures we haven't corrupted addresses
 * through lowercase conversions or other transformations.
 */
export function isValidStellarAddress(address: string): boolean {
  // Stellar addresses are either G... (account) or C... (contract)
  // They are case-sensitive base32 and should be 56 characters
  if (typeof address !== "string") return false;
  if (address.length !== 56) return false;
  if (!/^[GC]/.test(address)) return false;
  
  // Base32 character set check
  const base32Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  for (const char of address) {
    if (!base32Chars.includes(char)) return false;
  }
  
  return true;
}

/**
 * Validate money fields for accounting correctness.
 *
 * Ensures stakes and payouts are non-negative finite numbers with reasonable
 * precision (6 decimal places for USDC).
 */
export function validateMoneyField(value: number, fieldName: string): boolean {
  if (typeof value !== "number") return false;
  if (!Number.isFinite(value)) return false;
  if (value < 0) return false;
  
  // Check for reasonable precision (USDC has 6 decimals)
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  if (Math.abs(value - rounded) > 0.000001) {
    console.warn(`[vs-index] Money field ${fieldName} has excessive precision: ${value}`);
    return false;
  }
  
  return true;
}

/**
 * Comprehensive validation of a claim's state against accounting rules.
 */
export function validateClaimAccounting(claim: ClaimData): string[] {
  const errors: string[] = [];
  
  // Validate addresses
  if (!isValidStellarAddress(claim.creator)) {
    errors.push(`Invalid creator address: ${claim.creator}`);
  }
  
  if (claim.challenger_addresses) {
    for (const addr of claim.challenger_addresses) {
      if (!isValidStellarAddress(addr)) {
        errors.push(`Invalid challenger address: ${addr}`);
      }
    }
  }
  
  // Validate money fields
  if (!validateMoneyField(claim.creator_stake, "creator_stake")) {
    errors.push(`Invalid creator_stake: ${claim.creator_stake}`);
  }
  
  if (!validateMoneyField(claim.total_challenger_stake, "total_challenger_stake")) {
    errors.push(`Invalid total_challenger_stake: ${claim.total_challenger_stake}`);
  }
  
  if (!validateMoneyField(claim.reserved_creator_liability, "reserved_creator_liability")) {
    errors.push(`Invalid reserved_creator_liability: ${claim.reserved_creator_liability}`);
  }
  
  // Validate stake consistency
  const availableLiability = Math.max(0, claim.creator_stake - claim.reserved_creator_liability);
  if (availableLiability < 0) {
    errors.push(`Negative available liability: ${availableLiability}`);
  }
  
  // Validate pot calculation
  const calculatedPot = claim.creator_stake + claim.total_challenger_stake;
  if (Math.abs(calculatedPot - claim.total_pot) > 0.001) {
    errors.push(`Pot mismatch: calculated ${calculatedPot}, stored ${claim.total_pot}`);
  }
  
  // Validate challenger consistency
  if (claim.challenger_count === 0 && claim.total_challenger_stake > 0) {
    errors.push(`Zero challenger count but positive stake: ${claim.total_challenger_stake}`);
  }
  
  if (claim.challenger_count > 0 && claim.total_challenger_stake === 0) {
    errors.push(`Positive challenger count but zero stake: ${claim.challenger_count}`);
  }
  
  return errors;
}

// ── Cursor validation and restart safety ─────────────────────────────────────

/**
 * Validate and sanitize a sync cursor value.
 *
 * Malformed, negative, or non-numeric cursor values are rejected to prevent
 * corrupted state from propagating. This is the defense against a poisoned
 * `sync_meta` row — whether from manual intervention, a failed migration, or
 * a bug in an earlier version.
 */
export function validateCursorValue(value: string | null, key: string): number | null {
  if (value == null || value === "") return null;
  
  // Trim whitespace to reject "  100  " as invalid
  const trimmed = value.trim();
  if (trimmed !== value) {
    console.warn(`[vs-index] Invalid cursor value for ${key}: "${value}" (contains whitespace), resetting to null`);
    return null;
  }
  
  // Reject hexadecimal strings like "0x64"
  if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
    console.warn(`[vs-index] Invalid cursor value for ${key}: "${value}" (hexadecimal format), resetting to null`);
    return null;
  }
  
  // Reject scientific notation like "1e2" or "1E2"
  if (/^[+-]?\d+e[+-]?\d+$/i.test(trimmed)) {
    console.warn(`[vs-index] Invalid cursor value for ${key}: "${value}" (scientific notation), resetting to null`);
    return null;
  }
  
  const parsed = Number(trimmed);
  // Reject non-finite values, negative numbers, and NaN
  if (!Number.isFinite(parsed) || parsed < 0 || Number.isNaN(parsed)) {
    console.warn(`[vs-index] Invalid cursor value for ${key}: "${value}", resetting to null`);
    return null;
  }
  
  // Reject floating point numbers - cursor positions must be integers
  if (!Number.isInteger(parsed)) {
    console.warn(`[vs-index] Invalid cursor value for ${key}: "${value}" (not an integer), resetting to null`);
    return null;
  }
  
  return parsed;
}

/**
 * Transactionally update a sync cursor with validation.
 *
 * The cursor is only advanced if the new value is greater than the current one,
 * preventing cursor rollback from a race condition or malformed state. This is
 * called inside a database transaction in production, but the validation logic
 * lives here to keep the sync layer self-contained.
 */
async function advanceCursor(key: string, newValue: number): Promise<void> {
  const current = await getSyncMeta(key);
  const currentValidated = validateCursorValue(current, key);
  
  // Only advance; never roll back. A rollback would mean losing progress and
  // re-scanning already-indexed data, which is both wasteful and a replay risk.
  if (currentValidated !== null && newValue <= currentValidated) {
    console.warn(`[vs-index] Cursor ${key} would roll back from ${currentValidated} to ${newValue}, skipping update`);
    return;
  }
  
  await setSyncMeta(key, String(newValue));
}

/**
 * Recover from a corrupted or missing cursor by falling back to a safe default.
 *
 * This is the fail-closed path: if the cursor is unusable, we restart from a
 * known-good position rather than proceeding with bad state that could skip
 * data or duplicate work.
 */
async function recoverCursor(key: string, fallback: number): Promise<number> {
  const current = await getSyncMeta(key);
  const validated = validateCursorValue(current, key);
  
  if (validated === null) {
    console.warn(`[vs-index] Recovering cursor ${key} to fallback value ${fallback}`);
    await setSyncMeta(key, String(fallback));
    return fallback;
  }
  
  return validated;
}

type ReconcileResult = {
  synced: number;
  new: number;
  stateChanges: number;
  corrected: number;
  inconsistencies: number;
};

export type VSFeedSnapshot = {
  items: VSData[];
  cache: VSCacheFreshness;
};

export type VSDetailSnapshot = {
  item: VSData | null;
  cache: VSCacheFreshness;
};

type BackgroundTaskEntry = {
  startedAt: number;
  promise?: Promise<void>;
};

type VsIndexBackgroundState = {
  feedRefresh?: BackgroundTaskEntry;
  userRefreshes: Map<string, BackgroundTaskEntry>;
  detailRefreshes: Map<number, BackgroundTaskEntry>;
};

declare global {
  var __provenVsIndexBackgroundState: VsIndexBackgroundState | undefined;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBackgroundState(): VsIndexBackgroundState {
  if (!globalThis.__provenVsIndexBackgroundState) {
    globalThis.__provenVsIndexBackgroundState = {
      userRefreshes: new Map<string, BackgroundTaskEntry>(),
      detailRefreshes: new Map<number, BackgroundTaskEntry>(),
    };
  }

  return globalThis.__provenVsIndexBackgroundState;
}

function isBackgroundTaskCoolingDown(startedAt?: number) {
  return (
    typeof startedAt === "number" &&
    Date.now() - startedAt < BACKGROUND_REFRESH_COOLDOWN_MS
  );
}

function refreshVsIndexInBackground() {
  const state = getBackgroundState();
  const entry = state.feedRefresh;
  if (entry?.promise || isBackgroundTaskCoolingDown(entry?.startedAt)) {
    return;
  }

  const nextEntry: BackgroundTaskEntry = {
    startedAt: Date.now(),
  };

  nextEntry.promise = reconcileVsIndex()
    .then(() => {})
    .catch(() => {
      // Serve indexed rows immediately and let refresh failures degrade quietly.
    })
    .finally(() => {
      const currentState = getBackgroundState();
      const currentEntry = currentState.feedRefresh;
      if (currentEntry?.promise === nextEntry.promise) {
        currentState.feedRefresh = {
          startedAt: nextEntry.startedAt,
        };
      }
    });

  state.feedRefresh = nextEntry;
}

function hydrateUserClaimsInBackground(address: string) {
  // The strkey itself is the map key. Folding case would collapse two distinct
  // addresses onto one in-flight refresh entry.
  const state = getBackgroundState();
  const entry = state.userRefreshes.get(address);
  if (entry?.promise || isBackgroundTaskCoolingDown(entry?.startedAt)) {
    return;
  }

  const nextEntry: BackgroundTaskEntry = {
    startedAt: Date.now(),
  };

  nextEntry.promise = hydrateUserClaimsFromContract(address)
    .then(() => {})
    .catch(() => {
      // Keep serving indexed rows if chain reads are currently unreliable.
    })
    .finally(() => {
      const currentState = getBackgroundState();
      const currentEntry = currentState.userRefreshes.get(address);
      if (currentEntry?.promise === nextEntry.promise) {
        currentState.userRefreshes.set(address, {
          startedAt: nextEntry.startedAt,
        });
      }
    });

  state.userRefreshes.set(address, nextEntry);
}

function refreshIndexedClaimInBackground(options: {
  claimId: number;
  inviteKey?: string | null;
}) {
  const state = getBackgroundState();
  const entry = state.detailRefreshes.get(options.claimId);
  if (entry?.promise || isBackgroundTaskCoolingDown(entry?.startedAt)) {
    return;
  }

  const nextEntry: BackgroundTaskEntry = {
    startedAt: Date.now(),
  };

  nextEntry.promise = refreshIndexedClaim({
    claimId: options.claimId,
    inviteKey: options.inviteKey,
  })
    .then(() => {})
    .catch(() => {
      // Keep serving indexed rows if chain reads are currently unreliable.
    })
    .finally(() => {
      const currentState = getBackgroundState();
      const currentEntry = currentState.detailRefreshes.get(options.claimId);
      if (currentEntry?.promise === nextEntry.promise) {
        currentState.detailRefreshes.set(options.claimId, {
          startedAt: nextEntry.startedAt,
        });
      }
    });

  state.detailRefreshes.set(options.claimId, nextEntry);
}

function isPrivateClaim(claim: Pick<ClaimData, "visibility" | "is_private">) {
  return claim.visibility === "private" || Boolean(claim.is_private);
}

function sanitizeClaimForPublicRead(claim: ClaimData): ClaimData {
  if (!isPrivateClaim(claim)) {
    return claim;
  }

  return {
    ...claim,
    question: "",
    creator_position: "",
    counter_position: "",
    resolution_url: "",
    resolution_summary: "",
    handicap_line: "",
    settlement_rule: "",
  };
}

function isClaimFinal(state: string) {
  return state === "resolved" || state === "cancelled";
}

function isFresh(updatedAt: number, thresholdMs: number) {
  return Date.now() - updatedAt <= thresholdMs;
}

function getReferenceUpdatedAt(
  rows: Array<Pick<ClaimRow, "updated_at" | "is_final">>,
  fallbackUpdatedAt?: number | null
) {
  const mutableRows = rows.filter((row) => row.is_final === 0);
  const mutableReference =
    mutableRows.length > 0
      ? Math.min(...mutableRows.map((row) => row.updated_at))
      : null;
  const anyReference =
    rows.length > 0 ? Math.max(...rows.map((row) => row.updated_at)) : null;

  if (typeof fallbackUpdatedAt === "number" && Number.isFinite(fallbackUpdatedAt)) {
    if (mutableReference != null) {
      return Math.max(fallbackUpdatedAt, mutableReference);
    }

    if (anyReference != null) {
      return Math.max(fallbackUpdatedAt, anyReference);
    }

    return fallbackUpdatedAt;
  }

  return mutableReference ?? anyReference ?? null;
}

async function buildListCacheFreshness(rows: ClaimRow[]) {
  const lastSyncAt = Number((await getSyncMeta("last_sync_at")) ?? "0");
  return buildVSCacheFreshness({
    updatedAtMs: getReferenceUpdatedAt(rows, lastSyncAt > 0 ? lastSyncAt : null),
    freshnessWindowMs: LIST_FRESHNESS_MS,
    source: "index",
  });
}

function buildDetailCacheFreshness(row: ClaimRow | null) {
  return buildVSCacheFreshness({
    updatedAtMs: row?.updated_at ?? null,
    freshnessWindowMs: DETAIL_FRESHNESS_MS,
    source: "index",
  });
}

function challengerRowsToClaimChallengers(rows: ChallengerRow[]): ClaimChallenger[] {
  return rows.map((row) => ({
    address: row.address,
    stake: row.stake,
    potential_payout: row.potential_payout,
  }));
}

function claimRowToClaimData(
  row: ClaimRow,
  challengerRows: ChallengerRow[] = []
): ClaimData {
  const challengers = challengerRowsToClaimChallengers(challengerRows);
  const challengerAddresses =
    challengers.length > 0
      ? challengers.map((challenger) => challenger.address)
      : row.first_challenger
      ? [row.first_challenger]
      : [];

  return {
    id: row.id,
    creator: row.creator,
    question: row.question ?? "",
    creator_position: row.creator_position ?? "",
    counter_position: row.counter_position ?? "",
    resolution_url: row.resolution_url ?? "",
    creator_stake: row.creator_stake,
    total_challenger_stake: row.total_challenger_stake,
    reserved_creator_liability: row.reserved_creator_liability,
    available_creator_liability: Math.max(
      0,
      row.creator_stake - row.reserved_creator_liability
    ),
    deadline: row.deadline,
    state: row.state as ClaimData["state"],
    winner_side: row.winner_side as ClaimData["winner_side"],
    resolution_summary: row.resolution_summary ?? "",
    confidence: row.confidence,
    category: row.category,
    parent_id: row.parent_id,
    challenger_count: row.challenger_count,
    market_type: row.market_type,
    odds_mode: row.odds_mode,
    challenger_payout_bps: row.challenger_payout_bps,
    handicap_line: row.handicap_line ?? "",
    settlement_rule: row.settlement_rule ?? "",
    max_challengers: row.max_challengers,
    visibility: row.visibility as ClaimData["visibility"],
    is_private: row.visibility === "private",
    resolve_attempts: 0,
    creator_requested_resolve: false,
    challenger_requested_resolve: false,
    challengers: challengers.length > 0 ? challengers : undefined,
    first_challenger: row.first_challenger,
    challenger_addresses: challengerAddresses,
    total_pot: row.total_pot,
  };
}

function claimRowToVSData(row: ClaimRow, challengerRows: ChallengerRow[] = []) {
  return mapClaimToVS(claimRowToClaimData(row, challengerRows));
}

async function persistIndexedClaim(claim: ClaimData) {
  await upsertClaim(claim);

  if (Array.isArray(claim.challengers)) {
    await upsertChallengers(claim.id, claim.challengers);
    return;
  }

  if (claim.challenger_count === 0) {
    await upsertChallengers(claim.id, []);
  }
}

async function persistIndexedClaims(claims: ClaimData[]) {
  if (claims.length === 0) {
    return;
  }

  await upsertClaimsBatch(claims);
  await Promise.all(
    claims.map((claim) => {
      if (Array.isArray(claim.challengers)) {
        return upsertChallengers(claim.id, claim.challengers);
      }
      if (claim.challenger_count === 0) {
        return upsertChallengers(claim.id, []);
      }
      return undefined;
    })
  );
}

async function loadStoredVsById(vsId: number) {
  const [row, challengerRows] = await Promise.all([
    getClaimById(vsId),
    getChallengersByClaimId(vsId),
  ]);

  return { row, challengerRows };
}

async function loadStoredUserVs(address: string) {
  // Verbatim strkey on both lookups: `claims.creator` and `challengers.address`
  // now hold the exact address, so a folded value matches nothing.
  const creatorRows = await getClaimsByFilter({
    creator: address,
    orderBy: "id_desc",
  });

  const challengerClaimIds = await getClaimsByChallenger(address);
  const creatorIds = new Set(creatorRows.map((row) => row.id));
  const otherIds = challengerClaimIds.filter((id) => !creatorIds.has(id));
  const otherRows =
    otherIds.length > 0
      ? await getClaimsByFilter({
          ids: otherIds,
          orderBy: "id_desc",
        })
      : [];

  const rows = [...creatorRows, ...otherRows].sort((a, b) => b.id - a.id);
  const withChallengers = await Promise.all(
    rows.map(async (row) => {
      const challengerRows = await getChallengersByClaimId(row.id);
      return {
        row,
        challengerRows,
        vs: claimRowToVSData(row, challengerRows),
      };
    })
  );

  return withChallengers;
}

async function fetchClaimForIndex(
  claimId: number,
  inviteKey?: string | null
): Promise<ClaimData | null> {
  if (inviteKey) {
    return getClaimWithAccess(claimId, inviteKey);
  }

  return getClaim(claimId);
}

async function hydrateUserClaimsFromContract(address: string) {
  const claims = await getUserClaimSummaries(address);
  if (claims.length === 0) {
    return [];
  }

  await persistIndexedClaims(claims);

  const publicClaimsNeedingDetails = claims.filter(
    (claim) => !isPrivateClaim(claim) && claim.challenger_count > 0
  );

  if (publicClaimsNeedingDetails.length > 0) {
    const fullClaims = await Promise.all(
      publicClaimsNeedingDetails.map((claim) => getClaim(claim.id))
    );

    await Promise.all(
      fullClaims
        .filter((claim): claim is ClaimData => claim !== null)
        .map((claim) => persistIndexedClaim(claim))
    );
  }

  return claims
    .map(sanitizeClaimForPublicRead)
    .map(mapClaimToVS)
    .sort((a, b) => b.id - a.id);
}

export async function refreshIndexedClaim(options: {
  claimId: number;
  inviteKey?: string | null;
  attempts?: number;
  attemptDelayMs?: number;
}) {
  const attempts = options.attempts ?? 1;
  const attemptDelayMs = options.attemptDelayMs ?? 0;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const claim = await fetchClaimForIndex(options.claimId, options.inviteKey);
    if (claim) {
      await persistIndexedClaim(claim);
      return claim;
    }

    if (attempt < attempts - 1 && attemptDelayMs > 0) {
      await delay(attemptDelayMs);
    }
  }

  return null;
}

export async function getVsWithInvite(
  claimId: number,
  inviteKey: string
): Promise<VSData | null> {
  const claim = await getClaimWithAccess(claimId, inviteKey);
  if (!claim) {
    return null;
  }

  try {
    await persistIndexedClaim(claim);
  } catch {
    // Private claims should still load even if the read index is unavailable.
  }

  return mapClaimToVS(claim);
}

// Cap per-run work so a reconcile always finishes inside a serverless window
// (cron has maxDuration 60). Progress persists via sync_meta, so back-to-back
// runs converge on the full chain instead of restarting from scratch.
const RECONCILE_MAX_NEW_PAGES = 2;
const RECONCILE_MAX_ACTIVE_REFRESHES = 25;

export async function reconcileVsIndex(): Promise<ReconcileResult> {
  const now = Date.now();
  const [lastClaimCountValue, totalClaimCount, activeRows] = await Promise.all([
    getSyncMeta("last_claim_count"),
    getClaimCount(),
    getClaimsByFilter({
      states: ["open", "active"],
      orderBy: "id_desc",
    }),
  ]);

  // Use validated cursor; fall back to 0 if corrupted
  const lastClaimCount = validateCursorValue(lastClaimCountValue, "last_claim_count") ?? 0;
  let synced = 0;
  let newClaims = 0;
  let stateChanges = 0;
  let corrected = 0;
  let inconsistencies = 0;

  // 1. Backfill new claims page by page, checkpointing after EVERY page.
  //    The old version wrote last_claim_count only at the very end, so any
  //    timeout or RPC failure threw away all progress and the index stalled.
  let pagesDone = 0;
  for (
    let startId = lastClaimCount + 1;
    startId <= totalClaimCount && pagesDone < RECONCILE_MAX_NEW_PAGES;
    startId += CLAIM_SYNC_PAGE_SIZE, pagesDone += 1
  ) {
    const pageEnd = Math.min(startId + CLAIM_SYNC_PAGE_SIZE - 1, totalClaimCount);
    const expected = pageEnd - startId + 1;
    const pageClaims = await getClaimSummaries(startId, expected);
    
    // Validate chain-state accounting before persisting
    for (const claim of pageClaims) {
      const accountingErrors = validateClaimAccounting(claim);
      if (accountingErrors.length > 0) {
        console.warn(`[vs-index] Chain state accounting errors for claim ${claim.id}:`, accountingErrors);
        // Still persist the claim as-is from chain (contract-first principle)
        // but log the discrepancy for investigation
      }
    }
    
    if (pageClaims.length > 0) {
      await persistIndexedClaims(pageClaims);
      synced += pageClaims.length;
      newClaims += pageClaims.length;
    }

    if (pageClaims.length < expected) {
      // Claim ids are dense on-chain, so a short page means RPC reads failed.
      // Checkpoint only the contiguous prefix that DID come back, then stop:
      // the next run retries from there instead of skipping the gap forever.
      const got = new Set(pageClaims.map((claim) => claim.id));
      let checkpoint = startId - 1;
      while (got.has(checkpoint + 1)) checkpoint += 1;
      if (checkpoint >= startId) {
        await advanceCursor("last_claim_count", checkpoint);
      }
      break;
    }

    await advanceCursor("last_claim_count", pageEnd);
  }

  // 2. Refresh claims the index believes are open/active by reading only
  //    those ids, instead of re-scanning the entire chain to find them.
  const rowsToRefresh = activeRows.slice(0, RECONCILE_MAX_ACTIVE_REFRESHES);
  for (const row of rowsToRefresh) {
    const fresh = await refreshIndexedClaim({ claimId: row.id });
    if (!fresh) continue;
    
    // Validate chain-state accounting
    const accountingErrors = validateClaimAccounting(fresh);
    if (accountingErrors.length > 0) {
      console.warn(`[vs-index] Chain state accounting errors for refreshed claim ${fresh.id}:`, accountingErrors);
      inconsistencies += 1;
    }
    
    synced += 1;
    if (
      fresh.state !== row.state ||
      fresh.total_challenger_stake !== row.total_challenger_stake ||
      fresh.challenger_count !== row.challenger_count
    ) {
      stateChanges += 1;
      
      // Detect discrepancies between indexed and chain state
      const discrepancies = compareClaimStates(row, fresh);
      if (discrepancies.length > 0) {
        console.warn(`[vs-index] Chain-index discrepancy for claim ${row.id}:`, discrepancies);
        inconsistencies += discrepancies.filter(d => d.severity === "critical").length;
        corrected += 1; // This correction came from chain state
      }
    }
  }

  // 3. Periodic full validation of a sample of indexed claims
  //    This catches drift that might have been missed in the incremental refresh
  if (pagesDone === 0 && activeRows.length > 0) {
    const sampleSize = Math.min(5, activeRows.length);
    const sampleRows = activeRows.slice(0, sampleSize);
    
    for (const row of sampleRows) {
      const fresh = await refreshIndexedClaim({ claimId: row.id });
      if (!fresh) continue;
      
      const discrepancies = compareClaimStates(row, fresh);
      if (discrepancies.length > 0) {
        console.warn(`[vs-index] Validation discrepancy for claim ${row.id}:`, discrepancies);
        inconsistencies += discrepancies.filter(d => d.severity === "critical").length;
        corrected += 1;
      }
    }
  }

  // Advance sync timestamp only on successful completion
  await advanceCursor("last_sync_at", now);

  return {
    synced,
    new: newClaims,
    stateChanges,
    corrected,
    inconsistencies,
  };
}

export async function getVsFeedSnapshot(
  options: { forceRefresh?: boolean } = {}
): Promise<VSFeedSnapshot> {
  try {
    const rows = await getClaimsByFilter({
      visibility: "public",
      orderBy: "id_desc",
    });
    const lastSyncAt = Number((await getSyncMeta("last_sync_at")) ?? "0");
    const shouldRefresh =
      options.forceRefresh ||
      rows.length === 0 ||
      !lastSyncAt ||
      !isFresh(lastSyncAt, LIST_FRESHNESS_MS);

    if (options.forceRefresh || rows.length === 0) {
      await reconcileVsIndex();
      const refreshedRows = await getClaimsByFilter({
        visibility: "public",
        orderBy: "id_desc",
      });
      return {
        items: refreshedRows.map((row) => claimRowToVSData(row)),
        cache: buildVSCacheFreshness({
          updatedAtMs: Date.now(),
          freshnessWindowMs: LIST_FRESHNESS_MS,
          source: "index",
        }),
      };
    }

    if (shouldRefresh) {
      refreshVsIndexInBackground();
    }

    return {
      items: rows.map((row) => claimRowToVSData(row)),
      cache: await buildListCacheFreshness(rows),
    };
  } catch (err) {
    // Silent before: a DB outage (unset/expired DATABASE_URL, paused Neon) here
    // makes markets + stats + revenue all go dark with zero log. Surface it.
    console.error("[vs-index] getVsFeedSnapshot DB read failed:", err instanceof Error ? err.message : err);
    if (options.forceRefresh) {
      return {
        items: (await refreshVSIndex()).items,
        cache: makeContractFreshness(),
      };
    }
    return {
      items: await getVsFeedFromCache(),
      cache: buildVSCacheFreshness({
        updatedAtMs: null,
        freshnessWindowMs: LIST_FRESHNESS_MS,
        source: "index",
      }),
    };
  }
}

export async function getVsFeed(options: { forceRefresh?: boolean } = {}) {
  return (await getVsFeedSnapshot(options)).items;
}

// When a stored row exists we'd rather serve slightly stale data than let a
// slow RPC 504 the page: the live refresh gets this budget, then we fall back
// to the row. The refresh keeps running and persists for the next request.
const DETAIL_REFRESH_BUDGET_MS = 6_000;

function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export async function getVsDetailSnapshot(vsId: number): Promise<VSDetailSnapshot> {
  try {
    const { row, challengerRows } = await loadStoredVsById(vsId);
    if (row?.visibility === "private") {
      return {
        item: null,
        cache: buildDetailCacheFreshness(row),
      };
    }

    const missingChallengerDetails =
      row != null &&
      row.challenger_count > 0 &&
      challengerRows.length < row.challenger_count;

    if (
      row &&
      row.is_final === 1 &&
      !missingChallengerDetails &&
      isFresh(row.updated_at, DETAIL_FRESHNESS_MS)
    ) {
      return {
        item: claimRowToVSData(row, challengerRows),
        cache: buildDetailCacheFreshness(row),
      };
    }

    const freshClaim = row
      ? await withDeadline(refreshIndexedClaim({ claimId: vsId }), DETAIL_REFRESH_BUDGET_MS, null)
      : await refreshIndexedClaim({ claimId: vsId });
    if (freshClaim) {
      return {
        item: mapClaimToVS(freshClaim),
        cache: makeContractFreshness(),
      };
    }

    if (row) {
      return {
        item: claimRowToVSData(row, challengerRows),
        cache: buildDetailCacheFreshness(row),
      };
    }

    if (!row) {
      const [lastSyncAtValue, lastClaimCountValue] = await Promise.all([
        getSyncMeta("last_sync_at"),
        getSyncMeta("last_claim_count"),
      ]);

      const lastSyncAt = Number(lastSyncAtValue ?? "0");
      const lastClaimCount = Number(lastClaimCountValue ?? "0");
      const hasFreshIndex =
        lastSyncAt > 0 && isFresh(lastSyncAt, LIST_FRESHNESS_MS);

      if (hasFreshIndex && (lastClaimCount === 0 || vsId > lastClaimCount)) {
        return {
          item: null,
          cache: buildVSCacheFreshness({
            updatedAtMs: lastSyncAt > 0 ? lastSyncAt : null,
            freshnessWindowMs: LIST_FRESHNESS_MS,
            source: "index",
          }),
        };
      }
    }
  } catch {
    // Fall through to the existing cache-backed path below.
  }

  const fallbackItem = await getVsByIdFromCache(vsId);
  return {
    item: fallbackItem,
    cache: buildVSCacheFreshness({
      updatedAtMs: null,
      freshnessWindowMs: DETAIL_FRESHNESS_MS,
      source: "index",
    }),
  };
}

export async function getVsDetail(vsId: number) {
  return (await getVsDetailSnapshot(vsId)).item;
}

export async function getUserVsSnapshot(
  address: string,
  options: { forceRefresh?: boolean } = {}
): Promise<VSFeedSnapshot> {
  try {
    const storedEntries = await loadStoredUserVs(address);
    const storedItems = storedEntries.map((entry) => entry.vs);
    const storedRows = storedEntries.map((entry) => entry.row);
    const forceRefresh = options.forceRefresh === true;
    const shouldRefresh =
      forceRefresh ||
      storedEntries.length === 0 ||
      storedEntries.some(
        ({ row }) => row.is_final === 0 && !isFresh(row.updated_at, LIST_FRESHNESS_MS)
      );

    if (storedItems.length > 0 && !shouldRefresh) {
      return {
        items: storedItems,
        cache: buildVSCacheFreshness({
          updatedAtMs: getReferenceUpdatedAt(storedRows),
          freshnessWindowMs: LIST_FRESHNESS_MS,
          source: "index",
        }),
      };
    }

    if (storedItems.length > 0 && !forceRefresh) {
      if (shouldRefresh) {
        hydrateUserClaimsInBackground(address);
      }
      return {
        items: storedItems,
        cache: buildVSCacheFreshness({
          updatedAtMs: getReferenceUpdatedAt(storedRows),
          freshnessWindowMs: LIST_FRESHNESS_MS,
          source: "index",
        }),
      };
    }

    try {
      const freshItems = await hydrateUserClaimsFromContract(address);
      if (freshItems.length > 0) {
        return {
          items: freshItems,
          cache: makeContractFreshness(),
        };
      }
    } catch {
      if (storedItems.length > 0) {
        return {
          items: storedItems,
          cache: buildVSCacheFreshness({
            updatedAtMs: getReferenceUpdatedAt(storedRows),
            freshnessWindowMs: LIST_FRESHNESS_MS,
            source: "index",
          }),
        };
      }
    }

    return {
      items: storedItems,
      cache: buildVSCacheFreshness({
        updatedAtMs: getReferenceUpdatedAt(storedRows),
        freshnessWindowMs: LIST_FRESHNESS_MS,
        source: "index",
      }),
    };
  } catch {
    try {
      const freshItems = await hydrateUserClaimsFromContract(address);
      if (freshItems.length > 0) {
        return {
          items: freshItems,
          cache: makeContractFreshness(),
        };
      }
    } catch {
      // Keep falling back.
    }

    return {
      items: await getUserVsFromCache(address),
      cache: buildVSCacheFreshness({
        updatedAtMs: null,
        freshnessWindowMs: LIST_FRESHNESS_MS,
        source: "index",
      }),
    };
  }
}

export async function getUserVs(address: string) {
  return (await getUserVsSnapshot(address)).items;
}

export async function triggerPostWriteRefresh(options: {
  claimId: number;
  inviteKey?: string | null;
}) {
  return refreshIndexedClaim({
    claimId: options.claimId,
    inviteKey: options.inviteKey,
    attempts: POST_WRITE_REFRESH_ATTEMPTS,
    attemptDelayMs: POST_WRITE_REFRESH_DELAY_MS,
  });
}
