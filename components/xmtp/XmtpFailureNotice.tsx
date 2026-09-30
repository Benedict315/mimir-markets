"use client";

/**
 * Aviso de fallo de XMTP con reintento, compartido por el panel de VS y el hub.
 *
 * Un solo lugar decide cómo se ve un fallo, para que provider (arranque), hilo
 * (apertura/stream) y envío no tengan tres treatments distintos.
 *
 * ── Reglas de privacidad y accesibilidad ────────────────────────────────────
 *
 * - El mensaje crudo del SDK **nunca** es el titular. Va en un `<details>` de
 *   soporte porque puede contener el InboxID (identificador estable del usuario) o
 *   rutas OPFS: útil para soporte, no para la pantalla.
 * - `danger` usa `role="alert"` (asertivo, interrumpe lector de pantalla) y
 *   `warning` usa `role="status"` (educativo): un hilo que se quedó viejo no es
 *   una emergencia, y no debe interrumpir lo que el usuario estaba leyendo.
 * - El botón de reintento se serializa con `isRetrying`: pulsar Retry durante un
 *   `Client.create` en vuelo lo cancelaría a medias.
 * - Cuando el aviso ya no es recuperable, se dice en pantalla en lugar de dejar
 *   un botón que no puede funcionar.
 */

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { MonitorSmartphone, RefreshCw, TriangleAlert } from "lucide-react";
import {
  isXmtpRetryDisabled,
  xmtpFailureMessageKey,
  type XmtpFailure,
} from "@/lib/xmtp/failure-state";

export type XmtpFailureNoticeProps = {
  /** `null` no renderiza nada: el aviso sigue a la presencia del fallo. */
  failure: XmtpFailure | null;
  tone?: "danger" | "warning";
  /** Hay un intento en vuelo: el botón se deshabilita y anuncia `aria-busy`. */
  isRetrying?: boolean;
  onRetry?: () => void;
  /** Copy extra por debajo del mensaje (p. ej. "puede estar desactualizado"). */
  children?: ReactNode;
  /** Acción complementaria al reintento (p. ej. abrir XMTP Inbox Tools). */
  action?: ReactNode;
  /** Eyebrow propio; por defecto usa la copy genérica de la UI. */
  eyebrow?: string;
  className?: string;
};

const TONE_CLASSES = {
  danger:
    "border-pv-danger/30 bg-pv-danger/[0.05] text-pv-danger shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]",
  warning: "border-amber-400/25 bg-amber-400/[0.06] text-amber-300",
} as const;

const EYEBROW_CLASSES = {
  danger: "text-pv-danger/90",
  warning: "text-amber-200/85",
} as const;

export default function XmtpFailureNotice({
  failure,
  tone = "danger",
  isRetrying = false,
  onRetry,
  children,
  action,
  eyebrow,
  className = "",
}: XmtpFailureNoticeProps) {
  const t = useTranslations("xmtpVs");
  if (!failure) return null;

  const retryDisabled = isXmtpRetryDisabled(failure, isRetrying);
  const showRetry = Boolean(onRetry) && failure.retryable;
  const NoticeIcon = tone === "warning" ? MonitorSmartphone : TriangleAlert;

  return (
    <div
      role={tone === "warning" ? "status" : "alert"}
      aria-live={tone === "warning" ? "polite" : "assertive"}
      className={`overflow-hidden rounded-xl border ${TONE_CLASSES[tone]} ${className}`}
    >
      <div
        className={`flex items-center gap-1.5 px-3.5 py-2.5 sm:px-4 ${
          tone === "danger" ? "border-b border-pv-ink/[0.06] bg-pv-bg/25" : ""
        }`}
      >
        <NoticeIcon size={14} className="shrink-0 opacity-80" aria-hidden />
        <p
          className={`text-[10px] font-bold uppercase tracking-[0.14em] ${
            EYEBROW_CLASSES[tone]
          }`}
        >
          {eyebrow ?? t("failureEyebrow")}
        </p>
      </div>

      <div className="px-3.5 py-3 sm:px-4 sm:py-3.5">
        <p className="text-xs leading-relaxed text-pv-text/90 [overflow-wrap:anywhere]">
          {t(xmtpFailureMessageKey(failure.kind))}
        </p>
        {children ? (
          <div className="mt-1.5 text-[11px] leading-relaxed text-pv-muted">
            {children}
          </div>
        ) : null}

        {failure.escalated ? (
          <p className="mt-2.5 text-[11px] leading-relaxed text-pv-muted">
            {t("failureEscalated")}
          </p>
        ) : null}

        {!failure.retryable ? (
          <p className="mt-2.5 text-[11px] leading-relaxed text-pv-muted">
            {t("failureNotRetryable")}
          </p>
        ) : null}

        {action ? <div className="mt-4">{action}</div> : null}

        {showRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={retryDisabled}
            aria-busy={isRetrying || undefined}
            className="mt-3 inline-flex items-center gap-1.5 text-left text-xs font-semibold text-pv-emerald hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
          >
            <RefreshCw
              size={13}
              className={`shrink-0 ${isRetrying ? "animate-spin" : ""}`}
              aria-hidden
            />
            {isRetrying ? t("retrying") : t("retry")}
          </button>
        ) : null}

        {failure.technical ? (
          <details className="mt-3 group">
            <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.12em] text-pv-muted/70 hover:text-pv-muted">
              {t("failureTechnicalDetails")}
            </summary>
            <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-pv-muted/70 [overflow-wrap:anywhere]">
              {failure.technical}
            </p>
          </details>
        ) : null}
      </div>
    </div>
  );
}
