/**
 * Superficies del dashboard — alineadas a `ArenaCard` en Explorer: panel gris `pv-surface`
 * frente al fondo `pv-bg`, borde `white/[0.12]`, hover como en Arena (`#242323` + borde emerald).
 *
 * Evitar fondos muy transparentes que se confundan con el fondo de página.
 */

/** Tarjeta estándar: filas de lista, contenedor de VS, KPI (paridad `ArenaCard`). */
export const DASHBOARD_CARD_SURFACE =
  "rounded-xl border border-pv-ink/[0.12] bg-pv-surface";

/** Hover para KPI y bloques planos interactivos (paridad `ArenaCard`). */
export const DASHBOARD_CARD_HOVER =
  "transition-[border-color,background-color] duration-200 hover:border-pv-emerald/40 hover:bg-pv-surface2";

/** Panel con padding (filtros, perfil de riesgo, quick actions). */
export const DASHBOARD_PANEL_SURFACE = `${DASHBOARD_CARD_SURFACE} p-4 sm:p-5`;

/** Estados vacíos / sin coincidencias (mismo relleno gris, borde discontinuo). */
export const DASHBOARD_SURFACE_DASHED =
  "rounded-xl border border-dashed border-pv-ink/[0.12] bg-pv-surface";

/** Barra de resumen, "load more" (tono gris intermedio, misma familia cromática). */
export const DASHBOARD_SURFACE_MUTED =
  "rounded-xl border border-pv-ink/[0.1] bg-pv-surface2/35";

/** Placeholder de carga de filas. */
export const DASHBOARD_SKELETON_ROW =
  "rounded-xl border border-pv-ink/[0.12] bg-pv-surface2/50";

/** Celdas de stats dentro de filas (mismo patrón que `ArenaCard`). */
export const DASHBOARD_STAT_CELL_SURFACE =
  "rounded border border-pv-ink/[0.1] bg-pv-ink/[0.03] px-3 py-2.5 sm:px-3.5 sm:py-3";

/**
 * Paginación del dashboard — contrato de UI para cargar posiciones por lotes.
 *
 * El dashboard carga posiciones desde la cadena (chain-as-source-of-truth); el
 * cliente solo pagina lo ya cargado y nunca invalida el estado de la cadena.
 */

/** Tamaño de página predeterminado para las posiciones del dashboard. */
export const DASHBOARD_PAGE_SIZE = 10 as const;

/** Tamaño máximo de página permitido (límite de entrada de contrato). */
export const DASHBOARD_MAX_PAGE_SIZE = 100 as const;

/** Tamaño mínimo de página permitido. */
export const DASHBOARD_MIN_PAGE_SIZE = 1 as const;

/** Estado de carga de la fábrica de paginación. */
export type DashboardPaginationStatus =
  | "idle"
  | "loading"
  | "ready"
  | "invalid"
  | "stale"
  | "disconnected"
  | "dependency-failure";

/** Razón de la falla de paginación para reportar a la UI. */
export type DashboardPaginationFailure =
  | "none"
  | "invalid-page"
  | "invalid-page-size"
  | "out-of-range"
  | "stale-source"
  | "wallet-disconnected"
  | "data-source-unavailable";

/** Entrada de paginación normalizada y segura. */
export interface DashboardPaginationInput {
  page: number;
  pageSize: number;
}

/** Resultado de normalizar una entrada de paginación. */
export interface DashboardPaginationResolved {
  page: number;
  pageSize: number;
  offset: number;
  failure: DashboardPaginationFailure;
}

