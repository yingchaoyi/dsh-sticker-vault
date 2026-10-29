/**
 * dsh-sticker-vault —— 表情包 / 图片库
 *
 * 群友发图先落盘 → 同一张重复出现就计数 → 计数到阈值（默认 5）自动入库
 * → 每张记着「谁发的、什么语境用的、大概什么内容」→ 对喷时按语境 / 关键词捞出来发。
 *
 * 全部本地：图片存 ~/.dsh/sticker-vault/，不打网络请求、不调模型。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync, truncateSync, copyFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

export const name = 'sticker-vault'
export const inject = ['tools']

// defineTool：优先用宿主那份，拿不到就退回本地等价实现
let defineTool = null
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  defineTool = mod.defineTool || null
} catch { /* 离线自测时没有宿主包 */ }
if (!defineTool) {
  defineTool = (options) => {
    const required = Object.entries(options.parameters || {}).filter(([, v]) => v && v.required).map(([k]) => k)
    return {
      name: options.name,
      description: options.description,
      parameters: options.parameters,
      output: options.output,
      execute(args) {
        const a = args || {}
        for (const k of required) {
          if (a[k] === undefined || a[k] === null) throw new Error(`缺少参数 ${k}`)
        }
        return options.execute(a, {})
      },
    }
  }
}

// ---------------------------------------------------------------- 路径

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const ROOT = join(HOME, 'sticker-vault')
const STORE_PATH = join(ROOT, 'store.json')
const INBOX_DIR = join(ROOT, 'inbox')
const IMAGE_DIR = join(ROOT, 'images')
const LOG_PATH = join(ROOT, 'sticker.log')
const ATTACH_ROOT = join(HOME, 'attachments', 'v1', 'objects')

const EXT_OF = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const MIME_OF = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
const CONTEXT_KEEP = 6

const DEFAULT_SETTINGS = {
  enabled: true,
  autoCapture: true,
  promoteAt: 5,
  perMember: 3,
  maxTotal: 50,
  resetDays: 5,
  resetItemTo: 2,
  uploadMaxMB: 4,
  hint: true,
}

// ---------------------------------------------------------------- 小工具

