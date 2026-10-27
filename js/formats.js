// Разбор книжных форматов. Всё, что умеет foliate-js (EPUB, MOBI, AZW3, FB2, FBZ, CBZ, PDF),
// открываем им напрямую. Остальное приводим к его форматам:
//   TXT, RTF, DOCX, ODT, HTML, MD  → собираем FB2 (главы, абзацы, курсив, картинки)
//   DJVU                           → «книга из страниц-картинок», рисуем страницы djvu.js по мере листания
//   CBR, CB7, CBT                  → распаковываем libarchive и отдаём как комикс
import { makeBook } from '../vendor/foliate-js/view.js'

const V = new URL('../vendor/', import.meta.url).href

export const FORMATS = {
  epub: 'EPUB', fb2: 'FB2', fbz: 'FB2', 'fb2.zip': 'FB2', mobi: 'MOBI', azw: 'AZW', azw3: 'AZW3', kf8: 'AZW3', prc: 'MOBI',
  pdf: 'PDF', djvu: 'DJVU', djv: 'DJVU', txt: 'TXT', rtf: 'RTF', docx: 'DOCX', odt: 'ODT', html: 'HTML', htm: 'HTML',
  xhtml: 'HTML', md: 'MD', markdown: 'MD', cbz: 'CBZ', cbr: 'CBR', cb7: 'CB7', cbt: 'CBT',
}
// Эти форматы браузер прочитать не может ни в одной веб-читалке: подсказываем, как перевести
export const CONVERT = { doc: 'DOC', chm: 'CHM', lit: 'LIT', pdb: 'PDB', lrf: 'LRF', djvu_old: '' }
export const ACCEPT = Object.keys(FORMATS).map(e => '.' + e.split('.').pop()).concat(['.zip']).join(',')

export const extOf = name => {
  const n = name.toLowerCase()
  if (n.endsWith('.fb2.zip')) return 'fb2.zip'
  return n.includes('.') ? n.split('.').pop() : ''
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const baseName = name => name.replace(/\.fb2\.zip$/i, '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim()

// ---------- Кодировка текста: UTF-8, UTF-16 или старая русская windows-1251 ----------
export const decodeText = buf => {
  const b = new Uint8Array(buf)
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return new TextDecoder('utf-8').decode(b.subarray(3))
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2))
  if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b.subarray(2))
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b) }
  catch { // не UTF-8: выбираем между windows-1251 и KOI8-R по частоте строчных русских букв
    const w = new TextDecoder('windows-1251').decode(b), k = new TextDecoder('koi8-r').decode(b)
    const score = s => (s.match(/[а-яё]/g) || []).length
    return score(k) > score(w) * 1.3 ? k : w
  }
}

// ---------- Сборка FB2 из глав ----------
// chapters: [{ title, blocks: [{ type: 'p'|'img'|'sub', html, id }] }], images: Map(id → {type, base64})
const buildFB2 = ({ title, author = '', lang = 'ru', chapters, images = new Map(), coverId }) => {
  const [first = '', ...rest] = String(author).trim().split(/\s+/)
  const sections = chapters.filter(c => c.blocks.length).map(c =>
    `<section>${c.title ? `<title><p>${esc(c.title)}</p></title>` : ''}${c.blocks.map(b =>
      b.type === 'img' ? `<image l:href="#${b.id}"/>` : b.type === 'sub' ? `<subtitle>${b.html}</subtitle>` : `<p>${b.html}</p>`).join('')}</section>`)
  const bin = [...images].map(([id, im]) => `<binary id="${id}" content-type="${im.type}">${im.base64}</binary>`).join('')
  return `<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><author><first-name>${esc(first)}</first-name><last-name>${esc(rest.join(' '))}</last-name></author><book-title>${esc(title)}</book-title>${coverId ? `<coverpage><image l:href="#${coverId}"/></coverpage>` : ''}<lang>${lang}</lang></title-info></description><body>${sections.join('') || '<section><p></p></section>'}</body>${bin}</FictionBook>`
}

// Длинную главу без заголовков режем на части, чтобы книга листалась быстро
const splitLong = (chapters, max = 220) => chapters.flatMap(c => {
  if (c.blocks.length <= max) return [c]
  const parts = []
  for (let i = 0; i < c.blocks.length; i += max) parts.push({ title: i ? '' : c.title, blocks: c.blocks.slice(i, i + max) })
  return parts
})

