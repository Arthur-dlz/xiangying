import type {
  PageAdapter,
  PageCard,
  PageTransport,
} from "./site-adapters/types";

const BUTTON_TAG = "mediago-download-button";

const STYLES = `
  .mg-button {
    appearance: none;
    -webkit-appearance: none;
    color: #fff;
    background-color: #409eff;
    border: 0;
    padding: 0 5px;
    border-radius: 4px;
    cursor: pointer;
    display: inline-block;
    text-align: center;
    text-decoration: none;
    outline: none;
    font: inherit;
    font-size: 14px;
    line-height: 1.5;
    position: absolute;
    top: 5px;
    right: 5px;
    z-index: 30;
  }
  .mg-button:hover {
    background-color: #66b1ff;
  }
  .mg-button:focus-visible {
    outline: 2px solid #005fcc;
    outline-offset: 2px;
  }
`;

export interface PageRuntimeOptions {
  adapter: PageAdapter;
  document: Document;
  transport: PageTransport;
}

interface RuntimeInjection {
  button: HTMLButtonElement;
  card: PageCard;
  handleClick: (event: MouseEvent) => void;
  host: HTMLElement;
  key: string;
}

function releaseInjection(adapter: PageAdapter, injection: RuntimeInjection) {
  const { button, card, handleClick, host } = injection;
  button.removeEventListener("click", handleClick);
  host.remove();
  adapter.clearProcessed(card);
}

function injectButton(
  document: Document,
  card: PageCard,
  adapter: PageAdapter,
  transport: PageTransport,
): RuntimeInjection | null {
  if (card.querySelector(BUTTON_TAG)) return null;
  const key = adapter.extractCandidate(card)?.url;
  if (!key) return null;

  const host = document.createElement(BUTTON_TAG);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLES;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "mg-button";
  button.textContent = "下载";
  const handleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const candidate = adapter.extractCandidate(card);
    if (candidate) transport(candidate);
  };
  button.addEventListener("click", handleClick);

  shadow.appendChild(style);
  shadow.appendChild(button);
  card.appendChild(host);
  adapter.markProcessed(card);

  return { button, card, handleClick, host, key };
}

export function startPageRuntime({
  adapter,
  document,
  transport,
}: PageRuntimeOptions): () => void {
  let active = true;
  const injections = new Set<RuntimeInjection>();
  const stopObserving = adapter.observe(document, (card) => {
    if (!active) return;

    const injection = injectButton(document, card, adapter, transport);
    if (injection) injections.add(injection);
  });
  const MutationObserverConstructor =
    document.defaultView?.MutationObserver ?? MutationObserver;
  const removalObserver = new MutationObserverConstructor(() => {
    for (const injection of injections) {
      const currentKey = adapter.extractCandidate(injection.card)?.url;
      if (
        injection.card.isConnected &&
        injection.host.isConnected &&
        currentKey === injection.key
      ) {
        continue;
      }
      releaseInjection(adapter, injection);
      injections.delete(injection);
    }
  });
  removalObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["href"],
    childList: true,
    subtree: true,
  });

  return () => {
    if (!active) return;

    active = false;
    stopObserving();
    removalObserver.disconnect();

    for (const injection of injections) {
      releaseInjection(adapter, injection);
    }
    injections.clear();
  };
}
