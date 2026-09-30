/**
 * The HTTP edge of trace correlation.
 *
 * Two directions, and they are not symmetric:
 *
 *  - **Inbound (worker or client → web).** A caller may hand back an id we
 *    minted so one operation has one id across both processes. It may not choose
 *    one. `resolveRequestTrace` validates against {@link TRACE_ID_PATTERN} and
 *    mints a fresh id for anything else, reporting the attempt as `rejected` so a
 *    hostile or buggy caller is visible in the span rather than silently
 *    relabelled.
 *  - **Outbound (worker → web).** `outboundTraceHeaders()` attaches the ambient
 *    cycle's id, minting one when the call happens outside a cycle so no request
 *    is ever uncorrelated.
 *
 * `tracedRoute` is the wrapper a route handler adopts. It resolves the trace,
 * opens an `http.request` span, and writes the id onto the response — including
 * an error response, which is where an operator usually starts. It is deliberately
 * the outermost wrapper, so the span covers the paywall, the auth check and the
 * handler alike: a 402 that never reached the handler is still a traced request.
 */

import {
  currentTraceId,
  endSpan,
  mintTraceId,
  runWithTrace,
  sanitizeErrorText,
  startSpan,
  type SpanAttributeValue,
  type SpanStatus,
  type TraceContext,
  type TraceSource,
} from "./trace";
import { isTraceId, normalizeTraceId } from "./trace-id";

/**
 * `x-mimir-trace-` prefixed rather than the W3C `traceparent`.
 *
 * `traceparent` implies `tracestate` and a vendor format, and adopting the name
 * without the format is how a proxy ends up forwarding a half-understood header
 * that a downstream service then trusts. This is a single opaque id with a stated
 * contract: valid ids continue a trace, everything else is replaced.
 */
export const TRACE_HEADER = "x-mimir-trace-id";
export const TRACE_HEADER_NAME = "X-Mimir-Trace-Id";

export interface ResolvedTrace {
  traceId: string;
  source: TraceSource;
}

/** Just enough of `Headers` to read the correlation header. */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Decide which trace a request runs under. Never throws and never returns a
 * caller-supplied string it has not checked.
 */
export function resolveRequestTrace(headers: HeaderReader): ResolvedTrace {
  let raw: string | null = null;
  try {
    raw = headers.get(TRACE_HEADER);
  } catch {
    raw = null;
  }
  if (raw === null || raw.trim() === "") return { traceId: mintTraceId(), source: "generated" };
  const accepted = normalizeTraceId(raw);
  if (accepted) return { traceId: accepted, source: "inbound" };
  // Rejected: a new id, and the reason, so "why does the caller's id not match
  // its own logs" is answerable from the response alone.
  return { traceId: mintTraceId(), source: "rejected" };
}

function traceHeader(traceId: string): TraceHeaders {
  return { [TRACE_HEADER]: traceId };
}

/**
 * The correlation header as a value a caller can spread into `RequestInit.headers`
 * without losing the key's name to a typo.
 */
export type TraceHeaders = Record<string, string> & { [TRACE_HEADER]: string };

/** Attach a specific id to an outbound request. */
export function traceHeaders(traceId: string | null | undefined): TraceHeaders {
  return traceHeader(normalizeTraceId(traceId) ?? mintTraceId());
}

/**
 * Attach the ambient trace to an outbound request, minting one when the call is
 * not inside a traced cycle. Spread it into `init.headers` alongside whatever
 * else the call needs.
 */
export function outboundTraceHeaders(): TraceHeaders {
  return traceHeader(currentTraceId() ?? mintTraceId());
}

/**
 * Write the id onto a response.
 *
 * A response whose headers are immutable — one returned straight from `fetch`,
 * or a synthetic `Response` in some runtimes — throws on `set`. That is swallowed:
 * losing the header is a worse trace, not a broken request.
 */
export function withTraceHeader<T extends { headers: Headers }>(response: T, traceId: string): T {
  try {
    response.headers.set(TRACE_HEADER, traceId);
  } catch {
    // Immutable headers: the id is still on the span and in any error body.
  }
  return response;
}

function statusFor(status: number | undefined): SpanStatus {
  if (status === undefined) return "ok";
  if (status >= 500) return "error";
  return "ok";
}

/**
 * The 500 a traced route returns when its handler throws.
 *
 * Hand-built rather than taken from `lib/api/errors`, which already imports this
 * module's sibling for the ambient id: importing it back would close a cycle. The
 * body deliberately matches that module's `error` shape and includes no message,
 * because the throw may be the one thing carrying a value that should not be
 * written to a response.
 */
