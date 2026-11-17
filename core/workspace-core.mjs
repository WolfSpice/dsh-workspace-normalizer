/**
 * workspace-guard 核心模块：规范工作区规则的唯一实现。
 * 规则层（parse/validate/render/classify）为纯函数；适配层（scan/create/write/archive/probe）
 * 使用 node:fs/promises 与 node:child_process，所有写入限制在 root 内并采用「临时文件 + rename」。
 * 契约见 workspace-guard-plugin-dev.md 第 2 节不变量与第 5 节。
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { isRootAllowed, normalizeRootAllowlist } from './root-policy.mjs'

/** 包内 core 模块的绝对 file: URL。 */
export const CORE_MODULE_URL = import.meta.url

const STATUS_VALUES = Object.freeze(['active', 'paused', 'done'])
/** 完整项目目录名：YYYYMMDD-slug。 */
const PROJECT_SLUG_RE = /^\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/
/** createProject 允许的纯 slug（不含日期）。 */
const PURE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** 过渡期根目录遗留项目目录名。 */
const LEGACY_SLUG_RE = /^\d{8}-[a-z0-9-]+$/
const FIELD_MAP = new Map([
  ['目标', 'goal'],
  ['状态', 'status'],
  ['结论', 'conclusions'],
  ['约束', 'constraints'],
  ['入口', 'entries'],
  ['回滚', 'rollback'],
])
/** 根目录白名单策略见 core/root-policy.mjs；点开头条目另行忽略。 */
const AGENTS_BEGIN = '<!-- workspace-guard:begin -->'
const AGENTS_END = '<!-- workspace-guard:end -->'

/** 所有错误码：Issue 闭集 + 适配层操作错误。 */
export const ERROR_CODES = Object.freeze([
  'README_MISSING', 'GOAL_MISSING', 'GOAL_PLACEHOLDER', 'STATUS_INVALID',
  'FULLWIDTH_COLON', 'PARSE_FAILED', 'SLUG_INVALID', 'DATE_INVALID',
  'ROOT_NOT_FOUND', 'PROJECT_EXISTS', 'PROJECT_CREATE_FAILED', 'WRITE_FAILED',
  'PATH_OUTSIDE_ROOT', 'STATUS_NOT_DONE', 'YEAR_INVALID', 'TARGET_EXISTS',
  'VCS_BLOCKED', 'VCS_MOVE_FAILED', 'VCS_VERIFY_FAILED', 'MOVE_FAILED',
  'ROLLBACK_FAILED', 'ROOT_FILE', 'WORKSPACE_WRITE_FAILED',
])

/** 核心统一错误类型；调用方用 err.code 分支，不用 message 判断。 */
export class WorkspaceError extends Error {
  /** @param {string} code @param {string} message @param {{cause?: unknown, details?: object}} [options] */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
    if (options.cause !== undefined) this.cause = options.cause
    if (options.details !== undefined) this.details = options.details
  }
  /** @returns {{name: string, code: string, message: string}} */
  toJSON() {
    return { name: this.name, code: this.code, message: this.message }
  }
}

/* ------------------------------ 规则层：解析 ------------------------------ */

function makeIssue(code, severity, message, extra = {}) {
  const issue = { code, severity, message }
  if (extra.line !== undefined) issue.line = extra.line
  if (extra.path !== undefined) issue.path = extra.path
  return issue
}

function isPlaceholder(value) {
  return /^<[^<>]*>$/.test(String(value).trim())
}

/** 按 5.4 解析 README。只识别 `- 字段: 值`（半角冒号）；`## 说明` 之后不解析。 */
export function parseReadme(text) {
  const fields = { conclusions: [], constraints: [], entries: [], rollback: [] }
  const issues = []
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)
  let inNotes = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNo = index + 1
    if (/^\s*##\s*说明\s*$/.test(line)) {
      inNotes = true
      continue
    }
    if (inNotes) continue
    // 中文冒号只对已知字段名的字段行提示格式问题，不改变解析结果。
    const fullwidth = /^\s*-\s*([^\s:：]+)\s*：[ \t]*(.*)$/.exec(line)
    if (fullwidth && FIELD_MAP.has(fullwidth[1])) {
      issues.push(makeIssue('FULLWIDTH_COLON', 'warning', '字段行使用了中文冒号（：），该行未解析', { line: lineNo }))
      continue
    }
    const fieldLine = /^\s*-\s*([^\s:：]+)\s*:[ \t]*(.*)$/.exec(line)
    if (!fieldLine) continue
    const key = FIELD_MAP.get(fieldLine[1])
    if (key === undefined) continue
    const value = fieldLine[2].trim()
    if (key === 'goal' || key === 'status') fields[key] = value
    else if (value !== '') fields[key].push(value)
  }
  return { fields, issues }
}

/** 按工作区约定校验：必填只有 `目标`；状态缺失显示 unknown，非法报 STATUS_INVALID。 */
export function validateProject(record) {
  const issues = []
  const fields = record?.fields ?? {}
  const readmePath = record?.readmePath ?? null
  const hasReadme = typeof readmePath === 'string' && readmePath !== ''
  if (!hasReadme) issues.push(makeIssue('README_MISSING', 'error', '缺少 README.md'))
  const goal = typeof fields.goal === 'string' ? fields.goal.trim() : ''
  if (hasReadme) {
    if (goal === '') issues.push(makeIssue('GOAL_MISSING', 'error', '缺少「目标」字段或值为空'))
    else if (isPlaceholder(goal)) issues.push(makeIssue('GOAL_PLACEHOLDER', 'error', '「目标」仍是占位符'))
  }
  const status = fields.status
  if (status !== undefined && status !== null && status !== '' && !STATUS_VALUES.includes(status)) {
    issues.push(makeIssue('STATUS_INVALID', 'error', `状态「${status}」非法（只允许 active / paused / done）`))
  }
  return issues
}

