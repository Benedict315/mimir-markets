/**
 * Module stubs for money-moving path tests.
 *
 * Loaded via --require before the test files. Registers lightweight stubs for
 * modules that either throw in a plain Node context (server-only) or pull in
 * native binaries / live network clients not available in the test environment.
 *
 * The stubs export only the symbols the tested source files actually use so
 * that the units under test remain fully exercised.
 */
"use strict";

const Module = require("module");
const { createHash } = require("node:crypto");
const originalLoad = Module._load;

const STUBS = {
  // next.js server-only guard — a no-op outside Next.js
  "server-only": {},

  // Stellar SDK — only the symbols used transitively by the modules under test.
  // The test environment has no live Soroban RPC.
  "@stellar/stellar-sdk": {
    Account: class Account {},
    Asset: class Asset { constructor(code, issuer) { this.code = code; this.issuer = issuer; } },
    BASE_FEE: "100",
    Contract: class Contract { constructor(id) { this.id = id; } call() { return {}; } },
    TransactionBuilder: class TransactionBuilder {
      constructor() {}
      addOperation() { return this; }
      setTimeout() { return this; }
      build() { return {}; }
    },
    rpc: {
      Server: class Server {},
      Api: { isSimulationSuccess: () => false },
    },
    scValToNative: () => 7,
    // Real SHA-256, not a fake: lib/content-hash.ts uses it for the body hash in
    // the agent API signing message, and a stub digest would make a published
    // example disagree with what the server computes. Returns a Buffer like the
    // SDK does — a Uint8Array would be `.toString("hex")`-ed into "1,2,3" and
    // quietly poison every digest.
    hash: (data) => createHash("sha256").update(Buffer.from(data)).digest(),
    Networks: { TESTNET: "Test SDF Network ; September 2015" },
    Keypair: { fromPublicKey: () => ({}) },
    StrKey: {
      isValidEd25519PublicKey: (s) => typeof s === "string" && s.startsWith("G") && s.length === 56,
      isValidContract: (s) => typeof s === "string" && s.startsWith("C") && s.length === 56,
    },
  },

  // Stellar SDK sub-path exports used by lib/agent-wallets.ts and lib/x402/stellar-scheme.ts
  "@stellar/stellar-sdk/contract": {},
  "@stellar/stellar-sdk/rpc": { Server: class Server {} },

  // Neon serverless DB used by lib/db.ts.
  // Returning a rejecting neon() means recordPayment's durable write always
  // fails, which exercises the error-swallow path in paid-revenue.ts.
  "@neondatabase/serverless": {
    neon: () => { throw new Error("no DATABASE_URL in test"); },
    Pool: class Pool {
      connect() { return Promise.reject(new Error("no DATABASE_URL in test")); }
    },
    neonConfig: {},
  },

  // @x402/fetch — used by lib/x402/buyer.ts
  "@x402/fetch": {
    wrapFetchWithPayment: (_fetch, _client) => _fetch,
    x402Client: class x402Client {
      register() { return this; }
      registerPolicy() { return this; }
    },
  },

  // @x402/core/* — type-level only in the paths we exercise
  "@x402/core/http": {
    decodePaymentResponseHeader: () => ({ success: false }),
    decodePaymentSignatureHeader: () => ({ payload: {} }),
  },
  "@x402/core/client": {},
  "@x402/core/types": {},
  "@x402/next": {},
  "@x402/extensions/bazaar": { declareDiscoveryExtension: () => ({}) },

  // next/server — used by lib/x402/server.ts (not under test here, but
  // transitively imported)
  "next/server": {
    NextResponse: { json: (body, init) => ({ body, ...init }) },
  },
};

Module._load = function stubLoad(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) {
    return STUBS[request];
  }
  return originalLoad.call(this, request, parent, isMain);
};
