# CLAUDE.md

> **多平台迁移说明（2026-07-12）**：仓库当前产品定位已经升级为多平台商品运营中台，但 Temu / 店小秘仍是唯一生产写链路。所有新平台必须经过 `PlatformCapabilityProfile.writeEnabled` 和服务端 `assertPlatformWriteEnabled`；当前 TikTok Shop、Shopee、Amazon 均禁止写入。不要因为控制台出现平台名称就认为适配器已经可用。

> 给未来打开这个仓库的 Claude / 协作者。读这一份就够开始动手；细节去 [`docs/`](docs/)。

## 1. 这是什么

**temu-ai-ops** —— 店小秘主控的 Temu 自动上品系统。把 1688 / 采集箱 / 手动录入的候选商品交给 AI 编排，再用 Playwright 驱动浏览器在店小秘里完成选品编辑、媒体处理、提交核价。**当前写天花板停在店小秘提交** —— Temu 侧核价确认、最终上架是唯一允许保留的人工步骤。

同时，项目已经新增多平台旁路架构：

- `packages/shared/src/platform.ts`：标准商品、统一店铺、平台刊登、平台能力和统一发布任务模型。
- `packages/shared/src/platform-adapter.ts`：平台适配器契约。
- `apps/server/src/platform-registry.ts`：平台能力注册表和统一写保护。
- `GET /catalog/products`：标准商品只读目录。
- `GET /shops`：统一店铺账号目录。
- `GET /publishing/tasks`：统一发布任务目录。
- `GET /platforms/capabilities`：平台阶段、能力和阻塞原因。

迁移策略是旁路读取、兼容展示、证据充分后再迁移写入口。不得删除或绕过现有 Temu 安全门禁。

## 2. 仓库形态

npm workspaces monorepo，5 个子包 + 共享 + 文档：

```
apps/dashboard     React + Vite 控制台（默认简化"无人值守主流程"界面）
apps/server        Fastify 编排服务（端口 8787，AI mock 规划 + 自动化执行网关）
apps/extension     Chrome/Edge MV3 插件（注入店小秘/Temu 页面）
apps/automation    Playwright 浏览器自动化（dry-run / fill / save / submit / media）
packages/shared    共享类型、AI mock、核价规则
docs/              规划与运行手册（见 §7 索引）
```

多平台开发计划：[`docs/multi-platform-development-plan.md`](docs/multi-platform-development-plan.md)。TikTok Shop 规则基线：[`docs/tiktok-shop-rules-matrix.md`](docs/tiktok-shop-rules-matrix.md)。

AI 编排的**任务规划骨架**仍为 mock（[`packages/shared/src/mock.ts`](packages/shared/src/mock.ts)），但**文案生成已接真实大模型**：交互式重规划（`POST /plan/:productId`）会用 OpenAI 兼容模型覆写标题/卖点/描述，未配 `LLM_API_KEY` 或调用失败自动回退规则草稿。详见 [`docs/content-generation.md`](docs/content-generation.md)「真实大模型增强」。无人值守批量仍走确定性规则（刻意为之）。

## 3. 启动

```bash
npm install                    # 安装 workspaces
npm run dev:server             # http://localhost:8787
npm run dev:dashboard          # http://localhost:5173

# 单独子包
npm run dev --workspace @temu-ai-ops/server
npm run build --workspace @temu-ai-ops/extension   # MV3 manifest 校验 + 复制到 dist/
npm test  --workspace @temu-ai-ops/extension      # 含面板 Playwright 校验
```

加载已解压扩展程序时指向 **`apps/extension/dist`**（先 `npm run build --workspace @temu-ai-ops/extension`）。

## 4. 默认主路径

控制台默认入口只有 **"无人值守主流程"**。流程 = `queue-run` → `full-flow`（dry-run → fill-draft → unattended-apply 媒体 → save-draft → submit-listing）。

