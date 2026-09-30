/**
 * The published agent API contract must be the live one.
 *
 * Two things are under test. First, that the generated artifacts on disk are
 * exactly what the live code produces — the check that would have caught the
 * 11-of-18 action list and the 409-for-nonce-replay mistake before they shipped.
 * Second, that the audit *fails* for each way a document can drift, because an
 * audit that cannot fail is documentation.
 *
 * Nothing here reads the environment, the database or the network: the artifacts
 * are derived from modules, and the examples use synthetic addresses.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_API_ACTIONS, AGENT_FUNDED_ACTIONS } from "../../lib/agents/api";
import { apiErrorCatalogue } from "../../lib/api/errors";
import {
  buildAgentApiJsonSchema,
  buildAgentOpenApiDocument,
  buildAgentRequestExamples,
  checkAgentApiArtifacts,
  describeAction,
  formatArtifactReport,
  renderArtifacts,
  SYNTHETIC_WALLETS,
  auditAgentApiDocument,
  type OpenApiAudit,
} from "../../lib/ops/agent-api-openapi";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = path.join(REPO_ROOT, "tests", "fixtures", "agent-openapi");

/** A deep clone that is enough for JSON-shaped documents. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function auditWith(mutate: (doc: Record<string, unknown>, schema: Record<string, unknown>) => void): OpenApiAudit {
  const doc = clone(buildAgentOpenApiDocument()) as Record<string, unknown>;
  const schema = clone(buildAgentApiJsonSchema());
  mutate(doc, schema);
  const rendered = renderArtifacts();
  return auditAgentApiDocument({
    doc,
    schema,
    rendered: { doc: rendered[1]!.contents, schema: rendered[0]!.contents },
  });
}

function codes(audit: OpenApiAudit): string[] {
  return audit.findings.map((item) => item.code);
}

/** A typed view of the generated document, so tests can index it without `any`. */
type Example = Record<string, unknown>;
type ExampleMap = Record<string, Example>;

function requestExamplesOf(doc: Record<string, unknown>): ExampleMap {
  const content = (operation(doc).requestBody as Example).content as Record<string, ExampleMap>;
  return content["application/json"]!.examples as ExampleMap;
}

function responseExamplesOf(doc: Record<string, unknown>, status: string): ExampleMap {
  const responses = operation(doc).responses as Record<string, Record<string, unknown>>;
  const content = responses[status]!.content as Record<string, ExampleMap>;
  return content["application/json"]!.examples as ExampleMap;
}

/** The operation, typed just enough to mutate for a drift test. */
function operation(doc: Record<string, unknown>): Record<string, unknown> {
  return (doc.paths as Record<string, Record<string, Record<string, unknown>>>)["/api/agents/v1/{action}"].post;
}

function actionMatrix(doc: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return operation(doc)["x-mimir-actions"] as Record<string, Record<string, unknown>>;
}

// ── The generated document matches the live code ─────────────────────────────

test("the generated document audits clean", () => {
  const rendered = renderArtifacts();
  const audit = auditAgentApiDocument({
    doc: buildAgentOpenApiDocument(),
    schema: buildAgentApiJsonSchema(),
    rendered: { doc: rendered[1]!.contents, schema: rendered[0]!.contents },
  });
  assert.deepEqual(audit.findings, []);
  assert.equal(audit.ok, true);
});

test("the committed artifacts are what the live code generates", () => {
  // The regression this whole change exists for: a hand-edited document that no
  // longer matched the route. Read from disk, not from the builder.
  const check = checkAgentApiArtifacts((relativePath) => {
    const absolute = path.join(REPO_ROOT, relativePath);
    try {
      return readFileSync(absolute, "utf8");
    } catch {
      return undefined;
    }
  });
  assert.deepEqual(
    check.drifted.map((artifact) => artifact.relativePath),
    [],
    `committed artifacts are stale: ${formatArtifactReport(check)}`,
  );
  assert.equal(check.audit.ok, true, formatArtifactReport(check));
});

test("generation is deterministic", () => {
  assert.deepEqual(renderArtifacts(), renderArtifacts());
});

test("every live action is documented, and nothing else is", () => {
  const matrix = actionMatrix(clone(buildAgentOpenApiDocument()) as Record<string, unknown>);
  assert.deepEqual(Object.keys(matrix), [...AGENT_API_ACTIONS]);
  const schema = buildAgentApiJsonSchema();
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties.action!.enum, [...AGENT_API_ACTIONS]);
  assert.ok(AGENT_API_ACTIONS.length > 11, "the live action list grew; keep the fixtures honest");
});

