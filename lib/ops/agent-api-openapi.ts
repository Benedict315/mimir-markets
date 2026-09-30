/**
 * The published agent API contract, generated from the live code.
 *
 * Mimir's agent API is a money-moving surface that third parties write against
 * without reading the repository. The contract used to be a hand-maintained
 * `docs/openapi-agent-v1.yaml` and it drifted: it listed eleven actions while the
 * route has served eighteen (the whole key and spend-permission surface was
 * undocumented), and the docs page still told readers a replayed nonce came back
 * 409 when the route has always returned 401. Nothing failed, because nothing
 * compared the two.
 *
 * So the document is derived here instead of written by hand. Every machine-
 * readable fact in it is read from the module that enforces it:
 *
 *   actions          lib/agents/api.ts            (AGENT_API_ACTIONS)
 *   funding gate     lib/agents/api.ts            (AGENT_FUNDED_ACTIONS)
 *   credentials      lib/agents/authenticate.ts   (requiresOwnerSignature)
 *   incident switch  lib/agents/api.ts            (AGENT_ACTION_PAUSE)
 *   limits           lib/agents/api.ts, lib/agents/registry.ts
 *   error status     lib/api/errors.ts            (apiErrorCatalogue)
 *   wallet limits    lib/ops/flags.ts             (PAUSABLE, pauseEnvKey)
 *   fee arithmetic   lib/agents/dry-run.ts        (buildAgentDryRun)
 *
 * and every published example is executed against the live validator
 * (`validateAgentRequestEnvelope`) and the published JSON schema before it is
 * written. An example that the server would reject cannot be published, because
 * generating the file would fail.
 *
 * Two rules make the result safe to commit:
 *
 *   1. **No secrets, ever.** Every address is one of the synthetic placeholders
 *      below (derived from a public constant, so no key exists for any of them),
 *      every credential is an obviously-fake `mk_test_…` token, and
 *      `auditAgentApiDocument` fails the check if anything credential-shaped
 *      appears that is not on that allowlist.
 *   2. **Offline and deterministic.** No env, no clock, no randomness, no RPC:
 *      the same commit always regenerates the same bytes, which is what lets CI
 *      compare a regenerated file against the committed one.
 *
 * Finding codes are stable and their messages never echo a value — a failure
 * report is safe to paste into an issue. See `docs/AGENT_API_OPENAPI.md`.
 */

import {
  AGENT_ACTION_PAUSE,
  AGENT_API_ACTIONS,
  AGENT_API_VERSION,
  AGENT_FUNDED_ACTIONS,
  AGENT_FUNDED_FEATURE,
  AGENT_REGISTRY_FEATURE,
  AGENT_REQUEST_MAX_SKEW_MS,
  MAX_SIGNED_REQUEST_PAYLOAD_BYTES,
  agentRequestMessage,
  operatorProofMessage,
  validateAgentRequestEnvelope,
  type AgentApiAction,
  type SignedAgentRequest,
} from "@/lib/agents/api";
import { requiresOwnerSignature } from "@/lib/agents/authenticate";
import { buildAgentDryRun } from "@/lib/agents/dry-run";
import {
  AUTHORITY_LEVELS,
  authorizeAction,
  defaultLimits,
  type AgentCapability,
  type AgentRecord,
  type AuthorityLevel,
} from "@/lib/agents/registry";
import { apiError, apiErrorCatalogue, type ApiErrorCode, type ApiErrorSpec } from "@/lib/api/errors";
import { PAUSABLE, pauseEnvKey, type Pausable } from "@/lib/ops/flags";
import { isContractAddress } from "@/lib/stellar";
import { isStellarAccount } from "@/lib/stellar-message";
import { assertSupportedKeywords, validateAgainstSchema } from "@/lib/ops/json-schema-subset";
import { asYamlValue, toYaml, type YamlValue } from "@/lib/ops/yaml";
import { usdcToUnits } from "@/lib/usdc";

export const OPENAPI_RELATIVE = "docs/openapi-agent-v1.yaml";
export const SCHEMA_RELATIVE = "schemas/agent-api-v1.schema.json";

/**
 * Placeholder host.
 *
 * The document describes the API, not a deployment: a committed real hostname
 * tells a reader which instance is live, and a committed internal hostname would
 * leak topology. An operator publishing their own copy substitutes it there; the
 * audit then reports a warning (`SERVER_URL_NOT_PLACEHOLDER`) rather than failing,
 * because naming your own public host is legitimate.
 */
export const SERVER_URL_PLACEHOLDER = "https://mimir.example";

/** Fixed clock for every published example, so generation is byte-stable. */
export const EXAMPLE_SIGNED_AT_MS = 1_755_200_000_000;

/** Unix seconds, matching the same instant, for spend-permission examples. */
const EXAMPLE_START_AT_S = Math.floor(EXAMPLE_SIGNED_AT_MS / 1000);
const EXAMPLE_END_AT_S = EXAMPLE_START_AT_S + 30 * 24 * 60 * 60;

/**
 * Synthetic wallets.
 *
 * Derived from `sha256("mimir-openapi-example/" + role)`, so they are reproducible
 * by anyone reviewing this file, and no private key for any of them exists or will
 * be published. They are REAL strkeys — valid version bytes, valid CRC16 — because
 * an example with a malformed address teaches a caller the wrong shape and a
 * stricter server would reject their first real request.
 *
 * Re-derive and check with:
 *   node -e "const {StrKey,hash}=require('@stellar/stellar-sdk');\
 *   for (const r of ['owner','operator','payout-wallet','spender','usdc-sac'])\
 *   console.log(r, StrKey.encodeEd25519PublicKey(hash(Buffer.from('mimir-openapi-example/'+r))))"
 */
export const SYNTHETIC_WALLETS = {
  owner: "GB7RICBT3KM36Z5VDUFC63BYHTVZXM6IQZMWJ3LRNSM5RM63TRTJARRK",
  operator: "GDJZRBH4KNOVBTOZBCLFGF5FW3VQIEWEXCGN7V4MLLJNV4TQZFWG47C3",
  payout: "GBB5P3KLZCJ5S3OX553HDNX2DIIETIRXTD7MLF32FTMEELBGM7GPO6C6",
  spender: "GCLSS2UVE5LPYLXDAIFOQDORHDSE6IN2DP6RRTC3RAWG3KEFPFXNUBCC",
  usdcSac: "CCSH6NUOVUVU3ONODLWHQAUO6NQJI5HBIYYQW6EMF32JBAC2XIKP3TIL",
} as const;

export const SYNTHETIC_WALLET_VALUES: readonly string[] = Object.values(SYNTHETIC_WALLETS);

/**
 * Obvious non-credentials. A caller copying an example gets a request that is
 * refused for a stated reason rather than one that looks live.
 *
 * The signature placeholders are base64 of 64 zero bytes, so they have the real
 * width an Ed25519 signature has; the verifier rejects them, which is the point.
 * Regenerate with `Buffer.alloc(64).toString("base64")`.
 */
export const PLACEHOLDER_API_KEY = "mk_test_EXAMPLEPLACEHOLDER0000000000000000";
export const PLACEHOLDER_SIGNATURE = Buffer.alloc(64).toString("base64");

/** Tokens the published documents are allowed to contain, credential-shaped or not. */
const ALLOWED_TOKENS: readonly string[] = [
  ...SYNTHETIC_WALLET_VALUES,
  PLACEHOLDER_API_KEY,
  PLACEHOLDER_SIGNATURE,
];

/**
 * Credential shapes that must never appear in a committed document.
 *
 * Every pattern is global: the scan reports the first match of each shape in a
 * document, which is enough to fail the build and enough to find the line.
 */
