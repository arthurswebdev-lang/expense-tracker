# Dev Guide

Reference guide for a minimal, installable iOS-friendly mobile web app. No build step, no framework, no dependencies — just static files. Copy this file as-is into a new repo.

## Tech Stack

- **HTML / CSS / vanilla JavaScript** — no framework, no bundler, no transpiler, no `package.json`.
- **IndexedDB** — client-side persistent storage (structured data, offline-first, survives reloads).
- **Service Worker** — caches static assets for offline use and repeat-visit speed.
- **Web App Manifest** (`manifest.json`) — makes the site installable ("Add to Home Screen").
- **iOS PWA meta tags** — `apple-mobile-web-app-capable`, `apple-touch-icon`, status bar styling, since iOS Safari only partially supports the standard manifest spec.
- **CSS safe-area insets** (`env(safe-area-inset-*)`) — keeps layout clear of the iPhone notch/Dynamic Island and home indicator.

No CI, no linter, no test runner by default — add them only if the project actually needs them.

## Typical File Structure

```
index.html      entry point / single-page shell
styles.css      all styling
app.js          application logic
manifest.json   PWA manifest
sw.js           service worker (offline caching)
icons/          app icons (192x192, 512x512, apple-touch-icon)
```

## Required `<head>` Boilerplate

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<link rel="manifest" href="manifest.json">
<meta name="theme-color" content="#000000">

<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="App Name">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
```

## `manifest.json` Template

```json
{
  "name": "App Name",
  "short_name": "App",
  "start_url": "./index.html",
  "scope": "./",
  "display": "standalone",
  "background_color": "#000000",
  "theme_color": "#000000",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

Keep `start_url` and `scope` relative (`./`) — this makes the app work regardless of whether it's hosted at a domain root or a subpath (e.g. GitHub Pages project sites).

## Service Worker Template

```js
const CACHE_NAME = "app-cache-v1"; // bump on every deploy to force refresh
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first: prefer a fresh copy while online, fall back to cache offline.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
```

Register it in `app.js`:

```js
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
}
```

## Cache Busting

iOS Safari caches static assets aggressively. Append a version query string to CSS/JS links and bump it on every deploy:

```html
<link rel="stylesheet" href="styles.css?v=2">
<script src="app.js?v=2"></script>
```

Also bump `CACHE_NAME` in `sw.js` on every deploy — otherwise the service worker keeps serving stale assets.

## Local Development

No build step needed — just serve the folder statically:

```bash
python3 -m http.server 8000
# or
npx serve
```

Open `http://localhost:8000` in a browser. To test iOS-specific behavior (install prompt, safe areas, status bar), use an actual iPhone on the same network, or Safari's device simulator via Xcode.

## Deploying to GitHub Pages

1. Push the project to a GitHub repository (files at the repo root, or in a `docs/` folder).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a branch".
4. Choose the branch (e.g. `main`) and folder (`/root` or `/docs`), then **Save**.
5. Wait a minute for the first build; the site will be live at:
   `https://<username>.github.io/<repo-name>/`
6. Because the site is served from a subpath, all asset paths must be relative (`./styles.css`, not `/styles.css`) — otherwise assets 404 on Pages while working fine locally.
7. After every push, bump the cache-busting query strings and `CACHE_NAME` (see above) so returning users get the update instead of a stale cached copy.
8. Optional — custom domain: add a `CNAME` file at the repo root containing the domain, and configure the DNS record to point at GitHub Pages.

No further configuration is required — GitHub Pages serves static files directly, and this stack has no build step to run in CI.