**默认参数**（控制台日间模式）：
- `mediaAutomationMode = unattended-apply`
- 启用媒体工具：image translation / batch resize（`white-background`、`image-editor` 只在高级区按需启用）
- `submitAfterSave = true`（保存后点店小秘"提交核价"）
- 真实店小秘校准 ≤ 24h（`REAL_DIANXIAOMI_CALIBRATION_STALE_MINUTES`，范围 30min~7d）
- 试验闸门：`limit=3` 试跑必须至少跑过 1 个 ready 商品、所有 full-flow 成功，才解锁"开始无人值守"按钮

详见 [docs/operating-principles.md](docs/operating-principles.md) —— **这是产品规则源头，改它之前先读懂**。

## 5. 自动化 API 速查

服务端所有自动化入口在 [apps/server/src/index.ts](apps/server/src/index.ts)：

| 类别 | 端点 |
|------|------|
| 健康 | `GET /health` · `GET /automation/queue-daemon/health` · `GET /automation/unattended-startup-check` · `GET /automation/readiness` · `GET /automation/preflight` |
| 任务 | `GET /tasks` · `GET /tasks/active` · `GET /debug-snapshots` |
| 单次自动化 | `POST /automation/dry-run` / `fill-draft` / `save-draft` / `submit-listing` / `full-flow` |
| 编排 | `POST /automation/queue-run` / `recovery-run` |
| 修复 | `POST /automation/repair-preview` / `repair-apply` |
| 校准 | 端点在 `apps/automation` 子包脚本（`npm run snapshot:diagnose` / `selector-config:generate`） |
| 任务文件 | `GET /automation/task-file-exports` 及其 diff 子路径 |

job 日志通用格式：`/jobs/:id/logs`。

## 6. 关键环境变量

| 变量 | 作用 | 默认 / 范围 |
|------|------|------------|
| `SMOKE_PORT` | 烟测服务端口；不设则自动选空闲端口 | 烟测必用 |
| `PLANNER_STATE_PATH` | 规划器状态文件 | 隔离烟测用 |
| `QUEUE_DAEMON_STATE_PATH` | 队列守护进程状态 | 隔离烟测用 |
| `TASK_EXPORT_HISTORY_PATH` | 任务导出历史 | 隔离烟测用 |
| `SELECTOR_DIAGNOSIS_DIRS` | 选择器诊断扫描根目录 | 多目录用 `:` 分隔 |
| `RECOVERY_RUN_HISTORY_PATH` | recovery 批次历史 | 隔离用 |
| `QUEUE_RUN_HISTORY_PATH` | queue-run 历史（含 limit=3 试跑记录，重启后试跑门靠它不回锁） | `.runtime/data/queue-run-history.json` |
| `AUTOMATION_PRESET_PATH` | 自动化启动预设存储 | 隔离烟测用 |
| `REAL_DIANXIAOMI_CALIBRATION_STALE_MINUTES` | 真实店小秘校准时效 | 30 ~ 10080 |
| `ALLOW_DIANXIAOMI_SMOKE_URLS` | 允许 fixture/示例 URL 入队 | 烟测显式开启 |
| `UNATTENDED_MAX_SKU` | 无人值守选品 SKU 上限；`snapshot.skuCount` 超过则跳过并记 `sku-count-over-cap`（防 variant-remap OOM，只读已存快照） | `200`（1~2000） |
| `UNATTENDED_MIN_FREE_MEM_MB` | spawn full-flow 前的空闲内存下限；低于则 tick 记 `insufficient-memory` 干净等待（不计失败） | `3072`（256~131072） |
| `UNATTENDED_FULLPAGE_SCREENSHOTS` | 自动化截图是否整页；默认视口截图省内存，校准/排查可显式开 | `false` |
| `LLM_API_KEY` | 内容生成大模型 key；**不设=禁用**，纯规则回退 | 无（禁用） |
| `LLM_BASE_URL` | OpenAI 兼容基址（DeepSeek/Qwen/OpenAI/vLLM） | `https://api.openai.com/v1` |
| `LLM_MODEL` | 模型名 | `gpt-4o-mini` |
| `LLM_TIMEOUT_MS` | 单次调用超时（毫秒） | `20000` |

