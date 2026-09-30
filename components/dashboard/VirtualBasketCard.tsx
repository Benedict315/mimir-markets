import type { BasketAgentWeight, BasketSnapshot } from "@/lib/baskets";
import { basketExposure } from "@/lib/baskets";

export type VirtualBasketCardProps = {
  weights: BasketAgentWeight[];
  snapshots: BasketSnapshot[];
  /** Page size for the agent list. Defaults to 6 and is clamped to [1, 50]. */
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 6;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 50;

function clampPageSize(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return DEFAULT_PAGE_SIZE;
  const integer = Math.floor(value);
  if (integer < MIN_PAGE_SIZE) return MIN_PAGE_SIZE;
  if (integer > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return integer;
}

function formatUsdc(atomic: string | undefined): string {
  if (!atomic) return "—";
  const parsed = Number(atomic);
  if (!Number.isFinite(parsed)) return "—";
  return (parsed / 1_000_000).toFixed(2);
}

export function VirtualBasketCard({ weights, snapshots, pageSize }: VirtualBasketCardProps) {
  const exposure = basketExposure(weights);
  const latest = snapshots.at(-1);
  const maxDrawdown = snapshots.reduce((max, point) => Math.max(max, point.drawdownBps), 0);

  const size = clampPageSize(pageSize);
  const totalPages = Math.max(1, Math.ceiling(weights.length / size));
  const page = 1;
  const start = (page - 1) * size;
  const visibleWeights = weights.slice(start, start + size);

  return <section className="rounded-2xl border border-pv-ink/10 p-4" aria-label="Virtual agent basket">
    <div className="flex justify-between"><div><h3 className="font-semibold">Virtual agent basket</h3><p className="text-xs text-pv-ink/60">Simulation only — idle capital remains USDC; no yield or real funds.</p></div><div className="text-right"><div>{formatUsdc(latest?.navAtomic)} USDC</div><div className="text-xs text-pv-ink/60">Max drawdown {(maxDrawdown / 100).toFixed(2)}%</div></div></div>
    <div className="mt-4 grid gap-3 sm:grid-cols-2"><div><h4 className="text-xs uppercase text-pv-ink/50">Agents</h4>{visibleWeights.length === 0 ? <p className="text-sm text-pv-ink/60">No agent weights available.</p> : visibleWeights.map((item) => <div key={item.agentId} className="flex justify-between text-sm"><span>{item.agentId}{item.paused || item.stale ? " (idle)" : ""}</span><span>{(item.weightBps / 100).toFixed(2})}%</span></div>)}{totalPages > 1 ? <p className="mt-2 text-xs text-pv-ink/50">Page {page} of {totalPages} ({weights.length} agents)</p> : null}</div><div><h4 className="text-xs uppercase text-pv-ink/50">Category / mode exposure</h4>{Object.entries({ ...exposure.categories, ...Object.fromEntries(Object.entries(exposure.modes).map(([key, value]) => [`mode:${key}`, value])) }).map(([key, value]) => <div key={key} className="flex justify-between text-sm"><span>{key}</span><span>{(value / 100).toFixed(2)}%</span></div>)}</div></div>
  </section>;
}
