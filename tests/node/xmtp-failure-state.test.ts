import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  classifyXmtpFailureKind,
  clearXmtpFailure,
  isXmtpRetryDisabled,
  nextXmtpFailure,
  shouldEscalateXmtpFailure,
  xmtpAutoRetryDelayMs,
  xmtpFailureMessageKey,
  XMTP_FAILURE_ESCALATION_ATTEMPT,
  XMTP_MAX_AUTO_RETRIES,
  XMTP_RETRY_DELAYS_MS,
  type XmtpFailureKind,
} from "../../lib/xmtp/failure-state";

const INSTALL_LIMIT =
  "Cannot register a new installation because the InboxID 6a965415 has already registered 10/10 installations. Please revoke existing installations first.";

/** Atajo: construyo el fallo con el mismo camino que la app. */
function failure(
  kind: XmtpFailureKind,
  previous: Parameters<typeof nextXmtpFailure>[0] = null,
  technical = "t"
) {
  return nextXmtpFailure(previous, kind, technical);
}

/* ── Clasificación: positivo ───────────────────────────────────────────────── */

test("classify: XmtpSignerError rejected is a declined signature, not a crash", () => {
  assert.equal(
    classifyXmtpFailureKind(new Error("user rejected the signature"), {
      signerCode: "rejected",
    }),
    "signature_declined"
  );
});

test("classify: unsupported wallet and malformed identity are separate kinds", () => {
  assert.equal(
    classifyXmtpFailureKind(new Error("nope"), { signerCode: "unsupported_wallet" }),
    "unsupported_wallet"
  );
  assert.equal(
    classifyXmtpFailureKind(new Error("nope"), { signerCode: "invalid_address" }),
    "invalid_identity"
  );
});

test("classify: installations limit beats the generic rate-limit match", () => {
  const kind = classifyXmtpFailureKind(new Error(INSTALL_LIMIT));
  assert.equal(kind, "installations_limit");
});

test("classify: 429, timeout and network wording each land on their own kind", () => {
  assert.equal(
    classifyXmtpFailureKind(new Error("Request failed with status 429")),
    "rate_limit"
  );
  assert.equal(
    classifyXmtpFailureKind(
      new Error("XMTP client initialization timed out. Try closing other tabs.")
    ),
    "timeout"
  );
  assert.equal(
    classifyXmtpFailureKind(new Error("TypeError: Failed to fetch")),
    "network"
  );
  assert.equal(
    classifyXmtpFailureKind(new Error("read ECONNRESET")),
    "network"
  );
});

test("classify: the peer-unreachable sentinel is not confused with a network error", () => {
  assert.equal(
    classifyXmtpFailureKind(new Error("XMTP_PEER_UNREACHABLE")),
    "peer_unreachable"
  );
});

test("classify: blocked_by_tab comes from the provider status, not the message", () => {
  // The SDK text is generic; only the status is authoritative here.
  assert.equal(
    classifyXmtpFailureKind(new Error("something odd"), {
      status: "blocked_by_tab",
    }),
    "blocked_by_tab"
  );
});

/* ── Clasificación: negativo y frontera ────────────────────────────────────── */

test("classify: empty, null and non-Error throws degrade to unknown, never throw", () => {
  assert.equal(classifyXmtpFailureKind(new Error("")), "unknown");
  assert.equal(classifyXmtpFailureKind(null), "unknown");
  assert.equal(classifyXmtpFailureKind(undefined), "unknown");
  assert.equal(classifyXmtpFailureKind({ weird: true }), "unknown");
});

test("classify: an Error with no message falls back to its name", () => {
  assert.equal(classifyXmtpFailureKind(new TypeError("")), "unknown");
});

test("classify: reads a plain string and a bare { message } object", () => {
  assert.equal(classifyXmtpFailureKind("Failed to fetch"), "network");
  assert.equal(classifyXmtpFailureKind({ message: "rate limit exceeded" }), "rate_limit");
});

/* ── Política de reintento ─────────────────────────────────────────────────── */

test("a declined signature is user-retryable but never auto-retried", () => {
  const declined = failure("signature_declined");
  assert.equal(declined.retryable, true, "the user can approve it next time");
  assert.equal(
    declined.autoRetryable,
    false,
    "auto-retry would reopen the wallet dialog nobody asked for"
  );
  assert.equal(xmtpAutoRetryDelayMs(declined), null);
});

test("an unsupported wallet is not retryable at all: Retry would be a lie", () => {
  const unsupported = failure("unsupported_wallet");
  assert.equal(unsupported.retryable, false);
  assert.equal(unsupported.needsExternalFix, true);
  assert.equal(xmtpAutoRetryDelayMs(unsupported), null);
  assert.equal(isXmtpRetryDisabled(unsupported, false), true);
});

test("invalid_identity is not retryable and not auto-retried", () => {
  const invalid = failure("invalid_identity");
  assert.equal(invalid.retryable, false);
  assert.equal(invalid.autoRetryable, false);
  assert.equal(xmtpAutoRetryDelayMs(invalid), null);
});

