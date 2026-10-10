const CACHE_PREFIX = "mediago-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const SHARE_PATH = "/share";
const SHELL_FILES = [
  "/",
  "/manifest.json",
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-192-maskable.png",
  "/icon-512-maskable.png",
];
const SHARE_FIELD_LIMITS = {
  title: 512,
  text: 16 * 1024,
  url: 16 * 1024,
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)),
      self.skipWaiting(),
    ]),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter(
                (key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME,
              )
              .map((key) => caches.delete(key)),
          ),
        ),
      self.clients.claim(),
    ]),
  );
});

function appendShareField(params, formData, name) {
  const value = formData.get(name);
  if (typeof value !== "string") return;
  const normalized = value.trim().slice(0, SHARE_FIELD_LIMITS[name]);
  if (normalized) params.set(name, normalized);
}

async function redirectShareRequest(request) {
  const formData = await request.formData();
  const params = new URLSearchParams();
  appendShareField(params, formData, "title");
  appendShareField(params, formData, "text");
  appendShareField(params, formData, "url");

  const target = new URL("/#/share", self.location.origin);
  const query = params.toString();
  if (query) target.hash = `#/share?${query}`;
  return Response.redirect(target, 303);
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put("/", response.clone());
    }
    return response;
  } catch {
    return (await caches.match("/")) || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (
    request.method === "POST" &&
    url.origin === self.location.origin &&
    url.pathname === SHARE_PATH
  ) {
    const networkFallback = request.clone();
    event.respondWith(
      redirectShareRequest(request).catch(() => fetch(networkFallback)),
    );
    return;
  }

  if (request.method === "GET" && request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
  }
});