const SECRET_SHAPES: readonly { label: string; pattern: RegExp }[] = [
  { label: "stellar secret seed", pattern: /\bS[A-Z2-7]{55}\b/g },
  { label: "live or test agent API key", pattern: /\bmk_(?:live|test)_[A-Za-z0-9_-]{20,}/g },
  { label: "anthropic api key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { label: "openai-style api key", pattern: /\bsk-[A-Za-z0-9]{32,}/g },
  { label: "google api key", pattern: /\bAIza[A-Za-z0-9_-]{30,}/g },
  { label: "postgres connection string", pattern: /\bpostgres(?:ql)?:\/\/[^\s"']+/g },
  { label: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { label: "assigned secret env value", pattern: /\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\s*=\s*\S/g },
];

export type OpenApiFindingCode =
  // structure
  | "DOC_MISSING_PATH"
  | "DOC_MISSING_SCHEMA_REF"
  | "DOC_MISSING_ACTION_MATRIX"
  | "SCHEMA_ACTION_DRIFT"
  | "DOC_SCHEMA_UNSUPPORTED"
  | "SERVER_URL_NOT_PLACEHOLDER"
  // actions
  | "ACTION_UNDOCUMENTED"
  | "ACTION_UNDOCUMENTED_IN_SCHEMA"
  | "ACTION_UNKNOWN"
  | "CREDENTIAL_DRIFT"
  | "FUNDED_GATE_DRIFT"
  | "PAUSE_SWITCH_DRIFT"
  | "ACTION_CAPABILITY_DRIFT"
  | "PAUSE_CAPABILITY_UNKNOWN"
  // errors
  | "ERROR_CODE_UNDOCUMENTED"
  | "ERROR_CODE_UNKNOWN"
  | "ERROR_STATUS_DRIFT"
  | "ERROR_RETRYABLE_DRIFT"
  // examples
  | "EXAMPLE_ENVELOPE_REJECTED"
  | "EXAMPLE_SCHEMA_REJECTED"
  | "EXAMPLE_REJECTION_DRIFT"
  | "SIGNING_MESSAGE_DRIFT"
  | "EXAMPLE_MISSING"
  // safety
  | "SECRET_MATERIAL_IN_DOCS"
  | "PLACEHOLDER_WALLET_UNKNOWN"
  | "PLACEHOLDER_WALLET_MALFORMED"
  | "LIMIT_DRIFT"
  // committed files
  | "ARTIFACT_MISSING"
  | "ARTIFACT_DRIFT";

export interface OpenApiFinding {
  code: OpenApiFindingCode;
  severity: "error" | "warning";
  /** JSON-pointer-ish locator inside the document. Never a value. */
  where: string;
  message: string;
}

export interface OpenApiAudit {
  ok: boolean;
  findings: OpenApiFinding[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ── Request envelope schema ───────────────────────────────────────────────────

/**
 * The signed envelope, as JSON Schema.
 *
 * The root stays an object with `properties` so an existing `$ref` consumer keeps
 * working, and the API-key relaxation is expressed with `if/then`: a request that
 * carries a `signature` is the full signed envelope, and one that does not is the
 * bearer path, where the server fills version, nonce, timestamp and signature
 * itself. Publishing the old unconditional `required` list would have kept
 * describing a shape the server has not required since API keys shipped.
 */
export function buildAgentApiJsonSchema(): Record<string, unknown> {
  const envelopeProperties: Record<string, unknown> = {
    version: { const: AGENT_API_VERSION, description: `Envelope version. Only "${AGENT_API_VERSION}" is served.` },
    agentId: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9-]{2,63}$",
      description: "Registry id. On the API-key path the key's own agent wins and any claimed value must match it.",
    },
    action: {
      enum: [...AGENT_API_ACTIONS],
      description: "Must equal the {action} path segment. The action list is the live one in lib/agents/api.ts.",
    },
    idempotencyKey: {
      type: "string", minLength: 1, maxLength: 128,
      description: "Client-chosen replay key. Re-posting the same key returns the stored response instead of re-executing.",
    },
    nonce: {
      type: "string", minLength: 1, maxLength: 128,
      description: `Single-use value, consumed for the envelope's freshness window (${AGENT_REQUEST_MAX_SKEW_MS} ms). A replay is refused as nonce_reused.`,
    },
    signedAt: {
      type: "integer",
      description: `Epoch milliseconds, within ${AGENT_REQUEST_MAX_SKEW_MS} ms (5 minutes) of the server clock.`,
    },
    body: { description: "Action payload. Undefined here by design: each action's credential, funding gate and incident switch are listed under x-mimir-actions." },
    signature: {
      type: "string",
      pattern: "^[A-Za-z0-9+/]{16,}={0,2}$",
      description:
        "Base64 Ed25519 signature over the canonical request message, as SEP-43 signMessage returns it. Mirrors the check in lib/agents/api.ts.",
    },
  };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://mimir.example/schemas/agent-api-v1.schema.json",
    title: "Mimir Agent API request",
    description:
      "One endpoint serves every agent action. Send the signed envelope, or — on the bearer path — just the body: "
      + "the server fills version, nonce, timestamp and signature from the API key. GENERATED from lib/agents/api.ts by `npm run check:openapi -- --write`; edit that module, not this file.",
    type: "object",
    additionalProperties: false,
    properties: envelopeProperties,
    allOf: [
      {
        // A request carrying a signature IS the signed envelope, so all of it is
        // required. A request without one is the bearer path, where the action
        // comes from the path segment and the server fills the rest from the API
        // key — so nothing is required. Publishing the old unconditional
        // `required` list would keep describing a shape the server has not
        // required since API keys shipped.
        if: { required: ["signature"] },
        then: {
          required: ["version", "agentId", "action", "idempotencyKey", "nonce", "signedAt", "body"],
        },
      },
    ],
  };
}

// ── Live-derived action matrix ────────────────────────────────────────────────

/** What an action does, in one line. Prose is the only hand-written part. */
const ACTION_SUMMARY: Record<AgentApiAction, string> = {
  register: "Create the registry record. Owner-signed, and the operator must also prove it controls its own wallet.",
  heartbeat: "Liveness signal and status read. Moves nothing.",
  proposeMarket: "Submit a market candidate for moderation. Moves nothing; the agent is not the market creator yet.",
  createMarket: "Open a market from the agent's own wallet. Funded: gated on byoa_funded_actions and the create_market pause switch.",
  publishReasoning: "Publish research output. Needs the researcher capability.",
  vote: "Vote as a council juror. Funded: gated on byoa_funded_actions and the stake pause switch.",
  stake: "Take a position. Funded: gated on byoa_funded_actions and the stake pause switch.",
  listPositions: "The agent's on-chain markets, read straight from the contract.",
  listEarnings: "Owner fees, unclaimed balance and x402 revenue, all in atomic USDC strings.",
  revoke: "Terminate the agent. Terminal and immediate: capabilities are cleared, and only a fresh registration restores service.",
  dryRun: "Simulate policy, fees and spendable balance for a planned action. Moves nothing.",
  issueKey: "Mint a bearer API key. Owner-signed; the key is returned once and only its SHA-256 is stored.",
  listKeys: "List key prefixes, labels and expiry. Never the key itself.",
  revokeKey: "Revoke a key immediately, ahead of any scheduled expiry.",
  rotateKey: "Issue a successor key and schedule the old one's expiry, so both work through the overlap window.",
  grantSpend: "Record the owner-signed USDC SAC allowance and period budget that funds a key. Owner-signed.",
  revokeSpend: "Stop drawing from a permission. The grant itself is withdrawn on chain by the owner.",
  spendStatus: "Remaining allowance, period window and the agent's limits, in atomic USDC strings.",
};

/** The capability an action needs, or null when it needs none. */
const ACTION_CAPABILITY: Partial<Record<AgentApiAction, AgentCapability>> = {
  proposeMarket: "market_creator",
  createMarket: "market_creator",
  dryRun: "market_creator",
  vote: "council_juror",
  stake: "council_juror",
  publishReasoning: "researcher",
};

/**
 * The credential an action is called with, from the live policy.
 *
 * `owner_signature` means a bearer key is refused outright (`requiresOwnerSignature`),
 * so publishing anything softer would document a control the server does not have.
 */
export type PublishedCredential = "owner_signature" | "operator_signature_or_api_key";

/**
 * The credentials the route accepts for an action.
 *
 * Exactly the route's own rule: `authenticateAgentRequest` refuses an API key for
 * an owner-signed action, and every other action takes either an owner/operator
 * signature or a key. No per-action exceptions, because an exception here is
 * exactly the kind of thing that goes stale.
 */
export function credentialFor(action: AgentApiAction): PublishedCredential {
  return requiresOwnerSignature(action) ? "owner_signature" : "operator_signature_or_api_key";
}

export interface PublishedAction {
  action: AgentApiAction;
  summary: string;
  credential: PublishedCredential;
  funded: boolean;
  feature?: string;
  pauseCapability?: Pausable;
  pauseEnvKey?: string;
  capability?: AgentCapability;
  /** Minimum authority level the capability needs, when the action needs one. */
  minimumAuthorityLevel?: number;
}

export function describeAction(action: AgentApiAction): PublishedAction {
  const funded = AGENT_FUNDED_ACTIONS.includes(action);
  const capability = ACTION_CAPABILITY[action];
  const pauseCapability = AGENT_ACTION_PAUSE[action];
  return {
    action,
    summary: ACTION_SUMMARY[action],
    credential: credentialFor(action),
    funded,
    ...(funded ? { feature: AGENT_FUNDED_FEATURE } : {}),
    ...(action === "register" ? { feature: AGENT_REGISTRY_FEATURE } : {}),
    ...(pauseCapability ? { pauseCapability, pauseEnvKey: pauseEnvKey(pauseCapability) } : {}),
    ...(capability ? { capability } : {}),
    ...(capability ? { minimumAuthorityLevel: capabilityMinimumAuthority(capability) } : {}),
  };
}

/**
 * A live-shaped registry record.
 *
 * The platform limits are `defaultLimits()` — the ceilings the server enforces
 * regardless of what any owner signs — so the published example shows the real
 * numbers rather than something flattering.
 */
function baseAgentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    schemaVersion: 1,
    agentId: "mimir-example-agent",
    ownerWallet: SYNTHETIC_WALLETS.owner,
    operatorWallet: SYNTHETIC_WALLETS.operator,
    payoutWallet: SYNTHETIC_WALLETS.payout,
    displayName: "Example agent",
    description: "Synthetic agent used by the published contract examples.",
    capabilities: ["council_juror", "researcher"],
    authorityLevel: AUTHORITY_LEVELS.STAKE,
    limits: defaultLimits(),
    status: "active",
    reputationBps: 0,
    createdAt: EXAMPLE_SIGNED_AT_MS,
    updatedAt: EXAMPLE_SIGNED_AT_MS,
    ...overrides,
  };
}

/**
 * A record for probing the authority gate.
 *
 * The limits are opened up rather than left at `defaultLimits()`: a probe that hit
 * the exposure or request ceilings would report "not allowed" for a reason that
 * has nothing to do with authority, and the published number would then be wrong
 * in a way that looks right.
 */
function probingAgent(overrides: Partial<AgentRecord>): AgentRecord {
  return baseAgentRecord({
    capabilities: [],
    authorityLevel: AUTHORITY_LEVELS.READ_ONLY,
    limits: {
      ...defaultLimits(),
      maxRequestsPerHour: 1_000_000,
      maxActiveMarkets: 1_000_000,
      maxDailyExposureAtomic: "1000000000000000",
      maxPositionAtomic: "1000000000000000",
    },
    ...overrides,
  });
}

/**
 * The minimum authority level each capability needs, read by ASKING the live gate.
 *
 * `lib/agents/registry.ts` keeps that table private, and copying it here is
 * exactly how a published number starts lying. So the level is found by running
 * `authorizeAction` at every level and taking the first that passes: whatever the
 * registry decides is what gets published, including a future change to it.
 */
export function capabilityMinimumAuthority(capability: AgentCapability): AuthorityLevel {
  for (let level = 0; level <= AUTHORITY_LEVELS.MONETISE; level += 1) {
    const agent = probingAgent({
      capabilities: [capability],
      authorityLevel: level as AuthorityLevel,
    });
    if (authorizeAction(agent, { capability, positionAtomic: "0" }).allowed) {
      return level as AuthorityLevel;
    }
  }
  // Unreachable while every capability has a minimum ≤ MONETISE; falling back to
  // the top level is the conservative answer if that ever stops being true.
  return AUTHORITY_LEVELS.MONETISE;
}

// ── Examples ──────────────────────────────────────────────────────────────────

/**
 * A signature the verifier will reject: real width, all zero bytes.
 *
 * Deliberately not a valid signature over anything. An example that carried a
 * working signature for a synthetic wallet would be a credential-shaped blob in a
 * committed file, and the audit would rightly refuse it.
 */
function placeholderSignature(): string {
  return PLACEHOLDER_SIGNATURE;
}

export interface PublishedExample {
  /** Key under the OpenAPI `examples` map; also the finding's locator. */
  name: string;
  /** What it demonstrates, in one line. */
  summary: string;
  action: AgentApiAction;
  /** `signed` needs a real envelope; `api_key` sends only the body. */
  credential: "signed" | "api_key";
  request: Record<string, unknown>;
  /** The exact bytes to sign, when there are any. */
  signingMessage?: string;
  /** Second signature `register` needs. */
  operatorProofMessage?: string;
  /** The live reason this example is refused, for the failure examples. */
  expectedRejection?: string;
  expectedStatus?: number;
  expectedErrorCode?: ApiErrorCode;
}

function signedEnvelope(args: {
  action: AgentApiAction;
  agentId?: string;
  body: unknown;
  idempotencyKey?: string;
  nonce?: string;
  signedAt?: number;
  signature?: string;
}): Record<string, unknown> {
  return {
    version: AGENT_API_VERSION,
    agentId: args.agentId ?? "mimir-example-agent",
    action: args.action,
    idempotencyKey: args.idempotencyKey ?? "example-idempotency-key-0001",
    nonce: args.nonce ?? "example-nonce-0001",
    signedAt: args.signedAt ?? EXAMPLE_SIGNED_AT_MS,
    body: args.body,
    signature: args.signature ?? placeholderSignature(),
  };
}

function registerBody(): Record<string, unknown> {
  return {
    ownerWallet: SYNTHETIC_WALLETS.owner,
    operatorWallet: SYNTHETIC_WALLETS.operator,
    payoutWallet: SYNTHETIC_WALLETS.payout,
    displayName: "Example agent",
    description: "Synthetic agent used by the published contract examples.",
    authorityLevel: AUTHORITY_LEVELS.STAKE,
    capabilities: ["council_juror", "researcher"],
    operatorSignature: placeholderSignature(),
  };
}

/**
 * Every published request example, built from the live modules.
 *
 * `signingMessage` is produced by the same `agentRequestMessage` the route
 * verifies against, so the published string cannot drift from what a caller has
 * to sign. `now` is the example's own `signedAt`, which keeps the positive
 * examples valid without the check depending on the wall clock.
 */
export function buildAgentRequestExamples(): PublishedExample[] {
  const register = signedEnvelope({ action: "register", body: registerBody(), idempotencyKey: "example-register-0001", nonce: "example-register-nonce-0001" });
  const heartbeat = signedEnvelope({ action: "heartbeat", body: {}, idempotencyKey: "example-heartbeat-0001", nonce: "example-heartbeat-nonce-0001" });
  const grantSpend = signedEnvelope({
    action: "grantSpend",
    idempotencyKey: "example-grantspend-0001",
    nonce: "example-grantspend-nonce-0001",
    body: {
      account: SYNTHETIC_WALLETS.owner,
      spender: SYNTHETIC_WALLETS.spender,
      token: SYNTHETIC_WALLETS.usdcSac,
      // Atomic USDC, 7 decimals, as a string: 25 USDC.
      allowance: "250000000",
      period: 86_400,
      start: EXAMPLE_START_AT_S,
      end: EXAMPLE_END_AT_S,
      salt: "1",
      signature: placeholderSignature(),
    },
  });
  const dryRunApiKey = {
    body: {
      principalUsdc: 25,
      grossPayoutUsdc: 50,
      stakeUsdc: 25,
      outcome: "creator_wins",
      platformFeeBps: 200,
      agentOwnerFeeBps: 50,
    },
  };

  return [
    {
      name: "signedRegister",
      summary: "Owner-signed registration with the operator's own proof. The first call an agent makes.",
      action: "register",
      credential: "signed",
      request: register,
      signingMessage: agentRequestMessage(register as unknown as Omit<SignedAgentRequest, "signature">),
      operatorProofMessage: operatorProofMessage("mimir-example-agent", SYNTHETIC_WALLETS.operator),
    },
    {
      name: "signedHeartbeat",
      summary: "Operator-signed liveness check: the smallest complete signed request.",
      action: "heartbeat",
      credential: "signed",
      request: heartbeat,
      signingMessage: agentRequestMessage(heartbeat as unknown as Omit<SignedAgentRequest, "signature">),
    },
    {
      name: "signedGrantSpend",
      summary: "Owner-signed spend permission: the USDC SAC allowance and period budget that funds a key.",
      action: "grantSpend",
      credential: "signed",
      request: grantSpend,
      signingMessage: agentRequestMessage(grantSpend as unknown as Omit<SignedAgentRequest, "signature">),
    },
    {
      name: "apiKeyDryRun",
      summary: "Bearer path: the body only, with `authorization: Bearer mk_…`. The server fills the envelope.",
      action: "dryRun",
      credential: "api_key",
      request: dryRunApiKey,
    },
    {
      name: "rejectedHexSignature",
      summary: "Pre-Stellar hex signature. Refused before any signature check runs.",
      action: "heartbeat",
      credential: "signed",
      request: signedEnvelope({
        action: "heartbeat", body: {}, nonce: "example-nonce-hexsig", idempotencyKey: "example-hexsig-0001",
        signature: "0xdeadbeef",
      }),
      expectedRejection: "invalid signature encoding",
      expectedStatus: 400,
      expectedErrorCode: "invalid_request",
    },
    {
      name: "rejectedStaleTimestamp",
      summary: "Envelope older than the 5-minute window. A fresh timestamp would work, so the envelope code is request_expired.",
      action: "heartbeat",
      credential: "signed",
      request: signedEnvelope({
        action: "heartbeat", body: {}, nonce: "example-nonce-stale", idempotencyKey: "example-stale-0001",
        signedAt: EXAMPLE_SIGNED_AT_MS - 6 * 60_000,
      }),
      expectedRejection: "signed timestamp outside allowed window",
      expectedStatus: 401,
      expectedErrorCode: "request_expired",
    },
  ];
}

// ── Response examples, built from the live handlers ───────────────────────────

function exampleAgentRecord(): Record<string, unknown> {
  return { agent: baseAgentRecord() };
}

export interface PublishedResponseExample {
  name: string;
  summary: string;
  status: number;
  /** `error` examples carry the live `error.code`; success examples do not. */
  code?: ApiErrorCode;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * Success bodies, each produced by the function the route calls.
 *
 * `buildAgentDryRun` runs the real fee split, so a change to
 * `lib/fees.ts` moves the published payout example instead of quietly leaving a
 * stale one behind — that is the drift this issue is about.
 */
export function buildAgentSuccessExamples(): PublishedResponseExample[] {
  return [
    {
      name: "registerAccepted",
      summary: "The stored registry record, with the limits the platform enforces regardless of what the owner signed.",
      status: 200,
      body: exampleAgentRecord(),
    },
    {
      name: "heartbeatOk",
      summary: "Liveness accepted.",
      status: 200,
      body: { agentId: "mimir-example-agent", status: "active", at: EXAMPLE_SIGNED_AT_MS },
    },
    {
      name: "dryRunSimulated",
      summary: "Policy verdict, spendable balance against the required stake, and the fee split, all in atomic USDC strings.",
      status: 200,
      body: buildAgentDryRun({
        principalUsdc: 25,
        grossPayoutUsdc: 50,
        outcome: "creator_wins",
        allowanceAtomic: usdcToUnits(30),
        requiredAtomic: usdcToUnits(25),
        platformFeeBps: 200,
        agentOwnerFeeBps: 50,
        platformRecipient: SYNTHETIC_WALLETS.owner,
        ownerRecipient: SYNTHETIC_WALLETS.payout,
        policy: { allowed: true },
      }),
    },
    {
      name: "issueKeyIssued",
      summary: "A bearer key, returned exactly once. There is no endpoint that can show it again.",
      status: 200,
      body: {
        apiKey: PLACEHOLDER_API_KEY,
        keyId: "00000000-0000-4000-8000-000000000000",
        prefix: PLACEHOLDER_API_KEY.slice(0, 14),
        label: "server",
        expiresAt: null,
        note: "Store this now — it is not recoverable.",
        usage: `Authorization: Bearer ${PLACEHOLDER_API_KEY.slice(0, 14)}...`,
      },
    },
    {
      name: "spendStatusActive",
      summary: "Remaining allowance in atomic USDC, the period window, and the platform limits that apply on top of it.",
      status: 200,
      body: {
        funded: true,
        permissionHash: "0000000000000000000000000000000000000000000000000000000000000000",
        account: SYNTHETIC_WALLETS.owner,
        allowanceAtomic: "250000000",
        spentThisPeriodAtomic: "0",
        remainingAtomic: "250000000",
        periodStart: EXAMPLE_START_AT_S,
        periodEndsAt: EXAMPLE_START_AT_S + 86_400,
        endAt: EXAMPLE_END_AT_S,
        limits: defaultLimits(),
      },
    },
  ];
}

/**
 * One error example per live error code, from `apiError()` itself.
 *
 * Messages are written for an autonomous client, not for a human reading prose,
 * which is the point: the code, the status and the `retryable` flag are the
 * contract. The `agent_paused` example carries the structured pause detail a
 * route attaches, with the capability and env key read from the live pause
 * registry.
 */
export function buildAgentErrorExamples(): PublishedResponseExample[] {
  const MESSAGES: Record<ApiErrorCode, string> = {
    invalid_request: "invalid JSON",
    invalid_signature: "signature rejected",
    unsupported_version: `unsupported version; only ${AGENT_API_VERSION} is served`,
    payload_too_large: `payload exceeds ${MAX_SIGNED_REQUEST_PAYLOAD_BYTES} bytes`,
    idempotency_conflict: "idempotency key was already used with a different body",
    unauthenticated: "API key revoked",
    nonce_reused: "signed agent envelope was already used; generate a fresh nonce",
    request_expired: "signed timestamp outside allowed window",
    forbidden: "register requires an owner signature, not an API key",
    capability_missing: "Missing capability market_creator",
    agent_revoked: "agent is revoked",
    agent_paused: "stake is temporarily paused",
    not_found: "agent not found",
    conflict: "agent already registered",
    rate_limited: "Rate limit exceeded",
    budget_exhausted: "period allowance exhausted; wait for the next period",
    upstream_unavailable: "dependency unavailable; retry later",
    internal_error: "internal error",
  };

  return apiErrorCatalogue().map((spec) => {
    // A zero retryAfter is not passed through: `apiError` would only set a header
    // when the wait is positive, and request_expired means "retry now, with a
    // fresh timestamp" — advertising a wait would be advice against it.
    const wait = spec.retryAfterSeconds !== undefined && spec.retryAfterSeconds > 0
      ? { retryAfterSeconds: spec.retryAfterSeconds } : {};
    const result = apiError(spec.code, MESSAGES[spec.code], wait);
    const body: Record<string, unknown> = { error: { ...result.body.error } };
    if (spec.code === "agent_paused") {
      // The pause registry augments this body with the switch that stopped the
      // action; both the capability and the env var that re-enables it come from
      // the live pause tables.
      const capability: Pausable = "stake";
      body.error = {
        ...(body.error as Record<string, unknown>),
        capability,
        viaGlobal: false,
        env: pauseEnvKey(capability),
      };
    }
    return {
      name: spec.code,
      summary: describeErrorCode(spec),
      status: spec.status,
      code: spec.code,
      body,
      ...(Object.keys(result.headers).length > 0 ? { headers: result.headers } : {}),
    };
  });
}

/**
 * What a caller should do about an error, from the live spec.
 *
 * Only facts the catalogue carries. The obvious temptation — "seen on heartbeat",
 * "seen on createMarket" — was cut: the envelope errors are action-independent, and
 * naming an action would invent a claim the code does not make.
 */
function describeErrorCode(spec: ApiErrorSpec): string {
  if (!spec.retryable) {
    return "Not retryable: repeating the identical request cannot succeed. A fresh nonce and timestamp will not help either.";
  }
  if (spec.retryAfterSeconds === undefined) {
    return "Retryable: a fresh attempt with a new nonce and timestamp can succeed.";
  }
  return `Retryable after ${spec.retryAfterSeconds}s; a fresh attempt with a new nonce and timestamp can succeed.`;
}

// ── The OpenAPI document ──────────────────────────────────────────────────────

const GENERATED_HEADER = [
  "GENERATED FILE — DO NOT EDIT BY HAND.",
  "",
  "Published contract for the Mimir agent API. Every machine-readable fact below is",
  "read from the module that enforces it (lib/agents/api.ts, lib/agents/authenticate.ts,",
  "lib/api/errors.ts, lib/ops/flags.ts, lib/agents/registry.ts, lib/agents/dry-run.ts), and",
  "every example is executed against the live validator before it is written.",
  "",
  "Regenerate:  npm run check:openapi -- --write",
  "Verify:      npm run check:openapi",
  "Why:         docs/AGENT_API_OPENAPI.md",
];

export function buildAgentOpenApiDocument(): YamlValue {
  const actions = AGENT_API_ACTIONS.map(describeAction);
  const requestExamples = buildAgentRequestExamples();
  const successExamples = buildAgentSuccessExamples();
  const errorExamples = buildAgentErrorExamples();

  // Group the live error catalogue by status: the response table must be keyed by
  // the status the server actually returns, not by a hand-written list.
  const byStatus = new Map<number, PublishedResponseExample[]>();
  for (const example of [...successExamples, ...errorExamples]) {
    const bucket = byStatus.get(example.status) ?? [];
    bucket.push(example);
    byStatus.set(example.status, bucket);
  }
  const responses: Record<string, YamlValue> = {};
  for (const status of [...byStatus.keys()].sort((a, b) => a - b)) {
    const bucket = byStatus.get(status)!;
    const isSuccess = status < 400;
    const examples: Record<string, YamlValue> = {};
    for (const example of bucket) {
      examples[example.name] = {
        summary: example.summary,
        ...(example.code ? { "x-mimir-error-code": example.code } : {}),
        // asYamlValue, not a cast: an example that cannot be represented must
        // stop the build rather than quietly lose a field on the way to YAML.
        value: asYamlValue(example.body, `$.responses.${status}.${example.name}.value`),
        ...(example.headers ? { "x-mimir-response-headers": asYamlValue(example.headers) } : {}),
      };
    }
    responses[String(status)] = {
      description: isSuccess ? "Accepted, simulated, or the stored response for a repeated idempotency key." : describeStatus(status),
      ...(isSuccess ? {} : { "x-mimir-error-codes": bucket.map((example) => example.code ?? "unknown") }),
      content: { "application/json": { examples } },
    };
  }

  const requestExampleMap: Record<string, YamlValue> = {};
  for (const example of requestExamples) {
    requestExampleMap[example.name] = {
      summary: example.summary,
      ...(example.credential === "api_key" ? { "x-mimir-credential": `authorization: Bearer ${PLACEHOLDER_API_KEY}` } : {}),
      ...(example.signingMessage ? { "x-mimir-signing-message": example.signingMessage } : {}),
      ...(example.operatorProofMessage ? { "x-mimir-operator-proof-message": example.operatorProofMessage } : {}),
      ...(example.expectedRejection ? { "x-mimir-expected-rejection": example.expectedRejection } : {}),
      value: asYamlValue(example.request, `$.requestBody.examples.${example.name}.value`),
    };
  }

  const actionMatrix: Record<string, YamlValue> = {};
  for (const action of actions) {
    actionMatrix[action.action] = {
      summary: action.summary,
      credential: action.credential,
      funded: action.funded,
      ...(action.feature ? { feature: action.feature } : {}),
      ...(action.pauseCapability ? { pauseCapability: action.pauseCapability, pauseEnvKey: action.pauseEnvKey } : {}),
      ...(action.capability ? { capability: action.capability, minimumAuthorityLevel: action.minimumAuthorityLevel } : {}),
      ...(action.funded ? { note: "Funded actions move owner USDC and are refused with 403 forbidden until the feature flag is on." } : {}),
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Mimir Agent API",
      version: AGENT_API_VERSION,
      summary: "One signed, idempotent endpoint for every BYOA agent action.",
      description: [
        `Mimir runs on Stellar Testnet (CAIP-2 \`stellar:testnet\`). Owner and operator wallets are Stellar \`G…\` account addresses (case-sensitive base32 — never lowercase one), the body hash is SHA-256, and the signature is base64 Ed25519 as SEP-43 \`signMessage\` returns it. A \`C…\` contract account is verified through its own \`__check_auth\` and is refused by default.`,
        "",
        "Two credentials, not interchangeable. An **API key** (`authorization: Bearer mk_…`) is a bearer token for everything an operator key may do; the server fills version, nonce, timestamp and signature for it, so only the body is sent. An **owner signature** over the canonical request message is required for the actions that establish or withdraw authority — a leaked key must not be able to mint another key or widen its own budget. Which is which per action is in `x-mimir-actions.<action>.credential`, generated from `lib/agents/authenticate.ts`.",
        "",
        `Every request must carry a single-use nonce and stay within ${AGENT_REQUEST_MAX_SKEW_MS / 60_000} minutes of the server clock, and its JSON body must stay under ${MAX_SIGNED_REQUEST_PAYLOAD_BYTES} bytes. A body over that cap is refused with 413 before parsing. Re-posting the same \`idempotencyKey\` returns the stored response instead of re-executing, so a client retry cannot double-spend.`,
      ].join("\n"),
      contact: { name: "Mimir", url: "https://mimir.example" },
      "x-mimir-generated-by": "npm run check:openapi -- --write",
      "x-mimir-envelope-version": AGENT_API_VERSION,
    },
    servers: [
      {
        url: SERVER_URL_PLACEHOLDER,
        description:
          "Placeholder, not a deployment. Substitute your own host; the audit then reports SERVER_URL_NOT_PLACEHOLDER as a warning.",
      },
    ],
    security: [{ bearerKey: [] }],
    paths: {
      "/api/agents/v1/{action}": {
        post: {
          operationId: "agentAction",
          summary: "Submit a signed, idempotent BYOA action",
          description: [
            "The action in the body must equal the `{action}` path segment; a mismatch is 400.",
            "",
            "Order of the gates, because it decides which error a caller sees: unknown action (404) → payload cap (413) → malformed JSON (400) → credential (401/403) → signature (401) → agent status (403) → funded feature flag (403) → incident pause (403) → idempotent replay (stored response) → nonce replay (401 nonce_reused).",
          ].join("\n"),
          parameters: [
            {
              name: "action",
              in: "path",
              required: true,
              description: "Live action list from `AGENT_API_ACTIONS`.",
              schema: { type: "string", enum: [...AGENT_API_ACTIONS] },
            },
            {
              name: "authorization",
              in: "header",
              required: false,
              description: `Bearer API key, \`Authorization: Bearer ${PLACEHOLDER_API_KEY.slice(0, 14)}…\`. Absent means the request must carry a signature. Present-but-unknown is 401, not a fall-through to signature checking.`,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: `../${SCHEMA_RELATIVE}` },
                examples: requestExampleMap,
              },
            },
          },
          responses,
          "x-mimir-actions": actionMatrix,
        },
      },
    },
    components: {
      securitySchemes: {
        bearerKey: {
          type: "apiKey",
          in: "header",
          name: "authorization",
          description:
            "Agent API key as `Bearer mk_…`. Only the SHA-256 of the key is stored; the key is returned once at issue and cannot be recovered.",
        },
      },
      schemas: {
        AgentError: {
          type: "object",
          description: "Every non-2xx body this endpoint returns. Built from `lib/api/errors.ts`.",
          required: ["error"],
          additionalProperties: false,
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "retryable"],
              properties: {
                code: {
                  type: "string",
                  enum: apiErrorCatalogue().map((spec) => spec.code),
                  description: "Stable machine code. Branch on this, never on the message.",
                },
                message: { type: "string", description: "Human-readable detail. Not a stable interface." },
                retryable: { type: "boolean", description: "False when repeating the identical request can never succeed." },
                retryAfterSeconds: { type: "number", description: "Present only when waiting can help." },
                field: { type: "string", description: "Field that caused a validation failure, when there is one." },
                capability: { type: "string", enum: [...PAUSABLE], description: "agent_paused only: the switch that stopped this action." },
                viaGlobal: { type: "boolean", description: "agent_paused only: true when MIMIR_PAUSE_ALL stopped it." },
                pausedAt: { type: "number", description: "agent_paused only, when the operator set a timestamp." },
                env: { type: "string", description: "agent_paused only: the env var that re-enables it." },
              },
            },
          },
        },
        AgentRecord: {
          type: "object",
          description: "The registry record, with the platform limits it is held to. Built from `lib/agents/registry.ts`.",
          required: ["agentId", "ownerWallet", "operatorWallet", "payoutWallet", "capabilities", "authorityLevel", "limits", "status"],
          properties: {
            agentId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{2,63}$" },
            ownerWallet: { type: "string", description: "`G…`. Receives owner fees; the only party that may rotate or revoke." },
            operatorWallet: { type: "string", description: "`G…` or `C…`. The hot key that signs day to day." },
            payoutWallet: { type: "string", description: "`G…` or `C…`. Where owner fees are paid. Defaults to the owner wallet." },
            capabilities: { type: "array", items: { type: "string" } },
            authorityLevel: { type: "integer", minimum: 0, maximum: 4, description: "0 READ_ONLY, 1 PROPOSE, 2 CREATE, 3 STAKE, 4 MONETISE." },
            limits: { type: "object", description: "Platform ceilings. An owner's permission cannot raise them." },
            status: { type: "string", enum: ["pending", "active", "paused", "revoked"] },
            reputationBps: { type: "integer", description: "Observational only. Never a source of authority." },
          },
        },
      },
    },
    "x-mimir-limits": {
      maxSignedPayloadBytes: MAX_SIGNED_REQUEST_PAYLOAD_BYTES,
      maxClockSkewMs: AGENT_REQUEST_MAX_SKEW_MS,
      maxIdempotencyKeyLength: 128,
      maxNonceLength: 128,
      defaultMaxRequestsPerHour: defaultLimits().maxRequestsPerHour,
      defaultMaxActiveMarkets: defaultLimits().maxActiveMarkets,
      defaultMaxDailyExposureUsdc: defaultLimits().maxDailyExposureUsdc,
      defaultMaxPositionUsdc: defaultLimits().maxPositionUsdc,
      usdcDecimals: 7,
    },
    "x-mimir-rollout": {
      registryFeature: { feature: AGENT_REGISTRY_FEATURE, env: `MIMIR_FEATURE_${AGENT_REGISTRY_FEATURE.toUpperCase()}`, defaultOn: true },
      fundedFeature: {
        feature: AGENT_FUNDED_FEATURE,
        env: `MIMIR_FEATURE_${AGENT_FUNDED_FEATURE.toUpperCase()}`,
        defaultOn: false,
        actions: [...AGENT_FUNDED_ACTIONS],
        note: "Off by default. While it is off, funded actions are refused with 403 forbidden; registration, reads and dry runs keep working.",
      },
      incidentSwitches: Object.fromEntries(
        (Object.entries(AGENT_ACTION_PAUSE) as [AgentApiAction, Pausable][]).map(([action, capability]) => [
          action, { capability, env: pauseEnvKey(capability) },
        ]),
      ),
    },
  };
}