/* ------------------------------ 规则层：渲染 ------------------------------ */

function toPosix(value) { return String(value).replace(/\\/g, '/') }

function projectRelPath(root, record) {
  if (typeof record.relPath === 'string' && record.relPath !== '') {
    return toPosix(record.relPath).replace(/\/+$/, '')
  }
  const rel = path.relative(path.resolve(root), path.resolve(record.dir))
  return toPosix(rel === '' ? path.basename(record.dir) : rel).replace(/\/+$/, '')
}

function projectDisplayPath(root, record) {
  return `${projectRelPath(root, record)}/`
}

function statusRank(status) {
  if (status === 'active') return 0
  if (status === 'paused') return 1
  if (status === 'done') return 3
  return 2
}

function compareProjects(a, b) {
  const diff = statusRank(a.fields?.status) - statusRank(b.fields?.status)
  if (diff !== 0) return diff
  if (a.slug !== b.slug) return a.slug < b.slug ? 1 : -1
  return 0
}

function displayStatus(record) {
  const status = record.fields?.status
  if (status === undefined || status === null || status === '') return 'unknown'
  return STATUS_VALUES.includes(status) ? status : `${status} ⚠`
}

function parseFailed(record) {
  return (record.issues ?? []).some((issue) => issue.code === 'PARSE_FAILED')
}

function markdownCell(value) {
  return String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

/** 生成 PROJECTS.md（5.5）：状态排序、空待处理省略、路径 POSIX 化。 */
export function renderProjectsIndex(result) {
  const root = result?.root ?? ''
  const projects = Array.isArray(result?.projects) ? result.projects : []
  const warnings = Array.isArray(result?.warnings) ? result.warnings : []
  const ordered = projects.slice().sort(compareProjects)
  const tableProjects = ordered.filter((record) => !parseFailed(record))
  const pending = []
  for (const record of ordered) for (const issue of record.issues ?? []) pending.push({ path: projectDisplayPath(root, record), message: issue.message })
  for (const warning of warnings) {
    pending.push({ path: warning.path === undefined ? '' : toPosix(warning.path), message: warning.message })
  }
  const blocks = ['# 项目索引', '', '> 由 bin/workspace-index.mjs 生成，不要手改。', '']
  if (pending.length > 0) {
    blocks.push(`## 待处理（${pending.length}）`, '')
    for (const item of pending) blocks.push(item.path === '' ? `- ${item.message}` : `- \`${item.path}\` — ${item.message}`)
    blocks.push('')
  }
  if (tableProjects.length === 0) {
    blocks.push('暂无项目。', '')
  } else {
    blocks.push(`## 活跃项目（${tableProjects.length}）`, '')
    blocks.push('| 项目 | 状态 | 目标 | 最近更新 |', '|---|---|---|---|')
    for (const record of tableProjects) {
      const goal = typeof record.fields?.goal === 'string' ? record.fields.goal.trim() : ''
      const goalCell = goal === '' || isPlaceholder(goal) ? '—' : markdownCell(goal)
      blocks.push(`| \`${projectDisplayPath(root, record)}\` | ${markdownCell(displayStatus(record))} | ${goalCell} | ${record.updatedAt ?? '—'} |`)
    }
    blocks.push('')
  }
  return `${blocks.join('\n').replace(/\n+$/, '')}\n`
}

function summaryGoal(record) {
  const goal = typeof record.fields?.goal === 'string' ? record.fields.goal.trim() : ''
  return goal === '' || isPlaceholder(goal) ? '—' : goal.replace(/\r?\n/g, ' ')
}

function truncateToBytes(text, limit) {
  if (limit <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= limit) return text
  const chars = Array.from(text)
  const budget = limit - Buffer.byteLength('…', 'utf8')
  if (budget <= 0) return ''
  let low = 0
  let high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(chars.slice(0, mid).join(''), 'utf8') <= budget) low = mid
    else high = mid - 1
  }
  return `${chars.slice(0, low).join('')}…`
}