// \b в JavaScript не видит границ русских слов, поэтому после слова ждём пробел, точку, цифру или конец
const HEADING = /^(глава|часть|книга|том|пролог|эпилог|предисловие|послесловие|введение|заключение|chapter|part|book|prologue|epilogue|preface|introduction)(?=[\s.:,\-—\dIVXLC]|$)[\s\S]{0,80}$|^[IVXLCDM]{1,7}\.?$|^\d{1,3}\.?$|^\*\s*\*\s*\*$/i

// ---------- TXT ----------
const fromText = (text, title) => {
  text = text.replace(/\r\n?/g, '\n')
  const hasBlank = /\n[ \t]*\n/.test(text)
  // Абзацы: по пустым строкам, а если их нет — каждая строка (или строка с отступом) отдельный абзац
  const paras = (hasBlank ? text.split(/\n[ \t]*\n+/) : text.split(/\n(?=[ \t]+\S)|\n/))
    .map(s => s.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean)
  const chapters = []; let cur = { title: '', blocks: [] }
  for (const p of paras) {
    if (p.length < 90 && HEADING.test(p)) {
      if (/^\*\s*\*\s*\*$/.test(p)) { cur.blocks.push({ type: 'sub', html: '* * *' }); continue }
      if (cur.blocks.length || cur.title) chapters.push(cur)
      cur = { title: p, blocks: [] }
    } else cur.blocks.push({ type: 'p', html: esc(p) })
  }
  chapters.push(cur)
  if (!title && chapters[0] && !chapters[0].title && chapters[0].blocks[0]?.html.length < 80) title = chapters[0].blocks[0].html
  return { chapters: splitLong(chapters.filter(c => c.blocks.length)), title }
}

// ---------- HTML (и всё, что сначала превращаем в HTML: DOCX, MD) ----------
const INLINE = { EM: 'emphasis', I: 'emphasis', CITE: 'emphasis', STRONG: 'strong', B: 'strong', SUP: 'sup', SUB: 'sub', CODE: 'code', S: 'strikethrough', DEL: 'strikethrough' }
const inlineHTML = (node, images) => {
  let out = ''
  for (const n of node.childNodes) {
    if (n.nodeType === 3) out += esc(n.nodeValue.replace(/\s+/g, ' '))
    else if (n.nodeType === 1) {
      const tag = INLINE[n.tagName.toUpperCase()]
      if (n.tagName.toUpperCase() === 'BR') out += ' '
      else if (n.tagName.toUpperCase() === 'IMG') continue
      else out += tag ? `<${tag}>${inlineHTML(n, images)}</${tag}>` : inlineHTML(n, images)
    }
  }
  return out
}
const dataURLImage = (src, images) => {
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(src || '')
  if (!m) return null
  const id = 'img' + (images.size + 1) + '.' + m[1].split('/')[1].replace('jpeg', 'jpg').replace('+xml', '')
  images.set(id, { type: m[1], base64: m[2] })
  return id
}
const fromHTMLDoc = (doc, fallbackTitle) => {
  const images = new Map(), chapters = []; let cur = { title: '', blocks: [] }
  const BLOCK = /^(P|DIV|LI|BLOCKQUOTE|PRE|DD|DT|TD|FIGCAPTION|ADDRESS)$/
  const walk = el => {
    for (const n of el.children) {
      const tag = n.tagName.toUpperCase()
      if (/^(SCRIPT|STYLE|NAV|HEAD|NOSCRIPT|TEMPLATE)$/.test(tag)) continue
      if (/^H[1-3]$/.test(tag)) {
        const t = n.textContent.replace(/\s+/g, ' ').trim()
        if (!t) continue
        if (cur.blocks.length || cur.title) chapters.push(cur)
        cur = { title: t, blocks: [] }
      } else if (/^H[4-6]$/.test(tag)) {
        const t = inlineHTML(n, images).trim(); if (t) cur.blocks.push({ type: 'sub', html: t })
      } else if (tag === 'IMG') {
        const id = dataURLImage(n.getAttribute('src'), images); if (id) cur.blocks.push({ type: 'img', id })
      } else if (BLOCK.test(tag) && ![...n.children].some(c => /^(P|DIV|H\d|UL|OL|TABLE|BLOCKQUOTE|FIGURE)$/i.test(c.tagName))) {
        for (const img of n.querySelectorAll('img')) { const id = dataURLImage(img.getAttribute('src'), images); if (id) cur.blocks.push({ type: 'img', id }) }
        const t = inlineHTML(n, images).trim(); if (t) cur.blocks.push({ type: 'p', html: t })
      } else if (tag === 'HR') cur.blocks.push({ type: 'sub', html: '* * *' })
      else walk(n)
    }
  }
  walk(doc.body || doc.documentElement)
  // Текст прямо в <body> без абзацев
  if (!chapters.length && !cur.blocks.length) return fromText(doc.body?.innerText || doc.documentElement.textContent || '', fallbackTitle)
  chapters.push(cur)
  const title = doc.querySelector('title')?.textContent.trim() || fallbackTitle
  return { chapters: splitLong(chapters.filter(c => c.blocks.length)), images, title }
}
const parseHTML = s => new DOMParser().parseFromString(s, 'text/html')

