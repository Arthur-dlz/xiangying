export type ConversionOutputType = "video" | "audio";

export interface StagedMediaFile {
  path: string;
  name: string;
  extension: string;
  kind: ConversionOutputType;
}

export interface AppendStagedMediaResult {
  files: StagedMediaFile[];
  added: number;
  duplicates: number;
  rejected: number;
}

export const OUTPUT_FORMATS: Record<ConversionOutputType, string[]> = {
  video: ["mp4", "mkv", "webm"],
  audio: ["mp3", "aac", "flac", "wav"],
};

export const QUALITY_OPTIONS = ["high", "medium", "low"] as const;

export const MEDIA_DIALOG_FILTERS = [
  {
    name: "Media",
    extensions: [
      "mp4",
      "mkv",
      "webm",
      "mov",
      "avi",
      "flv",
      "m4v",
      "ts",
      "mp3",
      "aac",
      "flac",
      "wav",
      "m4a",
      "ogg",
      "opus",
      "wma",
    ],
  },
];

const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "mkv",
  "webm",
  "mov",
  "avi",
  "flv",
  "m4v",
  "ts",
]);

const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "aac",
  "flac",
  "wav",
  "m4a",
  "ogg",
  "opus",
  "wma",
]);

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").toLocaleLowerCase();
}

export function getPathFileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() || path;
}

export function getPathExtension(path: string): string {
  const name = getPathFileName(path);
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > -1 ? name.slice(dotIndex + 1).toLocaleLowerCase() : "";
}

export function createStagedMediaFile(path: string): StagedMediaFile | null {
  const trimmedPath = path.trim();
  if (!trimmedPath) return null;

  const extension = getPathExtension(trimmedPath);
  const isVideo = VIDEO_EXTENSIONS.has(extension);
  const isAudio = AUDIO_EXTENSIONS.has(extension);
  if (!isVideo && !isAudio) return null;

  return {
    path: trimmedPath,
    name: getPathFileName(trimmedPath),
    extension,
    kind: isAudio ? "audio" : "video",
  };
}

export function appendStagedMediaFiles(
  current: StagedMediaFile[],
  paths: string[],
): AppendStagedMediaResult {
  const files = [...current];
  const seen = new Set(current.map((file) => normalizePath(file.path)));
  let added = 0;
  let duplicates = 0;
  let rejected = 0;

  for (const path of paths) {
    const file = createStagedMediaFile(path);
    if (!file) {
      rejected += 1;
      continue;
    }

    const key = normalizePath(file.path);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }

    seen.add(key);
    files.push(file);
    added += 1;
  }

  return { files, added, duplicates, rejected };
}

const CANCELLED_CONVERSION_ERRORS = new Set([
  "conversion cancelled",
  "cancelled by user",
]);

export function isConversionCancelled(error?: string | null): boolean {
  if (!error) return false;
  return CANCELLED_CONVERSION_ERRORS.has(error.trim().toLocaleLowerCase());
}

export function getConversionStatusKey(
  status: string,
  error?: string | null,
): string {
  if (status === "failed" && isConversionCancelled(error)) {
    return "conversionStatusCancelled";
  }

  switch (status) {
    case "pending":
      return "conversionStatusPending";
    case "converting":
      return "conversionStatusConverting";
    case "done":
      return "conversionStatusDone";
    case "failed":
      return "conversionStatusFailed";
    default:
      return "conversionStatusUnknown";
  }
}

export function getConversionErrorKey(error?: string | null): string {
  if (isConversionCancelled(error)) {
    return "conversionErrorCancelled";
  }

  const normalizedError = error?.trim().toLocaleLowerCase() ?? "";
  if (normalizedError.includes("ffmpeg binary path not configured")) {
    return "conversionErrorUnavailable";
  }
  if (
    normalizedError.includes("failed to start ffmpeg") ||
    normalizedError.includes("failed to get stderr pipe")
  ) {
    return "conversionErrorStartFailed";
  }
  if (
    normalizedError.includes("source file has no audio stream") ||
    normalizedError.includes("output file does not contain any stream")
  ) {
    return "conversionErrorNoAudioStream";
  }
  return "conversionErrorUnknown";
}
