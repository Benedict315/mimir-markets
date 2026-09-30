/**
 * Server-side capture — the ONLY path to PostHog.
 *
 * Browser events are posted to /api/analytics/event and forwarded from here, for
 * two reasons that are worth stating plainly:
 *
 *   1. The actor salt stays server-only. Handing the browser a salted hash would
 *      let anyone request hashes for arbitrary addresses and build a rainbow
 *      table over a public chain's address space — which defeats the salt.
 *   2. Redaction and consent are enforced on a boundary the client cannot skip.
 *
 * It also means no analytics SDK ships to the browser at all.
 *
 * Capture is awaited by callers. On Vercel the function freezes as soon as the
 * response returns, so a fire-and-forget POST is simply dropped.
 */

import "server-only";
import { buildEnvelope, conformEventProperties, hasRequiredEnvelope, isAnalyticsEvent, type EventInput } from "./events";
import { redactProperties, redactWalletAddresses } from "./redact";
import { isInternalActor, opaqueAnalyticsId, resolveActor } from "./actor";
import { currentTraceId } from "../ops/trace";
import { isTraceId } from "../ops/trace-id";

// Re-exported for server call sites; the implementation is pure and lives in
// ./events so the client and the tests can use it too.
export { idempotencyKey } from "./events";

const DEFAULT_HOST = "https://eu.i.posthog.com";

export interface CaptureArgs extends EventInput {
  /** Wallet address, if any. Hashed here; never forwarded. */
  address?: string | null;
  isAgent?: boolean;
  agentId?: string;
  /**
   * Stable key for this occurrence. PostHog deduplicates on $insert_id, so a
   * retried worker or a double-submitted route cannot double-count a funnel step.
   */
  idempotencyKey?: string;
  /** False when the user has not consented or sent DNT. */
  consented?: boolean;
  /** Epoch ms; defaults to now. */
  at?: number;
}

function apiKey(): string | null {
  return process.env.POSTHOG_API_KEY?.trim() || null;
}

/** Analytics is opt-in via env: with no key configured, capture is a no-op. */
export function isAnalyticsEnabled(): boolean {
  return apiKey() !== null && process.env.ANALYTICS_DISABLED !== "1";
}

/**
 * `test` keeps preview/CI traffic out of the production project even when both
 * share a key, so a smoke run cannot move a conversion metric.
 *
 * Falls back to whichever host set an environment name. Without the Railway arm a
 * Railway-hosted production tags every event `test`, and the analytics release gate
 * measures a funnel that looks permanently empty.
 */
export function analyticsEnvironment(): "production" | "test" {
  if (process.env.ANALYTICS_ENVIRONMENT === "production") return "production";
  if (process.env.ANALYTICS_ENVIRONMENT === "test") return "test";
  const hostEnv = process.env.VERCEL_ENV ?? process.env.RAILWAY_ENVIRONMENT_NAME;
  return hostEnv === "production" ? "production" : "test";
}

export interface CaptureResult {
  sent: boolean;
  reason?: "disabled" | "no_consent" | "unknown_event" | "incomplete_envelope" | "transport_error";
  dropped?: string[];
}

/**
 * Capture one event. Never throws: analytics must not be able to break a request
 * that was otherwise going to succeed.
 */
export async function capture(args: CaptureArgs): Promise<CaptureResult> {
  const key = apiKey();
  if (!key || !isAnalyticsEnabled()) return { sent: false, reason: "disabled" };
  if (args.consented === false) return { sent: false, reason: "no_consent" };
  if (!isAnalyticsEvent(args.event)) return { sent: false, reason: "unknown_event" };

  const actor = resolveActor({
    address: args.address,
    isAgent: args.isAgent,
    agentId: args.agentId,
  });

  const conformed = conformEventProperties(args.event, args.properties ?? {});
  // An explicit trace_id on the call wins over the ambient one; neither is trusted
  // until `buildEnvelope` has checked the shape. The id joins this event to the
  // worker span or request span that produced it — see docs/TRACE_CORRELATION.md.
  const traceId = args.envelope?.trace_id ?? currentTraceId();
  const envelope = buildEnvelope({
    ...args.envelope,
    actor_type: actor.actorType,
    ...(isTraceId(traceId) ? { trace_id: traceId } : {}),
  });
  const redacted = redactProperties({
    ...conformed.properties,
    ...envelope,
    analytics_environment: analyticsEnvironment(),
    // Cohort flag so internal wallets can be excluded from product metrics
    // rather than silently inflating them.
    is_internal: isInternalActor(actor.actorId),
    // Surfaces the case where a missing salt forced an anonymous event, so a
    // misconfigured deployment is visible instead of looking like real anons.
    actor_id_degraded: actor.degraded,
  });
  const safeProperties = redacted.properties;
  // Redact any wallet addresses that callers may have accidentally included in
  // properties or envelope. Contract addresses are preserved as public context.
  const { properties: finalProperties, dropped: addressDropped } = redactWalletAddresses(safeProperties);
  const insertId = args.idempotencyKey ? opaqueAnalyticsId(args.idempotencyKey) : null;
  const dropped = [
    ...conformed.dropped.map((key) => `properties.${key}`),
    ...redacted.dropped,
    ...addressDropped,
    ...(args.idempotencyKey && !insertId ? ["idempotencyKey"] : []),
  ];

  if (!hasRequiredEnvelope(finalProperties)) {
    return { sent: false, reason: "incomplete_envelope", dropped };
  }

  const host = process.env.POSTHOG_HOST?.trim() || DEFAULT_HOST;
  const body = {
    api_key: key,
    event: args.event,
    distinct_id: actor.actorId,
    timestamp: new Date(args.at !== undefined && Number.isFinite(args.at) ? args.at : Date.now()).toISOString(),
    properties: {
      ...finalProperties,
      // PostHog deduplicates on $insert_id.
      ...(insertId ? { $insert_id: insertId } : {}),
      // Salted ids are not people; person profiles would only add PII surface.
      $process_person_profile: false,
    },
  };

  try {
    const response = await fetch(`${host}/i/v0/e/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { sent: false, reason: "transport_error", dropped };
    return { sent: true, dropped };
  } catch {
    return { sent: false, reason: "transport_error", dropped };
  }
}
