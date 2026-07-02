# 真实 Dianxiaomi 页面校准 Runbook

**目标**: 把系统从"只能在 fixture 上跑"推进到"能在真实 Dianxiaomi 商品编辑/刊登页上跑"。

**前置条件**:
- 一个已登录店小秘、并且已经初始化完成的 Chromium browser profile（`playwright-user-data` 或类似）
- 一个真实 Dianxiaomi 商品编辑/刊登页 URL
- 本仓库根目录

## Step 1: 采集真实页面快照

```bash
cd "d:/61590/temu自动上品"
# headed=true 表示用真实浏览器（不是 headless），便于人工登录
npm run snapshot --workspace @temu-ai-ops/automation -- \
  --url="https://erp.dianxiaomi.com/product/edit/YOUR_PRODUCT_ID" \
  --headed=true \
  --profile=".runtime/playwright/dianxiaomi-real-profile"
```

运行后：
1. Playwright 启动 Chromium
2. 打开你提供的 Dianxiaomi 页面
3. 脚本会检测是否已登录；如果未登录，弹出手动登录提示（`waitForManualLoginIfNeeded`）
4. 你在浏览器里手动登录店小秘
5. 登录后脚本自动继续，采集页面快照
6. 等待页面出现 ≥3 个可编辑元素（标题、描述、SKU 字段之一）
7. 快照写入 `output/playwright/dianxiaomi-snapshot-{timestamp}.json` + 同名 .png 截图

**关键环境变量**（可选）:
- `TEMU_TARGET_URL` — 替代 `--url`
- `TEMU_PROFILE_DIR` — 替代 `--profile`
- `HEADED=true` — headed 模式（默认 true）
- `SLOW_MO=200` — 操作间延迟（毫秒），调试时可加大

## Step 2: 诊断快照

```bash
npm run snapshot:diagnose --workspace @temu-ai-ops/automation
```

诊断最新快照，输出到 `output/playwright/dianxiaomi-diagnosis-{timestamp}.json`。关键字段：

```json
{
  "readyToFill": true | false,
  "missingFields": ["title" | "description" | "price" | "stock" | ...],
  "fields": {
    "title": { "recognized": true, "selectorHint": "...", "confidence": "high" },
    ...
  },
  "buttons": {
    "save": { "recognized": true, "selectorHint": "button.save" },
    "submit": { "recognized": true, "selectorHint": "..." }
  },
  "skuRows": { "count": 3, "sample": [...] },
  "mediaTools": {
    "imageTranslation": { "recognized": true },
    ...
  },
  "targetSurface": {
    "status": "real-dianxiaomi",
    "isDianxiaomiHost": true,
    "isDataFixture": false
  }
}
```

**关键检查**:
- `targetSurface.status === "real-dianxiaomi"` —— 不能是 `fixture` 或 `unknown`
- `targetSurface.isDianxiaomiHost === true`
- `targetSurface.isDataFixture === false`
- `readyToFill === true` —— 关键字段都识别到

如果 `readyToFill === false`：
1. 看 `missingFields` 列表
2. 对照 `docs/dianxiaomi-snapshot-diagnosis.md` 调整选择器策略
3. 重新采集快照

## Step 3: 生成选择器配置

```bash
npm run selector-config:generate --workspace @temu-ai-ops/automation
```

或通过 Dashboard 高级面板：`selector 诊断` → `生成选择器配置`。

输出到 `.runtime/dianxiaomi-selector-config.json`。格式参考 [docs/dianxiaomi-selector-config.md](dianxiaomi-selector-config.md)。

**人工校准建议**:
1. 打开生成的 `.runtime/dianxiaomi-selector-config.json`
2. 对照 Step 1 采集的 `dianxiaomi-snapshot-*.json`，检查每个 selector 字符串
3. 必要时用 Playwright Inspector（`npx playwright codegen <url>`）验证 selector 在真实页面上能找到元素
4. 修改不准确的 selector，保存

## Step 4: 验证配置可用