// ---------- Markdown (заголовки, абзацы, жирный, курсив, картинки по ссылке не грузим) ----------
const mdInline = s => esc(s).replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
  .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>').replace(/(^|\W)_(?!\s)(.+?)_(?=\W|$)/g, '$1<em>$2</em>')
  .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
const mdToHTML = md => md.replace(/\r\n?/g, '\n').split(/\n{2,}/).map(b => {
  const h = /^(#{1,6})\s+(.+)$/m.exec(b.trim())
  if (h && b.trim().split('\n').length === 1) return `<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`
  if (/^(-{3,}|\*{3,})$/.test(b.trim())) return '<hr>'
  return b.trim() ? `<p>${b.trim().split('\n').map(l => mdInline(l.replace(/^\s*([-*+]|\d+\.)\s+/, '• ').replace(/^>\s?/, ''))).join('<br>')}</p>` : ''
}).join('')

// ---------- RTF: свой небольшой разборщик (абзацы, жирный, курсив, кириллица) ----------
const fromRTF = (bytes, fallbackTitle) => {
  const src = new TextDecoder('latin1').decode(bytes)
  let cp = +(/\\ansicpg(\d+)/.exec(src)?.[1] || 1252)
  const decoderFor = c => { try { return new TextDecoder(c === 1251 ? 'windows-1251' : c === 866 ? 'ibm866' : c === 1250 ? 'windows-1250' : 'windows-1252') } catch { return new TextDecoder('windows-1252') } }
  let dec = decoderFor(cp)
  const SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'listtable', 'listoverridetable', 'pict', 'header', 'footer', 'headerl', 'headerr', 'footerl', 'footerr', 'object', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'rsidtbl', 'generator', 'mmathPr', 'pgdsctbl', 'revtbl', 'fldinst', 'bkmkstart', 'bkmkend', 'shp', 'nonshppict'])
  const info = {}
  const paras = []; let para = '', bold = false, ital = false, uc = 1, skipChars = 0, bytesBuf = []
  const stack = []; let skipGroup = 0, infoKey = null, depth = 0
  const flushBytes = () => { if (bytesBuf.length) { const t = dec.decode(new Uint8Array(bytesBuf)); bytesBuf = []; emit(t) } }
  const emit = t => {
    if (skipGroup) return
    if (infoKey) { info[infoKey] = (info[infoKey] || '') + t; return }
    para += esc(t)
  }
  const style = () => { let s = ''; if (bold) s += '<strong>'; if (ital) s += '<emphasis>'; return s }
  const unstyle = () => { let s = ''; if (ital) s += '</emphasis>'; if (bold) s += '</strong>'; return s }
  const endPara = () => { flushBytes(); const t = para.replace(/<(strong|emphasis)><\/\1>/g, '').trim(); if (t) paras.push(t); para = style() }
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '{') { flushBytes(); stack.push({ bold, ital, uc, skipGroup, infoKey }); depth++; i++; continue }
    if (ch === '}') { flushBytes(); para += unstyle(); const s = stack.pop() || {}; ({ bold, ital, uc, skipGroup, infoKey } = { ...s }); para += style(); depth--; i++; continue }
    if (ch === '\\') {
      const nx = src[i + 1]
      if (nx === "'") { const b = parseInt(src.substr(i + 2, 2), 16); if (skipChars > 0) skipChars--; else bytesBuf.push(b); i += 4; continue }
      if (nx === '*') { skipGroup = skipGroup || (infoKey ? 0 : 1); i += 2; continue }
      if (/[\\{}]/.test(nx)) { flushBytes(); emit(nx); i += 2; continue }
      if (nx === '~') { flushBytes(); emit(' '); i += 2; continue }
      if (nx === '-' || nx === '_') { flushBytes(); if (nx === '_') emit('-'); i += 2; continue }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i, i + 40))
      if (!m) { i += 2; continue }
      const [all, word, num] = m; i += all.length
      if (word !== 'u') flushBytes()
      if (SKIP.has(word)) skipGroup = 1
      else if (word === 'info') {}
      else if (['title', 'author'].includes(word)) infoKey = word
      else if (word === 'par' || word === 'line' || word === 'sect' || word === 'page') { if (!skipGroup && !infoKey) endPara() }
      else if (word === 'tab') emit(' ')
      else if (word === 'b') { para += unstyle(); bold = num !== '0'; para += style() }
      else if (word === 'i') { para += unstyle(); ital = num !== '0'; para += style() }
      else if (word === 'plain') { para += unstyle(); bold = ital = false }
      else if (word === 'uc') uc = +num
      else if (word === 'u') { flushBytes(); let c = +num; if (c < 0) c += 65536; emit(String.fromCharCode(c)); skipChars = uc }
      else if (word === 'ansicpg') { cp = +num; dec = decoderFor(cp) }
      else if (word === 'emdash') emit('—'); else if (word === 'endash') emit('–')
      else if (word === 'lquote') emit('‘'); else if (word === 'rquote') emit('’')
      else if (word === 'ldblquote') emit('«'); else if (word === 'rdblquote') emit('»')
      else if (word === 'bullet') emit('•')
      continue
    }
    if (ch === '\r' || ch === '\n') { i++; continue }
    if (skipChars > 0) { skipChars--; i++; continue }
    flushBytes(); emit(ch); i++
  }
  endPara()
  // Абзацы → главы: короткая строка-заголовок начинает главу
  const chapters = []; let cur = { title: '', blocks: [] }
  for (const p of paras) {
    const plain = p.replace(/<[^>]+>/g, '')
    // Заголовок: «Глава 3…» или короткая строка, целиком набранная жирным
    const allBold = /^<strong>[^<]*<\/strong>$/.test(p) && plain.length < 80
    if (plain.length < 90 && (HEADING.test(plain.trim()) || allBold)) { if (cur.blocks.length || cur.title) chapters.push(cur); cur = { title: plain.trim(), blocks: [] } }
    else cur.blocks.push({ type: 'p', html: p })
  }
  chapters.push(cur)
  return { chapters: splitLong(chapters.filter(c => c.blocks.length)), title: info.title?.trim() || fallbackTitle, author: info.author?.trim() }
}

