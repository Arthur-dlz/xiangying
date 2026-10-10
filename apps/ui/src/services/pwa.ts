interface ServiceWorkerContainerLike {
  register(
    scriptURL: string | URL,
    options?: RegistrationOptions,
  ): Promise<ServiceWorkerRegistration>;
}

interface PwaRegistrationEnvironment {
  isSecureContext: boolean;
  readyState: DocumentReadyState;
  serviceWorker?: ServiceWorkerContainerLike;
  addLoadListener(listener: () => void): void;
}

function browserEnvironment(): PwaRegistrationEnvironment {
  return {
    isSecureContext: window.isSecureContext,
    readyState: document.readyState,
    serviceWorker: navigator.serviceWorker,
    addLoadListener: (listener) =>
      window.addEventListener("load", listener, { once: true }),
  };
}

export function registerPwaServiceWorker(
  environment: PwaRegistrationEnvironment = browserEnvironment(),
): void {
  if (!environment.isSecureContext || !environment.serviceWorker) return;

  const register = () => {
    void environment.serviceWorker
      ?.register("/service-worker.js", { scope: "/" })
      .catch(() => {
        // PWA support is optional; the normal Web application remains usable.
      });
  };

  if (environment.readyState === "complete") {
    register();
  } else {
    environment.addLoadListener(register);
  }
}
