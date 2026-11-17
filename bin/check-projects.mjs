#!/usr/bin/env node
/**
 * 校验 CLI：--root <dir> [--json]
 * 只扫描与校验，不写任何文件；有 error 时退出 1，否则退出 0。
 */

import { scanWorkspace, WorkspaceError } from '../core/workspace-core.mjs'

const USAGE = `用法：node bin/check-projects.mjs --root <dir> [--json]

  --root <dir>   工作区根目录（必须）
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
  const booleans = new Set(['json', 'help'])
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
 * @returns {{path: string, message: string, severity: string, line?: number}[]}
 */
function collectIssues(result) {
  const issues = []
  for (const project of result.projects) {
    for (const issue of project.issues ?? []) {
      issues.push({ ...issue, path: `${project.relPath}/` })
    }
  }
  for (const warning of result.warnings ?? []) {
    issues.push({ ...warning, path: warning.path ?? '' })
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
  const errors = issues.filter((issue) => issue.severity === 'error')
  const warnings = issues.filter((issue) => issue.severity === 'warning')

  if (options.json === true) {
    console.log(
      JSON.stringify(
        {
          root: result.root,
          projectCount: result.projects.length,
          errorCount: errors.length,
          warningCount: warnings.length,
          ok: errors.length === 0,
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
  } else {
    console.log(`检查完毕：${result.projects.length} 个项目，${errors.length} 个问题`)
    for (const issue of errors) {
      const location = issue.line === undefined ? '' : `（README.md:${issue.line}）`
      console.log(`- ${issue.path}：${issue.message}${location}`)
    }
    if (warnings.length > 0) {
      console.log(`格式警告 ${warnings.length} 条（不改变退出码）：`)
      for (const issue of warnings) console.log(`- ${issue.path}：${issue.message}`)
    }
  }

  process.exitCode = errors.length > 0 ? 1 : 0
}

main().catch((err) => {
  if (err instanceof WorkspaceError) console.error(`错误（${err.code}）：${err.message}`)
  else console.error(`错误：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
