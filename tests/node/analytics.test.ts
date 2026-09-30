import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYTICS_EVENTS,
  EVENT_VERSION,
  buildEnvelope,
  conformEventProperties,
  hasRequiredEnvelope,
  isAnalyticsEvent,
} from "../../lib/analytics/events";
import { containsRawAddress, redactProperties, redactWalletAddresses } from "../../lib/analytics/redact";
import {
  ANON_ACTOR_ID,
  actorIdForAddress,
  opaqueAnalyticsId,
  resolveActor,
} from "../../lib/analytics/actor";
import { idempotencyKey } from "../../lib/analytics/events";
import {
  PRODUCT_DASHBOARDS,
  PRODUCT_FUNNELS,
  SUCCESS_METRICS,
  analyticsDefinitionErrors,
} from "../../lib/analytics/insights";

const SALT = "test-salt-not-the-real-one";
// Real Stellar strkeys. The EVM addresses these used to be made the whole actor
// suite green against an `actorIdForAddress` that rejected every address a real
// user has — and let the "case must not change identity" assertion below stand,
// which is true of hex and false of case-sensitive base32.
const ADDRESS = "GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE";
const OTHER = "GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D";

// ── Envelope ──────────────────────────────────────────────────────────────────

test("the envelope is stamped with version and network on every event", () => {
  const envelope = buildEnvelope({ actor_type: "human", source_surface: "explorer" });
  assert.equal(envelope.event_version, EVENT_VERSION);
  // A STRING network name, replacing the EVM numeric `chain_id`. Stellar has no
  // chain id, and the short name is what a dashboard breakdown wants — see the
  // note on `EventEnvelope.network`.
  assert.equal(envelope.network, "testnet");
  assert.equal(hasRequiredEnvelope(envelope as unknown as Record<string, unknown>), true);
});

test("an envelope missing the network is incomplete", () => {
  // The completeness gate must fail closed on a v1-shaped row — one that still
  // carries the old numeric chain field instead of `network` — rather than
  // counting it as measurable.
  assert.equal(
    hasRequiredEnvelope({ event_version: 1, chain_id: 1, actor_type: "human", source_surface: "home" }),
    false,
  );
});

test("absent envelope fields are omitted, not sent as null", () => {
  // Null-valued properties make PostHog filters noisy and imply "measured as
  // nothing" rather than "not applicable".
  const envelope = buildEnvelope({ actor_type: "anonymous", source_surface: "home" });
  assert.equal("claim_id" in envelope, false);
  assert.equal("settlement_mode" in envelope, false);
  assert.equal("modifiers" in envelope, false);
  assert.equal("agent_id" in envelope, false);
});

test("an empty modifier list is omitted rather than sent as []", () => {
  const envelope = buildEnvelope({
    actor_type: "human",
    source_surface: "vs_detail",
    modifiers: [],
  });
  assert.equal("modifiers" in envelope, false);
});

test("the envelope carries mode and claim context when supplied", () => {
  const envelope = buildEnvelope({
    actor_type: "human",
    source_surface: "vs_detail",
    claim_id: 12,
    subject_type: "binary",
    settlement_mode: "duel",
    modifiers: ["rematch_ladder"],
    tx_status: "confirmed",
    locale: "en",
  });
  assert.equal(envelope.claim_id, 12);
  assert.equal(envelope.settlement_mode, "duel");
  assert.deepEqual(envelope.modifiers, ["rematch_ladder"]);
  assert.equal(envelope.tx_status, "confirmed");
});

test("an incomplete envelope is detectable rather than shipped", () => {
  assert.equal(hasRequiredEnvelope({ network: "testnet", actor_type: "human" }), false);
  assert.equal(hasRequiredEnvelope({ event_version: 1, actor_type: "human" }), false);
  assert.equal(
    hasRequiredEnvelope({
      event_version: EVENT_VERSION,
      network: "testnet",
      actor_type: "human",
      source_surface: "attacker-controlled",
    }),
    false,
  );
});

test("only declared event names are accepted", () => {
  assert.equal(isAnalyticsEvent("stake_confirmed"), true);
  assert.equal(isAnalyticsEvent("stake_confirmed_v2"), false);
  assert.equal(isAnalyticsEvent("arbitrary_thing"), false);
});