/** 生成注入摘要（11.4，≤ maxBytes）：先完整渲染，超限时从最后一个项目开始删除， */
export function renderSummary(projects, maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 4000
  const list = Array.isArray(projects) ? projects : []
  const active = list.filter((record) => record.fields?.status !== 'done').sort(compareProjects)
  const counts = { active: 0, paused: 0, unknown: 0 }
  for (const record of active) {
    const status = record.fields?.status
    if (status === 'active') counts.active += 1
    else if (status === 'paused') counts.paused += 1
    else counts.unknown += 1
  }
  const countParts = []
  if (counts.active > 0) countParts.push(`active ${counts.active}`)
  if (counts.paused > 0) countParts.push(`paused ${counts.paused}`)
  if (counts.unknown > 0) countParts.push(`unknown ${counts.unknown}`)
  const statLine = active.length === 0 ? '活跃项目 0 个。' : `活跃项目 ${active.length} 个（${countParts.join(' / ')}）：`
  const itemLines = active.map((record) => `- ${record.slug} [${displayStatus(record)}] ${summaryGoal(record)}`)
  const issueParts = []
  for (const record of list) {
    const rel = typeof record.relPath === 'string' && record.relPath !== ''
      ? projectDisplayPath('', record)
      : `projects/${record.slug}/`
    for (const issue of record.issues ?? []) issueParts.push(`\`${rel}\` ${issue.message}`)
  }
  const issueLine = issueParts.length === 0 ? '' : `需要补全：${issueParts.join('；')}`
  const header = '## 规范工作区（自动注入）', footer = '规则见 AGENTS.md；索引见 PROJECTS.md。'
  const assemble = (kept, options = {}) => {
    const withFooter = options.withFooter !== false
    const lines = [header, '']
    if (options.withStat !== false) lines.push(statLine)
    lines.push(...itemLines.slice(0, kept))
    const omitted = itemLines.length - kept
    if (omitted > 0) lines.push(kept > 0 ? `- 还有 ${omitted} 个未列出` : `还有 ${omitted} 个未列出`)
    if (issueLine !== '') lines.push('', issueLine)
    else if (withFooter) lines.push('')
    if (withFooter) lines.push(footer)
    return lines.join('\n')
  }
  let text = assemble(itemLines.length)
  if (Buffer.byteLength(text, 'utf8') <= limit) return text
  for (let kept = itemLines.length - 1; kept >= 0; kept -= 1) {
    text = assemble(kept)
    if (Buffer.byteLength(text, 'utf8') <= limit) return text
  }
  text = assemble(0, { withFooter: false })
  if (Buffer.byteLength(text, 'utf8') <= limit) return text
  // 极端情形：保留标题与「需要补全」，各自按字符边界截断。
  const first = truncateToBytes(header, limit)
  if (issueLine === '') return first
  const remaining = limit - Buffer.byteLength(first, 'utf8') - 1
  if (remaining <= 0) return first
  const second = truncateToBytes(issueLine, remaining)
  return second === '' ? first : `${first}\n${second}`
}

/** 归类绝对路径：projects / legacy-root / tools / root-file / ignored（纯字符串判断）。 */
export function classifyPath(root, absPath, rootAllowlist) {
  const rel = path.relative(path.resolve(String(root ?? '')), path.resolve(String(absPath ?? '')))
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { kind: 'ignored' }
  const parts = rel.split(/[\\/]+/).filter(Boolean)
  const first = parts[0]
  if (first === undefined) return { kind: 'ignored' }
  if (first === 'projects') return { kind: 'projects' }
  if (first === 'tools') return { kind: 'tools' }
  if (first.startsWith('.') || isRootAllowed(first, rootAllowlist)) return { kind: 'ignored' }
  if (parts.length === 1) return LEGACY_SLUG_RE.test(first) ? { kind: 'legacy-root' } : { kind: 'root-file' }
  return LEGACY_SLUG_RE.test(first) ? { kind: 'legacy-root' } : { kind: 'ignored' }
}

/* ------------------------------ 路径与文件工具 ---------------------------- */

async function pathExists(target) {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

function compareKey(value) {
  let normalized = path.resolve(value)
  if (process.platform === 'win32') normalized = normalized.toLowerCase()
  return normalized.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
}

function fromGitPath(value) {
  const raw = String(value).trim()
  if (process.platform !== 'win32') return raw
  const msys = /^\/([a-zA-Z])\/(.*)$/.exec(raw)
  if (msys) return `${msys[1].toUpperCase()}:\\${msys[2].replace(/\//g, '\\')}`
  return raw.replace(/\//g, '\\')
}

async function resolveExistingAncestor(target) {
  let current = path.resolve(target)
  const suffix = []
  while (true) {
    try {
      return path.join(await fs.realpath(current), ...suffix.reverse())
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      suffix.push(path.basename(current))
      current = parent
    }
  }
}

async function assertInsideRoot(rootReal, target) {
  const rel = path.relative(rootReal, await resolveExistingAncestor(target))
  if (rel === '') return
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new WorkspaceError('PATH_OUTSIDE_ROOT', `路径越界，拒绝写入工作区之外：${target}`)
  }
}

async function existingRoot(root) {
  const raw = String(root ?? '').trim()
  if (raw === '') throw new WorkspaceError('ROOT_NOT_FOUND', '缺少工作区根目录（--root）')
  let real
  try {
    real = await fs.realpath(path.resolve(raw))
  } catch (err) {
    throw new WorkspaceError('ROOT_NOT_FOUND', `工作区根目录不存在：${raw}`, { cause: err })
  }
  if (!(await fs.stat(real)).isDirectory()) {
    throw new WorkspaceError('ROOT_NOT_FOUND', `工作区根路径不是目录：${raw}`)
  }
  return real
}

async function writeFileAtomic(target, content, options = {}) {
  if (options.rootReal !== undefined) await assertInsideRoot(options.rootReal, target)
  const dir = path.dirname(target)
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  )
  try {
    await fs.writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' })
    await fs.rename(tmp, target)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    if (err instanceof WorkspaceError) throw err
    throw new WorkspaceError('WRITE_FAILED', `写入 ${path.basename(target)} 失败：${err.message}`, { cause: err })
  }
}

function winLongPath(value) {
  if (process.platform !== 'win32') return value
  const abs = path.resolve(value)
  if (abs.startsWith('\\\\?\\')) return abs
  if (abs.length < 240) return abs
  if (abs.startsWith('\\\\')) return `\\\\?\\UNC\\${abs.slice(2)}`
  return `\\\\?\\${abs}`
}

async function copyTree(from, to) {
  await fs.cp(winLongPath(from), winLongPath(to), {
    recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true,
  })
}

