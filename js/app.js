// Читальня: полка, чтение, выделения и заметки. Книги и заметки хранятся на устройстве (db.js),
// формат книги разбирает formats.js, синхронизацию между телефоном и ПК делает sync.js через Dropbox.
import '../vendor/foliate-js/view.js'
import { Overlayer } from '../vendor/foliate-js/overlayer.js'
import { db, persist, pack, unpack } from './db.js'
import { openBookFile, describe, extOf, FORMATS, CONVERT } from './formats.js'
import { sync } from './sync.js'

const $ = id => document.getElementById(id)
const root = document.documentElement
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const now = () => Date.now()
const today = () => new Date().toLocaleDateString('sv')
const isTouch = matchMedia('(hover: none)').matches

/* ---------- Настройки ---------- */
const THEMES = [
  { k: 'mist', n: 'Туман', bg: '#f7f7f2', fg: '#1e2420', link: '#2f5d50', dark: false },
  { k: 'linen', n: 'Лён', bg: '#f3ead8', fg: '#33281c', link: '#7b3b2a', dark: false },
  { k: 'snow', n: 'Белый', bg: '#ffffff', fg: '#16191d', link: '#2b4a8a', dark: false },
  { k: 'graphite', n: 'Графит', bg: '#14171a', fg: '#d3d6cf', link: '#c6a55f', dark: true },
]
const FONTS = [
  { k: 'Literata', css: '"Literata", Georgia, serif', d: 'книжный, мягкий' },
  { k: 'PT Serif', css: '"PT Serif", Georgia, serif', d: 'классика, плотный' },
  { k: 'Cormorant', css: '"Cormorant Garamond", Georgia, serif', d: 'изящный, крупный' },
  { k: 'Onest', css: '"Onest", system-ui, sans-serif', d: 'без засечек' },
  { k: 'Как в книге', css: '', d: 'шрифт издателя' },
]
const HL = { 1: '#f2d66b', 2: '#9fd29a', 3: '#9cc6ea', 4: '#f1a9b4', 5: '#c8b4ef' }
const S = { theme: '', font: 0, fs: 19, lh: 1.6, margin: 'normal', align: 'justify', flow: 'paginated' }

const theme = () => THEMES.find(t => t.k === S.theme) || (matchMedia('(prefers-color-scheme: dark)').matches ? THEMES[3] : THEMES[0])
function applyTheme() {
  if (S.theme) root.dataset.read = S.theme; else delete root.dataset.read
  document.querySelector('meta[name=theme-color]').content = getComputedStyle(root).getPropertyValue('--paper').trim() || '#14171a'
}

