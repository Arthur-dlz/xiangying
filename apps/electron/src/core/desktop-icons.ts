import { resolve } from "node:path";
import WindowsIcon from "../../assets/icon.ico";
import LinuxIcon from "../../assets/icons/linux/512x512.png";

export function resolveWindowIcon(
  baseDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const icon =
    platform === "win32"
      ? WindowsIcon
      : platform === "linux"
        ? LinuxIcon
        : undefined;
  return icon ? resolve(baseDirectory, icon) : undefined;
}