test("the roadmap's funnel events all exist", () => {
  for (const required of [
    "market_viewed",
    "create_started",
    "create_mode_selected",
    "create_submitted",
    "create_confirmed",
    "stake_previewed",
    "stake_started",
    "stake_confirmed",
    "stake_failed",
    "settlement_return_viewed",
    "payout_preview_seen",
    "low_upside_warning_seen",
    "agent_viewed",
    "agent_followed",
    "agent_unfollowed",
    "reasoning_opened",
    "reasoning_x402_purchased",
    "share_card_generated",
    "share_card_clicked",
    "rematch_started",
    "rematch_confirmed",
    "copy_permission_created",
    "copy_executed",
    "copy_skipped",
    "copy_revoked",
  ]) {
    assert.ok(
      (ANALYTICS_EVENTS as readonly string[]).includes(required),
      `missing funnel event '${required}'`,
    );
  }
});

test("all roadmap funnels and dashboards are reproducible from code", () => {
  assert.deepEqual(analyticsDefinitionErrors(), []);
  assert.deepEqual(
    PRODUCT_FUNNELS.map((funnel) => funnel.id),
    ["create", "stake", "settlement-return", "follow-to-copy", "share-to-market"],
  );
  assert.deepEqual(
    PRODUCT_DASHBOARDS.flatMap((dashboard) => dashboard.breakdowns).filter(
      (value, index, all) => all.indexOf(value) === index,
    ),
    ["settlement_mode", "category", "actor_type"],
  );
  assert.ok(PRODUCT_FUNNELS.every((funnel) => funnel.excludeInternal));
});

// ── Leak guard: the reason this module exists ─────────────────────────────────

test("secret-looking KEYS are dropped whatever the value", () => {
  const { properties, dropped } = redactProperties({
    private_key: "anything",
    privateKey: "anything",
    signature: "0xdead",
    invite_key: "hunter2",
    prompt: "You are Mimir…",
    evidence_text: "short",
    reasoning_text: "short",
    api_key: "k",
    password: "p",
    payment_signature: "s",
    claim_id: 12,
  });
  assert.deepEqual(properties, { claim_id: 12 });
  assert.ok(dropped.length >= 10);
});

test("a 32-byte hex value is dropped even under an innocent key", () => {
  const { properties } = redactProperties({
    note: "0x" + "ab".repeat(32),
    claim_id: 3,
  });
  assert.equal("note" in properties, false);
  assert.equal(properties.claim_id, 3);
});

test("a 65-byte signature is dropped even under an innocent key", () => {
  const { properties } = redactProperties({ blob: "0x" + "cd".repeat(65) });
  assert.equal("blob" in properties, false);
});

test("a JWT-shaped token is dropped", () => {
  const { properties } = redactProperties({
    council_pass: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  });
  assert.deepEqual(properties, {});
});

test("long free text is dropped, never truncated", () => {
  // A truncated prompt or evidence excerpt is still a leak.
  const { properties } = redactProperties({ blurb: "e".repeat(500) });
  assert.equal("blurb" in properties, false);
});

test("redaction walks nested objects", () => {
  const { properties, dropped } = redactProperties({
    context: { invite_key: "secret", claim_id: 5 },
  });
  assert.deepEqual(properties, { context: { claim_id: 5 } });
  assert.deepEqual(dropped, ["context.invite_key"]);
});

test("secret array members are removed and the array is flagged", () => {
  const { properties, dropped } = redactProperties({
    hashes: ["ok", "0x" + "11".repeat(32)],
  });
  assert.deepEqual(properties.hashes, ["ok"]);
  assert.deepEqual(dropped, ["hashes"]);
});

test("ordinary categorical properties survive untouched", () => {
  const input = {
    settlement_mode: "pool",
    stake_bucket: "2-10",
    upside_bps: 1_000,
    is_low_upside: true,
    modifiers: ["underdog_boost"],
  };
  assert.deepEqual(redactProperties(input).properties, input);
});

test("a raw wallet address in the payload is detectable", () => {
  assert.equal(containsRawAddress({ payer: ADDRESS }), true);
  assert.equal(containsRawAddress({ nested: { seller: ADDRESS } }), true);
  assert.equal(containsRawAddress({ list: [ADDRESS] }), true);
  assert.equal(containsRawAddress({ claim_id: 1, settlement_mode: "pool" }), false);
});

test("the contract address is public context, not a user identity", () => {
  assert.equal(containsRawAddress({ contract: `C${"A".repeat(55)}` }), false);
  assert.equal(containsRawAddress({ contract: ADDRESS }), true);
});

