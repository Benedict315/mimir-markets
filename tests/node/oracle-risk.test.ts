import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RiskManager } from "../../lib/oracle-risk";

const limits = {
  maxStakePerClaim: 10,
  dailyLimit: 15,
  totalExposure: 20,
  maxConcurrent: 2,
};

const future = Math.floor(Date.now() / 1000) + 3600;
const claim = (id: number) => ({ id, state: "open", deadline: future });

describe("RiskManager", () => {
  it("rejects malformed, closed and expired claims", () => {
    const r = new RiskManager(limits);
    assert.equal(r.validateClaim(null).ok, false);
    assert.equal(r.validateClaim({}).ok, false);
    assert.equal(
      r.validateClaim({ id: 1, state: "resolved", deadline: future }).ok,
      false,
    );
    assert.equal(
      r.validateClaim({ id: 1, state: "open", deadline: 1 }).ok,
      false,
    );
    assert.equal(r.validateClaim(claim(1)).ok, true);
  });

  it("enforces per-claim cap", () => {
    const r = new RiskManager(limits);
    assert.equal(r.canChallenge(claim(1), 11).ok, false);
    assert.equal(r.canChallenge(claim(1), 5).ok, true);
  });

  it("rejects invalid stakes", () => {
    const r = new RiskManager(limits);
    assert.equal(r.canChallenge(claim(1), 0).ok, false);
    assert.equal(r.canChallenge(claim(1), -1).ok, false);
    assert.equal(r.canChallenge(claim(1), NaN).ok, false);
  });

  it("rejects duplicates", () => {
    const r = new RiskManager(limits);
    r.recordChallenge(claim(1), 5);
    assert.equal(r.canChallenge(claim(1), 5).ok, false);
  });

  it("enforces the concurrent limit", () => {
    const r = new RiskManager(limits);
    r.recordChallenge(claim(1), 5);
    r.recordChallenge(claim(2), 5);
    assert.equal(r.canChallenge(claim(3), 1).ok, false);
  });

  it("enforces the daily limit even after release", () => {
    const r = new RiskManager(limits);
    r.recordChallenge(claim(1), 5);
    r.recordChallenge(claim(2), 5);
    r.release(1);
    r.release(2);
    r.recordChallenge(claim(4), 5);
    assert.equal(r.canChallenge(claim(5), 6).ok, false);
  });

  it("frees exposure on release", () => {
    const r = new RiskManager(limits);
    r.recordChallenge(claim(1), 10);
    assert.equal(r.exposure(), 10);
    r.release(1);
    assert.equal(r.exposure(), 0);
  });

  it("enforces total exposure", () => {
    const r = new RiskManager({ ...limits, dailyLimit: 100, maxConcurrent: 5 });
    r.recordChallenge(claim(1), 10);
    r.recordChallenge(claim(2), 10);
    assert.equal(r.canChallenge(claim(3), 1).ok, false);
  });
});