function localDateStamp(now = new Date()) {
  return `${String(now.getFullYear()).padStart(4, '0')}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
}

function formatDate(value) {
  return `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function normalizeDate(value) {
  const text = String(value ?? '').trim()
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  if (!match) throw new WorkspaceError('DATE_INVALID', `日期「${text}」非法，应为 YYYYMMDD`)
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new WorkspaceError('DATE_INVALID', `日期「${text}」不是有效日历日期`)
  }
  return text
}

function normalizeProjectSlug(rawSlug, rawDate) {
  const slug = String(rawSlug ?? '').trim()
  if (slug === '') throw new WorkspaceError('SLUG_INVALID', '缺少项目 slug')
  if (PROJECT_SLUG_RE.test(slug)) {
    if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
      const date = normalizeDate(rawDate)
      if (date !== slug.slice(0, 8)) {
        throw new WorkspaceError('SLUG_INVALID', `slug 自带日期 ${slug.slice(0, 8)} 与 --date ${date} 不一致`)
      }
    }
    return slug
  }
  if (!PURE_SLUG_RE.test(slug)) {
    throw new WorkspaceError('SLUG_INVALID', `slug「${slug}」非法：只能用小写英文、数字与连字符，且不能以连字符开头或结尾`)
  }
  const date = rawDate === undefined || rawDate === null || rawDate === ''
    ? localDateStamp()
    : normalizeDate(rawDate)
  return `${date}-${slug}`
}

/* ------------------------------ 适配层：扫描 ------------------------------ */

async function loadProject(root, dir, meta) {
  const readmePath = path.join(dir, 'README.md')
  const record = {
    slug: path.basename(dir), dir, legacyRoot: meta.legacyRoot, readmePath: null,
    fields: { conclusions: [], constraints: [], entries: [], rollback: [] },
    issues: [], relPath: meta.relPath, updatedAt: undefined,
  }
  let readmeStat
  try {
    readmeStat = await fs.stat(readmePath)
  } catch {
    readmeStat = undefined
  }
  if (readmeStat !== undefined && readmeStat.isFile()) {
    record.readmePath = readmePath
    record.updatedAt = formatDate(readmeStat.mtime)
    try {
      const buffer = await fs.readFile(readmePath)
      let text
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch {
        throw new WorkspaceError('PARSE_FAILED', 'README.md 不是合法的 UTF-8 编码')
      }
      const parsed = parseReadme(text)
      record.fields = parsed.fields
      record.issues.push(...parsed.issues)
    } catch (err) {
      const detail = err instanceof WorkspaceError ? err.message : `读取 README.md 失败：${err.message}`
      record.issues.push(makeIssue('PARSE_FAILED', 'error', detail, { path: meta.relPath }))
      return record
    }
  } else {
    try {
      record.updatedAt = formatDate((await fs.stat(dir)).mtime)
    } catch {
      record.updatedAt = undefined
    }
  }
  record.issues.push(...validateProject(record))
  return record
}

/** 扫描工作区（不写文件）：projects/ + 过渡期根目录 YYYYMMDD-*；根目录散落项进 warnings。 */
export async function scanWorkspace(root, opts = {}) {
  const rootReal = await existingRoot(root)
  const allow = normalizeRootAllowlist(opts.rootAllowlist)
  const warnings = []
  const projects = []
  const seen = new Set()
  const projectsDir = path.join(rootReal, 'projects')
  if (await isDirectory(projectsDir)) {
    for (const entry of await fs.readdir(projectsDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const relPath = `projects/${entry.name}`
      if (entry.isSymbolicLink()) { warnings.push(makeIssue('ROOT_FILE', 'warning', `projects/ 下的符号链接「${entry.name}」已跳过`, { path: relPath })); continue }
      if (!entry.isDirectory()) { warnings.push(makeIssue('ROOT_FILE', 'warning', `projects/ 下存在非目录条目「${entry.name}」`, { path: relPath })); continue }
      if (!PROJECT_SLUG_RE.test(entry.name)) { warnings.push(makeIssue('SLUG_INVALID', 'warning', `目录名「${entry.name}」不符合 YYYYMMDD-slug，已跳过`, { path: relPath })); continue }
      seen.add(entry.name)
      projects.push(await loadProject(rootReal, path.join(projectsDir, entry.name), { legacyRoot: false, relPath }))
    }
  }
  const rootEntries = await fs.readdir(rootReal, { withFileTypes: true })
  if (opts.legacyRootScan !== false) {
    for (const entry of rootEntries) {
      if (entry.name.startsWith('.') || !entry.isDirectory() || !LEGACY_SLUG_RE.test(entry.name)) continue
      if (seen.has(entry.name)) { warnings.push(makeIssue('SLUG_INVALID', 'warning', `根目录与 projects/ 存在同名项目「${entry.name}」，以 projects/ 为准`, { path: entry.name })); continue }
      seen.add(entry.name)
      projects.push(await loadProject(rootReal, path.join(rootReal, entry.name), { legacyRoot: true, relPath: entry.name }))
    }
  }
  for (const entry of rootEntries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      if (isRootAllowed(entry.name, allow) || LEGACY_SLUG_RE.test(entry.name)) continue
      warnings.push(makeIssue('ROOT_FILE', 'warning', `根目录存在未归类目录「${entry.name}」`, { path: entry.name }))
    } else if (entry.isFile() && !isRootAllowed(entry.name, allow)) {
      warnings.push(makeIssue('ROOT_FILE', 'warning', `根目录存在散落文件「${entry.name}」`, { path: entry.name }))
    }
  }
  projects.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  return { root: rootReal, projects, warnings }
}