/* ---------- Мелочи интерфейса ---------- */
let toastT
const toast = (m, ms = 2600) => { const t = $('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms) }
const openSheet = (title, html) => { $('shTitle').textContent = title; $('shBody').innerHTML = html; $('shBody').scrollTop = 0; $('scrim').classList.add('on'); $('sheet').classList.add('on'); $('shBody').onclick = null }
const closeSheet = () => { $('scrim').classList.remove('on'); $('sheet').classList.remove('on') }
$('scrim').addEventListener('click', closeSheet)
const fmtMin = m => m < 1 ? 'меньше минуты' : m < 60 ? Math.round(m) + ' мин' : Math.floor(m / 60) + ' ч ' + Math.round(m % 60) + ' мин'
const plural = (n, a, b, c) => n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c

/* ---------- Обложки ---------- */
const PALETTE = [['#2f4a3f', '#efe8d6'], ['#6d2e2a', '#f1e3cf'], ['#203247', '#dfe6ee'], ['#3b3a40', '#e8dfcc'], ['#8a6a3a', '#f6ecd6'], ['#4a3b5e', '#ece4f4'], ['#2e5252', '#e2efe9'], ['#d9cdb4', '#2b2620']]
const hashN = s => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
const coverURLs = new Map()
const coverHtml = b => {
  const blob = unpack(b.cover)
  if (blob) {
    let u = coverURLs.get(b.id)
    if (!u) { u = URL.createObjectURL(blob); coverURLs.set(b.id, u) }
    return `<div class="cover"><img src="${u}" alt="" loading="lazy"></div>`
  }
  const h = hashN(b.id), [cb, cc] = PALETTE[h % PALETTE.length], v = ['v1', 'v2', 'v3'][h % 3]
  const ti = esc(b.title), au = esc(b.author || FORMATS[b.ext] || '')
  return `<div class="cover ${v}" style="--cb:${cb};--cc:${cc}"><div class="in">${v === 'v3' ? `<div class="ti">${ti}</div><div class="au">${au}</div>` : v === 'v2' ? `<div class="au">${au}</div><div class="ti">${ti}</div><div class="orn"></div>` : `<div class="au">${au}</div><div class="rule"></div><div class="ti">${ti}</div>`}</div></div>`
}
// Уменьшаем обложку до 400 px, чтобы полка была лёгкой и быстро синхронизировалась
const shrinkCover = async blob => {
  try {
    const bmp = await createImageBitmap(blob)
    const k = Math.min(1, 400 / bmp.width), c = document.createElement('canvas')
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k)
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
    return await new Promise(r => c.toBlob(r, 'image/jpeg', .85))
  } catch { return null }
}

/* ---------- Полка ---------- */
let books = [], states = new Map(), filter = 'all', query = ''
async function loadLibrary() {
  books = (await db.all('books')).filter(b => !b.deleted)
  states = new Map((await db.all('state')).map(s => [s.id, s]))
  renderLibrary()
}
const progressOf = id => states.get(id)?.fraction || 0
const lastOpened = id => states.get(id)?.updated || 0
async function renderLibrary() {
  const d = new Date(), h = d.getHours()
  $('today').textContent = (h < 5 ? 'Ночь' : h < 12 ? 'Утро' : h < 18 ? 'День' : 'Вечер') + ', ' + d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
  const sorted = [...books].sort((a, b) => (lastOpened(b.id) || b.added) - (lastOpened(a.id) || a.added))
  const cur = sorted.find(b => lastOpened(b.id) && progressOf(b.id) < .995)
  const allNotes = (await db.all('notes')).filter(n => !n.deleted && n.kind !== 'bm')
  if (cur) {
    const p = progressOf(cur.id), C = 2 * Math.PI * 16, st = states.get(cur.id)
    const last = allNotes.filter(n => n.bookId === cur.id).sort((a, b) => b.created - a.created)[0]
    $('continueSlot').innerHTML = `<button class="continue" data-open="${cur.id}">${coverHtml(cur)}<div class="meta"><span class="eyebrow">Продолжить чтение</span><h2>${esc(cur.title)}</h2><span class="by">${esc(cur.author || FORMATS[cur.ext] || '')}${st?.chapter ? ' · ' + esc(st.chapter) : ''}</span>
      <div class="ring"><svg viewBox="0 0 38 38"><circle cx="19" cy="19" r="16" fill="none" stroke="var(--line)" stroke-width="3"/><circle cx="19" cy="19" r="16" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${C * p} ${C}"/></svg><span><b>${Math.round(p * 100)}%</b> прочитано${st?.left ? '<br>≈ ' + fmtMin(st.left) + ' до конца книги' : ''}</span></div>
      ${last ? `<div class="quote-line">«${esc(last.text)}»</div>` : ''}</div></button>`
  } else if (!books.length) {
    $('continueSlot').innerHTML = `<div class="welcome"><h2>Добро пожаловать</h2><p>Добавьте первую книгу кнопкой «+» или перетащите файл сюда. Книги хранятся на этом устройстве, а с синхронизацией появятся и на других.</p><button class="btn primary" id="welcomeAdd">Добавить книгу</button><div class="fmts">${[...new Set(Object.values(FORMATS))].map(f => `<span class="fmt">${f}</span>`).join('')}</div></div>`
    $('welcomeAdd').onclick = () => $('fileInput').click()
  } else $('continueSlot').innerHTML = ''
  // Статистика: минуты сегодня, дни подряд, цитаты
  const times = (await db.kv('time')) || {}
  // Серия: дни подряд, когда читали хотя бы минуту; сегодняшний день не обрывает серию, пока он не кончился
  let streak = 0
  for (let i = 0; i < 3650; i++) {
    const k = new Date(Date.now() - i * 864e5).toLocaleDateString('sv')
    if ((times[k] || 0) >= 60) streak++
    else if (i > 0) break
  }
  const mins = Math.round((times[today()] || 0) / 60)
  $('stats').innerHTML = `<div><b>${mins}</b><span>${plural(mins, 'минута', 'минуты', 'минут')} сегодня</span></div><div><b>${streak}</b><span>${plural(streak, 'день', 'дня', 'дней')} подряд</span></div><div><b>${allNotes.length}</b><span>${plural(allNotes.length, 'цитата', 'цитаты', 'цитат')}</span></div>`
  $('stats').hidden = !books.length
  $('searchbar').hidden = books.length < 8
  let list = sorted
  if (filter === 'now') list = list.filter(b => progressOf(b.id) > 0 && progressOf(b.id) < .995)
  if (filter === 'done') list = list.filter(b => progressOf(b.id) >= .995)
  if (query) list = list.filter(b => (b.title + ' ' + b.author).toLowerCase().includes(query))
  $('shelf').innerHTML = list.map(b => {
    const p = progressOf(b.id)
    return `<button class="book" data-open="${b.id}" data-id="${b.id}">${coverHtml(b)}${b.remote ? '<span class="cloud" title="В облаке, скачается при открытии"><svg class="ic" viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 00.5-8 5.5 5.5 0 00-10.6 1.5A3.3 3.3 0 007 18z"/></svg></span>' : ''}<div class="t">${esc(b.title)}</div><div class="s"><span class="fmt">${FORMATS[b.ext] || b.ext.toUpperCase()}</span>${p >= .995 ? 'прочитано' : p ? Math.round(p * 100) + '%' : 'новая'}</div>${p > 0 && p < .995 ? `<div class="pbar"><i style="width:${p * 100}%"></i></div>` : ''}</button>`
  }).join('') || (books.length ? '<div class="empty-shelf">Ничего не нашлось</div>' : '')
}
$('filters').addEventListener('click', e => { const b = e.target.closest('[data-filter]'); if (!b) return; filter = b.dataset.filter; for (const x of $('filters').children) x.classList.toggle('on', x === b); renderLibrary() })
$('shelfSearch').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); renderLibrary() })

// Долгое нажатие или правый щелчок по книге — меню книги
let pressT
$('shelf').addEventListener('contextmenu', e => { const b = e.target.closest('[data-id]'); if (b) { e.preventDefault(); bookMenu(b.dataset.id) } })
$('shelf').addEventListener('touchstart', e => { const b = e.target.closest('[data-id]'); if (b) pressT = setTimeout(() => { pressT = 'fired'; bookMenu(b.dataset.id) }, 550) }, { passive: true })
$('shelf').addEventListener('touchend', e => { if (pressT === 'fired') e.preventDefault(); clearTimeout(pressT) })
$('shelf').addEventListener('touchmove', () => clearTimeout(pressT), { passive: true })
async function bookMenu(id) {
  const b = books.find(x => x.id === id); if (!b) return
  const p = progressOf(id)
  openSheet(b.title, `<p class="hint">${esc(b.author || 'Автор не указан')} · ${FORMATS[b.ext] || b.ext} · ${(b.size / 1048576).toFixed(1)} МБ${b.remote ? ' · в облаке' : ''}</p>
    <div class="btnrow"><button class="btn primary" data-m="open">Читать</button><button class="btn" data-m="done">${p >= .995 ? 'Читаю заново' : 'Прочитано'}</button></div>
    <div class="btnrow"><button class="btn" data-m="rename">Переименовать</button><button class="btn danger" data-m="del">Удалить</button></div>`)
  $('shBody').onclick = async e => {
    const m = e.target.closest('[data-m]')?.dataset.m; if (!m) return
    if (m === 'open') { closeSheet(); openReader(id) }
    if (m === 'done') { const st = { ...(states.get(id) || { id }), fraction: p >= .995 ? 0 : 1, cfi: p >= .995 ? null : states.get(id)?.cfi, updated: now() }; await db.put('state', st); states.set(id, st); closeSheet(); renderLibrary(); sync.soon() }
    if (m === 'rename') {
      $('shBody').innerHTML = `<input class="field" id="rnT" value="${esc(b.title)}" aria-label="Название"><div style="height:10px"></div><input class="field" id="rnA" value="${esc(b.author)}" placeholder="Автор" aria-label="Автор"><div class="btnrow"><button class="btn" data-act="sheet-close">Отмена</button><button class="btn primary" id="rnSave">Сохранить</button></div>`
      $('rnSave').onclick = async () => { b.title = $('rnT').value.trim() || b.title; b.author = $('rnA').value.trim(); b.updated = now(); await db.put('books', b); closeSheet(); renderLibrary(); sync.soon() }
    }
    if (m === 'del') {
      $('shBody').innerHTML = `<p class="hint">Книга «${esc(b.title)}» удалится с этого устройства${sync.enabled() ? ' и из облака, то есть со всех устройств' : ''}. Заметки к ней тоже удалятся.</p><div class="btnrow"><button class="btn" data-act="sheet-close">Отмена</button><button class="btn danger" id="delOk">Удалить</button></div>`
      $('delOk').onclick = async () => { await removeBook(id); closeSheet(); toast('Книга удалена') }
    }
  }
}
async function removeBook(id) {
  const b = books.find(x => x.id === id); if (!b) return
  Object.assign(b, { deleted: true, updated: now(), cover: null }); await db.put('books', b)
  await db.del('files', id)
  for (const n of await db.byBook(id)) await db.del('notes', n.id)
  coverURLs.delete(id); await loadLibrary(); sync.soon()
}

