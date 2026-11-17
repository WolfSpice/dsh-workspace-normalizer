# dsh-workspace-normalizer

把目录规范插件：让「项目有 README、索引不过期、done 项目能归档」不再依赖人的自觉。

## 安装

面向 DSH 0.2.x，兼容范围写在 `package.json` 的 `dsh.compatibility.runtime`（`>=0.2.0-rc.1 <0.3.0-0`）。

### 从 npm 安装

在 DSH 的插件管理里安装，安装目标填包名：

    dsh-workspace-normalizer

插件以 `workspace-guard` 这个 id 出现在插件列表里；默认配置不写任何 `rootAllowlist`，安装完不会假设你的根目录长什么样。

### 本地开发

    pnpm install
    pnpm test

把仓库目录作为 `link:` 依赖装进 profile，改动在重新安装插件后生效。

### 首次使用

在工作区根目录执行 `/project-init-workspace`，建立 `projects/` 与 `PROJECTS.md`；之后新项目用 `/project-init <slug>`，随时用 `/project-check` 校验、`/project-archive` 归档。

### 配置

写在 profile 的 `cordis.patch.yml` 里（`~/.dsh/profiles/<profile>/cordis.patch.yml`），也可以在设置页的插件配置里改。字段见下文「配置项」。

### 命令行

包内附带三个 CLI，可选择全局安装或 `npx` 调用：`ws-new-project`、`ws-index`、`ws-check`。

## 做什么

- **新建项目**：按模板创建 `projects/YYYYMMDD-slug/` 与 README 骨架。
- **重建索引**：扫描 `projects/`（过渡期也扫描根目录遗留项目），生成 `PROJECTS.md`。
- **必填校验**：`目标` 缺失、为空或仍是 `<...>` 占位即报告；`状态` 非法也报告；可选字段只解析不检查。
- **摘要注入**：把活跃项目摘要作为运行时上下文注入每个 agent，最多 4000 字节。
- **归档**：状态为 `done` 的项目移入 `archive/YYYY/`；独立 git 仓库整体移动，父仓库内的项目用 `git mv` 暂存重命名。
- **根目录巡检**：模型请求结束后扫描根目录散落项，发现后重建索引并在「待处理」警告。
- **AGENTS.md 维护**：按工作区创建或更新受管约束块（`manageAgentsFile`）。

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
| `manageAgentsFile` | `true` | 按工作区维护 `AGENTS.md` 约定块；关闭后不创建、不更新。 |
| `rootAllowlist` | `[]` | 根目录允许长期存在的额外文件/目录名（大小写敏感），只影响散落判定，不参与项目扫描；CLI 通过生效配置读取。 |

`rootAllowlist` 用于「根目录里但暂时不便移动」的内容：命中的文件/目录不算散落项，不会进入索引警告，也不会触发 turn-stopping 重建；`projects/` 内的项目识别与扫描不受影响。条目会去空白、按大小写敏感精确匹配。

## 白名单位置与默认值

1. 内置白名单有 9 项：`PROJECTS.md`、`AGENTS.md`、`AGENTS.local.md`、`CLAUDE.md`、`projects`、`tools`、`archive`、`.git`、`WORKFLOW.md`（最后一项仅兼容旧文件）。它们写在 [`core/root-policy.mjs`](core/root-policy.mjs)。
2. 额外白名单是插件配置 `rootAllowlist`，位于 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/<profile>/cordis.patch.yml`）中 `- id: workspace-guard` 的 `config` 下，或通过 Settings 的插件配置页修改。
3. 仓库默认是空数组，不包含任何用户环境名；仓库的 `cordis.patch.yml` 不写 `rootAllowlist`。
4. 配置示例：

```yaml
- insert:
    - id: workspace-guard
      name: 'dsh-workspace-normalizer'
      config:
        autoCreateReadme: false
        maxSummaryBytes: 4000
        legacyRootScan: true
        rootAllowlist:
          - legacy-data
          - scratch
          - .dsh