test("auto-retry follows the backoff schedule and then stops", () => {
  const first = failure("network");
  assert.equal(xmtpAutoRetryDelayMs(first), XMTP_RETRY_DELAYS_MS[0]);

  const second = failure("network", first);
  assert.equal(xmtpAutoRetryDelayMs(second), XMTP_RETRY_DELAYS_MS[1]);

  // Third consecutive failure: attempt 3, which exceeds XMTP_MAX_AUTO_RETRIES (2),
  // so no more auto-retry is scheduled.
  const last = failure("network", second);
  assert.equal(last.attempt, XMTP_MAX_AUTO_RETRIES + 1);
  assert.equal(xmtpAutoRetryDelayMs(last), null);

  // Boundary: one past the cap. The schedule is finite on purpose, otherwise a
  // persistent failure would keep the wallet/SW busy with the tab in the background.
  const overCap = failure("network", last);
  assert.equal(overCap.attempt, XMTP_MAX_AUTO_RETRIES + 2);
  assert.equal(xmtpAutoRetryDelayMs(overCap), null);
});

test("no failure means no retry, and retry is disabled while one is in flight", () => {
  assert.equal(xmtpAutoRetryDelayMs(null), null);
  assert.equal(isXmtpRetryDisabled(null, false), true);
  assert.equal(isXmtpRetryDisabled(null, true), true);

  const net = failure("network");
  assert.equal(isXmtpRetryDisabled(net, false), false);
  assert.equal(
    isXmtpRetryDisabled(net, true),
    true,
    "a second tap would cancel Client.create mid-flight"
  );
});

/* ── Encadenamiento de intentos (stale / duplicado / cancelado) ────────────── */

test("consecutive failures of the same kind escalate the attempt counter", () => {
  let current = failure("network");
  // First retry: attempt 2, not yet escalated (escalation at attempt 3)
  current = failure("network", current);
  assert.equal(current.attempt, 2);
  assert.equal(current.escalated, false, "not escalated yet at attempt 2");

  // Second retry: attempt 3, NOW escalated (threshold is 3)
  current = failure("network", current);
  assert.equal(current.attempt, XMTP_FAILURE_ESCALATION_ATTEMPT);
  assert.equal(current.escalated, true, "escalated at attempt 3");
  assert.equal(shouldEscalateXmtpFailure(current), true);
  assert.equal(shouldEscalateXmtpFailure(null), false);
});

test("a different kind resets the counter: a stale failure never inflates a new one", () => {
  const timedOutTwice = failure("network", failure("network"));
  assert.equal(timedOutTwice.attempt, 2);

  const thenRateLimited = failure("rate_limit", timedOutTwice);
  assert.equal(thenRateLimited.attempt, 1, "rate limit is its own first attempt");
  assert.equal(thenRateLimited.escalated, false);
});

test("success clears the failure, so the next failure is attempt 1 again", () => {
  const broken = failure("network", failure("network"));
  assert.equal(broken.attempt, 2);

  const afterSuccess = failure("network", clearXmtpFailure());
  assert.equal(afterSuccess.attempt, 1);
});

test("a duplicated failure of the same kind still counts once per report", () => {
  // Two `onError` callbacks for the same dropped stream is one user-visible
  // problem; the counter exists to escalate, not to double-charge a retry.
  const reportedTwice = failure("stream_lost", failure("stream_lost"));
  assert.equal(reportedTwice.attempt, 2);
  assert.equal(reportedTwice.technical, "t");
  assert.equal(
    xmtpAutoRetryDelayMs(reportedTwice),
    XMTP_RETRY_DELAYS_MS[1],
    "escalation is bounded even when a stream flaps"
  );
});

test("the installations cap is a user-retryable but externally-fixable failure", () => {
  const capped = failure("installations_limit", null, INSTALL_LIMIT);
  assert.equal(capped.kind, "installations_limit");
  assert.equal(capped.retryable, true);
  assert.equal(capped.needsExternalFix, true);
  assert.equal(capped.autoRetryable, false, "retrying cannot free an install slot");
  assert.match(capped.technical, /InboxID/, "the InboxID stays in the support detail");
});

test("every kind maps to a distinct, existing xmtpVs message key", () => {
  const kinds: XmtpFailureKind[] = [
    "signature_declined",
    "unsupported_wallet",
    "invalid_identity",
    "installations_limit",
    "blocked_by_tab",
    "peer_unreachable",
    "rate_limit",
    "network",
    "timeout",
    "stream_lost",
    "send_failed",
    "unknown",
  ];
  const keys = kinds.map(xmtpFailureMessageKey);
  assert.equal(new Set(keys).size, kinds.length, "no two failures share copy");

  const messages = JSON.parse(
    readFileSync(path.join(process.cwd(), "messages", "en.json"), "utf8")
  ) as { xmtpVs: Record<string, string> };
  for (const key of keys) {
    assert.ok(
      messages.xmtpVs[key],
      `messages/en.json xmtpVs.${key} must exist: the notice renders it directly`
    );
  }
});
