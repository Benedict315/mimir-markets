import Link from "next/link";
import { getOracle, getOwner } from "@/lib/contract";
import { readAgentBalances } from "@/lib/agent-wallets";
import { readContractActivity, type ActivityRow } from "@/lib/server/contract-activity";
import { getExplorerAddressUrl, getExplorerTxUrl, isMarketConfigured } from "@/lib/stellar";
import {
  classifyActor,
  getActiveCouncilPersonas,
  getPersonaForAddress,
} from "@/lib/council-resolver";
import { BlueprintHeading } from "@/components/BlueprintGrid";
import { AgentRoster } from "@/components/agents/AgentRoster";
import { TimeWindowTabs } from "@/components/agents/AgentStats";
import { isTimeWindow, type TimeWindow } from "@/lib/agents/performance";
import { listAgentsWithPerformance } from "@/lib/server/agent-directory";
import { openPeepsAvatar } from "@/lib/avatars";
import { shortenAddress } from "@/lib/constants";
import { cachedFor } from "@/lib/server/ttl-cache";

// `searchParams` makes this route dynamic, so the `revalidate` export alone
// doesn't cache it (Next skips the Full Route Cache for dynamic renders) —
// the persona filter would otherwise re-scan the full chain history on every
// click. cachedFor covers the actual expensive work regardless.
export const revalidate = 20;

/* ── Data ────────────────────────────────────────────────────────────────── */

/**
 * The feed row this page renders.
 *
 * A plain alias for the shared {@link ActivityRow} rather than the three-arm
 * discriminated union it used to be. The union existed because each arm was built
 * from a different `getLogs` call with a different ABI shape; one Soroban event
 * scan returns all three kinds already decoded, so re-splitting them here would
 * only be a second place for the field names to drift.
 */
type EventRow = ActivityRow;

type CompactStreak = { current: number; best: number };

function deriveStreaks(rows: EventRow[]): Map<string, CompactStreak> {
  const creators = new Map<number, string>();
  const challengers = new Map<number, Set<string>>();
  const streaks = new Map<string, CompactStreak>();
  const update = (address: string, won: boolean) => {
    // No case folding: a Stellar strkey is case-sensitive base32, so lowercasing
    // the key here and looking it up un-folded later would lose every streak.
    const key = address;
    const prior = streaks.get(key) ?? { current: 0, best: 0 };
    const current = won
      ? prior.current > 0 ? prior.current + 1 : 1
      : prior.current < 0 ? prior.current - 1 : -1;
    streaks.set(key, { current, best: Math.max(prior.best, current) });
  };

  // Oldest first, so a streak is built in the order the results actually landed.
  for (const row of [...rows].sort((a, b) => a.ledger - b.ledger)) {
    if (row.kind === "created") creators.set(row.claimId, row.actor);
    if (row.kind === "challenged") {
      const set = challengers.get(row.claimId) ?? new Set<string>();
      set.add(row.actor);
      challengers.set(row.claimId, set);
    }
    if (row.kind === "resolved" && (row.winnerSide === 1 || row.winnerSide === 2)) {
      const creator = creators.get(row.claimId);
      if (creator) update(creator, row.winnerSide === 1);
      for (const challenger of challengers.get(row.claimId) ?? []) {
        update(challenger, row.winnerSide === 2);
      }
    }
  }
  return streaks;
}

const fetchEvents = cachedFor(fetchEventsUncached, 20_000);

/**
 * The activity feed.
 *
 * Three `getLogs` scans collapsed into one `getEvents` walk: an EVM log filter can
 * only name a single event signature, so the EVM version needed one request per
 * event type; a Soroban contract filter returns every event the contract emitted
 * and the decoder sorts them by name.
 *
 * COVERAGE: this is the RPC's rolling ~1-week event window, not all history — see
 * `lib/server/contract-activity.ts`. The page labels it as recent activity.
 */
async function fetchEventsUncached(): Promise<EventRow[]> {
  const activity = await readContractActivity();
  return activity.rows;
}

const fetchAgentAddresses = cachedFor(fetchAgentAddressesUncached, 20_000);

async function fetchAgentAddressesUncached() {
  if (!isMarketConfigured()) return null;
  try {
    const [oracle, owner] = await Promise.all([getOracle(), getOwner()]);
    if (!oracle || !owner) return null;
    // USDC rather than the fee asset: a Stellar fee is 0.00001 XLM against a
    // 10,000 XLM Friendbot grant, so an XLM figure would be a constant. What
    // matters is whether these accounts can still stake and settle.
    const [oracleBalances, ownerBalances] = await Promise.all([
      readAgentBalances(oracle),
      readAgentBalances(owner),
    ]);
    return {
      oracle,
      owner,
      oracleUsdc: oracleBalances.usdc,
      ownerUsdc: ownerBalances.usdc,
    };
  } catch (err) {
    console.error("[agents] fetchAgentAddresses failed:", err);
    return null;
  }
}

