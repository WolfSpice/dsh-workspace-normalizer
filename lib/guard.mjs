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

import { DONE_INDEX_FILE, classifyPath, classifyWriteTarget, ensureAgentsSection, listRootStrays } from '../core/workspace-core.mjs'
import { writeEffectiveConfig } from '../core/effective-config.mjs'

const DEFAULT_INDEX = 'PROJECTS.md'
const DEFAULT_MAX_SUMMARY = 4000
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh', 'workspace-guard')
const PROJECT_RE = /^\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/
const WRITE_TOOLS = new Set([
  'write', 'edit', 'patch', 'multiedit', 'create', 'move', 'delete', 'rename',
  'remove', 'write_file', 'edit_file', 'apply_patch', 'str_replace',
])
/** 只拦「新建文件」的工具；edit 只改内容，不参与拦截。 */
const CREATING_TOOLS = new Set(['write', 'write_file', 'create'])

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
 * 从 cwd 向上找工作区根（同步）；以 PROJECTS.md 或含项目的 projects/ 作为标记。
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
    manageAgentsFile: config.manageAgentsFile !== false,
    rootAllowlist: Array.isArray(config.rootAllowlist) ? config.rootAllowlist : [],
    enforceRootWrites: config.enforceRootWrites !== false,
    interactiveInit: config.interactiveInit !== false,
    askTimeoutMs: Number.isFinite(config.askTimeoutMs) && config.askTimeoutMs >= 5000
      ? Math.floor(config.askTimeoutMs)
      : 30000,
    maxDenyPerPath: Number.isFinite(config.maxDenyPerPath) && config.maxDenyPerPath >= 1
      ? Math.floor(config.maxDenyPerPath)
      : 3,
    dataDir: typeof config.dataDir === 'string' && config.dataDir !== ''
      ? config.dataDir
      : DEFAULT_DATA_DIR,
  }
  const stateFile = path.join(options.dataDir, 'state.json')
  const logsDir = path.join(options.dataDir, 'logs')

  // 落盘生效配置供 CLI 复用；失败只警告，不影响插件加载。
  void writeEffectiveConfig({ dataDir: options.dataDir }, options).then((ok) => {
    if (!ok) void warn('生效配置写入失败（CLI 将使用默认配置）')
  })

  const state = { version: 1, workspaces: {} }
  let stateLoaded = false
  let saveChain = Promise.resolve()
  const pendingDirty = new Set()
  const summaries = new Map()
  const summaryRoots = new Map()
  const agentDisposers = new Map()
  const rootCache = new Map()
  const scanPending = new Set()
  const agentsManaged = new Set()
  /** 行为推断的当前项目：agentId → 'projects/<slug>'。 */
  const currentProject = new Map()
  /** 熔断计数：`agentId|绝对路径` → 拒绝次数。 */
  const denyAttempts = new Map()
  /** 一次性放行：同一 key 命中即删除。 */
  const allowOnce = new Set()
  /** 按 agent 放行一次根目录写入（project_create 的「放行到根目录」）。 */
  const allowRootOnce = new Set()

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

  /** tools/result：任何工具都记 scanPending（不读盘）；写类工具再标记 dirty。永不抛出。 */
  function observeToolResult(exec) {
    try {
      const agentId = exec?.agentId ?? exec?.agent?.id
      if (typeof agentId === 'string' && agentId !== '') scanPending.add(agentId)
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
            const kind = classifyPath(root, absolute, options.rootAllowlist).kind
            if (kind === 'projects' || kind === 'legacy-root') {
              markDirty(root)
              const project = projectSlugFromPath(root, absolute)
              if (project !== undefined && typeof agentId === 'string' && agentId !== '') {
                currentProject.set(agentId, project)
              }
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

  /** 从 write 类工具参数里取目标路径。 */
  function extractWriteTarget(exec) {
    const args = exec?.arguments
    if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
      for (const key of ['path', 'file_path', 'filePath']) {
        const value = args[key]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      }
    }
    return undefined
  }

  /** 由绝对路径推断所属项目；不在 projects/<slug> 下返回 undefined。 */
  function projectSlugFromPath(root, absolute) {
    const rel = path.relative(root, absolute)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
    const parts = rel.split(/[\\/]+/).filter(Boolean)
    if (parts[0] !== 'projects' || parts.length < 2) return undefined
    return PROJECT_RE.test(parts[1]) ? `projects/${parts[1]}` : undefined
  }

  /** 工作区里所有未完成项目（相对路径）。 */
  async function listActiveProjectPaths(root) {
    try {
      const core = await loadCore()
      const result = await core.scanWorkspace(root, {
        legacyRootScan: options.legacyRootScan,
        rootAllowlist: options.rootAllowlist,
      })
      return result.projects
        .filter((record) => record.fields?.status !== 'done')
        .map((record) => `projects/${record.slug}`)
    } catch {
      return []
    }
  }

  /** 组装拒绝原因：给出当前项目与可执行的下一步。 */
  function buildWriteDenyReason(root, absolute, agentId) {
    const rel = path.relative(root, absolute).replace(/\\/g, '/')
    const current = currentProject.get(agentId)
    const lines = [`工作区根目录不接受新文件：${rel}`]
    if (current !== undefined) {
      lines.push(`当前项目：${current}`)
      lines.push(`请改写到 ${current}/artifacts/ 下（脚本用 scripts/，临时文件用 tmp/）。`)
    } else {
      lines.push('请把文件写进 projects/<slug>/ 下；没有对应项目时调用 project_create 新建。')
    }
    lines.push('确实要放在根目录时，调用 project_create 并选择「放行到根目录」。')
    return lines.join('\n')
  }

  /** 判定一次写入是否要拦；返回 pre-execute decision 或 undefined。 */
  function evaluateWriteIntent(exec) {
    if (!options.enforceRootWrites) return undefined
    const name = String(exec?.name ?? '').toLowerCase()
    if (!CREATING_TOOLS.has(name)) return undefined
    const raw = extractWriteTarget(exec)
    if (raw === undefined) return undefined
    const cwd = resolveExecCwd(exec)
    if (cwd === undefined) return undefined
    const root = findWorkspaceRoot(cwd)
    if (root === undefined) return undefined
    const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw)
    let exists = false
    try {
      exists = existsSync(absolute)
    } catch {
      exists = false
    }
    // 覆盖写已有文件不改变结构，放行。
    if (exists) return undefined
    const verdict = classifyWriteTarget(root, absolute, options.rootAllowlist)
    if (verdict.allow) return undefined

    const agentId = exec?.agent?.id ?? exec?.agentId ?? ''
    if (allowRootOnce.has(agentId)) {
      allowRootOnce.delete(agentId)
      return undefined
    }
    const key = `${agentId}|${normalizeKey(absolute)}`
    if (allowOnce.has(key)) {
      allowOnce.delete(key)
      return undefined
    }
    const attempts = (denyAttempts.get(key) ?? 0) + 1
    denyAttempts.set(key, attempts)
    if (attempts > options.maxDenyPerPath) {
      void warn(`同一路径已拒绝 ${attempts - 1} 次，本次放行：${raw}`)
      return undefined
    }
    return { kind: 'deny', reason: buildWriteDenyReason(root, absolute, agentId) }
  }

  /** tools/pre-execute：拦截根目录新建文件。永不抛出。 */
  async function onPreExecute(exec, next) {
    try {
      const decision = evaluateWriteIntent(exec)
      if (decision !== undefined) return decision
    } catch (err) {
      void warn(`写入拦截判定失败：${err?.message ?? err}`)
    }
    return typeof next === 'function' ? next() : { kind: 'allow' }
  }

  /** 交互式提问；服务缺失、调用方不可交互或超时时返回 undefined。 */
  async function askInteractive(agent, questions, callId) {
    let service
    try {
      service = typeof ctx?.get === 'function' ? ctx.get('userQuestions') : ctx?.userQuestions
    } catch {
      service = undefined
    }
    if (service === null || service === undefined) return undefined
    if (typeof service.askTimed !== 'function') return undefined
    if (callId === undefined || callId === null) return undefined
    try {
      const result = await service.askTimed({ questions, agent }, callId, options.askTimeoutMs)
      if (result === null || result === undefined || result.pending === true) return undefined
      return Array.isArray(result.answers) ? result.answers : undefined
    } catch (err) {
      await warn(`交互提问失败：${err?.message ?? err}`)
      return undefined
    }
  }

  /** 阻塞式提问（命令场景）：不设超时，用户当场可见。 */
  async function askBlocking(agent, questions, signal) {
    let service
    try {
      service = typeof ctx?.get === 'function' ? ctx.get('userQuestions') : ctx?.userQuestions
    } catch {
      service = undefined
    }
    if (service === null || service === undefined || typeof service.ask !== 'function') return undefined
    try {
      const result = await service.ask({ questions, agent, signal })
      return Array.isArray(result?.answers) ? result.answers : undefined
    } catch (err) {
      await warn(`交互提问失败：${err?.message ?? err}`)
      return undefined
    }
  }

  /** 取一个问题的答案文本：优先 custom，其次唯一选项。 */  function answerText(answers, id) {
    if (!Array.isArray(answers)) return undefined
    const item = answers.find((entry) => entry?.id === id)
    if (item === undefined) return undefined
    if (typeof item.custom === 'string' && item.custom.trim() !== '') return item.custom.trim()
    if (Array.isArray(item.selected) && item.selected.length === 1) return String(item.selected[0]).trim()
    return undefined
  }

  /** 注册 project_create 工具：让模型能主动建项目或申请放行。 */
  function registerProjectCreateTool(hostCtx) {
    let tools
    try {
      tools = hostCtx?.tools ?? (typeof ctx?.get === 'function' ? ctx.get('tools') : ctx?.tools)
    } catch {
      tools = undefined
    }
    if (tools === null || tools === undefined || typeof tools.register !== 'function') return
    safeEffect(hostCtx ?? ctx, () => tools.register({
      name: 'project_create',
      description: '在工作区内创建新项目（目录 + README 并重建索引），或把当前文件归入已有项目。写入工作区根目录被拒绝时调用它；它会用选择题向用户确认。',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: '项目短名（小写英文与连字符）；省略时向用户提问' },
          goal: { type: 'string', description: '项目目标，一句话；省略时向用户提问' },
          mode: {
            type: 'string',
            enum: ['new', 'existing', 'allow-root'],
            description: 'new 新建项目（默认）；existing 归入已有项目；allow-root 本次允许写入根目录',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
      },
      async execute(args, run) {
        const agent = run?.agent
        const agentId = agent?.id ?? ''
        const cwd = resolveExecCwd(run) ?? resolveCwd(agent)
        if (cwd === undefined) return { ok: false, message: '无法定位当前工作目录' }
        const root = findWorkspaceRoot(cwd)
        if (root === undefined) {
          return { ok: false, message: '当前位置不是工作区（找不到 PROJECTS.md 或含项目的 projects/）；请先执行 /project-init-workspace' }
        }

        let mode = typeof args?.mode === 'string' ? args.mode : ''
        let slug = typeof args?.slug === 'string' ? args.slug.trim() : ''
        let goal = typeof args?.goal === 'string' ? args.goal.trim() : ''

        if (mode === '' && options.interactiveInit) {
          const active = await listActiveProjectPaths(root)
          const options_ = [
            { label: '新建项目', description: '创建 projects/YYYYMMDD-slug/ 后写入' },
            ...active.slice(0, 5).map((item) => ({ label: item, description: '归入已有项目' })),
            { label: '放行到根目录', description: '不建项目，本次允许写入根目录' },
          ]
          const answers = await askInteractive(agent, [{
            id: 'mode',
            question: '这次的文件应该归到哪里？',
            header: '项目归属',
            options: options_,
          }], run?.callId)
          const picked = answerText(answers, 'mode')
          if (picked === undefined) return { ok: false, message: '用户未在时限内选择，已取消' }
          if (picked === '放行到根目录') mode = 'allow-root'
          else if (picked.startsWith('projects/')) {
            mode = 'existing'
            return { ok: true, path: picked, message: `已确认归入 ${picked}；请把文件写到 ${picked}/artifacts/ 下` }
          } else mode = 'new'
        }

        if (mode === 'allow-root') {
          allowRootOnce.add(agentId)
          return { ok: true, message: '已放行：本次可以写入工作区根目录，请重试原写入操作' }
        }
        if (mode === 'existing') {
          return { ok: true, message: '该文件应归入已有项目，请把路径改为 projects/<slug>/artifacts/ 下后重试' }
        }

        if (slug === '' && options.interactiveInit) {
          const answers = await askInteractive(agent, [{
            id: 'slug',
            question: '新项目的短名是什么？（小写英文与连字符，例如 demo）',
            header: '项目名',
            options: [{ label: 'demo' }, { label: 'notes' }],
          }], run?.callId)
          slug = answerText(answers, 'slug') ?? ''
        }
        if (goal === '' && options.interactiveInit) {
          const answers = await askInteractive(agent, [{
            id: 'goal',
            question: '这个项目要解决什么？用一句话描述。',
            header: '项目目标',
          }], run?.callId)
          goal = answerText(answers, 'goal') ?? ''
        }
        if (slug === '') return { ok: false, message: '缺少项目名（slug），已取消' }
        if (goal === '') return { ok: false, message: '缺少项目目标，已取消' }

        const core = await loadCore()
        const record = await core.createProject(root, { slug, goal })
        const rel = `projects/${record.slug}`
        currentProject.set(agentId, rel)
        try {
          await rebuild(root, agentId, run?.signal)
        } catch (err) {
          await warn(`项目已创建但索引重建失败：${err?.message ?? err}`)
        }
        return { ok: true, path: rel, message: `已创建 ${rel}/；请把文件写到 ${rel}/artifacts/ 下` }
      },
    }))
  }


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
        const kind = classifyPath(root, path.join(root, entry.name), options.rootAllowlist).kind
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
    const result = await core.scanWorkspace(root, { legacyRootScan: options.legacyRootScan, rootAllowlist: options.rootAllowlist })
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
    try {
      if (!existsSync(path.join(root, DONE_INDEX_FILE))) await core.writeDoneIndex(root)
    } catch (err) {
      await warn(`PROJECTS-DONE.md 生成失败：${err?.message ?? err}`)
    }
    clearDirtyState(root)
    summaries.set(agentId, core.renderSummary(result.projects, options.maxSummaryBytes, {
      currentProject: currentProject.get(agentId),
      strays: collectStrayPaths(result),
    }))
    summaryRoots.set(agentId, root)
  }

  /** 只刷新摘要，不写索引。 */
  async function refreshSummary(agentId, root) {
    const core = await loadCore()
    const result = await core.scanWorkspace(root, { legacyRootScan: options.legacyRootScan, rootAllowlist: options.rootAllowlist })
    summaries.set(agentId, core.renderSummary(result.projects, options.maxSummaryBytes, {
      currentProject: currentProject.get(agentId),
      strays: collectStrayPaths(result),
    }))
    summaryRoots.set(agentId, root)
  }

  /** 把根目录散落项整理成摘要用的短路径列表。 */
  function collectStrayPaths(result) {
    const warnings = Array.isArray(result?.warnings) ? result.warnings : []
    return warnings
      .map((warning) => (typeof warning?.path === 'string' ? warning.path.replace(/\\/g, '/') : ''))
      .filter((item) => item !== '')
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

  /** 每个 root 只维护一次 AGENTS.md；失败只警告一次。 */
  async function ensureAgentsOnce(root) {
    if (!options.manageAgentsFile) return
    const key = normalizeKey(root)
    if (agentsManaged.has(key)) return
    agentsManaged.add(key)
    try {
      await ensureAgentsSection(root)
    } catch (err) {
      await warn(`AGENTS.md 维护失败：${err?.message ?? err}`)
    }
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
      await ensureAgentsOnce(root)
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

  /** agent/turn-stopping：模型请求结束后扫描根目录散落项，必要时重建索引。 */
  async function onTurnStopping(payload, next) {
    const agent = payload?.agent
    const agentId = agent?.id
    try {
      if (typeof agentId === 'string' && scanPending.has(agentId) && !payload?.signal?.aborted) {
        const root = resolveRoot(agent)
        if (root !== undefined) {
          const strays = await listRootStrays(root, { rootAllowlist: options.rootAllowlist })
          if (strays.length > 0) {
            markDirty(root)
            await beforeStep(agent, payload?.signal)
          }
        }
      }
    } catch (err) {
      await warn(`turn-stopping 扫描失败：${err?.message ?? err}`)
    } finally {
      if (typeof agentId === 'string') scanPending.delete(agentId)
    }
    return typeof next === 'function' ? next() : undefined
  }

  /** 统一命令错误返回。 */
  function toErrorResult(err) {
    const code = typeof err?.code === 'string' ? err.code : 'UNKNOWN'
    return { kind: 'error', text: `错误（${code}）：${err?.message ?? String(err)}` }
  }

  function usageError(message) {
    return { kind: 'error', text: `错误（USAGE）：${message}` }
  }

  /** /project-init：slug + 目标 → 建目录与 README，并重建索引；参数不全时追问。 */
  async function commandInit(invocation) {
    try {
      const raw = String(invocation?.rawInput ?? '').trim()
      const root = resolveRoot(invocation?.agent)
      if (root === undefined) return usageError('无法定位工作区：当前目录向上找不到 PROJECTS.md 或 projects/')
      let [slug, ...rest] = raw.split(/\s+/).filter(Boolean)
      let goal = rest.join(' ')
      if ((slug === undefined || goal === '') && options.interactiveInit) {
        if (slug === undefined) {
          const answers = await askBlocking(invocation?.agent, [{
            id: 'slug',
            question: '新项目的短名是什么？（小写英文与连字符，例如 demo）',
            header: '项目名',
            options: [{ label: 'demo' }, { label: 'notes' }],
          }], invocation?.signal)
          slug = answerText(answers, 'slug') ?? ''
        }
        if (goal === '') {
          const answers = await askBlocking(invocation?.agent, [{
            id: 'goal',
            question: '这个项目要解决什么？用一句话描述。',
            header: '项目目标',
          }], invocation?.signal)
          goal = answerText(answers, 'goal') ?? ''
        }
      }
      if (slug === undefined || slug === '') return usageError('用法：/project-init <slug> <目标>')
      if (goal === '') return usageError('用法：/project-init <slug> <目标>')
      const core = await loadCore()
      const record = await core.createProject(root, { slug, goal })
      currentProject.set(invocation.agent.id, `projects/${record.slug}`)
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
      const result = await core.scanWorkspace(root, { legacyRootScan: options.legacyRootScan, rootAllowlist: options.rootAllowlist })
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
      try {
        await core.writeDoneIndex(root)
      } catch (err) {
        await warn(`已归档，但 PROJECTS-DONE.md 重建失败：${err.message}`)
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
      try {
        if (!existsSync(path.join(result.root, DONE_INDEX_FILE))) await core.writeDoneIndex(result.root)
      } catch (err) {
        await warn(`PROJECTS-DONE.md 生成失败：${err?.message ?? err}`)
      }
      await ensureAgentsOnce(result.root)
      const created = result.created.length > 0 ? result.created.join('，') : '已存在，无需创建'
      const agentsNote = options.manageAgentsFile ? '\nAGENTS.md 约束块已维护' : ''
      return { kind: 'success', text: `工作区已就绪：${result.root}\n创建：${created}${agentsNote}` }
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

  /** 注册 4 个事件与 4 个命令（index.js 与测试共用）。 */
  function register(hostCtx) {
    const target = hostCtx ?? ctx
    safeEffect(target, () => target.on('tools/result', (exec) => observeToolResult(exec)))
    safeEffect(target, () => target.on('tools/pre-execute', (exec, next) => onPreExecute(exec, next)))
    safeEffect(target, () => target.on('agent/created', (payload) => attachAgent(payload?.agent ?? payload)))
    safeEffect(target, () => target.on('agent/pre-step', async (payload, next) => {
      try {
        await beforeStep(payload?.agent, payload?.signal)
      } catch {
        // beforeStep 自身不抛，这里再兜一层。
      }
      return typeof next === 'function' ? next() : undefined
    }))
    safeEffect(target, () => target.on('agent/turn-stopping', (payload, next) => onTurnStopping(payload, next)))
    safeEffect(target, () => target.commands.register(commands.init))
    safeEffect(target, () => target.commands.register(commands.check))
    safeEffect(target, () => target.commands.register(commands.archive))
    safeEffect(target, () => target.commands.register(commands.initWorkspace))
    registerProjectCreateTool(target)
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
    scanPending.clear()
    agentsManaged.clear()
    currentProject.clear()
    denyAttempts.clear()
    allowOnce.clear()
    allowRootOnce.clear()
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
