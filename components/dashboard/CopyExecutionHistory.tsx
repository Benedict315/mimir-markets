import { formatAtomicUsdc } from "@/lib/usdc";

export interface CopyExecutionView {
  executionId: string;
  status: "executed" | "skipped" | "failed" | "expired";
  sourcePositionId: string;
  stakeAtomic: string;
  txHash?: string;
  skipReason?: string;
  createdAt: number;
  // Explicitly typed to ensure sensitive analytics/wallet fields are handled
  // and to support clear contract-backed feedback.
  isPermissionGranted?: boolean;
}

const STATUS_COPY = {
  executed: "Executed",
  skipped: "Skipped",
  failed: "Failed",
  expired: "Expired",
} as const;

const SKIP_REASONS = {
  insufficient_balance: "Insufficient balance",
  permission_denied: "Permission denied",
  slippage_too_high: "Slippage too high",
  network_error: "Network error",
  unknown: "Unknown reason",
} as const;

export function CopyExecutionHistory({
  executions,
}: {
  executions: CopyExecutionView[];
}) {
  return (
    <section
      aria-label="Copy execution history"
      className="rounded-2xl border border-pv-ink/10 p-4"
    >
      <h3 className="font-semibold">Copy execution history</h3>
      {executions.length === 0 ? (
        <p className="mt-2 text-sm text-pv-ink/60">No copy attempts yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-pv-ink/10">
          {executions.map((item) => {
            const displayReason =
              item.skipReason && item.skipReason in SKIP_REASONS
                ? SKIP_REASONS[item.skipReason as keyof typeof SKIP_REASONS]
                : item.skipReason
                  ? item.skipReason.replace(/_/g, " ")
                  : undefined;

            return (
              <li
                key={item.executionId}
                className="flex items-start justify-between gap-4 py-3 text-sm"
              >
                <div>
                  <div>{STATUS_COPY[item.status]}</div>
                  <div className="text-xs text-pv-ink/50">
                    Source {item.sourcePositionId}
                  </div>
                  {displayReason && (
                    <div
                      className="text-xs text-amber-300"
                      title={displayReason}
                    >
                      Reason: {displayReason}
                    </div>
                  )}
                  {item.status === "skipped" && !item.skipReason && (
                    <div className="text-xs text-pv-ink/50">
                      Skipped due to permission or balance constraints
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div>{formatAtomicUsdc(item.stakeAtomic)} USDC</div>
                  {item.txHash && (
                    <div
                      className="max-w-24 truncate text-xs text-pv-ink/50"
                      title={item.txHash}
                    >
                      {item.txHash}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}