// ---------- ZIP (берём zip.js, который уже есть в foliate-js) ----------
const unzip = async blob => {
  const { configure, ZipReader, BlobReader, TextWriter, BlobWriter } = await import('../vendor/foliate-js/vendor/zip.js')
  configure({ useWebWorkers: false })
  const reader = new ZipReader(new BlobReader(blob))
  const entries = await reader.getEntries()
  const find = name => entries.find(e => e.filename === name)
  return {
    entries,
    text: async name => { const e = find(name); return e ? e.getData(new TextWriter()) : null },
    blob: async (name, type) => { const e = find(name); return e ? e.getData(new BlobWriter(type)) : null },
  }
}
const toBase64 = async blob => {
  const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
  return btoa(s)
}

// ---------- DOCX через mammoth ----------
let mammothP
const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Не загрузился ' + src)); document.head.append(s) })
const fromDOCX = async (file, fallbackTitle) => {
  mammothP ??= loadScript(V + 'mammoth/mammoth.browser.min.js')
  await mammothP
  const buf = await file.arrayBuffer()
  const { value } = await globalThis.mammoth.convertToHtml({ arrayBuffer: buf })
  const z = await unzip(file)
  const core = await z.text('docProps/core.xml')
  const meta = core ? new DOMParser().parseFromString(core, 'application/xml') : null
  const r = fromHTMLDoc(parseHTML(value), fallbackTitle)
  r.title = meta?.getElementsByTagName('dc:title')[0]?.textContent.trim() || fallbackTitle
  r.author = meta?.getElementsByTagName('dc:creator')[0]?.textContent.trim() || ''
  return r
}

