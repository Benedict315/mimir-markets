/**
 * POST /api/analytics/event — the only way a browser event reaches PostHog.
 *
 * Exists so the actor salt never leaves the server (see lib/analytics/server.ts)
 * and so redaction cannot be skipped by a client. Always answers 204: analytics
 * must never surface an error to a user, and a body would only invite clients to
 * branch on it.
 *
 * Traced, because the ingest request is server-side telemetry like any other: a
 * capture that silently stops looks identical to a page nobody visited. Note what
 * the trace id here does and does not mean — it identifies THIS ingest, not the
 * navigation that produced the event. A browser may not assert a trace id of its
 * own, so the one in the response belongs to the server and only a client that
 * already held an id we minted would match it.
 */

import { NextResponse, type NextRequest } from "next/server";
import { capture, type CaptureArgs } from "@/lib/analytics/server";
import { isAnalyticsEvent } from "@/lib/analytics/events";
import { tracedRoute } from "@/lib/ops/trace-http";

export const dynamic = "force-dynamic";

/** Do Not Track / Global Privacy Control at the HTTP layer. */
function serverSideOptOut(req: NextRequest): boolean {
  return req.headers.get("dnt") === "1" || req.headers.get("sec-gpc") === "1";
}

async function ingest(req: NextRequest): Promise<NextResponse> {
  const noContent = new NextResponse(null, { status: 204 });
  if (serverSideOptOut(req)) return noContent;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return noContent;
  }

  const input = body as {
    event?: string;
    envelope?: Record<string, unknown>;
    properties?: Record<string, unknown>;
    address?: string | null;
    idempotencyKey?: string;
  };

  if (!input.event || !isAnalyticsEvent(input.event)) return noContent;
  const surface = input.envelope?.source_surface;
  if (typeof surface !== "string") return noContent;

  // A browser client may never assert it is an agent: agent events are captured
  // server-side from the workers, where the identity is actually known. Same for
  // actor_type — the client does not get to label itself.
  await capture({
    event: input.event,
    envelope: {
      ...(input.envelope ?? {}),
      actor_type: "human",
      source_surface: surface,
    } as CaptureArgs["envelope"],
    properties: input.properties as CaptureArgs["properties"],
    address: input.address ?? null,
    isAgent: false,
    idempotencyKey: input.idempotencyKey,
    consented: true,
  });

  return noContent;
}

export const POST = tracedRoute("api.analytics.event", ingest);
