import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type FC, type ReactNode, useEffect, useRef } from "react";
import useSWR from "swr";
import type { TaskOrigin } from "@mediago/common";
import { getDockerDownloadLog } from "@/api/docker-download-task";
import { getDownloadLog } from "@/api/download-task";
import { usePlatform } from "@/hooks/use-platform";
import { cn } from "@/utils";

interface TerminalProps {
  className?: string;
  id: number;
  origin?: TaskOrigin;
  header?: ReactNode;
}

const Terminal: FC<TerminalProps> = ({
  className,
  id,
  origin = "local",
  header,
}) => {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const { on, off } = usePlatform();
  const { data } = useSWR(
    { key: "download-log", args: { id, origin } },
    ({ args }) =>
      args.origin === "docker"
        ? getDockerDownloadLog(args.id)
        : getDownloadLog(args.id),
  );

  useEffect(() => {
    const element = terminalRef.current;
    if (!element) return;

    const terminal = new XTerminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 3000,
      theme: {
        background: "#0b0d12",
        foreground: "#c8d0dc",
        cursor: "#34d399",
        selectionBackground: "#334155",
        black: "#111827",
        red: "#fb7185",
        green: "#34d399",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e5e7eb",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(element);
    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        // The dialog may be closing while ResizeObserver delivers a frame.
      }
    };
    const frame = requestAnimationFrame(fit);

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const isCopy =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "c";
      if (!isCopy) return true;
      const selection = terminal.getSelection();
      if (!selection) return true;
      void navigator.clipboard.writeText(selection).catch(() => undefined);
      event.preventDefault();
      return false;
    });

    if (data?.log) terminal.write(data.log);

    const onDownloadMessage = (...args: unknown[]) => {
      const messageId = args[1];
      const message = args[2];
      if (id === messageId && typeof message === "string") {
        terminal.write(message);
      }
    };
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(element);
    if (origin === "local") on("download-message", onDownloadMessage);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      if (origin === "local") off("download-message", onDownloadMessage);
      terminal.dispose();
    };
  }, [data, id, off, on, origin]);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {header}
      <div ref={terminalRef} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
};

export default Terminal;
