/**
 * tests/node/xmtp-failure-ui.test.ts
 *
 * Regression coverage for the XMTP failure + retry UI (#90).
 *
 * The behaviour itself lives in `lib/xmtp/failure-state.ts` (unit-tested in
 * `xmtp-failure-state.test.ts`). This file guards the wiring that is easy to
 * regress silently, because there is no DOM in the node suite:
 *
 *   A. The old leaks stay closed — no raw SDK error as the headline, no
 *      `console.warn`-only stream error, no send that eats the user's text.
 *   B. Every failure surface has a retry affordance.
 *   C. Accessibility: assertive vs polite live region, `aria-busy`, and the
 *      technical detail stays behind a disclosure.
 *   D. i18n: every `t("…")` literal in the XMTP components resolves in
 *      `messages/en.json`. `i18n/request.ts` falls back to printing the raw key
 *      path, so a missing key ships as visible "xmtpVs.whatever" instead of copy.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const panel = read("components/xmtp/VsXmtpPanel.tsx");
const notice = read("components/xmtp/XmtpFailureNotice.tsx");
const threadHook = read("hooks/useVsXmtpThread.ts");
const provider = read("lib/xmtp/XmtpProvider.tsx");
const messages = JSON.parse(read(join("messages", "en.json"))) as Record<
  string,
  Record<string, string>
>;

const countOf = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

/* ── A. Old leaks stay closed ──────────────────────────────────────────────── */

test("the panel never paints a raw SDK error string as the notice body", () => {
  // Before: `{xmtpProviderErrorMessage || t("errorGeneric")}` dumped the SDK's
  // English text (which can contain the InboxID) straight into the headline.
  assert.equal(panel.includes("xmtpProviderErrorMessage"), false);
});

test("the panel has no string-typed send-error channel anymore", () => {
  // Before: `sendError` was a raw `e.message` printed under the input with no
  // retry and no classification.
  assert.equal(panel.includes("setSendError"), false);
  assert.equal(panel.includes("sendError"), false);
});

test("a stream error is recorded as a failure, not only logged", () => {
  // Before: `onError` only did `console.warn(...)`, so a dead stream left a
  // frozen thread on screen with no indication anything was wrong.
  assert.equal(threadHook.includes("[useVsXmtpThread] stream"), false);
  assert.equal(threadHook.includes("setStreamFailure"), true);
  assert.equal(threadHook.includes('"stream_lost"'), true);
});

test("a failed send gives the text back to the draft instead of losing it", () => {
  // Before: `setDraft("")` happened before `sendText`, and the catch only removed
  // the optimistic bubble — a failed message was unrecoverable.
  assert.match(panel, /setDraft\(\(prev\) => \(prev\.trim\(\) \? prev : text\)\)/);
});

test("the provider classifies its init failure and exposes it", () => {
  assert.equal(provider.includes("classifyXmtpFailureKind"), true);
  assert.equal(provider.includes("nextXmtpFailure"), true);
  // Handle both LF and CRLF line endings
  assert.match(provider, /failure,\r?\n\s+activeAddress/, "exposed on the context value");
});

test("the provider clears the failure once the client is ready", () => {
  assert.equal(countOf(provider, "dropFailure()") >= 2, true);
});

test("a retry attempt keeps the failure on screen, so Retry can show as busy", () => {
  // Before: the panel had no way to say "retrying" — the error block simply
  // vanished into the loading pulse the moment Retry was tapped.
  assert.equal(
    /setStatus\("initializing"\);[\s\S]{0,200}dropFailure\(\)/.test(provider),
    false,
    "entering `initializing` must not clear the failure"
  );
  assert.match(
    provider,
    /if \(status === "initializing"\) return;[\s\S]{0,120}xmtpAutoRetryDelayMs/,
    "an in-flight attempt must not also schedule an unattended retry"
  );
});

/* ── B. Retry affordances ──────────────────────────────────────────────────── */

test("every failure surface in the panel goes through the shared notice", () => {
  // provider init, thread open, demo preview, stream loss, send failure.
  assert.equal(countOf(panel, "<XmtpFailureNotice"), 5);
});

test("the blocked-by-tab state offers an explicit retry", () => {
  // Before it had no button at all and promised an automatic reconnect that only
  // fires if the other tab broadcasts its release.
  assert.equal(panel.includes('kind === "blocked_by_tab"'), true);
  assert.match(panel, /onRetry=\{\(\) => \{\s*\n\s*retry\(\);/);
});

test("the notice shows Retry for recoverable failures and not otherwise", () => {
  assert.match(notice, /const showRetry = Boolean\(onRetry\) && failure\.retryable;/);
  assert.match(notice, /isXmtpRetryDisabled\(failure, isRetrying\)/);
  assert.match(notice, /failureNotRetryable|!failure\.retryable/);
});

/* ── C. Accessibility ──────────────────────────────────────────────────────── */

test("danger and warning use different live-region politeness", () => {
  assert.match(
    notice,
    /role=\{tone === "warning" \? "status" : "alert"\}/
  );
  assert.match(
    notice,
    /aria-live=\{tone === "warning" \? "polite" : "assertive"\}/
  );
});

test("an in-flight retry is announced, not just disabled", () => {
  assert.match(notice, /aria-busy=\{isRetrying \|\| undefined\}/);
  assert.match(notice, /isRetrying \? t\("retrying"\) : t\("retry"\)/);
});

test("the technical detail is behind a disclosure, never the headline", () => {
  assert.match(notice, /<details/);
  assert.match(notice, /<summary/);
  const headline = notice.slice(
    notice.indexOf("xmtpFailureMessageKey(failure.kind)"),
    notice.indexOf("xmtpFailureMessageKey(failure.kind)") + 80
  );
  assert.equal(headline.includes("failure.technical"), false);
});

test("decoration is hidden from assistive tech", () => {
  assert.equal(notice.includes('aria-hidden />') || notice.includes("aria-hidden"), true);
});

/* ── D. i18n ───────────────────────────────────────────────────────────────── */

const XMTP_UI_FILES = [
  "components/xmtp/VsXmtpPanel.tsx",
  "components/xmtp/XmtpFailureNotice.tsx",
  "components/xmtp/VsXmtpChatPreviewShell.tsx",
  "components/xmtp/MessagesHub.tsx",
  "components/xmtp/MessagesPageHero.tsx",
  "components/xmtp/MessagesWalletGate.tsx",
];

test("every message key used by the XMTP components exists in en.json", () => {
  const missing: string[] = [];
  for (const file of XMTP_UI_FILES) {
    const src = read(file);
    const namespaces = [...src.matchAll(/useTranslations\("([A-Za-z0-9_]+)"\)/g)].map(
      (m) => m[1]
    );
    assert.ok(namespaces.length > 0, `${file} should declare useTranslations(...)`);
    for (const match of src.matchAll(/\bt\("([A-Za-z0-9_]+)"(?:,|\))/g)) {
      const key = match[1];
      if (!namespaces.some((ns) => messages[ns]?.[key])) {
        missing.push(`${file}: ${key} (ns: ${namespaces.join(", ")})`);
      }
    }
  }
  assert.deepEqual(missing, [], "missing i18n keys render as a raw key path");
});

test("the retired tab-lock copy is gone instead of lingering unused", () => {
  // The shared notice now owns these states via `failureBlockedByTab` and the
  // notice's own headline copy, which the previous ad-hoc blocks duplicated.
  for (const key of ["blockedByTabTitle", "blockedByTabDesc", "chatPreviewBanner"]) {
    assert.equal(key in messages.xmtpVs, false);
  }
});
