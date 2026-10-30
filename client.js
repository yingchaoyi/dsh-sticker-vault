/**
 * dsh-sticker-vault —— 浏览器半端（设置里的「表情库」）
 *
 * 一块面板：库里有什么、谁发的、什么语境用过；参数随便改；能上传、能打标、能上锁。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sticker-vault',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/api/sticker-vault'

    const parse = async (r) => {
      const text = await r.text()
      try { return JSON.parse(text) } catch { throw new Error('接口返回的不是 JSON：' + text.slice(0, 120)) }
    }
    const jget = async (path) => parse(await fetch(API + path, { credentials: 'same-origin' }))
    const jpost = async (path, body) => parse(await fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const stamp = (ms) => {
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    const CSS = `
      .sv-wrap { display:flex; flex-direction:column; gap:14px; color:currentColor; font-size:13px; }
      .sv-chips { display:flex; flex-wrap:wrap; gap:8px; }
      .sv-chip { padding:3px 9px; border-radius:999px; background:color-mix(in oklab, currentColor 8%, transparent); white-space:nowrap; }
      .sv-chip b { font-weight:700; }
      .sv-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:8px; }
      .sv-num { display:flex; align-items:center; gap:6px; padding:6px 8px; border:1px solid color-mix(in oklab, currentColor 14%, transparent); border-radius:8px; }
      .sv-num span { opacity:.75; }
      .sv-num input { width:64px; padding:3px 6px; border:1px solid color-mix(in oklab, currentColor 18%, transparent); border-radius:6px; background:transparent; color:inherit; }
      .sv-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .sv-list { display:flex; flex-direction:column; gap:10px; }
      .sv-card { display:flex; gap:12px; padding:10px; border-radius:10px; background:color-mix(in oklab, currentColor 4%, transparent); border:1px solid color-mix(in oklab, currentColor 10%, transparent); }
      .sv-thumb { width:96px; height:96px; flex:0 0 96px; border-radius:8px; object-fit:cover; background:color-mix(in oklab, currentColor 8%, transparent); }
      .sv-thumb.sm { width:48px; height:48px; flex-basis:48px; }
      .sv-main { flex:1 1 240px; min-width:200px; display:flex; flex-direction:column; gap:6px; }
      .sv-meta { opacity:.72; font-size:12px; }
      .sv-in, .sv-ta { width:100%; box-sizing:border-box; padding:5px 8px; border:1px solid color-mix(in oklab, currentColor 16%, transparent); border-radius:7px; background:transparent; color:inherit; font:inherit; }
      .sv-btn { padding:4px 10px; border-radius:7px; border:1px solid color-mix(in oklab, currentColor 18%, transparent); background:transparent; color:inherit; cursor:pointer; font:inherit; }
      .sv-btn:hover { background:color-mix(in oklab, currentColor 7%, transparent); }
      .sv-btn.danger { border-color:color-mix(in oklab, #d9544d 55%, transparent); color:color-mix(in oklab, #d9544d 85%, currentColor); }
      .sv-btn.on { background:color-mix(in oklab, currentColor 12%, transparent); }
      .sv-tag { padding:1px 7px; border-radius:999px; background:color-mix(in oklab, currentColor 9%, transparent); font-size:11px; }
      .sv-ctx { font-size:11px; opacity:.7; margin-top:2px; }
      .sv-empty { opacity:.6; padding:8px 0; }
      .sv-sec { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .sv-sec h4 { margin:0; font-size:13px; font-weight:600; }
      .sv-search { flex:1 1 200px; max-width:320px; }
      .sv-toast { font-size:12px; color:color-mix(in oklab, currentColor 70%, transparent); }
      .sv-err { font-size:12px; color:color-mix(in oklab, #e2655e 85%, currentColor); }
      .sv-warn { font-size:12px; color:color-mix(in oklab, #d9a441 85%, currentColor); }
      .sv-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:currentColor; margin-right:5px; animation: sv-pulse 1.1s ease-in-out infinite; }
      @keyframes sv-pulse { 0%,100% { opacity:.25; transform:scale(.8); } 50% { opacity:1; transform:scale(1); } }
      .sv-btn[disabled] { opacity:.55; cursor:progress; }
    `

    function NumField({ label, value, min, max, onChange, suffix }) {
      return h('label', { className: 'sv-num' }, [
        h('span', { key: 'l' }, label),
        h('input', {
          key: 'i', type: 'number', min, max,
          value: value === undefined ? '' : value,
          onChange: (e) => onChange(Number(e.target.value)),
        }),
        suffix ? h('span', { key: 's' }, suffix) : null,
      ])
    }

    function ItemCard({ it, edits, setEdit, onPatch, onDelete, onDescribe }) {
      const [openCtx, setOpenCtx] = useState(false)
      const edit = edits[it.id] || {}
      const desc = edit.desc !== undefined ? edit.desc : it.desc
      const tags = edit.tags !== undefined ? edit.tags : (it.tags || []).join('、')
      const saveDesc = () => { if (edit.desc !== undefined) onPatch(it.id, { desc }) }
      const saveTags = () => { if (edit.tags !== undefined) onPatch(it.id, { tags: tags.split(/[、,，\s]+/).filter(Boolean) }) }
      return h('div', { className: 'sv-card' }, [
        h('img', { key: 'img', className: 'sv-thumb', src: it.url, alt: it.desc || '图', loading: 'lazy' }),
        h('div', { key: 'main', className: 'sv-main' }, [
          h('div', { key: 'meta', className: 'sv-meta' }, [
            `${it.member.name}${it.member.qq ? `(${it.member.qq})` : ''} · 用过 ${it.count} 次 · ${stamp(it.promotedAt)} 入库`,
            it.locked ? ' · 🔒 已锁' : '',
            it.dstate === 'running' ? ' · AI 正在看图…' : '',
            it.dstate === 'queued' ? ' · 排队等 AI' : '',
            it.dstate === 'done' ? ' · AI 已补' : '',
          ].join('')),
          it.dstate === 'running' || it.dstate === 'queued'
            ? h('div', { key: 'ds', className: 'sv-warn' }, [
                h('span', { key: 'd', className: 'sv-dot' }),
                it.dstate === 'running' ? '模型正在看图写描述，一般十来秒，这块自己会刷出来' : '排在队里了，前面还有几张，轮到它就会动',
              ])
            : null,
          it.dstate === 'error'
            ? h('div', { key: 'de', className: 'sv-err' }, '补描述没成：' + (it.derr || '不知道为啥'))
            : null,
          h('input', {
            key: 'desc', className: 'sv-in', placeholder: it.describedAt ? '描述：这张图是什么内容' : '描述还没写——点下面「AI 补」让它自己看图和聊天',
            value: desc,
            onChange: (e) => setEdit(it.id, { desc: e.target.value }),
            onBlur: saveDesc,
            onKeyDown: (e) => { if (e.key === 'Enter') { saveDesc(); e.currentTarget.blur() } },
          }),
          h('input', {
            key: 'tags', className: 'sv-in', placeholder: '标签：什么语境能用（顿号或空格分开）',
            value: tags,
            onChange: (e) => setEdit(it.id, { tags: e.target.value }),
            onBlur: saveTags,
            onKeyDown: (e) => { if (e.key === 'Enter') { saveTags(); e.currentTarget.blur() } },
          }),
          h('div', { key: 'ops', className: 'sv-row' }, [
            h('button', { key: 'lock', className: 'sv-btn' + (it.locked ? ' on' : ''), onClick: () => onPatch(it.id, { locked: !it.locked }) }, it.locked ? '🔒 已锁' : '🔓 上锁'),
            h('button', {
              key: 'ai',
              className: 'sv-btn' + (it.dstate === 'running' ? ' on' : ''),
              disabled: it.dstate === 'running',
              onClick: () => onDescribe(it.id),
            }, it.dstate === 'running' ? '补描述中…' : it.dstate === 'error' ? '重试' : 'AI 补'),
            h('button', { key: 'ctx', className: 'sv-btn', onClick: () => setOpenCtx(!openCtx) }, `语境 ${it.contexts.length}`),
            h('button', { key: 'del', className: 'sv-btn danger', onClick: () => onDelete(it) }, '删除'),
          ]),
          openCtx && it.contexts.length ? h('div', { key: 'ctxs' }, it.contexts.slice().reverse().map((c, i) => h('div', { key: i, className: 'sv-ctx' }, `${stamp(c.at)} · ${c.text}`))) : null,
        ]),
      ])
    }

    function Panel({ initialState } = {}) {
      const [st, setSt] = useState(initialState || null)
      const [err, setErr] = useState('')
      const [q, setQ] = useState('')
      const [edits, setEdits] = useState({})
      const [toast, setToast] = useState('')
      const [upload, setUpload] = useState({ open: false, member: '', desc: '', tags: '', busy: false })
      const fileRef = useRef(null)
      const editing = useRef(false)

      const load = useCallback(async () => {
        try {
          const s = await jget('/state')
          setSt(s)
          setErr('')
        } catch (e) { setErr(String(e.message || e)) }
      }, [])

      useEffect(() => {
        load()
        const t = setInterval(() => { if (!editing.current) load() }, 4000)
        return () => clearInterval(t)
      }, [load])

      const flash = (msg) => { setToast(msg); setTimeout(() => setToast(''), 1800) }

      const patchSettings = async (patch) => {
        try {
          const r = await jpost('/settings', { patch })
          if (r.ok) { flash('已保存'); load() } else flash(r.error || '保存失败')
        } catch (e) { flash(String(e.message || e)) }
      }

      const setEdit = (id, part) => setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...part } }))

      const onPatch = async (id, patch) => {
        try {
          const r = await jpost('/item', { id, ...patch })
          if (!r.ok) return flash(r.error || '失败')
          setEdits((prev) => { const n = { ...prev }; delete n[id]; return n })
          load()
        } catch (e) { flash(String(e.message || e)) }
      }

      const onDelete = async (it) => {
        if (!window.confirm('删掉这张？')) return
        try {
          const r = await jpost('/delete', { id: it.id, force: false })
          if (!r.ok) return flash(r.error || '删不掉')
          flash('删了'); load()
        } catch (e) { flash(String(e.message || e)) }
      }

      const describe = async (ids) => {
        try {
          const r = await jpost('/describe', ids ? { ids } : {})
          if (!r.enabled) return flash('补描述是关的，先打开')
          flash(r.queued ? `排了 ${r.queued} 张，一张十来秒，面板会自己刷新` : '没有要补的（都写过了或关着）')
          load()
        } catch (e) { flash(String(e.message || e)) }
      }

      const promote = async (c) => {
        try {
          const r = await jpost('/promote', { key: c.key })
          if (!r.ok) return flash(r.error || '入库失败')
          flash('已入库'); load()
        } catch (e) { flash(String(e.message || e)) }
      }

      const dropCandidate = async (c) => {
        try {
          const r = await jpost('/delete', { key: c.key })
          if (!r.ok) return flash(r.error || '删不掉')
          flash('扔了'); load()
        } catch (e) { flash(String(e.message || e)) }
      }

      const [whoEdit, setWhoEdit] = useState({})
      const setMember = (key, part) => setWhoEdit((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), ...part } }))

      const fixMember = async (c) => {
        const e = whoEdit[c.key] || {}
        const memberName = e.name !== undefined ? e.name : c.member.name
        const memberQQ = e.qq !== undefined ? e.qq : c.member.qq
        try {
          const r = await jpost('/candidate', { key: c.key, memberName, memberQQ })
          if (!r.ok) return flash(r.error || '改不动')
          setWhoEdit((prev) => { const n = { ...prev }; delete n[c.key]; return n })
          flash('归属改了'); load()
        } catch (err) { flash(String(err.message || err)) }
      }

      const doUpload = async (file) => {
        if (!file) return
        setUpload((u) => ({ ...u, busy: true }))
        try {
          const data = await new Promise((resolve, reject) => {
            const fr = new FileReader()
            fr.onload = () => resolve(String(fr.result))
            fr.onerror = () => reject(new Error('读文件失败'))
            fr.readAsDataURL(file)
          })
          const r = await jpost('/upload', {
            data,
            member: upload.member || '手动上传',
            desc: upload.desc,
            tags: upload.tags.split(/[、,，\s]+/).filter(Boolean),
          })
          if (!r.ok) throw new Error(r.error || '上传失败')
          flash('上传成功')
          setUpload({ open: false, member: '', desc: '', tags: '', busy: false })
          load()
        } catch (e) { flash(String(e.message || e)); setUpload((u) => ({ ...u, busy: false })) }
      }

      if (err && !st) return h('div', { className: 'sv-wrap' }, [
        h('style', { key: 's' }, CSS),
        h('div', { key: 'e', className: 'sv-toast' }, '读不到表情库：' + err),
      ])
      if (!st) return h('div', { className: 'sv-wrap' }, [h('style', { key: 's' }, CSS), h('div', { key: 'l' }, '读取中…')])

      const s = st.settings
      const kw = q.trim().toLowerCase()
      const shown = st.items.filter((it) => !kw || [it.desc, (it.tags || []).join(' '), it.member.name, ...(it.contexts || []).map((c) => c.text)].join(' ').toLowerCase().includes(kw))

      return h('div', { className: 'sv-wrap' }, [
        h('style', { key: 'style' }, CSS),

        h('div', { key: 'chips', className: 'sv-chips' }, [
          h('span', { key: 'a', className: 'sv-chip' }, ['库 ', h('b', { key: 'b' }, `${st.stats.items}/${s.maxTotal}`), ' 张']),
          h('span', { key: 'c', className: 'sv-chip' }, ['候选 ', h('b', { key: 'b' }, st.stats.candidates), ' 张']),
          h('span', { key: 'd', className: 'sv-chip' }, [`达标 ${s.promoteAt} 次入库`]),
          h('span', { key: 'e', className: 'sv-chip' }, [`每人最多 ${s.perMember} 张`]),
          h('span', { key: 'f', className: 'sv-chip' }, [`计数 ${s.resetDays} 天清一次`]),
          h('span', { key: 'g', className: 'sv-chip' }, [`清后库内从 ${s.resetItemTo} 次算`]),
          st.stats.pendingDescribe > 0 ? h('span', { key: 'h', className: 'sv-chip' }, ['描述待补 ', h('b', { key: 'b' }, st.stats.pendingDescribe), ' 张']) : null,
          st.describe && st.describe.running ? h('span', { key: 'i', className: 'sv-chip' }, ['AI 正在补 ', h('b', { key: 'b' }, st.describe.running), ' 张']) : null,
          st.describe && st.describe.queued ? h('span', { key: 'j', className: 'sv-chip' }, ['队列里还有 ', h('b', { key: 'b' }, st.describe.queued), ' 张']) : null,
          st.describe && st.describe.failing ? h('span', { key: 'k', className: 'sv-chip' }, ['补失败的 ', h('b', { key: 'b' }, st.describe.failing), ' 张，点卡片上的重试']) : null,
        ]),

        h('div', { key: 'grid', className: 'sv-grid' }, [
          h(NumField, { key: 'p', label: '达标次数', value: s.promoteAt, min: 2, max: 99, suffix: '次', onChange: (v) => patchSettings({ promoteAt: v }) }),
          h(NumField, { key: 'm', label: '每人最多', value: s.perMember, min: 1, max: 20, suffix: '张', onChange: (v) => patchSettings({ perMember: v }) }),
          h(NumField, { key: 't', label: '总容量', value: s.maxTotal, min: 5, max: 500, suffix: '张', onChange: (v) => patchSettings({ maxTotal: v }) }),
          h(NumField, { key: 'r', label: '计数周期', value: s.resetDays, min: 1, max: 365, suffix: '天', onChange: (v) => patchSettings({ resetDays: v }) }),
          h(NumField, { key: 'r2', label: '清后库内从', value: s.resetItemTo, min: 0, max: 20, suffix: '次', onChange: (v) => patchSettings({ resetItemTo: v }) }),
        ]),

        s.forceSticker ? h('div', { key: 'force-row', className: 'sv-row' }, [
          h('span', { key: 'l', className: 'sv-chip' }, ['强制发表情概率']),
          h('input', { key: 'p', className: 'sv-in', style: { width: '76px' }, type: 'number', step: '0.05', min: '0', max: '1', value: s.forceProb, onChange: (e) => patchSettings({ forceProb: Math.min(1, Math.max(0, Number(e.target.value) || 0)) }) }),
          h('span', { key: 'v', className: 'sv-chip' }, [Math.round((s.forceProb || 0) * 100) + '% · 每轮掷一次']),
        ]) : null,

        h('div', { key: 'row', className: 'sv-row' }, [
          h('button', { key: 'auto', className: 'sv-btn' + (s.autoCapture ? ' on' : ''), onClick: () => patchSettings({ autoCapture: !s.autoCapture }) }, s.autoCapture ? '自动收录：开' : '自动收录：关'),
          h('button', { key: 'hint', className: 'sv-btn' + (s.hint ? ' on' : ''), onClick: () => patchSettings({ hint: !s.hint }) }, s.hint ? '提示词提醒：开' : '提示词提醒：关'),
          h('button', { key: 'force', className: 'sv-btn' + (s.forceSticker ? ' on' : ''), onClick: () => patchSettings({ forceSticker: !s.forceSticker }) }, s.forceSticker ? '强制发表情：开' : '强制发表情：关'),
          h('button', { key: 'ai', className: 'sv-btn' + (s.autoDescribe ? ' on' : ''), onClick: () => patchSettings({ autoDescribe: !s.autoDescribe }) }, s.autoDescribe ? 'AI 补描述：开' : 'AI 补描述：关'),
          h('button', { key: 'fill', className: 'sv-btn', onClick: () => describe() }, '给没写的补上'),
          h('button', { key: 'up', className: 'sv-btn' + (upload.open ? ' on' : ''), onClick: () => setUpload((u) => ({ ...u, open: !u.open })) }, '上传图片'),
          toast ? h('span', { key: 't', className: 'sv-toast' }, toast) : null,
        ]),

        upload.open ? h('div', { key: 'upload', className: 'sv-card' }, [
          h('div', { key: 'm', className: 'sv-main' }, [
            h('div', { key: 'r', className: 'sv-row' }, [
              h('input', { key: 'mb', className: 'sv-in sv-search', placeholder: '谁提供的（昵称，可空）', value: upload.member, onChange: (e) => setUpload((u) => ({ ...u, member: e.target.value })) }),
              h('input', { key: 'd', className: 'sv-in sv-search', placeholder: '描述', value: upload.desc, onChange: (e) => setUpload((u) => ({ ...u, desc: e.target.value })) }),
              h('input', { key: 't', className: 'sv-in sv-search', placeholder: '标签（空格分开）', value: upload.tags, onChange: (e) => setUpload((u) => ({ ...u, tags: e.target.value })) }),
            ]),
            h('div', { key: 'r2', className: 'sv-row' }, [
              h('input', {
                key: 'f', type: 'file', accept: 'image/*', ref: fileRef,
                onChange: (e) => { const f = e.target.files && e.target.files[0]; if (f) doUpload(f) },
              }),
              upload.busy ? h('span', { key: 'b', className: 'sv-toast' }, '上传中…') : null,
            ]),
          ]),
        ]) : null,

        h('div', { key: 'sec1', className: 'sv-sec' }, [
          h('h4', { key: 'h' }, `库里 ${shown.length} 张`),
          h('input', { key: 'q', className: 'sv-in sv-search', placeholder: '搜描述 / 标签 / 谁发的 / 语境', value: q, onChange: (e) => setQ(e.target.value) }),
        ]),

        h('div', { key: 'items', className: 'sv-list' }, shown.length
          ? shown.map((it) => h(ItemCard, { key: it.id, it, edits, setEdit, onPatch, onDelete, onDescribe: (id) => describe([id]) }))
          : [h('div', { key: 'e', className: 'sv-empty' }, kw ? '没有对上的' : '库里还空着——等群友把同一张图发到 5 次，它自己就进来了')]),

        st.candidates.length ? h('div', { key: 'sec2', className: 'sv-sec' }, [
          h('h4', { key: 'h' }, `候选 ${st.candidates.length} 张（还没到 ${s.promoteAt} 次）`),
          h('button', { key: 'reset', className: 'sv-btn', onClick: async () => { await jpost('/reset', {}); flash('计数清了'); load() } }, '清空计数'),
        ]) : null,
        st.candidates.length ? h('div', { key: 'cands', className: 'sv-list' }, st.candidates.map((c) => { const we = whoEdit[c.key] || {}; return h('div', { key: c.key, className: 'sv-card' }, [
          h('img', { key: 'i', className: 'sv-thumb sm', src: `/api/sticker-vault/thumb?key=${encodeURIComponent(c.key)}`, alt: '候选', loading: 'lazy' }),
          h('div', { key: 'b', className: 'sv-main' }, [
            h('div', { key: 'm', className: 'sv-meta' }, `${c.member.name}${c.member.qq ? `(${c.member.qq})` : ''} · 出现 ${c.count} 次 · 最近 ${stamp(c.lastAt)}`),
            c.contexts.length ? h('div', { key: 'c', className: 'sv-ctx' }, c.contexts[c.contexts.length - 1].text) : null,
            h('div', { key: 'who', className: 'sv-row' }, [
              h('input', { key: 'n', className: 'sv-in sv-search', placeholder: '谁发的（认错了在这改）', value: we.name !== undefined ? we.name : c.member.name, onChange: (e) => setMember(c.key, { name: e.target.value }) }),
              h('input', { key: 'q', className: 'sv-in', style: { width: '110px' }, placeholder: 'QQ', value: we.qq !== undefined ? we.qq : (c.member.qq || ''), onChange: (e) => setMember(c.key, { qq: e.target.value }) }),
              h('button', { key: 's', className: 'sv-btn', onClick: () => fixMember(c) }, '改归属'),
            ]),
            h('div', { key: 'o', className: 'sv-row' }, [
              h('button', { key: 'p', className: 'sv-btn', onClick: () => promote(c) }, '现在就收'),
              h('button', { key: 'd', className: 'sv-btn danger', onClick: () => dropCandidate(c) }, '扔了'),
            ]),
          ]),
        ]) })) : null,
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.slots.inject('settings.section', () => ctx.slots.register(
            { name: 'settings.section', id: 'sticker-vault', order: 34, label: '表情库' },
            () => h(Panel),
          ))
        } catch (e) { /* ignore */ }
      },
    }
  },
})
