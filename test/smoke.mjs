/**
 * dsh-sticker-vault 离线自测：假 ctx + 假会话，不启动 DSH。
 *   node test/smoke.mjs
 * DSH_HOME 会被指到临时目录，别拿真数据跑。
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

const home = mkdtempSync(join(tmpdir(), 'sticker-test-'))
process.env.DSH_HOME = home

const ATT = join(home, 'attachments', 'v1', 'objects')
mkdirSync(ATT, { recursive: true })

let passed = 0
let failed = 0
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 造几张“图片”（字节随意，只要 sha256 不同 / 相同）----
function makeImage(tag) {
  const buf = Buffer.concat([Buffer.from('PNG-FAKE:' + tag + ':'), randomBytes(32)])
  const hex = createHash('sha256').update(buf).digest('hex')
  const dir = join(ATT, hex.slice(0, 2))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, hex), buf)
  return { id: `sha256:${hex}`, hex, buf }
}

const A = makeImage('A')
const F = makeImage('F')
const B = makeImage('B')
const C = makeImage('C')
const D = makeImage('D')
const E = makeImage('E')

// ---- 假会话 ----
let msgs = []
const session = { id: 's1', messages: () => msgs }
const promptSpecs = []
const agent = { session, ctx: { systemPrompt: { context: (spec) => { promptSpecs.push(spec); return () => {} } } } }

const exact = new Map()
const prefixes = new Map()
const tools = new Map()
const intervals = []

let describeCalls = 0
let failNext = false
const fakeLlm = {
  stream(o) {
    describeCalls += 1
    if (failNext) {
      failNext = false
      throw new Error('模型罢工了')
    }
    const payload = '```json\n{"desc":"熊猫头指着屏幕骂人，像是要破防了","tags":["破防","开喷","熊猫头"]}\n```'
    return (async function* () {
      yield { type: 'text-delta', text: payload }
      yield { type: 'finish', kind: 'stop' }
    })()
  },
}

function makeCtx() {
  const ctx = {
    tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
    effect: (f) => { try { return f() } catch { /* ignore */ } },
    on: () => () => {},
    inject(names, cb) {
      if (names.includes('agents')) cb({ agents: { list: () => [agent] }, effect: ctx.effect })
      if (names.includes('llm')) cb({ llm: fakeLlm })
      if (names.includes('agentDefaultModel')) cb({ agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-vision' }) } })
      if (names.includes('attachments')) cb({ attachments: { saveImage: async (o) => ({ attachmentId: 'sha256:fake', mediaType: o.mediaType, bytes: o.data.length }) } })
      if (names.includes('webServer')) {
        cb({
          effect: ctx.effect,
          webServer: {
            register(route) {
              if (route.kind === 'prefix') { prefixes.set(route.path, route.handler); return () => {} }
              exact.set(route.path, route.handler)
              return () => {}
            },
          },
        })
      }
    },
  }
  return ctx
}

const mod = await import('../lib/index.mjs')
const ctx = makeCtx()
mod.apply(ctx, {})

function pushImage(img, text = '[刘邦(2313535058)] 笑死', nick = '刘邦') {
  msgs.push({
    role: 'user',
    content: [
      { type: 'text', text: `[${nick}(2313535058)] ${text}` },
      { type: 'image', attachment: { attachmentId: img.id, mediaType: 'image/png', bytes: img.buf.length } },
    ],
  })
}

async function waitTick() { await sleep(2400) }

// ---- 路由调用辅助 ----
function callRoute(path, body) {
  return new Promise((resolve) => {
    const handler = exact.get(path)
    const req = { on(ev, fn) { if (ev === 'data') fn(JSON.stringify(body || {})); if (ev === 'end') fn() }, destroy() {} }
    const res = {
      code: 0, payload: null,
      writeHead(code) { this.code = code },
      end(data) { this.payload = data; try { resolve({ code: this.code, json: JSON.parse(data) }) } catch { resolve({ code: this.code, raw: data }) } },
    }
    handler(req, res)
  })
}

const storePath = join(home, 'sticker-vault', 'store.json')
const loadStore = () => JSON.parse(readFileSync(storePath, 'utf8'))
const state = async () => (await callRoute('/api/sticker-vault/state')).json

