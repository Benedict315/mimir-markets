import assert from "node:assert/strict";
import test from "node:test";

import { handleClaimModerationPost } from "../../lib/server/claim-moderation-route-handler";
import {
  getGlobalCooldownMs,
  hashModerationInput,
  moderationInFlight,
  moderationResultCache,
  setGlobalCooldownMs,
} from "../../lib/server/moderation-cache";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/claim-moderation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function run(body: unknown) {
  return handleClaimModerationPost({
    request: makeRequest(body),
    moderateClaim: async ({ input }) => {
      const combined = [
        input.question,
        input.creator_position,
        input.opponent_position,
        input.settlement_rule,
      ]
        .join(" ")
        .toLowerCase();
      if (combined.includes("kill myself") || combined.includes("suicid")) {
        return {
          decision: "block",
          violationCodes: ["death_self_harm"],
          confidence: 100,
          policyVersion: "local-rules:v1",
        };
      }
      return {
        decision: "allow",
        violationCodes: [],
        confidence: 90,
        policyVersion: "stub:v1",
      };
    },
  });
}

async function runWith(
  body: unknown,
  moderateClaim: Parameters<typeof handleClaimModerationPost>[0]["moderateClaim"]
) {
  return handleClaimModerationPost({
    request: makeRequest(body),
    moderateClaim,
  });
}

test("POST /api/claim-moderation: feature disabled returns 404", async () => {
  process.env.NEXT_PUBLIC_FEATURE_CLAIM_MODERATION = "0";
  const response = await run({
    locale: "en",
    input: {
      question: "Will it rain?",
      creator_position: "Yes",
      opponent_position: "No",
      category: "custom",
      settlement_rule: "Resolve using the linked source at the deadline.",
      resolution_url: "https://example.com",
    },
  });

  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload?.error?.code, "not_found");
});

test("POST /api/claim-moderation: invalid request returns 400", async () => {
  process.env.NEXT_PUBLIC_FEATURE_CLAIM_MODERATION = "1";
  const response = await run({ locale: "en", input: {} });

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload?.error?.code, "invalid_request");
});

test("POST /api/claim-moderation: cache MISS then HIT for identical input", async () => {
  process.env.NEXT_PUBLIC_FEATURE_CLAIM_MODERATION = "1";
  setGlobalCooldownMs(0);

  const locale = "en";
  const input = {
    question: "Will I kill myself tomorrow?", // triggers local rules (no Gemini call)
    creator_position: "Yes",
    opponent_position: "No",
    category: "custom",
    settlement_rule: "Resolve using the linked source at the deadline.",
    resolution_url: "https://example.com",
  };

  const cacheKey = hashModerationInput({ locale, input });
  moderationResultCache.delete(cacheKey);

  const body = { locale, input };

  const first = await run(body);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("X-Moderation-Cache"), "MISS");
  const firstPayload = await first.json();
  assert.equal(firstPayload?.decision, "block");
  assert.equal(firstPayload?.policyVersion, "local-rules:v1");

  const second = await run(body);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("X-Moderation-Cache"), "HIT");
  const secondPayload = await second.json();
  assert.equal(secondPayload?.decision, "block");
});

test("POST /api/claim-moderation: inflight dedupe sets X-Moderation-Dedupe", async () => {
  process.env.NEXT_PUBLIC_FEATURE_CLAIM_MODERATION = "1";
  setGlobalCooldownMs(0);

  const body = {
    locale: "en",
    input: {
      question: "Will it rain?",
      creator_position: "Yes",
      opponent_position: "No",
      category: "custom",
      settlement_rule: "Resolve using the linked source at the deadline.",
      resolution_url: "https://example.com",
    },
  };

  moderationInFlight.clear();

  const slowModerate: Parameters<typeof runWith>[1] = async () => {
    await new Promise((r) => setTimeout(r, 50));
    return {
      decision: "allow",
      violationCodes: [],
      confidence: 90,
      policyVersion: "stub:v1",
    };
  };

  const p1 = runWith(body, slowModerate);
  await new Promise((r) => setTimeout(r, 5));
  const p2 = runWith(body, slowModerate);

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get("X-Moderation-Dedupe"), "INFLIGHT");
});

test("POST /api/claim-moderation: rate-limited upstream triggers 429 and cooldown", async () => {
  process.env.NEXT_PUBLIC_FEATURE_CLAIM_MODERATION = "1";
  setGlobalCooldownMs(0);

  const body = {
    locale: "en",
    input: {
      question: `Will it rain? (rate-limit-test ${Date.now()})`,
      creator_position: "Yes",
      opponent_position: "No",
      category: "custom",
      settlement_rule: "Resolve using the linked source at the deadline.",
      resolution_url: "https://example.com",
    },
  };
  moderationResultCache.delete(hashModerationInput(body));

  const response = await runWith(
    body,
    async () => {
      throw new Error("Moderation request failed (429): RESOURCE_EXHAUSTED");
    }
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "35");
  assert.ok(getGlobalCooldownMs() > 0);

  setGlobalCooldownMs(0);
});

test("POST /api/claim-moderation: global cooldown returns 429 + Retry-After", async () => {
  process.env.NEXT_PUBLIC_FEATURE_CLAIM_MODERATION = "1";
  setGlobalCooldownMs(4000);

  assert.ok(getGlobalCooldownMs() > 0);

  const response = await run({
    locale: "en",
    input: {
      question: "Will it rain?",
      creator_position: "Yes",
      opponent_position: "No",
      category: "custom",
      settlement_rule: "Resolve using the linked source at the deadline.",
      resolution_url: "https://example.com",
    },
  });

  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("Retry-After")) >= 1);
  const payload = await response.json();
  assert.equal(payload?.error?.code, "rate_limited");

  setGlobalCooldownMs(0);
});