function internalErrorResponse(traceId: string): Response {
  return Response.json(
    { error: { code: "internal_error", trace_id: traceId } },
    { status: 500, headers: { [TRACE_HEADER]: traceId } },
  );
}

export interface RequestTraceOptions {
  /** Route label, e.g. `api.council.vote`. Falls back to the path. */
  route?: string;
}

/**
 * The arguments the wrapper takes.
 *
 * Normally the handler's own parameters, unchanged. The zero-argument case — a test
 * double, or a route whose work genuinely needs no request — is widened to accept
 * one anyway: the span reads the method and the response carries the id, so the
 * wrapper has a request regardless, and refusing the argument would push a cast
 * onto every such call site.
 */
export type TracedArgs<H extends (...args: never[]) => unknown> = Parameters<H> extends []
  ? [request?: Request]
  : Parameters<H>;

/**
 * What the wrapper hands back.
 *
 * The handler's own return type, so `export const GET` keeps whatever type Next
 * expects. The one exception is a handler that can only throw: its return type is
 * `never`, which would type the response as `never` too, when in fact the wrapper
 * answers with the 500 it built.
 */
export type TracedResult<H extends (...args: never[]) => unknown> = [Awaited<ReturnType<H>>] extends [never]
  ? Response
  : Awaited<ReturnType<H>>;

/**
 * Wrap a route handler in a request trace.
 *
 * Drop-in for `export const GET = handler`:
 *
 *   export const GET = tracedRoute("api.council.vote", paidRoute("councilVote", h));
 *
 * The handler's return value is passed through untouched apart from the added
 * header, so a route that returns a 402, a 503 or a streamed body behaves exactly
 * as it did before.
 *
 * Typed over the handler's own signature rather than a `(req, ctx)` pair, because
 * Next.js route signatures differ per route: `Request` vs `NextRequest`, one
 * argument vs two, `Response` vs `NextResponse`. Anything narrower would force a
 * cast at every call site, and a cast is exactly where a dropped error status hides.
 */
export function tracedRoute<H extends (...args: never[]) => Promise<Response> | Response>(
  name: string,
  handler: H,
  opts: RequestTraceOptions = {},
): (...args: TracedArgs<H>) => Promise<TracedResult<H>> {
  return async (...args: TracedArgs<H>): Promise<TracedResult<H>> => {
    const request = args[0] as unknown as { headers?: HeaderReader; method?: string } | undefined;
    const resolved = resolveRequestTrace(request?.headers ?? { get: () => null });
    const context: TraceContext = { traceId: resolved.traceId, source: resolved.source };
    const route = opts.route ?? name;
    // Annotated rather than inferred: the generic return type of the handler
    // confuses inference through the nested `runWithTrace` call.
    const traced = async (): Promise<TracedResult<H>> => {
      const span = startSpan(route, {
        attributes: {
          "http.method": typeof request?.method === "string" ? request.method : "UNKNOWN",
          "trace.source": resolved.source,
        },
      });
      try {
        // `Promise.resolve` unwraps a handler that returns a promise and leaves a
        // synchronous one alone; the casts are the one place the wrapper meets a
        // response and an argument list it only needs for `.status` and `.headers`.
        const response = (await Promise.resolve(
          handler(...(args as unknown as Parameters<H>)),
        )) as Response;
        endSpan(span, {
          status: statusFor(response?.status),
          attributes: { "http.status_code": response?.status ?? 0 } as Record<string, SpanAttributeValue>,
        });
        return withTraceHeader(response, resolved.traceId) as TracedResult<H>;
      } catch (error) {
        endSpan(span, { error });
        // An unhandled throw becomes a 500 that still carries the id, rather than
        // being rethrown into Next's error boundary — a boundary-generated
        // response has headers this wrapper cannot reach, and an uncorrelatable
        // 500 is the one failure an operator cannot afford to lose. The trace is
        // logged with its id first, so the stack is still in the server log rather
        // than only in the span, and routes that already funnel failures through
        // `apiError` return a response and never reach this branch.
        console.error(`[trace ${resolved.traceId}] ${sanitizeErrorText(error)}`);
        return internalErrorResponse(resolved.traceId) as TracedResult<H>;
      }
    };
    return runWithTrace(context, traced);
  };
}

export { isTraceId };
