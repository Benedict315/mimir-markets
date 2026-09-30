const fs = require('fs');
let code = fs.readFileSync('components/agents/AgentRoster.tsx', 'utf8');

code = code.replace(
  'export function AgentRoster({ agents }: { agents: AgentWithPerformance[] }) {',
  'import { AgentDirectoryEmptyState } from \'@/components/agents/AgentDirectoryEmptyState\';\nexport function AgentRoster({ agents }: { agents: AgentWithPerformance[] | null }) {\n  if (!agents) return <AgentDirectoryEmptyState error={true} />;'
);

code = code.replace(
  /if \(ranked\.length === 0\) \{\s*return \(\s*<p className="border border-pv-ink\/\[0\.1\] bg-pv-surface\/40 px-4 py-6 text-sm text-pv-muted">\s*No agents are configured in this deploy\.\s*<\/p>\s*\);\s*\}/,
  'if (ranked.length === 0) return <AgentDirectoryEmptyState />;'
);

fs.writeFileSync('components/agents/AgentRoster.tsx', code);
