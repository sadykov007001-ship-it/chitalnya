// Синхронизация через Dropbox (папка приложения «Приложения/Читальня»), без своего сервера и без Claude.
// В облаке на каждую книгу:  /books/<id>.<ext> — файл,  /covers/<id>.jpg — обложка,
//                            /meta/<id>.json — название, место чтения и заметки.
// Слияние: книги и заметки объединяются по номеру, при споре побеждает более свежая правка;
// место чтения — последнее по времени. Удаления передаются отметкой deleted.
import { db } from './db.js'

const API = 'https://api.dropboxapi.com/2', CONTENT = 'https://content.dropboxapi.com/2'
const redirect = () => location.origin + location.pathname
const asciiJSON = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

let cfg = null, ui = {}, running = null, soonT, again = false

async function token() {
  if (!cfg?.refresh) throw new Error('Dropbox не подключён')
  if (cfg.access && cfg.expires > Date.now() + 60e3) return cfg.access
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refresh, client_id: cfg.key }) })
  if (!r.ok) { if (r.status === 400 || r.status === 401) { cfg.refresh = null; await db.kv('dropbox', cfg) } throw new Error('Dropbox: вход устарел, подключите заново') }
  const j = await r.json()
  cfg.access = j.access_token; cfg.expires = Date.now() + j.expires_in * 1000
  await db.kv('dropbox', cfg)
  return cfg.access
}
async function call(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (r.status === 409) return { error: await r.json().catch(() => ({})) }
  if (!r.ok) throw new Error('Dropbox ' + r.status + ': ' + (await r.text()).slice(0, 120))
  return r.json()
}
async function download(path) {
  const r = await fetch(CONTENT + '/files/download', { method: 'POST', headers: { Authorization: 'Bearer ' + await token(), 'Dropbox-API-Arg': asciiJSON({ path }) } })
  if (r.status === 409) return null
  if (!r.ok) throw new Error('Dropbox ' + r.status)
  return r.blob()
}
async function upload(path, blob) {
  const auth = { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/octet-stream' }
  if (blob.size <= 140e6) {
    const r = await fetch(CONTENT + '/files/upload', { method: 'POST', headers: { ...auth, 'Dropbox-API-Arg': asciiJSON({ path, mode: 'overwrite', mute: true }) }, body: blob })
    if (!r.ok) throw new Error('Dropbox: не загрузился файл (' + r.status + ')')
    return r.json()
  }
  // Большие файлы — частями по 8 МБ
  const CH = 8e6
  let r = await fetch(CONTENT + '/files/upload_session/start', { method: 'POST', headers: { ...auth, 'Dropbox-API-Arg': '{}' }, body: blob.slice(0, CH) })
  const { session_id } = await r.json()
  let off = CH
  for (; off + CH < blob.size; off += CH)
    await fetch(CONTENT + '/files/upload_session/append_v2', { method: 'POST', headers: { ...auth, 'Dropbox-API-Arg': asciiJSON({ cursor: { session_id, offset: off } }) }, body: blob.slice(off, off + CH) })
  r = await fetch(CONTENT + '/files/upload_session/finish', { method: 'POST', headers: { ...auth, 'Dropbox-API-Arg': asciiJSON({ cursor: { session_id, offset: off }, commit: { path, mode: 'overwrite', mute: true } }) }, body: blob.slice(off) })
  if (!r.ok) throw new Error('Dropbox: не загрузился большой файл')
  return r.json()
}
async function listFolder(path) {
  let res = await call('/files/list_folder', { path, limit: 2000 })
  if (res.error) return []
  const all = [...res.entries]
  while (res.has_more) { res = await call('/files/list_folder/continue', { cursor: res.cursor }); all.push(...res.entries) }
  return all
}

/* ---------- Слияние ---------- */
const newer = (a, b) => (!a ? b : !b ? a : (b.updated || 0) > (a.updated || 0) ? b : a)
const strip = b => { const { cover, remote, ...rest } = b; return rest }
function merge(local, remote) {
  const book = { ...newer(local.book && strip(local.book), remote.book) }
  const state = newer(local.state, remote.state)
  const map = new Map()
  for (const n of [...(local.notes || []), ...(remote.notes || [])]) { const ex = map.get(n.id); map.set(n.id, newer(ex, n)) }
  return { book, state, notes: [...map.values()] }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function run() {
  if (!cfg?.refresh) return
  ui.setStatus?.('busy')
  try {
    const remoteMeta = new Map((await listFolder('/meta')).filter(e => e['.tag'] === 'file').map(e => [e.name.replace(/\.json$/, ''), e]))
    const remoteBooks = new Set((await listFolder('/books')).filter(e => e['.tag'] === 'file').map(e => e.name.replace(/\.[^.]+$/, '').replace(/\.fb2$/, '')))
    const books = await db.all('books'), allNotes = await db.all('notes'), states = await db.all('state')
    const revs = (await db.kv('dropbox-revs')) || {}
    const ids = new Set([...books.map(b => b.id), ...remoteMeta.keys()])
    let changed = false
    for (const id of ids) {
      const lb = books.find(b => b.id === id)
      const local = { book: lb, state: states.find(s => s.id === id), notes: allNotes.filter(n => n.bookId === id) }
      const rm = remoteMeta.get(id)
      let remote = { notes: [] }
      if (rm && rm.rev !== revs[id]) { const blob = await download('/meta/' + id + '.json'); if (blob) remote = JSON.parse(await blob.text()) }
      else if (rm) remote = (await db.kv('dropbox-meta-' + id)) || { notes: [] }
      const m = merge(local, remote)
      if (!m.book) continue
      // Сохраняем у себя то, что пришло из облака
      if (!lb || !same(strip(lb), m.book)) {
        const cover = lb?.cover || (m.book.deleted ? null : await download('/covers/' + id + '.jpg').catch(() => null))
        const hasFile = !!(await db.get('files', id))
        await db.put('books', { ...m.book, cover, remote: !hasFile && !m.book.deleted })
        if (m.book.deleted) await db.del('files', id)
        changed = true
      }
      if (m.state && !same(m.state, local.state)) { await db.put('state', m.state); changed = true }
      for (const n of m.notes) { const ln = local.notes.find(x => x.id === n.id); if (!same(ln, n)) { await db.put('notes', n); changed = true } }
      // Отправляем в облако файл книги и обложку, если их там ещё нет
      if (!m.book.deleted && !remoteBooks.has(id)) {
        const f = await db.get('files', id)
        if (f) { await upload(`/books/${id}.${m.book.ext}`, f.blob); if (lb?.cover) await upload(`/covers/${id}.jpg`, lb.cover) }
      }
      if (m.book.deleted && remoteBooks.has(id)) { await call('/files/delete_v2', { path: `/books/${id}.${m.book.ext}` }); await call('/files/delete_v2', { path: `/covers/${id}.jpg` }) }
      // Метаданные — если наши новее облачных
      const out = { book: m.book, state: m.state, notes: m.notes }
      if (!rm || !same(out, remote)) { const res = await upload('/meta/' + id + '.json', new Blob([JSON.stringify(out)], { type: 'application/json' })); revs[id] = res.rev }
      else revs[id] = rm.rev
      await db.kv('dropbox-meta-' + id, out)
    }
    await db.kv('dropbox-revs', revs)
    cfg.last = Date.now(); await db.kv('dropbox', cfg)
    ui.setStatus?.('on')
    if (changed) ui.onChange?.()
  } catch (e) {
    console.error(e); ui.setStatus?.('err'); cfg.error = String(e.message || e)
    if (/устарел|не подключён/.test(cfg.error)) ui.toast?.(cfg.error, 5000)
  }
}

export const sync = {
  enabled: () => !!cfg?.refresh,
  async init(u) {
    ui = u
    cfg = (await db.kv('dropbox')) || null
    // Возврат со страницы входа Dropbox: меняем код на ключи доступа
    const p = new URLSearchParams(location.search)
    if (p.get('code') && cfg?.verifier) {
      history.replaceState(null, '', redirect())
      try {
        const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams({ code: p.get('code'), grant_type: 'authorization_code', client_id: cfg.key, code_verifier: cfg.verifier, redirect_uri: redirect() }) })
        if (!r.ok) throw new Error(await r.text())
        const j = await r.json()
        Object.assign(cfg, { refresh: j.refresh_token, access: j.access_token, expires: Date.now() + j.expires_in * 1000, verifier: null, error: null })
        await db.kv('dropbox', cfg)
        u.toast?.('Dropbox подключён. Синхронизирую…')
      } catch (e) { u.toast?.('Не удалось подключить Dropbox: ' + (e.message || e).slice(0, 120), 6000) }
    } else if (p.get('error')) { history.replaceState(null, '', redirect()); u.toast?.('Вход в Dropbox отменён') }
    if (cfg?.refresh) { u.setStatus?.('on'); this.now() }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.now() })
    setInterval(() => { if (!document.hidden) this.now() }, 120e3)
  },
  now() { if (!cfg?.refresh) return; if (running) { again = true; return running } running = run().finally(() => { running = null; if (again) { again = false; this.soon() } }); return running },
  soon() { clearTimeout(soonT); soonT = setTimeout(() => this.now(), 2500) },
  async fetchBook(book) {
    if (!cfg?.refresh) return null
    const blob = await download(`/books/${book.id}.${book.ext}`)
    if (!blob) return null
    const rec = { id: book.id, blob, name: book.name || (book.title + '.' + book.ext) }
    await db.put('files', rec); return rec
  },
  async connect(key) {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)))
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    cfg = { key, verifier }; await db.kv('dropbox', cfg)
    location.href = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({ client_id: key, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline', redirect_uri: redirect() })
  },
  async disconnect() { cfg = null; await db.kv('dropbox', null); ui.setStatus?.('') },
  openPanel({ openSheet, closeSheet, toast }) {
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
    if (cfg?.refresh) {
      const when = cfg.last ? new Date(cfg.last).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'ещё не было'
      openSheet('Синхронизация', `<p class="hint">Книги, место чтения, выделения и заметки хранятся в вашем Dropbox, в папке «Приложения». На всех устройствах, где выполнен вход, у вас одна и та же полка.</p>
        <div class="row"><div><b>Dropbox подключён</b><span>Последняя синхронизация: ${esc(when)}</span></div></div>${cfg.error ? `<p class="hint" style="color:#c2523f">Последняя ошибка: ${esc(cfg.error)}</p>` : ''}
        <div class="btnrow"><button class="btn primary" id="syncNow">Синхронизировать сейчас</button></div><div class="btnrow"><button class="btn danger" id="syncOff">Отключить на этом устройстве</button></div>`)
      document.getElementById('syncNow').onclick = async () => { closeSheet(); toast('Синхронизирую…'); cfg.error = null; await this.now(); toast(cfg.error ? 'Ошибка: ' + cfg.error : 'Готово, всё синхронизировано') }
      document.getElementById('syncOff').onclick = async () => { await this.disconnect(); closeSheet(); toast('Синхронизация отключена. Книги на устройстве остались') }
      return
    }
    openSheet('Синхронизация', `<p class="hint">Чтобы книги, место чтения и заметки были одинаковыми на телефоне и компьютере, подключите бесплатный Dropbox. Это делается один раз.</p>
      <p class="hint"><b>Если ключ приложения у вас уже есть</b> — вставьте его и войдите:</p>
      <input class="field" id="dbxKey" placeholder="Ключ приложения (App key)" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(cfg?.key || '')}">
      <div class="btnrow"><button class="btn primary" id="dbxGo">Войти в Dropbox</button></div>
      <p class="hint" style="margin-top:18px"><b>Если ключа нет</b>, создайте его один раз на компьютере:<ol>
        <li>Откройте <b>dropbox.com/developers/apps</b> и войдите (или зарегистрируйтесь бесплатно).</li>
        <li>«Create app» → «Scoped access» → «App folder» → имя, например <code>Chitalnya-${Math.random().toString(36).slice(2, 6)}</code> → «Create app».</li>
        <li>Вкладка «Permissions»: отметьте <code>files.content.write</code> и <code>files.content.read</code> → «Submit».</li>
        <li>Вкладка «Settings» → «Redirect URIs»: вставьте <code>${esc(redirect())}</code> → «Add».</li>
        <li>Там же скопируйте «App key» и вставьте выше. Тот же ключ потом введите на телефоне.</li></ol></p>`)
    document.getElementById('dbxGo').onclick = () => { const k = document.getElementById('dbxKey').value.trim(); if (!/^[a-z0-9]{8,30}$/i.test(k)) return toast('Похоже, ключ вставлен не полностью'); this.connect(k) }
  },
}
