# dsh-workspace-normalizer

把目录规范插件：让「项目有 README、索引不过期、done 项目能归档」不再依赖人的自觉。

## 做什么

- **新建项目**：按模板创建 `projects/YYYYMMDD-slug/` 与 README 骨架。
- **重建索引**：扫描 `projects/`（过渡期也扫描根目录遗留项目），生成 `PROJECTS.md`。
- **必填校验**：`目标` 缺失、为空或仍是 `<...>` 占位即报告；`状态` 非法也报告；可选字段只解析不检查。
- **摘要注入**：把活跃项目摘要作为运行时上下文注入每个 agent，最多 4000 字节。
- **归档**：状态为 `done` 的项目移入 `archive/YYYY/`；独立 git 仓库整体移动，父仓库内的项目用 `git mv` 暂存重命名。

## 不做什么

- 不自动改状态（`active` / `paused` / `done` 只由人确认后修改）。
- 不自动归档、不自动删除 `tmp/`。
- 不修改 README 正文；`autoCreateReadme` 开启时也只补骨架。
- 不提交、不推送 git 变更；`parent` 归档只把重命名加入暂存区。
- 不在工作区创建插件数据目录，不做后台定时巡检。
- 不调用模型、不注册工具、不注册 Client UI。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后不监听事件、不注册命令。 |
| `autoCreateReadme` | `false` | `pre-step` 发现项目缺 README 时补骨架，只写骨架。 |
| `legacyRootScan` | `true` | 过渡期额外扫描根目录 `YYYYMMDD-*`；迁移完成后关闭。 |
| `maxSummaryBytes` | `4000` | 注入摘要的 UTF-8 字节上限（256–16384）。 |
| `corePath` | `""` | 覆盖包内 core 路径；留空使用包内实现。 |
| `indexFileName` | `"PROJECTS.md"` | 索引文件名。 |

## 命令

| 命令 | 输入 | 行为 |
|---|---|---|
| `/project-init` | `slug 目标...` | 创建项目目录与 README，重建索引。 |
| `/project-check` | 无 | 只校验，不写文件；有问题时返回错误文本。 |
| `/project-archive` | `slug` | 校验 `done` → 按 VCS 形态移动 → 重建索引；不提交、不推送。 |

## CLI（插件未安装时）

三个脚本独立运行，行为与插件一致：

```bash
node bin/new-project.mjs --root <工作区> --slug demo --goal "验证插件" [--date YYYYMMDD]
node bin/workspace-index.mjs --root <工作区> [--check] [--json]
node bin/check-projects.mjs --root <工作区> [--json]
```

`workspace-index.mjs --check` 与 `check-projects.mjs` 只校验不写，退出码 0/1；`new-project.mjs` 参数错误退出 2。

## 数据目录

```text
~/.dsh/workspace-guard/
├─ state.json     # dirty / lastBuildAt / lastError，按工作区根分区，原子写
└─ logs/          # 按天追加，单条 ≤ 2 KiB
```

工作区内只写 `PROJECTS.md` 与项目 README，不写 `.dsh/`。

## 根标记与同名风险

插件从会话 cwd 向上逐级检查，命中下面任一条才把该目录当作工作区根：

1. `PROJECTS.md` 存在；
2. `projects/` 是**目录**，且至少含一个 `YYYYMMDD-slug` 子目录。

**与锚点同名可能造成的 bug**：如果某个上层目录里恰好有叫 `projects` 的目录或文件，但它另有用途（放图片、放代码、或只是个同名文件），旧版本会误判为工作区根，并在那里创建 `PROJECTS.md`、改写索引，等于污染别人的目录。现在的防护：

- `projects` 是文件、空目录、或只放无关内容 → 不再判定为工作区根；
- 找不到根时只警告一次（写入 `~/.dsh/workspace-guard/logs/` 并 `logger.warn`），不会静默写文件；
- 全新工作区用 `/project-init-workspace` 显式初始化：它直接在当前目录创建 `projects/` 与 `PROJECTS.md`，不依赖自动发现。

**仍存在的歧义**：如果某个上层目录真的同时有 `PROJECTS.md` 和 `projects/YYYYMMDD-*`，插件会把它当工作区——这是设计上的固有歧义，只能靠不要在工作区内部嵌套同名锚点来避免。

## 理想的初始目录

在一个空目录执行 `/project-init-workspace` 后，工作区应长成下面这样（路径相对工作区根）：

```text
<工作区>/
├─ PROJECTS.md            # 由插件生成，不要手改
├─ projects/              # 所有项目
│  └─ YYYYMMDD-slug/      # 单个项目（用到才建）
│     ├─ README.md        # 项目说明书，必填「目标」
│     ├─ artifacts/       # 最终成果（按需）
│     ├─ scripts/         # 操作脚本（按需）
│     ├─ tests/           # 测试脚本（按需）
│     ├─ backups/         # 备份与回滚（按需）
│     └─ tmp/             # 过程文件（按需）
├─ tools/                 # 跨项目工具
└─ archive/               # done 项目，按年归档
   └─ YYYY/
```

要点：

- 刚初始化时只有 `PROJECTS.md` 与空的 `projects/`；`archive/`、`artifacts/`、`scripts/` 等**用到才建**，不预建空目录。
- 根目录只允许这些固定项；存档、一次性备份、环境导出直接进 Windows 回收站，不落盘。
- 服务目录（如 `astrbot-qq/`、`ollama/`）不参与这套结构，插件不扫描它们。

初始化后 `PROJECTS.md` 的内容（没有项目时没有表格）：

```md
# 项目索引

> 由 bin/workspace-index.mjs 生成，不要手改。
```

新建第一个项目（`/project-init demo 第一件事`）后：

```text
projects/20261118-demo/
└─ README.md
```

```md
# 20261118-demo

- 目标: 第一件事
- 状态: active

## 说明

自由文本。需要被解析的内容写成上面的 `- 字段: 值` 行，不要只写在这里。
```

索引随之出现「活跃项目（1）」表格；`目标` 缺失、为空或仍是 `<...>` 时进入「待处理」并标 `⚠`。

## 已知盲区

- 通过 bash 重定向、外部进程写入的文件不经过 `tools/result`，索引会滞后到下一次手工命令或写类工具命中。
- README 解析只认半角冒号的 `- 字段: 值`；中文冒号只产生格式警告，不改变解析结果。
- 索引与 README 允许滞后；`PROJECTS.md` 是派生值，状态以 README 为准。
- 归档是显式命令，不做后台巡检；移动失败会回滚，但已提交的历史只能由人处理。