function diag(msg) {
  try {
    mkdirSync(ROOT, { recursive: true })
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > 256 * 1024) truncateSync(LOG_PATH, 0)
    writeFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`, { flag: 'a' })
  } catch { /* ignore */ }
}

const clampInt = (v, min, max, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, Math.round(n)))
}

const nowIso = () => new Date().toISOString()

function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) }
  return {
    enabled: s.enabled !== false,
    autoCapture: s.autoCapture !== false,
    promoteAt: clampInt(s.promoteAt, 2, 99, 5),
    perMember: clampInt(s.perMember, 1, 20, 3),
    maxTotal: clampInt(s.maxTotal, 5, 500, 50),
    resetDays: clampInt(s.resetDays, 1, 365, 5),
    resetItemTo: clampInt(s.resetItemTo, 0, 20, 2),
    uploadMaxMB: clampInt(s.uploadMaxMB, 1, 20, 4),
    hint: s.hint !== false,
  }
}

function emptyStore() {
  return { v: 1, settings: normalizeSettings({}), items: [], candidates: {}, lastResetAt: Date.now(), sessions: {} }
}

function normalizeItem(raw) {
  const it = raw && typeof raw === 'object' ? raw : {}
  const member = it.member && typeof it.member === 'object' ? it.member : {}
  return {
    id: String(it.id || randomUUID()),
    hash: String(it.hash || ''),
    ext: String(it.ext || 'png'),
    mediaType: String(it.mediaType || 'image/png'),
    bytes: Number(it.bytes) || 0,
    file: String(it.file || ''),
    member: { name: String(member.name || '未知'), qq: String(member.qq || '') },
    count: Math.max(1, Number(it.count) || 1),
    firstAt: Number(it.firstAt) || Date.now(),
    lastAt: Number(it.lastAt) || Date.now(),
    promotedAt: Number(it.promotedAt) || Date.now(),
    locked: it.locked === true,
    desc: String(it.desc || ''),
    tags: Array.isArray(it.tags) ? it.tags.map(String).slice(0, 12) : [],
    contexts: Array.isArray(it.contexts) ? it.contexts.slice(-CONTEXT_KEEP) : [],
    src: it.src === 'upload' ? 'upload' : 'auto',
  }
}

function normalizeCandidate(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const member = c.member && typeof c.member === 'object' ? c.member : {}
  return {
    hash: String(c.hash || ''),
    ext: String(c.ext || 'png'),
    mediaType: String(c.mediaType || 'image/png'),
    bytes: Number(c.bytes) || 0,
    member: { name: String(member.name || '未知'), qq: String(member.qq || '') },
    count: Math.max(0, Number(c.count) || 0),
    firstAt: Number(c.firstAt) || Date.now(),
    lastAt: Number(c.lastAt) || Date.now(),
    contexts: Array.isArray(c.contexts) ? c.contexts.slice(-CONTEXT_KEEP) : [],
  }
}

// ---------------------------------------------------------------- 存储

let cache = null

function load() {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    cache = {
      v: 1,
      settings: normalizeSettings(raw.settings),
      items: Array.isArray(raw.items) ? raw.items.map(normalizeItem) : [],
      candidates: raw.candidates && typeof raw.candidates === 'object' ? raw.candidates : {},
      lastResetAt: Number(raw.lastResetAt) || Date.now(),
      sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
    }
    for (const k of Object.keys(cache.candidates)) cache.candidates[k] = normalizeCandidate(cache.candidates[k])
  } catch {
    cache = emptyStore()
  }
  return cache
}

function save(data) {
  cache = data
  try {
    mkdirSync(ROOT, { recursive: true })
    const tmp = STORE_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, STORE_PATH)
  } catch (error) {
    diag('存储失败：' + (error && error.message))
  }
}

// ---------------------------------------------------------------- 成员 / 路径

const memberId = (m) => (m && (m.qq || m.name) ? String(m.qq || m.name) : 'unknown')
const candKey = (m, hash) => `${memberId(m)}#${hash}`

const ENVELOPE = /^\s*\[([^\]]{1,24}?)\((\d{5,12})\)\]\s*/
const ENVELOPE_AT = /\[([^\]]{1,24}?)\((\d{5,12})\)\]/

function splitEnvelope(text) {
  const s = String(text || '')
  const m = s.match(ENVELOPE)
  if (m) return { member: { name: m[1].trim(), qq: m[2] }, body: s.slice(m[0].length) }
  const m2 = s.match(ENVELOPE_AT)
  if (m2) return { member: { name: m2[1].trim(), qq: m2[2] }, body: s.slice(m2.index + m2[0].length) }
  return { member: null, body: s }
}

function inboxPath(hash, ext) { return join(INBOX_DIR, `${hash}.${ext}`) }
function imagePath(item) { return join(IMAGE_DIR, item.file) }
function absPathOf(item) { return imagePath(item) }

function attachmentPath(attachmentId) {
  const hex = String(attachmentId || '').replace(/^sha256:/, '').toLowerCase()
  if (!/^[0-9a-f]{16,128}$/.test(hex)) return null
  return join(ATTACH_ROOT, hex.slice(0, 2), hex)
}

// ---------------------------------------------------------------- 入库 / 淘汰

function pushContext(list, text) {
  const t = String(text || '').trim().slice(0, 120)
  if (!t) return
  const last = list[list.length - 1]
  if (last && last.text === t && Date.now() - last.at < 60_000) return
  list.push({ at: Date.now(), text: t })
  while (list.length > CONTEXT_KEEP) list.shift()
}

function lowestUnlocked(items, exceptId) {
  const pool = items.filter((it) => !it.locked && it.id !== exceptId)
  if (!pool.length) return null
  pool.sort((a, b) => (a.count - b.count) || (a.lastAt - b.lastAt))
  return pool[0]
}

function enforceCaps(data, member, keepId) {
  const { perMember, maxTotal } = data.settings
  const mine = () => data.items.filter((it) => memberId(it.member) === memberId(member))
  while (mine().length > perMember) {
    const victim = lowestUnlocked(mine(), keepId)
    if (!victim) break
    dropItem(data, victim, '超出每人上限')
  }
  while (data.items.length > maxTotal) {
    const victim = lowestUnlocked(data.items, keepId)
    if (!victim) break
    dropItem(data, victim, '超出总容量')
  }
  return data
}

