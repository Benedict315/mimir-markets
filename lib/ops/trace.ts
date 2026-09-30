/**
 * Trace correlation across the web server and the workers.
 *
 * Mimir's funded work happens in two processes that used to have nothing to say
 * to each other: the Next.js server that answers an agent's HTTP call, and the
 * long-running worker that made it. When a settlement went wrong the only handle
 * on the pair was a timestamp and a claim id, so "which call was this?" meant
 * reading two interleaved log streams by eye and hoping. This module gives both
 * sides one identifier and a span tree, so a single grep follows a worker cycle
 * from the poll that started it, through the web request it made, to the error
 * the caller got back.
 *
 * Four properties, each of which is a decision rather than an implementation
 * detail:
 *
 *  1. **A trace id is not a secret, and never becomes one.** It is 128 bits of
 *     `randomBytes` returned to the caller in a response header, so it cannot be
 *     used as a capability, a nonce, or a replay defence. Anything that needs
 *     unguessability has its own id: see `lib/agents/api-keys.ts` and
 *     `validateAgentRequestEnvelope`. Keeping those separate is the point — one
 *     id that were load-bearing for both would leak a credential every time it
 *     was logged.
 *  2. **Inbound ids are validated, not trusted.** A caller may continue an id we
 *     minted; a caller may not choose an arbitrary one. An id that does not match
 *     {@link TRACE_ID_PATTERN} is REPLACED and the attempt is reported as
 *     `rejected`, because an id reaches a log line, a response header and an
 *     analytics property, and an unvalidated one is a header-splitting and
 *     log-poisoning primitive.
 *  3. **Telemetry must never fail a request.** Nothing here throws. A span whose
 *     attributes cannot be sanitised records what it dropped; a sink that throws
 *     is swallowed; `MIMIR_TRACE_DISABLED=1` stops emission without changing the
 *     shape of any response, so a rollback never alters a contract an autonomous
 *     agent depends on.
 *  4. **A span is a place a secret can leak, so it is a redaction boundary.** The
 *     same threat model as `lib/analytics/redact.ts` — forbidden key names,
 *     secret-shaped values regardless of key, raw wallet addresses — applied at
 *     log time. Long text is dropped, not truncated: a clipped prompt is still a
 *     leak. `tests/node/trace-correlation.test.ts` pins this module's guard
 *     against the analytics one so the two cannot drift apart.
 *
 * It is chain-first in the sense that matters here: correlation is read-only
 * observability. It writes no ledger transaction, holds no escrow, and cannot
 * pause, authorise, or refuse a stake, a settlement, or a withdrawal. Chain state
 * remains the source of truth and `sync_meta` remains a cache.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import { SPAN_NAME_PATTERN, UNNAMED_SPAN, normalizeTraceId } from "./trace-id";

/**
 * The patterns and the predicate live in ./trace-id so that code which runs in the
 * browser — `lib/analytics/events.ts` stamps the envelope with a trace id — can
 * validate an id without pulling `node:async_hooks` into a client bundle. Re-exported
 * here because a caller that opens a span should not have to know how the split
 * works.
 */
export {
  SPAN_ID_PATTERN,
  SPAN_NAME_PATTERN,
  TRACE_ID_PATTERN,
  UNNAMED_SPAN,
  isTraceId,
  normalizeTraceId,
} from "./trace-id";

// ── Identity ──────────────────────────────────────────────────────────────────

/** 128 bits: enough that a trace id is a label, never a capability. */
export function mintTraceId(): string {
  return `mh_${randomBytes(16).toString("hex")}`;
}

export function mintSpanId(): string {
  return `sp_${randomBytes(8).toString("hex")}`;
}


// ── Ambient context ───────────────────────────────────────────────────────────

/**
 * Where a trace came from, so a rejected inbound id is visible and not silent.
 *
 * `rejected` is a real state and not an error: a caller that sent something which
 * is not a trace id gets a fresh one, and the request continues. The state is
 * recorded so an operator can tell "this id came from us" from "this id was
 * replaced", which is the difference between following a trace and chasing one.
 */
export type TraceSource = "inbound" | "generated" | "rejected";