/* ---------- Добавление книг ---------- */
const sha = async blob => {
  // Один и тот же файл на телефоне и ПК получает один номер: так книги не задваиваются при синхронизации
  const part = blob.size > 8e6 ? new Blob([blob.slice(0, 4e6), blob.slice(-4e6), String(blob.size)]) : blob
  const h = await crypto.subtle.digest('SHA-256', await part.arrayBuffer())
  return [...new Uint8Array(h)].slice(0, 12).map(x => x.toString(16).padStart(2, '0')).join('')
}
async function addFiles(fileList) {
  const files = [...fileList]; if (!files.length) return
  let added = 0, lastId
  for (const [i, file] of files.entries()) {
    const ext = extOf(file.name)
    if (CONVERT[ext]) { convertHelp(ext, file.name); continue }
    if (!FORMATS[ext] && ext !== 'zip') { toast(`«${file.name}»: это не книга. Подходят ${[...new Set(Object.values(FORMATS))].join(', ')}`, 5000); continue }
    toast(files.length > 1 ? `Добавляю ${i + 1} из ${files.length}…` : 'Добавляю книгу…', 60000)
    try {
      const id = await sha(file)
      const ex = await db.get('books', id)
      if (ex && !ex.deleted) { toast(`«${ex.title}» уже на полке`); lastId = id; continue }
      const book = await openBookFile(file)
      const d = await describe(book, file)
      book.destroy?.()
      const cover = d.cover ? await shrinkCover(d.cover) : null
      const realExt = ext === 'zip' ? extOf(book.metadata?.title || '') || 'zip' : ext
      await db.put('files', { id, data: await pack(file), name: file.name })
      await db.put('books', { id, title: d.title || file.name, author: d.author, ext: realExt, name: file.name, size: file.size, cover: await pack(cover), added: now(), updated: now() })
      added++; lastId = id
    } catch (e) {
      console.error(e)
      toast(`Не удалось открыть «${file.name}»: ${e.message || e}`, 6000)
    }
  }
  await loadLibrary()
  if (added) { toast(added === 1 ? 'Книга на полке' : `Добавлено книг: ${added}`); persist(); sync.soon() }
  return lastId
}
function convertHelp(ext, name) {
  openSheet('Нужна конвертация', `<p class="hint">«${esc(name)}» в формате ${CONVERT[ext]}. Этот старый формат не умеет читать ни одна читалка в браузере.</p>
   <p class="hint">Переведите его в EPUB бесплатной программой Calibre на компьютере:<ol><li>Скачайте Calibre с сайта <b>calibre-ebook.com</b> и установите.</li><li>Перетащите файл в окно Calibre.</li><li>Нажмите «Преобразовать книги», формат вывода EPUB, «OK».</li><li>Правый щелчок по книге → «Открыть папку с книгой» и добавьте EPUB сюда.</li></ol></p>
   <div class="btnrow"><button class="btn primary" data-act="sheet-close">Понятно</button></div>`)
}
$('addBtn').addEventListener('click', () => $('fileInput').click())
$('fileInput').addEventListener('change', async e => { const f = e.target.files; await addFiles(f); e.target.value = '' })
// Перетаскивание файлов на ПК
let dragN = 0
addEventListener('dragenter', e => { if ([...e.dataTransfer?.types || []].includes('Files')) { dragN++; $('dropzone').classList.add('on') } })
addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; $('dropzone').classList.remove('on') } })
addEventListener('dragover', e => e.preventDefault())
addEventListener('drop', async e => { e.preventDefault(); dragN = 0; $('dropzone').classList.remove('on'); if (e.dataTransfer?.files?.length) { const id = await addFiles(e.dataTransfer.files); if (id && e.dataTransfer.files.length === 1) openReader(id) } })

