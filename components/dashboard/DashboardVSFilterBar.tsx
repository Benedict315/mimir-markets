"use client";

import { useCallback, useState, type KeyboardEvent } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useTranslations } from "next-intl";
import { ListFilter, RefreshCw, Search, X } from "lucide-react";
import { EXPLORE_PRIMARY_CATEGORY_ROW } from "@/lib/explorePrimaryCategories";
import { MIN_STAKE_OPTIONS } from "@/lib/exploreFilters";
import { DASHBOARD_PANEL_SURFACE } from "@/lib/dashboardSurface";

/** Píldoras de pestaña (dashboard). */
const filterPillBase =
  "shrink-0 rounded border px-4 py-2.5 font-display text-xs font-bold uppercase tracking-tight transition-[color,border-color,background-color] focus-ring min-h-[44px]";
const filterPillActive = "border-pv-emerald/50 bg-pv-emerald text-pv-bg";
const filterPillInactive =
  "border-pv-ink/[0.15] bg-transparent text-pv-muted hover:border-pv-ink/[0.28] hover:text-pv-text";

/** Píldoras del panel Advanced (misma escala que Explore). */
const advancedFilterPillBase =
  "shrink-0 rounded border px-4 py-2 font-display text-xs font-bold uppercase tracking-tight transition-[color,border-color,background-color] focus-ring min-h-[44px]";
const advancedPillActive = filterPillActive;
const advancedPillInactive = filterPillInactive;

export type DashboardVSTab = "all" | "active" | "done";

const TAB_ORDER: DashboardVSTab[] = ["all", "active", "done"];

type TabItem = { l: string; v: DashboardVSTab; count: number };

type DashboardVSFilterBarProps = {
  tab: DashboardVSTab;
  onTabChange: (tab: DashboardVSTab) => void;
  tabs: TabItem[];
  searchQuery: string;
  onSearchChange: (value: string) => void;
  categoryFilter: string;
  onCategoryChange: (cat: string) => void;
  minStakeFilter: number;
  onMinStakeFilterChange: (value: number) => void;
  refreshing?: boolean;
  onRefresh: () => void;
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  totalCount: number;
};

/**
 * Barra de búsqueda + pestañas + Advanced (categorías y apuesta mínima).
 * Sin orden ni filtros rápidos tipo Explore: el listado usa orden fijo en `applyExploreFilters`.
 */