test("the funded-action set is the live one, not a copy", () => {
  for (const action of AGENT_FUNDED_ACTIONS) {
    assert.equal(describeAction(action).funded, true, `${action} is funded in AGENT_FUNDED_ACTIONS`);
    assert.equal(describeAction(action).feature, "byoa_funded_actions");
  }
  for (const action of AGENT_API_ACTIONS) {
    const funded = AGENT_FUNDED_ACTIONS.includes(action);
    assert.equal(describeAction(action).funded, funded, `${action} funded flag`);
  }
});

test("every live error code has an example at its own status", () => {
  const doc = clone(buildAgentOpenApiDocument()) as Record<string, unknown>;
  const responses = operation(doc).responses as Record<string, Record<string, unknown>>;
  const published = new Map<string, string>();
  for (const [status] of Object.entries(responses)) {
    if (Number(status) < 400) continue; // 200 holds the success examples
    for (const name of Object.keys(responseExamplesOf(doc, status))) published.set(name, status);
  }
  for (const spec of apiErrorCatalogue()) {
    assert.equal(published.get(spec.code), String(spec.status), `${spec.code} status`);
  }
  assert.equal(published.size, apiErrorCatalogue().length);
});

test("nonce replay is published as 401, because that is what the server sends", () => {
  // The stale committed document claimed 409 here. If this ever changes, the
  // audit's ERROR_STATUS_DRIFT is what should catch it — not a reader's guess.
  const spec = apiErrorCatalogue().find((entry) => entry.code === "nonce_reused");
  assert.equal(spec?.status, 401);
  const doc = clone(buildAgentOpenApiDocument()) as Record<string, unknown>;
  assert.ok(responseExamplesOf(doc, "401").nonce_reused);
});

test("the published signing messages are the ones the server verifies", () => {
  const examples = requestExamplesOf(clone(buildAgentOpenApiDocument()) as Record<string, unknown>);
  for (const example of buildAgentRequestExamples()) {
    if (!example.signingMessage) continue;
    assert.equal(examples[example.name]!["x-mimir-signing-message"], example.signingMessage);
  }
});

test("the negative examples are refused for the stated reason", () => {
  const negatives = buildAgentRequestExamples().filter((example) => example.expectedRejection);
  assert.ok(negatives.length >= 2, "keep at least one envelope example that must fail");
  for (const example of negatives) {
    assert.equal(example.expectedStatus !== undefined, true);
    assert.equal(example.expectedErrorCode !== undefined, true);
  }
});

test("the API-key example sends no signature, because the server fills it", () => {
  const example = buildAgentRequestExamples().find((entry) => entry.credential === "api_key");
  assert.ok(example);
  assert.deepEqual(Object.keys(example.request).sort(), ["body"]);
});

test("the generated artifacts contain no credential and no unknown wallet", () => {
  for (const artifact of renderArtifacts()) {
    assert.equal(/S[A-Z2-7]{55}/.test(artifact.contents), false, "secret-seed shaped text");
    for (const address of artifact.contents.match(/[GC][A-Z2-7]{55}/g) ?? []) {
      assert.ok(
        (Object.values(SYNTHETIC_WALLETS) as string[]).includes(address),
        "a wallet that is not one of the synthetic placeholders",
      );
    }
  }
});

test("generation ignores the environment, including anything secret in it", () => {
  // A clean checkout with no production secrets must produce the same artifacts.
  // A canary in the environment proves nothing is read from it.
  const canary = "mk_live_CANARYMUSTNOTAPPEAR0000000000";
  process.env.MIMIR_OPENAPI_TEST_CANARY = canary;
  process.env.DATABASE_URL = `postgres://canary:${canary}@127.0.0.1:5432/mimir`;
  try {
    for (const artifact of renderArtifacts()) {
      assert.equal(artifact.contents.includes(canary), false, `${artifact.relativePath} leaked an environment value`);
    }
  } finally {
    delete process.env.MIMIR_OPENAPI_TEST_CANARY;
    delete process.env.DATABASE_URL;
  }
});

// ── Drift must fail, one way at a time ───────────────────────────────────────

test("a document that is not an object fails", () => {
  const audit = auditAgentApiDocument({ doc: "nope", schema: {} });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("DOC_MISSING_PATH"));
});

