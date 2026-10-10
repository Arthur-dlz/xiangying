import { type FC, useEffect, useRef } from "react";
import { cn } from "@/utils";
import { usePlatform } from "@/hooks/use-platform";

interface DivRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const computeRect = (rect: DivRect) => {
  if (!rect) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: Math.floor(rect.left),
    y: Math.floor(rect.top),
    width: Math.floor(rect.width),
    height: Math.floor(rect.height),
  };
};

interface WebViewProps {
  tabId: string;
  className?: string;
  boundsInset?: Partial<Record<"top" | "right" | "bottom" | "left", number>>;
}

const WebView: FC<WebViewProps> = ({ tabId, className, boundsInset }) => {
  const webviewRef = useRef<HTMLDivElement>(null);
  const resizeObserver = useRef<ResizeObserver>(null);
  const rafId = useRef<number>(0);

  const { browser } = usePlatform();

  useEffect(() => {
    if (!webviewRef.current) return;

    // Monitor the size of webview elements, throttled to one IPC call per frame
    resizeObserver.current = new ResizeObserver((entries) => {
      if (rafId.current) cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(() => {
        if (!webviewRef.current) return;

        const rect = computeRect(webviewRef.current.getBoundingClientRect());
        const entry = entries[0];
        const viewRect = computeRect(entry.contentRect);
        const top = boundsInset?.top ?? 0;
        const right = boundsInset?.right ?? 0;
        const bottom = boundsInset?.bottom ?? 0;
        const left = boundsInset?.left ?? 0;
        viewRect.x += rect.x + left;
        viewRect.y += rect.y + top;
        viewRect.width = Math.max(0, viewRect.width - left - right);
        viewRect.height = Math.max(0, viewRect.height - top - bottom);
        browser.setBounds(tabId, viewRect);
      });
    });

    resizeObserver.current.observe(webviewRef.current);
    browser.show(tabId);

    return () => {
      if (rafId.current) cancelAnimationFrame(rafId.current);
      resizeObserver.current?.disconnect();
      browser.hide(tabId);
    };
  }, [
    boundsInset?.bottom,
    boundsInset?.left,
    boundsInset?.right,
    boundsInset?.top,
    browser,
    tabId,
  ]);

  return <div ref={webviewRef} className={cn(className)} />;
};

export default WebView;
