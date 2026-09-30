import assert from "node:assert/strict";
import test from "node:test";

import {
  apiKeyPrefix, checkApiKeyRecord, generateApiKey, hashApiKey, hashesMatch,
  isApiKeyFormat, parseApiKeyHeader, type AgentApiKeyRecord,
} from "../../lib/agents/api-keys";

function record(overrides: Partial<AgentApiKeyRecord> = {}): AgentApiKeyRecord {
  const key = generateApiKey();
  return {
    keyId: "k1", agentId: "forecaster", keyHash: hashApiKey(key),
    keyPrefix: apiKeyPrefix(key), label: "", createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

test("issued keys are unique and environment-tagged", () => {
  const live = generateApiKey("live");
  const test1 = generateApiKey("test");
  assert.match(live, /^mk_live_/);
  assert.match(test1, /^mk_test_/);
  assert.notEqual(generateApiKey(), generateApiKey());
  assert.ok(isApiKeyFormat(live) && isApiKeyFormat(test1));
});

test("the stored hash does not reveal the key", () => {
  const key = generateApiKey();
  const hash = hashApiKey(key);
  assert.equal(hash.length, 64);
  assert.ok(!hash.includes(key.slice(8)), "hash must not contain the secret");
  // Same key hashes stably, a different key does not collide.
  assert.equal(hashApiKey(key), hash);
  assert.notEqual(hashApiKey(generateApiKey()), hash);
});

test("hash comparison rejects a near miss and a length mismatch", () => {
  const hash = hashApiKey(generateApiKey());
  assert.equal(hashesMatch(hash, hash), true);
  const diffChar = hash.endsWith("0") ? "1" : "0";
  assert.equal(hashesMatch(hash, hash.slice(0, -1) + diffChar), false);
  assert.equal(hashesMatch(hash, hash.slice(0, -1)), false, "must not throw on length mismatch");
});

test("the header parser accepts what agents actually send", () => {
  const key = generateApiKey();
  assert.equal(parseApiKeyHeader(`Bearer ${key}`), key);
  assert.equal(parseApiKeyHeader(`bearer ${key}`), key);
  // Third parties copy keys straight into the header without the scheme.
  assert.equal(parseApiKeyHeader(key), key);
  assert.equal(parseApiKeyHeader(`Bearer   ${key}  `), key);
});

test("anything that is not a key parses to null rather than to a lookup", () => {
  assert.equal(parseApiKeyHeader(null), null);
  assert.equal(parseApiKeyHeader(""), null);
  assert.equal(parseApiKeyHeader("Bearer "), null);
  // A worker secret or JWT must not be mistaken for a key and looked up.
  assert.equal(parseApiKeyHeader("Bearer 7f68cbd51a37aff4"), null);
  assert.equal(parseApiKeyHeader("Bearer mk_live_short"), null);
});

test("a revoked key is refused, and a missing one is not confused with it", () => {
  const missing = checkApiKeyRecord(null);
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.reason, "not_found");
  const revoked = checkApiKeyRecord(record({ revokedAt: 1_700_000_100_000 }));
  assert.equal(revoked.ok, false);
  assert.equal(revoked.ok === false && revoked.reason, "revoked");
  assert.equal(checkApiKeyRecord(record()).ok, true);
});
