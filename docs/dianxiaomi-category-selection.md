# 店小秘品类（category-selection）—— 根因、回写与验证

> 2026/06 这一轮把"店小秘商品缺 Temu 品类导致进不了无人值守"这条路彻底拆开：
> 一个**必填校验**、一条**品类回写**链路、两个**只读/半只读验证脚本**。先读本文再动品类相关代码。

## 1. 为什么会卡

上一轮（commit `4e79568`）给 `buildDianxiaomiWorkRequirements` 加了一个 **`required` 级别的 `category-selection` 校验**
（[apps/server/src/planner.ts](../apps/server/src/planner.ts) 的 `hasCategorySelectionSignal`）。判定逻辑：

```
hasCategorySelectionSignal =
     真实（非占位符）的 category label
  || categoryHint.categoryId
  || categoryHint.fullCid
```

三者全空 → `category-selection.ok = false` → work item 的 `status` 卡在 `needs-revision`，
**进不了 `ready-for-automation`**，无人值守主流程因此不会捡它。

这是**有意的硬门**：缺品类的商品如果硬跑 full-flow，会在店小秘"未选择分类（`未选择分类`）"那一步失败。
所以根因不是 bug，而是**存量 work item 没带品类信号**。要让它们重新 ready，有两条路：

1. 让自动化在编辑页**当场恢复品类**（`normalizeCategorySelection`，依赖页面能开品类选择弹窗 + 公共品类回退）。
2. **离线回写一个品类 label**到 work item（本文的回写脚本），由 server 重算 requirements 后放行。

## 2. 根因诊断脚本（只读）

### `probe-readonly-category-state.ts`

[apps/automation/src/probes/probe-readonly-category-state.ts](../apps/automation/src/probes/probe-readonly-category-state.ts)

回答："**这些真实编辑页到底有没有已选品类？**" —— 纯读，不点击、不写。
读的是 adapter 同款 `未选择分类` 信号，外加品类按钮可见性 + 品类标签附近文本。

```bash
cd apps/automation
tsx src/probe-readonly-category-state.ts <editUrl> [editUrl...]
# 每行输出: { url, title, missingCategory, selectCategoryButtonVisible, nearbyCategoryText }
```

用途：确认"卡住的商品是真缺品类，还是只是 work item 没记下品类信号"。
`missingCategory=false` 但 work item 仍 `needs-revision` → 用回写补 label 即可，不必跑浏览器恢复。

### `verify-category-label-only.ts`

[apps/automation/src/verify-category-label-only.ts](../apps/automation/src/verify-category-label-only.ts)

回答："**只给一个 label（没有 categoryId / fullCid），`normalizeCategorySelection` 能不能自己选中品类？**"
半只读：会打开品类弹窗并尝试选中（headed），但**不填其他字段、不保存、不提交**。

```bash
cd apps/automation
tsx src/verify-category-label-only.ts <editUrl> <label>
# 输出: { status, detail, selectedPath, candidatePaths, apiRecovery }
```

用途：验证回写一个 label 是否足以让浏览器侧把品类恢复出来 —— 这是"label-only 回写"能否替代"手动选品类"的关键证据。

> 既有的 [verify-category-normalization.ts](../apps/automation/src/verify-category-normalization.ts) 走完整 `PublishTask`
> （带 category 字段），本脚本专门压到 **label-only** 这一最弱输入，验证下限。

## 3. 品类回写脚本

[scripts/backfill-category-hint.mjs](../scripts/backfill-category-hint.mjs)

给存量 work item 批量补 `categoryHint.label`，走既有的
`POST /dianxiaomi/product-work-items`（`saveDianxiaomiProductWorkItem` 会**原地更新并重算 requirements + status**）。

```bash
# 前置：把当前 work item 快照导出到 .runtime/_wi_probe.json
node scripts/backfill-category-hint.mjs "<label>" <id1> <id2> ...
# 每行输出: { id, httpStatus, newStatus, categorySelectionOk, categoryHint }
```

