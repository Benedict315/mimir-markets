import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  evaluateCapabilitiesStatus,
  evaluateDeploymentStatus,
  evaluateOperationalMetadata,
  evaluateOperationalStatusReport,
  operationalHttpStatus,
  sanitizePrivacySafe,
  FAILURE_MODES,
  ROLLBACK_GUIDANCE,
  type OperationalStatusReport,
} from "../../lib/ops/operational-status";
import { parseArtifactManifest } from "../../lib/ops/artifact-provenance";
import { runOperationalVerification } from "../../scripts/verify-operational-status";

const NOW = 1_800_000_000_000;
const FIXTURE_MANIFEST_PATH = join(
  process.cwd(),
  "tests",
  "fixtures",
  "operational-status",
  "clean-manifest.json",
);

const MOCK_VALID_MARKET = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const MOCK_VALID_SQUAD = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";
const MOCK_VALID_USDC = "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3";

function loadFixtureManifest() {
  const raw = JSON.parse(readFileSync(FIXTURE_MANIFEST_PATH, "utf8"));
  return parseArtifactManifest(raw);
}

// ── Positive Tests ─────────────────────────────────────────────────────────────

test("positive: default clean checkout evaluates cleanly to status ok", () => {
  const report = evaluateOperationalStatusReport({
    nowMs: NOW,
    env: {
      NODE_ENV: "development",
      NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
    },
  });

  assert.equal(report.status, "ok");
  assert.equal(report.mode, "operational");
  assert.equal(report.deployment.network, "testnet");
  assert.equal(report.deployment.chainFirstAccounting, true);
  assert.equal(report.metadata.failClosed, true);
  assert.equal(report.metadata.privacySafe, true);
  assert.equal(operationalHttpStatus(report), 200);
});

test("positive: fully configured deployment reports ready and valid contract formats", () => {
  const env = {
    NODE_ENV: "development",
    NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
    NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID: MOCK_VALID_MARKET,
    NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID: MOCK_VALID_SQUAD,
    NEXT_PUBLIC_STELLAR_USDC_SAC_ID: MOCK_VALID_USDC,
  };

  const deployment = evaluateDeploymentStatus({ env });
  assert.equal(deployment.contracts.market.configured, true);
  assert.equal(deployment.contracts.market.validFormat, true);
  assert.equal(deployment.contracts.squad.configured, true);
  assert.equal(deployment.contracts.squad.validFormat, true);
  assert.equal(deployment.contracts.usdcSac.configured, true);
  assert.equal(deployment.contracts.usdcSac.validFormat, true);
  assert.equal(deployment.fundedFeaturesReady, true);
});

test("positive: reports all 10 pausable capabilities and 3 non-pausable invariants", () => {
  const caps = evaluateCapabilitiesStatus({});
  assert.equal(caps.globalPause, false);

  const pausableItems = caps.items.filter((i) => i.type === "pausable");
  const invariantItems = caps.items.filter((i) => i.type === "invariant_never_pausable");

  assert.equal(pausableItems.length, 10);
  assert.equal(invariantItems.length, 3);

  const withdraw = caps.items.find((i) => i.capability === "withdraw");
  assert.ok(withdraw);
  assert.equal(withdraw?.status, "active");
  assert.equal(withdraw?.guaranteedNonPausable, true);
});

test("positive: CLI runOperationalVerification succeeds on valid report", () => {
  const report = evaluateOperationalStatusReport({
    nowMs: NOW,
    env: {
      NODE_ENV: "development",
      NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
      NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID: MOCK_VALID_MARKET,
      NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID: MOCK_VALID_SQUAD,
      NEXT_PUBLIC_STELLAR_USDC_SAC_ID: MOCK_VALID_USDC,
    },
  });

  const res = runOperationalVerification(report, {
    mode: "develop",
    failClosed: true,
    strict: false,
  });

  assert.equal(res.ok, true);
  assert.equal(res.checksFailed, 0);
  assert.ok(res.checksPassed >= 6);
});

// ── Negative Tests ─────────────────────────────────────────────────────────────

test("negative: malformed contract address format is flagged as invalid", () => {
  const env = {
    NODE_ENV: "development",
    NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID: "not-a-stellar-contract-address",
  };

  const deployment = evaluateDeploymentStatus({ env });
  assert.equal(deployment.contracts.market.configured, true);
  assert.equal(deployment.contracts.market.validFormat, false);
  assert.equal(deployment.fundedFeaturesReady, false);
});

test("negative: missing contracts fail closed in release mode", () => {
  const env = {
    NODE_ENV: "production",
    MIMIR_REQUIRE_ARTIFACT_PROVENANCE: "1",
  };

  const report = evaluateOperationalStatusReport({
    nowMs: NOW,
    env,
  });

  assert.equal(report.status, "critical");
  assert.equal(report.mode, "outage");
  assert.equal(report.deployment.fundedFeaturesReady, false);
  assert.equal(operationalHttpStatus(report), 503);
});

test("negative: unpinned artifact in release mode produces error findings", () => {
  const manifest = loadFixtureManifest();
  // Clear the pin
  manifest.artifacts[0].sha256 = null;

  const report = evaluateOperationalStatusReport({
    nowMs: NOW,
    manifest,
    env: {
      NODE_ENV: "production",
      MIMIR_REQUIRE_ARTIFACT_PROVENANCE: "1",
    },
  });

  assert.equal(report.status, "critical");
  assert.ok(
    report.deployment.artifacts.findings.some(
      (f) => f.code === "DIGEST_UNPINNED" && f.severity === "error",
    ),
  );
});

// ── Failure Tests ──────────────────────────────────────────────────────────────