test("raw Stellar identities are removed before capture", () => {
  const contract = `C${"A".repeat(55)}`;
  const { properties, dropped } = redactProperties({
    wallet: ADDRESS,
    nested: { owner: OTHER },
    list: ["pool", ADDRESS],
    contract,
  });
  assert.deepEqual(properties, { nested: {}, list: ["pool"], contract });
  assert.deepEqual(dropped, ["wallet", "nested.owner", "list"]);
});

test("Stellar secret seeds are removed even under an innocent key", () => {
  assert.deepEqual(redactProperties({ value: `S${"A".repeat(55)}` }).properties, {});
});

test("redaction bounds cyclic payloads without throwing", () => {
  const cyclic: Record<string, unknown> = { claim_id: 1 };
  cyclic.self = cyclic;
  const result = redactProperties(cyclic);
  assert.deepEqual(result.properties, { claim_id: 1, self: {} });
  assert.deepEqual(result.dropped, ["self"]);
});

test("event schemas drop unknown, mistyped, and non-finite values", () => {
  const result = conformEventProperties("stake_previewed", {
    stake_bucket: "2-5",
    upside_bps: 1200,
    is_low_upside: false,
    total_return_multiple: 2.2,
    wallet: ADDRESS,
    exact_stake: 2.3456789,
    unsupported_mode: "false",
  });
  assert.deepEqual(result.properties, {
    stake_bucket: "2-5",
    upside_bps: 1200,
    is_low_upside: false,
    total_return_multiple: 2.2,
  });
  assert.deepEqual(result.dropped, ["wallet", "exact_stake", "unsupported_mode"]);
  assert.deepEqual(
    conformEventProperties("stake_previewed", { upside_bps: Number.POSITIVE_INFINITY }),
    { properties: {}, dropped: ["upside_bps"] },
  );
  assert.deepEqual(
    conformEventProperties("market_viewed", null),
    { properties: {}, dropped: ["$payload"] },
  );
});

// ── Wallet address redaction ──────────────────────────────────────────────────

test("redactWalletAddresses drops raw wallet addresses from properties", () => {
  const { properties, dropped } = redactWalletAddresses({ payer: ADDRESS, claim_id: 1 });
  assert.equal("payer" in properties, false);
  assert.equal(properties.claim_id, 1);
  assert.deepEqual(dropped, ["payer"]);
});

test("redactWalletAddresses preserves contract address as public context", () => {
  const { properties, dropped } = redactWalletAddresses({ contract: ADDRESS, claim_id: 1 });
  assert.equal(properties.contract, ADDRESS);
  assert.deepEqual(dropped, []);
});

test("redactWalletAddresses walks nested objects", () => {
  const { properties, dropped } = redactWalletAddresses({
    context: { seller: ADDRESS, claim_id: 5 },
  });
  assert.deepEqual(properties, { context: { claim_id: 5 } });
  assert.deepEqual(dropped, ["context.seller"]);
});

test("redactWalletAddresses removes addresses from arrays", () => {
  const { properties, dropped } = redactWalletAddresses({
    participants: [ADDRESS, OTHER, "not-an-address"],
  });
  assert.deepEqual(properties.participants, ["not-an-address"]);
  // Both individual element paths and the parent array path are reported
  assert.deepEqual(dropped.sort(), ["participants", "participants[0]", "participants[1]"].sort());
});

test("redactWalletAddresses handles mixed nested arrays and objects", () => {
  const { properties, dropped } = redactWalletAddresses({
    data: { buyers: [ADDRESS], seller: OTHER, meta: { referrer: ADDRESS } },
  });
  // Both ADDRESS and OTHER are user wallet addresses — both are redacted.
  // Only contract addresses are preserved as public context.
  assert.deepEqual(properties, { data: { buyers: [], meta: {} } });
  assert.deepEqual(dropped.sort(), ["data.buyers", "data.buyers[0]", "data.meta.referrer", "data.seller"].sort());
});

test("redactWalletAddresses does not drop actor ids (hashed, not raw)", () => {
  const actorId = actorIdForAddress(ADDRESS, SALT)!;
  const { properties, dropped } = redactWalletAddresses({ distinct_id: actorId, claim_id: 1 });
  assert.equal(properties.distinct_id, actorId);
  assert.deepEqual(dropped, []);
});

