/**
 * Trace identity, as a leaf module.
 *
 * Split out of `lib/ops/trace.ts` for one reason: the *check* is needed by code
 * that runs in the browser (`lib/analytics/events.ts`, which stamps the envelope),
 * and `trace.ts` imports `node:async_hooks` and `node:crypto`. Dragging those into
 * a client bundle to validate a string is how a "pure" helper becomes a build
 * failure.
 *
 * So this file holds the pattern and the predicate and imports nothing. Minting
 * stays in `trace.ts`, where the CSPRNG lives — minting is server-side by
 * definition, and a browser that invents its own trace ids would let a user file
 * events under ids of their choosing.
 */

/**
 * `mh_` + 128 bits of hex.
 *
 * The prefix makes a trace id greppable and keeps it from being mistaken for a
 * Stellar strkey, a `0x` secret, or a Postgres uuid at a glance. Hex rather than
 * base32 so the value can never collide with the `S…`/`G…`/`C…` alphabets the
 * redaction guard reasons about, and so it needs no case-folding — a strkey is
 * case-sensitive base32, and a comparison that folds case turns two accounts into
 * one.
 */
export const TRACE_ID_PATTERN = /^mh_[0-9a-f]{32}$/;

/** 64 bits: enough to disambiguate spans inside one trace, and nothing more. */
export const SPAN_ID_PATTERN = /^sp_[0-9a-f]{16}$/;

/**
 * Span names are a closed vocabulary, not free text. A name reaches a log line and
 * a metrics label, so a claim question or a wallet address must not be smuggled
 * through one.
 */
export const SPAN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Substituted for a name that fails {@link SPAN_NAME_PATTERN}. */
export const UNNAMED_SPAN = "unnamed";

export function isTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_PATTERN.test(value);
}

export function isSpanId(value: unknown): value is string {
  return typeof value === "string" && SPAN_ID_PATTERN.test(value);
}

/**
 * Accept an id only if it is one we could have minted, and return it in canonical
 * form. Null for everything else — a different prefix, the right shape at the wrong
 * length, a non-hex character, or a non-string.
 *
 * Surrounding whitespace is trimmed rather than rejected, because the whole trimmed
 * value still has to match the pattern in full: nothing can be smuggled past the
 * edges by trimming, and a proxy that preserves the optional whitespace `Headers`
 * would normally drop should not be the reason a trace is cut in two. Case is *not*
 * folded — hex ids are minted lowercase, and folding would make the accepted form
 * ambiguous about which string was actually minted.
 */
export function normalizeTraceId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return isTraceId(trimmed) ? trimmed : null;
}
