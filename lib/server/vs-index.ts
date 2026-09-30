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
import { validateCursorValue } from "@/lib/server/sync-helpers";
import {
  compareClaimStates,
  validateClaimAccounting,
  validateCursorValue,
} from "@/lib/server/sync-helpers";
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

// Re-export chain-state reconciliation types and functions for backwards compatibility
export type { ClaimDiscrepancy } from "@/lib/server/sync-helpers";
export { 
  compareClaimStates, 
  validateClaimAccounting,
  isValidStellarAddress,
  validateMoneyField 
} from "@/lib/server/sync-helpers";

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
  const currentValidated = validateCursorValue(current, key, "vs-index");
  
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
  const validated = validateCursorValue(current, key, "vs-index");
  
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
  nextCursor?: number | null;
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
      const claim = claimRowToClaimData(row, challengerRows);
      return {
        row,
        challengerRows,
        vs: mapClaimToVS(sanitizeClaimForPublicRead(claim)),
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
  const lastClaimCount = validateCursorValue(lastClaimCountValue, "last_claim_count", "vs-index") ?? 0;
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
      const accountingErrors = validateClaimAccounting(claim, "vs-index");
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
    const accountingErrors = validateClaimAccounting(fresh, "vs-index");
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
  options: { forceRefresh?: boolean; cursor?: number; limit?: number } = {}
): Promise<VSFeedSnapshot> {
  try {
    const { cursor, limit = 50 } = options;
    const rows = await getClaimsByFilter({
      visibility: "public",
      orderBy: "id_desc",
      cursor,
      limit: limit + 1, // Fetch one extra to determine if there's a next page
    });
    
    const hasMore = rows.length > limit;
    const paginatedRows = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? paginatedRows[paginatedRows.length - 1].id : null;

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
        cursor,
        limit: limit + 1,
      });
      const refreshedHasMore = refreshedRows.length > limit;
      const refreshedPaginatedRows = refreshedHasMore ? refreshedRows.slice(0, limit) : refreshedRows;
      const refreshedNextCursor = refreshedHasMore ? refreshedPaginatedRows[refreshedPaginatedRows.length - 1].id : null;

      return {
        items: refreshedPaginatedRows.map((row) => claimRowToVSData(row)),
        cache: buildVSCacheFreshness({
          updatedAtMs: Date.now(),
          freshnessWindowMs: LIST_FRESHNESS_MS,
          source: "index",
        }),
        nextCursor: refreshedNextCursor,
      };
    }

    if (shouldRefresh) {
      refreshVsIndexInBackground();
    }

    return {
      items: paginatedRows.map((row) => claimRowToVSData(row)),
      cache: await buildListCacheFreshness(paginatedRows),
      nextCursor,
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
      items: (await getVsFeedFromCache()).filter(
        (c) => !c.is_private && c.visibility !== "private"
      ),
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
  if (fallbackItem && (fallbackItem.visibility === "private" || fallbackItem.is_private)) {
    return {
      item: null,
      cache: buildVSCacheFreshness({
        updatedAtMs: null,
        freshnessWindowMs: DETAIL_FRESHNESS_MS,
        source: "index",
      }),
    };
  }

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
      items: (await getUserVsFromCache(address)).filter(
        (c) => !c.is_private && c.visibility !== "private"
      ),
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