/** Metadatos de paginación para la barra de resumen y el control de página. */
export interface DashboardPaginationMeta {
  totalItems: number;
  totalPages: number;
  page: number;
  pageSize: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

/** Estado de paginación expuesto a la UI del dashboard. */
export interface DashboardPaginationState {
  status: DashboardPaginationStatus;
  failure: DashboardPaginationFailure;
  page: number;
  pageSize: number;
  meta: DashboardPaginationMeta;
}

/** Estado inicial de la fábrica de paginación. */
export const DASHBOARD_PAGINATION_INITIAL: DashboardPaginationState = {
  status: "idle",
  failure: "none",
  page: 1,
  pageSize: DASHBOARD_PAGE_SIZE,
  meta: {
    totalItems: 0,
    totalPages: 0,
    page: 1,
    pageSize: DASHBOARD_PAGE_SIZE,
    hasPrevious: false,
    hasNext: false,
  },
};

/** Mensajes de estado para la UI de paginación. */
export const DASHBOARD_PAGINATION_MESSAGES: Record<DashboardPaginationStatus, string> = {
  idle: "",
  loading: "Cargando posiciones…",
  ready: "",
  invalid: "La página solicitada no es válida.",
  stale: "Los datos de la cadena cambiaron; refrescá para ver la versión actual.",
  disconnected: "Conectá tu cartera para ver tus posiciones.",
  "dependency-failure": "No pudimos cargar las posiciones. Intentá de nuevo.",
};

/** Mensajes de falla específicas de paginación. */
export const DASHBOARD_PAGINATION_FAILURE_MESSAGES: Record<
  DashboardPaginationFailure,
  string
|> = {
  none: "",
  "invalid-page": "El número de página debe ser un entero positivo.",
  "invalid-page-size": "El tamaño de página debe ser un entero entre 1 y 100.",
  "out-of-range": "Esa página no tiene posiciones.",
  "stale-source": "La cadena devolvió números distintos a los mostrados.",
  "wallet-disconnected": "La cartera se desconectó mientras cargabas.",
  "data-source-unavailable": "El origen de datos de la cadena no está disponible.",
};

/** Contrato de entrada de la fábrica de paginación. */
export interface DashboardPaginationContract {
  pageSize: number;
  maxPageSize: number;
  minPageSize: number;
}

/** Contrato de paginación expuesto a los loaders del dashboard. */
export const DASHBOARD_PAGINATION_CONTRACT: DashboardPaginationContract = {
  pageSize: DASHBOARD_PAGE_SIZE,
  maxPageSize: DASHBOARD_MAX_PAGE_SIZE,
  minPageSize: DASHBOARD_MIN_PAGE_SIZE,
};

/** Verifica si un valor es un entero finito. */
function isFiniteInteger(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value);
}

/** Normaliza el tamaño de página dentro del contrato. */
function normalizePageSize(pageSize: number): number {
  if (!isFiniteInteger(pageSize)) {
    return DASHBOARD_PAGINATION_CONTRACT.pageSize;
  }
  if (pageSize < DASHBOARD_PAGINATION_CONTRACT.minPageSize) {
    return DASHBOARD_PAGINATION_CONTRACT.minPageSize;
  }
  if (pageSize > DASHBOARD_PAGINATION_CONTRACT.maxPageSize) {
    return DASHBOARD_PAGINATION_CONTRACT.maxPageSize;
  }
  return pageSize;
}

/** Normaliza el número de página a un entero positivo. */
function normalizePage(page: number): number {
  if (!isFiniteInteger(page) || page < 1) {
    return 1;
  }
  return page;
}

/**
 * Resuelve una entrada de paginación a un resultado normalizado y determinista.
 *
 * La falla reportada es el motivo más relevante para la UI: un valor inválido
 * se considera inválido a pesar de normalizarse a un valor seguro.
 */
export function resolveDashboardPaginationInput(
  input: DashboardPaginationInput,
): DashboardPaginationResolved {
  const pageInvalid = !isFiniteInteger(input.page) || input.page < 1;
  const pageSizeInvalid =
    !isFiniteInteger(input.pageSize) ||
    input.pageSize < DASHBOARD_PAGINATION_CONTRACT.minPageSize ||
    input.pageSize > DASHBOARD_PAGINATION_CONTRACT.maxPageSize;

  const page = normalizePage(input.page);
  const pageSize = normalizePageSize(input.pageSize);

  const failure: DashboardPaginationFailure = pageInvalid
    ? "invalid-page"
    : pageSizeInvalid
      ? "invalid-page-size"
      : "none";

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    failure,
  };
}

