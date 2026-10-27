// Хранилище в браузере (IndexedDB): книги, файлы, место чтения, заметки, настройки.
// Всё лежит на устройстве; синхронизация (sync.js) копирует это в Dropbox и обратно.
const NAME = 'chitalnya', VERSION = 1
const STORES = {
  books: 'id',     // описание книги: название, автор, формат, обложка
  files: 'id',     // сам файл книги (Blob) — отдельно, чтобы список книг грузился быстро
  state: 'id',     // где остановился: cfi, доля прочитанного, когда
  notes: 'id',     // выделения, подчёркивания, заметки, закладки
  kv: 'key',       // настройки и служебные значения
}

let dbp
const open = () => dbp ??= new Promise((resolve, reject) => {
  const req = indexedDB.open(NAME, VERSION)
  req.onupgradeneeded = () => {
    const db = req.result
    for (const [name, keyPath] of Object.entries(STORES)) if (!db.objectStoreNames.contains(name)) {
      const s = db.createObjectStore(name, { keyPath })
      if (name === 'notes') s.createIndex('bookId', 'bookId')
    }
  }
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

const tx = async (store, mode, fn) => {
  const db = await open()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode), s = t.objectStore(store)
    let result
    Promise.resolve(fn(s)).then(r => { result = r })
    t.oncomplete = () => resolve(result)
    t.onerror = t.onabort = () => reject(t.error)
  })
}
const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })

export const db = {
  get: (store, key) => tx(store, 'readonly', s => req(s.get(key))),
  all: (store) => tx(store, 'readonly', s => req(s.getAll())),
  put: (store, value) => tx(store, 'readwrite', s => req(s.put(value))),
  del: (store, key) => tx(store, 'readwrite', s => req(s.delete(key))),
  byBook: (bookId) => tx('notes', 'readonly', s => req(s.index('bookId').getAll(bookId))),
  async kv(key, value) {
    if (value === undefined) return (await this.get('kv', key))?.value
    return this.put('kv', { key, value })
  },
}

// Файлы храним как байты (ArrayBuffer), а не как Blob: так надёжнее во всех браузерах,
// включая WebKit, который не всегда умеет класть Blob в IndexedDB
export const pack = async blob => blob ? { buf: await blob.arrayBuffer(), type: blob.type || '' } : null
export const unpack = x => !x ? null : x instanceof Blob ? x : x.buf ? new Blob([x.buf], { type: x.type || '' }) : null

// Просим браузер не удалять данные при нехватке места (на iPhone это важно)
export const persist = async () => {
  try { return await navigator.storage?.persist?.() } catch { return false }
}
