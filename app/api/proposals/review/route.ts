/**
 * The proposal review queue.
 *
 * Reads the pending market-creator proposals and moves them through the
 * queued -> in_review -> approved/rejected state machine. It is an operator tool,
 * not a user-facing API, so every handler is gated on the `internal_worker` tier
 * and the shared `CRON_SECRET` — the same pattern as the cron routes. An unset
 * `CRON_SECRET` refuses rather than waving callers through.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api/policy";
import { getDb, isDbConfigured } from "@/lib/db";
import {
  claimProposalForReview,
  completeProposalReview,
  cancelProposal,
  markProposalDependencyFailed,
  markStaleProposals,
  updateProposalReviewStatus,
} from "@/lib/db";

export const runtime = "nodejs";

const ROUTE = "/api/proposals/review";

function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

function errorResponse(message: string, status = 400): NextResponse {
  return json({ error: { message } }, status);
}

function requireAuth(request: NextRequest): NextResponse | null {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const auth = authorizeRequest("internal_worker", {
    route: ROUTE,
    presentedSecret: presented,
    expectedSecret: process.env.CRON_SECRET,
  });
  if (auth.allowed) return null;
  const error = auth.error;
  if (!error) return errorResponse("Unauthorized", 401);
  return NextResponse.json(error.body, { status: error.status, headers: error.headers });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = requireAuth(request);
  if (denied) return denied;

  if (!isDbConfigured()) {
    return errorResponse("Database not configured", 503);
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(searchParams.get("offset") ?? "0", 10);

  const pool = await getDb();
  let whereClause = "";
  const args: unknown[] = [];

  if (status) {
    whereClause = "WHERE review_status = ?";
    args.push(status);
  }

  args.push(limit, offset);

  const result = await pool.query(
    `SELECT
       proposal_id, created_at, question, creator_position, counter_position, category,
       subject_type, settlement_mode, product_modifiers, mode_rationale, stake_policy,
       context_pack_hash, resolution_url, settlement_rule, deadline, quality_score,
       preflight_verdict, disposition, blocked_by, claim_id, review, review_status,
       queued_at, claimed_at, reviewed_at, reviewer, failure_reason
     FROM market_proposals
     ${whereClause}
     ORDER BY queued_at DESC NULLS LAST, created_at DESC
     LIMIT ? OFFSET ?`,
    args,
  );

  return json({
    proposals: result.rows,
    limit,
    offset,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = requireAuth(request);
  if (denied) return denied;

  if (!isDbConfigured()) {
    return errorResponse("Database not configured", 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const { action, proposalId, reviewer, approve, reason } = body as {
    action: "claim" | "complete" | "cancel" | "mark_stale" | "mark_dependency_failed";
    proposalId?: string;
    reviewer?: string;
    approve?: boolean;
    reason?: string;
  };

  if (!action) {
    return errorResponse("Missing action", 400);
  }

  try {
    switch (action) {
      case "claim": {
        if (!proposalId || !reviewer) {
          return errorResponse("claim requires proposalId and reviewer", 400);
        }
        const ok = await claimProposalForReview(proposalId, reviewer);
        if (!ok) {
          return errorResponse("Proposal not available for claim (not queued or already claimed)", 409);
        }
        return json({ success: true, proposalId, status: "in_review" });
      }

      case "complete": {
        if (!proposalId || !reviewer || typeof approve !== "boolean") {
          return errorResponse("complete requires proposalId, reviewer, and approve (boolean)", 400);
        }
        const ok = await completeProposalReview(proposalId, reviewer, approve);
        if (!ok) {
          return errorResponse("Proposal not in review by this reviewer", 409);
        }
        return json({ success: true, proposalId, status: approve ? "approved" : "rejected" });
      }

      case "cancel": {
        if (!proposalId || !reason) {
          return errorResponse("cancel requires proposalId and reason", 400);
        }
        const ok = await cancelProposal(proposalId, reason);
        if (!ok) {
          return errorResponse("Proposal not cancellable (not queued or in_review)", 409);
        }
        return json({ success: true, proposalId, status: "cancelled" });
      }

      case "mark_dependency_failed": {
        if (!proposalId || !reason) {
          return errorResponse("mark_dependency_failed requires proposalId and reason", 400);
        }
        const ok = await markProposalDependencyFailed(proposalId, reason);
        if (!ok) {
          return errorResponse("Proposal not in a state that can be marked as dependency_failed", 409);
        }
        return json({ success: true, proposalId, status: "dependency_failed" });
      }

      case "mark_stale": {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const count = await markStaleProposals(nowSeconds);
        return json({ success: true, markedStale: count });
      }

      default:
        return errorResponse(`Unknown action: ${action}`, 400);
    }
  } catch (err) {
    console.error("[proposals/review] Error:", err);
    return errorResponse(err instanceof Error ? err.message : "Internal error", 500);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const denied = requireAuth(request);
  if (denied) return denied;

  if (!isDbConfigured()) {
    return errorResponse("Database not configured", 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const { proposalId, status, reviewer, failureReason } = body as {
    proposalId: string;
    status: "queued" | "in_review" | "approved" | "rejected" | "cancelled" | "stale" | "dependency_failed";
    reviewer?: string;
    failureReason?: string;
  };

  if (!proposalId || !status) {
    return errorResponse("Missing proposalId or status", 400);
  }

  const validStatuses = ["queued", "in_review", "approved", "rejected", "cancelled", "stale", "dependency_failed"];
  if (!validStatuses.includes(status)) {
    return errorResponse(`Invalid status: ${status}`, 400);
  }

  try {
    const ok = await updateProposalReviewStatus(proposalId, status, { reviewer, failureReason });
    if (!ok) {
      return errorResponse("Proposal not found or invalid state transition", 409);
    }
    return json({ success: true, proposalId, status });
  } catch (err) {
    console.error("[proposals/review] PATCH Error:", err);
    return errorResponse(err instanceof Error ? err.message : "Internal error", 500);
  }
}