## 7. 文档索引

按"先读这个"→"出问题再翻"排序：

| 我要... | 看 |
|---------|-----|
| 理解产品边界和 KPI 定义 | [docs/operating-principles.md](docs/operating-principles.md) |
| 了解生产路径 roadmap | [docs/roadmap-to-production.md](docs/roadmap-to-production.md) |
| 看当前冲刺卡点（阻塞墙） | [docs/blocking-walls-diagnosis.md](docs/blocking-walls-diagnosis.md) |
| OOM 崩溃诊断与缓解 | [docs/oom-mitigation-plan.md](docs/oom-mitigation-plan.md) |
| **看到「能用起来」的冲刺计划** | [docs/sprint-plan-to-usable.md](docs/sprint-plan-to-usable.md) |
| Temu/店小秘字段要求矩阵 | [docs/temu-dianxiaomi-requirements-matrix.md](docs/temu-dianxiaomi-requirements-matrix.md) |
| 看开发计划 | [docs/development-plan.md](docs/development-plan.md) |
| 看最近改了什么 | [docs/current-status.md](docs/current-status.md)（流水账） |
| 跑店小秘 dry-run | [docs/dianxiaomi-dry-run.md](docs/dianxiaomi-dry-run.md) |
| 修会话过期/CAPTCHA | [docs/dianxiaomi-session-health-runbook.md](docs/dianxiaomi-session-health-runbook.md) |
| 真实店小秘校准 | [docs/real-dianxiaomi-calibration-runbook.md](docs/real-dianxiaomi-calibration-runbook.md) |
| 跑 `limit=3` 真实试跑验收（含实战坑） | [docs/limit-3-trial-acceptance.md](docs/limit-3-trial-acceptance.md) |
| 选择器配置 | [docs/dianxiaomi-selector-config.md](docs/dianxiaomi-selector-config.md) + [validation](docs/dianxiaomi-selector-config-validation.md) |
| 品类校验/回写/诊断 | [docs/dianxiaomi-category-selection.md](docs/dianxiaomi-category-selection.md) |
| 故障恢复批跑 | [docs/recovery-run.md](docs/recovery-run.md) |
| 浏览器插件构建 | [docs/extension-build.md](docs/extension-build.md) |
| Playwright 自动化 | [docs/playwright-temu-automation.md](docs/playwright-temu-automation.md) |
| 批量草稿/复核/编辑 | [docs/batch-draft-restore.md](docs/batch-draft-restore.md) · [docs/batch-review.md](docs/batch-review.md) · [docs/draft-editing.md](docs/draft-editing.md) |
| 核价规则 | [docs/pricing-rules.md](docs/pricing-rules.md) |
| 发布门 | [docs/publish-gate.md](docs/publish-gate.md) · [docs/publish-preflight-check.md](docs/publish-preflight-check.md) |
| 商品导入 | [docs/csv-import.md](docs/csv-import.md) · [docs/manual-product-entry.md](docs/manual-product-entry.md) |
| 内容生成 | [docs/content-generation.md](docs/content-generation.md) |
| 评审流 | [docs/review-workflow.md](docs/review-workflow.md) |
| 同步门 | [docs/sync-preflight-gate.md](docs/sync-preflight-gate.md) |
| 选择器快照诊断 | [docs/dianxiaomi-snapshot-diagnosis.md](docs/dianxiaomi-snapshot-diagnosis.md) |
| 编辑队列 | [docs/dianxiaomi-edit-queue.md](docs/dianxiaomi-edit-queue.md) |
| 换新电脑上手 / stash 甄别 | [docs/new-machine-onboarding.md](docs/new-machine-onboarding.md) |

## 8. 工作约定