通过 Dashboard 验证：
1. 打开 Dashboard（[http://localhost:5173](http://localhost:5173)）
2. 进入"高级"（默认隐藏） → "选择器诊断"
3. 看 `selector-config 存在` ✓、`selector 数量 > 0` ✓
4. 看"启动检查"面板的 `selector config` 检查结果为 `pass`

或命令行：
```bash
curl -s http://localhost:8787/automation/selector-config | head -c 500
curl -s http://localhost:8787/automation/unattended-startup-check | python -c "import json,sys; d=json.load(sys.stdin); [print(c['id'], c['status'], c['message']) for c in d['checks']]"
```

期望看到 `selector config` 状态为 `pass`。

## Step 5: 启动无人值守前必须满足

按照 [docs/operating-principles.md](operating-principles.md)：

启动无人值守 daemon 之前，启动检查必须满足：
- ✅ `ready work items` —— 至少有一个 `ready-for-automation` 工作项
- ✅ `selector config` —— 选择器配置通过校验
- ✅ `real Dianxiaomi calibration` —— 真实页面校准通过（**不是 fixture**）
- ✅ `task file snapshot` —— 任务文件快照正常
- ✅ `browser profile` —— 已配置、已初始化、已登录，且没有活动锁文件
- ✅ `failure budget` —— 失败计数未超限
- ⚠️ `blocked backlog` —— 阻塞工作项数（warning）
- ✅ `manual-step promotion validation` —— 推广验证通过

**校准检查失败的常见原因**:
1. 校准报告来自 fixture（`fixture` 或 `isDataFixture: true`）
2. 校准报告 URL 不是 `erp.dianxiaomi.com` 或 `www.dianxiaomi.com`
3. 没有登录态，页面跳到登录页（targetSurface 是 `real-dianxiaomi` 但 `canInspect: false`）
4. 校准报告太旧（默认 > 24 小时，stale）
5. browser profile 没配置、目录还没初始化，或者存在活动锁文件

**校准新鲜度设置**:
- 默认真实 Dianxiaomi 校准有效期是 24 小时
- 可用 `REAL_DIANXIAOMI_CALIBRATION_STALE_MINUTES` 覆盖
- 覆盖值会被限制在 30 分钟到 7 天之间，避免误配置把门禁完全放开

**browser profile 要求**:
1. `profile` 路径必须显式配置
2. profile 目录必须已经存在，不能指望守护进程首次启动时临时创建
3. profile 里不能有活动 `SingletonLock` / lock 文件
4. 首次建立 profile 要用 headed 模式打开真实店小秘页，完成登录后再启动无人值守

## Step 6: 小批量试跑

默认首页 `小批量试跑` 的详细通过标准看 [docs/limit-3-trial-acceptance.md](limit-3-trial-acceptance.md)。这里仅保留启动方式和关键观察点。

按 [docs/roadmap-to-production.md](roadmap-to-production.md) 下一步条目：

```powershell
# 在 Dashboard 首页动作区点击「小批量试跑」
# 或直接调 API，默认日间试跑参数如下：
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

观察：
- `/automation/unattended-startup-check` —— 启动门是否还有硬阻塞
- `/automation/queue-runs` —— 最近一次 `limit=3` 试跑的 `queued/skipped/flowJobIds`
- `/automation/full-flow/jobs` —— 每个 flow job 的最终状态
- `/automation/queue-daemon/health` —— 队列健康
- 失败的话看 `failureDiagnosis` 分类
- 成功的话：商品进入 Dianxiaomi 草稿状态

注意：`/automation/manual-budget/trials` 属于 Advanced bounded trial / validation，不是首页默认 `limit=3` 试跑记录。

## 后续

校准完成后，[docs/roadmap-to-production.md](roadmap-to-production.md) 的下一步是：
- 根据真实快照校准标题、描述、属性、SKU 价格、SKU 库存和保存按钮选择器
- 接入 AI 内容生成
- 升级本地 JSON 存储为轻量数据库
- 批量恢复版本和批量发布前检查

## Fixture 验证结果（2026-06-04）

在 headless 环境用本地 fixture HTML（`.runtime/dianxiaomi-dry-run-fixture.html`）端到端跑了一遍工具链，确认全部 OK：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 1. 采集 | `npm run snapshot -- --url="file:///d:/.../dianxiaomi-dry-run-fixture.html" --headed=false` | ✅ `output/playwright/dianxiaomi-snapshot-{ts}.{json,png}` |
| 2. 诊断 | `npm run snapshot:diagnose` | ✅ 所有字段（title/description/price/stock/attribute）+ 按钮（save/submit）+ 媒体工具 5 个都识别；SKU 行 2 个。`targetSurface.status = "unknown"` 因为是 file:// URL 不是真实 Dianxiaomi 页（符合预期） |
| 3. 生成 | `npm run selector-config:generate` | ✅ 写入 `.runtime/dianxiaomi-selector-config.json` |

**已知 gap（已修 1 个）**:
- ~~生成的 `mediaTools` 字段没出现在 selector config 中~~ **已修**：`selector-config-generate.ts` 默认输出路径是相对 `apps/automation/` 解析，server 读的是项目根 `.runtime/dianxiaomi-selector-config.json`，两者不匹配；generator 实际写到了 `apps/automation/.runtime/...`，导致 server 看到的是旧版缺 `mediaTools` 的 config。已修：给 generator 加 `getRepoRoot()`，默认输出改为 `<repoRoot>/.runtime/dianxiaomi-selector-config.json`。
- `targetSurface.status === "real-dianxiaomi"` 必须是真实 Dianxiaomi URL 才能满足启动检查；fixture 版只验证工具链，不满足启动检查。

## 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| `targetSurface.status === "fixture"` | 跑的是 fixture 不是真实页 | 改用真实 Dianxiaomi URL |
| `targetSurface.status === "unknown"` | 页面未识别 | 跑 `snapshot:diagnose` 看 details |
| `readyToFill: false` | 关键字段未识别 | 调整 selector 关键词或人工校准 selector config |
| 保存按钮缺失 | Dianxiaomi 改版 | 重跑 snapshot 重新识别 |
| 启动检查卡在 `real Dianxiaomi calibration` | 校准报告是 fixture | 重新跑 Step 1-3 用真实页 |
| 生成的 config 缺 `mediaTools` | 路径 bug（已修） | generator 现在写到项目根 `.runtime/dianxiaomi-selector-config.json`，含 `mediaTools` 和 `mediaToolActions` |

## 文件位置

- 快照：`output/playwright/dianxiaomi-snapshot-{timestamp}.{json,png}`
- 诊断：`output/playwright/dianxiaomi-diagnosis-{timestamp}.json`
- 选择器配置：`.runtime/dianxiaomi-selector-config.json`
- 配置版本：`.runtime/selector-config-versions/*.json`
- Browser profile：`.runtime/playwright/dianxiaomi-profile/`

## 相关文档

- [docs/dianxiaomi-snapshot-diagnosis.md](dianxiaomi-snapshot-diagnosis.md) — snapshot 诊断详解
- [docs/dianxiaomi-selector-config.md](dianxiaomi-selector-config.md) — selector config 格式
- [docs/dianxiaomi-selector-config-validation.md](dianxiaomi-selector-config-validation.md) — config 校验规则
- [docs/operating-principles.md](operating-principles.md) — 运营铁律（人工步骤、KPI、AI 准入）
- [docs/roadmap-to-production.md](roadmap-to-production.md) — 上线路线图
