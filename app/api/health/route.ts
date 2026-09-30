/**
 * Operational health probe.
 *
 * Public but deliberately thin: severities, thresholds and the measurements
 * behind them, and nothing about users, markets or addresses. A status page
 * nobody can reach during an incident is not a status page, so this stays
 * unauthenticated — which is also why it must never leak anything an attacker
 * could use.
 *
 * Returns 503 only when something is actually broken. A warning stays 200,
 * because a load balancer that pulls the app out of rotation over a slow research
 * source turns a degradation into an outage.
 */

import { NextResponse } from "next/server";

import { getSettlementBacklog, getSyncMeta, isDbConfigured } from "@/lib/db";
import { evaluateHealth, healthHttpStatus, type HealthSnapshot } from "@/lib/ops/health";
import { readFailureWindow, readWorkerBeats } from "@/lib/ops/heartbeat";
import { readAgentBalances } from "@/lib/agent-wallets";
import { isAccountAddress } from "@/lib/stellar";

export const dynamic = "force-dynamic";

const EMPTY_WINDOW = { attempts: 0, failures: 0 } as const;

export async function GET() {
  const nowMs = Date.now();

  if (!isDbConfigured()) {
    // Without a database there are no signals at all, and pretending otherwise
    // would report a green probe for a system that cannot serve a single market.
    return NextResponse.json(
      {
        status: "critical",
        alarms: [{ id: "db.unconfigured", severity: "critical", message: "DATABASE_URL is not configured" }],
        operationalStatusUrl: "/api/health/status",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const agentRoles = [
    { name: "oracle", pub: process.env.ORACLE_PUBLIC ?? process.env.STELLAR_ORACLE_PUBLIC },
    { name: "market_creator", pub: process.env.CREATOR_PUBLIC ?? process.env.STELLAR_CREATOR_PUBLIC },
  ];

  const [workers, lastSyncAt, backlog, rpc, facilitator, sources, agentBalancesList] = await Promise.all([
    readWorkerBeats(),
    getSyncMeta("last_sync_at").catch(() => null),
    getSettlementBacklog().catch(() => null),
    readFailureWindow("rpc", nowMs),
    readFailureWindow("facilitator", nowMs),
    readFailureWindow("sources", nowMs),
    Promise.all(
      agentRoles.map(async (role) => {
        if (!role.pub || !isAccountAddress(role.pub)) return { name: role.name, balance: null };
        try {
          const bal = await readAgentBalances(role.pub);
          return { name: role.name, balance: bal.usdc };
        } catch {
          return { name: role.name, balance: null };
        }
      })
    ),
  ]);

  const lastSyncMs = Number(lastSyncAt ?? "0");
  const snapshot: HealthSnapshot = {
    workers,
    indexLastSyncAgeSec:
      Number.isFinite(lastSyncMs) && lastSyncMs > 0
        ? Math.max(0, Math.round((nowMs - lastSyncMs) / 1000))
        : null,
    // Job queueing is the workers' own poll interval today, so there is no
    // separate queue to lag. Reported as zero rather than invented.
    oldestQueuedJobAgeSec: 0,
    oldestOverdueSettlementSec: backlog?.oldestOverdueSec ?? 0,
    oracleBacklog: backlog?.count ?? 0,
    rpc,
    facilitator,
    sources: sources ?? EMPTY_WINDOW,
    agentBalancesUsdc: Object.fromEntries(agentBalancesList.map((a) => [a.name, a.balance])),
  };

  const report = evaluateHealth(snapshot, nowMs);

  // A failed backlog query means the claims table is unreadable, which the
  // snapshot above would otherwise report as an empty, healthy backlog.
  if (backlog === null) {
    report.alarms.unshift({
      id: "db.claims_unreadable",
      severity: "critical",
      message: "settlement backlog query failed",
      observed: 0,
      threshold: 0,
      unit: "count",
    });
    report.status = "critical";
  }

  return NextResponse.json(
    {
      ...report,
      operationalStatusUrl: "/api/health/status",
    },
    {
      status: healthHttpStatus(report.status),
      headers: { "Cache-Control": "no-store" },
    },
  );
}