/** Construye los metadatos de paginación a partir del total de elementos. */
export function buildDashboardPaginationMeta(
  totalItems: number,
  page: number,
  pageSize: number,
): DashboardPaginationMeta {
  const safeTotal = isFiniteInteger(totalItems) && totalItems > 0 ? totalItems : 0;
  const safePageSize = normalizePageSize(pageSize);
  const totalPages = Math.ceil(safeTotal / safePageSize);
  const safePage = totalPages === 0 ? 1 : Math.min(normalizePage(page), totalPages);

  return {
    totalItems: safeTotal,
    totalPages,
    page: safePage,
    pageSize: safePageSize,
    hasPrevious: safePage > 1,
    hasNext: totalPages > 0 && safePage < totalPages,
  };
}

/** Construye el estado de paginación para la UI del dashboard. */
export function buildDashboardPaginationState(params: {
  totalItems: number;
  page: number;
  pageSize: number;
  isLoading?: boolean;
  isDisconnected?: boolean;
  isStale?: boolean;
  isDependencyUnavailable?: boolean;
}): DashboardPaginationState {
  const resolved = resolveDashboardPaginationInput({
    page: params.page,
    pageSize: params.pageSize,
  });

  const meta = buildDashboardPaginationMeta(
    params.totalItems,
    resolved.page,
    resolved.pageSize,
  );

  let status: DashboardPaginationStatus;
  if (params.isDisconnected) {
    status = "disconnected";
  } else if (params.isDependencyUnavailable) {
    status = "dependency-failure";
  } else if (params.isStale) {
    status = "stale";
  } else if (params.isLoading) {
    status = "loading";
  } else if (resolved.failure !== "none") {
    status = "invalid";
  } else if (meta.totalPages > 0 && resolved.page > meta.totalPages) {
    status = "invalid";
  } else {
    status = "ready";
  }

  const failure: DashboardPaginationFailure =
    status === "disconnected"
      ? "wallet-disconnected"
      : status === "dependency-failure"
        ? "data-source-unavailable"
        : status === "stale"
          ? "stale-source"
          : resolved.failure !== "none"
            ? resolved.failure
            : meta.totalPages > 0 && resolved.page > meta.totalPages
              ? "out-of-range"
              : "none";

  return {
    status,
    failure,
    page: meta.page,
    pageSize: meta.pageSize,
    meta,
  };
}

/** Coge una página de posiciones de forma segura, sin mutar la fuente. */
export function paginateDashboardPositions<T>(
  items: readonly T<[],
  page: number,
  pageSize: number,
): { items: T[]; meta: DashboardPaginationMeta } {
  const resolved = resolveDashboardPaginationInput({ page, pageSize });
  const meta = buildDashboardPaginationMeta(
    items.length,
    resolved.page,
    resolved.pageSize,
  );
  const start = (meta.page - 1) * meta.pageSize;
  const end = start + meta.pageSize;

  return {
    items: items.slice(start, end),
    meta,
  };
}

/** Clases de la barra de paginación (consistente con las superficies). */
export const DASHBOARD_PAGINATION_BAR = `${DASHBOARD_SURFACE_MUTED} flex flex-wrap items-center justify-between gap-3 px-3 sm:px-4`;

/** Clases del botón de paginación. */
export const DASHBOARD_PAGINATION_BUTTON =
  "rounded-lg border border-pv-ink/[0.12] bg-pv-surface px-3 py-1.5 text-sm font-medium transition-[border-color,background-color] duration-200 hover:border-pv-emerald/40 hover:bg-pv-surface2 disabled:cursor-not-allowed disabled:opacity-50";
