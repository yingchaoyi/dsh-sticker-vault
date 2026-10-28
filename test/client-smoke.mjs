/**
 * client-smoke.mjs —— 不开浏览器也能验渲染：假 React + 假 slots，把「表情库」面板整棵树跑一遍。
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
  },
  useState(v) { return [typeof v === 'function' ? v() : v, () => {}] },
  useEffect() {},
  useCallback(f) { return f },
  useRef(v) { return { current: v } },
  Fragment: 'Fragment',
}

let captured = null
const documentStub = { head: { appendChild() {} }, createElement() { return { setAttribute() {}, textContent: '', remove() {} } } }
globalThis.window = { __ModuleLoader__: { load: ({ id, factory }) => { captured = { id, factory } } }, confirm: () => false }
globalThis.document = documentStub

new Function('window', 'document', src)(globalThis.window, documentStub)

const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1 }
const ok = (m) => console.log('✓ ' + m)
const assert = (c, m) => (c ? ok(m) : fail(m))

assert(captured && captured.id === 'dsh-sticker-vault', '模块 id 正确')
const mod = captured.factory(() => React)
assert(typeof mod.apply === 'function', 'factory 返回 apply')

const registered = []
const slots = { inject(name, fn) { fn() }, register(def, render) { registered.push({ def, render }); return () => {} } }
const ctx = { get: () => slots, effect: (fn) => fn(), slots }
mod.apply(ctx)

assert(registered.length === 1, '注册了 1 个设置分区')
assert(registered[0].def.name === 'settings.section' && registered[0].def.label === '表情库', '分区标题：' + registered[0].def.label)

const now = Date.now()
const state = {
  ok: true,
  settings: { enabled: true, autoCapture: true, promoteAt: 5, perMember: 3, maxTotal: 50, resetDays: 5, resetItemTo: 2, uploadMaxMB: 4, hint: true },
  stats: { items: 3, candidates: 2, maxTotal: 50, perMember: 3, promoteAt: 5, resetDays: 5, resetItemTo: 2, lastResetAt: now },
  items: [
    { id: 'a1', desc: '刘邦发的那张「就这」', tags: ['嘲讽', '就这'], member: { name: '刘邦', qq: '2313535058' }, count: 9, locked: false, src: 'auto', bytes: 100, promotedAt: now, lastAt: now, contexts: [{ at: now, text: '刘邦：你这也叫操作？' }], url: '/api/sticker-vault/file?id=a1' },
    { id: 'a2', desc: '', tags: [], member: { name: '盖哥', qq: '10001' }, count: 5, locked: true, src: 'auto', bytes: 100, promotedAt: now, lastAt: now, contexts: [], url: '/api/sticker-vault/file?id=a2' },
    { id: 'a3', desc: '老板的钓鱼图', tags: ['钓鱼'], member: { name: '老板', qq: '845940812' }, count: 6, locked: false, src: 'upload', bytes: 100, promotedAt: now, lastAt: now, contexts: [], url: '/api/sticker-vault/file?id=a3' },
  ],
  candidates: [
    { key: '2313535058#abc', hash: 'abc', member: { name: '刘邦', qq: '2313535058' }, count: 3, lastAt: now, ext: 'png', bytes: 1, contexts: [{ at: now, text: '刘邦：笑死' }], url: '' },
  ],
  members: ['刘邦', '盖哥', '老板'],
}

function walk(node, out) {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
  if (typeof node.type === 'function') { walk(node.type(node.props || {}), out); return }
  const p = node.props || {}
  if (typeof p.placeholder === 'string') out.push(p.placeholder)
  if (typeof p.src === 'string') out.push(p.src)
  if (typeof p.alt === 'string') out.push(p.alt)
  for (const c of node.children) walk(c, out)
}

const tree = registered[0].render()
if (tree && tree.props) tree.props.initialState = state
const out = []
try { walk(tree, out) } catch (error) { fail('渲染炸了：' + error.message) }
const text = out.join(' ').replace(/\s+/g, ' ')
const has = (s) => text.includes(s)

assert(has('库 3/50 张'), '状态：库 3/50')
assert(has('候选 1 张'), '状态：候选 1 张')
assert(has('达标 5 次入库'), '状态：达标次数')
assert(has('每人最多 3 张'), '状态：每人上限')
assert(has('计数 5 天清一次'), '状态：计数周期')
assert(has('清后库内从 2 次算'), '状态：清后库内基数')
assert(has('达标次数') && has('每人最多') && has('总容量') && has('计数周期') && has('清后库内从'), '五个参数都在')
assert(has('自动收录：开'), '自动收录开关')
assert(has('上传图片'), '上传入口')
assert(has('刘邦发的那张「就这」'), '库里的描述渲染出来')
assert(has('刘邦(2313535058) · 用过 9 次'), '作者与使用次数')
assert(has('🔒 已锁'), '上锁状态显示')
assert(has('/api/sticker-vault/file?id=a1'), '图片走文件路由')
assert(has('语境 1'), '语境按钮')
assert(has('搜描述 / 标签 / 谁发的 / 语境'), '搜索框在')
assert(has('/api/sticker-vault/thumb?key='), '候选缩略图路由')
assert(has('现在就收') && has('扔了'), '候选操作按钮')
assert(has('清空计数'), '清空计数按钮')
assert(text.length > 200, '渲染出的文字量合理（' + text.length + ' 字）')

console.log('\n' + (process.exitCode ? '有失败项' : '全过'))
