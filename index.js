/**
 * workspace-guard Host 入口：薄装配。
 *
 * 这里只声明依赖、Config 与事件/命令注册；所有规则与运行时逻辑在
 * `lib/guard.mjs` 与 `core/workspace-core.mjs`，本文件不复制任何判定逻辑。
 * 不注册工具、不调用模型、不注册 Client 模块。
 */

import z from '@deepseek-ai/schemastery'
import { createGuard } from './lib/guard.mjs'

/** Host 服务依赖；缺任意一个时插件应保持 inactive。 */
export const inject = ['fs', 'sessions', 'workingDirectory', 'commands', 'systemPrompt', 'tools']

/** 插件配置（与 WORKFLOW.md 第 11 节及开发文档 6.2 对齐）。 */
export const Config = z.object({
  enabled: z.boolean().default(true)
    .description('总开关；关闭后不监听事件、不注册命令。'),
  autoCreateReadme: z.boolean().default(false)
    .description('agent/pre-step 发现项目缺 README 时补写骨架；只写骨架，不写正文。'),
  legacyRootScan: z.boolean().default(true)
    .description('过渡期额外扫描根目录 YYYYMMDD-*；迁移完成后应关闭。'),
  maxSummaryBytes: z.number().min(256).max(16384).default(4000)
    .description('注入摘要的 UTF-8 字节上限。'),
  corePath: z.string().default('')
    .description('可选：覆盖包内 core 的路径（调试或本地补丁用）；留空表示用包内实现。'),
  indexFileName: z.string().default('PROJECTS.md')
    .description('索引文件名。'),
})

/**
 * 装配插件。
 * @param {object} ctx Host 上下文。
 * @param {object} config 已校验的 Config。
 * @returns {void}
 */
export function apply(ctx, config) {
  try {
    if (config?.enabled === false) return
    const guard = createGuard(ctx, config ?? {})
    guard.register(ctx)
    ctx.effect(() => () => {
      void guard.dispose()
    })
  } catch (err) {
    // apply 不抛异常，避免插件加载失败拖垮会话。
    try {
      ctx.logger?.warn?.(`[workspace-guard] apply 失败：${err?.message ?? err}`)
    } catch {
      // logger 自身异常也忽略。
    }
  }
}
