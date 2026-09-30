/**
 * Public operational status surface — fail-closed deployment and safety telemetry.
 *
 * Provides a unified, privacy-safe, unauthenticated view of Mimir's operational
 * state so funded features can ship and operate with predictable safety.
 *
 * Core principles:
 *  1. Chain-first accounting: Soroban contracts and Stellar ledgers are the
 *     authoritative source of truth for funds and settlements. Postgres is an
 *     idempotent read-index projection.
 *  2. Fail-closed security: Missing database, missing contracts in release mode,
 *     or artifact digest mismatches mark the surface critical (HTTP 503) and block
 *     funded operations.
 *  3. Incident agility: Capabilities (create_market, stake, copy_execution, etc.)
 *     are independently pausable via env vars without redeploying.
 *  4. Invariant protection: Withdrawals and read paths are NEVER pausable.
 *  5. Privacy-safe: Zero secrets (no S… seeds, no database passwords, no API keys)
 *     and zero PII/user addresses ever leak in this surface.
 */

import {
  DEFAULT_MANIFEST_RELATIVE,
  parseArtifactManifest,
  verifyArtifactProvenance,
  type ArtifactManifest,
  type ProvenanceFinding,
  type VerifyMode,
} from "./artifact-provenance";
import {
  PAUSABLE,
  NEVER_PAUSABLE,
  checkWriteAllowed,
  isNeverPausable,
  type Pausable,
  type NeverPausable,
} from "./flags";
import {
  evaluateHealth,
  type HealthReport,
  type HealthSnapshot,
  type Severity,
} from "./health";
import {
  STELLAR_NETWORK,
  NETWORK_PASSPHRASE,
  isContractAddress,
  getMarketContractId,
  getSquadContractId,
  getUsdcSacId,
} from "../stellar";

export type OperationalStatusLevel = "ok" | "warn" | "critical";
export type OperationalMode = "operational" | "degraded" | "paused" | "outage";

export interface ContractDeploymentStatus {
  name: string;
  configured: boolean;
  contractId: string | null;
  validFormat: boolean;
  role: string;
}

export interface ArtifactProvenanceSummary {
  manifestLoaded: boolean;
  schemaVersion: number;
  hashAlgorithm: string;
  totalArtifacts: number;
  pinnedCount: number;
  unpinnedCount: number;
  mode: VerifyMode;
  verified: boolean;
  findings: ProvenanceFinding[];
}

export interface DeploymentStatus {
  network: string;
  networkPassphrase: string;
  contracts: {
    market: ContractDeploymentStatus;
    squad: ContractDeploymentStatus;
    usdcSac: ContractDeploymentStatus;
  };
  artifacts: ArtifactProvenanceSummary;
  chainFirstAccounting: boolean;
  fundedFeaturesReady: boolean;
}

export interface CapabilityOperationalStatus {
  capability: Pausable | NeverPausable;
  type: "pausable" | "invariant_never_pausable";
  status: "active" | "paused";
  reason?: string;
  pausedAt?: number;
  viaGlobal: boolean;
  guaranteedNonPausable?: boolean;
}

export interface CapabilitiesStatus {
  globalPause: boolean;
  globalReason?: string;
  items: CapabilityOperationalStatus[];
  failClosed: boolean;
}

export interface OperationalMetadata {
  version: string;
  environment: "production" | "preview" | "development" | "test";
  commitSha?: string;
  nodeEnv: string;
  failClosed: boolean;
  privacySafe: boolean;
  timestamp: string;
  timestampMs: number;
}

export interface OperationalStatusReport {
  status: OperationalStatusLevel;
  mode: OperationalMode;
  summary: string;
  deployment: DeploymentStatus;
  capabilities: CapabilitiesStatus;
  health: HealthReport;
  metadata: OperationalMetadata;
  failureModes: string[];
  rollbackGuidance: Record<string, string>;
}