function dropItem(data, item, reason) {
  try {
    const p = imagePath(item)
    if (existsSync(p)) unlinkSync(p)
  } catch { /* ignore */ }
  data.items = data.items.filter((x) => x.id !== item.id)
  diag(`淘汰 ${item.id}（${reason}）`)
}

function promote(data, cand, extra = {}) {
  const ext = cand.ext || 'png'
  const src = inboxPath(cand.hash, ext)
  const id = `${cand.hash.slice(0, 12)}-${memberId(cand.member).replace(/[^\w.-]/g, '').slice(0, 12)}`
  const file = `${id}.${ext}`
  try {
    mkdirSync(IMAGE_DIR, { recursive: true })
    if (existsSync(src)) copyFileSync(src, join(IMAGE_DIR, file))
    else if (!existsSync(join(IMAGE_DIR, file))) return null
  } catch (error) {
    diag('入库拷图失败：' + (error && error.message))
    return null
  }
  const item = normalizeItem({
    id, hash: cand.hash, ext, mediaType: cand.mediaType, bytes: cand.bytes, file,
    member: cand.member, count: cand.count, firstAt: cand.firstAt, lastAt: cand.lastAt,
    promotedAt: Date.now(), locked: false, desc: extra.desc || '', tags: extra.tags || [cand.member.name],
    contexts: cand.contexts, src: extra.src || 'auto',
  })
  data.items.push(item)
  return item
}

function resetIfDue(data, now) {
  const days = data.settings.resetDays
  if (now - data.lastResetAt < days * 86400_000) return false
  // 候选清零，已入库的重置成 resetItemTo（默认 2）——库里的老图重新计数，
  // 但比新冒出来的候选高一点，别一进来就被挤掉
  for (const k of Object.keys(data.candidates)) data.candidates[k].count = 0
  for (const it of data.items) it.count = data.settings.resetItemTo
  data.lastResetAt = now
  diag(`计数周期到（${days} 天）：候选清零，库内重置为 ${data.settings.resetItemTo}`)
  return true
}

// ---------------------------------------------------------------- 检索

function tokensOf(text) {
  const s = String(text || '').toLowerCase()
  const out = new Set()
  for (const w of s.split(/[^a-z0-9\u4e00-\u9fff]+/i)) if (w.length >= 2) out.add(w)
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2))
  return out
}

function itemText(it) {
  return [it.desc, (it.tags || []).join(' '), it.member.name, ...(it.contexts || []).map((c) => c.text)].join(' ').toLowerCase()
}

function scoreItem(it, q) {
  let s = 0
  const text = itemText(it)
  for (const t of q) if (text.includes(t)) s += t.length >= 2 ? 2 : 1
  return s
}

function searchItems(data, query, limit = 3, member = '') {
  const q = tokensOf(query)
  const m = String(member || '').trim()
  const pool = data.items.filter((it) => !m || it.member.name === m || (it.member.qq && it.member.qq === m))
  if (!q.size) return pool.slice().sort((a, b) => b.count - a.count).slice(0, limit)
  const scored = pool.map((it) => ({ it, s: scoreItem(it, q) })).filter((r) => r.s > 0)
  scored.sort((a, b) => (b.s - a.s) || (b.it.count - a.it.count))
  return scored.slice(0, limit).map((r) => r.it)
}

// ---------------------------------------------------------------- 采集

function messageParts(m) {
  if (!m) return []
  if (Array.isArray(m.content)) return m.content
  if (typeof m.content === 'string') return [{ type: 'text', text: m.content }]
  return []
}

function sessionIdOf(session) {
  try {
    if (!session) return ''
    return String(session.id || session.sessionId || session.key || '') || ''
  } catch { return '' }
}

function userMessages(session) {
  try {
    if (!session) return []
    // 会话消息的正确读法是 deriveMessages()；老版本写的 messages() 根本不存在，
    // 于是每个会话永远扫到 0 条 —— 图全落不到候选里。
    let list = null
    if (typeof session.deriveMessages === 'function') list = session.deriveMessages()
    else if (typeof session.messages === 'function') list = session.messages()
    if (!Array.isArray(list)) return []
    return list.filter((m) => m && m.role === 'user')
  } catch { return [] }
}

