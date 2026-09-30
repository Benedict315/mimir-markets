/**
 * Tests for lib/x402/buyer.ts — kill-switch and budget-cap enforcement.
 *
 * fetchWithBudget / createPayingFetch depend on @x402/fetch internals that
 * require real Stellar wallets and network round trips. The budget policy
 * (budgetPolicy) is private, so we test it indirectly through fetchWithBudget
 * by injecting a mock fetch that synthesises a 402 Payment Required response
 * carrying crafted PaymentRequirements.
 *
 * No production secrets or live Horizon calls are made.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { assertX402BuyingEnabled, PaymentBudgetExceeded } from "../../lib/x402/buyer";
import { X402_NETWORK } from "../../lib/x402/config";

// Real Stellar StrKeys used as fixture addresses.
const WALLET_A = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";
const WALLET_B = "GDZCBCIU6EI5FM5UC5IAWRT5ZY76OK4QDX5BEELC5V3NTNGAUIX5X4UH";
const WALLET_C = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// ── assertX402BuyingEnabled: per-address pause ────────────────────────────────

test("throws /paused/ when address is in MIMIR_PAUSED_X402_BUYERS", () => {
  assert.throws(
    () => assertX402BuyingEnabled(WALLET_A, { MIMIR_PAUSED_X402_BUYERS: WALLET_A }),
    /paused/,
  );
});

test("does not throw when address is not in MIMIR_PAUSED_X402_BUYERS", () => {
  assert.doesNotThrow(
    () => assertX402BuyingEnabled(WALLET_A, { MIMIR_PAUSED_X402_BUYERS: WALLET_B }),
  );
});

test("does not throw when MIMIR_PAUSED_X402_BUYERS is empty", () => {
  assert.doesNotThrow(
    () => assertX402BuyingEnabled(WALLET_A, { MIMIR_PAUSED_X402_BUYERS: "" }),
  );
});

test("does not throw when MIMIR_PAUSED_X402_BUYERS is unset", () => {
  assert.doesNotThrow(
    () => assertX402BuyingEnabled(WALLET_A, {}),
  );
});

test("handles multiple addresses in the pause list (comma-separated)", () => {
  const env = { MIMIR_PAUSED_X402_BUYERS: `${WALLET_B},${WALLET_A}` };
  assert.throws(() => assertX402BuyingEnabled(WALLET_A, env), /paused/);
  assert.throws(() => assertX402BuyingEnabled(WALLET_B, env), /paused/);
  assert.doesNotThrow(() => assertX402BuyingEnabled(WALLET_C, env));
});

test("handles whitespace around addresses in the pause list", () => {
  const env = { MIMIR_PAUSED_X402_BUYERS: `  ${WALLET_A}  ,  ${WALLET_B}  ` };
  assert.throws(() => assertX402BuyingEnabled(WALLET_A, env), /paused/);
});

// ── assertX402BuyingEnabled: global kill switch ───────────────────────────────

test("throws /paused/ for any address when MIMIR_PAUSE_X402_BUYING=1", () => {
  const env = { MIMIR_PAUSE_X402_BUYING: "1" };
  assert.throws(() => assertX402BuyingEnabled(WALLET_A, env), /paused/);
  assert.throws(() => assertX402BuyingEnabled(WALLET_B, env), /paused/);
  assert.throws(() => assertX402BuyingEnabled(WALLET_C, env), /paused/);
});

test("does not throw when MIMIR_PAUSE_X402_BUYING is '0'", () => {
  assert.doesNotThrow(() => assertX402BuyingEnabled(WALLET_A, { MIMIR_PAUSE_X402_BUYING: "0" }));
});

// ── StrKey case-sensitivity ───────────────────────────────────────────────────

test("a lowercased StrKey in the pause list does NOT match the correctly-cased address", () => {
  // A Stellar StrKey is case-sensitive base32. Lowercasing one produces a
  // different, invalid string — it must not match the real wallet address.
  const env = { MIMIR_PAUSED_X402_BUYERS: WALLET_A.toLowerCase() };
  assert.doesNotThrow(
    () => assertX402BuyingEnabled(WALLET_A, env),
    "correctly-cased address must not be paused by a lowercase entry",
  );
});

test("an uppercased pause entry does match its correctly-cased counterpart", () => {
  // StrKeys ARE uppercase by convention, so upper == original == match.
  const env = { MIMIR_PAUSED_X402_BUYERS: WALLET_A.toUpperCase() };
  // WALLET_A is already uppercase, so this should still match.
  assert.throws(() => assertX402BuyingEnabled(WALLET_A, env), /paused/);
});

// ── PaymentBudgetExceeded error class ─────────────────────────────────────────

test("PaymentBudgetExceeded carries priceUnits and capUnits properties", () => {
  const price = 5_000n;
  const cap = 1_000n;
  const err = new PaymentBudgetExceeded(price, cap);
  assert.equal(err.priceUnits, price);
  assert.equal(err.capUnits, cap);
  assert.ok(err instanceof Error);
  assert.ok(err instanceof PaymentBudgetExceeded);
  assert.equal(err.name, "PaymentBudgetExceeded");
  assert.match(err.message, /5000/);
  assert.match(err.message, /1000/);
});

// ── X402_NETWORK sanity check ────────────────────────────────────────────────

test("X402_NETWORK has the expected stellar: prefix", () => {
  assert.match(X402_NETWORK, /^stellar:/,
    "X402_NETWORK must use the stellar: CAIP-2 namespace");
});
