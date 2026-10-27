// Офлайн-режим: при установке сохраняем все файлы приложения, дальше отдаём их из кэша.
// Список файлов и версию подставляет build.py при выкладке.
const VERSION = "b3ea660f10"
const FILES = ["./", "README.md", "app.css", "fonts.css", "fonts/CormorantGaramond-italic-500-cyrillic.woff2", "fonts/CormorantGaramond-italic-500-latin.woff2", "fonts/CormorantGaramond-normal-500-cyrillic.woff2", "fonts/CormorantGaramond-normal-500-latin.woff2", "fonts/CormorantGaramond-normal-600-cyrillic.woff2", "fonts/CormorantGaramond-normal-600-latin.woff2", "fonts/Literata-italic-400-cyrillic.woff2", "fonts/Literata-italic-400-latin.woff2", "fonts/Literata-normal-400-cyrillic.woff2", "fonts/Literata-normal-400-latin.woff2", "fonts/Literata-normal-600-cyrillic.woff2", "fonts/Literata-normal-600-latin.woff2", "fonts/Onest-normal-400-cyrillic.woff2", "fonts/Onest-normal-400-latin.woff2", "fonts/Onest-normal-500-cyrillic.woff2", "fonts/Onest-normal-500-latin.woff2", "fonts/Onest-normal-600-cyrillic.woff2", "fonts/Onest-normal-600-latin.woff2", "fonts/PTSerif-italic-400-cyrillic.woff2", "fonts/PTSerif-italic-400-latin.woff2", "fonts/PTSerif-normal-400-cyrillic.woff2", "fonts/PTSerif-normal-400-latin.woff2", "fonts/PTSerif-normal-700-cyrillic.woff2", "fonts/PTSerif-normal-700-latin.woff2", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "index.html", "js/app.js", "js/db.js", "js/formats.js", "js/sync.js", "manifest.webmanifest", "vendor/djvu/djvu.js", "vendor/foliate-js/comic-book.js", "vendor/foliate-js/epub.js", "vendor/foliate-js/epubcfi.js", "vendor/foliate-js/fb2.js", "vendor/foliate-js/fixed-layout.js", "vendor/foliate-js/footnotes.js", "vendor/foliate-js/mobi.js", "vendor/foliate-js/overlayer.js", "vendor/foliate-js/paginator.js", "vendor/foliate-js/pdf.js", "vendor/foliate-js/progress.js", "vendor/foliate-js/search.js", "vendor/foliate-js/text-walker.js", "vendor/foliate-js/tts.js", "vendor/foliate-js/vendor/fflate.js", "vendor/foliate-js/vendor/pdfjs/annotation_layer_builder.css", "vendor/foliate-js/vendor/pdfjs/pdf.mjs", "vendor/foliate-js/vendor/pdfjs/pdf.worker.mjs", "vendor/foliate-js/vendor/pdfjs/standard_fonts/FoxitDingbats.pfb", "vendor/foliate-js/vendor/pdfjs/standard_fonts/FoxitFixed.pfb", "vendor/foliate-js/vendor/pdfjs/standard_fonts/FoxitFixedBold.pfb", "vendor/foliate-js/vendor/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb", "vendor/foliate-js/vendor/pdfjs/standard_fonts/FoxitFixedItalic.pfb", "vendor/foliate-js/vendor/pdfjs/standard_fonts/FoxitSerif.pfb", "vendor/foliate-js/vendor/pdfjs/standard_fonts/FoxitSerifBold.pfb", "vendor/foliate-js/vendor/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb", "vendor/foliate-js/vendor/pdfjs/standard_fonts/FoxitSerifItalic.pfb", "vendor/foliate-js/vendor/pdfjs/standard_fonts/FoxitSymbol.pfb", "vendor/foliate-js/vendor/pdfjs/standard_fonts/LICENSE_FOXIT", "vendor/foliate-js/vendor/pdfjs/standard_fonts/LICENSE_LIBERATION", "vendor/foliate-js/vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf", "vendor/foliate-js/vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf", "vendor/foliate-js/vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf", "vendor/foliate-js/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf", "vendor/foliate-js/vendor/pdfjs/text_layer_builder.css", "vendor/foliate-js/vendor/zip.js", "vendor/foliate-js/view.js", "vendor/libarchive/libarchive.js", "vendor/libarchive/libarchive.wasm", "vendor/libarchive/worker-bundle.js", "vendor/mammoth/mammoth.browser.min.js"]
const CACHE = 'chitalnya-' + VERSION

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('chitalnya-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  // Страница: сначала сеть (чтобы приходили обновления), без сети — из кэша
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./', copy)); return r }).catch(() => caches.match('./', { ignoreSearch: true })))
    return
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)) }
    return r
  })))
})
