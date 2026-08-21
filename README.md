# manager-kanban

CloudCLI UI / claudecodeui 插件 —— 把 workbuddy vault 变成经理工作台。

未闭环承诺看板（我的置顶、团队按 owner 分组、逾期标红）、待回填、周会视图、客户档、Inbox 速记与归档。
**所有写入都是两步：先 diff 预览，确认才落盘。** vault 没有 git，这是唯一的保险。

## 安装

Settings → Plugins → 粘贴本仓库 URL → Install（宿主会自动 `npm install` + `npm run build`）。

手动：

```bash
git clone <this-repo> ~/.claude-code-ui/plugins/manager-kanban
cd ~/.claude-code-ui/plugins/manager-kanban
npm install && npm run build
```

## vault 路径

默认用宿主当前选中的 `project.path`。四项全命中才认作 vault：

- `memory/MEMORY.md`
- `publishers/`
- `team/people/`
- `inbox/`

不命中时插件会提示「这不像 workbuddy vault」并给一个手填路径的入口，手填值存在浏览器 `localStorage`（`manager-kanban:vault-path`），换设备要重填。清除后回落到当前项目。

## 解析规则

**承诺** 来自 `memory/MEMORY.md` 的 `- ⏳ [标题](plan.md) — 正文 → 目标路径` 行。
`## 未闭环承诺` 进主清单，`## 远期 / 无日期` 默认折叠。

- **owner** — 先看 `→ team/people/<name>/`，再看正文里的 `owner=X`，再看正文提到的人名（取自 `team/people/` 的目录名）；推不出归到「我」。
- **复核日** — 先取 `**加粗**` 里的日期，否则全句扫；支持 `2026-09-11`、`08-25`、`9/8`、`9 月 8 日`；多个取最早的未来日期，没有未来日期取最近的过去日期。
- **状态** — 正文含「卡在/等对方/权限/依赖」→ 卡外部；含「停滞/两周/零回音/窗口已过/hold」→ 停滞；否则进行。
- **客户/项目归属** — 从 `→` 后面的路径里取 `publishers/<slug>`、`projects/<slug>`、`team/people/<slug>`。

**客户** 来自 `publishers/<slug>/`：hub 文件（非 `Timeline.md` 的那个 `.md`）的一级标题作名字，`## 状态`／`## 关键人`／`## 产品` 三节的 bullet 作摘要，`Timeline.md` 的 `##` 块作事件流。

**周会** 取 `team/meetings/weekly/` 最新一份：`## A. 必查` 的 markdown 表转成必查卡，`## B. 按人过` 的 `### 人名` 块并到对应 owner 的周会块（`>` 引用作提醒），`## C. 团队级议题` 的编号条目进「议题」tab，可展开并标 owner。

**Inbox** 取今天的 `inbox/YYYY-MM-DD.md`，没有则取最新一份；行尾的 `→ 已归档:` 标记视为已处理。

## 写入动作

| 动作 | 落到哪 |
|---|---|
| 速记 | 追加一行到 `inbox/<today>.md` |
| 归档 | 目标文件插入一个 `##` 条目 + 在 inbox 那行下补 `→ 已归档:` |
| 回填结案 | 目标文件写结论/判据/下一步 + plan 文件补一行 + `MEMORY.md` 的 `⏳` 改 `✅` |
| 改复核日 | 改 `MEMORY.md` 那行的日期 + plan 文件补一行 |
| 标 owner | `MEMORY.md` 那行插 `**owner=X**` + plan 文件补一行 |

| 客户页写 Timeline | 在 `publishers/<slug>/Timeline.md` 顶部插一个 `##` 条目 |
| 标议题 owner | 作为一行速记追加到 `inbox/<today>.md` |

回填表单的复核日默认填今天 +7 天，可改。承诺 tab 顶部有一句「今日总览」，只说三件事：逾期数 + 最久那条的标题、今天到期数、谁那边有停滞。

所有写入 Timeline 的动作都按日期插到正确位置（Timeline 是倒序的，补旧条目也不会插错）。

「结案」= 结论写进目标文件、该行从未闭环清单消失；之后只在目标文件里查得到。

`MEMORY.md`（索引）和 `memory/plan-*.md`（单体）两边都写，保持一致。

## 目标文件选择

归档和回填都先弹一个选择面板：

1. **推荐** — 先取 `⏳` 行 `→` 后面已有的 `.md` 路径，再拿文本去匹配 `publishers/` 的 slug 与 hub 标题，最多 3 个。
2. **搜索** — 下面一个框，边打边筛全部客户的 Timeline。
3. **手填覆盖** — 直接打一个以 `.md` 结尾的相对路径，面板会把它当成候选。

## 结构

```
manifest.json
package.json
tsconfig.json
icon.svg
src/types.ts    插件 API 类型 + 领域类型
src/index.ts    前端：vanilla DOM，跟宿主主题（dark/light），顶部 chip 切视图，紧凑行点开才出操作
src/server.ts   后端子进程：markdown 解析 + /preview 与 /commit
```

## RPC

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/detect?path=` | 四项检测结果 |
| GET | `/data?path=` | 承诺、客户列表、人员、inbox |
| GET | `/client?path=&slug=` | 单个客户详情 |
| GET | `/weekly?path=` | 最新一份周会的 A/B/C 段 |
| POST | `/preview` | `{path, action}` → diff hunks（新增行 + 上下文两行） |
| POST | `/commit` | 同样的 `{path, action}`，落盘 |

## 已知边界

- 团队级议题（周会 C 段）已接。
- 助手对话不做 —— 插件规范禁止接入 Claude 聊天。
- 客户名没有别名表（CenturyGame / CG 这类叫法靠搜索框自己找）。
- 周会的 D（会议观察）和 E（我自己）两段暂未解析。
