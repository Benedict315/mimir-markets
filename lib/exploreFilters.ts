import type { VSData } from "@/lib/contract";
import { CATEGORIES } from "@/lib/constants";
import { computeClaimQuality } from "@/lib/claimQuality";
import { assessUnderdog, compareByUpside, isChallengerUnderdog } from "@/lib/underdog";

export type ExploreSort = "newest" | "highest" | "expiring" | "strength" | "upside";

/** Valores válidos en `?sort=` y chips de orden en Explore / Dashboard. */
export const EXPLORE_SORT_OPTIONS: ExploreSort[] = [
  "newest",
  "highest",
  "expiring",
  "strength",
  // Payout asymmetry, not a likelihood ranking — see lib/underdog.ts.
  "upside",
];

/** Wallet participation filter for the live arena. Applied in ExploreClient (needs address). */
export type ParticipationFilter = "all" | "joined" | "available";

/** Explorer view mode: open markets, AI opportunities, or closed markets */
export type ExplorerView = "open" | "ai" | "closed";

export interface ExploreFilterState {
  cat: string;
  minStake: number;
  sort: ExploreSort;
  search: string;
  needsChallengers: boolean;
  expiringSoon: boolean;
  participation: ParticipationFilter;
  /** Only markets where the joinable side is the thin one. */
  underdogOnly: boolean;
  /** Active view tab in explorer */
  view: ExplorerView;
}

export const DEFAULT_EXPLORE_FILTERS: ExploreFilterState = {
  cat: "all",
  minStake: 0,
  sort: "newest",
  search: "",
  needsChallengers: false,
  expiringSoon: false,
  participation: "all",
  underdogOnly: false,
  view: "open",
};

/** Valores permitidos para `minStake` (URL `?min=`) y chips del sidebar Explore */
export const MIN_STAKE_OPTIONS = [0, 2, 5, 10, 20] as const;

const VALID_CATEGORY_IDS = new Set<string>(CATEGORIES.map((c) => c.id));

function isValidCategoryId(id: string): boolean {
  return VALID_CATEGORY_IDS.has(id);
}

/** Redondea a 2 decimales; 0 si no es finito o es negativo. Tope defensivo para URLs. */
export function normalizeExploreMinStake(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  const rounded = Math.round(n * 100) / 100;
  return Math.min(rounded, 1_000_000);
}

/** Lee y valida query params (?cat=&min=&sort=&q=&view=). Valores inválidos → defaults. */
export function parseExploreSearchParams(sp: URLSearchParams): ExploreFilterState {
  const catRaw = sp.get("cat") ?? "all";
  const cat =
    catRaw === "all" || isValidCategoryId(catRaw) ? catRaw : "all";

  const minRaw = sp.get("min");
  const minParsed = minRaw === null || minRaw === "" ? 0 : Number(minRaw);
  const minStake = normalizeExploreMinStake(minParsed);

  const sortRaw = (sp.get("sort") ?? "newest").toLowerCase();
  const sort = EXPLORE_SORT_OPTIONS.includes(sortRaw as ExploreSort)
    ? (sortRaw as ExploreSort)
    : "newest";

  const search = sp.get("q") ?? "";
  const needsChallengers = sp.get("needs") === "1";
  const expiringSoon = sp.get("soon") === "1";
  const mineRaw = sp.get("mine");
  const participation: ParticipationFilter =
    mineRaw === "joined" || mineRaw === "available" ? mineRaw : "all";

  const underdogOnly = sp.get("underdog") === "1";
  
  const viewRaw = sp.get("view") ?? "open";
  const view: ExplorerView =
    viewRaw === "ai" || viewRaw === "closed" ? viewRaw : "open";
  
  return {
    cat,
    minStake,
    sort,
    search,
    needsChallengers,
    expiringSoon,
    participation,
    underdogOnly,
    view,
  };
}