function describeStatus(status: number): string {
  if (status === 400) return "Invalid envelope, unknown action, or a body the server refused to parse.";
  if (status === 401) return "Invalid signature, a replayed or expired envelope (nonce_reused, request_expired), or a bad API key.";
  if (status === 403) return "Capability, authority, budget, feature flag, revocation or incident pause rejected the action.";
  if (status === 404) return "No such agent, key or permission for this caller.";
  if (status === 409) return "Registration conflict, or an idempotency key reused with a different body.";
  if (status === 413) return `Signed payload over ${MAX_SIGNED_REQUEST_PAYLOAD_BYTES} bytes.`;
  if (status === 429) return "Rate limit or period allowance exhausted. Retryable, after the stated delay.";
  if (status === 500) return "Internal error. Retryable, after a short delay.";
  return "Upstream dependency unavailable. Retryable, after a short delay.";
}

// ── Rendering ─────────────────────────────────────────────────────────────────

export interface RenderedArtifact {
  relativePath: string;
  contents: string;
}

/** The OpenAPI document, rendered as the committed YAML artifact. */
export function renderOpenApiArtifact(): RenderedArtifact {
  return {
    relativePath: OPENAPI_RELATIVE,
    contents: toYaml(buildAgentOpenApiDocument(), { header: GENERATED_HEADER }),
  };
}

