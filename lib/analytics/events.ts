/**
 * Analytics event contract — the shared envelope and the funnel event names.
 *
 * Two rules this module exists to enforce:
 *
 *  1. Every event carries the same envelope, so a funnel can be built without
 *     per-event special cases. `event_version` is stamped on all of them; a
 *     breaking payload change bumps it rather than silently reinterpreting old
 *     rows.
 *  2. Nothing user-secret is ever a property. Private keys, signatures, invite
 *     keys, raw prompts and per-user evidence are stripped at the capture
 *     boundary in ./redact.ts — this is analytics, not a ledger.
 *
 * Financial truth lives in the contract and payments_v2. PostHog is never a
 * source for money numbers.
 */

import { STELLAR_NETWORK, getMarketContractId } from "../stellar";
// The leaf module, not lib/ops/trace.ts: this file ships to the browser, and the
// full trace module imports node:async_hooks.
import { isTraceId } from "../ops/trace-id";
import type { ProductModifier, SettlementMode, SubjectType } from "../market-modes";

/**
 * Bumped on any breaking change to the envelope or a payload's meaning.
 *
 * **v2** replaced the numeric `chain_id` with a string `network` — see
 * {@link EventEnvelope}. Rows from v1 carry the old field and cannot be filtered
 * by `network`, which is exactly why the version is stamped on every event.
 */
export const EVENT_VERSION = 2;

/** Where the user was when the event happened. */
export type SourceSurface =
  | "home"
  | "explorer"
  | "vs_detail"
  | "vs_create"
  | "dashboard"
  | "council"
  | "agents"
  | "revenue"
  | "stats"
  | "share_card"
  | "messages"
  | "api"
  | "worker";

export type ActorType = "human" | "agent" | "anonymous";

export type TxStatus = "none" | "submitted" | "confirmed" | "reverted" | "rejected" | "failed";

/**
 * Envelope present on every event. Optional fields are omitted rather than sent
 * as null so PostHog property filters stay clean.
 */
export interface EventEnvelope {
  event_version: number;
  /**
   * Stellar network name — `"testnet"` today, `"public"` if this ever ships to
   * Pubnet. Replaces the EVM `chain_id: number`.
   *
   * A STRING and the short name, not the network passphrase, on purpose. Nothing
   * downstream ever joined on `chain_id`: the only two consumers are
   * {@link hasRequiredEnvelope} and `lib/analytics/quality.ts`, which both merely
   * assert the field is present and well-typed. What the field is actually FOR is
   * a dashboard filter, and `network = "testnet"` reads in a PostHog breakdown
   * where a 34-character passphrase repeated on every event does not. The
   * passphrase remains the right identifier for signatures (see
   * `lib/api/signed-request.ts`), where the precision matters and the verbosity
   * costs nothing.
   */
  network: string;
  /** Market contract id (`C…`). Case-sensitive base32 — never lowercased. */
  contract?: string;
  claim_id?: number;
  category?: string;
  subject_type?: SubjectType;
  settlement_mode?: SettlementMode;
  modifiers?: ProductModifier[];
  actor_type: ActorType;
  agent_id?: string;
  source_surface: SourceSurface;
  locale?: string;
  tx_status?: TxStatus;
  /**
   * The `mh_…` trace this event was captured under, when the call site was inside
   * one (see `lib/ops/trace.ts`).
   *
   * Additive and optional, so this is NOT an envelope version bump: v2 is about
   * the shape of the fields that exist, and rows written before this one stay
   * measurable. What it buys is the join — an event that preceded a failed stake
   * becomes findable from the worker span that settled it, instead of being
   * correlated by a timestamp.
   *
   * A trace id is a random 128-bit value, never a wallet, a key, or anything else
   * derived from the user. It is validated on the way in, so a browser cannot
   * choose the value it is filed under.
   */
  trace_id?: string;
}

