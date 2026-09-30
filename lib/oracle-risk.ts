export type RiskResult = { ok: true } | { ok: false; reason: string };

export interface RiskLimits {
  maxStakePerClaim: number;
  dailyLimit: number;
  totalExposure: number;
  maxConcurrent: number;
}

export interface ClaimLike {
  id?: string | number;
  state?: string;
  deadline?: number;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const defaultLimits = (): RiskLimits => ({
  maxStakePerClaim: num(process.env.RISK_MAX_STAKE_PER_CLAIM, 10),
  dailyLimit: num(process.env.RISK_DAILY_LIMIT, 50),
  totalExposure: num(process.env.RISK_TOTAL_EXPOSURE, 100),
  maxConcurrent: num(process.env.RISK_MAX_CONCURRENT, 5),
});

const today = () => new Date().toISOString().slice(0, 10);

export class RiskManager {
  private open = new Map<string, number>();
  private day = today();
  private spentToday = 0;

  constructor(private limits: RiskLimits = defaultLimits()) {}

  private rollDay() {
    const d = today();
    if (d !== this.day) {
      this.day = d;
      this.spentToday = 0;
    }
  }

  validateClaim(
    claim: ClaimLike | null | undefined,
    nowSecs: number = Math.floor(Date.now() / 1000),
  ): RiskResult {
    if (!claim || claim.id === undefined || claim.id === null) {
      return { ok: false, reason: "malformed claim" };
    }
    if (claim.state !== "open" && claim.state !== "active") {
      return { ok: false, reason: "claim not open" };
    }
    if (claim.deadline !== undefined && claim.deadline <= nowSecs) {
      return { ok: false, reason: "claim expired" };
    }
    if (this.open.has(String(claim.id))) {
      return { ok: false, reason: "duplicate challenge" };
    }
    return { ok: true };
  }

  canChallenge(claim: ClaimLike, stakeUsdc: number): RiskResult {
    this.rollDay();
    const v = this.validateClaim(claim);
    if (!v.ok) return v;

    if (!Number.isFinite(stakeUsdc) || stakeUsdc <= 0) {
      return { ok: false, reason: "invalid stake" };
    }
    if (stakeUsdc > this.limits.maxStakePerClaim) {
      return { ok: false, reason: "stake above per-claim cap" };
    }
    if (this.open.size >= this.limits.maxConcurrent) {
      return { ok: false, reason: "too many concurrent challenges" };
    }
    if (this.spentToday + stakeUsdc > this.limits.dailyLimit) {
      return { ok: false, reason: "daily limit reached" };
    }
    if (this.exposure() + stakeUsdc > this.limits.totalExposure) {
      return { ok: false, reason: "total exposure limit reached" };
    }
    return { ok: true };
  }

  recordChallenge(claim: ClaimLike, stakeUsdc: number): void {
    this.rollDay();
    this.open.set(String(claim.id), stakeUsdc);
    this.spentToday += stakeUsdc;
  }

  release(claimId: string | number): void {
    this.open.delete(String(claimId));
  }

  exposure(): number {
    let t = 0;
    for (const v of this.open.values()) t += v;
    return t;
  }
}