/** The request schema, rendered as the committed JSON artifact. */
export function renderSchemaArtifact(): RenderedArtifact {
  return {
    relativePath: SCHEMA_RELATIVE,
    contents: `${JSON.stringify(buildAgentApiJsonSchema(), null, 2)}\n`,
  };
}

export function renderArtifacts(): RenderedArtifact[] {
  return [renderSchemaArtifact(), renderOpenApiArtifact()];
}

export interface AgentApiArtifactCheck {
  audit: OpenApiAudit;
  /** Artifacts whose committed text differs from what the live code generates. */
  drifted: RenderedArtifact[];
  /** Committed text per relative path; absent when the file does not exist. */
  committed: Map<string, string | undefined>;
}

/**
 * The whole check: audit the generated document against the live code, and
 * compare the generated text with what is committed.
 *
 * Byte comparison is what makes the check trustworthy. There is no YAML parser in
 * this repo, so a check that parsed the file could only be as good as a parser
 * nobody audited; comparing text cannot be fooled by a hand edit, a stale enum or
 * a reordering — anything the generator did not produce is drift, and drift is a
 * failure. The audit then explains *why* the generated document differs from the
 * live route, which is the part a human has to act on.
 */
export function checkAgentApiArtifacts(read: (relativePath: string) => string | undefined): AgentApiArtifactCheck {
  const rendered = renderArtifacts();
  const doc = buildAgentOpenApiDocument();
  const schema = buildAgentApiJsonSchema();
  const committed = new Map<string, string | undefined>();
  const drifted: RenderedArtifact[] = [];
  for (const artifact of rendered) {
    const onDisk = read(artifact.relativePath);
    committed.set(artifact.relativePath, onDisk);
    if (onDisk !== artifact.contents) drifted.push(artifact);
  }
  const audit = auditAgentApiDocument({
    doc,
    schema,
    rendered: { doc: rendered[1]!.contents, schema: rendered[0]!.contents },
  });
  for (const artifact of drifted) {
    const onDisk = committed.get(artifact.relativePath);
    // The byte counts live in the finding itself, not in a second line the report
    // adds. A consumer that only ever sees `audit.findings` — a test, a future
    // JSON reporter — then carries the same information as the terminal output,
    // instead of less.
    const how = onDisk === undefined
      ? "the generated artifact is not committed"
      : `the committed artifact does not match the live code (committed ${onDisk.length} bytes, generated ${artifact.contents.length} bytes)`;
    audit.findings.push(finding(
      onDisk === undefined ? "ARTIFACT_MISSING" : "ARTIFACT_DRIFT",
      "error", artifact.relativePath,
      `${how}; run \`npm run check:openapi -- --write\` and review the diff`,
    ));
  }
  audit.ok = audit.findings.every((item) => item.severity !== "error");
  return { audit, drifted, committed };
}

