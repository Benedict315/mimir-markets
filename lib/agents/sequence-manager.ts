/**
 * Safe account-sequence management for Mimir worker wallets.
 *
 * Every state-changing transaction a worker submits must carry the account's
 * *next* ledger sequence number. Horizon hands out the current sequence, and
 * Stellar rejects a transaction whose sequence is not exactly `current + 1`
 * (`tx_bad_seq`). That makes concurrent submissions from the same worker wallet
 * fragile in three concrete ways:
 *
 *  1. **Duplicate** — two jobs read the same Horizon sequence and both build a
 *     transaction with `current + 1`; the second is rejected after the first
 *     lands, and the wallet loses a slot.
 *  2. **Gap** — a job reserves `current + 1`, then aborts (cancelled job, failed
 *     simulation, crashed process) while a later job submits `current + 2`.
 *     Stellar refuses `current + 2` because the account is still at `current`,
 *     so the wallet is wedged until the hole is filled.
 *  3. **Stale base** — the cached sequence drifts after an out-of-band
 *     submission, leaving every subsequent transaction one behind.
 *
 * `SequenceManager` makes those cases explicit and recoverable:
 *
 *  - Reservations are serialised per address, so a sequence is never handed out
 *    twice, no matter how many jobs call `reserve()` concurrently.
 *  - Releasing an unsubmitted reservation rolls the counter back when nothing
 *    higher was issued (no gap); otherwise it records a hole that must be
 *    filled before a higher sequence is usable.
 *  - `resync()` re-reads the ledger after a `tx_bad_seq`, clearing holes that
 *    are now behind it.
 *  - `pause()` / `resume()` let an incident kill-switch stop new allocations
 *    without discarding in-flight reservations.
 *
 * The manager is deliberately dependency-free and takes a {@link SequenceProvider}
 * so it can be unit-tested without Horizon or a live ledger.
 */

/** Stellar sequences are signed 64-bit integers; keep a hard ceiling. */
const MAX_SEQUENCE = (1n << 63n) - 1n;

export interface SequenceProvider {
  /** Current on-ledger sequence for the account (Horizon `account.sequence`). */
  read(address: string): Promise<bigint>;
}

export type ReservationState = "reserved" | "submitted" | "released";

export interface SequenceReservation {
  readonly address: string;
  readonly sequence: bigint;
  readonly state: ReservationState;
  /** The transaction was accepted on-chain: the sequence is consumed. */
  submit(): void;
  /** The transaction will never be submitted: recover the gap where possible. */
  release(): void;
}

interface AddressState {
  /** Next sequence to hand out, or `null` until the first successful read. */
  next: bigint | null;
  /** Reserved and not yet settled. */
  outstanding: Set<bigint>;
  /** Released out of order; these must be filled before higher sequences. */
  holes: Set<bigint>;
  /** Serialises allocation for this address. */
  tail: Promise<void>;
}

function normalizeAddress(address: string): string {
  const scope = address.trim();
  if (!scope) throw new Error("sequence manager requires a non-empty account address");
  return scope;
}

function assertSequence(value: bigint, address: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`sequence provider returned an invalid ledger sequence for ${address}`);
  }
  return value;
}

function compareSequences(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class SequenceManager {
  private readonly provider: SequenceProvider;
  private readonly states = new Map<string, AddressState>();
  private paused = false;

  constructor(provider: SequenceProvider) {
    this.provider = provider;
  }

  private state(address: string): AddressState {
    let state = this.states.get(address);
    if (!state) {
      state = { next: null, outstanding: new Set(), holes: new Set(), tail: Promise.resolve() };
      this.states.set(address, state);
    }
    return state;
  }

  /** Run `task` after every previously queued task for `address` has settled. */
  private runExclusive<T>(address: string, task: () => Promise<T>): Promise<T> {
    const state = this.state(address);
    const run = state.tail.then(task, task);
    state.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async loadNext(address: string): Promise<bigint> {
    const ledger = assertSequence(await this.provider.read(address), address);
    return ledger + 1n;
  }

  /**
   * Reserve the next sequence for `address`.
   *
   * Concurrent callers for the same address are serialised, so every reservation
   * is unique and monotonically increasing.
   */
  async reserve(address: string): Promise<SequenceReservation> {
    const scope = normalizeAddress(address);
    return this.runExclusive(scope, async () => {
      if (this.paused) {
        throw new Error(`worker wallet sequence manager is paused for ${scope}`);
      }
      const state = this.state(scope);
      if (state.next === null) {
        state.next = await this.loadNext(scope);
      }
      if (state.next > MAX_SEQUENCE) {
        throw new Error(`sequence space exhausted for ${scope}`);
      }
      const sequence = state.next;
      state.next = sequence + 1n;
      state.outstanding.add(sequence);
      return this.mint(scope, sequence);
    });
  }

  private mint(address: string, sequence: bigint): SequenceReservation {
    const state = this.state(address);
    let status: ReservationState = "reserved";
    const settle = (next: ReservationState, rollback: boolean) => {
      if (status !== "reserved") return;
      status = next;
      state.outstanding.delete(sequence);
      if (!rollback) return;
      if (state.next === sequence + 1n) {
        // Nothing higher was issued, so the number can be safely reused.
        state.next = sequence;
      } else {
        // A higher reservation exists; this number must be filled first.
        state.holes.add(sequence);
      }
    };
    return {
      address,
      sequence,
      get state() {
        return status;
      },
      submit() {
        settle("submitted", false);
      },
      release() {
        settle("released", true);
      },
    };
  }

  /** Sequences reserved but not yet submitted or released. */
  pending(address: string): bigint[] {
    return [...this.state(normalizeAddress(address)).outstanding].sort(compareSequences);
  }

  /** Released out-of-order sequences that must be filled before higher ones. */
  holes(address: string): bigint[] {
    return [...this.state(normalizeAddress(address)).holes].sort(compareSequences);
  }

  /**
   * Re-read the ledger sequence and reconcile local state, e.g. after a
   * `tx_bad_seq` rejection or an out-of-band submission.
   */
  async resync(address: string): Promise<void> {
    const scope = normalizeAddress(address);
    return this.runExclusive(scope, async () => {
      const state = this.state(scope);
      const ledger = assertSequence(await this.provider.read(scope), scope);
      const floor = ledger + 1n;
      if (state.next === null || state.next < floor) {
        state.next = floor;
      }
      for (const value of state.holes) {
        if (value < floor) state.holes.delete(value);
      }
      for (const value of state.outstanding) {
        if (value < floor) state.outstanding.delete(value);
      }
    });
  }

  /** Stop handing out new sequences (in-flight reservations stay valid). */
  pause(): void {
    this.paused = true;
  }

  /** Resume allocations after a pause. */
  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }
}
