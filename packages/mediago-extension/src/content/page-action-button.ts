import type { PageActionCopy } from "./page-action-copy";

export interface CreatePageActionButtonOptions {
  document: Document;
  iconUrl: string;
  copy: PageActionCopy;
  onActivate: () => Promise<void>;
  failureResetMs?: number;
}

export interface PageActionButton {
  host: HTMLDivElement;
  button: HTMLButtonElement;
  setCopy(copy: PageActionCopy): void;
  destroy(): void;
}

type ButtonState = "idle" | "busy" | "failure";

const BUTTON_CSS = `
  :host { color-scheme: light; }
  button {
    appearance: none;
    align-items: center;
    background: #ffffff;
    border: 1px solid rgba(15, 23, 42, 0.14);
    border-radius: 999px;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16);
    box-sizing: border-box;
    color: #111827;
    display: inline-flex;
    font: 600 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    gap: 7px;
    min-height: 34px;
    padding: 8px 12px;
    white-space: nowrap;
  }
  button:not(:disabled) { cursor: pointer; }
  button:focus-visible {
    outline: 2px solid #2563eb;
    outline-offset: 2px;
  }
  button[aria-busy="true"] {
    cursor: progress;
    opacity: 0.78;
  }
  button[data-state="failure"] {
    border-color: rgba(220, 38, 38, 0.35);
    color: #b91c1c;
  }
  img { display: block; flex: none; height: 16px; width: 16px; }
`;

export function createPageActionButton({
  document,
  iconUrl,
  copy: initialCopy,
  onActivate,
  failureResetMs = 2_500,
}: CreatePageActionButtonOptions): PageActionButton {
  const host = document.createElement("div");
  host.dataset.mediagoPageAction = "";
  host.style.setProperty("all", "initial", "important");
  host.style.setProperty("display", "block", "important");
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty("top", "16px", "important");
  host.style.setProperty("right", "16px", "important");
  host.style.setProperty("z-index", "2147483647", "important");

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = BUTTON_CSS;
  const button = document.createElement("button");
  button.type = "button";
  const icon = document.createElement("img");
  icon.src = iconUrl;
  icon.alt = "";
  icon.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  button.append(icon, label);
  shadow.append(style, button);
  document.documentElement.append(host);

  let copy = initialCopy;
  let state: ButtonState = "idle";
  let destroyed = false;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  const render = () => {
    button.dataset.state = state;
    button.setAttribute("aria-label", copy.accessibleName);
    button.disabled = state === "busy";
    if (state === "busy") button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
    label.textContent = copy[state];
  };

  const clearReset = () => {
    if (resetTimer === undefined) return;
    clearTimeout(resetTimer);
    resetTimer = undefined;
  };

  const handleClick = async (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (destroyed || state === "busy") return;
    clearReset();
    state = "busy";
    render();
    try {
      await onActivate();
      if (destroyed) return;
      state = "idle";
    } catch {
      if (destroyed) return;
      state = "failure";
      resetTimer = setTimeout(() => {
        resetTimer = undefined;
        if (destroyed || state !== "failure") return;
        state = "idle";
        render();
      }, failureResetMs);
    }
    render();
  };

  button.addEventListener("click", handleClick);
  render();

  return {
    host,
    button,
    setCopy(nextCopy) {
      if (destroyed) return;
      copy = nextCopy;
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearReset();
      button.removeEventListener("click", handleClick);
      host.remove();
    },
  };
}
