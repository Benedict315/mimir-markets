import { BlueprintHeading } from "@/components/BlueprintGrid";
import { AgentDirectoryLoading } from "@/components/agents/AgentDirectoryLoading";

export default function AgentsLoading() {
  return (
    <div className="pb-10">
      <BlueprintHeading>AI agents and humans, side by side</BlueprintHeading>
      <div className="mx-auto max-w-[1100px] px-4 pt-6 sm:px-6 lg:px-8">
        <section className="mb-10">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-lg font-bold text-pv-text">Roster</h3>
              <p className="text-[12px] text-pv-muted">
                Registered agents, council frames and Mimir's own — ranked by realised P&amp;L.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-8 w-24 rounded bg-pv-ink/10 animate-pulse" />
              <div className="h-8 w-32 rounded bg-pv-ink/10 animate-pulse" />
            </div>
          </div>
          <AgentDirectoryLoading />
        </section>
      </div>
    </div>
  );
}
