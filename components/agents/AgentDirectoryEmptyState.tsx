import { useTranslations } from "next-intl";
import { UserSquare2, AlertTriangle } from "lucide-react";
import { Link } from "@/i18n/navigation";
import Button from "@/components/ui/Button";

export function AgentDirectoryEmptyState({ error = false }: { error?: boolean }) {
  const t = useTranslations("agentDirectory");
  return (
    <div className="border border-pv-ink/[0.1] bg-pv-surface/40 px-4 py-16 text-center">
      {error ? (
        <AlertTriangle className="mx-auto h-8 w-8 text-pv-danger/80 mb-4" />
      ) : (
        <UserSquare2 className="mx-auto h-8 w-8 text-pv-emerald/80 mb-4" />
      )}
      <h3 className="font-display text-lg font-bold text-pv-text">
        {error ? t("errorTitle") : t("emptyStateTitle")}
      </h3>
      <p className="mt-2 text-sm text-pv-muted">
        {error ? t("errorDescription") : t("emptyStateDescription")}
      </p>
      {!error && (
        <div className="mt-6">
          <Link href="/agents/new">
            <Button variant="primary" className="px-6 py-2 text-sm">
              {t("createAction")}
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}