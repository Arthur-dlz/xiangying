export function normalizeDownloadPercent(value: string | number | undefined) {
  const percent = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(percent) || percent < 0) return null;
  return Math.min(100, percent);
}

const BYTE_RATE_UNITS = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"] as const;
const SPEED_PATTERN = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b)(?:(?:\/s)|ps)?$/i;
const SPEED_UNIT_MULTIPLIERS: Record<string, number> = {
  b: 1,
  kb: 1_000,
  mb: 1_000_000,
  gb: 1_000_000_000,
  tb: 1_000_000_000_000,
  kib: 1_024,
  mib: 1_048_576,
  gib: 1_073_741_824,
  tib: 1_099_511_627_776,
};

export function formatDownloadSpeed(value: string | undefined): string {
  const match = SPEED_PATTERN.exec(value?.trim() ?? "");
  if (!match) return "0 B/s";

  const amount = Number.parseFloat(match[1]);
  const multiplier = SPEED_UNIT_MULTIPLIERS[match[2].toLowerCase()];
  const bytesPerSecond = amount * multiplier;
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";

  let unitIndex = 0;
  let normalized = bytesPerSecond;
  while (normalized >= 1_000 && unitIndex < BYTE_RATE_UNITS.length - 1) {
    normalized /= 1_000;
    unitIndex += 1;
  }

  const formatted =
    unitIndex === 0 ? normalized.toFixed(0) : normalized.toFixed(2);
  return `${formatted} ${BYTE_RATE_UNITS[unitIndex]}`;
}

function recordingStartTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function formatRecordingDuration(
  startedAt: string | undefined,
  now = Date.now(),
): string {
  const startTimestamp = recordingStartTimestamp(startedAt);
  if (startTimestamp === null) return "";

  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - startTimestamp) / 1_000),
  );
  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
  const seconds = elapsedSeconds % 60;
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function formatRecordingStartTime(
  startedAt: string | undefined,
  locale?: string,
  timeZone?: string,
): string {
  const startTimestamp = recordingStartTimestamp(startedAt);
  if (startTimestamp === null) return "";

  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  }).format(startTimestamp);
}