export default function DashboardVSFilterBar({
  tab,
  onTabChange,
  tabs,
  searchQuery,
  onSearchChange,
  categoryFilter,
  onCategoryChange,
  minStakeFilter,
  onMinStakeFilterChange,
  refreshing = false,
  onRefresh,
  page,
  pageCount,
  onPageChange,
  totalCount,
}: DashboardVSFilterBarProps) {
  const tDash = useTranslations("dashboard");
  const tExplore = useTranslations("explore");
  const tCache = useTranslations("cache");
  const tCat = useTranslations("categories");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  const safePageCount = Math.max(1, pageCount);
  const safePage = Math.min(Math.max(1, page), safePageCount);
  const canPrev = safePage > 1;
  const canNext = safePage < safePageCount;

  const goToPage = useCallback(
    (next: number) => {
      const clamped = Math.min(Math.max(1, next), safePageCount);
      if (clamped === safePage) return;
      onPageChange(clamped);
    },
    [onPageChange, safePage, safePageCount],
  );

  const handlePrev = useCallback(() => goToPage(safePage - 1), [goToPage, safePage]);
  const handleNext = useCallback(() => goToPage(safePage + 1), [goToPage, safePage]);

  const handleTabListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Home") {
      e.preventDefault();
      onTabChange("all");
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      onTabChange("done");
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = TAB_ORDER.indexOf(tab);
    if (i < 0) return;
    const delta = e.key === "ArrowRight" ? 1 : -1;
    onTabChange(TAB_ORDER[(i + delta + TAB_ORDER.length) % TAB_ORDER.length]);
  };

  const handlePagerKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (canPrev) handlePrev();
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (canNext) handleNext();
      return;
    }
  };

  const advDuration = reduceMotion ? 0 : 0.34;
  const advOpacityDuration = reduceMotion ? 0 : 0.22;

  return (
    <section
      className={DASHBOARD_PANEL_SURFACE}
      aria-label={tDash("tabsSectionAria")}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-3 md:gap-4">
        <div className="min-w-0 flex-1">
          <label htmlFor="dashboard-vs-search" className="sr-only">
            {tDash("searchChallengesPlaceholder")}
          </label>
          <div className="relative w-full min-w-0">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 z-[1] -translate-y-1/2 text-pv-muted"
              aria-hidden
            />
            <input
              id="dashboard-vs-search"
              type="text"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              placeholder={tDash("searchChallengesPlaceholder")}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className={`input h-11 min-h-[44px] w-full bg-pv-bg py-2.5 pl-10 font-body text-sm ${
                searchQuery ? "pr-11" : "pr-3"
              }`}
            />
            {searchQuery ? (
              <button
                type="button"
                className="absolute right-2 top-1/2 z-[1] flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-pv-muted transition-colors hover:bg-pv-ink/[0.06] hover:text-pv-text focus-ring"
                onClick={() => onSearchChange("")}
                aria-label={tDash("clearSearch")}
              >
                <X size={16} strokeWidth={2} />
              </button>
            ) : null}
          </div>
        </div>

        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <div
            className="flex flex-wrap items-center gap-2"
            role="tablist"
            aria-orientation="horizontal"
            onKeyDown={handleTabListKeyDown}
          >
            {tabs.map(({ l, v, count }) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={tab === v}
                onClick={() => onTabChange(v)}
                className={`${filterPillBase} ${
                  tab === v ? filterPillActive : filterPillInactive
                }`}
              >
                <span className="inline-flex items-baseline gap-1.5">
                  {l}
                  {count > 0 ? (
                    <span
                      className={`font-mono text-[10px] font-bold tabular-nums ${
                        tab === v ? "text-pv-bg/90" : "opacity-55"
                      }`}
                    >
                      {count}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            aria-expanded={advancedOpen}
            className="flex h-11 min-h-[44px] w-full shrink-0 items-center justify-center gap-2 rounded border border-pv-ink/[0.1] bg-pv-bg px-5 font-display text-[11px] font-bold uppercase tracking-[0.18em] text-pv-text transition-colors hover:border-pv-emerald/30 hover:bg-pv-ink/[0.04] sm:w-auto"
          >
            <ListFilter size={16} className="text-pv-muted" aria-hidden />
            {tExplore("advanced")}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-busy={refreshing}
            className="flex h-11 min-h-[44px] w-full shrink-0 items-center justify-center gap-2 rounded border border-pv-ink/[0.1] bg-pv-bg px-5 font-display text-[11px] font-bold uppercase tracking-[0.18em] text-pv-text transition-colors hover:border-pv-emerald/30 hover:bg-pv-ink/[0.04] disabled:cursor-wait disabled:opacity-70 sm:w-auto"
          >
            <RefreshCw
              size={16}
              className={`text-pv-muted ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
              aria-hidden
            />
            {refreshing ? tCache("refreshing") : tCache("refresh")}
          </button>
        </div>
      </div>

      <motion.div
        initial={false}
        animate={{
          height: advancedOpen ? "auto" : 0,
          opacity: advancedOpen ? 1 : 0,
        }}
        transition={{
          height: {
            duration: advDuration,
            ease: [0.25, 0.46, 0.45, 0.94],
          },
          opacity: {
            duration: advOpacityDuration,
            ease: [0.25, 0.1, 0.25, 1],
          },
        }}
        className={`overflow-hidden ${!advancedOpen ? "pointer-events-none" : ""}`}
        aria-hidden={!advancedOpen}
      >
        <div className="mt-6 border-t border-pv-ink/[0.06] pt-6">
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 sm:gap-x-10 sm:gap-y-6 sm:items-start">
            <div className="min-w-0">
              <span className="mb-3 block font-display text-[10px] font-bold uppercase tracking-[0.22em] text-pv-muted">
                {tExplore("categoriesHeading")}
              </span>
              <div
                className="flex flex-wrap gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                role="group"
                aria-label={tExplore("category")}
              >
                <button
                  type="button"
                  aria-pressed={categoryFilter === "all"}
                  onClick={() => onCategoryChange("all")}
                  className={`${advancedFilterPillBase} ${
                    categoryFilter === "all"
                      ? advancedPillActive
                      : advancedPillInactive
                  }`}
                >
                  {tExplore("all")}
                </button>
                {EXPLORE_PRIMARY_CATEGORY_ROW.map(({ id, labelKey }) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={categoryFilter === id}
                    onClick={() => onCategoryChange(id)}
                    className={`${advancedFilterPillBase} ${
                      categoryFilter === id
                        ? advancedPillActive
                        : advancedPillInactive
                    }`}
                  >
                    {tExplore(labelKey)}
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={categoryFilter === "clima"}
                  onClick={() => onCategoryChange("clima")}
                  className={`${advancedFilterPillBase} ${
                    categoryFilter === "clima"
                      ? advancedPillActive
                      : advancedPillInactive
                  }`}
                >
                  <span className="uppercase">{tCat("clima")}</span>
                </button>
              </div>
            </div>
            <div className="min-w-0">
              <span className="mb-3 block font-display text-[10px] font-bold uppercase tracking-[0.18em] text-pv-muted">
                {tExplore("advancedMinPresets")}
              </span>
              <div className="flex flex-wrap gap-2" role="group">
                {MIN_STAKE_OPTIONS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={minStakeFilter === value}
                    onClick={() => onMinStakeFilterChange(value)}
                    className={`${advancedFilterPillBase} ${
                      minStakeFilter === value
                        ? advancedPillActive
                        : advancedPillInactive
                    }`}
                  >
                    {value === 0 ? tExplore("any") : `$${value}+`}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      <nav
        className="mt-4 flex flex-col gap-3 border-t border-pv-ink/[0.06] pt-4 sm:flex-row sm:items-center sm:justify-between"
        aria-label={tDash("paginationAria")}
      >
        <p
          className="font-mono text-[11px] tabular-nums text-pv-muted"
          aria-live="polite"
        >
          {tDash("paginationStatus", {
            page: safePage,
            pageCount: safePageCount,
            total: totalCount,
          })}
        </p>
        <div
          className="flex items-center gap-2"
          role="group"
          aria-label={tDash("paginationControlsAria")}
          onKeyDown={handlePagerKeyDown}
        >
          <button
            type="button"
            onClick={handlePrev}
            disabled={!canPrev}
            aria-label={tDash("paginationPrev")}
            className="flex h-11 min-h-[44px] items-center justify-center rounded border border-pv-ink/[0.1] bg-pv-bg px-4 font-display text-[11px] font-bold uppercase tracking-[0.18em] text-pv-text transition-colors hover:border-pv-emerald/30 hover:bg-pv-ink/[0.04] disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
          >
            {tDash("paginationPrev")}
          </button>
          <span
            className="font-mono text-[11px] tabular-nums text-pv-muted"
            aria-hidden
          >
            {safePage} / {safePageCount}
          </span>
          <button
            type="button"
            onClick={handleNext}
            disabled={!canNext}
            aria-label={tDash("paginationNext")}
            className="flex h-11 min-h-[44px] items-center justify-center rounded border border-pv-ink/[0.1] bg-pv-bg px-4 font-display text-[11px] font-bold uppercase tracking-[0.18em] text-pv-text transition-colors hover:border-pv-emerald/30 hover:bg-pv-ink/[0.04] disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
          >
            {tDash("paginationNext")}
          </button>
        </div>
      </nav>
    </section>
  );
}
