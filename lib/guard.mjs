/**
 * workspace-guard 运行时胶水：dirty 标记、索引重建、摘要注入与三个命令。
 *
 * 本模块不依赖 @deepseek-ai/schemastery；dirty 判定静态使用包内 core.classifyPath，
 * 索引与摘要通过动态 import 加载 core 并缓存，`config.corePath` 只覆盖后者。
 * 所有钩子内部捕获异常，只写日志与 ctx.logger.warn，绝不打断会话。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { classifyPath } from '../core/workspace-core.mjs'

const DEFAULT_INDEX = 'PROJECTS.md'
const DEFAULT_MAX_SUMMARY = 4000
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh', 'workspace-guard')
const PROJECT_RE = /^\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/
const WRITE_TOOLS = new Set([
  'write', 'edit', 'patch', 'multiedit', 'create', 'move', 'delete', 'rename',
  'remove', 'write_file', 'edit_file', 'apply_patch', 'str_replace',
])

/** 模块级 core 缓存：同一个 URL 只 import 一次。 */
const coreCache = new Map()

/**
 * 归一化 root 作为状态 key（Windows 折叠大小写）。
 * @param {string} root
 * @returns {string}
 */
function normalizeKey(root) {
  let value = path.resolve(String(root ?? ''))
  if (process.platform === 'win32') value = value.toLowerCase()
  return value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
}

/**
 * 按 UTF-8 字节截断，避免日志单条超过 2 KiB。
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function truncateUtf8(text, limit) {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text
  const chars = Array.from(text)
  let low = 0
  let high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(chars.slice(0, mid).join(''), 'utf8') <= limit - 3) low = mid
    else high = mid - 1
  }
  return `${chars.slice(0, low).join('')}…`
}

/**
 * 本地日期 YYYY-MM-DD（日志文件名）。
 * @returns {string}
 */
