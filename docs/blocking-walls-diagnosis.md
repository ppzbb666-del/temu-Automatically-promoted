# 无人值守上品 — 阻塞墙诊断（2026-06-28）

> 一次「从校准到提交核价」的深度推进记录。三道墙:品类(已解)、媒体工具(部分解)、图片缺失(待解)。
> 目标仍是冲刺计划 [sprint-plan-to-usable.md](sprint-plan-to-usable.md) 的唯一里程碑:limit=3 真实试跑全绿 → 解锁无人值守。

## 起点状态(实测 `unattended-startup-check`)

从 4 道 block 一路推进。当日实测:校准过期 8.3 天、0 ready、browser-profile 未配、failure-budget 3/3。

## 墙 1:品类 — ✅ 已解

**根因**:提交 `4e79568` 新增「品类可解析就绪门」(`category-selection`,required,[planner.ts:472-489](../apps/server/src/planner.ts))。238 个历史商品**全部缺 Temu 品类**(229 个只差这一项)→ 全被打成 needs-revision/blocked → ready=0。

**关键事实**:
- 门通过条件很宽:`categoryHint.label` 非占位符 **或** `categoryId` **或** `fullCid` 任一非空即过。**一个像样的中文 label 就够**。
- 回写走现成 `POST /dianxiaomi/product-work-items`(带 `id`+`categoryHint`)→ `saveDianxiaomiProductWorkItem` 自动重算 requirements + 把 status 设回 ready。**无需新端点**。该端点也能强制重置卡住的 blocked 商品(ready=true 时覆盖 blocked)。
- fill 阶段 `normalizeCategorySelection`([dianxiaomi-adapter.ts:1090](../apps/automation/src/adapters/dianxiaomi-adapter.ts))是成熟生产代码,三路 fallback 选品类:① 页面自带 categoryId → API `getByCategoryId.json` 自动解析公开路径(**多数商品走这条,映射表用不上**);② 弹窗搜索/categoryPath;③ `KNOWN_CATEGORY_RECOVERY_PATHS` 表(仅「女装长裤」1 条)。

**验证**:回写 label=「女装长裤」→ 商品过门变 ready;真实页面验证 `normalizeCategorySelection` status=done,逐层选中「服装、鞋靴和珠宝饰品 > 女士时尚 > 女装 > 女装长裤」。

**工具**:回写脚本 [scripts/backfill-category-hint.mjs](../scripts/backfill-category-hint.mjs);单页验证 [verify-category-label-only.ts](../apps/automation/src/verify-category-label-only.ts);只读探测 [probe-readonly-category-state.ts](../apps/automation/src/probes/probe-readonly-category-state.ts)。

## 墙 2:媒体工具 — ⚠️ 部分解

**拦截机制**(关键):submit 被 `write-blocked-media-processing` 拦,仅当 `media-processing-plan` = failed。而 plan failed 的条件 [dianxiaomi-adapter.ts:13201](../apps/automation/src/adapters/dianxiaomi-adapter.ts) **只看这 4 个 tool status**:`open-failed / apply-failed / return-failed / blocked-by-media-failure`。**`manual-confirmation-required` 不拦**。

**image-editor 的两层 bug**:
1. **第一层(已修✅)**:「批量编辑」弹窗打开后没选图就点「确定」→ 店小秘报「请选择要编辑的图片」(已选中:0)。修复:apply 前调 `ensureCheckboxNearText(mediaSurface,"选择全部",true)`([dianxiaomi-adapter.ts:12911](../apps/automation/src/adapters/dianxiaomi-adapter.ts))。验证:已选中 0→18 生效。
2. **第二层(未解)**:选图后点「确定」,弹窗**不推进/不关闭**,`feedbackState=unknown`,apply 判失败。试过「弹窗关闭=成功」fallback,**被数据证伪**(弹窗其实没关到 baseline),已回退。真修需 ground truth(看正确 apply 流程),但 headed 浏览器窗口在操作者屏幕不显示,手动观察走不通 → **下轮专项**。

**临时突破(已验证✅)**:把 image-editor 从 `mediaAutomationTools` 白名单移除 → 它变 `manual-confirmation-required`(不在 4 个失败 status 里)→ 不再让 plan failed → batch-resize 不被连带 → **`media-processing-plan=done`,submit 不再被媒体门拦**。image-translation + batch-resize 均 `applied` 成功。

> 推荐默认媒体工具暂用 `["image-translation","white-background","batch-resize"]`(去 image-editor),直到第二层修好。

## 墙 3:图片缺失 — ❌ 待解(当前最后一道墙)