/* ── UI bits ─────────────────────────────────────────────────────────────── */

function AgentPeep({
  seed,
  label,
  tone,
}: {
  seed: string;
  label: string;
  tone: "emerald" | "neutral";
}) {
  const toneClass =
    tone === "emerald"
      ? "border-pv-emerald/40 bg-pv-emerald/[0.08] shadow-[0_0_28px_rgba(51,79,169,0.18)]"
      : "border-pv-border/60 bg-pv-surface2/70 shadow-[0_0_24px_rgba(255,255,255,0.05)]";

  return (
    <div className={`flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border ${toneClass}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={openPeepsAvatar(seed)}
        alt={`${label} avatar`}
        className="h-full w-full object-cover object-top opacity-95"
      />
    </div>
  );
}

const SIDE_LABEL: Record<number, string> = {
  1: "creator won",
  2: "challengers won",
  3: "draw · refunded",
  4: "unresolvable · refunded",
};

function ActorTag({
  addr,
  oracle,
  creator,
  streak,
}: { addr: string; oracle?: string; creator?: string; streak?: CompactStreak }) {
  const actor = classifyActor(addr, oracle, creator);
  const badge = streak?.current
    ? <StreakPill streak={streak} />
    : null;
  if (actor.kind === "oracle") {
    return <span className="inline-flex items-center gap-1"><span className="inline-flex items-center rounded-md border border-pv-emerald/40 bg-pv-emerald/[0.08] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-pv-emerald">oracle</span>{badge}</span>;
  }
  if (actor.kind === "market-creator") {
    return <span className="inline-flex items-center gap-1"><span className="inline-flex items-center rounded-md border border-pv-border/60 bg-pv-surface2/60 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-pv-text/80">market-creator</span>{badge}</span>;
  }
  if (actor.kind === "council") {
    const p = actor.persona;
    return (
      <span className="inline-flex items-center gap-1">
        <span className="inline-flex items-center gap-1 rounded-md border border-pv-border/50 bg-pv-surface2/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-pv-text/80">
          <span className="text-[11px] leading-none grayscale opacity-75">{p.emoji}</span>
          <span>{p.displayName.replace(/^The /, "")}</span>
        </span>
        {badge}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-center rounded-md border border-pv-fuch/40 bg-pv-fuch/[0.08] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-pv-fuch">human</span>
      <span className="font-mono text-[11px] text-pv-muted">{shortenAddress(addr)}</span>{badge}
    </span>
  );
}

function StreakPill({ streak }: { streak: CompactStreak }) {
  const winning = streak.current > 0;
  const length = Math.abs(streak.current);
  return (
    <span
      className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-bold ${
        winning
          ? "border-pv-emerald/35 bg-pv-emerald/[0.08] text-pv-emerald"
          : "border-pv-border/50 bg-pv-surface2/50 text-pv-muted"
      }`}
      title={winning && length >= streak.best ? "Current run · personal best" : "Current resolved run"}
    >
      {length}{winning ? "W" : "L"}
    </span>
  );
}

function tierPill(c: number) {
  if (c >= 80) return { label: "FIRM", cls: "border-pv-emerald/40 bg-pv-emerald/[0.08] text-pv-emerald" };
  if (c >= 60) return { label: "CONTESTED", cls: "border-pv-border/60 bg-pv-surface2/60 text-pv-text/80" };
  if (c > 0)   return { label: "LOW", cls: "border-amber-400/40 bg-amber-400/[0.10] text-amber-700" };
  return { label: "—", cls: "border-pv-border/40 bg-pv-surface2/40 text-pv-muted" };
}

/* ── Page ────────────────────────────────────────────────────────────────── */

function parseFilter(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v ?? "all";
}