export interface TraceContext {
  traceId: string;
  source: TraceSource;
  /** The worker whose cycle owns this trace, when there is one. */
  worker?: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();
const spanStorage = new AsyncLocalStorage<Span>();

/**
 * Run `fn` with `ctx` as the ambient trace.
 *
 * `AsyncLocalStorage` rather than a module-level variable because the web server
 * handles many requests per process: a global would let one request's span
 * inherit another's id, which is the exact bug correlation exists to prevent.
 *
 * A bare id is accepted because that is the natural thing to pass, and validated
 * here rather than trusted. Worth the extra branch: an unchecked string lands in
 * the store as a context with no `traceId`, and every reader then falls back to
 * `null` — correlation silently evaporates instead of failing. A malformed id is
 * replaced, and reported as `generated`, which is what it is.
 */
export function runWithTrace<T>(ctx: TraceContext | string, fn: () => T): T {
  if (typeof ctx === "string") {
    const accepted = normalizeTraceId(ctx);
    return traceStorage.run(
      accepted ? { traceId: accepted, source: "inbound" } : { traceId: mintTraceId(), source: "generated" },
      fn,
    );
  }
  return traceStorage.run(ctx, fn);
}

export function currentTrace(): TraceContext | null {
  return traceStorage.getStore() ?? null;
}

/** The id to stamp on a log line, an error body, or an analytics event. */
export function currentTraceId(): string | null {
  return traceStorage.getStore()?.traceId ?? null;
}

/** The innermost span currently open, for parent linkage. */
export function currentSpan(): Span | null {
  return spanStorage.getStore() ?? null;
}

// ── The leak guard ────────────────────────────────────────────────────────────

/**
 * Mirrors `FORBIDDEN_KEY_PATTERN` in `lib/analytics/redact.ts`.
 *
 * Deliberately duplicated rather than exported from there: that module is
 * `server-only` in spirit (it is imported by `server.ts`, which is), while a span
 * is opened in workers and scripts. `tests/node/trace-correlation.test.ts` asserts
 * the two lists reject the same corpus, so a key added to one without the other
 * fails the build.
 */
const FORBIDDEN_KEY_PATTERN =
  /(private[_-]?key|secret|password|passphrase|mnemonic|seed[_-]?phrase|signature|sig$|invite|pass[_-]?token|bearer|authorization|api[_-]?key|passport|prompt|evidence[_-]?text|raw[_-]?evidence|reasoning[_-]?text|chain[_-]?of[_-]?thought|cookie|session[_-]?token|email|payment[_-]?signature)/i;

/** A 32-byte hex string — a private key, or a hash of one. */
const HEX_32_BYTES = /^0x[0-9a-fA-F]{64}$/;
/** A 65-byte hex string — an ECDSA signature. */
const HEX_65_BYTES = /^0x[0-9a-fA-F]{130}$/;
/** JWT / base64url token shape. */
const TOKEN_LIKE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
/** A Stellar secret seed. */
const STELLAR_SECRET_SEED = /^S[A-Z2-7]{55}$/;
/** A Stellar account or contract strkey — pseudonymous but a real identity. */
const STELLAR_PUBLIC_ID = /^[GCM][A-Z2-7]{55}$/;
/** Anything unreasonably long for a categorical attribute. */
const MAX_STRING_LENGTH = 200;

/** Ceiling on attribute count, mirroring the analytics guard's. */
const MAX_ATTRIBUTES = 48;

export type SpanAttributeValue = string | number | boolean;

export interface SanitizedAttributes {
  attributes: Record<string, SpanAttributeValue>;
  /** Key paths refused by the guard, for the span's own `dropped` list. */
  dropped: string[];
}

function isSecretValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (HEX_32_BYTES.test(value) || HEX_65_BYTES.test(value)) return true;
  if (TOKEN_LIKE.test(value)) return true;
  if (STELLAR_SECRET_SEED.test(value.trim())) return true;
  return value.length > MAX_STRING_LENGTH;
}

function isRawActorIdentity(value: unknown): boolean {
  return typeof value === "string" && STELLAR_PUBLIC_ID.test(value.trim());
}

/**
 * The one exception to address redaction, and it is narrow on purpose: the
 * market contract id is a public constant the UI already prints, and correlating a
 * settlement needs it. Compared verbatim — a strkey is case-sensitive, so folding
 * case here would let a *different* account through as `contract`.
 */
function isPublicContractContext(key: string, value: unknown): boolean {
  return key === "contract" && typeof value === "string" && value.startsWith("C") && STELLAR_PUBLIC_ID.test(value.trim());
}

/**
 * Flatten and screen a span's attributes.
 *
 * Nested objects and arrays are reduced to a marker rather than walked: an
 * attribute on a span is a categorical label, and a span that needs a structure
 * belongs in an event payload that is redaction-checked before it is stored, not
 * in a log line.
 */
export function sanitizeAttributes(input: unknown): SanitizedAttributes {
  const attributes: Record<string, SpanAttributeValue> = {};
  const dropped: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { attributes, dropped };

  let visited = 0;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const path = key;
    if (++visited > MAX_ATTRIBUTES) {
      dropped.push(path);
      continue;
    }
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      dropped.push(path);
      continue;
    }
    if (value === undefined || value === null) continue;
    if (isPublicContractContext(key, value)) {
      attributes[key] = value as string;
      continue;
    }
    if (isSecretValue(value)) {
      dropped.push(path);
      continue;
    }
    if (isRawActorIdentity(value)) {
      dropped.push(path);
      continue;
    }
    if (typeof value === "string" || typeof value === "boolean") {
      attributes[key] = value;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      attributes[key] = value;
      continue;
    }
    // Arrays, nested objects, and non-finite numbers: refused rather than
    // stringified, because `String(value)` on a deep object is how a whole
    // request body ends up in a log line.
    dropped.push(path);
  }
  return { attributes, dropped };
}

