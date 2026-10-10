import { createServer } from "node:http";

const ERROR_LIMIT = 512;

export interface StartedTestPage {
  url: string;
  blankURL: string;
  close(): Promise<void>;
}

export interface StartTestPageOptions {
  marker?: string;
  title?: string;
}

function fixtureHTML(sampleURL: string, options: StartTestPageOptions): string {
  const serializedURL = JSON.stringify(sampleURL).replaceAll("<", "\\u003c");
  const serializedMarker = JSON.stringify(
    options.marker ?? "fixture",
  ).replaceAll("<", "\\u003c");
  const title = (options.title ?? "MediaGo E2E Fixture")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
  </head>
  <body>
    <main><h1>MediaGo E2E Fixture</h1></main>
    <script>
      window.fixtureExecutionState = { marker: ${serializedMarker}, ticks: 0 };
      history.replaceState({ marker: ${serializedMarker} }, "");
      setInterval(() => { window.fixtureExecutionState.ticks += 1; }, 50);
      window.fixtureMediaLoaded = false;
      fetch(${serializedURL})
        .then((response) => {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.arrayBuffer();
        })
        .then(() => { window.fixtureMediaLoaded = true; })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          window.fixtureMediaLoaded = message.slice(0, ${ERROR_LIMIT});
        });
    </script>
  </body>
</html>`;
}

const blankHTML = Buffer.from(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>MediaGo E2E Neutral Fixture</title>
  </head>
  <body>
    <main><h1>MediaGo E2E Neutral Fixture</h1></main>
  </body>
</html>`);

export async function startTestPage(
  sampleURL: string,
  options: StartTestPageOptions = {},
): Promise<StartedTestPage> {
  const mediaHTML = Buffer.from(fixtureHTML(sampleURL, options));
  const server = createServer((request, response) => {
    const body =
      request.method === "GET"
        ? request.url === "/"
          ? mediaHTML
          : request.url === "/blank"
            ? blankHTML
            : undefined
        : undefined;
    if (!body) {
      response.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": "10",
      });
      response.end("Not Found\n");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(body.length),
      "Cache-Control": "no-store",
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => reject(error);
    server.once("error", handleError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", handleError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Fixture page did not bind to a loopback TCP port");
  }
  const baseURL = "http://127.0.0.1:" + address.port;
  return {
    url: `${baseURL}/`,
    blankURL: `${baseURL}/blank`,
    close: async () => {
      server.closeAllConnections();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