**根因**:**234/238 个 work item 完全没有图片 URL**。这批是「页面引用型」采集——图片在店小秘编辑页上,但没存进 work item 的 `product.images`。

**连锁后果**:
- `createTaskFromDianxiaomiProductWorkItem` 建的 task `product.images=[]`。
- fill 阶段 `fill-sku-image-links`(totalImages:0)、`normalize-description-image-modules` 全 skip。
- save-draft 被店小秘服务端拒:**「错误:服装类颜色属性必须上传3张图片」**。
- 这会卡住**所有**这批商品的 save→submit。

**待解方向**(需规划,根因在采集层):
- 采集时把页面图片 URL 存进 work item;**或**
- fill 阶段从当前编辑页读现有图片填到 SKU/颜色变体。

## 真实写链路推进到哪

`dry-run ✅ → fill-draft ✅(含媒体)→ save-draft`(草稿多次真存进店小秘)。submit 被媒体门拦已突破,但 save-draft 现卡在「每色3图」(墙3)。

## 墙 3 修复的 headless 验证(2026-06-30)

`fetchProductImagesFromEditJson` 的核心假设(`edit.json` 暴露每色图 URL)已用只读探针 [probe-editjson-images.ts](../apps/automation/src/probes/probe-editjson-images.ts) 在 4 个真实商品上验证 ✅:每色 6-7 图,去重后 10-15 张,远超「每色3图」下限,URL 是真实 pddpic/alicdn CDN。所以图片恢复对这批「页面引用型」商品确实能拿到图。

**但这只证明「图能捞到」,不证明「save 能过」**——按既往真跑实锤,save 真正撞的是 variant-remap `rowsAfter=0`(「主题颜色至少需要选一个」),颜色变种行没物化。完整 fill→save 真跑是 operator-attended(headed 浏览器、~15-20 分钟/件、headed 窗口只在操作者屏幕),需操作者在场才能继续。

> 同次发现并修复了一个**服务端启动崩溃**:`planner.ts` 的 `DIANXIAOMI_PLACEHOLDER_CATEGORY_LABELS` 在 TDZ 里(顶层 work-item readiness 重建早于该 const 声明),6-29 品类回填把 work item 写进持久态后触发,server 自此无法启动。已 hoist 修复(commit 7acf165)。

## 仍未做(非本次)

- A2 `browser-profile` 门:启动 daemon 时传 `profile=.runtime/playwright/dianxiaomi-real-profile`(已登录、无 SingletonLock)。
- snapshot/diagnose 输出路径 bug:落在 `apps/automation/output/playwright/` 而非项目根 `output/playwright/`(服务校准门只扫后者)。本次靠手动 copy 绕过;根治是给 `snapshot.ts`/`snapshot-diagnose.ts` 加 `getRepoRoot()`(参照 `selector-config-generate.ts` 已修写法)。

## 运维提示

- Playwright headed 子进程不干净退出会留 `ms-playwright\chromium` 僵尸进程占 profile,但不一定有 SingletonLock。新 launch 卡死时,按可执行路径含 `ms-playwright` 杀(**不碰 Google Chrome**)。
- 每个 full-flow 阶段都重新打开页面 + 重做变体重映射,单商品(变体多时)full-flow ~15-20 分钟,慢但正常。

## 终局:单品全链实锤(2026-07-03 晚)

商品 `id=161406453047896424`(~7 SKU)经 `POST /automation/queue-run`(`submitAfterSave=true`)在真实店小秘页面跑完全链:

- save-draft:店小秘返回**「您的产品编辑成功!」**(墙 3「每色3图」、墙 4「主题颜色」均未触发;`fetchProductImagesFromEditJson` 图片恢复真实生效)。
- submit-listing:第 1 次尝试成功,店小秘返回**「产品已提交发布,请在「发布中」、「发布失败」或「在线产品」中查看!」**,`publishOutcome.status=succeeded`。
- 证据:`.runtime/automation-artifacts/automation-full-flow-2026-07-03T19-49-49-946Z/`(截图 + 结构化报告)。

**遗留边界**:
- 墙 4 只在小 SKU 商品上验证。322 SKU 的 `161406453261437092` 在 variant-remap 阶段 OOM 崩溃(本机 ~2GB 空闲内存),复杂商品未验证。
- 墙 2 image-editor 第二层仍未真修,默认媒体白名单继续排除 image-editor。
- server 别用 `tsx watch` 跑(热重载杀 full-flow 子进程);`POST /automation/full-flow` 只带 `url` 会 409,统一走 `queue-run`。

下一战:limit=3 真实试跑([sprint-plan-to-usable.md](sprint-plan-to-usable.md) A4)。