```

`legacy-data`、`scratch`、`.dsh` 这类不在内置集合中的名字需要显式加入，否则会被当作根目录散落项；`archive`、`projects`、`tools`、`AGENTS.md` 等是内置项，无需配置。

## 命令

| 命令 | 输入 | 行为 |
|---|---|---|
| `/project-init` | `slug 目标...` | 创建项目目录与 README，重建索引。 |
| `/project-check` | 无 | 只校验，不写文件；有问题时返回错误文本。 |
| `/project-archive` | `slug` | 校验 `done` → 按 VCS 形态移动 → 重建索引；不提交、不推送。 |
| `/project-init-workspace` | 无 | 在当前目录建立 `projects/` 与 `PROJECTS.md`，并维护 `AGENTS.md`。 |

## CLI（插件未安装时）

三个脚本独立运行，行为与插件一致：

```bash
node bin/new-project.mjs --root <工作区> --slug demo --goal "验证插件" [--date YYYYMMDD]
node bin/workspace-index.mjs --root <工作区> [--check] [--json]
node bin/check-projects.mjs --root <工作区> [--json]
```

`workspace-index.mjs --check` 与 `check-projects.mjs` 只校验不写，退出码 0/1；`new-project.mjs` 参数错误退出 2。

CLI 启动时读取 `~/.dsh/workspace-guard/effective-config.json`（由插件写入，含 `rootAllowlist`、`indexFileName`、`legacyRootScan` 等），因此与插件行为一致；没有该文件时使用默认值。用 `--config-dir <dir>` 指定其他数据目录。

## 数据目录

```text
~/.dsh/workspace-guard/
├─ state.json              # dirty / lastBuildAt / lastError，按工作区根分区，原子写
├─ effective-config.json   # 插件写入的生效配置，CLI 读取
└─ logs/                   # 按天追加，单条 ≤ 2 KiB
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
├─ AGENTS.md              # 工作区约定，由插件维护标记块
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
- 根目录只保留这些固定项。
- 服务目录（运行中服务自己的数据目录）不参与项目结构；如需长期保留在根目录，请加入 `rootAllowlist`。

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

## AGENTS.md 自动维护

`manageAgentsFile`（默认 `true`）开启时，插件在首次解析到某个工作区根、以及执行 `/project-init-workspace` 时维护根目录的 `AGENTS.md`：

- 没有 `AGENTS.md`：创建文件并写入受管约定块；
- 有文件但没有标记：在末尾追加约定块，保留原有内容；
- 已有 `<!-- workspace-guard:begin -->` / `<!-- workspace-guard:end -->`：原地替换标记块，块外原文不变；
- 块内容完全一致时不写盘。

约定块示例：

```md
<!-- workspace-guard:begin -->
## 工作区约定（由 dsh-workspace-normalizer 维护，请勿手改本块）

- 所有产出落在 `projects/<YYYYMMDD-slug>/` 下。
- 工作区根目录由 `AGENTS.md`、`PROJECTS.md`、`projects/`、`tools/`、`archive/` 与服务目录组成。
- 新文件放入对应项目的 `artifacts/`、`scripts/` 或 `tmp/`。
<!-- workspace-guard:end -->
```

约定块使用肯定句与通用规则，不硬编码具体项目路径；不要手改标记块内内容，块外可以自由编辑。

## 已知盲区

- 通过 bash 重定向、外部进程写入的文件不经过 `tools/result`；项目目录内的写入靠写类工具标记 dirty，根目录散落项在 `agent/turn-stopping` 后置扫描时发现。
- README 解析只认半角冒号的 `- 字段: 值`；中文冒号只产生格式警告，不改变解析结果。
- 索引与 README 允许滞后；`PROJECTS.md` 是派生值，状态以 README 为准。
- 归档是显式命令，不做后台巡检；移动失败会回滚，但已提交的历史只能由人处理。

## 与工作区约定的关系

工作区约束由 `AGENTS.md` 的受管块承载（`manageAgentsFile` 维护），索引由 `PROJECTS.md` 派生；插件不依赖工作区里任何特定说明文件，也不需要额外保留编辑说明。
