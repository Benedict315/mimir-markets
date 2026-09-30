import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySourceType,
  isBlockedSourceHost,
  sanitizeGeneratedDrafts,
} from "../../lib/server/source-claim-generator";

const TEST_NOW = Date.parse("2040-01-01T00:00:00.000Z");

function futureDeadlineIso(daysFromNow = 30): string {
  return new Date(TEST_NOW + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

test("blocks unsupported social source hosts", () => {
  assert.equal(isBlockedSourceHost("https://x.com/some/status/1"), true);
  assert.equal(isBlockedSourceHost("https://twitter.com/test"), true);
  assert.equal(isBlockedSourceHost("https://openai.com/index/hello"), false);
});

test("classifies trusted media sources distinctly", () => {
  assert.equal(classifySourceType("https://www.bbc.com/sport"), "media");
  assert.equal(classifySourceType("https://apple.com/newsroom"), "official");
});

test("sanitizeGeneratedDrafts keeps valid unique candidates only", () => {
  const deadlineAt = futureDeadlineIso(60);
  const result = sanitizeGeneratedDrafts({
    sourceUrl: "https://openai.com/index/update",
    sourceType: "official",
    now: TEST_NOW,
    payload: {
      sourceSummary: "OpenAI published a future launch update.",
      candidates: [
        {
          category: "culture",
          claimText: "Will OpenAI publish the announced update before the deadline?",
          sideA: "OpenAI publishes it before the deadline",
          sideB: "OpenAI does not publish it before the deadline",
          deadlineAt,
          timezone: "UTC",
          primaryResolutionSource: "https://openai.com/index/update",
          settlementRule:
            "Resolve this only from the linked official source at the deadline. If the update is publicly published there before the deadline, Side A wins.",
          ambiguityFlags: ["Deadline based on the announced publication window."],
          confidenceScore: 91,
        },
        {
          category: "culture",
          claimText: "Will OpenAI publish the announced update before the deadline?",
          sideA: "Duplicate",
          sideB: "Duplicate",
          deadlineAt,
          timezone: "UTC",
          primaryResolutionSource: "https://openai.com/index/update",
          settlementRule: "This duplicate should be removed because the claim text repeats.",
          ambiguityFlags: [],
          confidenceScore: 40,
        },
      ],
    },
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.category, "culture");
  assert.equal(result.candidates[0]?.confidenceScore, 91);
});

test("sanitizeGeneratedDrafts rejects short-window relative change claims", () => {
  const result = sanitizeGeneratedDrafts({
    sourceUrl: "https://www.accuweather.com/es/ar/buenos-aires/7894/10-day-weather-forecast/7894",
    sourceType: "media",
    now: TEST_NOW,
    payload: {
      sourceSummary: "Forecast page for Buenos Aires.",
      candidates: [
        {
          category: "weather",
          claimText:
            "La temperatura aumenta 10° en Buenos Aires durante los siguientes 8 minutos?",
          sideA: "Sí, aumenta 10° en los siguientes 8 minutos",
          sideB: "No, no aumenta 10° en los siguientes 8 minutos",
          deadlineAt: futureDeadlineIso(14),
          timezone: "UTC",
          primaryResolutionSource:
            "https://www.accuweather.com/es/ar/buenos-aires/7894/10-day-weather-forecast/7894",
          settlementRule:
            "Resolve this by checking whether the listed temperature increases by 10°C from now during the next 8 minutes on the linked page.",
          ambiguityFlags: [],
          confidenceScore: 72,
        },
      ],
    },
  });

  assert.equal(result.candidates.length, 0);
  assert.match(
    result.rejectionReason ?? "",
    /deadline-based checks|short-window change tracking/i
  );
});

test("sanitizeGeneratedDrafts keeps deadline-based event claims even with time windows", () => {
  const result = sanitizeGeneratedDrafts({
    sourceUrl: "https://apple.com/newsroom",
    sourceType: "official",
    now: TEST_NOW,
    payload: {
      sourceSummary: "Apple newsroom updates.",
      candidates: [
        {
          category: "custom",
          claimText: "Will Apple announce a new iPad in the next 24 hours?",
          sideA: "Apple announces a new iPad before the deadline",
          sideB: "Apple does not announce a new iPad before the deadline",
          deadlineAt: futureDeadlineIso(2),
          timezone: "UTC",
          primaryResolutionSource: "https://apple.com/newsroom",
          settlementRule:
            "Resolve this only from the linked Apple Newsroom source at the deadline. If a new iPad announcement is published there before the deadline, Side A wins.",
          ambiguityFlags: [],
          confidenceScore: 88,
        },
      ],
    },
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(
    result.candidates[0]?.claimText,
    "Will Apple announce a new iPad in the next 24 hours?"
  );
});

