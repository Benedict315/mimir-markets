import { NextResponse } from "next/server";

import { apiError } from "@/lib/api/errors";
import { getVsFeedSnapshot } from "@/lib/server/vs-index";
import { VS_CACHE_HEADERS } from "@/lib/server/vs-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { authorizeRequest } = await import("@/lib/api/policy");
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
    const gate = authorizeRequest("public_read", { route: "/api/vs", ip });
    if (!gate.allowed && gate.error) {
      return NextResponse.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
    }
    const { searchParams } = new URL(request.url);
    const refreshValue = searchParams.get("refresh");
    const cursorValue = searchParams.get("cursor");
    const limitValue = searchParams.get("limit");

    if (refreshValue && refreshValue !== "1") {
      const err = apiError("invalid_request", "refresh must be 1 when provided", { field: "refresh" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const shouldRefresh = refreshValue === "1";
    const cursor = cursorValue ? Number(cursorValue) : undefined;
    const limit = limitValue ? Number(limitValue) : undefined;

    if (cursor !== undefined && (isNaN(cursor) || cursor <= 0)) {
      return NextResponse.json(
        createApiError("invalid_parameter", "cursor must be a positive integer"),
        { status: 400 }
      );
    }
    if (limit !== undefined && (isNaN(limit) || limit <= 0 || limit > 100)) {
      return NextResponse.json(
        createApiError("invalid_parameter", "limit must be between 1 and 100"),
        { status: 400 }
      );
    }

    const { items, cache, nextCursor } = await getVsFeedSnapshot({
      forceRefresh: shouldRefresh,
      cursor,
      limit,
    });

    return NextResponse.json(
      {
        items,
        count: items.length,
        cache,
        nextCursor,
      },
      {
        headers: VS_CACHE_HEADERS,
      }
    );
  } catch {
    const err = apiError("internal_error", "Unable to load VS feed");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}
