# 冲刺计划:到「你能用起来」

Updated: 2026-06-22

> 目标只有一个:**尽快完成第一次真实无人值守上品**(店小秘草稿 → 提交核价,Temu 侧核价确认留给你人工)。
> 本文档只列「挡住首次使用」的事;能改善但不挡首次使用的,统一进 §B 待办,**先用起来再说**。

---

## 唯一里程碑

跑通一次 `limit=3` 真实试跑,3 个商品全部 full-flow 成功、进店小秘草稿并点了「提交核价」,从而**解锁「开始无人值守」按钮**。

依据:[CLAUDE.md](../CLAUDE.md) §4 试验闸门 + [real-dianxiaomi-calibration-runbook.md](real-dianxiaomi-calibration-runbook.md) Step 6 + [operating-principles.md](operating-principles.md)。

挡在这个里程碑前的,是 8 项启动检查(`GET /automation/unattended-startup-check`)。

---

## A0 实测结果(2026-06-22,live server @8787)

`canStart: false`,但**只剩 3 道硬门**,而且比预想轻 —— session 已登录、selector-config 已有效、131 个 ready 商品都到位:

| 检查 | 状态 | 解法 | 谁 |
|---|---|---|---|
| ready-work-items | ✅ pass | 131 ready —— 够 | — |
| selector-config | ✅ pass | 已有效(A1 的生成/验证其实已完成) | — |
| dianxiaomi-session | ✅ pass | **已登录、可检视**(最难的人工门当前满足) | — |
| task-file-snapshot | ✅ pass | — | — |
| manual-budget-promotion-gate | ✅ pass | — | — |
| **real-dianxiaomi-calibration** | ❌ block | 校准 4 天前过期(上限 24h)→ 重跑 snapshot+diagnose 刷新 | 你登录确认 / 我驱动 |
| **browser-profile** | ❌ block | profile 路径未配置 → 配置持久 profile 路径 | 配置项,我能帮 |
| **failure-budget** | ❌ block | 连续失败 3/3 → 走 recovery-run 或一次成功跑清零 | 我驱动 |
| blocked-backlog | ⚠️ warning | 99 阻塞项 / 近 10 次失败流(校准过期很可能是诱因) | 校准修好后复查 |

**关键洞察**:登录态当前是好的,所以校准只是「放久了要刷新」,不是从零做。三道门修好 → A4 试跑。

### A0 测试发现(需修)
`npm test`:扩展全绿;server `automation-runner.test.ts` 1 处断言失败(line ~3362)。
根因:新增的会话用例在共享诊断目录留下 login/CAPTCHA 信号没清,泄漏进后面 baseline 的 selector-config 用例,而会话门优先级在 selector 之前(符合「会话是硬门」)。**是测试隔离问题,非产品回归**,修在测试侧(几行)。

---

## A. 冲刺(本周,按顺序做)

### A0 — 验证快照能起(我来,不需要你登录)
- `npm install` → `npm test`(server + extension)→ `npm run dev:server`
- `GET /health` 200;`GET /automation/unattended-startup-check` 列出 8 项检查的真实状态
- **验收**:测试全绿、服务起得来、拿到 8 项检查的当前红/绿清单(这份清单决定 A1–A2 还要补什么)
- **产出**:一张「当前哪几项检查没过」的表

### A1 — 真实页面校准(你登录,我驱动)
按 runbook Step 1–4:
1. `npm run snapshot ... --headed=true --profile="..."` → 浏览器弹出,**你手动登录店小秘**
2. `npm run snapshot:diagnose` → `readyToFill=true`、`targetSurface.status="real-dianxiaomi"`
3. `npm run selector-config:generate` → 写 `<repoRoot>/.runtime/dianxiaomi-selector-config.json`
4. 人工核对生成的 selector(对照快照,必要时 `npx playwright codegen` 验证)
- **验收**:`unattended-startup-check` 里 `selector config = pass` **且** `real Dianxiaomi calibration = pass`(非 fixture、URL 是 `erp/www.dianxiaomi.com`、有登录态、校准 ≤24h)
- **风险**:店小秘改版会让字段识别失败 → 看 `missingFields` 调关键词或手改 config

### A2 — browser profile 就绪(你登录一次)
- profile 目录已存在、已登录、**无 `SingletonLock` 活动锁**
- **验收**:`browser profile` 检查 = pass
- 注:本地已有一个登录态目录(`待发布编辑页/`,已被 .gitignore),可复用或按 runbook 路径新建;关键是「已登录 + 无锁 + 新鲜」

### A3 — 准备 ≥1 个 ready 商品(你给真实商品,我驱动)
- 用插件在真实店小秘商品页点「加入队列」,或用 `itemUrls` 传真实链接
- **验收**:`ready work items` 检查 = pass(至少 1 个 `ready-for-automation`)

### A4 — limit=3 试跑(我驱动,你看结果)
详见 [limit-3-trial-acceptance.md](limit-3-trial-acceptance.md)。最小 API 例子：

```powershell
$body = @{
  limit = 3
  submitAfterSave = $true
  mediaAutomationMode = "unattended-apply"
  mediaAutomationTools = @("image-translation", "batch-resize")
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:8787/automation/queue-run" `
  -ContentType "application/json" `
  -Body $body
```
- 观察 `/automation/queue-runs`、`/automation/full-flow/jobs`、`/automation/queue-daemon/health`，失败看 `failureDiagnosis`
- **验收**:3 个全部 full-flow 成功 → 进店小秘草稿 + 已点提交核价 → **「开始无人值守」解锁**

### A5 — 首次无人值守批跑(你点)
- 在控制台「无人值守主流程」开跑真实 ready 队列
- **验收**:商品稳定流到「Temu 核价确认」(你唯一的人工步骤)。**到这里就算能用了。**

---

## B. 先用起来之后再做(不挡首次使用)

| # | 事项 | 为什么不挡首次使用 | 依据 |
|---|------|------------------|------|
| B1 | `automation-runner.ts` 273 个 typecheck 错误收尾;或暂时加回 `@ts-nocheck` | test 通过、runtime 正常 | current-status |
| B2 | `automation-runner.ts` 领域拆分(9 子文件,≤1500 行/个) | 维护性,不影响功能 | roadmap §下一步 |
| B3 | 接入真实大模型替换 mock 内容生成 | 现有规则化内容可人工小改后用 | roadmap 阶段 3 |
| B4 | 本地 JSON 存储 → 轻量数据库 | 单机小批量 JSON 够用 | roadmap §下一步 |
| B5 | 批量发布前检查 / 批量版本恢复 | 首次是小批量(limit=3→几十) | roadmap 阶段 8 |

---

## 关键纪律(别踩)
- **绝不绕过**登录、CAPTCHA、风控、Temu 核价/最终上架;写天花板 = 店小秘提交。
- **登录态目录绝不入库**(已 .gitignore `待发布编辑页/`、`*.bak`)。
- 改 `automation-runner.ts` 大改前先 `cp ...bak` 或 `git stash`(防源文件丢失,已有前科)。
- 改产品边界先读 [operating-principles.md](operating-principles.md) + [roadmap-to-production.md](roadmap-to-production.md)。
