/**
 * Per-cycle evidence cache.
 *
 * 10 personas often look at the same claim in a single poll cycle.
 * Without caching, that's 10 HTTP fetches of the same resolution URL
 * per claim per cycle — wasteful and rate-limit-prone.
 *
 * The runner builds one of these per cycle and the LLM evaluators ask
 * it before doing a fetch. Cleared between cycles to avoid serving
 * stale evidence at settlement time.
 */

import { sha256Hex } from "../../../lib/content-hash";
import {
  fetchEvidence as fetchEvidenceShared,
  EvidenceFetchError,
} from "../../../lib/server/evidence-fetcher";
import type { EvidenceCacheEntry } from "./types";

const MAX_CONTENT_CHARS = 8_000;

export async function getOrFetchEvidence(
  claimId: number,
  resolutionUrl: string,
  cache: Map<number, EvidenceCacheEntry>,
): Promise<EvidenceCacheEntry> {
  const hit = cache.get(claimId);
  if (hit) return hit;

  if (!resolutionUrl?.startsWith("http")) {
    const empty: EvidenceCacheEntry = {
      text:    "(No resolution URL provided)",
      fetcher: "none",
      hash:    sha256Hex("(No resolution URL provided)"),
    };
    cache.set(claimId, empty);
    return empty;
  }

  try {
    const snap = await fetchEvidenceShared(resolutionUrl, {
      maxChars:  MAX_CONTENT_CHARS,
      userAgent: "Mimir-Council/1.0",
    });
    const entry: EvidenceCacheEntry = {
      text:      snap.text,
      fetcher:   snap.fetcher,
      hash:      sha256Hex(snap.text),
      fetchedAt: snap.fetchedAt,
      sourceUrl: snap.sourceUrl,
    };
    cache.set(claimId, entry);
    return entry;
  } catch (err: unknown) {
    const msg =
      err instanceof EvidenceFetchError
        ? err.message
        : err instanceof Error
          ? err.message
          : "unknown";
    const failed: EvidenceCacheEntry = {
      text:    `(Failed to fetch: ${msg})`,
      fetcher: "none",
      hash:    sha256Hex(`(Failed to fetch: ${msg})`),
    };
    cache.set(claimId, failed);
    return failed;
  }
}