/**
 * A URL in an error message carries its query string, and a query string carries
 * tokens, invite keys and x402 payment proofs. Keep the origin and path, drop the
 * rest — the path is what identifies the endpoint in an incident.
 */
const URL_WITH_QUERY = /\bhttps?:\/\/[^\s"'<>]+/g;

/**
 * Secret and identity shapes *embedded* in a larger string.
 *
 * The whole-value test above is not enough on its own, and the gap is not
 * theoretical: `Error("vote failed for S… with https://host/vote?proof=…")` is a
 * plausible message, it is nowhere near 200 characters, and it does not itself
 * match `^S[A-Z2-7]{55}$` — so a value-only check passes it straight through with
 * a seed in it. Anything of these shapes is replaced wherever it appears.
 *
 * Every strkey prefix is redacted here, including `C` market ids, even though a
 * market id is public and is deliberately *kept* as a named span attribute. Free
 * text has no key to say which is which, and the asymmetry favours redaction: an
 * operator who loses a market id from a message still has it in the span's
 * `contract` attribute, whereas a leaked seed cannot be recovered from anywhere.
 */
const EMBEDDED_SECRET =
  /0x[0-9a-fA-F]{64}|0x[0-9a-fA-F]{130}|[GSCM][A-Z2-7]{55}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/**
 * Make one error message safe to write down.
 *
 * Query strings first: stripping them removes most token material before the
 * shape rules run, and a redacted query is a more useful log line than
 * `[redacted]`.
 */
export function sanitizeErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const withoutQueries = raw.replace(URL_WITH_QUERY, (match) => `${match.split("?")[0]}?<redacted>`);
  const withoutSecrets = withoutQueries.replace(EMBEDDED_SECRET, "[redacted]");
  // Truncated because this string is rendered in an alarm line and in a log a human
  // reads at 3am; a stack trace pasted in buries the message it came with. The
  // span keeps the name and status, which is what the graph needs.
  return withoutSecrets.slice(0, MAX_STRING_LENGTH);
}

// ── Spans ─────────────────────────────────────────────────────────────────────

export type SpanStatus = "ok" | "error" | "cancelled";

export interface Span {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly startedAtMs: number;
  endedAtMs?: number;
  durationMs?: number;
  status?: SpanStatus;
  attributes: Record<string, SpanAttributeValue>;
  dropped: string[];
  error?: string;
}

export interface StartSpanOptions {
  attributes?: Record<string, unknown>;
  /** Defaults to the ambient trace; required when there is none. */
  traceId?: string;
  parent?: Span | null;
  nowMs?: number;
}

export interface EndSpanOptions {
  status?: SpanStatus;
  attributes?: Record<string, unknown>;
  error?: unknown;
  nowMs?: number;
}

/**
 * Open a span. Never throws: an invalid name becomes {@link UNNAMED_SPAN} rather
 * than failing the operation being observed.
 */
export function startSpan(name: string, opts: StartSpanOptions = {}): Span {
  const traceId = opts.traceId ?? currentTraceId() ?? mintTraceId();
  const parent = opts.parent === undefined ? currentSpan() : opts.parent;
  const dropped: string[] = [];
  const { attributes, dropped: attributeDrops } = sanitizeAttributes(opts.attributes);
  dropped.push(...attributeDrops);
  const safeName = SPAN_NAME_PATTERN.test(name) ? name : UNNAMED_SPAN;
  if (safeName === UNNAMED_SPAN && !SPAN_NAME_PATTERN.test(name)) dropped.push("name");
  return {
    name: safeName,
    traceId,
    spanId: mintSpanId(),
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    startedAtMs: opts.nowMs ?? Date.now(),
    attributes,
    dropped,
  };
}

/**
 * Close a span and hand it to the sink. Idempotent per span: a double end (a
 * `finally` racing an explicit call) emits once and mutates nothing, so a
 * retry-logging call site cannot rewrite a recorded duration.
 */
export function endSpan(span: Span, opts: EndSpanOptions = {}): Span {
  if (span.endedAtMs !== undefined) return span;
  const nowMs = opts.nowMs ?? Date.now();
  const { attributes, dropped } = sanitizeAttributes(opts.attributes);
  span.endedAtMs = nowMs;
  span.durationMs = Math.max(0, nowMs - span.startedAtMs);
  span.status = opts.status ?? (opts.error !== undefined ? "error" : "ok");
  if (opts.error !== undefined) span.error = sanitizeErrorText(opts.error);
  span.attributes = { ...span.attributes, ...attributes };
  span.dropped = [...span.dropped, ...dropped];
  emit(span);
  return span;
}