/** 列出根目录白名单之外的散落项（只读一层；点开头条目忽略）。 */
export async function listRootStrays(root, opts = {}) {
  const rootReal = await existingRoot(root)
  const allow = normalizeRootAllowlist(opts.rootAllowlist)
  const strays = []
  for (const entry of await fs.readdir(rootReal, { withFileTypes: true })) {
    if (isRootAllowed(entry.name, allow) || entry.name.startsWith('.')) continue
    let type = entry.isDirectory() ? 'directory' : 'file'
    if (entry.isSymbolicLink()) type = (await isDirectory(path.join(rootReal, entry.name))) ? 'directory' : 'file'
    strays.push({ name: entry.name, type })
  }
  return strays.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/* ------------------------------ 适配层：创建与写索引 ---------------------- */

/** 生成附录 A 的项目 README 模板；`目标` 保留 `<...>` 占位。 */
export function renderReadmeSkeleton(slug) {
  return [
    `# ${slug}`,
    '',
    '- 目标: <...>',
    '- 状态: active',
    '',
    '## 说明',
    '',
    '自由文本。需要被解析的内容写成上面的 `- 字段: 值` 行，不要只写在这里。',
    '',
  ].join('\n')
}

export async function createProject(root, input) {
  const rootReal = await existingRoot(root)
  const slug = normalizeProjectSlug(input?.slug, input?.date)
  const goal = String(input?.goal ?? '').replace(/\s*\r?\n\s*/g, ' ').trim()
  if (goal === '') throw new WorkspaceError('GOAL_MISSING', '创建项目必须提供非空的「目标」')
  if (isPlaceholder(goal)) throw new WorkspaceError('GOAL_PLACEHOLDER', '「目标」不能是 <...> 占位符')
  const projectsDir = path.join(rootReal, 'projects')
  const projectDir = path.join(projectsDir, slug)
  await assertInsideRoot(rootReal, projectsDir)
  await assertInsideRoot(rootReal, projectDir)
  if (await pathExists(projectDir)) throw new WorkspaceError('PROJECT_EXISTS', `项目目录已存在，拒绝覆盖：projects/${slug}/`)
  let createdProjectsDir = false
  let createdProjectDir = false
  try {
    if (!(await pathExists(projectsDir))) {
      await fs.mkdir(projectsDir)
      createdProjectsDir = true
    }
    await fs.mkdir(projectDir)
    createdProjectDir = true
    const readme = renderReadmeSkeleton(slug).replace('- 目标: <...>', () => `- 目标: ${goal}`)
    await writeFileAtomic(path.join(projectDir, 'README.md'), readme, { rootReal })
  } catch (err) {
    if (createdProjectDir) await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {})
    if (createdProjectsDir) await fs.rmdir(projectsDir).catch(() => {})
    if (err instanceof WorkspaceError) throw err
    throw new WorkspaceError('PROJECT_CREATE_FAILED', `创建项目失败：${err.message}`, { cause: err })
  }
  return {
    slug, dir: projectDir, legacyRoot: false, readmePath: path.join(projectDir, 'README.md'),
    fields: { goal, status: 'active', conclusions: [], constraints: [], entries: [], rollback: [] },
    issues: [], relPath: `projects/${slug}`,
    updatedAt: `${slug.slice(0, 4)}-${slug.slice(4, 6)}-${slug.slice(6, 8)}`,
  }
}

/**
 * 原子写入 projects/<slug>/README.md。目标路径必须在 root 内；
 * 项目目录不存在时抛 WORKSPACE_WRITE_FAILED，slug 非法时抛 SLUG_INVALID。
 * @param {string} root @param {string} slug @param {string} content
 * @returns {Promise<{path: string, bytes: number}>}
 */
export async function writeProjectReadme(root, slug, content) {
  const rootReal = await existingRoot(root)
  const cleanSlug = String(slug ?? '').trim()
  if (!PROJECT_SLUG_RE.test(cleanSlug)) {
    throw new WorkspaceError('SLUG_INVALID', `slug「${cleanSlug}」非法，应为 YYYYMMDD-slug`)
  }
  const projectDir = path.join(rootReal, 'projects', cleanSlug)
  const target = path.join(projectDir, 'README.md')
  await assertInsideRoot(rootReal, target)
  if (!(await isDirectory(projectDir))) {
    throw new WorkspaceError('WORKSPACE_WRITE_FAILED', `项目目录不存在，无法写入 README.md：projects/${cleanSlug}/`)
  }
  const text = String(content ?? '')
  await writeFileAtomic(target, text, { rootReal })
  return { path: target, bytes: Buffer.byteLength(text, 'utf8') }
}

/** 原子写入 root/PROJECTS.md。 */
export async function writeIndex(root, content) {
  const rootReal = await existingRoot(root)
  const text = String(content ?? '')
  const target = path.join(rootReal, 'PROJECTS.md')
  await assertInsideRoot(rootReal, target)
  await writeFileAtomic(target, text, { rootReal })
  return { path: target, bytes: Buffer.byteLength(text, 'utf8') }
}

/**
 * 初始化工作区：确保 `projects/` 目录存在；`PROJECTS.md` 不存在时写入空索引。
 * 已存在的目录与文件不覆盖、不删除。用于全新工作区的首次建立。
 * @param {string} root 工作区根（必须已存在）
 * @returns {Promise<{root: string, created: string[]}>}
 */
