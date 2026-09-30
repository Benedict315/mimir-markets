/**
 * Tests for lib/paid-pass.ts — HMAC-signed subscription passes.
 *
 * PASS_SECRET is injected here as a non-empty test value. Any string works;
 * no production credential is required. The module reads the env per call, not
 * at import time, so `process.env.PASS_SECRET = ...` before the first call is
 * sufficient.
 */
import assert from "node:assert/strict";
import test from "node:test";

// Inject a test secret BEFORE importing the module. issuePass reads it on each
// call so the value set here is what every test below will use.
process.env.PASS_SECRET = "mimir-test-secret-do-not-use-in-production";

import { issuePass, verifyPass } from "../../lib/paid-pass";

const PAYER = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";
const PLAN = "premium";
const TTL = 60_000; // 1 minute

// ── Issuance ─────────────────────────────────────────────────────────────────

test("issuePass returns a pass string and a future expiresAt", () => {
  const before = Date.now();
  const { pass, expiresAt } = issuePass(PAYER, PLAN, TTL);
  assert.ok(typeof pass === "string" && pass.length > 0, "pass must be a non-empty string");
  assert.ok(expiresAt >= before + TTL, "expiresAt must be at least ttlMs ahead");
});

// ── Round-trip ────────────────────────────────────────────────────────────────

test("a freshly issued pass verifies against the same plan", () => {
  const { pass, expiresAt } = issuePass(PAYER, PLAN, TTL);
  const claims = verifyPass(pass, PLAN);
  assert.ok(claims !== null, "verifyPass must return claims for a valid pass");
  assert.equal(claims!.payer, PAYER.toLowerCase(), "payer is stored lowercased");
  assert.equal(claims!.plan, PLAN);
  assert.equal(claims!.exp, expiresAt);
});

test("round-trip works for multiple payer / plan combinations", () => {
  // Payers must not contain dots — the body format is `payer.exp.plan` and the
  // parser splits on the first and last dot. Email-style payers with dots are
  // not a supported input shape for this module.
  const cases: Array<[string, string]> = [
    ["alice", "council"],
    [PAYER, "council-pass"],
    ["agent-42", "premium"],
  ];
  for (const [payer, plan] of cases) {
    const { pass } = issuePass(payer, plan, TTL);
    const claims = verifyPass(pass, plan);
    assert.ok(claims !== null, `round-trip must succeed for ${payer}/${plan}`);
    assert.equal(claims!.payer, payer.toLowerCase());
    assert.equal(claims!.plan, plan);
  }
});

// ── Expiry ────────────────────────────────────────────────────────────────────

test("an expired pass returns null", () => {
  // Issue with ttlMs = 1, then check after expiry. We fabricate an expired pass
  // by issuing one and back-dating the exp in the body rather than waiting.
  // The issuePass signature: `${body_b64url}.${mac}`.
  // We reuse the raw structure to construct a token with elapsed exp.
  const payer = "user@test";
  const plan = "premium";
  const pastExp = Date.now() - 1; // 1 ms ago
  // Build the body the same way the module does: `${payer.toLowerCase()}.${exp}.${plan}`
  const body = `${payer.toLowerCase()}.${pastExp}.${plan}`;
  const bodyB64 = Buffer.from(body).toString("base64url");
  // We cannot produce a valid MAC for this body without the secret, but we CAN
  // issue a legitimate pass and swap out only the body to trigger the expiry path.
  // Instead, test the clock by issuing with a very short TTL and using a frozen time.
  // The simplest deterministic approach: monkey-patch Date.now for a moment.
  const realNow = Date.now;
  try {
    // Issue at "now", then advance the clock past expiry.
    const { pass } = issuePass(payer, plan, 100);
    Date.now = () => realNow() + 200; // 200ms later, past the 100ms TTL
    assert.equal(verifyPass(pass, plan), null, "expired pass must return null");
  } finally {
    Date.now = realNow;
  }
});

// ── Plan mismatch ─────────────────────────────────────────────────────────────

test("a pass issued for 'premium' does not verify for 'council'", () => {
  const { pass } = issuePass(PAYER, "premium", TTL);
  assert.equal(verifyPass(pass, "council"), null);
});

// ── Tamper detection ──────────────────────────────────────────────────────────

test("altering a single character in the MAC portion returns null", () => {
  const { pass } = issuePass(PAYER, PLAN, TTL);
  const dot = pass.lastIndexOf(".");
  const mac = pass.slice(dot + 1);
  // Flip the first character of the MAC.
  const flippedChar = mac[0] === "A" ? "B" : "A";
  const tampered = pass.slice(0, dot + 1) + flippedChar + mac.slice(1);
  assert.equal(verifyPass(tampered, PLAN), null);
});

test("modifying the body after signing returns null", () => {
  const { pass } = issuePass(PAYER, PLAN, TTL);
  const dot = pass.lastIndexOf(".");
  const mac = pass.slice(dot + 1);
  // Decode and alter the body.
  const body = Buffer.from(pass.slice(0, dot), "base64url").toString("utf8");
  const alteredBody = body + "x"; // append a character → different content
  const alteredB64 = Buffer.from(alteredBody).toString("base64url");
  const tampered = `${alteredB64}.${mac}`;
  assert.equal(verifyPass(tampered, PLAN), null);
});

// ── Null / undefined inputs ────────────────────────────────────────────────────

test("verifyPass returns null for null input", () => {
  assert.equal(verifyPass(null, PLAN), null);
});

test("verifyPass returns null for undefined input", () => {
  assert.equal(verifyPass(undefined, PLAN), null);
});

test("verifyPass returns null for an empty string", () => {
  assert.equal(verifyPass("", PLAN), null);
});

// ── Missing secret ────────────────────────────────────────────────────────────

test("issuePass throws when PASS_SECRET is unset", () => {
  const saved = process.env.PASS_SECRET;
  try {
    delete process.env.PASS_SECRET;
    assert.throws(() => issuePass(PAYER, PLAN, TTL), /PASS_SECRET/);
  } finally {
    process.env.PASS_SECRET = saved;
  }
});

// ── Secret isolation ──────────────────────────────────────────────────────────

test("a pass signed with one secret does not verify with a different secret", () => {
  // Issue with the current test secret.
  const { pass } = issuePass(PAYER, PLAN, TTL);
  // Swap to a different secret.
  const saved = process.env.PASS_SECRET;
  try {
    process.env.PASS_SECRET = "a-completely-different-secret";
    assert.equal(verifyPass(pass, PLAN), null, "wrong secret must reject the pass");
  } finally {
    process.env.PASS_SECRET = saved;
  }
});