/**
 * `try`/`finally` around a unit of work, with the ambient span set for parent
 * linkage. Rethrows after recording, so an observed failure is still a failure.
 */
export async function withSpan<T>(
  name: string,
  opts: StartSpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = startSpan(name, opts);
  return spanStorage.run(span, async () => {
    try {
      const result = await fn(span);
      endSpan(span, { status: "ok" });
      return result;
    } catch (error) {
      endSpan(span, { error });
      throw error;
    }
  });
}

// ── Emission ──────────────────────────────────────────────────────────────────

export interface TraceSink {
  emit(span: Span): void;
}

/**
 * One JSON object per line, no prefix.
 *
 * A prefix would make `jq` and every log shipper's parser fail on a fixed prefix,
 * and the id is already the first field. `console.log` is stderr/stdout-agnostic
 * here because a JSONL line is inert either way.
 */
export function jsonlSink(write: (line: string) => void = (line) => console.log(line)): TraceSink {
  return {
    emit(span) {
      try {
        write(JSON.stringify(serializeSpan(span)));
      } catch {
        // A sink that cannot serialise is a reason to lose the line, never a
        // reason to fail the caller.
      }
    },
  };
}

export interface RecordedSpan {
  name: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  status: SpanStatus;
  started_at_ms: number;
  duration_ms: number;
  attributes: Record<string, SpanAttributeValue>;
  dropped: string[];
  error?: string;
}

/**
 * The wire form of a span: one JSON object, snake_case keys, matching the analytics
 * envelope's convention so a line parses the same way in both places.
 */
export function serializeSpan(span: Span): RecordedSpan {
  return {
    name: span.name,
    trace_id: span.traceId,
    span_id: span.spanId,
    ...(span.parentSpanId ? { parent_span_id: span.parentSpanId } : {}),
    status: span.status ?? "ok",
    started_at_ms: span.startedAtMs,
    duration_ms: span.durationMs ?? Math.max(0, Date.now() - span.startedAtMs),
    attributes: span.attributes,
    dropped: span.dropped,
    ...(span.error ? { error: span.error } : {}),
  };
}

/**
 * A bounded in-process tail of the most recent spans.
 *
 * Bounded because a worker runs for days and an unbounded buffer is a slow leak.
 * The cap is a stated trade: a burst of spans evicts the oldest, and the heartbeat
 * row — not this buffer — is what tells an operator which trace to grep for.
 */
export const DEFAULT_TRACE_BUFFER = 200;

export interface RecordingSink extends TraceSink {
  recent(limit?: number): Span[];
  lastTraceId(): string | null;
  clear(): void;
  size(): number;
}

export function recordingSink(capacity = DEFAULT_TRACE_BUFFER): RecordingSink {
  const buffer: Span[] = [];
  return {
    emit(span) {
      buffer.push(span);
      while (buffer.length > Math.max(1, capacity)) buffer.shift();
    },
    recent(limit = buffer.length) {
      return buffer.slice(-Math.max(0, limit));
    },
    lastTraceId() {
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i].traceId) return buffer[i].traceId;
      }
      return null;
    },
    clear() {
      buffer.length = 0;
    },
    size() {
      return buffer.length;
    },
  };
}

/**
 * Telemetry off. Span objects are still built — the cost is a `randomBytes` and an
 * object — so nothing downstream has to branch on "tracing disabled", and a
 * rollback changes no response shape, no header, and no log format.
 */
export function isTracingEnabled(): boolean {
  return process.env.MIMIR_TRACE_DISABLED !== "1";
}

const defaultSink: RecordingSink & TraceSink = (() => {
  const recorder = recordingSink();
  const lines = jsonlSink();
  return {
    emit(span) {
      recorder.emit(span);
      if (!isTracingEnabled()) return;
      lines.emit(span);
    },
    recent: recorder.recent,
    lastTraceId: recorder.lastTraceId,
    clear: recorder.clear,
    size: recorder.size,
  };
})();

let sink: TraceSink = defaultSink;

export function setTraceSink(next: TraceSink | null): void {
  sink = next ?? defaultSink;
}

export function getTraceSink(): TraceSink {
  return sink;
}

/** Test/diagnostic access to the process-wide tail. */
export function processTraceTail(limit?: number): Span[] {
  return defaultSink.recent(limit);
}

function emit(span: Span): void {
  try {
    sink.emit(span);
  } catch {
    // Rule 3: telemetry never fails the operation it observes.
  }
}
