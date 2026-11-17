/**
 * 生效配置：插件把影响扫描/索引的配置落盘，CLI 读取同一份，保证行为一致。
 *
 * 只序列化 rootAllowlist / indexFileName / legacyRootScan / autoCreateReadme /
 * maxSummaryBytes；读取失败或字段类型不符时回退到默认值，不抛异常。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh', 'workspace-guard')
const CONFIG_FILE = 'effective-config.json'
const DEFAULT_INDEX = 'PROJECTS.md'
const DEFAULT_MAX_SUMMARY = 4000

/**
 * 生效配置文件路径。
 * @param {string} [dataDir] 默认 `~/.dsh/workspace-guard`。
 * @returns {string}
 */
export function effectiveConfigPath(dataDir) {
  const base = typeof dataDir === 'string' && dataDir.trim() !== '' ? dataDir : DEFAULT_DATA_DIR
  return path.join(path.resolve(base), CONFIG_FILE)
}

/**
 * 默认生效配置（与 index.js Config 默认值一致）。
 * @returns {{rootAllowlist: string[], indexFileName: string, legacyRootScan: boolean, autoCreateReadme: boolean, maxSummaryBytes: number}}
 */
export function defaultEffectiveConfig() {
  return {
    rootAllowlist: [],
    indexFileName: DEFAULT_INDEX,
    legacyRootScan: true,
    autoCreateReadme: false,
    maxSummaryBytes: DEFAULT_MAX_SUMMARY,
  }
}

/**
 * 索引文件名只允许单段，拒绝路径分隔符与点开头；非法时回退默认。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeIndexName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name) || name.startsWith('.')) {
    return DEFAULT_INDEX
  }
  return name
}

/**
 * 类型校验并补默认值；rootAllowlist 保留原始大小写。
 * @param {unknown} value
 * @returns {object}
 */
function normalizeEffectiveConfig(value) {
  const defaults = defaultEffectiveConfig()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return defaults
  const rootAllowlist = Array.isArray(value.rootAllowlist)
    ? value.rootAllowlist
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item !== '')
    : defaults.rootAllowlist
  return {
    rootAllowlist,
    indexFileName: normalizeIndexName(value.indexFileName),
    legacyRootScan: typeof value.legacyRootScan === 'boolean' ? value.legacyRootScan : defaults.legacyRootScan,
    autoCreateReadme: typeof value.autoCreateReadme === 'boolean' ? value.autoCreateReadme : defaults.autoCreateReadme,
    maxSummaryBytes: Number.isFinite(value.maxSummaryBytes) && value.maxSummaryBytes > 0
      ? Math.floor(value.maxSummaryBytes)
      : defaults.maxSummaryBytes,
  }
}

/**
 * 读取生效配置；文件不存在、损坏或字段类型不符时返回默认值。
 * @param {{dataDir?: string}} [opts]
 * @returns {Promise<object>}
 */
export async function readEffectiveConfig(opts = {}) {
  try {
    const raw = await fs.readFile(effectiveConfigPath(opts?.dataDir), 'utf8')
    return normalizeEffectiveConfig(JSON.parse(raw))
  } catch {
    return defaultEffectiveConfig()
  }
}

/**
 * 原子写入生效配置；失败只返回 false，不抛异常。
 * @param {{dataDir?: string}} [opts]
 * @param {object} [values]
 * @returns {Promise<boolean>}
 */
export async function writeEffectiveConfig(opts = {}, values = {}) {
  let tmp
  try {
    const file = effectiveConfigPath(opts?.dataDir)
    const dir = path.dirname(file)
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      ...normalizeEffectiveConfig(values),
    }
    await fs.mkdir(dir, { recursive: true })
    tmp = path.join(
      dir,
      `.effective-config.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
    )
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await fs.rename(tmp, file)
    return true
  } catch {
    if (tmp !== undefined) await fs.rm(tmp, { force: true }).catch(() => {})
    return false
  }
}