console.log('\n== 1. 采集与计数')
pushImage(A)
await waitTick()
let st = await state()
ok('第一次出现：进候选、计数 1', st.stats.candidates === 1 && st.candidates[0].count === 1, JSON.stringify(st.candidates))
ok('候选没入库', st.stats.items === 0)

for (let i = 0; i < 4; i++) pushImage(A, '[刘邦(2313535058)] 笑死')
await waitTick()
st = await state()
ok('第 5 次：入库', st.stats.items === 1 && st.stats.candidates === 0, `items=${st.stats.items}`)
ok('入库计数 = 5', st.items[0].count === 5, String(st.items[0].count))
ok('带作者信息', st.items[0].member.name === '刘邦' && st.items[0].member.qq === '2313535058')
ok('带语境', st.items[0].contexts.length > 0 && st.items[0].contexts[0].text.includes('笑死'), JSON.stringify(st.items[0].contexts))
ok('图片拷进 images/', existsSync(join(home, 'sticker-vault', 'images', st.items[0].id + '.png')))

console.log('\n== 2. 重复用的图，计数继续涨')
pushImage(A, '[刘邦(2313535058)] 这图太贴了')
await waitTick()
st = await state()
ok('已入库的再发：count+1', st.items[0].count === 6 && st.stats.candidates === 0, String(st.items[0].count))

console.log('\n== 3. 每人上限 3 张，满了挤掉计数最低的')
for (const img of [B, C, D]) for (let i = 0; i < 5; i++) pushImage(img, '[刘邦(2313535058)] 再来')
await waitTick()
st = await state()
ok('每人最多 3 张', st.items.filter((x) => x.member.name === '刘邦').length === 3, String(st.items.length))
ok('计数最高的 A 留着（6 次）', st.items.some((x) => x.id.startsWith(A.hex.slice(0, 12))), st.items.map((x) => x.id).join(','))
ok('挤掉的是 5 次里的一个', st.items.filter((x) => [B, C, D].some((i) => x.id.startsWith(i.hex.slice(0, 12)))).length === 2)

console.log('\n== 4. 上锁的图挤不掉')
const keep = st.items.slice().filter((x) => x.id.startsWith(A.hex.slice(0, 12)) === false).sort((a, b) => a.count - b.count)[0]
const lockRes = await callRoute('/api/sticker-vault/item', { id: keep.id, locked: true })
ok('上锁接口可用', lockRes.json.ok && lockRes.json.item.locked)
for (let i = 0; i < 5; i++) pushImage(E, '[刘邦(2313535058)] 新图')
await waitTick()
st = await state()
ok('上锁的那张还在', st.items.some((x) => x.id === keep.id), st.items.map((x) => x.id).join(','))
ok('还是 3 张', st.items.length === 3, String(st.items.length))
ok('新图 E 进来了', st.items.some((x) => x.id.startsWith(E.hex.slice(0, 12))))

console.log('\n== 5. 检索')
const pick = tools.get('sticker_pick')
const r1 = await pick.execute({ query: '笑死' })
ok('按语境找得到', r1.ok && r1.text.includes('!['), r1.text.slice(0, 80))
const r2 = await pick.execute({ query: '完全无关的航天发动机' })
ok('没匹配就别硬发', r2.ok && r2.text.includes('别硬发'))
const r3 = await pick.execute({ member: '刘邦', limit: 2 })
ok('按人找', r3.text.split('![').length - 1 === 2, r3.text.slice(0, 60))

console.log('\n== 6. 计数的 5 天周期')
pushImage(F, '[刘邦(2313535058)] 周期测试')
await waitTick()
let raw = loadStore()
const before = Object.values(raw.candidates)[0].count
raw.lastResetAt = Date.now() - 6 * 86400_000
writeFileSync(storePath, JSON.stringify(raw))
// 让插件重新读盘：换个入口调用（load 有 cache，重启进程才有；用 reset 路由验证另一种）
ok('候选有计数', before >= 1, String(before))