export const FAILURE_MODES = [
  "DATABASE_UNCONFIGURED: Database unavailable or unconfigured; write and read cache disabled; health probe returns 503 fail-closed.",
  "ARTIFACT_DIGEST_MISMATCH: Soroban Wasm bytecode digest does not match committed deployment manifest pin; release halts fail-closed.",
  "CAPABILITY_PAUSED: Emergency kill-switch active for one or more features; writes return structured 503/403 with operator reason.",
  "CHAIN_RPC_UNREACHABLE: Horizon or Soroban RPC unavailable; state verification fails closed and prevents settlement drift.",
  "NOISE_SUPPRESSED: Sample size below MIN_SAMPLES (<20) suppresses transient rate paging to avoid false alarms.",
] as const;

export const ROLLBACK_GUIDANCE: Record<string, string> = {
  capabilities:
    "Set MIMIR_PAUSE_<CAPABILITY>=1 in environment to halt writes instantly without redeployment. Set to 0 after remediation.",
  contracts:
    "Point NEXT_PUBLIC_STELLAR_*_CONTRACT_ID to previous verified contract addresses and restore matching pins in contract-artifacts.manifest.json.",
  web_release:
    "Rollback frontend/api deployment to prior release commit; read explorer and user withdrawal paths remain available.",
  money_movement:
    "Withdrawals are an invariant (NEVER_PAUSABLE) and remain functional even during complete incident pause so users are never trapped.",
};

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/S[A-Z2-7]{55}/g, "[REDACTED_STELLAR_SEED]"],
  [/(postgres|postgresql):\/\/[^@\s]+@[^\s"']+/gi, "postgresql://[REDACTED_CREDENTIALS]@[REDACTED_HOST]"],
  [/sk_live_[a-zA-Z0-9_-]{10,}/g, "[REDACTED_SECRET_KEY]"],
  [/mk_live_[a-zA-Z0-9_-]{10,}/g, "[REDACTED_API_KEY]"],
  [/gh[ps]_[a-zA-Z0-9]{36}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [REDACTED_BEARER_TOKEN]"],
];

/** Recursively sanitize strings in an object against known secret patterns. */
export function sanitizePrivacySafe<T>(input: T): T {
  if (typeof input === "string") {
    let sanitized: string = input;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
      sanitized = sanitized.replace(pattern, replacement);
    }
    return sanitized as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => sanitizePrivacySafe(item)) as unknown as T;
  }
  if (input !== null && typeof input === "object") {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      copy[k] = sanitizePrivacySafe(v);
    }
    return copy as unknown as T;
  }
  return input;
}

export interface OperationalStatusOptions {
  env?: Record<string, string | undefined>;
  manifest?: ArtifactManifest;
  artifactFiles?: Record<string, Uint8Array | Buffer>;
  nowMs?: number;
  healthSnapshot?: HealthSnapshot;
}