test("redactWalletAddresses does not drop agent ids", () => {
  const { properties, dropped } = redactWalletAddresses({ distinct_id: "agent:oracle", claim_id: 1 });
  assert.equal(properties.distinct_id, "agent:oracle");
  assert.deepEqual(dropped, []);
});

// ── Boundary and negative tests for wallet address redaction ──────────────────

test("redactWalletAddresses handles empty object", () => {
  const { properties, dropped } = redactWalletAddresses({});
  assert.deepEqual(properties, {});
  assert.deepEqual(dropped, []);
});

test("redactWalletAddresses handles null and undefined values", () => {
  const { properties, dropped } = redactWalletAddresses({
    claim_id: 1,
    nullable_field: null,
    undefined_field: undefined,
  });
  assert.deepEqual(properties, { claim_id: 1 });
  assert.deepEqual(dropped, []);
});

test("redactWalletAddresses does not drop EVM addresses (not Stellar strkeys)", () => {
  const evmAddress = "0x1111111111111111111111111111111111111111";
  const { properties, dropped } = redactWalletAddresses({ eth_address: evmAddress });
  assert.equal(properties.eth_address, evmAddress);
  assert.deepEqual(dropped, []);
});

test("redactWalletAddresses does not drop truncated address-like strings", () => {
  const truncated = ADDRESS.slice(0, 50); // Too short to be a valid strkey
  const { properties, dropped } = redactWalletAddresses({ partial: truncated });
  assert.equal(properties.partial, truncated);
  assert.deepEqual(dropped, []);
});

test("redactWalletAddresses preserves case-sensitive contract address exactly", () => {
  // Contract addresses are compared verbatim — case matters for strkeys
  const { properties, dropped } = redactWalletAddresses({
    contract: ADDRESS,
    other_field: ADDRESS,
  });
  assert.equal(properties.contract, ADDRESS);
  assert.ok(!properties.other_field); // non-contract address is dropped
  assert.deepEqual(dropped, ["other_field"]);
});

test("redactWalletAddresses drops address in deeply nested structure", () => {
  const { properties, dropped } = redactWalletAddresses({
    level1: { level2: { level3: { wallet: ADDRESS } } },
  });
  assert.deepEqual(properties, { level1: { level2: { level3: {} } } });
  assert.deepEqual(dropped, ["level1.level2.level3.wallet"]);
});

test("redactWalletAddresses handles arrays with mixed types", () => {
  const { properties, dropped } = redactWalletAddresses({
    mixed: [ADDRESS, 123, "string", { nested: ADDRESS }, null, [OTHER]],
  });
  // Object keys containing addresses are dropped entirely (not kept as empty),
  // consistent with nested object behavior.
  assert.deepEqual(properties.mixed, [123, "string", {}, null, []]);
  // Reports element paths for nested arrays; parent array "mixed" is reported
  // at the top level, but nested array "mixed[5]" only reports its elements.
  assert.deepEqual(dropped.sort(), ["mixed", "mixed[0]", "mixed[3].nested", "mixed[5][0]"].sort());
});

// ── Actor identity ────────────────────────────────────────────────────────────

test("the actor id is stable for the same address and salt", () => {
  const first = actorIdForAddress(ADDRESS, SALT);
  const second = actorIdForAddress(ADDRESS, SALT);
  assert.equal(first, second, "the same address must map to the same actor id");
  assert.equal(first!.length, 32);
});

test("a lowercased strkey is not the same identity — it is not an identity", () => {
  // The inverse of the EVM rule this suite used to assert ("case must not change
  // identity"). Stellar strkeys are base32 over the UPPERCASE alphabet plus 2-7,
  // so `toUpperCase()` is a no-op on a valid one — which is exactly why only the
  // lowercase direction was ever destructive, and why it is the direction the
  // ledger code was silently applying.
  assert.equal(actorIdForAddress(ADDRESS.toUpperCase(), SALT), actorIdForAddress(ADDRESS, SALT));
  assert.equal(actorIdForAddress(ADDRESS.toLowerCase(), SALT), null);
});

test("different addresses get different actor ids", () => {
  assert.notEqual(actorIdForAddress(ADDRESS, SALT), actorIdForAddress(OTHER, SALT));
});

test("rotating the salt severs the link to the old id", () => {
  assert.notEqual(actorIdForAddress(ADDRESS, SALT), actorIdForAddress(ADDRESS, "rotated-salt-value"));
});