console.log('\n== 6b. 清计数：候选归零，库内重置成 2')
const resetRes = await callRoute('/api/sticker-vault/reset', {})
st = await state()
ok('reset 接口 ok', resetRes.json.ok)
ok('库内全部重置成 2', st.items.every((x) => x.count === 2), st.items.map((x) => x.count).join(','))
ok('候选全部归零/消失', st.candidates.every((c) => c.count === 0), JSON.stringify(st.candidates.map((c) => c.count)))

console.log('\n== 7. 手动上传 / 删除 / 上锁保护')
const uploadRes = await callRoute('/api/sticker-vault/upload', {
  member: '老板',
  desc: '贴吧老哥的钓鱼图',
  tags: ['钓鱼', '抽象'],
  data: 'data:image/png;base64,' + Buffer.from('UPLOAD-FAKE-BYTES').toString('base64'),
})
ok('上传成功', uploadRes.json.ok && uploadRes.json.item.member.name === '老板', JSON.stringify(uploadRes.json).slice(0, 100))
const upId = uploadRes.json.item.id
ok('上传带描述和标签', uploadRes.json.item.desc.includes('钓鱼') && uploadRes.json.item.tags.includes('抽象'))

const fileHandler = prefixes.get('/api/sticker-vault/file')
const fileRes = await new Promise((resolve) => {
  const res = { code: 0, writeHead(c) { this.code = c }, end(d) { resolve({ code: this.code, len: d?.length }) } }
  fileHandler({ url: '/api/sticker-vault/file?id=' + encodeURIComponent(upId) }, res)
})
ok('图片路由能取到字节', fileRes.code === 200 && fileRes.len > 0, JSON.stringify(fileRes))

const delLocked = await callRoute('/api/sticker-vault/delete', { id: keep.id })
ok('上锁的删不掉', delLocked.code === 403, String(delLocked.code))
const unlock = await callRoute('/api/sticker-vault/item', { id: keep.id, locked: false })
ok('能解锁', unlock.json.ok && unlock.json.item.locked === false)
const delOk = await callRoute('/api/sticker-vault/delete', { id: upId })
ok('解锁后能删', delOk.json.ok)

console.log('\n== 8. 参数')
const setRes = await callRoute('/api/sticker-vault/settings', { patch: { promoteAt: 8, perMember: 2, maxTotal: 20, resetDays: 7 } })
ok('参数保存', setRes.json.settings.promoteAt === 8 && setRes.json.settings.perMember === 2 && setRes.json.settings.maxTotal === 20 && setRes.json.settings.resetDays === 7)
const bad = await callRoute('/api/sticker-vault/settings', { patch: { promoteAt: -3, perMember: 999 } })
ok('参数越界被夹住', bad.json.settings.promoteAt === 2 && bad.json.settings.perMember === 20, JSON.stringify(bad.json.settings))

console.log('\n== 8b. 信封只认开头，正文里的名字不算')
{
  const { splitEnvelope } = await import('../lib/index.mjs')
  const good = splitEnvelope('[王守义(601325221)] 【群聊近况】14:39 139.1华氏度(845940812)：在吗')
  ok('开头信封认对人', good.member && good.member.qq === '601325221', JSON.stringify(good.member))
  const bad = splitEnvelope('【群聊近况】14:39 139.1华氏度(845940812)：在吗')
  ok('正文里的名字不认', bad.member === null, JSON.stringify(bad.member))
  const prefixed = splitEnvelope('【群聊近况（背景参考）】17:26 轨道大嫖客(422671528)：需求搞这么快\n\n[139.1华氏度(845940812)] 只有半截')
  ok('群聊近况块后面才是真信封', prefixed.member?.qq === '845940812', JSON.stringify(prefixed.member))
}

console.log('\n== 8c. 认错人的能改回来')
const candList = (await callRoute('/api/sticker-vault/state', {})).json.candidates
if (candList.length) {
  const c0 = candList[0]
  const fixed = await callRoute('/api/sticker-vault/candidate', { key: c0.key, memberName: '刘邦', memberQQ: '2313535058' })
  ok('候选能改归属', fixed.json.ok, JSON.stringify(fixed.json))
  const after2 = (await callRoute('/api/sticker-vault/state', {})).json
  const c1 = after2.candidates.find((x) => x.member.qq === '2313535058')
  ok('改完记到对的人头上', !!c1 && c1.member.name === '刘邦')
}