- **默认主路径**：`无人值守主流程`。手动录入、复核、修复、选择器、导入、原始自动化控制只在 `高级区`。
- **手工步骤预算**：只有 `Temu 核价确认` + `Temu 最终上架确认` 是允许的永久人工步骤。其他任何人工步骤必须随附：为什么存在 / 哪个自动替代会移除它 / 触发人或负责人 / 退出条件。否则只能待在 `高级区`。
- **AI 准入**：进默认流程的 AI 特性必须能证明"少点击 / 少判断 / 自动通过率上升"中至少一项。只增加解释文本/复核/新界面的特性先在 `高级区` 等到证明。
- **不要绕过**：登录、CAPTCHA、平台风控、Temu 侧核价/最终上架。当前写天花板 = 店小秘提交。
- **写动作前的硬门**：`surfaceStatus=real-dianxiaomi` 校验、`fixture` 直接拒；fill/save/submit 全部前置 `target-surface` 闸门；unattended media 内部 apply 反馈必须验证，否则整批后续工具 `blocked-by-media-failure` 停掉。
- **会话健康**：`dianxiaomi-session` 是无人值守启动的硬门。最近的诊断/阻塞工作项/队列审计里出现 `login-or-captcha` → 守护进程停在 `PAUSED`，人工登录后再放。
- **失败分级**：发布失败分四路 —— `published` / `auto-retry` / `browser-recovery` / `manual-budget`。前两个走默认，后两个只在 `高级区`。`manualBudget.proofs` 用 proof-ledger 衡量自动方案是否真的减少了点击/判断；没证明就只是"候选"。
- **修复-恢复-重跑**：故障恢复链是 `repair-preview` → `repair-apply` → `full-flow`（无 repair plan 文件）。`recovery-run` 是 `高级区` 工具，**不计入** 日间 `自动通过率` KPI。

## 9. 常见坑

- **没有真实店小秘登录态**就开 `submitAfterSave=true`：会被 `dianxiaomi-session` 闸门挡在 `PAUSED`。
- **fixture URL**（`data:`、localhost demo）默认被生产工作队列拒绝；烟测要 `ALLOW_DIANXIAOMI_SMOKE_URLS=true` 显式开。
- **历史 smoke 工件**（`.runtime/automation-safety-smoke`、`.runtime/automation-runner-test`）默认不参与"最新生产校准"判定；用 `SELECTOR_DIAGNOSIS_DIRS` 显式指给烟测。
- **多服务端口冲突**导致烟测假失败：`test/automation-safety-smoke.ts` 已支持 `SMOKE_PORT` 自动空闲分配。
- **MV3 插件**直接 `加载已解压的扩展程序` 指向 `apps/extension/dist`（构建后），不是 `src`。
- **默认首页 `limit=3` 试跑** 的验收结果看 `GET /automation/queue-runs` + `GET /automation/full-flow/jobs`；`GET /automation/manual-budget/trials` 是 Advanced bounded trial / validation，不是首页试跑记录。
- **行尾是 CRLF**（Windows + `core.autocrlf=true`），跨平台协作前要加 `.gitattributes` 锁 LF。
- **`.runtime/`**（含 3.1G+ 的烟测工件）**不要**试着提交，已被 `.gitignore` 排除。

## 10. Git 现状

- **本地已 `git init`（2026-07-04）**，分支 `main`，基线提交为当日工作树快照（typecheck + 测试全绿状态）。改动有版本控制兜底了，但**没有远程**——只防误改，不防磁盘丢失。
- 大改动照常可以先 `git stash` 或提交；`.backups/` 目录（gitignored）存历史 `.bak` 快照。
- 上游仓库（供参考，本地未关联 remote）：`https://github.com/ppzbb666-del/Auto_goods.git`，其首提交 `4de04c5 chore: import existing monorepo as baseline`。**注意本地 git 历史与上游无共同祖先**，不要直接 push。
- 没有 CI / 没有 pre-commit hook。

---

如果只记一条：**改动前先读 [docs/operating-principles.md](docs/operating-principles.md) 和 [docs/roadmap-to-production.md](docs/roadmap-to-production.md)；它们锁住的就是产品边界，改了就连带要改回这里。**