/**
 * A privacy-safe report for the artifact check.
 *
 * Every finding, drift included, is already on the audit, so this is the audit's
 * own report rather than a second opinion about it.
 */
export function formatArtifactReport(check: AgentApiArtifactCheck): string {
  return formatOpenApiReport(check.audit);
}

// ── Audit ─────────────────────────────────────────────────────────────────────

function finding(
  code: OpenApiFindingCode,
  severity: OpenApiFinding["severity"],
  where: string,
  message: string,
): OpenApiFinding {
  return { code, severity, where, message };
}

/** The single operation this contract describes, or undefined if it is missing. */
function operationOf(doc: Record<string, unknown>): Record<string, unknown> | undefined {
  const paths = isPlainObject(doc.paths) ? doc.paths : undefined;
  const pathItem = paths ? paths["/api/agents/v1/{action}"] : undefined;
  const post = isPlainObject(pathItem) ? pathItem.post : undefined;
  return isPlainObject(post) ? post : undefined;
}

function actionEnumFromDoc(doc: Record<string, unknown>): string[] {
  const parameters = asArray(operationOf(doc)?.parameters);
  const actionParam = parameters.find((entry) => isPlainObject(entry) && entry.name === "action");
  const schema = isPlainObject(actionParam) ? actionParam.schema : undefined;
  return asArray(isPlainObject(schema) ? schema.enum : undefined).map(String);
}