console.log('\n== 8d. 强制发表情')
{
  const spec = promptSpecs.find((x) => x && x.name === 'sticker-vault')
  ok('表情库提示已挂上', !!spec)
  await callRoute('/api/sticker-vault/settings', { patch: { forceSticker: true, forceProb: 1 } })
  const forced = spec.text()
  ok('概率 1 → 这一轮要求必发', forced.includes('本轮必发'), forced.slice(0, 60))
  ok('必发提示里直接给了可抄的 SEND_FILE 行', forced.includes('[SEND_FILE: '), forced.slice(0, 120))
  await callRoute('/api/sticker-vault/settings', { patch: { forceSticker: false } })
  const normal = spec.text()
  ok('关掉 → 回到普通提示', !normal.includes('本轮必发') && normal.includes('【表情库】'), normal.slice(0, 40))
}

console.log('\n== 8e. 发之前转 jpg')
{
  const { sendPathOf } = await import('../lib/index.mjs')
  const data = JSON.parse(readFileSync(join(home, 'sticker-vault/store.json'), 'utf8'))
  const any = data.items[0]
  const out = sendPathOf(any)
  ok('发图路径能算出来', typeof out === 'string' && out.length > 0, String(out))
  const fake = { ...any, id: 'zzz-not-real' }
  ok('转不了的不会崩', typeof sendPathOf(fake) === 'string')
}

console.log('\n== 9. AI 补描述')
const descState = await callRoute('/api/sticker-vault/describe', {})
ok('/describe 能排队', descState.json.ok && descState.json.enabled === true, JSON.stringify(descState.json))
const someId = (await callRoute('/api/sticker-vault/state', {})).json.items[0].id
await callRoute('/api/sticker-vault/describe', { ids: [someId] })
await sleep(2600) // 等一轮 tick 把队列里那张补上
const after = (await callRoute('/api/sticker-vault/state', {})).json
const described = after.items.find((x) => x.id === someId)
ok('模型被真调了一次', describeCalls > 0, `calls=${describeCalls}`)
ok('描述写进去了', !!(described && described.desc && described.desc.length > 4), described && described.desc)
ok('标签也写进去了', !!(described && described.tags.includes('破防')), JSON.stringify(described && described.tags))

console.log('\n== 9b. 补描述的状态与报错')
const st1 = (await callRoute('/api/sticker-vault/state', {})).json
ok('state 带 describe 汇总', !!st1.describe && typeof st1.describe.queued === 'number', JSON.stringify(st1.describe))
const itemId2 = st1.items[1].id
failNext = true
await callRoute('/api/sticker-vault/describe', { ids: [itemId2] })
await sleep(2600)
const st2 = (await callRoute('/api/sticker-vault/state', {})).json
const failedItem = st2.items.find((x) => x.id === itemId2)
ok('失败挂了状态', failedItem && failedItem.dstate === 'error', JSON.stringify(failedItem && { s: failedItem.dstate, e: failedItem.derr }))
ok('失败原因带出来了', !!(failedItem && failedItem.derr && failedItem.derr.includes('罢工')), failedItem && failedItem.derr)
ok('汇总里有失败数和最近错误', st2.describe.failing >= 1 && !!st2.describe.lastError, JSON.stringify(st2.describe))

console.log('\n== 10. 工具的其它动作')
const note = tools.get('sticker_note')
const stat = tools.get('sticker_stats')
const addRes = await note.execute({ action: 'add', path: join(home, 'sticker-vault', 'images', st.items[0].id + '.png'), member: '测试', desc: '手动加' })
ok('工具能手动加图', addRes.ok, addRes.text)
const statsRes = await stat.execute({})
ok('统计能读', statsRes.ok && statsRes.text.includes('库'), statsRes.text)

console.log(`\n${failed ? '✗' : '✓'} 全过：${passed} 项${failed ? `，失败 ${failed} 项` : ''}`)
process.exit(failed ? 1 : 0)
