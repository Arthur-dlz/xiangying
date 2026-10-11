interface BeforeQuitEvent {
  preventDefault(): void;
}

interface GracefulQuitApp {
  on(event: "before-quit", listener: (event: BeforeQuitEvent) => void): unknown;
  quit(): void;
}

export function registerGracefulQuit(
  app: GracefulQuitApp,
  shutdown: () => Promise<void>,
  onError: (error: unknown) => void,
): void {
  let stopping = false;
  let quitting = false;

  app.on("before-quit", (event) => {
    if (quitting) {
      // This is the resumed quit we triggered after shutdown. Let it proceed,
      // but re-arm the guard: if another listener cancels this quit the app
      // keeps running, and the next attempt must run the graceful shutdown
      // again instead of exiting without it.
      quitting = false;
      stopping = false;
      return;
    }

    event.preventDefault();
    if (stopping) return;

    stopping = true;
    void Promise.resolve()
      .then(shutdown)
      .catch((error) => {
        try {
          onError(error);
        } catch {
          // Swallow errors thrown by the error handler so the quit can resume.
        }
      })
      .finally(() => {
        quitting = true;
        app.quit();
      });
  });
}
