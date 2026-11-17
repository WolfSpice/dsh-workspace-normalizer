#!/usr/bin/env node
/**
 * 索引 CLI：--root <dir> [--check] [--json]
 * 默认扫描并重建 PROJECTS.md（退出 0）；--check 只校验不写（退出 0/1）。
 */

import {
  renderProjectsIndex,
  scanWorkspace,
  writeIndex,
  WorkspaceError,
} from '../core/workspace-core.mjs'

const USAGE = `用法：node bin/workspace-index.mjs --root <dir> [--check] [--json]

  --root <dir>   工作区根目录（必须）
  --check        只校验，不写 PROJECTS.md；有 error 时退出 1
  --json         以 JSON 输出结果
  -h, --help     显示帮助`

class UsageError extends Error {}

/**
 * 解析参数：--key value / --key=value，布尔开关。
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
  const options = {}
  const booleans = new Set(['check', 'json', 'help'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') return { help: true }
    if (!token.startsWith('--')) throw new UsageError(`无法识别的参数：${token}`)
    const equal = token.indexOf('=')
    const key = equal >= 0 ? token.slice(2, equal) : token.slice(2)
    if (booleans.has(key)) {
      if (equal >= 0) throw new UsageError(`参数 --${key} 不接受值`)
      options[key] = true
      continue
    }
    if (key !== 'root') throw new UsageError(`未知参数：--${key}`)
    const value = equal >= 0 ? token.slice(equal + 1) : argv[++index]
    if (value === undefined || value === '') throw new UsageError('参数 --root 缺少值')
    options.root = value
  }
  return options
}

/**
 * 汇总项目 issues 与全局 warnings。
 * @param {{projects: object[], warnings: object[]}} result
 * @returns {{path: string, message: string, severity: string}[]}
 */
function collectIssues(result) {
  const issues = []
  for (const project of result.projects) {
    for (const issue of project.issues ?? []) {
      issues.push({ path: `${project.relPath}/`, message: issue.message, severity: issue.severity })
    }
  }
  for (const warning of result.warnings ?? []) {
    issues.push({ path: warning.path ?? '', message: warning.message, severity: warning.severity })
  }
  return issues
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`参数错误：${err.message}`)
      console.error(USAGE)
      process.exitCode = 2
      return
    }
    throw err
  }

  if (options.help === true) {
    console.log(USAGE)
    return
  }
  if (typeof options.root !== 'string' || options.root === '') {
    console.error('参数错误：缺少 --root')
    console.error(USAGE)
    process.exitCode = 2
    return
  }

  const result = await scanWorkspace(options.root)
  const issues = collectIssues(result)
  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  const warningCount = issues.length - errorCount
  const checkOnly = options.check === true

  let written = null
  if (!checkOnly) {
    const text = renderProjectsIndex(result)
    written = await writeIndex(options.root, text)
  }

  if (options.json === true) {
    console.log(
      JSON.stringify(
        {
          root: result.root,
          projectCount: result.projects.length,
          issueCount: issues.length,
          errorCount,
          warningCount,
          written: written !== null,
          index: written?.path ?? null,
          projects: result.projects.map((project) => ({
            slug: project.slug,
            path: `${project.relPath}/`,
            legacyRoot: project.legacyRoot,
            status: project.fields.status ?? 'unknown',
            goal: project.fields.goal ?? null,
            issues: project.issues,
          })),
          warnings: result.warnings,
        },
        null,
        2,
      ),
    )
  } else if (checkOnly) {
    console.log(`检查完毕：${result.projects.length} 个项目，${errorCount} 个问题`)
    for (const issue of issues) console.log(`- ${issue.path === '' ? '' : `${issue.path}：`}${issue.message}`)
    if (warningCount > 0) console.log(`（另有 ${warningCount} 条格式警告，不影响退出码）`)
  } else {
    console.log(`索引已重建：${written.path}（${written.bytes} 字节）`)
    console.log(`项目 ${result.projects.length} 个，问题 ${errorCount} 个，警告 ${warningCount} 条`)
    for (const issue of issues) console.log(`- ${issue.path === '' ? '' : `${issue.path}：`}${issue.message}`)
  }

  if (checkOnly) process.exitCode = errorCount > 0 ? 1 : 0
}

main().catch((err) => {
  if (err instanceof WorkspaceError) console.error(`错误（${err.code}）：${err.message}`)
  else console.error(`错误：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
