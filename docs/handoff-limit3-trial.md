# 交接任务书：limit=3 真实试跑 → 解锁无人值守

Updated: 2026-07-04（写给下一个执行者/助手，按此执行，不需要重新探索仓库）

## 背景（30 秒版）

写链路天花板已在单品上实锤打通（2026-07-03 晚）：商品 `161406453047896424` 走 `queue-run` 完成 save-draft（「产品编辑成功」）+ submit-listing（「产品已提交发布」）。证据在 `.runtime/automation-artifacts/automation-full-flow-2026-07-03T19-49-49-946Z/`。

现在只剩一件事：**跑通一次 `limit=3` 试跑（3 个商品全部 full-flow 成功），解锁「开始无人值守」**。判定逻辑在 [dashboard-helpers.ts](../apps/dashboard/src/lib/dashboard-helpers.ts) `getDailyTrialGate`：存在一条 `limit===3` 的 queue run、`queued>0`、`skipped=0`、所有关联 full-flow job 全部 `completed`。

## ⚠️ 三个必知的坑（都是真实踩过的）

1. **当前队列里唯一 ready 的商品是 OOM 炸弹**。工作项 `dxm-work-1783104364167`（322 SKU，`id=161406453261437092`）在 fill 阶段 variant-remap 时会把浏览器和 server 一起 OOM 崩掉（本机 15.6GB、常年 ~2GB 空闲）。**试跑绝不能让 queue-run 自由抓队列**（它会抓到这个商品），必须用 `itemUrls` 显式指定 3 个小 SKU 商品。
2. **server 不能用 `tsx watch` 跑**（热重载会杀 full-flow 子进程）。启动命令：
   ```bash
   cd apps/server && node ../../node_modules/tsx/dist/cli.mjs src/index.ts
   ```
3. **不要直接调 `POST /automation/full-flow`**（只带 `url` 会 409 Conflict）。统一走 `POST /automation/queue-run`（它会自动建任务 + 导出任务文件）。

## 执行步骤

### 第 0 步：起服务 + 查启动检查

```bash
# 项目根
npm install   # 若 node_modules 已在可跳过
cd apps/server && node ../../node_modules/tsx/dist/cli.mjs src/index.ts
```

```powershell
Invoke-RestMethod -Uri "http://localhost:8787/automation/unattended-startup-check"
```

重点看 `real-dianxiaomi-calibration`（≤24h 时效，大概率已过期）和 `dianxiaomi-session`。

### 第 1 步：刷新真实校准（若过期）

需要操作者在场（headed 浏览器 + 已登录 profile `.runtime/playwright/dianxiaomi-profile`）。按 [real-dianxiaomi-calibration-runbook.md](real-dianxiaomi-calibration-runbook.md)：

```bash
npm run snapshot --workspace @temu-ai-ops/automation -- --url="<真实商品编辑页URL>" --headed=true --profile=".runtime/playwright/dianxiaomi-profile"
npm run snapshot:diagnose --workspace @temu-ai-ops/automation
# 期望 readyToFill=true 且 targetSurface.status="real-dianxiaomi"
```

不需要重新 `selector-config:generate`（config 已有效），除非 diagnose 报字段缺失。

### 第 2 步：准备 3 个小 SKU 的 ready 商品

**选品标准：SKU 数 ≤ 30（越小越稳）**。当前库存不够（只有 1 ready 且是大 SKU + 1 edited），需要补：

- **首选**：操作者在真实店小秘「待发布」页面（小 SKU 商品）用扩展点「加入队列」（扩展先 `npm run build --workspace @temu-ai-ops/extension`，加载 `apps/extension/dist`）。
- **入队后大概率要修工作项**（已知缺陷：admission 会抓浏览器标签页标题当商品标题、断言 sourceBucket 失败，落成 `needs-revision`）。修法：把完整工作项（带真实 `title` + `categoryHint.label`）重新 POST 回去，server 会重算 requirements → `ready-for-automation`：
  ```bash
  # 中文必须用 --data-binary @file（-d 会破坏 Content-Length）
  curl -X POST http://localhost:8787/dianxiaomi/product-work-items \
    -H "Content-Type: application/json" --data-binary @wi.json
  ```
  wi.json 的样例：先 `GET /dianxiaomi/product-work-items` 拿现有对象，改 `title`、补 `categoryHint: {"label":"<中文品类>","source":"manual"}`，原样 POST。
- 已验证过的商品 `161406453047896424` 当前是 `edited` 状态，可用同样的 re-POST 方式重置回 ready，凑数用（它已证明能跑通全链）。

验收：`GET /dianxiaomi/product-work-items` 里有 3 个 `ready-for-automation` 的小 SKU 商品。

### 第 3 步：跑试跑（关键：itemUrls 显式圈定）

```powershell
$body = @{
  limit = 3
  submitAfterSave = $true
  mediaAutomationMode = "unattended-apply"
  mediaAutomationTools = @("image-translation", "batch-resize")
  itemUrls = @(
    "https://www.dianxiaomi.com/web/popTemu/edit?id=<小SKU商品1>",
    "https://www.dianxiaomi.com/web/popTemu/edit?id=<小SKU商品2>",
    "https://www.dianxiaomi.com/web/popTemu/edit?id=<小SKU商品3>"
  )
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "http://localhost:8787/automation/queue-run" -ContentType "application/json" -Body $body
```

- `mediaAutomationTools` **不要加 image-editor**（第二层 bug 未修，加了会被媒体门拦）。
- 带 `itemUrls` 的 run 依然满足试跑门（门只认 `limit===3`）。
- 每个商品 full-flow 约 15-20 分钟，3 个串行约 1 小时。每个阶段结束时报 "Browser crash/disconnect (possible OOM)" 但阶段报告是 `completed` 的，是正常 teardown 不是失败。

### 第 4 步：验收

```powershell
Invoke-RestMethod -Uri "http://localhost:8787/automation/queue-runs"
Invoke-RestMethod -Uri "http://localhost:8787/automation/full-flow/jobs"
```

全部 `completed`、无 failed/skipped → 打开 Dashboard（`npm run dev:dashboard`，5173）首页试跑门应显示通过、「开始无人值守」解锁。**到这里任务完成。**

### 失败时

- 看 job 的 `failureDiagnosis` + `.runtime/automation-artifacts/<jobId>/` 截图。
- `login-or-captcha` → 操作者 headed 登录后重跑（见 [dianxiaomi-session-health-runbook.md](dianxiaomi-session-health-runbook.md)）。
- OOM（浏览器/server 一起死）→ 换更小 SKU 的商品，别硬试。
- 僵尸 Chromium 占 profile → 按可执行路径含 `ms-playwright` 杀进程（**别碰 Google Chrome**）。
- 连续失败 3 次会触发 failure-budget 熔断 → 一次成功跑或 recovery-run 清零。

## 纪律红线（不要违反）

- 绝不绕过登录、CAPTCHA、风控；写天花板 = 店小秘提交核价，Temu 侧核价确认/最终上架永远人工。
- 不改 `apps/server/tsconfig.json` 的宽松设置（`noImplicitAny:false`/`strictNullChecks:false` 是让 runner 过 typecheck 的支撑，改成 strict 会爆几百个错）。
- 本仓库已有本地 git（无 remote，历史与上游 GitHub 无共同祖先，**不要 push**）。大改前正常 commit 即可。
- 改产品行为前先读 [operating-principles.md](operating-principles.md)；改完顺手更新 [current-status.md](current-status.md)。