function captureImages(data, sid, userMsgs) {
  let changed = false
  const state = data.sessions[sid] || { count: 0, member: null }
  let seen = Math.max(0, Number(state.count) || 0)
  // 第一次见这个会话：别把一整个月的历史图全灌进候选，只看最近的
  if (!state.initialized) {
    state.initialized = true
    seen = state.count = Math.max(0, userMsgs.length - 200)
    if (seen > 0) diag(`首见会话 ${sid.slice(0, 14)}：跳过 ${seen} 条历史，只看最近 200 条`)
  }
  if (userMsgs.length < seen) seen = 0 // 历史被压缩/截断过，从头算，避免漏
  for (let i = seen; i < userMsgs.length; i++) {
    const m = userMsgs[i]
    const parts = messageParts(m)
    const text = parts.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ')
    const env = splitEnvelope(text)
    if (env.member) state.member = env.member
    const body = (env.body || '').trim()
    const images = parts.filter((p) => p && p.type === 'image' && p.attachment)
    if (!images.length) { continue }
    const member = state.member || { name: '未知', qq: '' }
    const context = body ? `${member.name}：${body.slice(0, 100)}` : `${member.name}：发了一张图`
    const seenHashes = new Set()
    for (const p of images) {
      const hash = String(p.attachment.attachmentId || '').replace(/^sha256:/, '').toLowerCase()
      if (!hash || seenHashes.has(hash)) continue
      seenHashes.add(hash)
      const src = attachmentPath(p.attachment.attachmentId)
      if (!src || !existsSync(src)) { diag('找不到附件文件：' + hash.slice(0, 12)); continue }
      const mediaType = String(p.attachment.mediaType || 'image/png')
      const ext = EXT_OF[mediaType] || 'png'
      const dest = inboxPath(hash, ext)
      try {
        if (!existsSync(dest)) {
          mkdirSync(INBOX_DIR, { recursive: true })
          copyFileSync(src, dest)
        }
      } catch (error) { diag('落盘失败：' + (error && error.message)); continue }
      changed = true
      const key = candKey(member, hash)
      const existing = data.items.find((it) => it.hash === hash && memberId(it.member) === memberId(member))
      if (existing) {
        existing.count += 1
        existing.lastAt = Date.now()
        pushContext(existing.contexts, context)
        continue
      }
      const cand = data.candidates[key] || normalizeCandidate({
        hash, ext, mediaType, bytes: Number(p.attachment.bytes) || 0, member,
        count: 0, firstAt: Date.now(), lastAt: Date.now(), contexts: [],
      })
      cand.count += 1
      cand.lastAt = Date.now()
      cand.bytes = Number(p.attachment.bytes) || cand.bytes
      pushContext(cand.contexts, context)
      if (cand.count >= data.settings.promoteAt) {
        const item = promote(data, cand)
        if (item) { delete data.candidates[key]; diag(`入库 ${item.id}（${member.name} 第 ${cand.count} 次）`); enforceCaps(data, member, item.id) }
      } else {
        data.candidates[key] = cand
      }
    }
  }
  state.count = userMsgs.length
  data.sessions[sid] = state
  return changed
}

// ---------------------------------------------------------------- 对外状态

function fileUrl(id) { return `/api/sticker-vault/file?id=${encodeURIComponent(id)}` }

function publicItem(it) {
  return {
    id: it.id, desc: it.desc, tags: it.tags, member: it.member, count: it.count,
    locked: it.locked, src: it.src, bytes: it.bytes, promotedAt: it.promotedAt, lastAt: it.lastAt,
    contexts: it.contexts, url: fileUrl(it.id),
  }
}