关键点：
- 回写**携带 `id` + 必填字段**（`pageUrl` / `pageTitle` / `title` / `snapshot`），所以是更新而非新建。
- `categoryHint.source = "manual"` —— 标记这是人工补的品类，便于事后审计。
- 期望结果：`categorySelectionOk=true` 且 `newStatus=ready-for-automation`。
- 这是 **`高级区` / 一次性运维工具**，不是默认主流程的一环；用它说明品类信号本该在采集/录入阶段就带上。

### 3b. 批量回写（探针驱动，page-already-selected 场景）

存量里有一类商品：**店小秘页面上其实已经选好品类**，只是 work item 快照过时没记下品类信号，于是被 `category-selection` 卡在 `needs-revision`。
这类回写最安全 —— 真跑时 `normalizeCategorySelection` 看到 `missingCategory=false` 会**直接 skip**，回写的 label 只用于过闸门 + 留痕，**不参与真跑的品类选择**（即使店小秘当初选错了类目，也是页面已选的事实，不是回写引入）。

链路（全部一次性运维工具，产物落 `.runtime/`，已 gitignore）：

```bash
# 1. 导出 work item 快照
curl -s "http://localhost:8787/dianxiaomi/product-work-items?limit=1000" -o .runtime/_wi_probe.json

# 2. 只读探针：哪些页面已选品类（见 §2 probe-readonly-category-state.ts），输出落 .runtime/_probe_all.jsonl
#    注意 Windows 命令行长度上限：URL 多时分批（~30 个/批）跑

# 3. 从探针结果构建 id->label 计划（排除 fixture、清洗店小秘短名）
node scripts/build-category-backfill-plan.mjs        # 写 .runtime/_backfill_plan.json

# 4. 回写（默认 dry-run，看清每条；--apply 才真写）
node scripts/backfill-category-plan.mjs              # dry-run
node scripts/backfill-category-plan.mjs --apply      # 执行
```

- [scripts/build-category-backfill-plan.mjs](../scripts/build-category-backfill-plan.mjs)：解析探针文本里「`产品分类<短名>选择分类`」的店小秘短名，排除非真实编辑页（fixture），产出干净计划。
- [scripts/backfill-category-plan.mjs](../scripts/backfill-category-plan.mjs)：按 id 各带各的 label 回写，**dry-run 默认**，`--apply` 才 POST。
- 2026-06：首次批量执行救回 66 个（页面已选品类），`ready` 1 → 67。

## 4. 测试侧固化

[apps/server/test/automation-runner.test.ts](../apps/server/test/automation-runner.test.ts) 里所有"完整/ready 列表"型 fixture
现在都显式带 `categoryHint: { label: "Home & Garden" }`。

原因：`category-selection` 是上一轮新加的必填校验，这些 fixture 代表"应当 ready 的商品"，
不带品类信号就会掉到 `needs-revision`，破坏后续 publish/recovery 路由断言。补 label 让它们继续满足必填门。

## 5. 退出条件（什么时候这些工具可以下线）

回写脚本与 label-only 验证都是过渡工具。当满足以下任一时即可移除：

- **采集/录入阶段稳定带品类信号**（categoryId / fullCid / label）—— 则存量回写不再需要。
- **`normalizeCategorySelection` 的公共品类回退足够稳**，label-only 即可可靠恢复 —— 则离线回写可让位给浏览器侧当场恢复。

在那之前，缺品类的商品的正确处理顺序：
`probe-readonly-category-state`（确认真缺） → `verify-category-label-only`（确认 label 够用） → `backfill-category-hint`（回写放行）。

## 6. 相关

- 必填校验定义：[apps/server/src/planner.ts](../apps/server/src/planner.ts)（`category-selection` / `hasCategorySelectionSignal` / `resolveDianxiaomiWorkItemCategoryLabel`）
- 浏览器侧品类恢复：[apps/automation/src/adapters/dianxiaomi-adapter.ts](../apps/automation/src/adapters/dianxiaomi-adapter.ts)（`normalizeCategorySelection`）
- 同族品类探针：`probe-category-restore.ts` / `probe-category-vue-state.ts` / `probe-public-category-fallback.ts` / `probe-variant-remap-confirm.ts`
- 产品边界：[docs/operating-principles.md](operating-principles.md)
