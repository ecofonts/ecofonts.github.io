/**
 * Ecofonts service worker.
 *
 * Strategy:
 * - App shell (pages, manifest, logo) is precached on install.
 * - Navigations are network-first with cache fallback, so HTML stays fresh
 *   online and the app still opens offline.
 * - Build assets under /_astro/ carry content hashes and are immutable, so
 *   they are served cache-first and cached as they stream in — after one
 *   visit (and one optimization run, which pulls the processing chunks) the
 *   whole app works offline.
 */
const CACHE = "ecofonts-v1";
const PRECACHE = ["/", "/font/", "/favicon.svg", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	if (request.mode === "navigate") {
		// Network-first: fresh HTML online, cached shell offline.
		event.respondWith(
			fetch(request)
				.then((response) => {
					const copy = response.clone();
					caches.open(CACHE).then((cache) => cache.put(request, copy));
					return response;
				})
				.catch(() =>
					caches
						.match(request)
						.then((cached) => cached ?? caches.match("/"))
						.then((cached) => cached ?? Response.error()),
				),
		);
		return;
	}

	// Assets: cache-first (hashed /_astro/ files are immutable), cache on miss.
	event.respondWith(
		caches.match(request).then(
			(cached) =>
				cached ??
				fetch(request).then((response) => {
					if (response.ok) {
						const copy = response.clone();
						caches.open(CACHE).then((cache) => cache.put(request, copy));
					}
					return response;
				}),
		),
	);
});