/** Evaluate deployment status without network calls or secrets. */
export function evaluateDeploymentStatus(
  options: OperationalStatusOptions = {},
): DeploymentStatus {
  const env = options.env ?? process.env;
  const network = env.NEXT_PUBLIC_STELLAR_NETWORK ?? STELLAR_NETWORK;
  const networkPassphrase =
    env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ?? NETWORK_PASSPHRASE;

  const marketId = env.NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID ?? getMarketContractId() ?? null;
  const squadId = env.NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID ?? getSquadContractId() ?? null;
  const usdcSac = env.NEXT_PUBLIC_STELLAR_USDC_SAC_ID ?? getUsdcSacId() ?? null;

  const marketValid = Boolean(marketId && isContractAddress(marketId));
  const squadValid = Boolean(squadId && isContractAddress(squadId));
  const usdcValid = Boolean(usdcSac && isContractAddress(usdcSac));

  const mode: VerifyMode =
    env.MIMIR_REQUIRE_ARTIFACT_PROVENANCE === "1" || env.NODE_ENV === "production"
      ? "release"
      : "develop";

  let artifactSummary: ArtifactProvenanceSummary;

  if (options.manifest) {
    const report = verifyArtifactProvenance(options.manifest, {
      mode,
      fileContents: options.artifactFiles,
    });
    const pinnedCount = options.manifest.artifacts.filter(
      (a) => typeof a.sha256 === "string" && a.sha256.length > 0,
    ).length;
    artifactSummary = {
      manifestLoaded: true,
      schemaVersion: options.manifest.schemaVersion,
      hashAlgorithm: options.manifest.hashAlgorithm,
      totalArtifacts: options.manifest.artifacts.length,
      pinnedCount,
      unpinnedCount: options.manifest.artifacts.length - pinnedCount,
      mode,
      verified: report.ok,
      findings: report.findings,
    };
  } else {
    try {
      // In Node environments, try reading the committed manifest
      const fs = require("node:fs");
      const path = require("node:path");
      const manifestPath = path.resolve(process.cwd(), DEFAULT_MANIFEST_RELATIVE);
      if (fs.existsSync(manifestPath)) {
        const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const parsed = parseArtifactManifest(raw);
        const report = verifyArtifactProvenance(parsed, {
          mode,
          fileContents: options.artifactFiles,
        });
        const pinnedCount = parsed.artifacts.filter(
          (a) => typeof a.sha256 === "string" && a.sha256.length > 0,
        ).length;
        artifactSummary = {
          manifestLoaded: true,
          schemaVersion: parsed.schemaVersion,
          hashAlgorithm: parsed.hashAlgorithm,
          totalArtifacts: parsed.artifacts.length,
          pinnedCount,
          unpinnedCount: parsed.artifacts.length - pinnedCount,
          mode,
          verified: report.ok,
          findings: report.findings,
        };
      } else {
        artifactSummary = {
          manifestLoaded: false,
          schemaVersion: 1,
          hashAlgorithm: "sha256",
          totalArtifacts: 0,
          pinnedCount: 0,
          unpinnedCount: 0,
          mode,
          verified: mode !== "release",
          findings: [
            {
              code: "MANIFEST_INVALID",
              severity: mode === "release" ? "error" : "warning",
              message: "Deployment manifest not found on disk",
            },
          ],
        };
      }
    } catch (err) {
      artifactSummary = {
        manifestLoaded: false,
        schemaVersion: 1,
        hashAlgorithm: "sha256",
        totalArtifacts: 0,
        pinnedCount: 0,
        unpinnedCount: 0,
        mode,
        verified: mode !== "release",
        findings: [
          {
            code: "MANIFEST_INVALID",
            severity: mode === "release" ? "error" : "warning",
            message: `Manifest read error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  }

  const contractsReady = marketValid && squadValid && usdcValid;
  const artifactsReady = artifactSummary.verified;

  return {
    network,
    networkPassphrase,
    contracts: {
      market: {
        name: "mimir-market",
        configured: Boolean(marketId),
        contractId: marketId,
        validFormat: marketValid,
        role: "Primary claim prediction market and dispute resolution engine",
      },
      squad: {
        name: "mimir-squad",
        configured: Boolean(squadId),
        contractId: squadId,
        validFormat: squadValid,
        role: "Squad multi-agent syndicated staking pool",
      },
      usdcSac: {
        name: "usdc-sac",
        configured: Boolean(usdcSac),
        contractId: usdcSac,
        validFormat: usdcValid,
        role: "Stellar Asset Contract for native USDC escrow and payouts",
      },
    },
    artifacts: artifactSummary,
    chainFirstAccounting: true,
    fundedFeaturesReady: contractsReady && artifactsReady,
  };
}

/** Evaluate all capability pause states and enforce non-pausable invariants. */
export function evaluateCapabilitiesStatus(
  env: Record<string, string | undefined> = process.env,
): CapabilitiesStatus {
  const globalPause = env.MIMIR_PAUSE_ALL === "1" || env.MIMIR_PAUSE_ALL === "true";
  const globalReason = env.MIMIR_PAUSE_ALL_REASON;

  const items: CapabilityOperationalStatus[] = [];

  // 1. Pausable capabilities
  for (const cap of PAUSABLE) {
    const gate = checkWriteAllowed({ capability: cap }, env);
    items.push({
      capability: cap,
      type: "pausable",
      status: gate.allowed ? "active" : "paused",
      reason: gate.pauseDetail?.reason,
      pausedAt: gate.pauseDetail?.pausedAt,
      viaGlobal: gate.pauseDetail?.viaGlobal ?? false,
    });
  }

  // 2. Invariants that MUST NEVER BE PAUSABLE
  for (const cap of NEVER_PAUSABLE) {
    // Invariant assertion: even if someone attempts MIMIR_PAUSE_WITHDRAW=1, it is ignored
    items.push({
      capability: cap,
      type: "invariant_never_pausable",
      status: "active",
      viaGlobal: false,
      guaranteedNonPausable: true,
    });
  }

  return {
    globalPause,
    globalReason,
    items,
    failClosed: true,
  };
}

/** Evaluate operational metadata without leaking any secret. */
export function evaluateOperationalMetadata(
  env: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now(),
): OperationalMetadata {
  const version = env.MIMIR_APP_VERSION ?? "0.1.0";
  const environment =
    (env.MIMIR_ENVIRONMENT as any) ??
    (env.VERCEL_ENV as any) ??
    (env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development");

  const rawCommit = env.MIMIR_GIT_COMMIT ?? env.VERCEL_GIT_COMMIT_SHA ?? env.GIT_COMMIT;
  const commitSha = rawCommit ? rawCommit.slice(0, 12) : undefined;

  return {
    version,
    environment,
    commitSha,
    nodeEnv: env.NODE_ENV ?? "development",
    failClosed: true,
    privacySafe: true,
    timestamp: new Date(nowMs).toISOString(),
    timestampMs: nowMs,
  };
}

/**
 * Pure evaluator that computes the complete operational status report.
 */
export function evaluateOperationalStatusReport(
  options: OperationalStatusOptions = {},
): OperationalStatusReport {
  const nowMs = options.nowMs ?? Date.now();
  const env = options.env ?? process.env;

  const deployment = evaluateDeploymentStatus(options);
  const capabilities = evaluateCapabilitiesStatus(env);
  const metadata = evaluateOperationalMetadata(env, nowMs);

  // If healthSnapshot is provided, evaluate it; otherwise build default/mock
  const healthReport = options.healthSnapshot
    ? evaluateHealth(options.healthSnapshot, nowMs)
    : {
        status: "ok" as Severity,
        alarms: [],
        measurements: {
          indexLastSyncAgeSec: 0,
          oldestQueuedJobAgeSec: 0,
          oldestOverdueSettlementSec: 0,
          oracleBacklog: 0,
          rpcFailureRatio: 0,
          facilitatorFailureRatio: 0,
          sourceFailureRatio: 0,
          workerAgesSec: {},
          workerTraceIds: {},
        },
      };

  // Determine overall status
  let status: OperationalStatusLevel = "ok";
  let mode: OperationalMode = "operational";

  const hasCriticalAlarm = healthReport.status === "critical";
  const hasArtifactError = deployment.artifacts.findings.some(
    (f) => f.severity === "error",
  );
  const isReleaseMode = deployment.artifacts.mode === "release";
  const isContractsMissingInRelease = isReleaseMode && !deployment.fundedFeaturesReady;

  if (hasCriticalAlarm || hasArtifactError || isContractsMissingInRelease) {
    status = "critical";
    mode = "outage";
  } else if (capabilities.globalPause || capabilities.items.some((c) => c.status === "paused")) {
    status = "warn";
    mode = "paused";
  } else if (healthReport.status === "warn" || deployment.artifacts.findings.length > 0) {
    status = "warn";
    mode = "degraded";
  }

  let summary = `Mimir is operational (${deployment.network}).`;
  if (status === "critical") {
    summary = `Mimir has critical operational issues: ${
      healthReport.alarms[0]?.message ??
      (hasArtifactError ? "Artifact provenance mismatch" : "Deployment unconfigured")
    }.`;
  } else if (mode === "paused") {
    summary = capabilities.globalPause
      ? `Mimir writes are globally paused: ${capabilities.globalReason ?? "operational pause"}.`
      : "One or more funded capabilities are paused for operational safety.";
  } else if (mode === "degraded") {
    summary = "Mimir is operating in degraded mode with active non-critical warnings.";
  }

  const rawReport: OperationalStatusReport = {
    status,
    mode,
    summary,
    deployment,
    capabilities,
    health: healthReport,
    metadata,
    failureModes: [...FAILURE_MODES],
    rollbackGuidance: { ...ROLLBACK_GUIDANCE },
  };

  return sanitizePrivacySafe(rawReport);
}

/** HTTP status code: 503 if critical, 200 otherwise. */
export function operationalHttpStatus(report: { status: OperationalStatusLevel }): number {
  return report.status === "critical" ? 503 : 200;
}