// ---------- ODT: content.xml → HTML ----------
const fromODT = async (file, fallbackTitle) => {
  const z = await unzip(file)
  const xml = new DOMParser().parseFromString(await z.text('content.xml') || '', 'application/xml')
  const meta = new DOMParser().parseFromString(await z.text('meta.xml') || '<x/>', 'application/xml')
  const T = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0', D = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0', X = 'http://www.w3.org/1999/xlink'
  const images = new Map()
  let html = ''
  const inline = n => [...n.childNodes].map(c => c.nodeType === 3 ? esc(c.nodeValue) : c.localName === 's' ? ' ' : c.localName === 'tab' || c.localName === 'line-break' ? ' ' : c.localName === 'frame' || c.localName === 'image' ? '' : inline(c)).join('')
  const walk = async n => {
    for (const c of n.children) {
      if (c.namespaceURI === T && c.localName === 'h') { const l = Math.min(3, +c.getAttributeNS(T, 'outline-level') || 1); html += `<h${l}>${inline(c)}</h${l}>` }
      else if (c.namespaceURI === T && c.localName === 'p') {
        for (const im of c.getElementsByTagNameNS(D, 'image')) {
          const href = im.getAttributeNS(X, 'href'); const b = href && await z.blob(href)
          if (b) { const type = /\.png$/i.test(href) ? 'image/png' : 'image/jpeg'; html += `<img src="data:${type};base64,${await toBase64(b)}">` }
        }
        html += `<p>${inline(c)}</p>`
      }
      else await walk(c)
    }
  }
  const text = xml.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:office:1.0', 'text')[0]
  if (text) await walk(text)
  const r = fromHTMLDoc(parseHTML(html), fallbackTitle)
  r.title = meta.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0]?.textContent.trim() || fallbackTitle
  r.author = meta.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:meta:1.0', 'initial-creator')[0]?.textContent.trim() || ''
  return r
}

