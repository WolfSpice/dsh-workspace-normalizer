#!/usr/bin/env node
/**
 * 新建项目 CLI：--root <dir> --slug <slug> --goal <text> [--date YYYYMMDD]
 * 成功打印创建路径并退出 0；参数错误退出 2；运行时错误退出 1。
 */

import { createProject, WorkspaceError } from '../core/workspace-core.mjs'
import { readEffectiveConfig } from '../core/effective-config.mjs'

const USAGE = `用法：node bin/new-project.mjs --root <dir> --slug <slug> --goal <text> [--date YYYYMMDD] [--config-dir <dir>]

  --root <dir>        工作区根目录（必须）
  --slug <slug>       项目 slug；也可直接传完整 YYYYMMDD-slug
  --goal <text>       项目目标（必填，不能是 <...> 占位）
  --date YYYYMMDD     创建日期，默认今天
  --config-dir <dir>  生效配置目录，默认 ~/.dsh/workspace-guard
  -h, --help          显示帮助`

class UsageError extends Error {}

/**
 * 解析 `--key value` 与 `--key=value`。
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') return { help: true }
    if (!token.startsWith('--')) throw new UsageError(`无法识别的参数：${token}`)

    const equal = token.indexOf('=')
    const key = equal >= 0 ? token.slice(2, equal) : token.slice(2)
    const value = equal >= 0 ? token.slice(equal + 1) : argv[++index]
    if (value === undefined || value === '') throw new UsageError(`参数 --${key} 缺少值`)
    if (!['root', 'slug', 'goal', 'date', 'config-dir'].includes(key)) {
      throw new UsageError(`未知参数：--${key}`)
    }
    if (key === 'config-dir') options.configDir = value
    else options[key] = value
  }
  return options
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
  for (const key of ['root', 'slug', 'goal']) {
    if (typeof options[key] !== 'string' || options[key] === '') {
      console.error(`参数错误：缺少 --${key}`)
      console.error(USAGE)
      process.exitCode = 2
      return
    }
  }

  // 读取生效配置，保证与插件使用同一入口；创建项目本身不依赖扫描配置。
  await readEffectiveConfig({ dataDir: options.configDir })
  const record = await createProject(options.root, {
    slug: options.slug,
    goal: options.goal,
    date: typeof options.date === 'string' ? options.date : undefined,
  })
  console.log(record.dir)
}

main().catch((err) => {
  if (err instanceof WorkspaceError) console.error(`错误（${err.code}）：${err.message}`)
  else console.error(`错误：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