function publicState() {
  const data = load()
  const now = Date.now()
  if (resetIfDue(data, now)) save(data)
  const items = data.items.slice().sort((a, b) => (b.count - a.count) || (b.lastAt - a.lastAt)).map(publicItem)
  const candidates = Object.entries(data.candidates)
    .map(([key, c]) => ({ key, hash: c.hash, member: c.member, count: c.count, lastAt: c.lastAt, ext: c.ext, bytes: c.bytes, contexts: c.contexts, url: '' }))
    .sort((a, b) => b.count - a.count)
  const members = [...new Set(items.map((i) => i.member.name))]
  return {
    ok: true,
    settings: data.settings,
    defaults: DEFAULT_SETTINGS,
    stats: { items: items.length, candidates: candidates.length, maxTotal: data.settings.maxTotal, perMember: data.settings.perMember, promoteAt: data.settings.promoteAt, resetDays: data.settings.resetDays, resetItemTo: data.settings.resetItemTo, lastResetAt: data.lastResetAt },
    items,
    candidates,
    members,
  }
}

// ---------------------------------------------------------------- HTTP 小工具

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 24e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function sendFile(res, item) {
  try {
    const p = absPathOf(item)
    if (!existsSync(p)) return sendJson(res, 404, { ok: false, error: '文件不在了' })
    const buf = readFileSync(p)
    res.writeHead(200, { 'content-type': MIME_OF[item.ext] || 'image/png', 'content-length': buf.length, 'cache-control': 'max-age=60' })
    res.end(buf)
  } catch (error) {
    try { sendJson(res, 500, { ok: false, error: String(error && error.message) }) } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 工具

function makePickTool() {
  return defineTool({
    name: 'sticker_pick',
    description: '从表情包里挑一张来发。按语境 / 关键词 / 群友挑：返回图片的 Markdown 行和语境标签。跟群友对喷、接梗、遇到相同的语境时先用它找，找到合适的就把 markdown 原样放进回复里发出去；没合适的就自己说话，别硬凑。',
    parameters: {
      query: { type: 'string', description: '当前的语境或关键词（对方说了啥、在聊什么）' },
      member: { type: 'string', description: '只找某个群友发的图（昵称或 QQ）' },
      limit: { type: 'number', description: '最多给几张，默认 3' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, text: { type: 'string' } } },
      render(_args, value) { return [{ type: 'text', text: String((value && value.text) || '（没有合适的图）') }] },
    },
    async execute(args) {
      const data = load()
      if (resetIfDue(data, Date.now())) save(data)
      const picked = searchItems(data, args && args.query, clampInt(args && args.limit, 1, 8, 3), args && args.member)
      if (!picked.length) return { ok: true, text: '（库里没有对得上这个语境的图，别硬发）' }
      const text = picked.map((it) => {
        const ctx = (it.contexts || []).slice(-2).map((c) => c.text).join(' / ')
        return `![${it.desc || it.member.name}的图](${absPathOf(it)})\n  作者：${it.member.name}${it.member.qq ? `(${it.member.qq})` : ''} · 用过 ${it.count} 次 · 标签：${(it.tags || []).join('、') || '无'}${ctx ? `\n  语境：${ctx}` : ''}`
      }).join('\n\n')
      return { ok: true, text }
    },
  })
}

function makeNoteTool() {
  return defineTool({
    name: 'sticker_note',
    description: '管表情库：改描述 / 标签、上锁（锁了就不会被新图挤掉）、删除。也可以把本地图片手动加进库里。',
    parameters: {
      action: { type: 'string', enum: ['update', 'add', 'delete'], description: '默认 update' },
      id: { type: 'string', description: '改 / 删的时候给 id（用的 sticker_pick 会带）' },
      path: { type: 'string', description: 'add 时给本地图片的绝对路径' },
      member: { type: 'string', description: 'add 时给谁发的（昵称）' },
      desc: { type: 'string', description: '描述：这张图是什么内容' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签：什么语境能用' },
      locked: { type: 'boolean', description: '是否上锁' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, text: { type: 'string' } } },
      render(_args, value) { return [{ type: 'text', text: String((value && value.text) || '') }] },
    },
    async execute(args) {
      const data = load()
      const a = args || {}
      const action = a.action || 'update'
      if (action === 'delete') {
        const it = data.items.find((x) => x.id === a.id)
        if (!it) return { ok: false, text: '没有这个 id' }
        dropItem(data, it, '工具删除')
        save(data)
        return { ok: true, text: `已删除 ${it.id}` }
      }
      if (action === 'add') {
        const p = String(a.path || '')
        if (!p || !isAbsolute(p) || !existsSync(p)) return { ok: false, text: 'path 要是存在的绝对路径' }
        const buf = readFileSync(p)
        const hash = createHash('sha256').update(buf).digest('hex')
        const ext = (p.split('.').pop() || 'png').toLowerCase()
        const useExt = EXT_OF[`image/${ext}`] ? ext : 'png'
        mkdirSync(INBOX_DIR, { recursive: true })
        copyFileSync(p, inboxPath(hash, useExt))
        const item = promote(data, normalizeCandidate({ hash, ext: useExt, mediaType: MIME_OF[useExt] || 'image/png', bytes: buf.length, member: { name: a.member || '手动上传', qq: '' }, count: 1, contexts: [] }), { desc: a.desc || '', tags: a.tags || [], src: 'upload' })
        if (!item) return { ok: false, text: '入库失败' }
        if (a.locked) item.locked = true
        enforceCaps(data, item.member, item.id)
        save(data)
        return { ok: true, text: `已加入 ${item.id}` }
      }
      const it = data.items.find((x) => x.id === a.id)
      if (!it) return { ok: false, text: '没有这个 id' }
      if (typeof a.desc === 'string') it.desc = a.desc
      if (Array.isArray(a.tags)) it.tags = a.tags.slice(0, 12)
      if (typeof a.locked === 'boolean') it.locked = a.locked
      save(data)
      return { ok: true, text: `已更新 ${it.id}` }
    },
  })
}

function makeStatsTool() {
  return defineTool({
    name: 'sticker_stats',
    description: '看表情库的占用：库里几张、候选几张、每人上限、达标次数、计数周期。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, text: { type: 'string' } } },
      render(_args, value) { return [{ type: 'text', text: String((value && value.text) || '') }] },
    },
    async execute() {
      const st = publicState()
      return { ok: true, text: `库 ${st.stats.items}/${st.stats.maxTotal} 张 · 候选 ${st.stats.candidates} 张 · 每人上限 ${st.stats.perMember} · 达标 ${st.stats.promoteAt} 次 · 计数 ${st.stats.resetDays} 天清一次` }
    },
  })
}

