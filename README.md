# dsh-workspace-normalizer

让工作区的项目结构始终可检查：索引自动维护、README 必填项可校验、归档有入口、往根目录乱放文件会被挡。

## 安装

面向 DSH 0.2.x（兼容范围见 `package.json` 的 `dsh.compatibility.runtime`）。

在 DSH 的插件管理里安装，安装目标填包名：

    dsh-workspace-normalizer

插件以 `workspace-guard` 这个 id 出现在插件列表里。**装完不会自动初始化任何目录**，需要手动执行一次初始化命令。

### 首次使用

把会话工作目录切到目标文件夹，在 DSH 对话框输入：

    /project-init-workspace

它只作用于当前会话目录，不向上查找。执行后生成：

    PROJECTS.md      # 项目索引，由插件自动维护
    projects/        # 所有项目的容器
    PROJECTS-DONE.md          # 已归档项目入口
    AGENTS.md        # 工作区约定块

## 用法

四个命令都在 **DSH 对话框**里输入，以 `/` 开头，不是在终端执行。

### 新建项目

    /project-init <slug> <目标>

例：`/project-init demo 验证插件是否可用`。日期自动加在前面，目录是 `projects/YYYYMMDD-demo/`，同时写入 README 骨架。参数不全时会弹选择题补齐。

### 校验项目

    /project-check

只读不写：检查 `目标` 是否为空或仍是 `<...>` 占位、`状态` 是否合法。

### 归档项目

    /project-archive <slug>

前提是把该项目 README 的 `状态` 改成 `done`。归档后移到 `archive/YYYY/`，同步更新 `PROJECTS.md` 与 `PROJECTS-DONE.md`；插件不自动改状态、不提交、不推送。

### 写入拦截

模型用 `write` 往工作区根目录写新文件时会被拒绝，返回原因里带有当前项目和正确目录。覆盖已有文件、写项目内、写工作区外都不受影响。

被拒后模型可以调用 `project_create` 工具，用选择题确认：

| 选择 | 结果 |
|---|---|
| 新建项目 | 创建 `projects/<slug>/` 并把新路径返回给模型 |
| 归入已有项目 | 让模型改到该项目下重试 |
| 放行到根目录 | 本次允许写入根目录，只生效一次 |

超时（默认 30 秒）按取消处理；同一路径连续被拒 `maxDenyPerPath`（默认 3）次后自动放行一次。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后不监听事件、不注册命令。 |
| `autoCreateReadme` | `false` | 发现项目缺 README 时补骨架，只写骨架。 |
| `legacyRootScan` | `true` | 过渡期额外扫描根目录 `YYYYMMDD-*`；迁移完成后关闭。 |
| `maxSummaryBytes` | `4000` | 注入摘要的 UTF-8 字节上限（256–16384）。 |
| `corePath` | `""` | 覆盖包内 core 路径；留空使用包内实现。 |
| `indexFileName` | `"PROJECTS.md"` | 索引文件名。 |
| `manageAgentsFile` | `true` | 按工作区维护 `AGENTS.md` 约定块。 |
| `rootAllowlist` | `[]` | 根目录允许长期存在的额外文件/目录名（大小写敏感）。 |
| `enforceRootWrites` | `true` | 拦截根目录新建文件；关闭后退回「只警告」。 |
| `interactiveInit` | `true` | `project_create` 用选择题确认归属。 |
| `askTimeoutMs` | `30000` | 选择题等待回答的毫秒数。 |
| `maxDenyPerPath` | `3` | 同一路径连续被拒上限，超过后放行一次。 |

配置写在 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/<profile>/cordis.patch.yml`）里 `- id: workspace-guard` 的 `config` 下，或在设置页的插件配置里改。

内置白名单有 10 项：`PROJECTS.md`、`AGENTS.md`、`AGENTS.local.md`、`CLAUDE.md`、`PROJECTS-DONE.md`、`projects`、`tools`、`archive`、`.git`、`WORKFLOW.md`（最后一项仅兼容旧文件）。它们写在 `core/root-policy.mjs`，命中即不算散落项。

## 根目录约定

```
PROJECTS.md      # 活跃项目索引
PROJECTS-DONE.md          # 已归档项目入口
AGENTS.md        # 工作区约定块
projects/        # 所有项目
tools/           # 跨项目工具
archive/YYYY/    # 已归档项目
```

插件在这里只写 `PROJECTS.md`、`PROJECTS-DONE.md`、`AGENTS.md` 与项目 README，不写别的。

## 常见问题

**`npm publish` 报 403 `Two-factor authentication ... required`**：账号开了 2FA。要么用 granular access token 并勾选 *Bypass two-factor authentication*，要么用 TOTP 的 `--otp`。Windows Hello 这类安全密钥在命令行里没有 6 位码，只能走 token。

**命令报「无法定位工作区」**：当前目录向上既没有 `PROJECTS.md`，也没有含 `YYYYMMDD-*` 项目的 `projects/`。先 `cd` 到工作区根，或执行 `/project-init-workspace`。

**加了 `rootAllowlist` 还是被警告**：条目区分大小写且只去首尾空白；`archive`、`projects`、`tools` 等已在内置白名单里，不用重复配置。

**为什么 bash 写根目录没被拦**：拦截只作用于 `write` 类工具；`mv`、`cp`、`> file` 走进程，插件看不到，只能靠事后扫描在索引「待处理」里发现。

**摘要是什么**：每个模型请求前注入的项目清单，含当前项目与根目录未归类条目，上限 `maxSummaryBytes`。

## 数据目录

```
~/.dsh/workspace-guard/
├─ state.json              # 每个工作区的 dirty 状态与最近构建时间
├─ effective-config.json   # 当前生效配置
└─ logs/YYYY-MM-DD.log     # 警告与失败记录
```

工作区里只写索引、`PROJECTS-DONE.md`、`AGENTS.md` 与项目 README。

## 已知边界

- 不自动改状态、不自动归档、不自动删除 `tmp/`。
- 不修改 README 正文；`autoCreateReadme` 开启时也只补骨架。
- 不提交、不推送 git 变更。
- 不调用模型：所有判断都是纯规则。
