/**
 * Canonical stake display formatting (USDC, 7 decimals on-chain — see lib/usdc.ts).
 * All UI money rendering for markets goes through here.
 */

function trimFixed(value: number, decimals: number): string {
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

/** Full display string with unit: "1,234.56 USDC", "<0.000001 USDC", "0 USDC". */
export function formatUsdc(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0 USDC";
  const abs = Math.abs(value);
  if (abs < 0.000001) return "<0.000001 USDC";
  if (abs < 1) return `${trimFixed(value, 6)} USDC`;
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USDC`;
}

/** Bare number ("1,234.56", "12") for layouts that render the unit separately. */
export function formatUsdcBare(amount: number): string {
  if (!Number.isFinite(amount)) return "0";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(amount);
}

/**
 * Validates basis points as an integer-safe math value (0-10,000).
 * Protects against floating-point dust that would break contract logic.
 */
export function isValidBps(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
}
