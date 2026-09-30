export const RESOLUTION_SOURCE_TYPES = ["official", "media", "other"] as const;

export type ResolutionSourceType = (typeof RESOLUTION_SOURCE_TYPES)[number];

export type ResolutionSourceMetadataDraft = {
  sourceType: ResolutionSourceType | "";
  resolutionTarget: string;
};

export function formatSettlementRuleWithSourceMetadata(
  settlementRule: string,
  metadata: ResolutionSourceMetadataDraft
): string {
  const sourceType = metadata.sourceType;
  const resolutionTarget = metadata.resolutionTarget.trim();

  if (!sourceType && !resolutionTarget) {
    return settlementRule;
  }

  const metadataLines = [
    "Resolution source metadata (creator-provided, unverified):",
    ...(sourceType ? [`Source type: ${sourceType}`] : []),
    ...(resolutionTarget ? [`Resolution target: ${resolutionTarget}`] : []),
  ].join("\n");
  const rule = settlementRule.trim();

  return rule ? `${rule}\n\n${metadataLines}` : metadataLines;
}