/* ---------- Цитаты ---------- */
async function renderQuotes() {
  const notes = (await db.all('notes')).filter(n => !n.deleted && n.kind !== 'bm').sort((a, b) => b.created - a.created)
  const byId = new Map(books.map(b => [b.id, b]))
  $('quoteList').innerHTML = notes.length ? notes.map(n => { const b = byId.get(n.bookId); return b ? `<button class="qcard" data-jump="${n.bookId}|${esc(n.value)}"><span class="sw" style="background:${n.kind === 'ul' ? 'var(--accent)' : HL[n.color] || HL[1]}"></span><q>${esc(n.text)}</q>${n.note ? `<em>${esc(n.note)}</em>` : ''}<footer><span>${esc(b.title)}${n.chapter ? ' · ' + esc(n.chapter) : ''}</span><span>${n.kind === 'ul' ? 'подчёркнуто' : 'выделено'}</span></footer></button>` : '' }).join('')
    : '<div class="empty"><b>Пока пусто</b>Выделите строчку в книге — она появится здесь.</div>'
}
$('exportBtn').addEventListener('click', async () => {
  const notes = (await db.all('notes')).filter(n => !n.deleted && n.kind !== 'bm')
  const md = books.map(b => { const ns = notes.filter(n => n.bookId === b.id); return ns.length ? `## ${b.title}${b.author ? ' — ' + b.author : ''}\n\n` + ns.map(n => `> ${n.text}\n${n.note ? '\n' + n.note + '\n' : ''}`).join('\n') : '' }).filter(Boolean).join('\n')
  if (!md) return toast('Цитат пока нет')
  try { await navigator.clipboard.writeText(md); toast('Все цитаты скопированы в формате Markdown') } catch { toast('Не удалось скопировать') }
})
function showTab(t) {
  for (const x of document.querySelectorAll('[data-tab]')) x.classList.toggle('on', x.dataset.tab === t)
  $('library').hidden = t !== 'library'; $('quotes').hidden = t !== 'quotes'
  if (t === 'quotes') renderQuotes()
}

