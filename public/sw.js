const CACHE_NAME = 'hush-shell-v4'
const STATIC_SHELL = ['/manifest.webmanifest', '/hush-mark.png', '/hush-app-icon.svg']

async function cacheResource(cache, resourceUrl) {
  try {
    const response = await fetch(resourceUrl, { cache: 'reload' })
    if (response.ok) await cache.put(resourceUrl, response.clone())
    return response
  } catch {
    return null
  }
}

async function precacheApp() {
  const cache = await caches.open(CACHE_NAME)
  const indexResponse = await cacheResource(cache, '/index.html')
  if (indexResponse) {
    await cache.put('/', indexResponse.clone())
    const html = await indexResponse.text()
    const assetPaths = [...html.matchAll(/(?:src|href)="([^"#]+)"/gu)]
      .map((match) => new URL(match[1], self.location.origin))
      .filter((url) => url.origin === self.location.origin)
    const assetResponses = await Promise.all(assetPaths.map(async (url) => ({ url, response: await cacheResource(cache, url.href) })))
    const stylesheets = assetResponses.filter(({ url, response }) => response && url.pathname.endsWith('.css'))
    await Promise.all(stylesheets.map(async ({ url, response }) => {
      const css = await response.text()
      const nestedAssets = [...css.matchAll(/url\((?:'|")?([^)'"#]+)(?:'|")?\)/gu)]
        .map((match) => new URL(match[1], url))
        .filter((nestedUrl) => nestedUrl.origin === self.location.origin && !nestedUrl.href.startsWith('data:'))
      await Promise.all(nestedAssets.map((nestedUrl) => cacheResource(cache, nestedUrl.href)))
    }))
  }
  await Promise.all(STATIC_SHELL.map((url) => cacheResource(cache, url)))
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheApp())
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy))
          return response
        })
        .catch(() => caches.match('/index.html')),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone()
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
      }
      return response
    })),
  )
})