test("the actor id never contains the address", () => {
  const id = actorIdForAddress(ADDRESS, SALT)!;
  assert.equal(id.includes(ADDRESS), false);
  assert.equal(id.toLowerCase().includes(ADDRESS.toLowerCase()), false);
  assert.equal(containsRawAddress({ distinct_id: id }), false);
});

test("a malformed address yields no actor id", () => {
  assert.equal(actorIdForAddress("not-an-address", SALT), null);
  assert.equal(actorIdForAddress("0x1234", SALT), null);
  // An EVM address is not a Stellar address, however well-formed it is.
  assert.equal(actorIdForAddress("0x1111111111111111111111111111111111111111", SALT), null);
  // Right prefix, wrong length.
  assert.equal(actorIdForAddress("GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZL", SALT), null);
  assert.equal(actorIdForAddress("", SALT), null);
});

test("without a salt the actor degrades to anonymous, never to a raw address", () => {
  assert.equal(actorIdForAddress(ADDRESS, null), null);
  assert.equal(actorIdForAddress(ADDRESS, "too-short"), null);
  const actor = resolveActor({ address: ADDRESS, salt: null });
  assert.equal(actor.actorId, ANON_ACTOR_ID);
  assert.equal(actor.actorType, "anonymous");
  assert.equal(actor.degraded, true, "a misconfigured salt must be visible in the data");
});

test("no address means anonymous, and that is not a degraded state", () => {
  const actor = resolveActor({ salt: SALT });
  assert.equal(actor.actorId, ANON_ACTOR_ID);
  assert.equal(actor.actorType, "anonymous");
  assert.equal(actor.degraded, false);
});

test("humans and agents are separable so agent traffic cannot skew conversion", () => {
  const human = resolveActor({ address: ADDRESS, salt: SALT });
  const agent = resolveActor({ isAgent: true, agentId: "oracle", address: ADDRESS, salt: SALT });
  assert.equal(human.actorType, "human");
  assert.equal(agent.actorType, "agent");
  assert.equal(agent.actorId, "agent:oracle");
  assert.notEqual(human.actorId, agent.actorId);
});

test("an agent id is used verbatim and is not a wallet address", () => {
  const agent = resolveActor({ isAgent: true, agentId: "council-socrates" });
  assert.equal(containsRawAddress({ distinct_id: agent.actorId }), false);
});

test("unsafe agent ids degrade to anonymous before reaching distinct_id", () => {
  for (const agentId of [undefined, ADDRESS, "oracle@example.com", "x".repeat(65)]) {
    assert.deepEqual(resolveActor({ isAgent: true, agentId }), {
      actorId: ANON_ACTOR_ID,
      actorType: "anonymous",
      degraded: true,
    });
  }
});

// ── Idempotency ───────────────────────────────────────────────────────────────

test("the idempotency key is deterministic for the same logical step", () => {
  assert.equal(
    idempotencyKey(["stake_confirmed", 12, "0xabc"]),
    idempotencyKey(["stake_confirmed", 12, "0xabc"]),
  );
});

test("the idempotency key distinguishes different steps", () => {
  assert.notEqual(
    idempotencyKey(["stake_confirmed", 12]),
    idempotencyKey(["stake_confirmed", 13]),
  );
});

test("undefined and empty parts are skipped so the key stays stable", () => {
  assert.equal(idempotencyKey(["a", undefined, "b"]), "a:b");
  assert.equal(idempotencyKey(["a", "", "b"]), "a:b");
});

test("capture idempotency ids are opaque and fail closed without a strong salt", () => {
  const raw = `stake_confirmed:12:${ADDRESS}`;
  const opaque = opaqueAnalyticsId(raw, SALT);
  assert.equal(opaque?.length, 32);
  assert.equal(opaque?.includes(ADDRESS), false);
  assert.equal(opaqueAnalyticsId(raw, null), null);
  assert.equal(opaqueAnalyticsId(raw, "too-short"), null);
  assert.equal(opaqueAnalyticsId("x".repeat(513), SALT), null);
});
test("every roadmap success metric has an owned, non-financial-analytics source", () => {
  assert.equal(SUCCESS_METRICS.length, 11);
  assert.deepEqual(analyticsDefinitionErrors(), []);
  for (const metric of SUCCESS_METRICS) {
    if (/revenue|pnl/i.test(metric.name)) assert.notEqual(metric.source, "posthog");
  }
});
