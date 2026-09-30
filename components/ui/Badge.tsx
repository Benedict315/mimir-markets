"use client";

import { useTranslations } from "next-intl";

interface BadgeProps {
  status: string;
  large?: boolean;
  compact?: boolean;
  /**
   * Optional aria-label for accessibility. Defaults to the translated label.
   */
  ariaLabel?: string;
}

const STATUS_COLORS: Record<string, string> = {
  open:      "pv-cyan",
  accepted:  "pv-fuch",
  resolved:  "pv-emerald",
  won:       "pv-emerald",
  lost:      "pv-danger",
  draw:      "pv-muted",
  cancelled: "zinc-500",
  // Copy-trading specific statuses
  active:    "pv-emerald",
  paused:    "pv-muted",
  error:     "pv-danger",
  pending:   "pv-cyan",
};

const colorMap: Record<string, string> = {
  "pv-cyan":    "bg-pv-cyan/[0.1] text-pv-cyan border-pv-cyan/[0.25]",
  "pv-fuch":    "bg-pv-fuch/[0.1] text-pv-fuch border-pv-fuch/[0.25]",
  "pv-emerald": "bg-pv-emerald/[0.1] text-pv-emerald border-pv-emerald/[0.25]",
  "pv-danger":  "bg-pv-danger/[0.1] text-pv-danger border-pv-danger/[0.25]",
  "pv-muted":   "bg-pv-muted/[0.1] text-pv-muted border-pv-muted/[0.25]",
  "pv-gold":    "bg-pv-gold/[0.1] text-pv-gold border-pv-gold/[0.25]",
  "zinc-500":   "bg-zinc-500/[0.1] text-zinc-500 border-zinc-500/[0.25]",
};

export default function Badge({
  status,
  large = false,
  compact = false,
  ariaLabel,
}: BadgeProps) {
  const t = useTranslations("badges");
  const color   = STATUS_COLORS[status] ?? "pv-muted";
  const classes = colorMap[color] ?? colorMap["pv-muted"];
  
  // Fallback to status string if translation key is missing
  const label   = t(status as any) || status;
  const labelToRender = ariaLabel || label;

  return (
    <span
      className={`inline-flex items-center gap-1.5 border font-bold uppercase tracking-[0.1em] rounded ${classes} ${
        compact
          ? "px-2 py-0.5 text-[9px]"
          : large
            ? "px-3 py-1.5 text-[11px]"
            : "px-2.5 py-1 text-[10px]"
      }`}
      aria-label={labelToRender}
    >
      <span
        className={`rounded-full flex-shrink-0 ${
          compact ? "h-2 w-2" : "h-1.5 w-1.5"
        }`}
        style={{ background: "currentColor" }}
      />
      {label}
    </span>
  );
}