export async function initWorkspace(root) {
  const rootReal = await existingRoot(root)
  const created = []
  const projectsDir = path.join(rootReal, 'projects')
  await assertInsideRoot(rootReal, projectsDir)
  if (!(await isDirectory(projectsDir))) {
    await fs.mkdir(projectsDir, { recursive: true })
    created.push('projects/')
  }
  const indexFile = path.join(rootReal, 'PROJECTS.md')
  if (!(await pathExists(indexFile))) {
    const result = await scanWorkspace(rootReal, { legacyRootScan: false })
    await writeIndex(rootReal, renderProjectsIndex(result))
    created.push('PROJECTS.md')
  }
  return { root: rootReal, created }
}

/** 工作区约定块：AGENTS.md 中由插件维护的标记区。 */
export function renderAgentsSection() {
  return [
    AGENTS_BEGIN,
    '## 工作区约定（由 workspace-guard 维护，请勿手改本块）',
    '',
    '- 所有产出落在 `projects/<YYYYMMDD-slug>/` 下。',
    '- 工作区根目录由 `AGENTS.md`、`PROJECTS.md`、`projects/`、`tools/`、`archive/` 与服务目录组成。',
    '- 新文件放入对应项目的 `artifacts/`、`scripts/` 或 `tmp/`。',
    AGENTS_END,
  ].join('\n')
}

/**
 * 确保 AGENTS.md 含受管约束块：无文件创建、无标记追加、有标记原地替换。
 * 保留标记块外原文；原子写，目标必须在 root 内。
 * @param {string} root
 * @returns {Promise<{path: string, action: 'created'|'appended'|'updated'|'unchanged'}>}
 */
export async function ensureAgentsSection(root) {
  const rootReal = await existingRoot(root)
  const target = path.join(rootReal, 'AGENTS.md')
  await assertInsideRoot(rootReal, target)
  let text = ''
  try { text = await fs.readFile(target, 'utf8') } catch (err) {
    if (err.code !== 'ENOENT') throw new WorkspaceError('WORKSPACE_WRITE_FAILED', `读取 AGENTS.md 失败：${err.message}`, { cause: err })
  }
  const section = renderAgentsSection()
  const begin = text.indexOf(AGENTS_BEGIN)
  const end = begin >= 0 ? text.indexOf(AGENTS_END, begin) : -1
  let next
  let action
  if (begin >= 0) {
    next = text.slice(0, begin) + section + (end >= 0 ? text.slice(end + AGENTS_END.length) : '')
    action = 'updated'
  } else {
    next = `${text === '' ? '' : `${text.replace(/\n*$/, '')}\n\n`}${section}\n`
    action = text === '' ? 'created' : 'appended'
  }
  if (next === text) return { path: target, action: 'unchanged' }
  await writeFileAtomic(target, next, { rootReal })
  return { path: target, action }
}

/* ------------------------------ 适配层：git 与归档 ------------------------ */

function runGit(args) {
  return new Promise((resolve) => {
    execFile(
      'git', args,
      {
        windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
          code: error?.code, error: error ?? undefined,
        })
      },
    )
  })
}

function firstLine(value) {
  const line = String(value ?? '').split(/\r?\n/).find((item) => item.trim() !== '')
  return line === undefined ? '' : line.trim()
}

/** 探测仓库形态（5.7）：independent / parent / none。 */
export async function probeRepository(projectDir) {
  const dir = await fs.realpath(projectDir)
  const result = await runGit(['-C', dir, 'rev-parse', '--show-toplevel'])
  if (!result.ok) return { kind: 'none', worktrees: 0, gitAvailable: result.code !== 'ENOENT' }
  let toplevel = fromGitPath(result.stdout)
  try {
    toplevel = await fs.realpath(toplevel)
  } catch {
    // 保留 git 原始输出，比较时仍会被规范化。
  }
  const kind = compareKey(toplevel) === compareKey(dir) ? 'independent' : 'parent'
  let worktrees = 0
  if (kind === 'independent') {
    const worktreeResult = await runGit(['-C', dir, 'worktree', 'list', '--porcelain'])
    if (worktreeResult.ok) {
      worktrees = worktreeResult.stdout.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length
    }
  }
  return { kind, toplevel, worktrees, gitAvailable: true }
}

async function snapshotRepo(dir) {
  const [top, head, remotes, status] = await Promise.all([
    runGit(['-C', dir, 'rev-parse', '--show-toplevel']),
    runGit(['-C', dir, 'rev-parse', 'HEAD']),
    runGit(['-C', dir, 'remote', '-v']),
    runGit(['-C', dir, 'status', '--porcelain']),
  ])
  return {
    toplevel: top.ok ? fromGitPath(top.stdout) : undefined,
    head: head.ok ? head.stdout.trim() : undefined,
    remotes: remotes.ok ? remotes.stdout.replace(/\r\n/g, '\n').trimEnd() : '',
    dirty: status.ok ? status.stdout.split(/\r?\n/).filter((line) => line !== '').sort().join('\n') : '',
  }
}

async function findAbsoluteSubmoduleGitdir(projectDir) {
  let text
  try {
    text = await fs.readFile(path.join(projectDir, '.gitmodules'), 'utf8')
  } catch {
    return undefined
  }
  const paths = [...text.matchAll(/^\s*path\s*=\s*(.+)$/gm)].map((match) => match[1].trim())
  for (const rel of paths) {
    if (rel === '') continue
    let content
    try {
      content = await fs.readFile(path.join(projectDir, rel, '.git'), 'utf8')
    } catch {
      continue
    }
    const match = /^\s*gitdir:\s*(.+)$/m.exec(content)
    if (match === null) continue
    const gitdir = match[1].trim()
    if (path.isAbsolute(gitdir) || /^[A-Za-z]:[\\/]/.test(gitdir) || gitdir.startsWith('\\\\')) return rel
  }
  return undefined
}