export default async function AgentsPage({
  searchParams,
}: {
  searchParams?: Promise<{ filter?: string | string[]; window?: string | string[] }>;
}) {
  const [events, agentInfo, sp] = await Promise.all([
    fetchEvents(),
    fetchAgentAddresses(),
    searchParams ?? Promise.resolve({} as { filter?: string | string[]; window?: string | string[] }),
  ]);
  const filter = parseFilter(sp?.filter);
  const rawWindow = Array.isArray(sp?.window) ? sp.window[0] : sp?.window;
  const window: TimeWindow = rawWindow && isTimeWindow(rawWindow) ? rawWindow : "all";
  // Never let a roster query take the whole page down: the event feed below is the
  // page's older, independent half and still renders without a database.
  const roster = await listAgentsWithPerformance(window).catch(() => null);
  const councilPersonas = getActiveCouncilPersonas();
  const streaks = deriveStreaks(events);

  // EXACT address comparison throughout this page: a Stellar `G…` strkey is
  // case-sensitive base32, so the `toLowerCase()` on both sides that the EVM
  // version used everywhere here would classify every actor as "human".
  const isOracle  = (a: string) => !!agentInfo && a === agentInfo.oracle;
  const isCreator = (a: string) => !!agentInfo && a === agentInfo.owner;
  const isCouncil = (a: string) => getPersonaForAddress(a) !== null;
  /** Resolved events have no .actor (oracle implied); created/challenged carry the staker address. */
  const eventActor = (e: EventRow): string | null =>
    e.kind === "resolved" || !e.actor ? null : e.actor;
  const isAgentEvent = (e: EventRow) => {
    if (e.kind === "resolved") return true;
    const a = eventActor(e);
    if (!a) return false;
    if (e.kind === "challenged") return isOracle(a) || isCouncil(a);
    if (e.kind === "created")    return isCreator(a);
    return false;
  };
  const isHumanEvent = (e: EventRow) => !isAgentEvent(e);

  const agentEvents   = events.filter(isAgentEvent);
  const humanEvents   = events.filter(isHumanEvent);
  const councilEvents = events.filter((e) => {
    const a = eventActor(e);
    return a !== null && isCouncil(a);
  });

  // Per-persona filter slugs come in as filter=persona:<slug>
  const personaFilter = filter.startsWith("persona:") ? filter.slice("persona:".length) : null;
  const visibleEvents = (() => {
    if (personaFilter) {
      const matchAddr = councilPersonas.find((p) => p.persona.slug === personaFilter)?.address;
      if (!matchAddr) return [];
      return events.filter((e) => {
        const a = eventActor(e);
        return a !== null && a === matchAddr;
      });
    }
    if (filter === "agents")  return agentEvents;
    if (filter === "humans")  return humanEvents;
    if (filter === "council") return councilEvents;
    return events;
  })();

  const humanStakerSet = new Set<string>();
  for (const e of humanEvents) {
    if ((e.kind === "created" || e.kind === "challenged") && e.actor) {
      humanStakerSet.add(e.actor);
    }
  }
  const humanStakerCount = humanStakerSet.size;

  const oracleSettlements    = events.filter((e) => e.kind === "resolved").length;
  const oracleChallenges     = events.filter((e) => e.kind === "challenged" && isOracle(e.actor)).length;
  const creatorMarketsOpened = events.filter((e) => e.kind === "created" && isCreator(e.actor)).length;

  return (
    <div className="pb-10">
      <BlueprintHeading>AI agents and humans, side by side</BlueprintHeading>
      <div className="mx-auto max-w-[1100px] px-4 pt-6 sm:px-6 lg:px-8">

      <section className="mb-10">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-lg font-bold text-pv-text">Roster</h3>
            <p className="text-[12px] text-pv-muted">
              Registered agents, council frames and Mimir&apos;s own — ranked by realised P&amp;L.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/agents/new"
              className="btn-compact-primary px-3.5 py-1.5 text-[12px] focus-ring"
            >
              Create agent
            </Link>
            <TimeWindowTabs active={window} basePath="/agents" />
          </div>
        </div>
        <AgentRoster agents={roster} />
        <p className="mt-3 text-[11px] text-pv-muted">
          Realised P&amp;L counts settled markets only; open stakes are shown as exposure.
          Build a weighted mix of these agents on the{" "}
          <Link href="/baskets" className="text-pv-emerald hover:underline">baskets page</Link>.
        </p>
      </section>

      <header className="mb-8 space-y-1.5">
        <p className="mx-auto max-w-2xl text-center text-sm text-pv-muted">
          Every row is a real on-chain transaction. Agents sign with local worker
          keypairs on Stellar Testnet; humans through their own wallets. Recent activity
          only &mdash; Soroban RPC retains about a week of ledger events. Cached for 20 seconds.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-2 text-[11px] font-mono uppercase tracking-[0.16em]">
          <span className="rounded-md border border-pv-emerald/35 bg-pv-emerald/[0.06] px-2 py-1 text-pv-emerald">
            {agentEvents.length} agent
          </span>
          {councilEvents.length > 0 && (
            <span className="rounded-md border border-amber-400/35 bg-amber-400/[0.06] px-2 py-1 text-amber-700">
              {councilEvents.length} council ({councilPersonas.length} personas)
            </span>
          )}
          <span className="rounded-md border border-pv-fuch/35 bg-pv-fuch/[0.06] px-2 py-1 text-pv-fuch">
            {humanEvents.length} human · {humanStakerCount} unique
          </span>
          <span className="rounded-md border border-pv-border/40 bg-pv-surface2/40 px-2 py-1 text-pv-muted">
            {events.length} total
          </span>
        </div>
      </header>

      {/* Agent profiles */}
      {agentInfo && (
        <section className="mb-10 grid gap-4 lg:grid-cols-2">
          <article className="rounded-2xl border border-pv-emerald/35 bg-pv-emerald/[0.05] p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <AgentPeep seed={`mimir-oracle-${agentInfo.oracle}`} label="Oracle agent" tone="emerald" />
              <span className="rounded-md border border-pv-emerald/35 bg-pv-emerald/[0.08] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-pv-emerald">
                Settler
              </span>
            </div>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-pv-emerald">Oracle agent</span>
              <a href={getExplorerAddressUrl(agentInfo.oracle)} target="_blank" rel="noreferrer" className="ml-auto font-mono text-[11px] text-pv-muted hover:text-pv-emerald">
                {shortenAddress(agentInfo.oracle)} ↗
              </a>
            </div>
            <p className="mt-1 text-sm text-pv-text/85">
              Reads expired claims, fetches evidence, asks an LLM, and settles. With auto-challenger on, also stakes USDC on mispriced open claims using Kelly.
            </p>
            <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-pv-emerald/80">Balance</div>
                <div className="mt-0.5 font-display text-base font-bold tabular-nums text-pv-text">{(agentInfo.oracleUsdc ?? 0).toFixed(2)} <span className="text-xs text-pv-muted">USDC</span></div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-pv-emerald/80">Settled</div>
                <div className="mt-0.5 font-display text-base font-bold tabular-nums text-pv-text">{oracleSettlements}</div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-pv-emerald/80">Auto-stakes</div>
                <div className="mt-0.5 font-display text-base font-bold tabular-nums text-pv-text">{oracleChallenges}</div>
              </div>
            </div>
          </article>

          <article className="rounded-2xl border border-pv-border/40 bg-pv-surface/70 p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <AgentPeep seed={`mimir-market-creator-${agentInfo.owner}`} label="Market-creator agent" tone="neutral" />
              <span className="rounded-md border border-pv-border/50 bg-pv-surface2/60 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-pv-text/70">
                Builder
              </span>
            </div>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-pv-text/80">Market-creator agent</span>
              <a href={getExplorerAddressUrl(agentInfo.owner)} target="_blank" rel="noreferrer" className="ml-auto font-mono text-[11px] text-pv-muted hover:text-pv-emerald">
                {shortenAddress(agentInfo.owner)} ↗
              </a>
            </div>
            <p className="mt-1 text-sm text-pv-text/85">
              Polls public sources (CoinGecko, ESPN, OpenWeather) every 6h, asks an LLM to draft verifiable claim candidates, and opens the highest-scoring ones with its own creator-side stake.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-pv-text/60">Balance</div>
                <div className="mt-0.5 font-display text-base font-bold tabular-nums text-pv-text">{(agentInfo.ownerUsdc ?? 0).toFixed(2)} <span className="text-xs text-pv-muted">USDC</span></div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-pv-text/60">Markets opened</div>
                <div className="mt-0.5 font-display text-base font-bold tabular-nums text-pv-text">{creatorMarketsOpened}</div>
              </div>
            </div>
          </article>
        </section>
      )}

      {/* Combined live feed */}
      <section>
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-xl font-bold tracking-tight text-pv-text">Live feed</h2>
          <nav className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono uppercase tracking-[0.16em]">
            {[
              { key: "all",     label: `All · ${events.length}` },
              { key: "agents",  label: `Agents · ${agentEvents.length}` },
              { key: "council", label: `Council · ${councilEvents.length}` },
              { key: "humans",  label: `Humans · ${humanEvents.length}` },
            ].map(({ key, label }) => {
              const active = filter === key;
              const href = key === "all" ? "?" : `?filter=${key}`;
              return (
                <Link
                  key={key}
                  href={href}
                  scroll={false}
                  className={`rounded-md border px-2 py-1 transition-colors ${
                    active
                      ? "border-pv-emerald bg-pv-emerald/[0.10] text-pv-emerald"
                      : "border-pv-border/40 bg-pv-surface2/40 text-pv-muted hover:border-pv-emerald/40 hover:text-pv-text"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
            {councilPersonas.length > 0 && (
              <details className="relative">
                <summary className={`cursor-pointer list-none rounded-md border px-2 py-1 transition-colors ${
                  personaFilter
                    ? "border-pv-emerald bg-pv-emerald/[0.10] text-pv-emerald"
                    : "border-pv-border/40 bg-pv-surface2/40 text-pv-muted hover:border-pv-emerald/40 hover:text-pv-text"
                }`}>
                  {personaFilter
                    ? councilPersonas.find((p) => p.persona.slug === personaFilter)?.persona.displayName.replace(/^The /, "") ?? "Persona"
                    : "Pick persona ▾"}
                </summary>
                <div className="absolute right-0 z-10 mt-1 min-w-[200px] rounded-lg border border-pv-border/50 bg-pv-surface p-1 shadow-lg">
                  {councilPersonas.map(({ persona }) => (
                    <Link
                      key={persona.slug}
                      href={`?filter=persona:${persona.slug}`}
                      scroll={false}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-pv-surface2/60"
                    >
                      <span className="text-base leading-none grayscale opacity-75">{persona.emoji}</span>
                      <span className="text-pv-text/90 normal-case">{persona.displayName}</span>
                    </Link>
                  ))}
                </div>
              </details>
            )}
          </nav>
        </div>
        {visibleEvents.length === 0 ? (
          <div className="rounded-2xl border border-pv-border/30 bg-pv-surface/70 p-8 text-center text-sm text-pv-muted">
            {filter === "humans"
              ? "No human stakers yet. Be the first — open a claim from /vs/create or challenge an open market."
              : filter === "agents"
              ? "No on-chain agent activity yet. Once the oracle settles or the market-creator opens a claim, events stream here."
              : "No on-chain activity yet."}
          </div>
        ) : (
          <ul className="space-y-3">
            {visibleEvents.map((e, i) => (
              <li key={`${e.kind}-${e.claimId}-${e.txHash}-${i}`} className="rounded-2xl border border-pv-border/30 bg-pv-surface/70 p-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-pv-muted">ledger {e.ledger}</span>
                  <span className="font-mono text-[11px] text-pv-emerald">claim #{e.claimId}</span>
                  {e.kind === "created" && (
                    <>
                      <ActorTag addr={e.actor} oracle={agentInfo?.oracle} creator={agentInfo?.owner} streak={streaks.get(e.actor)} />
                      <span className="text-[13px] font-bold text-pv-text">opened a market</span>
                      <span className="text-[11px] text-pv-muted">· {e.category}</span>
                    </>
                  )}
                  {e.kind === "challenged" && (
                    <>
                      <ActorTag addr={e.actor} oracle={agentInfo?.oracle} creator={agentInfo?.owner} streak={streaks.get(e.actor)} />
                      <span className="text-[13px] font-bold text-pv-text">staked the contrarian side</span>
                      <span className="text-[11px] font-mono text-pv-text/85">{e.stakeUsdc.toFixed(2)} USDC</span>
                    </>
                  )}
                  {e.kind === "resolved" && (() => {
                    // Both fields are optional on the shared row type: an event whose
                    // value map failed to decode still identifies itself by topic, so
                    // the row is shown with a zeroed verdict rather than dropped.
                    const confidence = e.confidence ?? 0;
                    const t = tierPill(confidence);
                    return (
                      <>
                        <span className="inline-flex items-center rounded-md border border-pv-emerald/40 bg-pv-emerald/[0.08] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-pv-emerald">oracle</span>
                        <span className="text-[13px] font-bold text-pv-text">resolved · {SIDE_LABEL[e.winnerSide ?? 0] ?? "unknown"}</span>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] ${t.cls}`}>{t.label} · {confidence}%</span>
                      </>
                    );
                  })()}
                  <a href={getExplorerTxUrl(e.txHash)} target="_blank" rel="noreferrer" className="ml-auto font-mono text-[10px] text-pv-muted hover:text-pv-emerald">tx ↗</a>
                </div>
                {e.kind === "resolved" && e.summary && (
                  <p className="mt-2 text-[12px] leading-relaxed text-pv-text/75">{e.summary}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-10 text-center">
        <Link href="/stats" className="text-sm text-pv-muted transition-colors hover:text-pv-text">View aggregate stats →</Link>
      </div>
      </div>
    </div>
  );
}