test("failure: critical alarm in health snapshot propagates to critical operational status", () => {
  const report = evaluateOperationalStatusReport({
    nowMs: NOW,
    healthSnapshot: {
      workers: [{ name: "oracle", lastBeatAtMs: null }],
      indexLastSyncAgeSec: 45,
      oldestQueuedJobAgeSec: 0,
      oldestOverdueSettlementSec: 0,
      oracleBacklog: 0,
      rpc: { attempts: 100, failures: 0 },
      facilitator: { attempts: 100, failures: 0 },
      sources: { attempts: 100, failures: 0 },
    },
  });

  assert.equal(report.status, "critical");
  assert.equal(report.mode, "outage");
  assert.equal(operationalHttpStatus(report), 503);
  assert.ok(report.health.alarms.some((a) => a.id === "worker.oracle.missing"));
});

test("failure: CLI runOperationalVerification fails closed on critical status", () => {
  const report = evaluateOperationalStatusReport({
    nowMs: NOW,
    env: {
      NODE_ENV: "production",
      MIMIR_REQUIRE_ARTIFACT_PROVENANCE: "1",
    },
  });

  const res = runOperationalVerification(report, {
    mode: "release",
    failClosed: true,
    strict: false,
  });

  assert.equal(res.ok, false);
  assert.ok(res.checksFailed > 0);
});

// ── Invariant, Regression & Safety Tests ────────────────────────────────────────

test("invariant: withdrawal is NEVER pausable even when MIMIR_PAUSE_WITHDRAW is set", () => {
  const caps = evaluateCapabilitiesStatus({
    MIMIR_PAUSE_WITHDRAW: "1",
    MIMIR_PAUSE_ALL: "1",
  } as Record<string, string>);

  const withdraw = caps.items.find((i) => i.capability === "withdraw");
  assert.ok(withdraw);
  assert.equal(withdraw?.status, "active");
  assert.equal(withdraw?.guaranteedNonPausable, true);
  assert.equal(withdraw?.viaGlobal, false);
});

test("regression: read_markets and read_reasoning remain active during global pause", () => {
  const caps = evaluateCapabilitiesStatus({
    MIMIR_PAUSE_ALL: "1",
    MIMIR_PAUSE_ALL_REASON: "Incident investigation",
  });

  assert.equal(caps.globalPause, true);
  assert.equal(caps.globalReason, "Incident investigation");

  const readMarkets = caps.items.find((i) => i.capability === "read_markets");
  const readReasoning = caps.items.find((i) => i.capability === "read_reasoning");

  assert.equal(readMarkets?.status, "active");
  assert.equal(readReasoning?.status, "active");

  const createMarket = caps.items.find((i) => i.capability === "create_market");
  assert.equal(createMarket?.status, "paused");
  assert.equal(createMarket?.viaGlobal, true);
});

test("regression: single capability pause reflects reason and paused timestamp", () => {
  const caps = evaluateCapabilitiesStatus({
    MIMIR_PAUSE_STAKE: "1",
    MIMIR_PAUSE_STAKE_REASON: "Pricing curve recalculation",
    MIMIR_PAUSE_STAKE_AT: "1790000000000",
  });

  const stake = caps.items.find((i) => i.capability === "stake");
  assert.equal(stake?.status, "paused");
  assert.equal(stake?.reason, "Pricing curve recalculation");
  assert.equal(stake?.pausedAt, 1790000000000);
  assert.equal(stake?.viaGlobal, false);
});

test("safety: sanitizePrivacySafe redacts secret keys, connection strings, and tokens", () => {
  const dummySk = ["sk", "live", "1234567890abcdefghijklmn"].join("_");
  const dummyGhp = ["ghp", "0123456789abcdefghijklmnopqrstuvwxyz"].join("_");
  const dummyMk = ["mk", "live", "99887766554433221100"].join("_");
  const dirty = {
    message: "Failed to connect to postgres://app_user:s3cr3tPass@db.mimir.internal:5432/mimir",
    nested: {
      auth: `Bearer ${dummyMk}`,
      key: dummySk,
      token: dummyGhp,
    },
    list: ["Safe text", "Database URL postgresql://admin:secret@host/db"],
  };

  const clean = sanitizePrivacySafe(dirty);
  const serialized = JSON.stringify(clean);

  assert.ok(!serialized.includes("s3cr3tPass"));
  assert.ok(!serialized.includes(dummyMk));
  assert.ok(!serialized.includes(dummySk));
  assert.ok(!serialized.includes(dummyGhp));
  assert.ok(serialized.includes("[REDACTED_CREDENTIALS]"));
  assert.ok(serialized.includes("[REDACTED_SECRET_KEY]"));
  assert.ok(serialized.includes("[REDACTED_API_KEY]"));
  assert.ok(serialized.includes("[REDACTED_GITHUB_TOKEN]"));
});

test("documentation integrity: FAILURE_MODES and ROLLBACK_GUIDANCE are non-empty and explicit", () => {
  assert.ok(FAILURE_MODES.length >= 4);
  assert.ok(FAILURE_MODES.some((m) => m.startsWith("DATABASE_UNCONFIGURED")));
  assert.ok(FAILURE_MODES.some((m) => m.startsWith("ARTIFACT_DIGEST_MISMATCH")));
  assert.ok(FAILURE_MODES.some((m) => m.startsWith("CAPABILITY_PAUSED")));

  assert.ok(ROLLBACK_GUIDANCE.capabilities);
  assert.ok(ROLLBACK_GUIDANCE.contracts);
  assert.ok(ROLLBACK_GUIDANCE.web_release);
  assert.ok(ROLLBACK_GUIDANCE.money_movement);
});