/** Every funnel event Mimir emits. Adding one here is the only way to emit it. */
export const ANALYTICS_EVENTS = [
  "market_viewed",

  "create_started",
  "create_mode_selected",
  "create_submitted",
  "create_confirmed",

  "stake_previewed",
  "stake_started",
  "stake_confirmed",
  "stake_failed",

  "settlement_return_viewed",

  "payout_preview_seen",
  "low_upside_warning_seen",

  "agent_viewed",
  "agent_followed",
  "agent_unfollowed",

  "reasoning_opened",
  "reasoning_x402_purchased",

  "share_card_generated",
  "share_card_clicked",

  "rematch_started",
  "rematch_confirmed",

  "copy_permission_created",
  "copy_executed",
  "copy_skipped",
  "copy_revoked",

  "basket_ownership_transferred",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export function isAnalyticsEvent(name: string): name is AnalyticsEvent {
  return (ANALYTICS_EVENTS as readonly string[]).includes(name);
}

/** Per-event properties, on top of the envelope. */
export type EventProperties = Record<string, string | number | boolean | string[] | undefined>;

export interface EventInput {
  event: AnalyticsEvent;
  envelope: Partial<EventEnvelope> & Pick<EventEnvelope, "actor_type" | "source_surface">;
  properties?: EventProperties;
}

type PropertyKind = "string" | "number" | "boolean";

/**
 * Runtime property contract. Browser input is untrusted even when its call site
 * is TypeScript, so undeclared and mistyped fields are removed before capture.
 */
export const EVENT_PROPERTY_SCHEMA: Record<AnalyticsEvent, Readonly<Record<string, PropertyKind>>> = {
  market_viewed: { unsupported_mode: "boolean" },
  create_started: { is_rematch: "boolean" },
  create_mode_selected: { is_rematch: "boolean" },
  create_submitted: { stake_bucket: "string", is_rematch: "boolean" },
  create_confirmed: { stake_bucket: "string", is_rematch: "boolean" },
  stake_previewed: { stake_bucket: "string", upside_bps: "number", is_low_upside: "boolean", total_return_multiple: "number" },
  stake_started: { stake_bucket: "string" },
  stake_confirmed: { stake_bucket: "string" },
  stake_failed: { failure_stage: "string" },
  settlement_return_viewed: {},
  payout_preview_seen: { stake_bucket: "string", upside_bps: "number", is_low_upside: "boolean", total_return_multiple: "number" },
  low_upside_warning_seen: { stake_bucket: "string", upside_bps: "number", is_low_upside: "boolean", total_return_multiple: "number" },
  agent_viewed: {},
  agent_followed: {},
  agent_unfollowed: {},
  reasoning_opened: {},
  reasoning_x402_purchased: {},
  share_card_generated: { card_kind: "string", card_size: "string", locked: "boolean" },
  share_card_clicked: {},
  rematch_started: { parent_claim_id: "number", best_of: "number" },
  rematch_confirmed: { parent_claim_id: "number", best_of: "number" },
  copy_permission_created: {},
  copy_executed: {},
  copy_skipped: {},
  copy_revoked: {},
  basket_ownership_transferred: {},
};

export function conformEventProperties(
  event: AnalyticsEvent,
  input: unknown,
): { properties: EventProperties; dropped: string[] } {
  const schema = EVENT_PROPERTY_SCHEMA[event];
  const properties: EventProperties = {};
  const dropped: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { properties, dropped: ["$payload"] };
  }
  for (const [key, value] of Object.entries(input)) {
    const expected = schema[key];
    const valid =
      (expected === "string" && typeof value === "string") ||
      (expected === "boolean" && typeof value === "boolean") ||
      (expected === "number" && typeof value === "number" && Number.isFinite(value));
    if (!valid) {
      dropped.push(key);
      continue;
    }
    properties[key] = value as string | number | boolean;
  }
  return { properties, dropped };
}

/** Fill in the parts of the envelope that are the same for every event. */
export function buildEnvelope(
  partial: Partial<EventEnvelope> & Pick<EventEnvelope, "actor_type" | "source_surface">,
): EventEnvelope {
  const contract = partial.contract ?? getMarketContractId();
  const envelope: EventEnvelope = {
    event_version: EVENT_VERSION,
    network: partial.network ?? STELLAR_NETWORK,
    actor_type: partial.actor_type,
    source_surface: partial.source_surface,
  };
  // Passed through verbatim. The EVM version lowercased it to normalise hex
  // casing; a `C…` strkey is case-sensitive base32 and lowercasing it produces a
  // contract id that matches nothing.
  if (contract) envelope.contract = contract;
  if (partial.claim_id !== undefined) envelope.claim_id = partial.claim_id;
  if (partial.category) envelope.category = partial.category;
  if (partial.subject_type) envelope.subject_type = partial.subject_type;
  if (partial.settlement_mode) envelope.settlement_mode = partial.settlement_mode;
  if (partial.modifiers && partial.modifiers.length > 0) envelope.modifiers = partial.modifiers;
  if (partial.agent_id) envelope.agent_id = partial.agent_id;
  if (partial.locale) envelope.locale = partial.locale;
  if (partial.tx_status) envelope.tx_status = partial.tx_status;
  // Only a well-formed id passes. A caller that has one is inside a trace; a
  // caller that passes an arbitrary string is not, and must not be able to file an
  // event under an id it chose.
  if (isTraceId(partial.trace_id)) envelope.trace_id = partial.trace_id;
  return envelope;
}

/**
 * True when this event has the fields the roadmap's KPI requires — used by the
 * completeness test rather than by a dashboard filter after the fact.
 */
export function hasRequiredEnvelope(properties: Record<string, unknown>): boolean {
  return (
    properties.event_version === EVENT_VERSION &&
    typeof properties.network === "string" &&
    properties.network.length > 0 &&
    properties.network.length <= 32 &&
    (properties.actor_type === "human" ||
      properties.actor_type === "agent" ||
      properties.actor_type === "anonymous") &&
    (ANALYTICS_SURFACES as readonly unknown[]).includes(properties.source_surface)
  );
}

const ANALYTICS_SURFACES: readonly SourceSurface[] = [
  "home", "explorer", "vs_detail", "vs_create", "dashboard", "council",
  "agents", "revenue", "stats", "share_card", "messages", "api", "worker",
];

/**
 * Build a deterministic idempotency key. Same inputs → same key, so a retried
 * worker or a double-submitted form is deduplicated by PostHog's $insert_id
 * instead of double-counting a funnel step.
 *
 * Pure, and deliberately not in ./server.ts: that module is server-only, and a
 * key builder needs to be usable from the client and from tests.
 */
export function idempotencyKey(parts: Array<string | number | undefined>): string {
  return parts.filter((part) => part !== undefined && part !== "").join(":");
}
