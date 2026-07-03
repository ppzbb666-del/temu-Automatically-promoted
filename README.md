# 店小秘主控的 Temu AI 自动上品系统

> 把 1688 / 采集箱 / 手动录入的候选商品交给 AI 编排，再用 Playwright 驱动浏览器在店小秘里完成选品编辑、媒体处理、提交核价。
> 当前写天花板 = **店小秘提交进入 Temu 核价**；Temu 侧的核价确认与最终上架是仅存的两项允许保留的人工步骤。

## 当前状态（2026-06-30 基线已核对）

已不是"最小闭环原型"。系统以"**无人值守主流程**"为唯一默认入口：队列守护进程按真实店小秘会话、选择器校准、目标表面识别、媒体处理、发布校验这一系列硬门控，自动把候选商品推进到店小秘提交。

- **AI 编排仍为 mock**（见 `packages/shared/src/mock.ts`），生产路径的所有硬门控、修复链、KPI 路由都是真实的 —— 接入大模型是下一阶段独立工作
- **店小秘端**：采集、编辑、媒体工具（图像翻译/批量改尺寸/白底/图片编辑）、保存草稿、提交核价，已端到端跑通
- **Temu 端**：核价确认、最终上架是允许保留的人工步骤，不在自动化范围
- **控制台默认每日视图**精简为"状态 / 告警 / 动作"三组；修复、选择器、替换候选、原始自动化控制全部收入"高级区"
- **产品规则与 KPI 定义**见 `docs/operating-principles.md` —— 任何对默认主路径的修改必须先读懂它

## 仓库形态

npm workspaces monorepo，5 个子包 + 共享 + 文档：

```
apps/dashboard     React + Vite 控制台（默认简化"无人值守主流程"界面）
apps/server        Fastify 编排服务（端口 8787，AI mock 规划 + 自动化执行网关）
apps/extension     Chrome/Edge MV3 插件（注入店小秘/Temu 页面）
apps/automation    Playwright 浏览器自动化（dry-run / fill / save / submit / media）
packages/shared    共享类型、AI mock、核价规则
docs/              规划与运行手册
```

## 默认主路径：无人值守主流程

`queue-run` → `full-flow`（dry-run → fill-draft → `unattended-apply` 媒体 → save-draft → submit-listing）。控制台日间模式默认参数：

- `mediaAutomationMode = unattended-apply`
- 启用媒体工具：image translation / batch resize（`white-background`、`image-editor` 只在高级区按需启用）
- `submitAfterSave = true`（保存后点店小秘"提交核价"）
- 真实店小秘校准时效 ≤ 24h（`REAL_DIANXIAOMI_CALIBRATION_STALE_MINUTES`，范围 30min~7d）
- 试验闸门：`limit=3` 试跑必须至少跑过 1 个 ready 商品、所有 full-flow 成功，才解锁"开始无人值守"

## 能力清单

| 类别 | 默认主路径 | 高级区 |
|------|-----------|--------|
| 队列与守护进程 | 自动启停、健康告警、试跑闸门 | 队列审计、tick 历史、failure 分类详情 |
| 自动化执行 | full-flow 一键链式 | dry-run / fill-draft / save-draft / submit-listing 单独 |
| 媒体处理 | unattended-apply（首页默认 `image-translation` + `batch-resize`） | plan-only / 单工具 / 反馈逐次验证 |
| 故障恢复 | 失败 → 自动 retry / browser-recovery / manual-budget 三路路由 | repair-preview / repair-apply / recovery-run / 替换候选 |
| 选择器 | 默认采用最近一次真实校准 | 选择器工作台、版本回滚、media tool actions 配置 |
| 任务文件 | 任务文件导出历史（隐藏 blocked） | 任务文件 diff、blocked 列表、导入 |
| 核验 | 目标表面、登录态、媒体反馈、发布结果自动验证 | 逐次 step 报告、失败原因解析、字段级修复动作 |

## 快速开始

完整开发命令、API 速查、环境变量、文档索引见 [CLAUDE.md](CLAUDE.md)。常用三条：

```bash
npm install
npm run dev:server      # http://localhost:8787
npm run dev:dashboard   # http://localhost:5173
```

加载已解压扩展程序时指向 `apps/extension/dist`（先 `npm run build --workspace @temu-ai-ops/extension`）。

## 关键文档

按"先读这个 → 出问题再翻"排序（完整 25 份索引见 [CLAUDE.md §7](CLAUDE.md)）：

- [docs/operating-principles.md](docs/operating-principles.md) — 产品规则与 KPI 定义，**改默认主路径前必读**
- [docs/roadmap-to-production.md](docs/roadmap-to-production.md) — 生产路径 roadmap
- [docs/real-dianxiaomi-calibration-runbook.md](docs/real-dianxiaomi-calibration-runbook.md) — 真实店小秘校准手册
- [docs/limit-3-trial-acceptance.md](docs/limit-3-trial-acceptance.md) — `limit=3` 真实试跑验收清单
- [docs/dianxiaomi-session-health-runbook.md](docs/dianxiaomi-session-health-runbook.md) — 会话过期 / CAPTCHA 处置
- [docs/recovery-run.md](docs/recovery-run.md) — 故障恢复批跑
- [docs/current-status.md](docs/current-status.md) — 最近改了什么（流水账）

## 接下来

- 把 AI mock 编排替换为真实大模型（候选商品 → 标题/卖点/选品策略）
- 选择器自愈：失败告警 → 自动重新校准 → 自动应用新选择器
- 替换候选项证明 ledger：自动方案通过"少点击 / 少判断"证明后晋升默认

## 仓库信息

- **Git**：已初始化，当前默认分支 `master`
- **行尾**：`.gitattributes` 锁 LF（`core.autocrlf=true` 在 Windows 工作树保留 CRLF，仓库内强制 LF）
- **远端**：已配置 `origin` → `https://github.com/ppzbb666-del/Auto_goods.git`
- **CI / pre-commit hook**：未配置
