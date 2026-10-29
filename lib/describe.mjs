// AI 补描述：入库的表情包，按「图片本身 + 被发出来时的聊天」自动写一句描述和几个标签。
// 纯函数放这里，方便自测；真正调模型的那一段在 index.mjs。

export const DESCRIBE_SYSTEM = `你在给一个 QQ 群的表情库打标签。
你会看到一张图和它被发出来时的聊天记录。用一句话说清：画面是什么、上面有什么字、什么时候该发它。
语气像给同事备注，直接、具体，别客套，别解释你在干什么，别提「这张图」三个字。
只回 JSON，不要代码块，格式：
{"desc":"不超过 40 字","tags":["3 到 5 个短标签，每个不超过 6 个字"]}`

const TAG_BAN = new Set(['表情包', '图片', '搞笑', '表情'])

/** 描述为空、或者标签只剩作者名字，就算还没写。 */
export function needsDescribe(item, memberNames = []) {
  if (!item) return false
  const desc = String(item.desc || '').trim()
  const tags = Array.isArray(item.tags) ? item.tags.map((t) => String(t).trim()).filter(Boolean) : []
  if (!desc) return true
  if (!tags.length) return true
  const names = new Set([String(item.member?.name || ''), ...memberNames].filter(Boolean))
  return tags.every((t) => names.has(t))
}

/** 把聊天语境拼成给模型看的材料。 */
export function buildDescribePrompt(item) {
  const lines = (item.contexts || [])
    .slice(-6)
    .map((c) => {
      const at = c?.at ? new Date(c.at) : null
      const hm = at ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : ''
      const text = String(c?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80)
      return text ? `${hm} ${text}` : ''
    })
    .filter(Boolean)
  const who = item.member?.name ? `${item.member.name}` : '群里某个人'
  const head = `发图的人：${who}`
  if (!lines.length) return `${head}\n当时群里没留下别的聊天记录——就按画面本身说。`
  return `${head}\n发图前后群里在说：\n${lines.map((l) => `- ${l}`).join('\n')}`
}

/** 模型可能加代码块、加解释，尽量把 JSON 抠出来。 */
export function parseDescribeJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  let body = raw
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) body = fence[1]
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let obj
  try {
    obj = JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
  const desc = String(obj.desc || obj.description || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const tags = (Array.isArray(obj.tags) ? obj.tags : [])
    .map((t) => String(t || '').replace(/^[#＃\s]+/, '').replace(/\s+/g, '').trim())
    .filter((t) => t && t.length <= 10 && !TAG_BAN.has(t))
  const uniq = [...new Set(tags)].slice(0, 6)
  if (!desc && !uniq.length) return null
  return { desc, tags: uniq }
}

/** 和现有标签合并，别把群友手动改掉的东西冲掉。 */
export function mergeDescribe(item, parsed) {
  if (!parsed) return false
  let changed = false
  if (parsed.desc && parsed.desc !== item.desc) {
    item.desc = parsed.desc
    changed = true
  }
  if (parsed.tags?.length) {
    const keep = (item.tags || []).filter((t) => t && t !== item.member?.name)
    const merged = [...new Set([...keep, ...parsed.tags])].slice(0, 12)
    if (merged.join('|') !== (item.tags || []).join('|')) {
      item.tags = merged
      changed = true
    }
  }
  if (changed) item.describedAt = Date.now()
  return changed
}
