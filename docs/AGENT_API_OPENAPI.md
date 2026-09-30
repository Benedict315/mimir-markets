# The agent API contract is generated

`docs/openapi-agent-v1.yaml` and `schemas/agent-api-v1.schema.json` are the wire
contract for `POST /api/agents/v1/{action}`. Both are **generated**, and the check
that keeps them honest is part of CI. Do not edit either file by hand.

They used to be hand-maintained, and they drifted: the committed document listed 11
actions while the route served 18, and claimed 409 for a replayed nonce where the
server returns 401 `nonce_reused`. A caller reading the file could not tell which
document was right. Now there is one source of truth and the files are a rendering
of it.

## Commands

```bash
npm run check:openapi              # verify: fails if the committed files drift
npm run check:openapi -- --write   # regenerate the committed files
```

Both are offline and need no credentials. CI runs the verify form after
`npm run typecheck`; `tests/node/agent-api-openapi.test.ts` runs the same check
and asserts that each kind of drift *does* fail, so a check that silently stopped
working would fail the suite.

## Where each fact comes from

| Published fact | Read from |
|---|---|
| Action list, envelope fields, signing message, funded actions | `lib/agents/api.ts` |
| Which credential each action takes | `lib/agents/authenticate.ts` (`requiresOwnerSignature`) |
| Error code, HTTP status, retryable, `Retry-After` | `lib/api/errors.ts` (`apiErrorCatalogue`) |
| Capability and minimum authority level | `lib/agents/registry.ts` (`authorizeAction`, probed per level) |
| Feature flag behind a funded action | `lib/ops/flags.ts` / `AGENT_FUNDED_FEATURE` |
| Incident switch and the env var that re-enables it | `lib/ops/flags.ts` (`AGENT_ACTION_PAUSE`, `pauseEnvKey`) |
| Dry-run response, fee split, atomic amounts | `lib/agents/dry-run.ts` (`buildAgentDryRun`) |

Nothing in the document is typed by hand. Even the error examples are produced by
calling `apiError()` with the live catalogue, so a status that changes in
`lib/api/errors.ts` shows up in the document on the next write.

The minimum authority level is the one fact that cannot simply be read: the
registry decides it with a private table. Rather than copy the table, the
generator calls `authorizeAction` for every level from 0 up with a synthetic
record and records the lowest level that allows it — so a change in the registry
shows up as a changed number, and a test fails until the document is regenerated.

## Examples

Every request example is executed against the live
`validateAgentRequestEnvelope` before it is written, and against the generated
schema with a small fail-closed JSON Schema subset validator. The negative
examples are executed too: `rejectedHexSignature` must still fail with *invalid
signature encoding*, and `rejectedStaleTimestamp` must still fail as expired. If
the live validator stops refusing them, that is a finding, not a stale comment.

Examples use synthetic values only. Wallets are derived from
`sha256("mimir-openapi-example/" + role)`, so they are valid strkeys that belong
to nobody; the signature is base64 of 64 zero bytes; the API key is
`mk_test_EXAMPLEPLACEHOLDER0000000000000000`. A real key would be hashed and
forgotten, and a real address would be published to every reader.

## Failure behaviour

The check fails closed. `npm run check:openapi` exits non-zero, writes nothing, and
prints one line per finding:

```
agent API contract: FAILED (2 error(s), 0 warning(s))
  ✗ ACTION_UNDOCUMENTED at $.paths./api/agents/v1/{action}.post.parameters[action].schema.enum: live action "grantSpend" is not in the published action enum
  ✗ ARTIFACT_DRIFT at docs/openapi-agent-v1.yaml: the committed artifact does not match the live code (committed 35395 bytes, generated 35547 bytes); run `npm run check:openapi -- --write` and review the diff
```

One line per finding, in the audit itself, so a consumer that only reads
`audit.findings` — a test, a future JSON reporter — carries the same information
as the terminal.

Findings are a code, a location and a reason — never a value. A check that printed
the credential it found would be a second copy of it, so the secret scan reports a
label and a byte offset and says nothing else. The same applies to addresses: a
finding says a wallet is not one of the synthetic placeholders, and does not repeat
it.

Two properties are deliberate:

- **Failures do not bypass a money or deployment control.** Nothing here can turn
  `npm run check:openapi` into a warning to get a build through. A substituted
  `servers[0].url` is the one warning, because a copy of the contract with a real
  host is a legitimate thing for a reader to make, and it does not change any
  claim about the API.
- **A schema the validator does not understand is a failure, not a pass.** The
  subset validator throws on any keyword it does not implement, and the audit
  reports it as `DOC_SCHEMA_UNSUPPORTED` rather than validating the parts it
  recognises. The same applies to the emitter: a value that is not plain JSON
  (an `undefined` property, a `Map`) stops the build instead of quietly vanishing
  from the file.

## Artifacts, secrets, environment

- **Artifacts**: exactly two, both committed. `docs/openapi-agent-v1.yaml` (the
  document) and `schemas/agent-api-v1.schema.json` (the envelope schema the
  document `$ref`s). The `servers[0].url` placeholder is
  `https://mimir.example` — substitute your own host in your copy, never in the
  committed one.
- **Secrets**: no secret may appear in either file, and the scan runs on the
  rendered text before it is written and on the committed bytes at check time. It
  covers Stellar secret-seed shape, agent API keys, provider API keys, Postgres
  connection strings, private-key blocks and assigned secret-looking env values.
  `npm run check:terms` runs over tracked files as a second, independent net.
- **Environment**: the generator reads no variable. `tests/node/agent-api-openapi.test.ts`
  sets a canary in `process.env` (including a `postgres://` URL) and asserts the
  output does not contain it, so a clean checkout with no production secrets
  produces byte-identical artifacts. The only env var that appears in the document
  is a *pause switch name* (`MIMIR_PAUSE_STAKE` and friends), which is how an
  operator is told where to reach during an incident — a name, not a value.
- **Network**: none. No RPC, no database, no LLM.

## Changing the API

1. Change the code that enforces it — the route, the registry, the error catalogue.
2. `npm run check:openapi -- --write`.
3. Read the diff. It is the review of the contract change; the generator will not
   decide for you whether a new error code or a new pause switch is the right
   thing to publish.
4. `npm run check:openapi && npm run test:smoke && npm run typecheck`.

If step 3 shows something surprising, that is the generator working. Do not reach
for `--allow-drift`: there is no such flag, and inventing one is the failure mode
this change exists to remove.

## Rollback

The check is read-only. Rolling it back is a `git revert` of the CI step and the
`check:openapi` script; no data, no chain state and no deployment is involved.

If the generated files themselves are the problem — a bad emission, or a fact the
generator gets wrong — revert the two artifact files to their previous contents
and the generator change together. The route is the source of truth, so reverting
the document never changes what the server accepts; it only un-publishes it. The
previous hand-maintained contents are kept verbatim in
`tests/fixtures/agent-openapi/` and are used as a regression fixture.

## Why there is a YAML emitter and a JSON Schema subset validator

`package.json` has no YAML dependency, and adding one for a single generated file
would mean auditing a parser to publish a contract. So the emitter is ~150 lines,
and its tests state the expected *value* for each case (reserved words, `1.0`,
`12:30`, timestamps, `: `, trailing spaces, exponent forms) rather than comparing
its output to itself. The subset validator is the same trade: it implements only
what this schema uses, and throws on anything else.

Both are covered by `tests/node/ops-yaml.test.ts` and
`tests/node/json-schema-subset.test.ts`, which fail on the silent-corruption cases
they were written to catch: a number rendered as a string, a `Map` flattened to
`{}`, a header string iterated per character.