/** Serializa solo desviaciones respecto a defaults (URLs limpias). */
export function serializeExploreFilters(f: ExploreFilterState): string {
  const p = new URLSearchParams();
  if (f.cat !== "all") p.set("cat", f.cat);
  if (f.minStake !== 0) p.set("min", String(f.minStake));
  if (f.underdogOnly) p.set("underdog", "1");
  if (f.sort !== "newest") p.set("sort", f.sort);
  if (f.needsChallengers) p.set("needs", "1");
  if (f.expiringSoon) p.set("soon", "1");
  if (f.participation !== "all") p.set("mine", f.participation);
  if (f.view !== "open") p.set("view", f.view);
  const q = f.search.trim();
  if (q) p.set("q", q);
  return p.toString();
}

/**
 * Filtra VS por texto en pregunta y posiciones (misma regla que el campo `q` en Explore).
 * Útil para el panel del dashboard y para mantener un solo criterio con el explorador.
 */
export function filterVsByTextQuery(open: VSData[], rawQuery: string): VSData[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return open;
  return open.filter(
    (v) =>
      v.question.toLowerCase().includes(q) ||
      v.creator_position.toLowerCase().includes(q) ||
      v.opponent_position.toLowerCase().includes(q)
  );
}

/**
 * Aplica categoría, apuesta mínima, búsqueda (`q`) y orden sobre una lista de `VSData`.
 * Misma lógica para VS on-chain abiertos y para cards de demostración (ids negativos).
 */
export function applyExploreFilters(
  open: VSData[],
  f: ExploreFilterState,
  nowTs = Math.floor(Date.now() / 1000)
): VSData[] {
  let list = open;
  if (f.cat !== "all") {
    list = list.filter((v) => v.category === f.cat);
  }
  if (f.minStake > 0) {
    list = list.filter((v) => v.stake_amount >= f.minStake);
  }
  if (f.needsChallengers) {
    list = list.filter((v) => (v.challenger_count ?? 0) < 2);
  }
  if (f.expiringSoon) {
    list = list.filter(
      (v) => v.deadline > nowTs && v.deadline - nowTs <= 24 * 60 * 60
    );
  }
  if (f.underdogOnly) {
    // Only markets whose JOINABLE side is thin: a market where the creator is the
    // underdog is lopsided too, but a browsing user cannot take that side.
    list = list.filter((v) => isChallengerUnderdog(assessUnderdog(v)));
  }
  list = filterVsByTextQuery(list, f.search);

  const sorted = [...list];
  if (f.sort === "highest") {
    sorted.sort((a, b) => {
      const diff = b.stake_amount - a.stake_amount;
      return diff !== 0 ? diff : b.id - a.id;
    });
  } else if (f.sort === "expiring") {
    sorted.sort((a, b) => {
      const diff = a.deadline - b.deadline;
      return diff !== 0 ? diff : b.id - a.id;
    });
  } else if (f.sort === "upside") {
    sorted.sort((a, b) => {
      const diff = compareByUpside(a, b);
      return diff !== 0 ? diff : b.id - a.id;
    });
  } else if (f.sort === "strength") {
    sorted.sort((a, b) => {
      const aScore = computeClaimQuality({
        question: a.question,
        creator_position: a.creator_position,
        opponent_position: a.opponent_position,
        resolution_url: a.resolution_url,
        settlement_rule: a.settlement_rule ?? "",
        category: a.category,
        deadline: a.deadline,
      }).score;
      const bScore = computeClaimQuality({
        question: b.question,
        creator_position: b.creator_position,
        opponent_position: b.opponent_position,
        resolution_url: b.resolution_url,
        settlement_rule: b.settlement_rule ?? "",
        category: b.category,
        deadline: b.deadline,
      }).score;
      if (bScore !== aScore) {
        return bScore - aScore;
      }
      return b.id - a.id;
    });
  } else {
    sorted.sort((a, b) => b.id - a.id);
  }
  return sorted;
}