test("a missing operation fails", () => {
  const audit = auditWith((doc) => {
    delete (doc.paths as Record<string, unknown>)["/api/agents/v1/{action}"];
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("DOC_MISSING_PATH"));
});

test("a request body that stops pointing at the schema fails", () => {
  const audit = auditWith((doc) => {
    const requestBody = operation(doc).requestBody as Record<string, unknown>;
    (requestBody.content as Record<string, Record<string, unknown>>)["application/json"]!.schema = { type: "object" };
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("DOC_MISSING_SCHEMA_REF"));
});

test("a real host in servers is a warning, not a silent substitution", () => {
  const audit = auditWith((doc) => {
    (doc.servers as Record<string, unknown>[])[0]!.url = "https://agents.mimir.live";
  });
  assert.equal(audit.ok, true, "a substituted host must not fail an offline check");
  assert.ok(codes(audit).includes("SERVER_URL_NOT_PLACEHOLDER"));
});

test("an action missing from the matrix fails", () => {
  const audit = auditWith((doc) => {
    delete actionMatrix(doc).stake;
  });
  assert.equal(audit.ok, false);
  assert.ok(
    audit.findings.some((item) => item.code === "DOC_MISSING_ACTION_MATRIX" && item.message.includes("stake")),
    `expected a finding naming stake, got ${codes(audit).join(", ")}`,
  );
});

test("an action the server does not serve fails", () => {
  const audit = auditWith((doc) => {
    actionMatrix(doc).withdrawEverything = { credential: "owner_signature", funded: false };
    const parameters = operation(doc).parameters as Record<string, unknown>[];
    const actionParam = parameters.find((param) => param.name === "action")!;
    (actionParam.schema as Record<string, unknown>).enum = [
      ...(actionParam.schema as Record<string, unknown[]>).enum,
      "withdrawEverything",
    ];
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("ACTION_UNKNOWN"));
});

test("a missing action matrix fails rather than passing an empty check", () => {
  const audit = auditWith((doc) => {
    delete operation(doc)["x-mimir-actions"];
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("DOC_MISSING_ACTION_MATRIX"));
});

test("claiming a key works for an owner-signed action fails", () => {
  const audit = auditWith((doc) => {
    actionMatrix(doc).issueKey!.credential = "operator_signature_or_api_key";
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("CREDENTIAL_DRIFT"));
});

test("claiming an action is unfunded when the live gate funds it fails", () => {
  const audit = auditWith((doc) => {
    actionMatrix(doc).stake!.funded = false;
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("FUNDED_GATE_DRIFT"));
});

test("a funded action without its rollout flag fails", () => {
  const audit = auditWith((doc) => {
    delete actionMatrix(doc).createMarket!.feature;
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("FUNDED_GATE_DRIFT"));
});

test("naming the wrong incident switch fails", () => {
  const audit = auditWith((doc) => {
    actionMatrix(doc).vote!.pauseCapability = "x402_selling";
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("PAUSE_SWITCH_DRIFT"));
});

test("the wrong pause environment variable fails", () => {
  const audit = auditWith((doc) => {
    actionMatrix(doc).stake!.pauseEnvKey = "MIMIR_PAUSE_SOMETHING_ELSE";
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("PAUSE_SWITCH_DRIFT"));
});

test("a wrong capability fails", () => {
  const audit = auditWith((doc) => {
    actionMatrix(doc).vote!.capability = "researcher";
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("ACTION_CAPABILITY_DRIFT"));
});

test("a wrong minimum authority level fails", () => {
  const audit = auditWith((doc) => {
    actionMatrix(doc).stake!.minimumAuthorityLevel = 0;
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("ACTION_CAPABILITY_DRIFT"));
});

test("an error code moved to the wrong status fails", () => {
  const audit = auditWith((doc) => {
    const responses = operation(doc).responses as Record<string, unknown>;
    responses["409"] = responses["401"];
    delete responses["401"];
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("ERROR_STATUS_DRIFT"));
});

test("an error code that is not in the live catalogue fails", () => {
  const audit = auditWith((doc) => {
    const examples = responseExamplesOf(doc, "400");
    examples.made_up = { summary: "invented", "x-mimir-error-code": "made_up", value: { error: { code: "made_up", message: "m", retryable: false } } };
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("ERROR_CODE_UNKNOWN"));
});

test("a dropped error example fails", () => {
  const audit = auditWith((doc) => {
    delete responseExamplesOf(doc, "429").budget_exhausted;
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("ERROR_CODE_UNDOCUMENTED"));
});

test("a flipped retryable flag fails", () => {
  const audit = auditWith((doc) => {
    const error = (responseExamplesOf(doc, "429").rate_limited!.value as Example)["error"] as Example;
    error.retryable = false;
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("ERROR_RETRYABLE_DRIFT"));
});

test("a dropped request example fails", () => {
  const audit = auditWith((doc) => {
    const examples = requestExamplesOf(doc);
    delete examples.signedHeartbeat;
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("EXAMPLE_MISSING"));
});

test("an invented request example fails", () => {
  const audit = auditWith((doc) => {
    const examples = requestExamplesOf(doc);
    examples.madeUp = { summary: "invented", value: { version: "v1" } };
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("EXAMPLE_MISSING"));
});

test("an example the live validator refuses fails", () => {
  const audit = auditWith((doc) => {
    const examples = requestExamplesOf(doc);
    (examples.signedHeartbeat!.value as Example).agentId = "NOT A VALID AGENT ID";
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("EXAMPLE_ENVELOPE_REJECTED"));
});

test("a stale signing message fails", () => {
  const audit = auditWith((doc) => {
    const examples = requestExamplesOf(doc);
    examples.signedHeartbeat!["x-mimir-signing-message"] = "Mimir Agent API request\nversion: v1";
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("SIGNING_MESSAGE_DRIFT"));
});

test("a negative example that the server would accept fails", () => {
  // If the envelope stops being stale, the published "this is refused" claim is
  // wrong even though the example is still well-formed.
  const audit = auditWith((doc) => {
    const examples = requestExamplesOf(doc);
    (examples.rejectedStaleTimestamp!.value as Example).signedAt = Date.now();
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("EXAMPLE_REJECTION_DRIFT"));
});

test("a schema that stops refusing unknown fields fails", () => {
  const audit = auditWith((_doc, schema) => {
    schema.additionalProperties = true;
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("SCHEMA_ACTION_DRIFT"));
});

test("a schema missing a live action fails", () => {
  const audit = auditWith((_doc, schema) => {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    properties.action!.enum = (properties.action!.enum as string[]).filter((action) => action !== "rotateKey");
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("ACTION_UNDOCUMENTED_IN_SCHEMA"));
});

test("a schema that is not an object fails", () => {
  const audit = auditAgentApiDocument({ doc: buildAgentOpenApiDocument(), schema: "nope" });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("DOC_MISSING_SCHEMA_REF"));
});

// ── Safety: a failure must not leak what it found ────────────────────────────

test("a credential in the document fails, and the finding does not repeat it", () => {
  const leaked = "mk_live_9f3c1a7be40d5c82aa61f0b47d5e9c3107ab2de6f1c8";
  const audit = auditWith((doc) => {
    const examples = requestExamplesOf(doc);
    examples.signedHeartbeat!["x-mimir-credential"] = `authorization: Bearer ${leaked}`;
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("SECRET_MATERIAL_IN_DOCS"));
  for (const item of audit.findings) {
    assert.equal(item.message.includes(leaked), false, "a finding must not quote the value");
    assert.equal(item.where.includes(leaked), false, "a locator must not quote the value");
  }
});

test("a wallet that is not a synthetic placeholder fails, and is not printed", () => {
  const real = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const audit = auditWith((doc) => {
    (actionMatrix(doc).stake!.note as string) = `see ${real}`;
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("PLACEHOLDER_WALLET_UNKNOWN"));
  for (const item of audit.findings) {
    assert.equal(JSON.stringify(item).includes(real), false);
  }
});

test("a secret seed shape anywhere in the document fails", () => {
  // S + 55 base32 characters: the shape a Stellar secret key has, and the one
  // thing that must never be in a committed file even as an "example".
  const seed = `S${"ABCDEFGH".repeat(8)}`.slice(0, 56);
  assert.equal(seed.length, 56);
  assert.match(seed, /\bS[A-Z2-7]{55}\b/, "the fixture must actually have the secret-key shape");
  const audit = auditWith((doc) => {
    (doc.info as Example).description = `sign with ${seed}`;
  });
  assert.equal(audit.ok, false);
  assert.ok(codes(audit).includes("SECRET_MATERIAL_IN_DOCS"));
  for (const item of audit.findings) assert.equal(item.message.includes(seed), false);
});

test("the report names locations and reasons, and never a value", () => {
  const audit = auditWith((doc) => {
    actionMatrix(doc).stake!.funded = false;
  });
  const report = formatArtifactReport({ audit, drifted: [], committed: new Map() });
  assert.match(report, /FUNDED_GATE_DRIFT/);
  assert.match(report, /x-mimir-actions\.stake\.funded/);
  assert.equal(report.includes(SYNTHETIC_WALLETS.owner), false);
});

// ── Drift detection against a reader ─────────────────────────────────────────

test("a missing artifact is reported as missing, not as a pass", () => {
  const check = checkAgentApiArtifacts(() => undefined);
  assert.equal(check.audit.ok, false);
  assert.ok(check.audit.findings.some((item) => item.code === "ARTIFACT_MISSING"));
  assert.equal(check.drifted.length, 2);
});

test("stale committed text is reported as drift with a byte count", () => {
  const check = checkAgentApiArtifacts(() => "openapi: \"3.1.0\"\n");
  assert.equal(check.audit.ok, false);
  const drift = check.audit.findings.filter((item) => item.code === "ARTIFACT_DRIFT");
  assert.equal(drift.length, 2);
  for (const item of drift) {
    // Both sizes, in the finding itself: a consumer that only reads
    // `audit.findings` must not have to call the reporter to learn how far off
    // the committed file is.
    assert.match(item.message, /committed \d+ bytes, generated \d+ bytes/);
    assert.match(item.message, /npm run check:openapi -- --write/);
  }
  // One line per finding. A duplicate ARTIFACT_DRIFT block is noise that makes a
  // real failure harder to read.
  assert.equal(
    formatArtifactReport(check).split("\n").filter((line) => line.includes("ARTIFACT_DRIFT")).length,
    2,
  );
});

// ── Regression: the document that actually shipped ───────────────────────────

test("the stale committed document is detected as drift", () => {
  // A verbatim copy of the hand-maintained artifacts from before generation. If
  // this test ever fails to fail, the check has stopped working.
  const staleDoc = readFileSync(path.join(FIXTURES, "stale-openapi.yaml"), "utf8");
  const staleSchema = readFileSync(path.join(FIXTURES, "stale-schema.json"), "utf8");
  const check = checkAgentApiArtifacts((relativePath) => {
    if (relativePath.endsWith(".json")) return staleSchema;
    if (relativePath.endsWith(".yaml")) return staleDoc;
    return undefined;
  });
  assert.equal(check.audit.ok, false);
  assert.equal(check.drifted.length, 2);
});

test("the stale schema is caught by the audit, action by action", () => {
  const stale = JSON.parse(readFileSync(path.join(FIXTURES, "stale-schema.json"), "utf8")) as Record<string, unknown>;
  const audit = auditAgentApiDocument({ doc: buildAgentOpenApiDocument(), schema: stale });
  assert.equal(audit.ok, false);
  const published = (stale.properties as Record<string, Record<string, unknown>>).action!.enum as string[];
  const missing = AGENT_API_ACTIONS.filter((action) => !published.includes(action));
  assert.deepEqual(missing, [
    "issueKey", "listKeys", "revokeKey", "rotateKey", "grantSpend", "revokeSpend", "spendStatus",
  ]);
  const found = codes(audit);
  for (const action of missing) {
    assert.ok(
      audit.findings.some((item) => item.code === "ACTION_UNDOCUMENTED_IN_SCHEMA" && item.message.includes(action)),
      `expected a finding naming ${action}`,
    );
  }
  assert.ok(found.includes("ACTION_UNDOCUMENTED_IN_SCHEMA"));
});

test("the stale schema required a signature from API-key callers", () => {
  // The pre-generation schema listed every envelope field as required, so an
  // API-key request — which legitimately sends only the body — could not have
  // validated against it. That is a wrong document, not a wrong client.
  const stale = JSON.parse(readFileSync(path.join(FIXTURES, "stale-schema.json"), "utf8")) as Record<string, unknown>;
  const required = stale.required as string[];
  assert.ok(required.includes("signature"));
  const live = buildAgentApiJsonSchema();
  assert.equal(live.required, undefined, "a bearer request sends only the body, so the root requires nothing");
  const branches = (live.allOf ?? []) as Record<string, unknown>[];
  assert.equal(branches.length, 1);
  assert.deepEqual(branches[0]!.if, { required: ["signature"] });
  assert.ok(Array.isArray((branches[0]!.then as Record<string, unknown>).required));
  const thenRequired = (branches[0]!.then as Record<string, string[]>).required;
  assert.ok(thenRequired, "then must carry its own required list");
  assert.equal(thenRequired.includes("signature"), false,
    "then must not require signature: the property's presence is the condition");
  for (const field of ["version", "agentId", "action", "idempotencyKey", "nonce", "signedAt", "body"]) {
    assert.ok(thenRequired.includes(field), `then must require ${field} on the signed path`);
  }
});