function actionMatrixFromDoc(doc: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const matrix = operationOf(doc)?.["x-mimir-actions"];
  if (!isPlainObject(matrix)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [action, entry] of Object.entries(matrix)) {
    if (isPlainObject(entry)) out[action] = entry;
  }
  return out;
}

function jsonContentOf(content: unknown): Record<string, unknown> {
  if (!isPlainObject(content)) return {};
  const json = content["application/json"];
  return isPlainObject(json) ? json : {};
}

function requestExamplesFromDoc(doc: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const body = operationOf(doc)?.requestBody;
  const examples = isPlainObject(body) ? jsonContentOf(body.content).examples : undefined;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(isPlainObject(examples) ? examples : {})) {
    if (isPlainObject(entry)) out[name] = entry;
  }
  return out;
}

function responsesFromDoc(doc: Record<string, unknown>): Record<string, { examples: Record<string, Record<string, unknown>> }> {
  const responses = operationOf(doc)?.responses;
  const out: Record<string, { examples: Record<string, Record<string, unknown>> }> = {};
  for (const [status, entry] of Object.entries(isPlainObject(responses) ? responses : {})) {
    if (!isPlainObject(entry)) continue;
    const examples = jsonContentOf(entry.content).examples;
    const parsed: Record<string, Record<string, unknown>> = {};
    for (const [name, value] of Object.entries(isPlainObject(examples) ? examples : {})) {
      if (isPlainObject(value)) parsed[name] = value;
    }
    out[status] = { examples: parsed };
  }
  return out;
}