// ---------------------------------------------------------------- 插件本体

export function apply(ctx, config = {}) {
  diag('插件启动 v0.1.1（清计数：候选归零 / 库内重置为设定值）')
  const data0 = load()
  if (config && Object.keys(config).length && !existsSync(STORE_PATH)) {
    data0.settings = normalizeSettings({ ...data0.settings, ...config })
    save(data0)
  }
  mkdirSync(INBOX_DIR, { recursive: true })
  mkdirSync(IMAGE_DIR, { recursive: true })

  const toolsOff = []
  for (const make of [makePickTool, makeNoteTool, makeStatsTool]) {
    try { toolsOff.push(ctx.tools.register(make())) } catch (error) { diag('工具挂载失败：' + (error && error.message)) }
  }

  // ---- 定时采集：每 2 秒扫一遍每个会话的最后一条新消息 ----
  ctx.inject(['agents'], (c) => {
    try {
      let lastErr = ''
      const tick = () => {
        try {
          const data = load()
          if (!data.settings.enabled || !data.settings.autoCapture) return
          const list = (c.agents && typeof c.agents.list === 'function') ? c.agents.list() : []
          let dirty = resetIfDue(data, Date.now())
          for (const agent of list) {
            const sid = sessionIdOf(agent && agent.session)
            if (!sid) continue
            if (captureImages(data, sid, userMessages(agent.session))) dirty = true
          }
          if (dirty) save(data)
        } catch (error) {
          const msg = String(error && error.message)
          if (msg.includes('inactive context')) return
          if (msg !== lastErr) { lastErr = msg; diag('tick 出错：' + msg) }
        }
      }
      tick()
      const timer = setInterval(tick, 2000)
      if (timer.unref) timer.unref()
      c.effect(() => () => { try { clearInterval(timer) } catch { /* ignore */ } })
    } catch (error) { diag('定时器挂不上：' + (error && error.message)) }
  })

  // ---- 给模型一句话提示（不占多少 token，但能让它知道库在哪）----
  const mounted = new Map()
  function mountHint(agent) {
    const sid = sessionIdOf(agent && agent.session)
    if (!sid || mounted.has(sid)) return
    try {
      const off = agent.ctx.systemPrompt.context({
        name: 'sticker-vault',
        order: 912,
        interpolate: false,
        text: () => {
          const data = load()
          if (!data.settings.enabled || !data.settings.hint) return ''
          if (!data.items.length) return ''
          return `【表情库】有 ${data.items.length} 张群友的表情包（最多 ${data.settings.maxTotal} 张）。跟群友接梗、对喷、遇到相同语境时，用 sticker_pick 按语境找一张，把返回的 Markdown 原样放进回复；没合适的就别硬发。`
        },
      })
      mounted.set(sid, typeof off === 'function' ? off : (off && off.off) || (() => {}))
    } catch (error) {
      const msg = String((error && error.message) || '')
      if (msg.includes('already registered')) mounted.set(sid, () => {})
      else diag('提示挂不上：' + msg)
    }
  }
  ctx.inject(['agents'], (c) => {
    try {
      const tick = () => {
        try {
          const list = (c.agents && typeof c.agents.list === 'function') ? c.agents.list() : []
          for (const agent of list) mountHint(agent)
        } catch { /* ignore */ }
      }
      tick()
      const timer = setInterval(tick, 5000)
      if (timer.unref) timer.unref()
      c.effect(() => () => { try { clearInterval(timer) } catch { /* ignore */ } })
    } catch { /* ignore */ }
  })

  ctx.on('dispose', () => {
    for (const off of mounted.values()) { try { off() } catch { /* ignore */ } }
    mounted.clear()
    for (const off of toolsOff) { try { off() } catch { /* ignore */ } }
  })

  // ---- 面板路由 ----
  ctx.inject(['webServer'], (c) => {
    try {
      const route = (path, handler) => {
        if (!c.webServer || typeof c.webServer.register !== 'function') return
        c.effect(() => c.webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            try { await handler(req, res) } catch (error) {
              try { sendJson(res, 500, { ok: false, error: String(error && error.message) }) } catch { /* ignore */ }
            }
          },
        }))
      }

      route('/api/sticker-vault/state', async (_req, res) => sendJson(res, 200, publicState()))

      route('/api/sticker-vault/settings', async (req, res) => {
        const body = await readBody(req)
        const data = load()
        data.settings = normalizeSettings({ ...data.settings, ...(body.patch || body) })
        save(data)
        sendJson(res, 200, { ok: true, settings: data.settings })
      })

      route('/api/sticker-vault/item', async (req, res) => {
        const body = await readBody(req)
        const data = load()
        const it = data.items.find((x) => x.id === body.id)
        if (!it) return sendJson(res, 404, { ok: false, error: '没有这张' })
        if (typeof body.desc === 'string') it.desc = body.desc
        if (Array.isArray(body.tags)) it.tags = body.tags.map(String).slice(0, 12)
        if (typeof body.locked === 'boolean') it.locked = body.locked
        save(data)
        sendJson(res, 200, { ok: true, item: publicItem(it) })
      })

      route('/api/sticker-vault/delete', async (req, res) => {
        const body = await readBody(req)
        const data = load()
        if (body.key) {
          const key = String(body.key)
          if (!data.candidates[key]) return sendJson(res, 404, { ok: false, error: '没有这个候选' })
          const cand = data.candidates[key]
          delete data.candidates[key]
          // 候选都删了就把 inbox 里没人用的文件也清掉
          const used = Object.values(data.candidates).some((c) => c.hash === cand.hash) || data.items.some((i) => i.hash === cand.hash)
          if (!used) { try { const p = inboxPath(cand.hash, cand.ext); if (existsSync(p)) unlinkSync(p) } catch { /* ignore */ } }
          save(data)
          return sendJson(res, 200, { ok: true })
        }
        const it = data.items.find((x) => x.id === body.id)
        if (!it) return sendJson(res, 404, { ok: false, error: '没有这张' })
        if (it.locked && !body.force) return sendJson(res, 403, { ok: false, error: '上锁的图不能删，先解锁' })
        dropItem(data, it, '面板删除')
        save(data)
        sendJson(res, 200, { ok: true })
      })

      route('/api/sticker-vault/promote', async (req, res) => {
        const body = await readBody(req)
        const data = load()
        const key = String(body.key || '')
        const cand = data.candidates[key]
        if (!cand) return sendJson(res, 404, { ok: false, error: '没有这个候选' })
        if (data.items.length >= data.settings.maxTotal && !lowestUnlocked(data.items)) {
          return sendJson(res, 400, { ok: false, error: '库满了，而且都被锁着，得先解锁一张' })
        }
        const item = promote(data, cand, { desc: body.desc || '', tags: body.tags || [] })
        if (!item) return sendJson(res, 500, { ok: false, error: '入库失败' })
        delete data.candidates[key]
        enforceCaps(data, item.member, item.id)
        save(data)
        sendJson(res, 200, { ok: true, item: publicItem(item) })
      })

      route('/api/sticker-vault/upload', async (req, res) => {
        const body = await readBody(req)
        const data = load()
        const raw = String(body.data || '')
        const m = raw.match(/^data:([^;]+);base64,(.+)$/)
        const b64 = m ? m[2] : raw
        let buf
        try { buf = Buffer.from(b64, 'base64') } catch { return sendJson(res, 400, { ok: false, error: 'base64 解析失败' }) }
        if (!buf.length) return sendJson(res, 400, { ok: false, error: '空文件' })
        if (buf.length > data.settings.uploadMaxMB * 1024 * 1024) return sendJson(res, 400, { ok: false, error: `超过 ${data.settings.uploadMaxMB}MB` })
        const mediaType = m ? m[1] : 'image/png'
        const ext = EXT_OF[mediaType] || 'png'
        const hash = createHash('sha256').update(buf).digest('hex')
        mkdirSync(INBOX_DIR, { recursive: true })
        writeFileSync(inboxPath(hash, ext), buf)
        const item = promote(data, normalizeCandidate({ hash, ext, mediaType, bytes: buf.length, member: { name: body.member || '手动上传', qq: String(body.qq || '') }, count: 1, contexts: [] }), { desc: body.desc || '', tags: body.tags || [], src: 'upload' })
        if (!item) return sendJson(res, 500, { ok: false, error: '入库失败' })
        if (body.locked) item.locked = true
        enforceCaps(data, item.member, item.id)
        save(data)
        sendJson(res, 200, { ok: true, item: publicItem(item) })
      })

      route('/api/sticker-vault/reset', async (_req, res) => {
        const data = load()
        for (const k of Object.keys(data.candidates)) data.candidates[k].count = 0
        for (const it of data.items) it.count = data.settings.resetItemTo
        data.lastResetAt = Date.now()
        save(data)
        sendJson(res, 200, { ok: true })
      })

      // 候选图的缩略图（还没入库，按 key 读 inbox）
      route('/api/sticker-vault/thumb', async (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const key = url.searchParams.get('key') || ''
        const data = load()
        const cand = data.candidates[key]
        if (!cand) return sendJson(res, 404, { ok: false, error: '没有这个候选' })
        const p = inboxPath(cand.hash, cand.ext)
        if (!existsSync(p)) return sendJson(res, 404, { ok: false, error: '文件不在了' })
        const buf = readFileSync(p)
        res.writeHead(200, { 'content-type': MIME_OF[cand.ext] || 'image/png', 'content-length': buf.length, 'cache-control': 'max-age=30' })
        res.end(buf)
      })

      // 图片文件
      if (c.webServer && typeof c.webServer.register === 'function') {
        c.effect(() => c.webServer.register({
          kind: 'prefix',
          path: '/api/sticker-vault/file',
          handler: async (req, res) => {
            const url = new URL(req.url, 'http://localhost')
            const id = url.searchParams.get('id') || ''
            const data = load()
            const it = data.items.find((x) => x.id === id)
            if (!it) return sendJson(res, 404, { ok: false, error: '没有这张' })
            sendFile(res, it)
          },
        }))
      }
    } catch (error) { diag('路由挂载失败：' + (error && error.message)) }
  })
}