async function preflightIndependent(projectDir) {
  if (await pathExists(path.join(projectDir, '.git', 'index.lock'))) {
    throw new WorkspaceError('VCS_BLOCKED', '检测到 .git/index.lock，可能有 git 进程正在写入；确认没有 git 操作后删除该文件再重试（目录未改动）')
  }
  const probe = await probeRepository(projectDir)
  if (probe.kind !== 'independent') {
    throw new WorkspaceError('VCS_BLOCKED', '仓库形态在移动前发生变化，已中止（目录未改动）')
  }
  if (probe.worktrees > 1) {
    throw new WorkspaceError('VCS_BLOCKED', '检测到 linked worktree；请先用 git worktree remove 清理，再移动主仓库（目录未改动）')
  }
  const submodule = await findAbsoluteSubmoduleGitdir(projectDir)
  if (submodule !== undefined) {
    throw new WorkspaceError('VCS_BLOCKED', `子模块「${submodule}」的 .git 文件记录了绝对 gitdir，移动会失效；请先改为相对 gitdir 或重新初始化子模块（目录未改动）`)
  }
  return snapshotRepo(projectDir)
}

async function relocateDirectory(from, to) {
  try {
    await fs.rename(from, to)
    return { crossVolume: false, sourceDeleted: true }
  } catch (err) {
    if (err.code === 'EXDEV') {
      try {
        await copyTree(from, to)
      } catch (copyError) {
        await fs.rm(to, { recursive: true, force: true }).catch(() => {})
        throw new WorkspaceError('MOVE_FAILED', `跨卷复制目录失败：${copyError.message}`, { cause: copyError })
      }
      return { crossVolume: true, sourceDeleted: false }
    }
    if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
      throw new WorkspaceError('MOVE_FAILED', `移动目录失败（${err.code}）：可能是资源管理器、杀毒软件、OneDrive 同步或未退出的 git 进程占用；不自动重试`, { cause: err })
    }
    throw new WorkspaceError('MOVE_FAILED', `移动目录失败：${err.message}`, { cause: err })
  }
}

async function verifyIndependent(targetDir, before) {
  const probe = await probeRepository(targetDir)
  if (probe.kind !== 'independent' || probe.toplevel === undefined) {
    throw new WorkspaceError('VCS_VERIFY_FAILED', '移动后不再是独立仓库根')
  }
  if (compareKey(probe.toplevel) !== compareKey(targetDir)) {
    throw new WorkspaceError('VCS_VERIFY_FAILED', '移动后仓库根与新目录不一致')
  }
  const after = await snapshotRepo(targetDir)
  if (after.head !== before.head) throw new WorkspaceError('VCS_VERIFY_FAILED', '移动后 HEAD 与移动前不一致')
  if (after.remotes !== before.remotes) throw new WorkspaceError('VCS_VERIFY_FAILED', '移动后 remote 与移动前不一致')
  if (after.dirty !== before.dirty) throw new WorkspaceError('VCS_VERIFY_FAILED', '移动后工作区状态与移动前不一致')
}

async function moveInParentRepo(toplevel, from, to) {
  const relFrom = toPosix(path.relative(toplevel, from))
  const relTo = toPosix(path.relative(toplevel, to))
  const moved = await runGit(['-C', toplevel, 'mv', relFrom, relTo])
  if (!moved.ok) {
    const detail = firstLine(moved.stderr) || firstLine(moved.stdout) || '未知原因'
    if (/source directory is empty|not under version control/i.test(`${moved.stderr}\n${moved.stdout}`)) {
      throw new WorkspaceError('VCS_MOVE_FAILED', `项目尚未被 git 跟踪，请先 git add 再归档（目录未改动）：${detail}`)
    }
    throw new WorkspaceError('VCS_MOVE_FAILED', `git mv 失败：${detail}（目录未改动）`)
  }
  const status = await runGit(['-C', toplevel, '-c', 'core.quotepath=false', 'status', '--porcelain'])
  const staged = status.ok && status.stdout.split(/\r?\n/)
    .some((line) => line.startsWith('R') && line.includes(relFrom) && line.includes(relTo))
  if (!staged) {
    const back = await runGit(['-C', toplevel, 'mv', relTo, relFrom])
    const suffix = back.ok ? '已反向 git mv 回滚' : '反向 git mv 也失败，需人工处理'
    throw new WorkspaceError('VCS_VERIFY_FAILED', `git mv 后未检测到重命名状态（${suffix}）`)
  }
  return { staged: true, statusText: status.stdout }
}