// ---------- DJVU: страницы-картинки, рисуются по мере листания ----------
let djvuP
const makeDJVU = async file => {
  djvuP ??= loadScript(V + 'djvu/djvu.js')
  await djvuP
  // Страницы расшифровываются в фоновом потоке (Web Worker): иначе на 1–2 секунды
  // замирает весь интерфейс и касания не срабатывают. Если поток не запустился — считаем на месте.
  const buf = await file.arrayBuffer()
  let worker = null, doc = null, count, contents
  try {
    worker = new globalThis.DjVu.Worker(V + 'djvu/djvu.js')
    await worker.createDocument(buf.slice(0))
    count = await worker.doc.getPagesQuantity().run()
    contents = await worker.doc.getContents().run().catch(() => null)
  } catch {
    worker?.terminate(); worker = null
    doc = new globalThis.DjVu.Document(buf)
    count = doc.getPagesQuantity(); contents = doc.getContents?.()
  }
  const cache = new Map()
  const pagePNG = async i => {
    let img
    if (worker) img = await worker.doc.getPage(i + 1).getImageData().run()
    else { const page = await doc.getPage(i + 1); img = page.getImageData(); page.reset?.() }
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height
    canvas.getContext('2d').putImageData(img, 0, 0)
    return new Promise(r => canvas.toBlob(r, 'image/jpeg', .9))
  }
  // Страница DJVU расшифровывается 1–2 секунды, поэтому, показав страницу, сразу готовим следующие две
  const render = async i => {
    const src = URL.createObjectURL(await pagePNG(i))
    return URL.createObjectURL(new Blob([`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0"><img src="${src}" style="display:block;width:100%"></body></html>`], { type: 'text/html' }))
  }
  const get = i => { if (!cache.has(i)) cache.set(i, render(i)); return cache.get(i) }
  const load = async i => {
    const html = await get(i)
    if (worker) for (const j of [i + 1, i + 2]) if (j < count && !cache.has(j)) setTimeout(() => get(j), 50)
    return html
  }
  const toc = []
  const walkToc = (arr, out) => { for (const c of arr || []) { const m = /#?(\d+)/.exec(c.url || ''); const item = { label: c.description, href: String(m ? +m[1] - 1 : 0) }; out.push(item); if (c.children?.length) { item.subitems = []; walkToc(c.children, item.subitems) } } }
  walkToc(contents, toc)
  return {
    metadata: { title: baseName(file.name) },
    rendition: { layout: 'pre-paginated' },
    sections: Array.from({ length: count }, (_, i) => ({ id: i, load: () => load(i), size: 1000 })),
    toc: toc.length ? toc : Array.from({ length: count }, (_, i) => ({ label: 'Страница ' + (i + 1), href: String(i) })),
    resolveHref: href => ({ index: +href }),
    splitTOCHref: href => [+href, null],
    getTOCFragment: d => d.documentElement,
    getCover: () => pagePNG(0),
    destroy: () => { worker?.terminate(); for (const p of cache.values()) Promise.resolve(p).then(u => URL.revokeObjectURL(u)).catch(() => {}) },
  }
}

// ---------- CBR / CB7 / CBT через libarchive (WebAssembly) ----------
let archiveP
const makeArchiveComic = async file => {
  archiveP ??= import(V + 'libarchive/libarchive.js').then(({ Archive }) => {
    Archive.init({ getWorker: () => new Worker(V + 'libarchive/worker-bundle.js', { type: 'module' }) })
    return Archive
  })
  const Archive = await archiveP
  const archive = await Archive.open(file)
  const list = (await archive.getFilesArray()).filter(f => /\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(f.file.name))
  const entries = list.map(f => ({ filename: (f.path || '') + f.file.name, f }))
  const map = new Map(entries.map(e => [e.filename, e.f]))
  const { makeComicBook } = await import('../vendor/foliate-js/comic-book.js')
  const loadBlob = async name => { const x = await map.get(name).file.extract(); return x }
  const book = makeComicBook({ entries, loadBlob, getSize: () => 1000 }, file)
  book.metadata = { title: baseName(file.name) }
  return book
}

// ---------- Главная функция: файл → книга для foliate ----------
export const openBookFile = async file => {
  const ext = extOf(file.name)
  const title0 = baseName(file.name)
  const asFB2 = r => makeBook(new File([buildFB2({ ...r, title: r.title || title0 })], title0 + '.fb2', { type: 'application/x-fictionbook+xml' }))
  switch (ext) {
    case 'txt': return asFB2(fromText(decodeText(await file.arrayBuffer()), ''))
    case 'html': case 'htm': case 'xhtml': return asFB2(fromHTMLDoc(parseHTML(decodeText(await file.arrayBuffer())), title0))
    case 'md': case 'markdown': {
      const md = decodeText(await file.arrayBuffer()); const r = fromHTMLDoc(parseHTML(mdToHTML(md)), title0)
      r.title = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() || title0; return asFB2(r)
    }
    case 'rtf': return asFB2(fromRTF(new Uint8Array(await file.arrayBuffer()), title0))
    case 'docx': return asFB2(await fromDOCX(file, title0))
    case 'odt': return asFB2(await fromODT(file, title0))
    case 'djvu': case 'djv': return makeDJVU(file)
    case 'cbr': case 'cb7': case 'cbt': return makeArchiveComic(file)
    case 'fb2.zip': case 'fbz': return makeBook(new File([file], title0 + '.fbz', { type: 'application/x-zip-compressed-fb2' }))
    case 'zip': { // архив с книгой внутри: ищем знакомый формат
      const z = await unzip(file)
      const inner = z.entries.find(e => !e.directory && FORMATS[extOf(e.filename)] && extOf(e.filename) !== 'zip')
      if (inner) return openBookFile(new File([await z.blob(inner.filename)], inner.filename.split('/').pop()))
      if (z.entries.some(e => /\.(jpe?g|png|webp)$/i.test(e.filename))) return makeBook(new File([file], title0 + '.cbz'))
      throw new Error('В архиве не нашлось книги')
    }
    case 'azw': case 'kf8': case 'prc': return makeBook(new File([file], title0 + '.mobi'))
    default: return makeBook(file)
  }
}

// Название, автор и обложка для полки
export const describe = async (book, file) => {
  const t = book.metadata?.title
  let title = (typeof t === 'string' ? t : t && Object.values(t)[0]) || baseName(file.name)
  if (title === file.name) title = baseName(file.name)
  const a = book.metadata?.author
  const one = x => typeof x === 'string' ? x : x?.name ? (typeof x.name === 'string' ? x.name : Object.values(x.name)[0]) : ''
  const author = Array.isArray(a) ? a.map(one).filter(Boolean).join(', ') : one(a)
  let cover = null
  try { cover = await book.getCover?.() } catch {}
  if (cover && !(cover instanceof Blob)) cover = null
  return { title: String(title).trim(), author: String(author || '').trim(), cover }
}
