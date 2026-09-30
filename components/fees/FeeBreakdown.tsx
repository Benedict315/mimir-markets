"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { getFeePolicy } from "@/lib/contract";
import { FEE_SCHEDULE } from "@/lib/fees";
import { Skeleton } from "@/components/ui/Skeleton";

export type FeeBreakdownContext = "agent" | "basket" | "follow";

export function FeeBreakdown({
  context,
  isOwn = false,
}: {
  context: FeeBreakdownContext;
  isOwn?: boolean;
}) {
  const t = useTranslations("fees");

  const [policy, setPolicy] = useState<{ platform_fee_bps: number; agent_owner_fee_bps: number } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    getFeePolicy()
      .then((p) => {
        if (active) {
          setPolicy(p);
          setError(false);
        }
      })
      .catch((err) => {
        console.warn("[FeeBreakdown] Failed to load fee policy:", err);
        if (active) {
          setError(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <div className="text-pv-danger text-sm">
        {t("loadFailed")}
      </div>
    );
  }

  if (!policy) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-full max-w-sm" />
        <Skeleton className="h-4 w-3/4 max-w-sm" />
      </div>
    );
  }

  const platformPct = (policy.platform_fee_bps / 100).toFixed(2);
  const agentPct = (policy.agent_owner_fee_bps / 100).toFixed(2);
  const basketPct = (FEE_SCHEDULE.basketCreatorBps / 100).toFixed(2);

  if (context === "agent") {
    return (
      <section className="mt-6 border border-pv-ink/[0.1] bg-pv-surface/30 p-4">
        <h2 className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">
          {t("agentWhatYouEarn")}
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-pv-muted">
          {t.rich("agentDescription1", {
            agent: agentPct,
            platform: platformPct,
            strong: (chunks) => <strong className="text-pv-text">{chunks}</strong>,
          })}
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-pv-muted">
          {t("agentDescription2")}
        </p>
      </section>
    );
  }

  if (context === "basket") {
    return (
      <section className="mt-6 border border-pv-ink/[0.1] bg-pv-surface/30 p-4">
        <h2 className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">
          {t("basketWhatYouEarn")}
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-pv-muted">
          {t.rich("basketDescription1", {
            basket: basketPct,
            agent: agentPct,
            platform: platformPct,
            strong: (chunks) => <strong className="text-pv-text">{chunks}</strong>,
          })}
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-pv-muted">
          {t("basketDescription2")}
        </p>
      </section>
    );
  }

  if (context === "follow") {
    return (
      <p className="mt-3 text-[11px] text-pv-muted">
        {t("followDescription", {
          platform: platformPct,
          agent: agentPct,
          basketPart: isOwn
            ? t("followBasketIsOwn")
            : t("followBasketCreator", { basket: basketPct }),
        })}
      </p>
    );
  }

  return null;
}