/** 归档状态为 done 的项目（5.6 / 5.7）：移动前按 VCS 形态选择方式， */
export async function archiveProject(root, input) {
  const rootReal = await existingRoot(root)
  const slug = String(input?.slug ?? '').trim()
  if (!PROJECT_SLUG_RE.test(slug)) {
    throw new WorkspaceError('SLUG_INVALID', `slug「${slug}」非法，应为 YYYYMMDD-slug`)
  }
  const projectsSlugDir = path.join(rootReal, 'projects', slug)
  const legacyDir = path.join(rootReal, slug)
  let from
  if (await isDirectory(projectsSlugDir)) from = projectsSlugDir
  else if (await isDirectory(legacyDir)) from = legacyDir
  else throw new WorkspaceError('README_MISSING', `项目不存在：projects/${slug}/`)
  await assertInsideRoot(rootReal, from)
  const readmePath = path.join(from, 'README.md')
  let readmeText
  try {
    readmeText = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(readmePath))
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      throw new WorkspaceError('README_MISSING', `缺少 README.md：${readmePath}`, { cause: err })
    }
    throw new WorkspaceError('PARSE_FAILED', 'README.md 不是合法的 UTF-8 编码', { cause: err })
  }
  const { fields } = parseReadme(readmeText)
  if (fields.status !== 'done') {
    throw new WorkspaceError(
      'STATUS_NOT_DONE',
      `项目状态是「${fields.status ?? 'unknown'}」，只有 done 才能归档（目录未改动）`,
    )
  }
  const vcsMode = input?.vcs ?? 'auto'
  if (vcsMode !== 'auto' && vcsMode !== 'none') {
    throw new WorkspaceError('VCS_BLOCKED', `vcs 参数只能是 auto 或 none，收到「${vcsMode}」`)
  }
  const year = String(input?.year ?? slug.slice(0, 4))
  if (!/^\d{4}$/.test(year)) {
    throw new WorkspaceError('YEAR_INVALID', `归档年份「${year}」非法，应为 4 位数字`)
  }
  const targetDir = path.join(rootReal, 'archive', year, slug)
  await assertInsideRoot(rootReal, targetDir)
  if (await pathExists(targetDir)) throw new WorkspaceError('TARGET_EXISTS', `归档目标已存在，拒绝覆盖：archive/${year}/${slug}/（目录未改动）`)
  const warnings = []
  let probe = { kind: 'none', worktrees: 0, gitAvailable: true, toplevel: undefined }
  if (vcsMode === 'none') {
    warnings.push('已按 vcs=none 跳过 git 探测与校验；若项目位于上层仓库内，普通 rename 会显示为删除 + 未跟踪')
  } else {
    probe = await probeRepository(from)
    if (!probe.gitAvailable) warnings.push('git 不可执行，已降级为普通目录移动并跳过所有 git 校验')
    else if (probe.kind === 'none') warnings.push('项目不在 git 仓库中，按普通目录移动')
  }
  const archiveRoot = path.join(rootReal, 'archive')
  const yearDir = path.join(archiveRoot, year)
  const archiveRootExisted = await pathExists(archiveRoot)
  const yearExisted = await pathExists(yearDir)
  await fs.mkdir(yearDir, { recursive: true })
  const cleanupEmptyParents = async () => {
    if (!yearExisted) await fs.rmdir(yearDir).catch(() => {})
    if (!archiveRootExisted) await fs.rmdir(archiveRoot).catch(() => {})
  }
  let snapshot = {}
  let relocated = null
  let parentStatusText = ''
  const finish = async (moved) => {
    if (!moved.crossVolume) return moved
    try {
      await fs.rm(from, { recursive: true, force: true })
      moved.sourceDeleted = true
    } catch (err) {
      moved.sourceDeleted = false
      warnings.push(`跨卷移动已复制目标，但删除源目录失败：${err.message}`)
    }
    return moved
  }
  try {
    if (probe.kind === 'independent') {
      snapshot = await preflightIndependent(from)
      relocated = await relocateDirectory(from, targetDir)
      await verifyIndependent(targetDir, snapshot)
      relocated = await finish(relocated)
    } else if (probe.kind === 'parent') {
      if (probe.toplevel === undefined) {
        throw new WorkspaceError('VCS_BLOCKED', '无法确定上层仓库根，已中止（目录未改动）')
      }
      const result = await moveInParentRepo(probe.toplevel, from, targetDir)
      parentStatusText = result.statusText
      relocated = { crossVolume: false, sourceDeleted: true }
    } else {
      relocated = await finish(await relocateDirectory(from, targetDir))
    }
  } catch (err) {
    await rollbackArchive(err, { from, targetDir, probe, relocated, parentStatusText })
    await cleanupEmptyParents()
    throw err
  }
  if (relocated === null) {
    await cleanupEmptyParents()
    throw new WorkspaceError('MOVE_FAILED', '归档移动未完成（目录未改动）')
  }
  const result = {
    from,
    to: targetDir,
    vcs: probe.kind,
    staged: probe.kind === 'parent',
    snapshot,
    sourceDeleted: relocated.sourceDeleted,
    warnings,
    relFrom: toPosix(path.relative(rootReal, from)),
    relTo: toPosix(path.relative(rootReal, targetDir)),
  }
  if (probe.kind === 'parent') result.statusText = parentStatusText
  return result
}

async function rollbackArchive(original, state) {
  const { from, targetDir, probe, relocated } = state
  if (probe.kind === 'parent') {
    if (state.parentStatusText === '' || probe.toplevel === undefined) return
    const relFrom = toPosix(path.relative(probe.toplevel, from))
    const relTo = toPosix(path.relative(probe.toplevel, targetDir))
    const back = await runGit(['-C', probe.toplevel, 'mv', relTo, relFrom])
    if (!back.ok) {
      throw new WorkspaceError('ROLLBACK_FAILED', `回滚失败（git mv 反向执行失败）：${firstLine(back.stderr)}；原始错误：${original.message}`)
    }
    return
  }
  if (relocated === null) return
  try {
    if (relocated.crossVolume) {
      await fs.rm(targetDir, { recursive: true, force: true })
      return
    }
    await fs.rename(targetDir, from)
  } catch (err) {
    throw new WorkspaceError('ROLLBACK_FAILED', `回滚失败，需人工检查源与目标：${err.message}；原始错误：${original.message}`, { cause: err })
  }
}
