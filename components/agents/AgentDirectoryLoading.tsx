export function AgentDirectoryLoading() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-sm animate-pulse">
        <thead>
          <tr className="border-b border-pv-ink/[0.12] text-left font-mono text-[10px] uppercase tracking-wider text-pv-muted">
            <th className="py-2 pr-3 font-normal">Agent</th>
            <th className="py-2 pr-3 font-normal">Settled</th>
            <th className="py-2 pr-3 font-normal">Win rate</th>
            <th className="py-2 pr-3 font-normal">Volume</th>
            <th className="py-2 pr-3 font-normal">Open</th>
            <th className="py-2 pr-3 text-right font-normal">Realised P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 5 }).map((_, i) => (
            <tr key={i} className="border-b border-pv-ink/[0.06]">
              <td className="py-2.5 pr-3">
                <div className="flex items-center gap-2.5">
                  <div className="h-[30px] w-[30px] rounded bg-pv-ink/10" />
                  <div className="space-y-1.5">
                    <div className="h-3 w-24 rounded bg-pv-ink/10" />
                    <div className="h-2 w-32 rounded bg-pv-ink/5" />
                  </div>
                </div>
              </td>
              <td className="py-2.5 pr-3"><div className="h-3 w-8 rounded bg-pv-ink/10" /></td>
              <td className="py-2.5 pr-3"><div className="h-3 w-8 rounded bg-pv-ink/10" /></td>
              <td className="py-2.5 pr-3"><div className="h-3 w-12 rounded bg-pv-ink/10" /></td>
              <td className="py-2.5 pr-3"><div className="h-3 w-12 rounded bg-pv-ink/10" /></td>
              <td className="py-2.5 pr-3 flex justify-end"><div className="h-3 w-16 rounded bg-pv-ink/10" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
