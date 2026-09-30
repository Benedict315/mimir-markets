import assert from "node:assert/strict";
import test from "node:test";
import { SequenceManager, type SequenceProvider } from "../../lib/agents/sequence-manager";

const ACCOUNT = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";
const OTHER = "GDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";

/** A provider that always reports the same ledger sequence. */
function provider(sequence: bigint, onRead?: () => void): SequenceProvider {
  return {
    async read() {
      onRead?.();
      return sequence;
    },
  };
}

test("the first reservation is ledger sequence + 1 and increments monotonically", async () => {
  const manager = new SequenceManager(provider(100n));
  const first = await manager.reserve(ACCOUNT);
  const second = await manager.reserve(ACCOUNT);
  assert.equal(first.sequence, 101n);
  assert.equal(second.sequence, 102n);
  assert.equal(first.state, "reserved");
  assert.deepEqual(manager.pending(ACCOUNT), [101n, 102n]);
});

test("concurrent reservations never duplicate and read the ledger once per address", async () => {
  let reads = 0;
  const manager = new SequenceManager(provider(500n, () => (reads += 1)));
  const reservations = await Promise.all(
    Array.from({ length: 8 }, () => manager.reserve(ACCOUNT)),
  );
  const sequences = reservations.map((reservation) => reservation.sequence);
  assert.deepEqual(sequences, [501n, 502n, 503n, 504n, 505n, 506n, 507n, 508n]);
  assert.equal(new Set(sequences).size, sequences.length);
  assert.equal(reads, 1, "the ledger is read once per address, not once per reservation");
});

test("different addresses keep independent sequence streams", async () => {
  const manager = new SequenceManager({
    async read(address) {
      return address === ACCOUNT ? 10n : 20n;
    },
  });
  const a = await manager.reserve(ACCOUNT);
  const b = await manager.reserve(OTHER);
  assert.equal(a.sequence, 11n);
  assert.equal(b.sequence, 21n);
});

test("submitting consumes the sequence and is idempotent", async () => {
  const manager = new SequenceManager(provider(200n));
  const first = await manager.reserve(ACCOUNT);
  first.submit();
  first.release(); // must be a no-op after submit
  assert.equal(first.state, "submitted");
  const second = await manager.reserve(ACCOUNT);
  assert.equal(second.sequence, 202n);
  assert.deepEqual(manager.pending(ACCOUNT), [202n]);
});

test("releasing the most recent reservation rolls back so no gap is left", async () => {
  const manager = new SequenceManager(provider(300n));
  const keep = await manager.reserve(ACCOUNT);
  const cancelled = await manager.reserve(ACCOUNT);
  cancelled.release();

  const reused = await manager.reserve(ACCOUNT);
  assert.equal(cancelled.state, "released");
  assert.equal(reused.sequence, 302n, "cancelled sequence is handed out again");
  assert.deepEqual(manager.holes(ACCOUNT), []);
  assert.deepEqual(manager.pending(ACCOUNT), [301n, 302n]);
  assert.equal(keep.sequence, 301n);
});

test("releasing an older reservation records a hole that must be filled", async () => {
  const manager = new SequenceManager(provider(400n));
  const older = await manager.reserve(ACCOUNT);
  await manager.reserve(ACCOUNT);
  older.release();

  assert.deepEqual(manager.holes(ACCOUNT), [401n]);
  const next = await manager.reserve(ACCOUNT);
  assert.equal(next.sequence, 403n, "a gap is not silently reused");
});

test("a provider failure rejects the reservation without corrupting state", async () => {
  let attempts = 0;
  const manager = new SequenceManager({
    async read() {
      attempts += 1;
      if (attempts === 1) throw new Error("horizon unavailable");
      return 42n;
    },
  });
  await assert.rejects(() => manager.reserve(ACCOUNT), /horizon unavailable/);
  const retry = await manager.reserve(ACCOUNT);
  assert.equal(retry.sequence, 43n, "the manager re-reads after a dependency failure");
});

test("resync advances past an externally consumed sequence and clears stale holes", async () => {
  let ledger = 100n;
  const manager = new SequenceManager({
    async read() {
      return ledger;
    },
  });
  const older = await manager.reserve(ACCOUNT); // 101
  await manager.reserve(ACCOUNT); // 102
  older.release(); // 101 becomes a hole
  assert.deepEqual(manager.holes(ACCOUNT), [101n]);

  ledger = 102n; // an out-of-band submission moved the account forward
  await manager.resync(ACCOUNT);

  assert.deepEqual(manager.holes(ACCOUNT), []);
  const next = await manager.reserve(ACCOUNT);
  assert.equal(next.sequence, 103n);
});

test("pause stops new reservations and resume restores them", async () => {
  const manager = new SequenceManager(provider(700n));
  manager.pause();
  assert.equal(manager.isPaused(), true);
  await assert.rejects(() => manager.reserve(ACCOUNT), /paused/);
  manager.resume();
  const reservation = await manager.reserve(ACCOUNT);
  assert.equal(reservation.sequence, 701n);
});

test("rejects a blank address", async () => {
  const manager = new SequenceManager(provider(1n));
  await assert.rejects(() => manager.reserve("   "), /non-empty account address/);
});

test("rejects a negative ledger sequence from the provider", async () => {
  const manager = new SequenceManager(provider(-1n));
  await assert.rejects(() => manager.reserve(ACCOUNT), /invalid ledger sequence/);
});

test("rejects reservations once the signed 64-bit sequence ceiling is reached", async () => {
  const max = (1n << 63n) - 1n;
  const manager = new SequenceManager(provider(max - 1n));
  const last = await manager.reserve(ACCOUNT);
  assert.equal(last.sequence, max);
  await assert.rejects(() => manager.reserve(ACCOUNT), /sequence space exhausted/);
});