function walkStrings(value: unknown, path: string, visit: (text: string, path: string) => void): void {
  if (typeof value === "string") {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${path}[${index}]`, visit));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      walkStrings(item, `${path}.${key}`, visit);
    }
  }
}

/** Credential-shaped tokens that must never reach a committed document. */
const WALLET_SHAPES = [/\bG[A-Z2-7]{55}\b/g, /\bC[A-Z2-7]{55}\b/g];

/**
 * Whether every address-shaped run in a string is one of the synthetic ones.
 *
 * True for a string with no address in it at all, so it can be used as a negative
 * test: "this string mentions a wallet, and it is not ours".
 */
function isSyntheticOnly(text: string): boolean {
  for (const shape of WALLET_SHAPES) {
    for (const match of text.matchAll(shape)) {
      if (!SYNTHETIC_WALLET_VALUES.includes(match[0])) return false;
    }
  }
  return true;
}

/** The first credential-shaped run in `text` that is not a published placeholder. */export function unallowedSecretIn(text: string): { label: string; offset: number } | undefined {
  for (const { label, pattern } of SECRET_SHAPES) {
    for (const match of text.matchAll(pattern)) {
      // The published placeholders are credential-shaped on purpose: an example
      // has to look like what a caller will send. They are the only such strings
      // allowed to appear, and each is a fixed constant above.
      if (ALLOWED_TOKENS.includes(match[0])) continue;
      return { label, offset: match.index };
    }
  }
  return undefined;
}

/**
 * The safety net for the published text: no credential may appear in it.
 *
 * A finding names the label and the offset, never the matched value — a check
 * that printed the secret it found would be a second copy of it.
 */
export function auditPublishedText(text: string, where: string): OpenApiFinding[] {
  const findings: OpenApiFinding[] = [];
  const secret = unallowedSecretIn(text);
  if (secret) {
    findings.push(finding(
      "SECRET_MATERIAL_IN_DOCS", "error", where,
      `document contains ${secret.label}-shaped text at offset ${secret.offset}; remove it and rotate the credential. The value is not printed.`,
    ));
  }
  for (const shape of WALLET_SHAPES) {
    for (const match of text.matchAll(shape)) {
      if (!SYNTHETIC_WALLET_VALUES.includes(match[0])) {
        findings.push(finding(
          "PLACEHOLDER_WALLET_UNKNOWN", "error", where,
          `document names a wallet at offset ${match.index} that is not one of the synthetic placeholders derived from "mimir-openapi-example/*". Use SYNTHETIC_WALLETS. The address is not printed.`,
        ));
        break;
      }
    }
  }
  return findings;
}

/**
 * The synthetic placeholders must be real strkeys.
 *
 * An example carrying a malformed address teaches the wrong shape, and the strict
 * parts of the stack (StrKey, the SAC allowance check) would reject a caller's
 * first real request because of our documentation. Checked at generation time so
 * the file cannot be written with a bad one.
 */
export function auditSyntheticWallets(): OpenApiFinding[] {
  const findings: OpenApiFinding[] = [];
  for (const [role, address] of Object.entries(SYNTHETIC_WALLETS)) {
    const valid = address.startsWith("C")
      ? isContractAddress(address)
      : isStellarAccount(address);
    if (!valid) {
      findings.push(finding(
        "PLACEHOLDER_WALLET_MALFORMED", "error", "lib/ops/agent-api-openapi.ts",
        `the synthetic "${role}" placeholder is not a valid Stellar strkey; re-derive it with the command in the module header`,
      ));
    }
  }
  return findings;
}

/**
 * Run the subset validator and turn anything it throws into a finding.
 *
 * The validator throws on a schema it does not understand, which is the right
 * behaviour for a build. Inside an audit it would otherwise abort the whole report
 * after the first bad example and hide every other finding, so the throw becomes
 * a finding and the scan continues.
 */
function verifyExampleAgainstSchema(
  schema: unknown,
  request: unknown,
  where: string,
): { ok: boolean; message: string } {
  try {
    const verdict = validateAgainstSchema(schema, request, where);
    if (verdict.ok) return { ok: true, message: "" };
    return {
      ok: false,
      message: `published example does not match ${SCHEMA_RELATIVE}: ${verdict.errors.slice(0, 3).join("; ")}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `the schema could not be checked, so no example is verified against it: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Compare a document against the live code.
 *
 * This is the function that makes the published contract trustworthy: it is
 * deliberately independent of the builder, so a bug in the builder cannot quietly
 * mark its own output as correct. Every finding is a place where the document and
 * the code disagree, or where the document contains something it must not.
 */
export function auditAgentApiDocument(input: {
  doc: unknown;
  schema: unknown;
  /** Text of both artifacts, for the secret scan. */
  rendered?: { doc: string; schema: string };
}): OpenApiAudit {
  const findings: OpenApiFinding[] = [];
  const { doc, schema } = input;

  if (!isPlainObject(doc)) {
    return { ok: false, findings: [finding("DOC_MISSING_PATH", "error", OPENAPI_RELATIVE, "the document root is not an object")] };
  }

  // ── Structure ───────────────────────────────────────────────────────────────
  const post = operationOf(doc);
  if (!post) {
    findings.push(finding("DOC_MISSING_PATH", "error", "$.paths./api/agents/v1/{action}.post", "the agent action operation is missing from the published document"));
  }
  const requestBody = isPlainObject(post?.requestBody) ? post.requestBody : undefined;
  const requestSchema = isPlainObject(requestBody) ? jsonContentOf(requestBody.content).schema : undefined;
  const schemaRef = isPlainObject(requestSchema) ? requestSchema.$ref : undefined;
  if (schemaRef !== `../${SCHEMA_RELATIVE}`) {
    findings.push(finding(
      "DOC_MISSING_SCHEMA_REF", "error", "$.paths./api/agents/v1/{action}.post.requestBody",
      `the request body must $ref ../${SCHEMA_RELATIVE}; found ${String(schemaRef ?? "nothing")}`,
    ));
  }

  const serverUrl = asArray(doc.servers)[0];
  const serverValue = isPlainObject(serverUrl) ? str(serverUrl.url) : undefined;
  if (serverValue !== undefined && serverValue !== SERVER_URL_PLACEHOLDER) {
    findings.push(finding(
      "SERVER_URL_NOT_PLACEHOLDER", "warning", "$.servers[0].url",
      "the published document names a real host; the generated artifact uses the documented placeholder. Substitute it only in your own copy of the contract.",
    ));
  }

  // ── Actions ─────────────────────────────────────────────────────────────────
  const documentedActions = actionEnumFromDoc(doc);
  const matrix = actionMatrixFromDoc(doc);
  if (Object.keys(matrix).length === 0) {
    findings.push(finding(
      "DOC_MISSING_ACTION_MATRIX", "error", "$.paths./api/agents/v1/{action}.post.x-mimir-actions",
      "the per-action matrix is missing, so credential, funding and pause facts are undocumented",
    ));
  }
  for (const action of AGENT_API_ACTIONS) {
    if (!documentedActions.includes(action)) {
      findings.push(finding("ACTION_UNDOCUMENTED", "error", "$.paths./api/agents/v1/{action}.post.parameters[action].schema.enum", `live action "${action}" is not in the published action enum`));
    }
    const entry = matrix[action];
    const live = describeAction(action);
    if (!entry) {
      findings.push(finding("DOC_MISSING_ACTION_MATRIX", "error", "$.paths./api/agents/v1/{action}.post.x-mimir-actions", `live action "${action}" has no published entry`));
      continue;
    }
    if (str(entry.credential) !== live.credential) {
      findings.push(finding("CREDENTIAL_DRIFT", "error", `$.paths./api/agents/v1/{action}.post.x-mimir-actions.${action}.credential`, `published credential "${String(entry.credential)}" is not what lib/agents/authenticate.ts enforces ("${live.credential}")`));
    }
    if (entry.funded !== live.funded) {
      findings.push(finding("FUNDED_GATE_DRIFT", "error", `$.paths./api/agents/v1/{action}.post.x-mimir-actions.${action}.funded`, `published funded=${String(entry.funded)} but the live gate is ${String(live.funded)}`));
    }
    if (live.funded && str(entry.feature) !== live.feature) {
      findings.push(finding("FUNDED_GATE_DRIFT", "error", `$.paths./api/agents/v1/{action}.post.x-mimir-actions.${action}.feature`, `a funded action must publish its rollout flag ("${String(live.feature)}")`));
    }
    if (str(entry.pauseCapability ?? undefined) !== (live.pauseCapability ?? undefined)) {
      findings.push(finding("PAUSE_SWITCH_DRIFT", "error", `$.paths./api/agents/v1/{action}.post.x-mimir-actions.${action}.pauseCapability`, `published incident switch "${String(entry.pauseCapability ?? "none")}" is not the live one ("${live.pauseCapability ?? "none"}")`));
    }
    if (live.pauseCapability && !(PAUSABLE as readonly string[]).includes(live.pauseCapability)) {
      findings.push(finding("PAUSE_CAPABILITY_UNKNOWN", "error", "lib/ops/flags.ts", `action "${action}" names pause capability "${live.pauseCapability}", which is not pausable`));
    }
    // The env var is the second half of the same control: an operator reaching
    // for the kill switch has to be told the name that actually works.
    if (live.pauseCapability && str(entry.pauseEnvKey) !== live.pauseEnvKey) {
      findings.push(finding("PAUSE_SWITCH_DRIFT", "error", `$.paths./api/agents/v1/{action}.post.x-mimir-actions.${action}.pauseEnvKey`, `published env var "${String(entry.pauseEnvKey ?? "none")}" is not the one lib/ops/flags.ts reads ("${live.pauseEnvKey}")`));
    }
    if (str(entry.capability ?? undefined) !== (live.capability ?? undefined)) {
      findings.push(finding("ACTION_CAPABILITY_DRIFT", "error", `$.paths./api/agents/v1/{action}.post.x-mimir-actions.${action}.capability`, `published capability "${String(entry.capability ?? "none")}" is not the live one ("${live.capability ?? "none"}")`));
    }
    // An understated minimum authority is the dangerous direction: a caller
    // would believe a level is enough when the registry will refuse it.
    if (entry.minimumAuthorityLevel !== live.minimumAuthorityLevel) {
      findings.push(finding("ACTION_CAPABILITY_DRIFT", "error", `$.paths./api/agents/v1/{action}.post.x-mimir-actions.${action}.minimumAuthorityLevel`, `published minimumAuthorityLevel ${String(entry.minimumAuthorityLevel)} is not the level the registry enforces (${String(live.minimumAuthorityLevel)})`));
    }
  }
  for (const action of documentedActions) {
    if (!(AGENT_API_ACTIONS as readonly string[]).includes(action)) {
      findings.push(finding("ACTION_UNKNOWN", "error", "$.paths./api/agents/v1/{action}.post.parameters[action].schema.enum", `the document publishes action "${action}", which the live route does not serve`));
    }
  }

  // ── Schema ──────────────────────────────────────────────────────────────────
  // Checked once, up front: if the schema uses something the subset validator does
  // not implement, every example is unverified and the per-example check below
  // would report the same root cause a dozen times.
  let schemaIsCheckable = true;
  try {
    assertSupportedKeywords(schema);
  } catch (error) {
    schemaIsCheckable = false;
    findings.push(finding(
      "DOC_SCHEMA_UNSUPPORTED", "error", SCHEMA_RELATIVE,
      `the published schema uses something the local validator does not implement, so no example can be verified against it: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
  if (!isPlainObject(schema)) {
    findings.push(finding("DOC_MISSING_SCHEMA_REF", "error", SCHEMA_RELATIVE, "the published schema is not an object"));
  } else {
    const schemaProperties = isPlainObject(schema.properties) ? schema.properties : {};
    const schemaAction = isPlainObject(schemaProperties.action) ? schemaProperties.action.enum : undefined;
    const liveActions: readonly string[] = AGENT_API_ACTIONS;
    const publishedActions = asArray(schemaAction).map(String);
    for (const action of liveActions) {
      if (!publishedActions.includes(action)) {
        findings.push(finding("ACTION_UNDOCUMENTED_IN_SCHEMA", "error", `${SCHEMA_RELATIVE}#/properties/action/enum`, `live action "${action}" is missing from the published schema's action enum`));
      }
    }
    for (const action of publishedActions) {
      if (!liveActions.includes(action)) {
        findings.push(finding("ACTION_UNKNOWN", "error", `${SCHEMA_RELATIVE}#/properties/action/enum`, `the published schema allows action "${action}", which the live route does not serve`));
      }
    }
    if (schema.additionalProperties !== false) {
      findings.push(finding("SCHEMA_ACTION_DRIFT", "error", `${SCHEMA_RELATIVE}#/additionalProperties`, "the envelope schema must refuse unknown properties so a typo'd field is an error rather than a silent drop"));
    }
  }

  // ── Limits ──────────────────────────────────────────────────────────────────
  const limits = isPlainObject(doc["x-mimir-limits"]) ? doc["x-mimir-limits"] : {};
  const liveLimits: Record<string, number> = {
    maxSignedPayloadBytes: MAX_SIGNED_REQUEST_PAYLOAD_BYTES,
    maxClockSkewMs: AGENT_REQUEST_MAX_SKEW_MS,
    defaultMaxRequestsPerHour: defaultLimits().maxRequestsPerHour,
    defaultMaxActiveMarkets: defaultLimits().maxActiveMarkets,
    defaultMaxDailyExposureUsdc: defaultLimits().maxDailyExposureUsdc,
    defaultMaxPositionUsdc: defaultLimits().maxPositionUsdc,
  };
  for (const [key, value] of Object.entries(liveLimits)) {
    if (limits[key] !== value) {
      findings.push(finding("LIMIT_DRIFT", "error", `$.x-mimir-limits.${key}`, `published limit ${key}=${String(limits[key])} is not the live value ${value}`));
    }
  }

  // ── Error examples ──────────────────────────────────────────────────────────
  const responses = responsesFromDoc(doc);
  const catalogue = apiErrorCatalogue();
  const publishedCodes = new Set<string>();
  for (const [statusKey, response] of Object.entries(responses)) {
    const status = Number(statusKey);
    for (const [name, example] of Object.entries(response.examples)) {
      const code = str(example["x-mimir-error-code"]);
      if (!code) continue;
      publishedCodes.add(code);
      const spec = catalogue.find((entry) => entry.code === code);
      if (!spec) {
        findings.push(finding("ERROR_CODE_UNKNOWN", "error", `$.paths./api/agents/v1/{action}.post.responses.${statusKey}.${name}`, `the document documents error code "${code}", which lib/api/errors.ts does not define`));
        continue;
      }
      if (spec.status !== status) {
        findings.push(finding("ERROR_STATUS_DRIFT", "error", `$.paths./api/agents/v1/{action}.post.responses.${statusKey}.${name}`, `code "${code}" is published under ${statusKey} but the server returns ${spec.status}`));
      }
      const body = example.value;
      const error = isPlainObject(body) && isPlainObject(body.error) ? body.error : undefined;
      if (!error) {
        findings.push(finding("EXAMPLE_MISSING", "error", `$.paths./api/agents/v1/{action}.post.responses.${statusKey}.${name}`, `error example "${name}" has no error object`));
        continue;
      }
      if (str(error.code) !== code) {
        findings.push(finding("ERROR_CODE_UNKNOWN", "error", `$.paths./api/agents/v1/{action}.post.responses.${statusKey}.${name}`, `error body code does not match the example's declared code`));
      }
      if (error.retryable !== spec.retryable) {
        findings.push(finding("ERROR_RETRYABLE_DRIFT", "error", `$.paths./api/agents/v1/{action}.post.responses.${statusKey}.${name}`, `code "${code}" is published with retryable=${String(error.retryable)} but the server sends ${String(spec.retryable)}`));
      }
    }
  }
  for (const spec of catalogue) {
    if (!publishedCodes.has(spec.code)) {
      findings.push(finding("ERROR_CODE_UNDOCUMENTED", "error", "$.paths./api/agents/v1/{action}.post.responses", `live error code "${spec.code}" (${spec.status}) has no published example`));
    }
  }

  // ── Request examples ────────────────────────────────────────────────────────
  const docExamples = requestExamplesFromDoc(doc);
  const liveExamples = buildAgentRequestExamples();
  for (const example of liveExamples) {
    const published = docExamples[example.name];
    if (!published) {
      findings.push(finding("EXAMPLE_MISSING", "error", `$.paths./api/agents/v1/{action}.post.requestBody.examples.${example.name}`, `published example "${example.name}" is missing from the document`));
      continue;
    }
    const request = isPlainObject(published.value) ? published.value : {};
    if (example.expectedRejection) {
      // Negative examples must still be refused, and for the same live reason.
      // They are deliberately not schema-checked: they exist to be refused, and
      // the hex-signature one violates the published pattern on purpose.
      // `now` is the real clock here, not the example's own signedAt — a stale
      // timestamp is only stale relative to now. The published signedAt is fixed
      // and in the past, so this stays stale for good.
      const errors = validateAgentRequestEnvelope(request as unknown as SignedAgentRequest, Date.now());
      if (!errors.join("; ").includes(example.expectedRejection)) {
        findings.push(finding("EXAMPLE_REJECTION_DRIFT", "error", `$.paths./api/agents/v1/{action}.post.requestBody.examples.${example.name}`, `example "${example.name}" is documented as refused with "${example.expectedRejection}" but the live validator now reports "${errors.join("; ") || "no error"}"`));
      }
      continue;
    }
    if (example.credential === "api_key") {
      // Mirror the route's API-key branch exactly: the key supplies agentId, the
      // path segment supplies the action, and the server fills version, nonce,
      // timestamp and signature. Validating the *raw* example would report
      // failures for fields the client is not asked to send.
      const errors = validateAgentRequestEnvelope({
        version: AGENT_API_VERSION,
        action: example.action,
        agentId: "mimir-example-agent",
        idempotencyKey: "api-key-path-0001",
        nonce: "api-key-path-nonce-0001",
        signedAt: EXAMPLE_SIGNED_AT_MS,
        signature: "",
        body: request.body ?? {},
      } as SignedAgentRequest, EXAMPLE_SIGNED_AT_MS, { requireSignature: false });
      if (errors.length > 0) {
        findings.push(finding("EXAMPLE_ENVELOPE_REJECTED", "error", `$.paths./api/agents/v1/{action}.post.requestBody.examples.${example.name}`, `published example "${example.name}" is refused by the live validator: ${errors.join("; ")}`));
      }
    } else {
      // `now` is the example's own signedAt: a published example is judged on its
      // own terms, so the check never depends on the wall clock.
      const errors = validateAgentRequestEnvelope(request as unknown as SignedAgentRequest, request.signedAt as number);
      if (errors.length > 0) {
        findings.push(finding("EXAMPLE_ENVELOPE_REJECTED", "error", `$.paths./api/agents/v1/{action}.post.requestBody.examples.${example.name}`, `published example "${example.name}" is refused by the live validator: ${errors.join("; ")}`));
      }
      if (example.signingMessage && str(published["x-mimir-signing-message"]) !== example.signingMessage) {
        findings.push(finding("SIGNING_MESSAGE_DRIFT", "error", `$.paths./api/agents/v1/{action}.post.requestBody.examples.${example.name}.x-mimir-signing-message`, `the published signing message is not what agentRequestMessage() produces`));
      }
      if (example.operatorProofMessage && str(published["x-mimir-operator-proof-message"]) !== example.operatorProofMessage) {
        findings.push(finding("SIGNING_MESSAGE_DRIFT", "error", `$.paths./api/agents/v1/{action}.post.requestBody.examples.${example.name}.x-mimir-operator-proof-message`, `the published operator proof is not what operatorProofMessage() produces`));
      }
    }
    // The example must also satisfy the schema the document points at.
    if (!schemaIsCheckable) continue;
    const verdict = verifyExampleAgainstSchema(schema, request, `$.${example.name}`);
    if (!verdict.ok) {
      findings.push(finding("EXAMPLE_SCHEMA_REJECTED", "error", `$.paths./api/agents/v1/{action}.post.requestBody.examples.${example.name}`, verdict.message));
    }
  }
  for (const name of Object.keys(docExamples)) {
    if (!liveExamples.some((example) => example.name === name)) {
      findings.push(finding("EXAMPLE_MISSING", "error", `$.paths./api/agents/v1/{action}.post.requestBody.examples.${name}`, `the document publishes example "${name}", which the builder does not produce`));
    }
  }

  // ── Safety ──────────────────────────────────────────────────────────────────
  findings.push(...auditSyntheticWallets());
  if (input.rendered) {
    findings.push(...auditPublishedText(input.rendered.schema, SCHEMA_RELATIVE));
    findings.push(...auditPublishedText(input.rendered.doc, OPENAPI_RELATIVE));
  }
  walkStrings(doc, "$", (text, path) => {
    // Strings are scanned, not just whole documents: the API-key hint is one
    // string ("authorization: Bearer …"), so the credential is inside it. A
    // 14-character key prefix is not a credential — the server compares the whole
    // key — so only a full key is worth refusing, and the published placeholders
    // are the only ones allowed.
    if (unallowedSecretIn(text)) {
      findings.push(finding("SECRET_MATERIAL_IN_DOCS", "error", path, "a credential appears in the document that is not a published placeholder; never commit a real key"));
    }
    // Walks are checked here as well as in the rendered text, so a hand-edited
    // document object is caught by the same rule as a hand-edited file.
    if (WALLET_SHAPES.some((shape) => new RegExp(shape).test(text)) && !isSyntheticOnly(text)) {
      findings.push(finding(
        "PLACEHOLDER_WALLET_UNKNOWN", "error", path,
        "this string names a wallet that is not one of the synthetic placeholders derived from \"mimir-openapi-example/*\". Use SYNTHETIC_WALLETS. The address is not printed.",
      ));
    }
  });

  const ok = findings.every((item) => item.severity !== "error");
  return { ok, findings };
}

/** A privacy-safe report: codes, locations and reasons, never values. */
export function formatOpenApiReport(audit: OpenApiAudit): string {
  const errors = audit.findings.filter((item) => item.severity === "error");
  const warnings = audit.findings.filter((item) => item.severity === "warning");
  const lines = [`agent API contract: ${audit.ok ? "OK" : `FAILED (${errors.length} error(s), ${warnings.length} warning(s))`}`];
  for (const item of audit.findings) {
    lines.push(`  ${item.severity === "error" ? "✗" : "!"} ${item.code} at ${item.where}: ${item.message}`);
  }
  if (audit.ok && warnings.length === 0) {
    lines.push(`  · ${AGENT_API_ACTIONS.length} actions, ${apiErrorCatalogue().length} error codes, ${buildAgentRequestExamples().length} request examples, all derived from live code`);
  }
  return lines.join("\n");
}
