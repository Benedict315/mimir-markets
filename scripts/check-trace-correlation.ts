/**
 * Check trace correlation across the web server and the workers — fully offline.
 *
 *   npm run check:trace
 *
 * No DATABASE_URL, no network, no seeds, no LLM keys, no PostHog key: this runs on
 * a clean checkout and in CI, and it is deterministic apart from the random ids it
 * prints. Those ids are the useful part of a failure — they are exactly what an
 * operator would grep for.
 *
 * Exit 0 only when correlation holds end to end AND no fail-closed branch was
 * reachable. Findings are stable codes, not prose, so a CI failure names the
 * property that broke.
 *
 * See docs/TRACE_CORRELATION.md for the artifact, secret, environment, and
 * rollback policy this check sits inside.
 */

import { checkTraceCorrelation, formatTraceCheckReport } from "../lib/ops/trace-check";

async function main(): Promise<void> {
  const report = await checkTraceCorrelation();
  console.log(formatTraceCheckReport(report));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(
    "[check:trace] failed to run:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