function localDay() {
  const now = new Date()
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * 判断目录是否像工作区根（同步，供 tools/result 使用）。
 * 强标记：`PROJECTS.md` 存在；弱标记：`projects/` 是目录且至少含一个 `YYYYMMDD-*` 项目。
 * 纯同名文件、空目录、放其他东西的 `projects/` 都不算，避免把无关目录误判为工作区。
 * @param {string} dir
 * @returns {boolean}
 */
function isWorkspaceRoot(dir) {
  try {
    if (existsSync(path.join(dir, 'PROJECTS.md'))) return true
    const projectsDir = path.join(dir, 'projects')
    if (!statSync(projectsDir).isDirectory()) return false
    return readdirSync(projectsDir, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && PROJECT_RE.test(entry.name))
  } catch {
    return false
  }
}

/**
 * 从 cwd 向上找工作区根（同步）。`WORKFLOW.md` 已归档到项目内，不再作为标记。
 * @param {string} cwd
 * @returns {string|undefined}
 */
function findWorkspaceRoot(cwd) {
  let current = path.resolve(cwd)
  while (true) {
    if (isWorkspaceRoot(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * 把任意 JSON 结构里的字符串收集起来（用于工具参数提取）。
 * @param {unknown} value
 * @param {Set<string>} out
 * @param {number} depth
 */
function collectStrings(value, out, depth) {
  if (depth > 6 || value === null || value === undefined) return
  if (typeof value === 'string') {
    out.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1)
  }
}

/**
 * 索引文件名只允许单段文件名，拒绝路径分隔符与点开头，防止越界写入。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeIndexFileName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name) || name.startsWith('.')) {
    return DEFAULT_INDEX
  }
  return name
}

/**
 * 创建 guard 实例。
 * @param {object} ctx Host 上下文（测试可传 fake）。
 * @param {object} [config] 插件配置；`dataDir` 仅供测试/嵌入使用。
 * @returns {object}
 */
export function createGuard(ctx, config = {}) {
  const options = {
    autoCreateReadme: config.autoCreateReadme === true,
    legacyRootScan: config.legacyRootScan !== false,
    maxSummaryBytes: Number.isFinite(config.maxSummaryBytes) && config.maxSummaryBytes > 0
      ? Math.floor(config.maxSummaryBytes)
      : DEFAULT_MAX_SUMMARY,
    corePath: typeof config.corePath === 'string' ? config.corePath : '',
    indexFileName: normalizeIndexFileName(config.indexFileName),
    dataDir: typeof config.dataDir === 'string' && config.dataDir !== ''
      ? config.dataDir
      : DEFAULT_DATA_DIR,
  }
  const stateFile = path.join(options.dataDir, 'state.json')
  const logsDir = path.join(options.dataDir, 'logs')

  const state = { version: 1, workspaces: {} }
  let stateLoaded = false
  let saveChain = Promise.resolve()
  const pendingDirty = new Set()
  const summaries = new Map()
  const summaryRoots = new Map()
  const agentDisposers = new Map()
  const rootCache = new Map()

  /** 写一条日志（失败吞掉）。 */
  async function appendLog(level, message) {
    try {
      const line = `${new Date().toISOString()} [${level}] ${truncateUtf8(String(message ?? ''), 1800)}\n`
      await fs.mkdir(logsDir, { recursive: true })
      await fs.appendFile(path.join(logsDir, `${localDay()}.log`), line, 'utf8')
    } catch {
      // 日志失败不能再影响会话。
    }
  }

  /** logger.warn + 文件日志；永不抛出。 */
  async function warn(message) {
    try {
      ctx.logger?.warn?.(`[workspace-guard] ${message}`)
    } catch {
      // 忽略 logger 自身异常。
    }
    await appendLog('warn', message)
  }

  /** 懒加载 state.json；损坏时按空状态处理。 */
  async function ensureState() {
    if (stateLoaded) return
    stateLoaded = true
    try {
      const raw = await fs.readFile(stateFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.workspaces && typeof parsed.workspaces === 'object') {
        state.version = 1
        state.workspaces = parsed.workspaces
      }
    } catch (err) {
      if (err.code !== 'ENOENT') await warn(`state.json 损坏，按空状态处理：${err.message}`)
    }
  }

  /** 原子写入 state.json。 */
  async function saveStateNow() {
    try {
      await fs.mkdir(options.dataDir, { recursive: true })
      const tmp = path.join(
        options.dataDir,
        `.state.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
      )
      await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await fs.rename(tmp, stateFile)
    } catch {
      // 状态保存失败不影响索引与会话。
    }
  }

  /** 串行保存，避免并发 rename 冲突。 */
  function scheduleSave() {
    saveChain = saveChain.then(saveStateNow).catch(() => {})
    return saveChain
  }

  /** 标记某个 root 为 dirty（同步入内存，异步落盘）。 */
  function markDirty(root) {
    const key = normalizeKey(root)
    pendingDirty.add(key)
    void ensureState()
      .then(() => {
        const entry = state.workspaces[key] ?? { dirty: false, lastBuildAt: null, lastError: null }
        entry.dirty = true
        state.workspaces[key] = entry
        return scheduleSave()
      })
      .catch(() => {})
  }

  function isDirty(root) {
    const key = normalizeKey(root)
    return pendingDirty.has(key) || state.workspaces[key]?.dirty === true
  }

  function clearDirtyState(root) {
    const key = normalizeKey(root)
    pendingDirty.delete(key)
    const entry = state.workspaces[key] ?? { dirty: false, lastBuildAt: null, lastError: null }
    entry.dirty = false
    entry.lastBuildAt = new Date().toISOString()
    entry.lastError = null
    state.workspaces[key] = entry
    void scheduleSave()
  }

  /** 记录一次失败：保留 dirty，写入 lastError。 */
  async function reportFailure(root, phase, err) {
    const message = `[${phase}] ${err?.message ?? String(err)}`
    await warn(message)
    if (typeof root !== 'string') return
    await ensureState()
    const key = normalizeKey(root)
    const entry = state.workspaces[key] ?? { dirty: false, lastBuildAt: null, lastError: null }
    entry.lastError = message
    state.workspaces[key] = entry
    await scheduleSave()
  }

  /** 加载 core 供索引/摘要生成；dirty 判定始终用包内默认 core（静态 import）。 */
  function loadCore() {
    const url = options.corePath !== ''
      ? pathToFileURL(path.resolve(options.corePath)).href
      : new URL('../core/workspace-core.mjs', import.meta.url).href
    let promise = coreCache.get(url)
    if (promise === undefined) {
      promise = import(url)
      coreCache.set(url, promise)
      promise.catch(() => coreCache.delete(url))
    }
    return promise
  }

  /** 从 agent 解析工作区根：sessions → workingDirectory → 向上找 PROJECTS.md 或 projects/。 */
  function resolveRoot(agent) {
    const agentId = agent?.id
    if (typeof agentId !== 'string' || agentId === '') return undefined
    let session
    try {
      session = ctx.sessions?.get?.(agentId)
    } catch {
      session = undefined
    }
    if (session === undefined || session === null) return undefined
    let cwd
    try {
      cwd = ctx.workingDirectory?.get?.(session)
    } catch {
      cwd = undefined
    }
    if (typeof cwd !== 'string' || cwd.trim() === '') return undefined

    const absolute = path.resolve(cwd)
    const cached = rootCache.get(agentId)
    if (cached !== undefined && cached.cwd === absolute) return cached.root
    const root = findWorkspaceRoot(absolute)
    if (root === undefined) {
      rootCache.delete(agentId)
      return undefined
    }
    rootCache.set(agentId, { cwd: absolute, root })
    return root
  }

  /** 只取 agent 的当前目录，不要求它已经是工作区根（供初始化命令使用）。 */
  function resolveCwd(agent) {
    const agentId = agent?.id
    if (typeof agentId !== 'string' || agentId === '') return undefined
    try {
      const session = ctx.sessions?.get?.(agentId)
      if (session === undefined || session === null) return undefined
      const cwd = ctx.workingDirectory?.get?.(session)
      if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
      return path.resolve(cwd)
    } catch {
      return undefined
    }
  }

  /** 从 exec 推断 cwd（显式 cwd / agent / session）。 */
  function resolveExecCwd(exec) {
    if (typeof exec?.cwd === 'string' && exec.cwd !== '') return path.resolve(exec.cwd)
    if (typeof exec?.workingDirectory === 'string' && exec.workingDirectory !== '') {
      return path.resolve(exec.workingDirectory)
    }
    const agentId = exec?.agentId ?? exec?.agent?.id
    const sessionId = exec?.sessionId ?? exec?.session?.id
    let session
    try {
      if (sessionId !== undefined) session = ctx.sessions?.get?.(sessionId)
      else if (agentId !== undefined) session = ctx.sessions?.get?.(agentId)
      if (session === undefined || session === null) return undefined
      const cwd = ctx.workingDirectory?.get?.(session)
      return typeof cwd === 'string' && cwd !== '' ? path.resolve(cwd) : undefined
    } catch {
      return undefined
    }
  }

  /** 提取工具参数里的候选路径字符串。 */
  function extractPaths(exec) {
    const values = new Set()
    for (const candidate of [exec?.arguments, exec?.args, exec?.input]) {
      if (typeof candidate === 'string') {
        try {
          collectStrings(JSON.parse(candidate), values, 0)
        } catch {
          collectStrings(candidate, values, 0)
        }
      } else {
        collectStrings(candidate, values, 0)
      }
    }
    for (const key of ['path', 'file_path', 'filePath', 'source', 'destination', 'target']) {
      if (typeof exec?.[key] === 'string') values.add(exec[key])
    }
    return [...values].filter((value) => {
      if (typeof value !== 'string' || value === '' || value.length > 4096) return false
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false
      return value.includes('/') || value.includes('\\')
    })
  }

  /** tools/result：同步标记 dirty，永不抛出。 */
  function observeToolResult(exec) {
    try {
      const name = String(exec?.name ?? exec?.tool ?? '').toLowerCase()
      if (!WRITE_TOOLS.has(name)) return
      const paths = extractPaths(exec)
      if (paths.length === 0) return
      const cwd = resolveExecCwd(exec)
      const roots = new Set()
      if (cwd !== undefined) {
        const root = findWorkspaceRoot(cwd)
        if (root !== undefined) roots.add(root)
      }
      for (const cached of rootCache.values()) roots.add(cached.root)
      for (const key of Object.keys(state.workspaces)) roots.add(key)
      if (typeof exec?.root === 'string') roots.add(exec.root)
      for (const value of paths) {
        try {
          const absolute = path.isAbsolute(value)
            ? path.resolve(value)
            : (cwd === undefined ? undefined : path.resolve(cwd, value))
          if (absolute === undefined) continue
          for (const root of roots) {
            const kind = classifyPath(root, absolute).kind
            if (kind === 'projects' || kind === 'legacy-root') {
              markDirty(root)
              break
            }
          }
        } catch {
          // 单个路径失败不影响其他路径。
        }
      }
    } catch (err) {
      void warn(`observeToolResult 失败：${err?.message ?? err}`)
    }
  }

  /** agent/created：注册 per-agent 摘要上下文。 */
  function attachAgent(agent) {
    try {
      const agentId = agent?.id
      const agentCtx = agent?.ctx
      if (typeof agentId !== 'string' || agentId === '' || agentCtx === undefined) return
      if (typeof agentCtx.effect !== 'function' || typeof agentCtx.systemPrompt?.context !== 'function') return
      if (agentDisposers.has(agentId)) return
      const disposer = agentCtx.effect(() => agentCtx.systemPrompt.context({
        name: 'workspace-guard:projects',
        order: 500,
        text: () => summaries.get(agentId) ?? '',
      }))
      agentDisposers.set(agentId, typeof disposer === 'function' ? disposer : () => {})
    } catch (err) {
      void warn(`attachAgent 失败：${err?.message ?? err}`)
    }
  }

  /** 判断是否存在缺 README 的项目（projects/ 与过渡期根目录）。 */
  async function hasProjectWithoutReadme(root) {
    const dirs = []
    try {
      for (const entry of await fs.readdir(path.join(root, 'projects'), { withFileTypes: true })) {
        if (entry.isDirectory() && PROJECT_RE.test(entry.name)) dirs.push(path.join(root, 'projects', entry.name))
      }
    } catch {
      // projects/ 不存在。
    }
    try {
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        const kind = classifyPath(root, path.join(root, entry.name)).kind
        if (entry.isDirectory() && kind === 'legacy-root') dirs.push(path.join(root, entry.name))
      }
    } catch {
      // 根目录不可读。
    }
    for (const dir of dirs) {
      if (!existsSync(path.join(dir, 'README.md'))) return true
    }
    return false
  }

  /** autoCreateReadme：为缺 README 的项目补骨架（失败只警告）。 */
  async function createMissingReadmes(root, core) {
    let entries
    try {
      entries = await fs.readdir(path.join(root, 'projects'), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_RE.test(entry.name)) continue
      if (existsSync(path.join(root, 'projects', entry.name, 'README.md'))) continue
      try {
        await core.writeProjectReadme(root, entry.name, core.renderReadmeSkeleton(entry.name))
      } catch (err) {
        await warn(`补写 README 失败：projects/${entry.name}/：${err.message}`)
      }
    }
  }

  /** 扫描 + 校验 + 写索引 + 刷新该 agent 摘要。失败抛给 beforeStep 捕获。 */
  async function rebuild(root, agentId, signal) {
    const core = await loadCore()
    if (signal?.aborted) return
    if (options.autoCreateReadme) await createMissingReadmes(root, core)
    const result = await core.scanWorkspace(root, { legacyRootScan: options.legacyRootScan })
    if (signal?.aborted) return
    const text = core.renderProjectsIndex(result)
    const written = await core.writeIndex(root, text)
    if (options.indexFileName !== DEFAULT_INDEX) {
      try {
        await fs.rename(written.path, path.join(root, options.indexFileName))
      } catch (err) {
        await warn(`索引已写为 PROJECTS.md，但改名为 ${options.indexFileName} 失败：${err.message}`)
      }
    }
    clearDirtyState(root)
    summaries.set(agentId, core.renderSummary(result.projects, options.maxSummaryBytes))
    summaryRoots.set(agentId, root)
  }

  /** 只刷新摘要，不写索引。 */
  async function refreshSummary(agentId, root) {
    const core = await loadCore()
    const result = await core.scanWorkspace(root, { legacyRootScan: options.legacyRootScan })
    summaries.set(agentId, core.renderSummary(result.projects, options.maxSummaryBytes))
    summaryRoots.set(agentId, root)
  }

  /** 找不到工作区根时只警告一次，避免每步刷屏。 */
  const warnedMissingRoot = new Set()

  async function warnMissingRoot(agent) {
    const agentId = agent?.id
    if (typeof agentId !== 'string' || agentId === '') return
    if (warnedMissingRoot.has(agentId)) return
    warnedMissingRoot.add(agentId)
    await warn('未找到工作区根：向上既没有 PROJECTS.md，也没有含 YYYYMMDD-* 项目的 projects/ 目录；本目录跳过。可在目标目录执行 /project-init-workspace 初始化。')
  }

  /** agent/pre-step：必要时重建索引并刷新摘要；任何情况下不抛。 */
  async function beforeStep(agent, signal) {
    let root
    try {
      if (signal?.aborted) return
      root = resolveRoot(agent)
      if (root === undefined) {
        await warnMissingRoot(agent)
        return
      }
      await ensureState()
      const indexMissing = !existsSync(path.join(root, options.indexFileName))
      const readmeMissing = await hasProjectWithoutReadme(root)
      const dirty = isDirty(root)
      if (!dirty && !indexMissing && !readmeMissing) {
        if (summaries.get(agent.id) === undefined || summaryRoots.get(agent.id) !== root) {
          await refreshSummary(agent.id, root)
        }
        return
      }
      await rebuild(root, agent.id, signal)
    } catch (err) {
      await reportFailure(root, 'beforeStep', err)
    }
  }

  /** 统一命令错误返回。 */
  function toErrorResult(err) {
    const code = typeof err?.code === 'string' ? err.code : 'UNKNOWN'
    return { kind: 'error', text: `错误（${code}）：${err?.message ?? String(err)}` }
  }

  function usageError(message) {
    return { kind: 'error', text: `错误（USAGE）：${message}` }
  }

  /** /project-init：slug + 目标 → 建目录与 README，并重建索引。 */
  async function commandInit(invocation) {
    try {
      const raw = String(invocation?.rawInput ?? '').trim()
      const [slug, ...rest] = raw.split(/\s+/).filter(Boolean)
      const goal = rest.join(' ')
      if (slug === undefined || goal === '') return usageError('用法：/project-init <slug> <目标>')
      const root = resolveRoot(invocation?.agent)
      if (root === undefined) return usageError('无法定位工作区：当前目录向上找不到 PROJECTS.md 或 projects/')
      const core = await loadCore()
      const record = await core.createProject(root, { slug, goal })
      try {
        await rebuild(root, invocation.agent.id)
      } catch (err) {
        await warn(`项目已创建，但索引重建失败：${err.message}`)
      }
      return { kind: 'success', text: `已创建：projects/${record.slug}/` }
    } catch (err) {
      return toErrorResult(err)
    }
  }

  /** /project-check：只扫描与校验，不写文件。 */
  async function commandCheck(invocation) {
    try {
      const root = resolveRoot(invocation?.agent)
      if (root === undefined) return usageError('无法定位工作区：当前目录向上找不到 PROJECTS.md 或 projects/')
      const core = await loadCore()
      const result = await core.scanWorkspace(root, { legacyRootScan: options.legacyRootScan })
      const issues = []
      for (const project of result.projects) {
        for (const issue of project.issues ?? []) {
          issues.push({ path: `${project.relPath}/`, issue })
        }
      }
      for (const warning of result.warnings ?? []) {
        issues.push({ path: warning.path ?? '', issue: warning })
      }
      const errors = issues.filter((item) => item.issue.severity === 'error')
      const warnings = issues.filter((item) => item.issue.severity === 'warning')
      const lines = [`检查完毕：${result.projects.length} 个项目，${errors.length} 个问题`]
      for (const item of errors) {
        const location = item.issue.line === undefined ? '' : `（README.md:${item.issue.line}）`
        lines.push(`- ${item.path}：${item.issue.message}${location}`)
      }
      if (warnings.length > 0) lines.push(`格式警告 ${warnings.length} 条（不改变结果）`)
      return { kind: errors.length > 0 ? 'error' : 'success', text: lines.join('\n') }
    } catch (err) {
      return toErrorResult(err)
    }
  }

  /** /project-archive：校验 done → 按 VCS 形态移动 → 重建索引。 */
  async function commandArchive(invocation) {
    try {
      const slug = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)[0]
      if (slug === undefined) return usageError('用法：/project-archive <slug>')
      const root = resolveRoot(invocation?.agent)
      if (root === undefined) return usageError('无法定位工作区：当前目录向上找不到 PROJECTS.md 或 projects/')
      if (invocation?.signal?.aborted) return { kind: 'error', text: '错误（CANCELLED）：归档已取消' }

      const core = await loadCore()
      const result = await core.archiveProject(root, { slug })
      try {
        await rebuild(root, invocation.agent.id)
      } catch (err) {
        await warn(`已归档，但索引重建失败：${err.message}`)
      }
      const from = path.relative(root, result.from).replace(/\\/g, '/')
      const to = path.relative(root, result.to).replace(/\\/g, '/')
      if (result.vcs === 'parent') {
        return {
          kind: 'success',
          text: [
            `已归档（仓库内重命名）：${from}/ → ${to}/`,
            'VCS: parent（上层仓库）',
            '状态：重命名已暂存（R），需人工提交；本插件不提交、不推送',
          ].join('\n'),
        }
      }
      return { kind: 'success', text: `已归档：${from}/ → ${to}/\nVCS: ${result.vcs}` }
    } catch (err) {
      return toErrorResult(err)
    }
  }

  /** /project-init-workspace：在当前目录显式建立 projects/ 与 PROJECTS.md 骨架。 */
  async function commandInitWorkspace(invocation) {
    try {
      const cwd = resolveCwd(invocation?.agent)
      if (cwd === undefined) return usageError('无法定位当前目录：请先确认会话工作目录')
      const core = await loadCore()
      const result = await core.initWorkspace(cwd)
      const created = result.created.length > 0 ? result.created.join('，') : '已存在，无需创建'
      return { kind: 'success', text: `工作区已就绪：${result.root}\n创建：${created}` }
    } catch (err) {
      return toErrorResult(err)
    }
  }

  const commands = {
    init: { name: 'project-init', description: '新建项目目录与 README 骨架，并重建索引。', handler: commandInit },
    check: { name: 'project-check', description: '只校验项目 README 必填项，不写文件。', handler: commandCheck },
    archive: { name: 'project-archive', description: '归档状态为 done 的项目并重建索引。', handler: commandArchive },
    initWorkspace: { name: 'project-init-workspace', description: '在当前目录建立 projects/ 与 PROJECTS.md 骨架，用于全新工作区。', handler: commandInitWorkspace },
  }

  /** 安全执行 ctx.effect 注册。 */
  function safeEffect(hostCtx, factory) {
    try {
      if (typeof hostCtx?.effect === 'function') hostCtx.effect(factory)
      else factory()
    } catch (err) {
      void warn(`注册失败：${err?.message ?? err}`)
    }
  }

  /** 注册 3 个事件与 4 个命令（index.js 与测试共用）。 */
  function register(hostCtx) {
    const target = hostCtx ?? ctx
    safeEffect(target, () => target.on('tools/result', (exec) => observeToolResult(exec)))
    safeEffect(target, () => target.on('agent/created', (payload) => attachAgent(payload?.agent ?? payload)))
    safeEffect(target, () => target.on('agent/pre-step', async (payload, next) => {
      try {
        await beforeStep(payload?.agent, payload?.signal)
      } catch {
        // beforeStep 自身不抛，这里再兜一层。
      }
      return typeof next === 'function' ? next() : undefined
    }))
    safeEffect(target, () => target.commands.register(commands.init))
    safeEffect(target, () => target.commands.register(commands.check))
    safeEffect(target, () => target.commands.register(commands.archive))
    safeEffect(target, () => target.commands.register(commands.initWorkspace))
  }

  /** 等待状态落盘。 */
  async function flushState() {
    try {
      await ensureState()
      await saveStateNow()
    } catch {
      // 忽略。
    }
  }

  /** 清理 agent 上下文并落盘。 */
  async function dispose() {
    for (const disposer of agentDisposers.values()) {
      try {
        if (typeof disposer === 'function') disposer()
      } catch {
        // 单个 disposer 失败不影响其他清理。
      }
    }
    agentDisposers.clear()
    summaries.clear()
    summaryRoots.clear()
    rootCache.clear()
    await flushState()
  }

  return {
    observeToolResult,
    attachAgent,
    beforeStep,
    commands,
    register,
    flushState,
    dispose,
  }
}