/* ---------- Чтение ---------- */
let view = null, cur = null, notes = [], docs = new Map(), lastLoc = null, saveT, readTimer, perScreen = 0
const cssFor = () => {
  const t = theme(), f = FONTS[S.font]
  return `
  @namespace epub "http://www.idpf.org/2007/ops";
  ${fontFaceCSS}
  html { color-scheme: ${t.dark ? 'dark' : 'light'}; background: ${t.bg} !important; color: ${t.fg} !important; }
  body { background: none !important; color: inherit !important; ${f.css ? `font-family: ${f.css} !important;` : ''} }
  ${f.css ? `p, li, blockquote, dd, div, span, td { font-family: inherit !important; }` : ''}
  html { font-size: ${S.fs}px !important; }
  p, li, blockquote, dd, div { line-height: ${S.lh} !important; }
  p, li, blockquote, dd { text-align: ${S.align === 'justify' ? 'justify' : 'start'}; -webkit-hyphens: auto; hyphens: auto; widows: 2; orphans: 2; }
  [align="left"] { text-align: left; } [align="right"] { text-align: right; } [align="center"] { text-align: center; }
  a:link, a:visited { color: ${t.link} !important; }
  img, svg { max-width: 100%; height: auto; }
  ${t.dark ? 'img { filter: brightness(.9); }' : ''}
  pre { white-space: pre-wrap !important; }
  ::selection { background: ${t.dark ? 'rgba(198,165,95,.35)' : 'rgba(47,93,80,.22)'}; }
  aside[epub|type~="footnote"], aside[epub|type~="endnote"], aside[epub|type~="rearnote"] { display: none; }`
}
let fontFaceCSS = ''
fetch(new URL('../fonts.css', import.meta.url)).then(r => r.text()).then(t => { fontFaceCSS = t.replace(/url\(fonts\//g, `url(${new URL('../fonts/', import.meta.url).href}`) }).catch(() => {})
const MARGINS = { narrow: 18, normal: 32, wide: 56 }
function applyReaderStyle() {
  if (!view?.renderer) return
  const r = view.renderer
  r.setAttribute('flow', S.flow)
  r.setAttribute('margin', '18px')
  r.setAttribute('gap', (MARGINS[S.margin] / Math.max(320, innerWidth) * 200).toFixed(1) + '%')
  r.setAttribute('max-inline-size', '660px')
  r.setAttribute('max-column-count', '2')
  r.setAttribute('animated', '')
  r.setStyles?.(cssFor())
  perScreen = 0 // шрифт или поля поменялись — заново считаем, сколько текста на странице
  const t = theme()
  view.style.setProperty('--overlayer-highlight-opacity', t.dark ? '.42' : '.55')
  view.style.setProperty('--overlayer-highlight-blend-mode', t.dark ? 'normal' : 'multiply')
}

async function openReader(id, target) {
  const b = books.find(x => x.id === id) || await db.get('books', id); if (!b) return
  cur = b; hideSel(); perScreen = 0
  $('rTitle').textContent = b.title; $('cTitle').textContent = b.title; $('cAuthor').textContent = b.author || ''
  $('rChap').textContent = $('rLeft').textContent = $('rPage').textContent = ''
  const r = $('reader'); r.hidden = false; r.classList.remove('ui')
  $('loading').classList.remove('off'); $('loadingText').textContent = 'Открываю книгу…'
  requestAnimationFrame(() => { r.classList.remove('closed'); $('library').classList.add('away') })
  $('tabbar').hidden = true
  try {
    let rec = await db.get('files', id)
    if (!rec && b.remote) { $('loadingText').textContent = 'Скачиваю книгу из облака…'; rec = await sync.fetchBook(b); if (!rec) throw new Error('не удалось скачать из облака') ; b.remote = false; await db.put('books', b) }
    if (!rec) throw new Error('файла книги нет на этом устройстве')
    const file = new File([unpack(rec.data) || rec.blob], rec.name || b.name || ('book.' + b.ext))
    const book = await openBookFile(file)
    if (cur !== b) return
    view?.close?.(); view?.remove()
    docs = new Map()
    view = document.createElement('foliate-view')
    $('stage').replaceChildren(view)
    notes = (await db.byBook(id)).filter(n => !n.deleted)
    view.addEventListener('load', onDocLoad)
    view.addEventListener('relocate', onRelocate)
    view.addEventListener('create-overlay', e => { for (const n of notes) if (n.kind !== 'bm' && n.index === e.detail.index) view.addAnnotation(n) })
    view.addEventListener('draw-annotation', e => {
      const { draw, annotation: a } = e.detail
      if (a.kind === 'ul') draw(Overlayer.underline, { color: theme().link, width: 2 })
      else draw(Overlayer.highlight, { color: HL[a.color] || HL[1] })
    })
    view.addEventListener('show-annotation', e => { const n = notes.find(x => x.value === e.detail.value); if (n) showSelFor(n, e.detail.range, e.detail.index) })
    view.addEventListener('external-link', e => { e.preventDefault(); window.open(e.detail.href_, '_blank', 'noopener') })
    await view.open(book)
    // Заметкам с другого устройства может не хватать номера главы — вычисляем по адресу
    for (const n of notes) if (n.index == null) { try { n.index = view.resolveNavigation(n.value)?.index } catch {} }
    applyReaderStyle()
    const st = states.get(id)
    if (target) await view.init({ lastLocation: target })
    else if (st?.cfi) await view.init({ lastLocation: st.cfi })
    else if (st?.fraction) { await view.init({ showTextStart: false }); await view.goToFraction(st.fraction) }
    else await view.init({ showTextStart: true })
    $('loading').classList.add('off')
    updateBookmarkBtn()
    startTimer()
  } catch (e) {
    console.error(e)
    $('loadingText').textContent = 'Не получилось открыть книгу: ' + (e.message || e)
    setTimeout(() => { if (cur === b) closeReader() }, 3500)
  }
}
function closeReader() {
  hideSel(); closeSheet(); stopTimer()
  if (lastLoc && cur) saveState(true)
  // Сразу останавливаем отрисовку книги: иначе foliate-js пытается пересчитать страницы, пока экран прячется
  const v = view; view = null
  try { v?.close?.() } catch {}
  v?.remove()
  const r = $('reader'); r.classList.remove('ui'); r.classList.add('closed'); $('library').classList.remove('away')
  $('tabbar').hidden = false
  setTimeout(() => { if (r.classList.contains('closed')) r.hidden = true }, 420)
  cur = null; renderLibrary(); sync.soon()
}

function onRelocate(e) {
  const d = e.detail; lastLoc = d
  const fixed = view.isFixedLayout
  const chapter = d.tocItem?.label?.trim() || ''
  $('rChap').textContent = chapter
  // Номер страницы: у PDF и DJVU настоящие страницы книги. У остальных страницы зависят от шрифта и экрана,
  // поэтому показываем точный номер страницы внутри главы (как в Apple Books) и процент всей книги
  let page = '', inChapter = false
  if (fixed) page = `${(d.section?.current ?? 0) + 1} из ${d.section?.total ?? 1}`
  else if (S.flow === 'paginated' && view.renderer.pages > 2) { const r = view.renderer; page = `${Math.min(r.page, r.pages - 2)} из ${r.pages - 2}`; inChapter = (d.section?.total ?? 1) > 1 }
  $('rPage').textContent = page ? 'стр. ' + page : Math.round((d.fraction || 0) * 100) + '%'
  const left = d.time?.section
  $('rLeft').textContent = fixed ? '' : left != null ? (left < 1 ? 'глава заканчивается' : fmtMin(left) + ' до конца главы') : ''
  $('sChap').textContent = chapter || cur?.title || ''
  $('sPage').textContent = (page ? 'стр. ' + page + (inChapter ? ' в главе' : '') + ' · ' : '') + Math.round((d.fraction || 0) * 100) + '% книги'
  if (!scrubbing) $('scrub').value = d.fraction || 0
  hideSel()
  updateBookmarkBtn()
  clearTimeout(saveT); saveT = setTimeout(() => saveState(), 1200)
}
async function saveState(force) {
  if (!cur || !lastLoc) return
  const st = { id: cur.id, cfi: lastLoc.cfi, fraction: lastLoc.fraction || 0, chapter: lastLoc.tocItem?.label?.trim() || '', left: lastLoc.time?.total || 0, updated: now() }
  states.set(cur.id, st); await db.put('state', st)
  if (force) sync.soon()
}
let scrubbing = false
$('scrub').addEventListener('input', e => { scrubbing = true; view?.goToFraction(+e.target.value) })
$('scrub').addEventListener('change', () => { scrubbing = false })

// Время чтения: копим секунды, пока книга открыта и экран виден
function startTimer() { stopTimer(); readTimer = setInterval(async () => { if (document.hidden || !cur) return; const t = (await db.kv('time')) || {}; t[today()] = (t[today()] || 0) + 15; await db.kv('time', t) }, 15000) }
function stopTimer() { clearInterval(readTimer) }

// Касания внутри страницы: края листают, центр открывает меню
function onDocLoad({ detail: { doc, index } }) {
  docs.set(doc, index)
  doc.addEventListener('click', e => {
    if (e.target.closest?.('a[href]')) return
    const sel = doc.getSelection(); if (sel && !sel.isCollapsed) return
    if (!$('sel').hidden) { hideSel(); return }
    const fr = doc.defaultView.frameElement?.getBoundingClientRect(), stage = $('stage').getBoundingClientRect()
    const x = ((fr ? fr.left : 0) + e.clientX * ((fr?.width || 1) / (doc.defaultView.innerWidth || fr?.width || 1)) - stage.left) / stage.width
    tap(x)
  })
  doc.addEventListener('selectionchange', () => { clearTimeout(selT); selT = setTimeout(() => onSelection(doc, index), isTouch ? 450 : 250) })
  doc.addEventListener('pointerup', () => { clearTimeout(selT); selT = setTimeout(() => onSelection(doc, index), 60) })
  doc.addEventListener('keydown', onKey)
}
function tap(x) {
  const r = $('reader')
  if (r.classList.contains('ui')) { r.classList.remove('ui'); return }
  if (S.flow === 'scrolled') { r.classList.add('ui'); return }
  // На сенсорном экране foliate-js после касания «примагничивает» страницу к текущей; листаем чуть позже, иначе он отменит перелистывание
  const go = f => isTouch ? setTimeout(f, 60) : f()
  if (x < .28) go(() => view?.goLeft()); else if (x > .72) go(() => view?.goRight()); else r.classList.add('ui')
}
$('stage').addEventListener('click', e => { if (e.target === $('stage') || e.target === view) { const s = $('stage').getBoundingClientRect(); tap((e.clientX - s.left) / s.width) } })
function onKey(e) {
  if ($('reader').hidden || $('sheet').classList.contains('on') || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) { e.preventDefault(); view?.goRight() }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) { e.preventDefault(); view?.goLeft() }
  else if (e.key === 'Escape') { if (!$('sel').hidden) hideSel(); else closeReader() }
}
document.addEventListener('keydown', onKey)

/* ---------- Выделение ---------- */
let selT, pending = null, editing = null
const selBar = $('sel')
function onSelection(doc, index) {
  const sel = doc.getSelection()
  if (!sel || sel.isCollapsed || !sel.toString().trim()) { if (!editing) hideSel(); return }
  const range = sel.getRangeAt(0)
  pending = { doc, index, range: range.cloneRange() }; editing = null
  showBar(screenRect(doc, range), null)
}
const screenRect = (doc, range) => {
  const fr = doc.defaultView.frameElement?.getBoundingClientRect() || { left: 0, top: 0, width: 1 }
  const k = fr.width / (doc.defaultView.innerWidth || fr.width) || 1
  const rs = [...range.getClientRects()].filter(r => r.width > 0)
  const a = rs[0] || range.getBoundingClientRect(), z = rs[rs.length - 1] || a
  return { left: fr.left + Math.min(a.left, z.left) * k, right: fr.left + Math.max(a.right, z.right) * k, top: fr.top + a.top * k, bottom: fr.top + z.bottom * k }
}
function showBar(rect, note) {
  const on = note ? (note.kind === 'ul' ? 'u' : String(note.color)) : ''
  selBar.innerHTML = [1, 2, 3, 4, 5].map(c => `<button class="dot${on === String(c) ? ' on' : ''}" data-color="${c}" aria-label="Выделить цветом ${c}"><i style="background:${HL[c]}"></i></button>`).join('') +
    `<span class="div"></span><button class="act${on === 'u' ? ' on' : ''}" data-mk="ul" aria-label="Подчеркнуть" title="Подчеркнуть"><svg class="ic" viewBox="0 0 24 24"><path d="M7 4v7a5 5 0 0010 0V4M5 20h14"/></svg></button>` +
    `<button class="act" data-mk="note" aria-label="Заметка" title="Заметка"><svg class="ic" viewBox="0 0 24 24"><path d="M5 19.5l1-4.5L16.5 4.5a2 2 0 013 3L9 18z"/></svg></button>` +
    (note ? `<button class="act" data-mk="del" aria-label="Убрать выделение" title="Убрать выделение"><svg class="ic" viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button>`
      : `<button class="act" data-mk="copy" aria-label="Копировать" title="Копировать"><svg class="ic" viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/></svg></button><button class="act" data-mk="find" aria-label="Найти в книге" title="Найти в книге"><svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg></button>`)
  selBar.hidden = false
  const box = $('reader').getBoundingClientRect(), w = selBar.offsetWidth, h = selBar.offsetHeight
  const cx = (rect.left + rect.right) / 2
  let left = Math.max(8, Math.min(box.width - w - 8, cx - w / 2 - box.left))
  // На iPhone над выделением своё системное меню — ставим нашу панель под текстом
  let top = rect.bottom - box.top + 14, below = true
  if (!isTouch && rect.top - box.top - h - 12 > 50) { top = rect.top - box.top - h - 12; below = false }
  if (top + h > box.height - 50) { top = Math.max(50, rect.top - box.top - h - 12); below = false }
  selBar.style.left = left + 'px'; selBar.style.top = top + 'px'; selBar.classList.toggle('below', below)
  selBar.style.setProperty('--ax', Math.max(16, Math.min(w - 16, cx - box.left - left)) + 'px')
}
function hideSel() { selBar.hidden = true; pending = null; editing = null }
function showSelFor(n, range, index) {
  const doc = [...docs].find(([, i]) => i === index)?.[0]
  editing = n; pending = null
  showBar(doc && range ? screenRect(doc, range) : { left: innerWidth / 2 - 10, right: innerWidth / 2 + 10, top: innerHeight / 2, bottom: innerHeight / 2 }, n)
}
selBar.addEventListener('pointerdown', e => e.preventDefault())
selBar.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return
  const color = b.dataset.color, mk = b.dataset.mk
  if (mk === 'copy' && pending) { try { await navigator.clipboard.writeText(pending.range.toString()); toast('Скопировано') } catch { toast('Не удалось скопировать') } clearSel(); return }
  if (mk === 'find' && pending) { const q = pending.range.toString().trim().slice(0, 60); clearSel(); return sheetFind(q) }
  if (editing) {
    const n = editing
    if (mk === 'del') { n.deleted = true; n.updated = now(); await db.put('notes', n); notes = notes.filter(x => x !== n); view.deleteAnnotation(n); hideSel(); toast('Выделение убрано'); sync.soon(); return }
    if (mk === 'note') { hideSel(); return noteSheet(n) }
    if (color) { n.kind = 'hl'; n.color = +color } else if (mk === 'ul') n.kind = 'ul'
    n.updated = now(); await db.put('notes', n); view.addAnnotation(n); hideSel(); sync.soon(); return
  }
  if (!pending) return
  const n = await createNote(mk === 'ul' ? 'ul' : 'hl', +color || 1)
  if (!n) return
  if (mk === 'note') noteSheet(n); else toast(mk === 'ul' ? 'Подчёркнуто' : 'Выделено')
})
function clearSel() { try { pending?.doc.getSelection().removeAllRanges() } catch {} hideSel() }
async function createNote(kind, color) {
  const { doc, index, range } = pending
  const text = range.toString().replace(/\s+/g, ' ').trim(); if (!text) return null
  const value = view.getCFI(index, range)
  const chapter = view.getProgressOf?.(index, range)?.tocItem?.label?.trim() || lastLoc?.tocItem?.label?.trim() || ''
  const n = { id: (crypto.randomUUID?.() || String(Math.random()).slice(2)), bookId: cur.id, value, index, kind, color, text, note: '', chapter, created: now(), updated: now() }
  await db.put('notes', n); notes.push(n)
  await view.addAnnotation(n)
  try { doc.getSelection().removeAllRanges() } catch {}
  hideSel(); sync.soon(); return n
}
function noteSheet(n) {
  openSheet('Заметка', `<p class="notequote">${esc(n.text)}</p><textarea id="noteText" placeholder="Ваша мысль об этом месте">${esc(n.note || '')}</textarea><div class="btnrow"><button class="btn" data-act="sheet-close">Отмена</button><button class="btn primary" id="noteSave">Сохранить</button></div>`)
  if (!isTouch) setTimeout(() => $('noteText').focus(), 300)
  $('noteSave').onclick = async () => { n.note = $('noteText').value.trim(); n.updated = now(); await db.put('notes', n); closeSheet(); toast(n.note ? 'Заметка сохранена' : 'Заметка очищена'); sync.soon() }
}

/* ---------- Закладки ---------- */
const curBookmark = () => lastLoc?.cfi && notes.find(n => n.kind === 'bm' && n.value === lastLoc.cfi)
function updateBookmarkBtn() { const on = !!curBookmark(); for (const b of document.querySelectorAll('[data-act=bookmark]')) b.classList.toggle('on', on) }
async function toggleBookmark() {
  if (!lastLoc?.cfi) return
  const ex = curBookmark()
  if (ex) { ex.deleted = true; ex.updated = now(); await db.put('notes', ex); notes = notes.filter(x => x !== ex); toast('Закладка снята') }
  else {
    const text = (lastLoc.range?.toString?.() || '').replace(/\s+/g, ' ').trim().slice(0, 140)
    const n = { id: crypto.randomUUID?.() || String(Math.random()).slice(2), bookId: cur.id, value: lastLoc.cfi, kind: 'bm', text, chapter: lastLoc.tocItem?.label?.trim() || '', fraction: lastLoc.fraction, created: now(), updated: now() }
    await db.put('notes', n); notes.push(n); toast('Закладка поставлена')
  }
  updateBookmarkBtn(); sync.soon()
}

/* ---------- Шторки чтения ---------- */
function sheetToc() {
  const toc = view?.book?.toc || []
  const curHref = lastLoc?.tocItem?.href
  const rows = []
  const walk = (items, lvl) => { for (const it of items || []) { rows.push(`<button class="lvl${Math.min(lvl, 3)}${it.href === curHref ? ' cur' : ''}" data-href="${esc(it.href)}"><span class="nm">${esc(it.label?.trim() || 'Без названия')}</span></button>`); if (lvl < 3) walk(it.subitems, lvl + 1) } }
  walk(toc, 1)
  openSheet('Оглавление', rows.length ? `<div class="toc">${rows.join('')}</div>` : '<p class="hint">В этой книге нет оглавления. Листайте ползунком внизу.</p>')
  $('shBody').onclick = e => { const b = e.target.closest('[data-href]'); if (b) { closeSheet(); $('reader').classList.remove('ui'); view.goTo(b.dataset.href) } }
  $('shBody').querySelector('.cur')?.scrollIntoView({ block: 'center' })
}
function sheetNotes() {
  const hl = notes.filter(n => n.kind !== 'bm').sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || a.created - b.created)
  const bm = notes.filter(n => n.kind === 'bm').sort((a, b) => (a.fraction || 0) - (b.fraction || 0))
  openSheet('Заметки', (hl.length ? hl.map(n => `<button class="nl" data-go="${esc(n.value)}"><span class="sw" style="background:${n.kind === 'ul' ? 'var(--accent)' : HL[n.color] || HL[1]}"></span><q>${esc(n.text)}</q>${n.note ? `<em>${esc(n.note)}</em>` : ''}<small>${esc(n.chapter || '')}${n.kind === 'ul' ? ' · подчёркнуто' : ''}</small></button>`).join('')
    : '<p class="hint">Выделите текст пальцем или мышью — появится панель с цветами, подчёркиванием и заметкой.</p>') +
    (bm.length ? `<div class="grp" style="margin-top:6px"><div class="lab">Закладки</div>${bm.map(n => `<button class="nl" data-go="${esc(n.value)}"><small>${esc(n.chapter || '')} · ${Math.round((n.fraction || 0) * 100)}%</small>${n.text ? `<q>${esc(n.text)}</q>` : ''}</button>`).join('')}</div>` : '') +
    (hl.length ? `<div class="btnrow"><button class="btn" id="copyNotes">Скопировать все заметки книги</button></div>` : ''))
  $('shBody').onclick = async e => {
    const g = e.target.closest('[data-go]'); if (g) { closeSheet(); $('reader').classList.remove('ui'); view.goTo(g.dataset.go) }
    if (e.target.closest('#copyNotes')) { const md = `## ${cur.title}\n\n` + hl.map(n => `> ${n.text}\n${n.note ? '\n' + n.note + '\n' : ''}`).join('\n'); try { await navigator.clipboard.writeText(md); toast('Заметки скопированы') } catch { toast('Не удалось скопировать') } }
  }
}
async function sheetFind(q = '') {
  openSheet('Поиск по книге', `<input class="field" id="findQ" type="search" placeholder="Слово или фраза" value="${esc(q)}" enterkeyhint="search" autocomplete="off"><div class="found" id="found"></div>`)
  const run = async () => {
    const query = $('findQ').value.trim(); if (!query || !view) return
    const out = $('found'); out.innerHTML = '<p class="hint" style="margin-top:12px">Ищу…</p>'
    let html = '', n = 0
    try {
      for await (const r of view.search({ query })) {
        if (r === 'done') break
        if (r.subitems) for (const s of r.subitems) { if (n++ > 200) break; html += `<button data-go="${esc(s.cfi)}"><small>${esc(r.label || '')}</small>${esc(s.excerpt.pre)}<b>${esc(s.excerpt.match)}</b>${esc(s.excerpt.post)}</button>` }
        if (n > 200) break
      }
    } catch (e) { console.error(e) }
    out.innerHTML = html || '<p class="hint" style="margin-top:12px">Ничего не найдено</p>'
  }
  $('findQ').addEventListener('keydown', e => { if (e.key === 'Enter') run() })
  $('shBody').onclick = e => { const g = e.target.closest('[data-go]'); if (g) { closeSheet(); $('reader').classList.remove('ui'); view.goTo(g.dataset.go) } }
  if (q) run(); else if (!isTouch) setTimeout(() => $('findQ').focus(), 300)
}
function sheetType() {
  const sw = t => `background:${t.bg};color:${t.fg}`
  openSheet('Текст', `
   <div class="grp" style="border:0;padding-top:0"><div class="lab">Тема</div><div class="themes">${THEMES.map(t => `<button class="thm${theme().k === t.k ? ' on' : ''}" data-theme-k="${t.k}" style="${sw(t)}"><b>Аа</b>${t.n}</button>`).join('')}</div></div>
   <div class="grp"><div class="lab">Шрифт</div><div class="fonts">${FONTS.map((f, i) => `<button class="fnt${S.font === i ? ' on' : ''}" data-font="${i}"><b style="${f.css ? 'font-family:' + esc(f.css) : ''}">${f.k}</b><span>${f.d}</span></button>`).join('')}</div></div>
   <div class="grp"><label for="fsR"><span>Размер</span><span id="fsV">${S.fs}</span></label><div class="stepper"><button data-step="-1" aria-label="Меньше"><span style="font:600 14px var(--f-display)">А</span></button><input type="range" id="fsR" min="13" max="32" value="${S.fs}"><button data-step="1" aria-label="Больше"><span style="font:600 21px var(--f-display)">А</span></button></div></div>
   <div class="grp"><label for="lhR"><span>Межстрочный интервал</span><span id="lhV">${S.lh.toFixed(2)}</span></label><input type="range" id="lhR" min="1.2" max="2.2" step="0.05" value="${S.lh}"></div>
   <div class="grp"><div class="lab">Поля</div><div class="pills">${[['narrow', 'Узкие'], ['normal', 'Обычные'], ['wide', 'Широкие']].map(([v, n]) => `<button class="pill${S.margin === v ? ' on' : ''}" data-margin="${v}">${n}</button>`).join('')}</div></div>
   <div class="grp"><div class="lab">Выравнивание</div><div class="pills"><button class="pill${S.align === 'justify' ? ' on' : ''}" data-align="justify">По ширине</button><button class="pill${S.align === 'left' ? ' on' : ''}" data-align="left">По левому краю</button></div></div>
   <div class="grp"><div class="lab">Листание</div><div class="pills"><button class="pill${S.flow === 'paginated' ? ' on' : ''}" data-flow="paginated">Страницами</button><button class="pill${S.flow === 'scrolled' ? ' on' : ''}" data-flow="scrolled">Прокруткой</button></div></div>`)
  const apply = () => { applyTheme(); applyReaderStyle(); saveSettings() }
  $('fsR').oninput = e => { S.fs = +e.target.value; $('fsV').textContent = S.fs; apply() }
  $('lhR').oninput = e => { S.lh = +e.target.value; $('lhV').textContent = S.lh.toFixed(2); apply() }
  $('shBody').onclick = e => {
    const b = e.target.closest('button'); if (!b) return
    if (b.dataset.themeK) S.theme = b.dataset.themeK
    else if (b.dataset.font != null) S.font = +b.dataset.font
    else if (b.dataset.margin) S.margin = b.dataset.margin
    else if (b.dataset.align) S.align = b.dataset.align
    else if (b.dataset.flow) S.flow = b.dataset.flow
    else if (b.dataset.step) { S.fs = Math.max(13, Math.min(32, S.fs + +b.dataset.step)); $('fsR').value = S.fs; $('fsV').textContent = S.fs }
    else return
    apply()
    const mark = (sel, ok) => $('shBody').querySelectorAll(sel).forEach(x => x.classList.toggle('on', ok(x)))
    mark('[data-theme-k]', x => x.dataset.themeK === theme().k); mark('[data-font]', x => +x.dataset.font === S.font)
    mark('[data-margin]', x => x.dataset.margin === S.margin); mark('[data-align]', x => x.dataset.align === S.align); mark('[data-flow]', x => x.dataset.flow === S.flow)
  }
}
const saveSettings = () => db.kv('settings', { ...S })

