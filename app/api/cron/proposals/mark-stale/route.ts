/**
 * Cron: mark queued/in-review market proposals past their deadline as stale.
 *
 * Authorization: same `CRON_SECRET` bearer pattern as the other cron routes. The
 * tier fails closed when `CRON_SECRET` is unset, so a deploy that forgets the
 * secret returns 403 rather than leaving the sweep publicly callable.
 */

import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api/policy";
import { isDbConfigured } from "@/lib/db";
import { markStaleProposals } from "@/lib/db";

export const runtime = "nodejs";

const ROUTE = "/api/cron/proposals/mark-stale";

export async function POST(request: Request): Promise<NextResponse> {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const auth = authorizeRequest("internal_worker", {
    route: ROUTE,
    presentedSecret: presented,
    expectedSecret: process.env.CRON_SECRET,
  });
  if (!auth.allowed && auth.error) {
    return NextResponse.json(auth.error.body, {
      status: auth.error.status,
      headers: auth.error.headers,
    });
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ error: { message: "Database not configured" } }, { status: 503 });
  }

  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const count = await markStaleProposals(nowSeconds);

    return NextResponse.json(
      {
        success: true,
        markedStale: count,
        timestamp: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[cron/proposals/mark-stale] Error:", err);
    return NextResponse.json(
      { error: { message: err instanceof Error ? err.message : "Internal error" } },
      { status: 500 },
    );
  }
}
