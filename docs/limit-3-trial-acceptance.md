# `limit=3` 真实试跑验收清单

Updated: 2026-06-30

> 这份清单只对应默认日间首页的 `小批量试跑`，底层是 `POST /automation/queue-run`。
> 它**不是** `POST /automation/manual-budget/trials` 那套 Advanced bounded trial / validation 流程。

## 目标

跑通一次真实 `limit=3` 试跑，让首页试跑门进入 `passed`，从而解锁 `开始无人值守`。

控制台日间试跑门的真实判定逻辑见 [apps/dashboard/src/lib/dashboard-helpers.ts](../apps/dashboard/src/lib/dashboard-helpers.ts) 的 `getDailyTrialGate`：

- 存在一条 `limit === 3` 的 queue run
- `queued > 0`
- `skipped = 0`
- 每个 `flowJobId` 都能在 full-flow job 列表里找到
- 所有相关 full-flow job 都是 `completed`
- 没有 `failed`
- 没有仍在 `running`

## 前置条件

开始前先确认下面几项：

1. 服务端已启动：`http://localhost:8787`
2. Dashboard 已启动：`http://localhost:5173`
3. 扩展已构建并加载 `apps/extension/dist`
4. 已登录真实店小秘资料目录，且无人值守启动检查没有硬阻塞
5. 至少有 1 个 `ready-for-automation` 商品；推荐准备 3 个
6. 真实页面校准是新的，且 selector config 已通过

先查一次启动检查：

```powershell
Invoke-RestMethod -Uri "http://localhost:8787/automation/unattended-startup-check"
```

期望硬门都不是 `block`，尤其是这些检查：

- `ready-work-items`
- `real-dianxiaomi-calibration`
- `selector-config`
- `browser-profile`
- `dianxiaomi-session`
- `failure-budget`

## 默认试跑参数

首页默认 `小批量试跑` 等价于：

```json
{
  "limit": 3,
  "submitAfterSave": true,
  "mediaAutomationMode": "unattended-apply",
  "mediaAutomationTools": ["image-translation", "batch-resize"]
}
```

`white-background` 和 `image-editor` 仍可在高级区显式启用，但它们不是当前日间默认工具。

## 启动方式

优先用 Dashboard 首页 `小批量试跑` 按钮。

如果要直接调 API，用这个：

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

如果要只跑指定商品，也可以在 body 里额外传：

- `itemUrls`
- `sourceBuckets`
- `storeId` / `storeName`

## 验收步骤

### 1. 看 queue run 是否真的启动

```powershell
Invoke-RestMethod -Uri "http://localhost:8787/automation/queue-runs"
```

最近一条 `limit = 3` 的记录至少要满足：

- `queued > 0`
- `skipped = 0`
- `flowJobIds` 非空

如果 `queued = 0`，这次试跑直接不算通过，先去补 `ready-for-automation` 商品。

### 2. 看 full-flow 是否全部完成

```powershell
Invoke-RestMethod -Uri "http://localhost:8787/automation/full-flow/jobs"
```

把上一步 queue run 的 `flowJobIds` 对上来，期望：

- 每个 `flowJobId` 都能找到对应 job
- 每个 job 的 `status = completed`
- 没有 `failed`
- 没有 `running`

### 3. 看首页试跑门是否解锁

成功时，首页试跑门会显示通过态，文案接近：

- `最近一次小批量试跑已通过：N 个商品完成并进入核价阶段。`
- `开始无人值守` 按钮从禁用变为可点

### 4. 抽查 work item 回写

```powershell
Invoke-RestMethod -Uri "http://localhost:8787/dianxiaomi/product-work-items?limit=20"
```

这次试跑涉及的成功商品不应继续停在 `ready-for-automation`。成功流一般会把源 work item 置为 `edited`；失败流会置为 `blocked` 并附带结构化 `failureDiagnosis`。

## 通过标准

一次 `limit=3` 真实试跑通过，等价于下面 6 条同时成立：

1. 启动检查无硬阻塞
2. 最近一条 `limit=3` queue run 的 `queued > 0`
3. `skipped = 0`
4. 所有关联 `flowJobId` 都能找到 job
5. 所有关联 full-flow job 都是 `completed`
6. 首页出现“已通过 / 可以启动 / 开始无人值守可点”的状态

## 失败时先看哪里

默认日间试跑失败，先看这三个接口：

```powershell
Invoke-RestMethod -Uri "http://localhost:8787/automation/unattended-startup-check"
Invoke-RestMethod -Uri "http://localhost:8787/automation/queue-daemon/health"
Invoke-RestMethod -Uri "http://localhost:8787/automation/full-flow/jobs"
```

常见失败分类和动作：

| 分类 | 先做什么 |
|---|---|
| `login-or-captcha` | 去真实资料目录里重新登录，处理验证码 |
| `real-page-calibration` / `selector-config` / `target-surface` | 重跑真实页面校准并保存 selector config |
| `media-processing` | 先看图片工具反馈；当前默认只保留 `image-translation` + `batch-resize` |
| `publish-validation` | 补齐必填属性、SKU、价格、库存、主题颜色、图片要求 |
| `browser-profile` | 关闭占用同一资料目录的浏览器，清掉活动锁 |

## 不要混淆的两套“试跑”

默认首页 `小批量试跑` 看的是：

- `GET /automation/queue-runs`
- `GET /automation/full-flow/jobs`

Advanced bounded trial / validation 看的是：

- `GET /automation/manual-budget/trials`

后者服务于 proof / replacement / validation rerun，不决定首页 `开始无人值守` 是否解锁。

## 相关文档

- [docs/real-dianxiaomi-calibration-runbook.md](real-dianxiaomi-calibration-runbook.md)
- [docs/sprint-plan-to-usable.md](sprint-plan-to-usable.md)
- [docs/blocking-walls-diagnosis.md](blocking-walls-diagnosis.md)
- [docs/operating-principles.md](operating-principles.md)