/* ---------- Общие кнопки ---------- */
document.addEventListener('click', async e => {
  const o = e.target.closest('[data-open]'); if (o && !o.closest('#shBody')) { if (pressT === 'fired') { pressT = null; return } return openReader(o.dataset.open) }
  const j = e.target.closest('[data-jump]'); if (j) { const [id, cfi] = j.dataset.jump.split('|'); showTab('library'); return openReader(id, cfi) }
  const tb = e.target.closest('[data-tab]'); if (tb) return showTab(tb.dataset.tab)
  const sh = e.target.closest('[data-sheet]'); if (sh) { $('reader').classList.remove('ui'); return { toc: sheetToc, notes: sheetNotes, type: sheetType }[sh.dataset.sheet]() }
  const a = e.target.closest('[data-act]'); if (!a) return
  const act = a.dataset.act
  if (act === 'close') closeReader()
  else if (act === 'sheet-close') closeSheet()
  else if (act === 'bookmark') toggleBookmark()
  else if (act === 'find') { $('reader').classList.remove('ui'); sheetFind() }
  else if (act === 'night') { S.theme = theme().dark ? 'mist' : 'graphite'; applyTheme(); applyReaderStyle(); saveSettings() }
})
$('syncBtn').addEventListener('click', () => sync.openPanel({ openSheet, closeSheet, toast }))

/* ---------- Запуск ---------- */
async function start() {
  Object.assign(S, (await db.kv('settings')) || {})
  applyTheme()
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!S.theme) { applyTheme(); applyReaderStyle() } })
  await loadLibrary()
  sync.init({ onChange: loadLibrary, setStatus: s => { $('syncDot').className = 'sync-dot ' + (s || ''); $('syncBtn').classList.toggle('spin', s === 'busy') }, toast })
  // Офлайн-режим включаем только в собранной версии (в ней sw.js со списком файлов)
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost') && !location.pathname.includes('/chitalnya/')) navigator.serviceWorker.register('sw.js').catch(() => {})
  // Открыть файл, которым поделились с приложением на ПК (Chrome/Edge: «Открыть с помощью»)
  if ('launchQueue' in window) launchQueue.setConsumer(async p => { const files = await Promise.all((p.files || []).map(h => h.getFile())); const id = await addFiles(files); if (id) openReader(id) })
}
document.addEventListener('visibilitychange', () => { if (document.hidden && cur) saveState(true) })
addEventListener('pagehide', () => { if (cur) saveState(true) })
start()
window.__app = { db, addFiles, openReader, closeReader, get view() { return view }, get notes() { return notes }, S }
