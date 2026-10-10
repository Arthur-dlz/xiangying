import type { Input } from "electron";

type BrowserRefreshInput = Pick<
  Input,
  "alt" | "control" | "key" | "meta" | "shift" | "type"
>;

export function getBrowserRefreshShortcut(
  input: BrowserRefreshInput,
): "reload" | "force-reload" | null {
  if (input.type !== "keyDown" || input.alt) return null;

  const key = input.key.toLowerCase();
  if (key === "f5") return input.shift ? "force-reload" : "reload";
  if (key !== "r" || (!input.control && !input.meta)) return null;
  return input.shift ? "force-reload" : "reload";
}
