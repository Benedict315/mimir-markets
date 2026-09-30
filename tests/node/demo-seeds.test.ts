import assert from "node:assert/strict";
import test from "node:test";

import { getDemoSecret } from "../../lib/demo-signers";
import { parseSeedAnchor, seedDeadline } from "../../scripts/lib/seed-claims";

test("demo actions prefer dedicated documented signer secrets", () => {
  const env = {
    DEMO_CREATOR_SECRET: "creator",
    DEMO_CHALLENGER_SECRET: "challenger",
    DEMO_SIGNER_SECRET: "shared",
  };
  assert.equal(getDemoSecret("create_claim", env), "creator");
  assert.equal(getDemoSecret("challenge_claim", env), "challenger");
  assert.equal(getDemoSecret("create_rematch", env), "creator");
});

test("demo signer legacy aliases remain supported without crossing roles", () => {
  assert.equal(getDemoSecret("create_claim", { DEMO_CREATOR_PRIVATE_KEY: "creator-old" }), "creator-old");
  assert.equal(
    getDemoSecret("challenge_claim", { DEMO_CHALLENGER_STELLAR_SECRET: "challenger-new" }),
    "challenger-new",
  );
  assert.equal(getDemoSecret("create_claim", { DEMO_CHALLENGER_SECRET: "wrong-role" }), undefined);
});

test("unknown demo actions never receive a signer", () => {
  assert.equal(getDemoSecret("resolve_claim", { DEMO_SIGNER_SECRET: "shared" }), undefined);
});

test("fixed seed anchors and deadlines reproduce exact seconds", () => {
  const anchor = parseSeedAnchor("2030-01-01T00:00:00Z");
  assert.equal(anchor, 1_893_456_000);
  assert.equal(seedDeadline(anchor, 3_600), 1_893_459_600);
  assert.equal(parseSeedAnchor(undefined, 1_893_456_000_999), anchor);
});

test("seed anchor rejects ambiguous or invalid timestamps", () => {
  assert.throws(() => parseSeedAnchor("2030-01-01T00:00:00"), /explicit timezone/);
  assert.throws(() => parseSeedAnchor("not-a-time"), /explicit timezone|valid ISO-8601/);
});