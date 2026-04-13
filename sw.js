'use strict';

importScripts('./sw-version.js');

const CACHE_NAME = 'flashcards-' + CACHE_VERSION;
const CDN_SCRIPT = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';

// ── Install: pre-cache all app files ──────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Cache local app files (must all succeed)
    await cache.addAll(CACHE_FILES);
    // Cache CDN script best-effort (may fail if offline at install time)
    try { await cache.add(CDN_SCRIPT); } catch {}
    await self.skipWaiting();
  })());
});

// ── Activate: delete old caches ────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// ── Fetch: network-first, fall back to cache ───────────────────
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith((async () => {
    // Try network first, with a 10-second timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(event.request, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (resp.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, resp.clone());
      }
      return resp;
    } catch {
      clearTimeout(timeoutId);
      // Network failed or timed out — fall back to cache
      const cached = await caches.match(event.request);
      if (cached) return cached;

      // Versioned URLs like manifest.json?v=... should still resolve to the
      // pre-cached file when offline.
      const cachedIgnoringSearch = await caches.match(event.request, { ignoreSearch: true });
      if (cachedIgnoringSearch) return cachedIgnoringSearch;

      // For page navigations return the cached shell as last resort
      if (event.request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('Offline — resource not cached.', { status: 503 });
    }
  })());
});
