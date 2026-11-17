/**
 * 根目录白名单策略：内置集合 + 调用方额外配置。
 *
 * 这是「哪些根目录条目不算散落项」的唯一实现，供 core 的 classifyPath /
 * scanWorkspace / listRootStrays 共用；guard 只通过 core 间接使用。
 * 白名单只影响根目录散落判定，不影响 projects/ 内的项目识别。
 * 匹配大小写敏感，条目只做 trim。
 */

/** 内置白名单（工作区固定项）；`WORKFLOW.md` 仅为兼容旧文件保留，不构成依赖。 */
export const ROOT_ALLOWED = new Set([
  'PROJECTS.md', 'AGENTS.md', 'AGENTS.local.md', 'CLAUDE.md',
  'projects', 'tools', 'archive', '.git', 'WORKFLOW.md',
])

/**
 * 归一化调用方白名单：只去空白，忽略空串与非字符串；大小写保持原样。
 * @param {unknown} value
 * @returns {Set<string>}
 */
export function normalizeRootAllowlist(value) {
  const set = new Set()
  if (!Array.isArray(value)) return set
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name !== '') set.add(name)
  }
  return set
}

/**
 * 判断根目录条目是否在内置或扩展白名单内（大小写敏感）。
 * @param {string} name
 * @param {Set<string>|string[]} [extra] 已归一化集合或原始字符串数组。
 * @returns {boolean}
 */
export function isRootAllowed(name, extra) {
  const candidate = String(name ?? '').trim()
  if (ROOT_ALLOWED.has(candidate)) return true
  if (extra === undefined || extra === null) return false
  const list = extra instanceof Set ? extra : normalizeRootAllowlist(extra)
  return list.has(candidate)
}
