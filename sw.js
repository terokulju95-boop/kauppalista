// ============================================================
//  Kauppalista – Service Worker
//  MUISTA: nosta APP_VERSION aina kun julkaiset uuden version.
//  Ilman sitä puhelin ei koskaan huomaa päivitystä.
// ============================================================
const APP_VERSION = "4.0.2";

const BASE        = "/kauppalista/";
const SHELL_CACHE = "kauppalista-shell-" + APP_VERSION;
const LIB_CACHE   = "kauppalista-lib-" + APP_VERSION;
const SHELL_KEY   = BASE + "index.html";

// Kuinka kauan verkkoa odotetaan ennen kuin näytetään välimuistista (ms)
const NETWORK_TIMEOUT = 2500;

const PRECACHE = [
  BASE,
  BASE + "index.html",
  BASE + "manifest.json",
  BASE + "icons/icon-192.png",
  BASE + "icons/icon-512.png"
];

// ---------- ASENNUS ----------
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // allSettled: yksi puuttuva ikoni ei kaada koko asennusta
    await Promise.allSettled(
      PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload" })))
    );
  })());
  // EI skipWaiting() tässä – odotetaan että käyttäjä hyväksyy päivityksen.
});

// Sovellus pyytää uutta versiota käyttöön
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// ---------- AKTIVOINTI ----------
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith("kauppalista-") && k !== SHELL_CACHE && k !== LIB_CACHE)
        .map((k) => caches.delete(k))
    );
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) {}
    }
    await self.clients.claim();
  })());
});

// ---------- APUFUNKTIO ----------
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

// ---------- PYYNNÖT ----------
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Firestore-liikenteeseen ei kosketa koskaan.
  // Firebase hoitaa itse offline-jonon ja pitkäkestoiset yhteydet.
  if (
    url.hostname.endsWith("googleapis.com") ||
    url.hostname.endsWith("firebaseio.com") ||
    url.hostname.endsWith("firebaseapp.com") ||
    url.hostname.endsWith("google.com")
  ) return;

  // 1) Sovelluksen avaus -> VERKKO ENSIN (näin päivitys tulee perille)
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);

      const fromNetwork = (async () => {
        const preload = await event.preloadResponse;
        const res = preload || (await fetch(req));
        if (res && res.ok) cache.put(SHELL_KEY, res.clone());
        return res;
      })();

      const cached = await cache.match(SHELL_KEY);
      if (!cached) {
        try { return await fromNetwork; } catch (e) { return Response.error(); }
      }

      // Odotetaan verkkoa hetki; jos kenttä on huono, näytetään välimuisti
      // ja verkkohaku päivittää välimuistin taustalla seuraavaa avausta varten.
      const winner = await Promise.race([
        fromNetwork.catch(() => null),
        new Promise((r) => setTimeout(() => r(null), NETWORK_TIMEOUT))
      ]);
      return winner || cached;
    })());
    return;
  }

  // 2) Firebase-kirjastot gstaticista -> välimuistista, päivitys taustalla.
  //    Ilman tätä sovellus ei käynnisty lainkaan ilman nettiä.
  if (url.hostname === "www.gstatic.com") {
    event.respondWith(staleWhileRevalidate(req, LIB_CACHE));
    return;
  }

  // 3) Omat ikonit ym. -> välimuistista, päivitys taustalla
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
  }
});
