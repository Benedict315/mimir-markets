export function parseSeedAnchor(value?: string, nowMs = Date.now()): number {
  if (value === undefined) return Math.floor(nowMs / 1000);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error("--at must be an ISO-8601 timestamp with an explicit timezone");
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("--at is not a valid ISO-8601 timestamp");
  return Math.floor(timestamp / 1000);
}

export function seedDeadline(anchorSeconds: number, offsetSeconds: number): number {
  return anchorSeconds + offsetSeconds;
}