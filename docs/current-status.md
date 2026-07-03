# Current Status

Updated: 2026-07-04

## 当前卡点（先看这里）

**写链路天花板已在单品上打通（2026-07-03 晚，真实页面实锤）**：商品 `id=161406453047896424`（~7 SKU）经 `queue-run`（`submitAfterSave=true`）跑完 `dry-run → fill-draft（含 image-translation + batch-resize）→ save-draft（「产品编辑成功」）→ submit-listing（「产品已提交发布」，publish state: publishing）`。证据：`.runtime/automation-artifacts/automation-full-flow-2026-07-03T19-49-49-946Z/`。三道墙在该商品上全部未触发：

1. **墙 4 主题颜色/变种行** —— 该商品 `normalize-skc-pricing` skipped（本就一致），save 未被拒。**注意**：大 SKU 商品（322 SKU 的 `161406453261437092`）在 fill 阶段 variant-remap 时 OOM 崩溃，未验证；墙 4 对复杂商品是否真解仍未知。
2. **墙 3 每色 3 图** —— `fetchProductImagesFromEditJson` 图片恢复真实生效，`fill-sku-image-links` done，save 未被「每色3图」拒。
3. **墙 2 image-editor 第二层** —— 仍未真修，默认媒体工具白名单维持 `image-translation` + `batch-resize`（不含 image-editor），该配置下媒体门通过。

**下一步就是唯一里程碑**：limit=3 真实试跑全绿 → 解锁「开始无人值守」（[sprint-plan-to-usable.md](sprint-plan-to-usable.md)）。已知约束：本机内存紧（~2GB 空闲），优先挑小 SKU 商品；server 别用 `tsx watch` 跑（热重载会杀 full-flow 子进程）。

代码健康快照（2026-07-04 实测）：全 workspace typecheck ✅、server+shared+extension 测试 ✅；`automation-runner.ts` 6077 行（已抽 6 个子模块）、`planner.ts` 4694 行、`dianxiaomi-adapter.ts` 15371 行、`App.tsx` 4466 行；存储已是 `node:sqlite`；已 `git init`（本地、无 remote）。

## Completed In This Iteration

- 内容生成接入真实大模型（此前为 mock/规则化）：
  - 新增 [`packages/shared/src/llm-content.ts`](../packages/shared/src/llm-content.ts) `enhanceListingDraftWithLlm`，用 Node 内置 `fetch` 直连 OpenAI 兼容 `/chat/completions`，零新依赖（DeepSeek/Qwen/OpenAI/vLLM 通用）。
  - 只接管标题/卖点/描述三项文案；定价、SKU、attributes、categoryPath 仍确定性生成。
  - 只在交互式重规划 `planTaskForProduct`（`POST /plan/:productId`）生效；无人值守队列/恢复批跑（automation-runner 核心）保持同步+规则化，不引入每件一次的网络依赖。
  - 优雅回退：未配 `LLM_API_KEY` → 与今天行为字节级一致；调用失败/超时/解析失败 → 回退规则草稿并附 `level:low` 的 `risk-llm-fallback`。
  - 通过：shared/server/dashboard typecheck、server+shared 测试、boot 冒烟、三分支（未配/成功/失败）验证。
  - 环境变量：`LLM_API_KEY` `LLM_BASE_URL` `LLM_MODEL` `LLM_TIMEOUT_MS`（见 CLAUDE.md §6 / docs/content-generation.md）。

- Dianxiaomi automation target-url safety is stricter now:
  - `help.dianxiaomi.com` help-center URLs are rejected as automation targets
  - plain Dianxiaomi home/workspace URLs are no longer treated as real product edit targets for auto-return
  - login/profile reuse can still open the Dianxiaomi workspace, but the runner now waits for a real product edit page instead of bouncing into help pages
- Dianxiaomi `图片检测` feedback now preserves categorized image issues when available:
  - `image-management` instant-action failures can carry structured issue buckets such as `轮播图 尺寸` or `产品图 比例`
  - snapshot enrichment merges those issue details back into the work item `snapshot.imageCheck.issues`
  - requirement checks now surface concrete image-check issue summaries instead of only a generic "not confirmed"
  - repair-plan generation can now split required image repairs by categorized image-check issue and map them to the nearest fixed tool path (`batchResize`, `imageTranslation`, `whiteBackground`, `imageManagement`)

- Default unattended scope selection now supports both dimensions the operator actually needs:
  - store scope
  - product scope (`ready` queue / specified Dianxiaomi product links / source buckets)
- Shared/server/dashboard now pass structured queue scope end to end:
  - `itemUrls`
  - `sourceBuckets`
  - queue-run results persist the requested scope for later health/audit filtering
- Added shared automation-scope helpers so store filtering and product filtering use one normalization path instead of separate ad hoc logic in server and dashboard.
- Default dashboard entry now includes minimal scope controls only:
  - choose store
  - choose product scope mode
  - paste Dianxiaomi product links when needed
  - check source buckets (`collection-box`, `pending-publish`, `listing-draft`) when needed
- Queue daemon health, unattended startup check, default queue-run, recovery, and manual-budget validation actions now all honor the selected product scope instead of only store scope.
- Source-bucket capture is now structured, not only inferred from loose text:
  - `DianxiaomiCollectedProduct.sourceBucket`
  - `DianxiaomiProductWorkItem.sourceBucket`
- Browser extension real-page admission now detects explicit Dianxiaomi source states:
  - `collection-box`
  - `pending-publish`
  - `listing-draft`
  and uploads `sourceBucket` with collected products/work items.
- Added a real-page admission calibration runner: `npm run admission:calibrate --workspace @temu-ai-ops/automation -- --url="<real Dianxiaomi page>"`. It launches Chromium with the built unpacked extension, clicks the injected `加入队列` action on the live page, and verifies the server stored:
  - collected product `sourceBucket`
  - work item `sourceBucket`
  - work item `pageProfile`
  - page-linked real-page notes (`page profile key`, `source bucket`)
- Real admission calibration was executed against `https://www.dianxiaomi.com/web/popTemu/edit?id=161406453047896278` with the live logged-in profile. The stored Dianxiaomi work item now updates in place with:
  - `storeName: Source Dream shop`
  - `pageProfile: 待发布编辑页`
  - `sourceBucket: pending-publish`
- Admission queueing on real Dianxiaomi pages now waits for the page to become stable before uploading:
  - visible Dianxiaomi loading overlays must clear
  - scan results must stabilize across multiple polls
  - pricing pages (`pending-publish`, `listing-draft`, `product-edit`) must expose editable price fields before the extension will queue the item
- Re-ran live admission calibration on the same real product after the readiness fix. The false `priceFieldCount = 0` / `needs-revision` path is gone; the live work item now returns to `ready-for-automation`.
- Real-page SKU admission extraction is now aligned to the actual Dianxiaomi tables:
  - primary SKU rows come from the `variationSku + price` table
  - stock is joined back from the separate stock table by shared row prefix
  - aggregate live snapshot on `2026-06-10` now reads `skuCount: 5`, `priceFieldCount: 5`, `stockFieldCount: 5` instead of the earlier noisy over-counts
- Live admission sampling now excludes the injected extension panel, footer/copyright chrome, loading/spinner images, and other non-product artifacts. This removed the false positive `copyright` compliance block that the old body-wide sampler could create on real pages.
- Source-bucket filtering now prefers explicit uploaded `sourceBucket`; raw page text and page-profile text remain only as fallback for older stored items.
- Server regression coverage now includes scoped queue-run cases for:
  - selected store + selected source bucket
  - selected store + specified item URL
- Verification completed:
  - `npm run typecheck --workspace @temu-ai-ops/shared`
  - `npm run typecheck --workspace @temu-ai-ops/server`
  - `npm run typecheck --workspace @temu-ai-ops/dashboard`
  - `npm run test --workspace @temu-ai-ops/server`
  - `npm run build --workspace @temu-ai-ops/dashboard`
  - `npm run build --workspace @temu-ai-ops/extension`

- Real Dianxiaomi publish calibration is now verified on the live Temu edit page `https://www.dianxiaomi.com/web/popTemu/edit?id=161406453047896278`. The automation can fill the product, open the green `发布` dropdown, click `立即发布`, and read the real Dianxiaomi submit feedback instead of only clicking the outer button.
- Real Dianxiaomi size-chart handling is verified on the same live page. The automation can open the existing size-chart modal, inspect metric values, reuse the saved template path when needed, confirm the modal, and continue to save/submit verification.
- Real Dianxiaomi image-tool discovery now recognizes the live page structure instead of only fixture/demo selectors. The runtime can now detect:
  - top-level `一键翻译`
  - top-level `图片检测`
  - image-module dropdown `批量改图片尺寸`
  - image-module dropdown `批量编辑`
  - image-module dropdown `图片翻译`
- Unattended `batch-resize` now has a dedicated real-page path. On the live Dianxiaomi batch-resize modal it can:
  - open the image-module dropdown
  - choose `批量改图片尺寸`
  - confirm `等比例调整`
  - confirm `图片小边`
  - fill `1785`
  - ensure `选择全部`
  - click `生成JPG图片`
  - capture before/after screenshots and structured tool feedback
- Real submit is now blocked safely when unattended media processing fails. Instead of crashing into the publish button with an open modal, the runner records `write-blocked-media-processing` and stops before `发布`.
- Live calibration proved the current real blocker is not selector drift but Dianxiaomi account capacity: batch resize failed with `图片空间不足`. This is now classified as `media-processing` with `failureKind=storage-quota`, `retryable=false`, and a manual-budget repair action instead of an auto-retry path.
- Server-side failure routing now distinguishes image-space quota from transient media failures. `storage-quota` creates a manual repair plan (`释放店小秘图片空间`) and pauses default unattended actions; transient media failures still stay in the retryable media bucket only when the report explicitly marks them transient.
- Task generation for Dianxiaomi work items now preserves linkage metadata on `task.draft.attributes` again (`dianxiaomiWorkItemId`, `dianxiaomiPageUrl`, `dianxiaomiRequirementPreset`, `dianxiaomiCollectedProductId`), restoring downstream server test expectations and keeping runner-side linkage available from the draft payload.

- Unattended startup now has a dedicated `dianxiaomi-session` gate. If the latest selector diagnosis, blocked work item, or queue audit shows `login-or-captcha`, unattended startup stays blocked until a newer real Dianxiaomi diagnosis proves the logged-in profile is healthy again.
- Queue daemon health, alerts, and recommendation priority now surface session loss as a first-class blocker. `resolve-login-or-captcha` is raised before normal queue/resume guidance, so the default unattended path does not keep trying to run with an expired Dianxiaomi session.
- Queue daemon activation and queue-level startup prechecks now stop on unresolved Dianxiaomi login/CAPTCHA signals, not only on missing profile/config/calibration blockers.
- Server regression coverage now verifies both sides of the new session gate: unattended startup is blocked after a login/CAPTCHA blocker, and a newer real-page diagnosis clears the block.
- Server smoke tests no longer depend on fixed port `18987`. `apps/server/test/automation-safety-smoke.ts` now allocates a free localhost port automatically unless `SMOKE_PORT` is explicitly provided, preventing false failures when another local server is already running.
- Browser extension build is now real instead of a placeholder. `npm run build --workspace @temu-ai-ops/extension` validates the MV3 manifest shape, verifies manifest-referenced files, runs JS syntax checks, copies `manifest.json`, `src`, and optional `assets` into `apps/extension/dist`, and writes `build-info.json` for install/debug visibility.
- Chrome/Edge unpacked extension loading should now use `apps/extension/dist` after the extension build step.
- Browser extension injected panel now follows the same low-intervention rule as the dashboard. The default surface shows only `状态`, `告警`, and `动作`; scan details, AI title, execution steps, feedback logs, and debug upload stay collapsed under `高级信息`.
- The injected panel styling was reduced from a card-heavy promotional look to a compact operational overlay with smaller spacing, stable two-column action buttons, bounded width, no horizontal overflow, and disabled states while automation is running.
- Browser extension panel now links to unattended backend status. It loads `/automation/queue-daemon/health` and `/dianxiaomi/product-work-items` through the extension background worker, then shows `守护进程`, `队列`, `当前商品`, and field recognition status directly on the injected page panel.
- Current Dianxiaomi page matching now compares the page URL with queued work item URLs. The panel can show whether the current product is `等待自动跑`, `需要改造`, `已阻塞`, `已发布到核价`, or still `未入队`; blocker/failure diagnosis messages are promoted into the compact alert area.
- Browser extension queue admission now uses the server-returned Dianxiaomi work item `requirements`, `suggestedEdits`, and `status` after clicking `加入队列`. The default panel adds a compact `准入` row, shows `通过，等待自动跑` or `未通过，缺 n 项`, and promotes up to three required missing items into the alert area.
- Full admission details stay under `高级信息 > 准入结果`, so operators can see missing image/title/SKU/attribute/price/stock/compliance requirements without expanding the daily default surface unless troubleshooting is needed.
- Selector calibration now has an optional media-action sampling mode. When enabled, it opens only allowlisted Dianxiaomi native media tool entries, samples visible dialog/button context for apply/close selector recommendations, and closes the dialog without clicking internal apply/save controls.
- Selector calibration media-action sampling accepts a media tool allowlist. Non-allowlisted tools are recorded as skipped, so calibration can focus on image translation, batch resize, white background, image editor, or image management without touching every entry on the page.
- Smoke coverage now runs selector calibration with media-action sampling enabled and verifies sampled allowlisted tools plus skipped non-allowlisted tools.
- Dashboard daily mode has been reduced to a single unattended console by default. The first screen now shows start/pause, current run state, ready/failed/edited counts, the latest run/task summary, and the main blocker; calibration details and product lists are hidden behind `查看详情`, while the full diagnostic workspace remains behind `高级诊断`.
- The daily unattended console now includes a `生产校准` action. It starts selector calibration in headed mode with media-action sampling enabled for image translation, batch resize, white background, and image editor; the sampling path only opens, inspects, and closes media tool surfaces, and does not click internal apply/save controls.
- The daily unattended console now includes a `小批量试跑` action. It runs a one-time queue batch with the production media tools, `submitAfterSave=true`, and `limit=3`, so the first real-page validation can process only a few ready Dianxiaomi products without enabling the long-running queue daemon.
- The daily unattended console now gates `开始无人值守` behind the latest `limit=3` trial run. The long-running daemon button stays disabled until the trial run queued at least one product, skipped none, and every related full-flow job completed successfully.
- The daily trial gate now shows compact acceptance details directly on the home screen: queued, completed, running, failed, skipped, plus up to three failed/skipped item reasons. Operators can see whether the trial is still running, blocked, or safe to expand without opening advanced diagnostics.
- The daily trial gate now also shows a single recovery recommendation. It classifies the latest small-batch trial failure into login/CAPTCHA, real-page calibration, selector config, target surface, media processing, publish validation, browser profile, auto-retry, or unknown, then shows the next actions directly on the home screen so operators do not need to inspect logs first.
- Manual `小批量试跑` now releases safe `autoRetryRecommended=true` blocked Dianxiaomi work items before selecting ready items, and returns the released ids in the queue-run result. This makes the home-screen "可自动重试" recommendation executable without requiring the long-running daemon to be started first.
- The daily home screen now detects core backend connection failures and promotes them to `服务未连接`. Start, calibration, and trial actions stay disabled until the server responds, and the startup metric changes from vague `检查中` to `离线`.
- Full-flow completion now immediately resolves its source Dianxiaomi work item. Completed flows keep the item `edited`; failed flows mark it `blocked` with a structured failure diagnosis, so manual trial runs and daemon runs feed the same home-screen recovery recommendation.
- Full-flow completion now also enriches the source Dianxiaomi work item snapshot from the finished automation reports before writing the final status:
  - applied media-tool results from `media-processing-plan` are merged back into `snapshot.mediaToolSignals`
  - successful `image-management` instant actions now set `snapshot.imageCheck.passed = true`
  - requirements / suggested edits are rescored while preserving the flow-resolved `blocked` / `edited` status

- Automation reports now start with a `target-surface` page identity gate. It records the current URL, title, host, whether the page is a real Dianxiaomi host, whether it is only the local dry-run fixture, whether login/CAPTCHA text is present, and counts for title/description/SKU/price/stock/save/submit/media/editable signals.
- The local `data:` page used in smoke tests is now explicitly labeled as `fixture`; it is not treated as a real Dianxiaomi page in reports.
- Dry-run no longer waits indefinitely on an empty or wrong page. It writes a failed report with the detected `surfaceStatus` and stops after the target-surface step.
- Fill-draft, save-draft, and submit-listing now have a hard write gate before any field fill, save, or publish click. If the page is not recognized as a safe Dianxiaomi listing edit surface, the report records `write-blocked-wrong-surface` and no write action is attempted.
- Dashboard automation report cards and preflight now surface the target page status, write permission, URL/title, Dianxiaomi-host flag, fixture flag, and field counts so it is visible when the browser is on the wrong/empty page.
- Selector calibration now also records the `target-surface` result inside snapshot and diagnosis reports. Selector workbench shows the calibration page status, and selector validation blocks if the latest diagnosis came from a wrong/empty/non-listing page.
- Selector config generation now rejects a blocked target-surface diagnosis with HTTP 409 instead of generating selectors from an invalid page.
- Server-side selector diagnosis scanning can be scoped with `SELECTOR_DIAGNOSIS_DIRS`; smoke tests use this to avoid stale diagnosis artifacts from previous runs affecting the current run.
- Default selector diagnosis scanning now ignores `.runtime/automation-safety-smoke` and `.runtime/automation-runner-test`, so historical smoke artifacts do not become the dashboard's latest production calibration. Tests still opt in to those directories with `SELECTOR_DIAGNOSIS_DIRS`.
- Dianxiaomi media tool selector calibration is wired end to end.
- Snapshot collection captures button text, aria/title metadata, nearby text, SKU rows, and stable text-based selector hints.
- Snapshot diagnosis detects native Dianxiaomi media tools: image translation, white background, image editor, batch resize, and image management.
- Selector config generation and server-side selector config save/diff/version restore now include `mediaTools`.
- Dashboard selector workbench can review, select, diff, save, and restore media tool selectors.
- Automation dry-run inspects configured/native media tool entries and reports media tool availability.
- Fill-draft and save-draft keep media handling as `plan-only` by default, so existing write flows remain non-clicking unless a stronger media mode is selected.
- Media tool safety planning is now included in dry-run, fill-draft, and save-draft reports.
- Media safety reports include `safeMode`, `manualConfirmationRequired`, `wouldClick`, page dialog/image counts, and a per-tool safety item.
- Media tool execution is blocked in reports when an open dialog is detected.
- Automation launch input now supports `mediaAutomationMode` and `mediaAutomationTools`.
- Dashboard automation presets and launch params can choose `plan-only`, `unattended-open`, or `unattended-apply` media automation.
- `unattended-open` can open allowlisted Dianxiaomi media tool entries without human confirmation, capture an after-open screenshot, and stop before internal apply/save actions.
- `unattended-apply` can open allowlisted Dianxiaomi media tool entries, detect safe internal apply buttons, click them, capture open/before/after screenshots, and return to the listing editor.
- `unattended-apply` now verifies native media tool feedback after each internal apply. Per-tool reports include `feedbackState`, `feedbackMessage`, and `feedbackSource`; failure or unknown success feedback marks the tool `apply-failed`.
- `unattended-apply` now verifies that the opened media surface matches the intended Dianxiaomi tool before clicking any internal apply/save control. Per-tool reports include `surfaceState`, `surfaceMatchedKeyword`, and `surfaceText`; missing or mismatched media surfaces mark the tool `apply-failed`, close the surface if possible, block later media tools, and prevent later save/submit.
- Media tool execution now stops after the first native media processing failure. Later allowlisted tools are reported as `blocked-by-media-failure` and are not clicked.
- `plan-only` remains the default media mode for fill/save flows, but `unattended-apply` is now a hard gate. When Dianxiaomi media processing fails or opens the wrong tool surface, the runner records `write-blocked-media-processing` and stops before save-draft or submit-listing.
- Smoke coverage now includes simulated Dianxiaomi dialogs for image translation, white background, image editor, batch resize, and image management. It verifies that `unattended-apply` can process all allowlisted tools in sequence, capture open/before/after screenshots for each tool, close each dialog, and return to the listing editor without touching publish/submit.
- Smoke coverage now also simulates a failed batch resize feedback path. It verifies the failure reason is captured, later media tools are blocked, `write-blocked-media-processing` is emitted, and the save-draft runner does not click save after media processing fails.
- Smoke coverage now simulates a wrong media surface after clicking a tool entry. It verifies the mismatch is captured in the media plan, later media tools are blocked, `write-blocked-media-processing` is emitted, and save-draft does not click save.
- Server and dashboard now expose a `full-flow` automation launcher that chains dry-run, fill-draft, unattended media apply, and save-draft as one background job.
- Full-flow can optionally append `submit-listing` after save-draft with `submitAfterSave=true`. This clicks the Dianxiaomi submit/publish control and moves the item toward the platform pricing review / 核价 stage.
- Server and dashboard also expose a standalone `submit-listing` launcher. It is blocked until a matching same-target save-draft job has completed successfully.
- `submit-listing` now verifies the Dianxiaomi publish result instead of only clicking once. It clicks publish, handles a visible confirmation dialog when present, waits for Dianxiaomi success/failure feedback, retries failed attempts up to `submitMaxAttempts` times, and records every attempt plus the final failure reason in the execution report.
- Dashboard automation launch params include `Submit attempts` with a default of `3`.
- Full-flow jobs expose ordered stage status, child automation job ids, report paths, report status, target fingerprint, and artifact directory.
- Server and dashboard now expose a `queue-run` launcher that takes `ready-for-automation` Dianxiaomi work items, creates automation tasks, exports task files, starts full-flow jobs, and marks queued work items `edited` to avoid duplicate starts.
- Queue-run inherits the same `submitAfterSave` switch, so batches can stop at save-draft by default or submit through Dianxiaomi when the launch preset enables it.
- Server and dashboard now expose a queue daemon for unattended runs. It can start/pause from the dashboard, run one queue tick immediately, repeat on an interval, keep recent tick history, and pause automatically after a configurable number of consecutive failed queue ticks.
- Queue daemon launch parameters reuse the normal automation params, including media automation mode, `submitAfterSave`, `submitMaxAttempts`, batch limit, interval seconds, and max consecutive failures.
- Queue daemon state is now persisted to `.runtime/data/queue-daemon-state.json`. When the server starts, it restores the last daemon configuration, status, tick history, and schedules the next run again if the daemon was active. Stale in-progress ticks are not restored as running.
- Queue daemon ticks are now classified as `ready-queued`, `idle-no-items`, `work-item-skipped`, `running-lock`, `selector-blocked`, `task-export-failed`, `target-surface-blocked`, `startup-check-blocked`, `login-or-captcha`, `publish-validation-failed`, `system-error`, `daemon-paused`, `tick-already-running`, or `flow-outcome-recovered`. Normal idle ticks with no ready work items do not increment consecutive failures; real skipped/error categories still can pause the daemon after the configured threshold.
- Queue daemon skipped/error classification now includes `target-surface-blocked` for wrong-page, empty-page, or non-listing-edit-surface failures.
- Queue daemon ticks now run a queue-level startup precheck before creating a queue-run. If ready work exists but the latest selector calibration is a blocked target surface, selector config is invalid, the configured Dianxiaomi browser profile is missing/locked, or the failure budget is exhausted, the tick is skipped with `target-surface-blocked`, `selector-blocked`, or `startup-check-blocked` and counts toward the daemon failure budget. Empty queues remain `idle-no-items`.
- Smoke tests now run with isolated `PLANNER_STATE_PATH`, `QUEUE_DAEMON_STATE_PATH`, `TASK_EXPORT_HISTORY_PATH`, and `SELECTOR_DIAGNOSIS_DIRS`. Test work items and exported smoke task files such as `work-smoke#rescan` can no longer leak into the real runtime planner state or task export history.
- Production Dianxiaomi work queue now blocks local fixture URLs and demo/smoke/example URLs by default. Test fixtures are allowed only when `ALLOW_DIANXIAOMI_SMOKE_URLS=true` is explicitly set for smoke tests.
- Automation launch now also blocks invalid Dianxiaomi URLs at the final start gate, including direct target URLs, Dianxiaomi URLs embedded in exported task files, missing task files, and unreadable task JSON. Historical smoke task files can no longer open the Dianxiaomi “page address invalid or missing” screen.
- Automation task-file export history now exposes `launchStatus` for each file. The dashboard shows ready/warning/blocked badges, hides blocked files by default, and disables loading blocked historical task files.
- Dashboard queue daemon history now shows each tick category alongside the status and reason.
- Queue daemon now tracks the full-flow jobs it starts and recovers their final outcomes on later ticks. Completed flows keep the Dianxiaomi work item `edited`; failed flows mark the source work item `blocked` with the automation failure note, so unattended runs do not leave failed publish attempts looking complete.
- Queue daemon state and dashboard now show tracked flow count, resolved flow count, recent recovered outcomes, and per-tick recovered outcome counts. Outcome-only ticks are classified as `flow-outcome-recovered` and do not count as daemon failures.
- Server and dashboard now expose queue daemon health at `/automation/queue-daemon/health`. It summarizes daemon status, consecutive failure threshold, last failed category, browser profile path/existence/possible lock files, ready/blocked/edited/needs-revision work item counts, unresolved tracked flows, and recent failed flow outcomes.
- Queue daemon health now includes an `alerts` array with operator actions for repeated failures, browser profile locks, missing/uninitialized profile setup, blocked work items, failed full-flow outcomes, and paused daemon with ready work.
- Dashboard automation controls now show a queue health card before queue daemon history, so unattended runs surface paused/blocked states, missing profile config, profile lock files, blocked work items, recent flow failures, and the next recommended operator action without opening logs.
- Server and dashboard now expose an unattended startup check at `/automation/unattended-startup-check`. It evaluates ready Dianxiaomi work items, selector config, task-file snapshot freshness, browser profile health, failure budget, blocked backlog, and provides a fixed runbook for safe unattended startup.
- The unattended startup check now includes `real-dianxiaomi-calibration`. It passes only when the latest selector diagnosis was captured on a real Dianxiaomi listing edit page (`surfaceStatus=real-dianxiaomi`, Dianxiaomi host, not fixture, inspectable), and now also blocks when that real calibration is stale by default after 24 hours. `REAL_DIANXIAOMI_CALIBRATION_STALE_MINUTES` can override the threshold within a guarded 30-minute to 7-day range. In production, local fixture calibration blocks the queue daemon before queue-run creation; smoke tests can still allow fixtures only when `ALLOW_DIANXIAOMI_SMOKE_URLS=true` is explicitly set.
- Startup-check calibration details now summarize very long fixture/data URLs instead of returning full embedded HTML URLs, keeping the dashboard responsive.
- Dashboard automation controls now show the unattended startup check before queue controls, including `canStart`, blocked/warning checks, normalized media/submit settings, a prominent real-Dianxiaomi calibration banner, and the runbook steps.
- Dashboard now opens in a simplified daily unattended workspace by default. Operators see only start/pause, daemon status, startup blockers, ready/blocked/edited counts, and short failed-product lists; the previous detailed control surface is hidden behind `高级诊断`.
- Daily unattended defaults now favor the intended production path: `mediaAutomationMode=unattended-apply`, image translation, batch resize, white background, and image editor tools enabled, with `submitAfterSave=true` in the dashboard daily start flow so saved Dianxiaomi drafts are submitted into the later Temu pricing review / 核价 stage. The lower-level server default remains conservative for direct API/script callers unless they explicitly pass `submitAfterSave=true`.
- Automation still does not bypass login, CAPTCHA, platform risk checks, or Temu-side pricing/final listing approval. The current write ceiling is Dianxiaomi submit into the later platform 核价 flow; Temu/platform-side核价确认 and final上架 remain manual.

- Blocked Dianxiaomi work items now persist a structured failure diagnosis. Queue skips and failed full-flow recovery classify common causes such as login/CAPTCHA, real-page calibration, selector config, target surface, task-file refresh, media processing, publish validation, browser profile locks, and unknown failures.
- The simplified daily workspace now shows a compact failure badge for blocked products, including whether the item is an automatic retry candidate, retry-after-fix, or manual-check state, plus the next action instead of forcing operators into logs.
- Queue daemon health now counts safe automatic retry candidates. Each daemon tick releases only `autoRetryRecommended=true` blocked items that still have a valid real Dianxiaomi URL and pass listing requirements, then lets the normal ready queue process them. Login/CAPTCHA, calibration, selector, media-processing, publish-validation, browser-profile, target-surface, and unknown failures remain blocked for manual/operator review.
- Unattended Dianxiaomi media apply reports now classify media failures with `failureKind` and `retryable`. Transient Dianxiaomi feedback such as temporary busy/try-again is marked retryable, while invalid image size, missing input, unsupported media, surface mismatch, missing apply controls, and return-blocked states remain non-auto-retry blockers.
- Unattended Dianxiaomi media apply now retries clearly transient native media-tool feedback inside the same opened tool before blocking the product. Each tool report includes `applyAttempts`, `maxApplyAttempts`, and `feedbackAttempts`; only transient busy/try-again/network/rate-limit style feedback is retried, while invalid media, missing input, unsupported media, surface mismatch, missing apply controls, and return-blocked states still stop immediately.
- Selector config now supports optional `mediaToolActions.apply` and `mediaToolActions.close` selectors for each Dianxiaomi native media tool. `unattended-apply` uses these configured selectors inside the opened media dialog before falling back to keyword matching, which lets real Dianxiaomi image translation, batch resize, white background, image editor, and image management dialogs be hardened without adding daily operator controls.
- Selector calibration snapshots now record dialog context for buttons, including dialog selector, label, and text. Diagnosis and selector config generation can recommend `mediaToolActions.apply` and `mediaToolActions.close` selectors from already-open Dianxiaomi media dialogs, and the advanced selector workbench can review/save these recommendations without changing the simplified daily workspace.
- Queue daemon recovery now reads the failed stage execution report before writing the blocked work item diagnosis. Media failures carry the failed tool, `failureKind`, retryability, and Dianxiaomi feedback into the product failure note instead of relying only on a generic full-flow error string.
- Queue daemon start now performs the same hard startup gates before activation. If real Dianxiaomi calibration, selector config, missing/uninitialized Dianxiaomi browser profile, browser profile locks, or the failure budget blocks startup, the daemon remains `PAUSED`, records `lastError`, and does not schedule a pointless tick. Recovery candidates no longer bypass blocked startup.
- Blocked Dianxiaomi work items now have a safe `retry-after-fix` requeue path. It only moves a product back to `ready-for-automation` when the item is still on a valid real Dianxiaomi edit URL, passes required listing checks, and its structured failure category is a fixable retry class such as media processing, publish validation, browser profile, or task-file refresh. Login/CAPTCHA, real-page calibration, selector config, target-surface, invalid URL, and unknown failures remain blocked.
- The simplified daily details panel now shows a small `修复后重试` action only beside eligible failed products. The button keeps recovery focused: after the operator or automation fixes the underlying product issue in Dianxiaomi, the item can be returned to the ready queue without opening the advanced diagnostics surface.

- Dianxiaomi work items now persist a structured repair plan. The plan combines listing requirement gaps and automation failure diagnoses into actions such as refreshing stale task files, retrying transient media-tool failures, reviewing invalid images, fixing publish-required fields, clearing browser profile locks, recalibrating selectors, or replacing invalid target URLs.
- Repair plans classify each failed item as `auto-ready`, `assisted`, `manual`, or `blocked`, and expose whether it can be auto-repaired or retried after repair. The daily failed-product list shows only a compact repair summary so operators can see the next step without opening logs or the advanced workspace.
- Queue runs and queue daemon ticks now release safe recovery candidates from `auto-ready` repair plans, not only legacy `autoRetryRecommended` failures. The release gate remains narrow: the item must be blocked, listing-ready, on a valid Dianxiaomi product edit URL, and its repair actions must be automatic safe actions such as refreshing a stale task file or retrying a transient media-tool failure. Invalid media, publish-required fields, login/CAPTCHA, selector calibration, target-surface, and unknown failures stay blocked.
- Publish-validation failures now parse common field targets from Dianxiaomi feedback. Missing required attributes such as `Color` or `材质`, SKU/variation issues, main-image requirements, title, price, and stock messages become specific assisted repair actions instead of a generic publish failure. These actions remain non-auto-release until the product is fixed and retried.
- Repair actions now include executable payload metadata for the later field-repair runner: writer type (`fill-single-field`, `fill-attributes`, `fill-sku-pricing`, `run-media-tool`, `refresh-task-file`, `clear-browser-profile`, or `manual`), selector group/key, field kind, attribute key, SKU mode, media tool, and reason code. The daily failed-product summary shows the target and writer in one compact line.
- Added the first browser-backed repair execution layer as `repair-preview`. It exports a repair plan file for a failed Dianxiaomi work item, opens the matching product edit page through the existing Playwright runner, and verifies that the planned field/SKU/media-tool targets can be found without writing values, clicking publish, or applying media changes.
- `repair-preview` is now available through server APIs and runner readiness checks, can be inserted into full-flow jobs when a repair plan file is present, and reports its own execution artifacts with `dianxiaomi-repair-preview-*` reports. Queue daemon classification now recognizes repair-preview failures separately from publish or target-surface failures.
- Repair preview export is side-effect safe: exporting a preview task keeps the original failed work item blocked and preserves its repair plan, so diagnostics cannot accidentally release or mark a product as edited.
- Added `repair-apply` as the controlled repair executor. It uses the same exported task file and repair plan, then applies only narrow safe actions on a recognized Dianxiaomi edit page: known title/description/price/stock values, SKU price/stock from task data, specific attributes that already have a known value, and allowlisted Dianxiaomi media tools.
- `repair-apply` is intentionally separate from full-flow save/submit. The runner starts with `--repair-mode=apply`, `--review=true`, `--save-draft=false`, and `--submit=false`, so it can repair fields or media surfaces but will not click save, publish, Temu approval, or final listing controls.
- Server APIs now expose `POST /automation/repair-apply`, `POST /dianxiaomi/product-work-items/:id/repair-apply`, and repair-apply job/log endpoints. Preflight and the simplified dashboard surface repair-apply readiness and latest job status without adding a large manual control panel.
- Smoke coverage now includes a browser-backed `repair-apply` fixture. It verifies title, description, a known attribute, SKU price/stock, and one allowlisted media tool are repaired; manual actions are skipped; non-allowlisted media tools are not applied; and no save-draft or submit-listing step appears in the report.
- Dashboard default mode now treats `无人值守主流程` as the only normal entry. Manual entry, review, repair, selector, import, and raw automation controls remain under `高级区`, which is collapsed by default.
- The daily dashboard is now limited to three information groups: `状态`, `告警`, and `动作`. The status group uses the main-path KPIs `自动通过率` and `单品人工触发`, plus queue/startup state. Trial-run details are hidden behind `验收明细`.
- `repair-*` is now presented as fault recovery only. Repair readiness and repair jobs stay in advanced/preflight surfaces and are explicitly excluded from daily main-path KPI.
- Added `docs/operating-principles.md` to lock the product rules: manual step budget, AI reduced-manual-work admission gate, default-entry constraints, and KPI definitions.
- Added `recovery-run` as an advanced fault recovery batch. It selects only blocked `auto-ready` repair plans with browser-executable automatic actions, runs `repair-preview`, then `repair-apply`, then reruns normal `full-flow` without a repair plan file so Dianxiaomi save/publish is verified again.
- Recovery batches skip task-file refresh, browser-profile cleanup, login/CAPTCHA, selector calibration, wrong-page, assisted, and manual repair plans. These remain outside the browser recovery loop and keep their existing startup/manual-budget gates.
- Dashboard advanced automation controls now show `Run recovery (n)` and recent recovery-run cards. The simplified daily `无人值守主流程` remains unchanged.
- Added `docs/recovery-run.md` with scope, flow, API, and dashboard behavior.
- Queue daemon policy now distinguishes direct safe retry candidates from browser recovery candidates. Browser-executable repair plans are no longer released straight back to the normal ready queue; the daemon starts a `recovery-run` tick first when startup gates pass.
- Queue daemon ticks now record `recoveryRun`, `lastRecoveryRunId`, and category `recovery-run-started`. Recovery-started ticks are treated as successful fault-recovery ticks, not daily main-path failures.
- Queue daemon health now reports `safe retry` and `browser recovery` counts separately, and the dashboard queue health/history shows recovery-run ids without adding them to the default daily dashboard.
- Full-flow jobs now carry a source (`direct`, `queue-run`, or `recovery-run`). The daily `自动通过率` KPI excludes recovery-run full-flow jobs so `repair-*` remains fault recovery only.
- Recovery-run history now persists to `.runtime/data/recovery-runs.json` by default, with `RECOVERY_RUN_HISTORY_PATH` available for isolated runtime/test folders. Recent recovery batches survive server restarts and stale restored `running` batches are normalized to failed history instead of hanging.
- Queue daemon health now derives repeated automatic recovery failures from persisted recovery-run history. If the same product or browser repair action fails at least twice, health exposes a compact `repeated-recovery-failures` warning and the simplified daily dashboard shows one alert while detailed recovery logs stay in `高级区`.
- Selector diagnosis lookup for queue health/startup checks no longer recursively scans the whole `.runtime` tree by default. It now scans bounded production calibration/report directories, while tests can still opt into isolated directories with `SELECTOR_DIAGNOSIS_DIRS`; this keeps the default dashboard health poll responsive even with large automation history.
- Queue daemon now enforces a recovery failure budget. Browser recovery candidates that repeatedly fail are excluded from unattended recovery runs and counted as `pausedBrowserRecoveryCandidates`; they are released only after the product/repair plan changes or, for action-level failures, real selector/media calibration is rerun.
- Dashboard advanced recovery stats now show `暂停恢复` separately from runnable `浏览器恢复`, so operators can see when automation is deliberately avoiding a known bad recovery path without adding controls to the default daily page.
- Recovery pause release events are now recorded in the same persisted recovery history. Queue health exposes recent `recovery.releases`, and the advanced health card shows which product/action was released and whether it came from a work-item update, repair-plan regeneration, or selector/media recalibration.
- Queue daemon now routes released recovery pauses through a bounded `released-retry` lane before normal browser recovery. Released candidates are counted as `releasedBrowserRecoveryCandidates`, listed under `recovery.releasedRetryCandidates`, and daemon ticks run at most one released item per `recovery-run` with `recoveryPolicy="released-retry"`.
- Dashboard advanced recovery/health surfaces now show `released retry` separately from normal browser recovery and paused recovery. The default daily page remains unchanged.
- Dashboard active-task polling now reads `/tasks/active` without the approved-only conflict response. The Dianxiaomi sync button remains gated by `approved` plus `canPublish`, but the default dashboard no longer emits a harmless 409 network error while waiting for review.
- Released retry now has a result closure summary. Queue health exposes `recovery.releasedRetryOutcomes` with the latest released retry run, item status, failure reason, next state, and next action.
- Recovery release events are now one-use gates. If a released retry fails again, the same product update, repair-plan regeneration, or selector/media calibration cannot release that newer failure; same-action candidates pause until a newer release event exists.
- Queue daemon health now includes an audit summary at `audit.recent`. It derives from persisted tick history and explains each recent unattended decision: skipped, startup-blocked, recovery-started, queue-started, outcomes-recovered, idle, or failed, including subject, reason, linked queue/recovery run ids, work item ids, whether it counts as a failure, and the next action.
- Dashboard advanced queue health now shows the recent audit entries. The simplified daily `无人值守主流程` remains limited to status, alerts, and actions.
- Released retry now exposes an explicit compact batch policy in queue health at `recovery.releasedRetryBatch`. It reports `maxItemsPerTick`, pending released retry count, the next bounded work item ids, and whether normal browser recovery is being held while released retry drains.
- Dashboard advanced queue health now shows the released retry policy, so operators can confirm released products are retried in small bounded batches before normal unattended recovery resumes.
- Extension panel fixture now returns a real `repairPlan` after `加入队列`. The default status group shows only the compact `改造 可自动处理（2 项）` conclusion, while the detailed media/attribute repair actions remain under collapsed `高级信息`.
- Added `apps/extension/scripts/check-panel-fixture.mjs`. It serves the extension fixture, opens it with Playwright, clicks `加入队列`, verifies `状态 / 告警 / 动作`, checks the compact repair conclusion, confirms detailed repair action text is hidden by default, then expands `高级信息` and verifies the details are present.
- `npm test --workspace @temu-ai-ops/extension` now runs both extension source validation and the panel fixture check.
- Extension panel fixture now supports `?repairPlan=auto-ready|assisted|manual|blocked`. The fixture check covers all four tones: auto-ready stays green with `可自动处理`, assisted/manual stay warning with `需辅助处理` or `需人工处理`, and blocked stays bad with `已阻塞`.
- The fixture check now asserts that non-auto repair plans never show `可自动处理` in the default `改造` row, while detailed action/blocker text remains hidden until `高级信息` is expanded.
- Extension panel default actions now respect repair-plan gating. When the current work item is `assisted`, `manual`, or `blocked`, `执行自动填充` and repeat `加入队列` are disabled, and the compact action area shows `默认动作已暂停` with a pointer to `高级信息` / fault recovery.
- The extension click handlers also re-check the repair gate before running default fill or queue actions, so scripted clicks cannot bypass the disabled buttons after a non-auto repair plan is known.
- Dianxiaomi work items now expose a backend-derived `repairActionGate`. The server persists whether default unattended actions are allowed, the gate status (`none`, `auto-ready`, `assisted`, `manual`, or `blocked`), and a compact message. The injected extension panel prefers this backend gate and falls back to local repair-plan inference only for older work items.
- The extension fixture now returns `repairActionGate` with each mocked work item. Fixture coverage asserts that non-auto plans consume the backend gate message, keep `高级信息` collapsed, and disable default fill/requeue actions without exposing detailed repair actions in the daily panel.
- Dianxiaomi work items now persist `publishOutcome` after a full-flow reaches `submit-listing`. The backend reads the submit report step, stores success/failure, attempt count, max attempts, failure reason, submit job id, report path, and a route of `published`, `auto-retry`, `browser-recovery`, `manual-budget`, or `not-attempted`.
- Publish outcome routing is conservative. Successful Dianxiaomi submit goes to `published`; safe auto retry diagnostics go to `auto-retry`; publish-validation/media/task/profile failures are routed as recovery/fix candidates; login/CAPTCHA, selector, wrong-page, and unknown failures stay in the manual-step budget path.
- Queue daemon health now includes compact publish-result counts: `publishSucceeded`, `publishFailed`, `publishRecoveryCandidates`, and `publishManualBudget`. This lets default surfaces know whether failed Dianxiaomi publish attempts are recoverable or should be counted against the manual-step budget without reading raw reports.
- Queue daemon health now also exposes `manualBudget.publishOutcomes`: a compact manual-step budget list for publish outcomes that are excluded from unattended retry/recovery. Each entry includes the work item id/title, source, exclusion reason, required operator action, release condition, and update time.
- Manual-step budget now has release tracking. When a blocked `manual-budget` publish outcome is fixed and moved back to `ready-for-automation`, the work item records `manualBudgetReleases` with source, reason, operator action, release condition, release type, old/new status, and note. Current budget counts only still-blocked manual-budget items; released items move into `manualBudget.releases`.
- Manual-step budget now has a replacement queue at `manualBudget.replacementQueue`. It groups active budget entries and release history by recurring reason, counts active/released occurrences, keeps sample work item ids/titles, proposes a conservative AI/browser replacement plan, and marks every candidate as not default-eligible until it has click/decision reduction proof.
- Manual-step budget now has a proof ledger at `manualBudget.proofs`, persisted to `.runtime/data/manual-budget-proof-ledger.json` by default. The replacement queue uses the latest proof record for each candidate, and a candidate only becomes `ready-for-default` when the trial passed and per-product operator clicks or per-product operator decisions decreased.
- Recovery trials can now auto-capture proof records for products with manual-step budget release history. When a recovery run fully completes repair-preview, repair-apply, and full-flow for such a product, the server records a `recovery-run` proof with baseline clicks/decisions estimated from the old manual budget action and trial operator clicks/decisions set to zero.
- Auto-captured proof records now include optional `automationMeasurement` from automation reports. The server counts browser clicks/actions from repair/full-flow report steps, keeps measured report ids/paths in the proof ledger, and shows the compact measurement only in Advanced `Manual Proof Ledger`.
- Proof records now include a confidence label: `measured` for ready proofs backed by automation reports, `estimated` for ready proofs backed only by baseline estimates, and `weak` for failed/no-improvement proofs. Replacement queue proof gates expose the same confidence label, but it remains an Advanced-only planning signal.
- Advanced replacement candidates now sort by proof strength before volume: `ready-for-default + measured` first, `ready-for-default + estimated` second, and weak/needs-proof candidates last. This changes Advanced planning order only; the default unattended gate is unchanged.
- Advanced queue health now has proof confidence counters and filters. The `Proof Confidence` control filters `Replacement Queue` and `Manual Proof Ledger` by all/measured/estimated/weak so measured candidates can be inspected without adding anything to the daily default surface.
- Advanced queue health now exposes `manualBudget.trialProposals` for measured ready replacement candidates only. Each bounded proposal includes trial size, sample work item ids/titles, measured report counts/clicks/actions, acceptance criteria, rollback criteria, and an explicit Advanced-only note so it cannot silently enter the daily default automation path.
- Advanced bounded trial proposals now include readiness checks before any trial execution: real Dianxiaomi calibration, browser profile health, candidate sample availability, and rollback acknowledgement. The Advanced-only request endpoint and dashboard action now exist; blocked requests return readiness details and start no full-flow jobs.
- The injected extension panel now consumes `publishOutcome` in the default alert area. It shows one compact success/failure message with attempt count, failure reason, and route, while report paths and raw attempt arrays stay out of the default UI.
- The simplified dashboard default alerts now surface one compact publish-result warning when queue health reports failed Dianxiaomi publish outcomes. It reports failed count, recoverable/retry count, and manual-budget count without adding a new panel.
- When a publish failure is in the manual-step budget, the simplified dashboard keeps one alert but includes the first affected item and its operator action. Detailed reason/release-condition rows remain in Advanced queue health.
- Advanced queue health now shows manual-step budget release history. The default dashboard still hides this detail and remains limited to `状态 / 告警 / 动作`.
- Advanced queue health now shows the first replacement queue candidates. This remains an advanced planning view; no AI/browser replacement enters the default unattended flow until the proof gate shows fewer clicks or fewer operator decisions.
- `publishOutcome.route` now participates in unattended decisions. `auto-retry` can feed safe retry release, `browser-recovery` can feed recovery-run only when the repair plan is still `auto-ready`, and `manual-budget` blocks direct retry/recovery even if a stale repair plan looks automatic.
- Safe retry release notes now identify publish-outcome-triggered releases, so queue-run/audit history can distinguish normal failure-diagnosis retry from submit-result retry.

## Validation

- `npx tsc -p apps/automation/tsconfig.json --noEmit`
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- Browser verification on `http://localhost:5173/`: daily `无人值守主流程` shows only `状态 / 告警 / 动作`; `故障恢复批跑`, `Run recovery`, `released retry`, `released retry outcomes`, and queue audit entries appear only after entering `高级区`; no browser console errors.
- Local queue health response after bounded selector diagnosis lookup: `GET /automation/queue-daemon/health` returned HTTP 200 in `0.066s`.
- Local queue health response now returns `recovery.releasedRetryBatch` with `policy=released-retry`, `maxItemsPerTick=1`, current pending count, next work item ids, and normal-recovery hold state.
- Browser verification on `http://localhost:5173/`: daily `无人值守主流程` remained limited to `状态 / 告警 / 动作`; after entering `高级区`, queue health showed `Released Retry Policy`.
- Browser fixture verification on `http://127.0.0.1:19052/.runtime/ui-fixtures/extension-panel.html`: default extension panel showed `状态 / 告警 / 动作`, compact `改造` conclusion row, and collapsed `高级信息`.
- `npm test --workspace @temu-ai-ops/extension`
- `npm run build --workspace @temu-ai-ops/extension`
- Browser fixture verification on `http://127.0.0.1:19052/.runtime/ui-fixtures/extension-panel.html`: after `加入队列`, the default panel showed `改造 可自动处理（2 项）`; detailed media/attribute repair action text stayed hidden until `高级信息` is expanded.
- Browser fixture verification on `http://127.0.0.1:19052/.runtime/ui-fixtures/extension-panel.html?repairPlan=assisted`: after `加入队列`, the default panel showed `改造 需辅助处理（自动 1 / 辅助 1 / 人工 0）` and did not show `可自动处理`.
- Browser fixture verification on `http://127.0.0.1:19052/.runtime/ui-fixtures/extension-panel.html?repairPlan=assisted`: after `加入队列`, the action area showed `默认动作已暂停`, and both `执行自动填充` / `加入队列` were disabled.
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19143`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19104`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19107`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19109`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19111`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19113`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19114`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19115`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19117`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19118`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19120`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19087`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19088`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19091`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19092`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19093`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19094`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19095`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19097`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19098`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19099`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19100`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19101`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19103`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19133`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19134`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19135`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19136`
- `node ..\..\node_modules\tsx\dist\cli.mjs test\automation-safety-smoke.ts` from `apps/server` with `SMOKE_PORT=19137`
- `npm run build --workspaces --if-present`
- `npm test --workspace @temu-ai-ops/extension`
- `npm run build --workspace @temu-ai-ops/extension`
- Browser fixture verification on `http://127.0.0.1:19052/.runtime/ui-fixtures/extension-panel.html`: injected panel rendered, default sections were `状态 / 告警 / 动作`, backend rows showed `守护进程 / 队列 / 当前商品 / 准入`, `高级信息` stayed collapsed, debug upload was hidden by default, and no horizontal overflow was detected.
- Local Playwright fixture click verification: after clicking `加入队列`, the panel showed `准入未通过，缺 2 项，见告警`, `准入 未通过，缺 2 项`, and required image/attribute alerts from the mocked server work item response.
- `npm audit --omit=dev`
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/extension`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- Browser fixture verification on `http://127.0.0.1:19052/.runtime/ui-fixtures/extension-panel.html?repairPlan=assisted`: after `加入队列`, the panel consumed the backend `repairActionGate` message, default sections stayed `状态 / 告警 / 动作`, `执行自动填充` and `加入队列` were disabled, `高级信息` stayed collapsed, and no horizontal overflow was detected.
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm test --workspace @temu-ai-ops/extension`
- `npm run build --workspaces --if-present`
- Browser fixture verification on `http://127.0.0.1:19052/.runtime/ui-fixtures/extension-panel.html?repairPlan=auto-ready&publishOutcome=failed`: after `加入队列`, the panel showed the compact publish failure alert, kept `高级信息` collapsed, left default actions enabled for the auto-ready plan, and had no horizontal overflow.
- Browser verification on `http://localhost:5173/`: simplified dashboard still loaded as `无人值守主流程` with `状态 / 告警 / 动作` and no horizontal overflow.
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- Browser verification on `http://localhost:5173/`: default dashboard still showed only `状态 / 告警 / 动作`, rendered the compact alert area, and had no horizontal overflow at the current in-app browser viewport.
- Local queue health response from `GET /automation/queue-daemon/health`: returned `manualBudget.total`, `manualBudget.publishOutcomes`, and `workItems.publishManualBudget`; current runtime data reported all three as `0`.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- Browser verification on `http://localhost:5173/`: default dashboard still showed only `状态 / 告警 / 动作`, did not leak `Manual Step Budget` / `manual releases` detail into the default flow, and had no horizontal overflow.
- Local queue health response from `GET /automation/queue-daemon/health`: returned `manualBudget.releases`; current runtime data reported `releaseCount=0`.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- Local queue health response from `GET /automation/queue-daemon/health`: returned `manualBudget.replacementQueue`; current runtime data reported `replacementCount=0`.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- Local queue health response from `GET /automation/queue-daemon/health`: returned `manualBudget.proofs`; current runtime data reported `proofCount=0`, `replacementCount=0`, and `manualBudgetTotal=0`.
- Local proof ledger response from `GET /automation/manual-budget/proofs`: returned HTTP 200 with `proofCount=0`.
- Browser verification on `http://localhost:5173/`: default dashboard still showed only `状态 / 告警 / 动作`, did not leak `Replacement Queue`, `Manual Proof Ledger`, `manual proofs`, or `manual replacements`, and had no horizontal overflow.
- Browser verification after entering Advanced: `Replacement Queue`, `Manual Proof Ledger`, and `manual proofs` appeared only in the advanced queue health surface; no horizontal overflow and no browser console errors.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm run build --workspaces --if-present`
- Local queue health response from `GET /automation/queue-daemon/health`: returned `manualBudget.proofs`; current runtime data reported `proofCount=0` and `measuredProofCount=0`.
- Browser verification on `http://localhost:5173/`: default dashboard still showed only `状态 / 告警 / 动作`, did not leak `measured`, `Manual Proof Ledger`, or `Replacement Queue`, and had no horizontal overflow.
- Browser verification after entering Advanced: `Manual Proof Ledger` and `Replacement Queue` appeared only in the advanced surface; no horizontal overflow and no browser console errors.

- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- Local queue health response from `GET /automation/queue-daemon/health`: returned `manualBudget.proofs`; current runtime data reported `proofCount=0` and no confidence groups yet.
- Browser verification on `http://localhost:5173/`: default dashboard did not leak `confidence`, `+measured`, `+estimated`, `+weak`, `Manual Proof Ledger`, or `Replacement Queue`; no horizontal overflow.
- Browser verification after entering Advanced: queue health loaded `Manual Proof Ledger` and `Replacement Queue`; no horizontal overflow and no browser console errors.

- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm run build --workspaces --if-present`
- Local HTTP checks: `http://localhost:5173/` returned 200 and `http://localhost:8787/automation/queue-daemon/health` returned 200.
- Browser verification on `http://localhost:5173/`: default dashboard still showed only `状态 / 告警 / 动作`, did not leak `confidence`, `+measured`, `+estimated`, `+weak`, `Manual Proof Ledger`, or `Replacement Queue`, and had no horizontal overflow.
- Browser verification after entering Advanced: `Manual Proof Ledger` and `Replacement Queue` appeared only in the advanced surface; no horizontal overflow and no browser console errors.

- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm run build --workspaces --if-present`
- Local HTTP checks: `http://localhost:5173/` returned 200 and `http://localhost:8787/automation/queue-daemon/health` returned 200.
- Playwright browser verification on `http://localhost:5173/`: default dashboard did not leak `Proof Confidence`, `Manual Proof Ledger`, or `Replacement Queue`; after entering Advanced, `Proof Confidence` and all/measured/estimated/weak filter buttons rendered, filter clicks worked, no horizontal overflow appeared, and no browser console errors were reported.

- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- Playwright browser verification on `http://localhost:5173/`: default dashboard did not leak `Bounded Trial Proposals`, `trial proposals`, `rollback`, `Proof Confidence`, `Manual Proof Ledger`, or `Replacement Queue`; after entering Advanced, `Bounded Trial Proposals`, `Proof Confidence`, and the trial counter rendered with no horizontal overflow and no browser console errors.
- Manual-budget bounded trial requests now persist to `.runtime/data/manual-budget-trials.json` (or `MANUAL_BUDGET_TRIAL_HISTORY_PATH` in tests), expose `GET /automation/manual-budget/trials`, include accepted rollback criteria and outcome state, and refresh started `manual-budget-trial` full-flow jobs into running/passed/failed outcomes with report-based measurement and proof linkage.
- Dashboard Advanced now shows `Bounded Trial Requests` with recent request outcome, flow count, skipped count, measurement, proof id, and per-flow failure details. The default unattended screen remains unchanged and still does not expose trial/proof/rollback diagnostics.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- Browser verification on `http://localhost:5173/`: default dashboard did not leak `Bounded Trial Requests`, `Bounded Trial Proposals`, `trial requests`, `rollback`, `Proof Confidence`, `Manual Proof Ledger`, or `Replacement Queue`; after entering Advanced, `Bounded Trial Requests`, `Bounded Trial Proposals`, `Proof Confidence`, `Manual Proof Ledger`, and `Replacement Queue` rendered with no horizontal overflow and no browser console errors.
- Measured manual-step replacement candidates are now held out of `defaultEligible` until the latest validation run cleanly passes with measured automation reports, no skipped samples, no failed/running/missing flows, and the active proof gate still points to the validation proof.
- Queue health and unattended startup checks now include `manual-budget-promotion-gate`. It warns when a measured AI/browser replacement has proof but has not yet passed the required validation evidence, while normal ready/recovery queue work can continue.
- Persisted running bounded-trial history now self-heals after restart. If a stored running trial references full-flow jobs that are no longer in memory, the next restore/list/health read marks the outcome failed with missing flow details and persists that normalized state.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- Server now exposes `POST /automation/manual-budget/validation-runs/next`. It selects the current held measured manual-step replacement candidate, acknowledges the proposal rollback criteria automatically, and still respects real-page/profile/sample readiness gates before any full-flow job can start.
- Dashboard Advanced now has `run next held validation` under `Bounded Trial Proposals`. This remains Advanced-only; the default unattended screen still has no trial/proof/rollback controls.
- Server regression coverage now verifies the next-validation launcher selects the held measured candidate, persists blocked readiness outcomes when the gate is not executable, and returns a stable no-candidate marker after a clean measured validation already cleared the promotion gate.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- Queue daemon health now exposes `manualBudget.validationClosure`. It refreshes running manual-budget validation trials on read, then summarizes total/running/passed/failed/blocked counts, the latest trial id/candidate/status/message, the latest proof id, and measured automation report counts into one compact pass/fail closure.
- Dashboard Advanced now shows `Validation Closure` next to bounded trial proposals and requests. It stays out of the default unattended screen, so daily operation still only shows status, alerts, and actions.
- Server regression coverage now verifies failed/missing persisted validation trials are summarized as failed closures and clean measured validation passes are summarized as passed closures with proof and measurement data.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- Local HTTP checks: `http://localhost:5173/` returned 200 and `http://localhost:8787/automation/queue-daemon/health` returned 200; current runtime `manualBudget.validationClosure` reported `status=idle`, `total=0`, `running=0`, `passed=0`, `failed=0`, and `blocked=0`.
- Browser verification on `http://localhost:5173/`: default dashboard did not leak `Bounded Trial Requests`, `Bounded Trial Proposals`, `trial requests`, `rollback`, `Proof Confidence`, `Manual Proof Ledger`, or `Replacement Queue`; no horizontal overflow appeared.
- Browser verification after entering Advanced: `Validation Closure`, `Bounded Trial Proposals`, `Bounded Trial Requests`, and `run next held validation` rendered with no horizontal overflow.
- Validation closure now includes `failureTriage`. Failed validation runs are classified into `auto-retry`, `browser-recovery`, `profile-fix`, `blocked`, or `manual-budget` routes using the existing Dianxiaomi failure classifier, while missing restored full-flow jobs are treated as a validation rerun blocker instead of consuming manual-step budget.
- Queue health now emits one compact `manual-budget-validation-triage` alert when a validation failure needs routing. The default dashboard consumes only that compact alert/action; detailed trial/proof/route information remains in Advanced `Validation Closure`.
- Dashboard Advanced `Validation Closure` now shows triage status, route, category, reason, next action, and affected work item ids next to bounded trial proposals/requests.
- Server regression coverage now verifies missing-flow failures do not count as manual budget, browser profile validation failures route to `profile-fix`, and unknown hard validation failures route to `manual-budget`.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- Local HTTP checks: `http://localhost:5173/` returned 200 and `http://localhost:8787/automation/queue-daemon/health` returned 200; current runtime `manualBudget.validationClosure.failureTriage` reported `status=none`, `route=none`, and `countsAsManualBudget=false`.
- Validation closure now includes `rerunPolicy`. It allows one guarded validation retry for eligible `auto-retry`, `profile-fix`, and proven `browser-recovery` routes after their prerequisite fix is met, and records source trial, retry trial, attempts used/max, prerequisite status, reason, next action, and affected work item ids.
- Queue daemon now checks ready validation rerun policy before browser recovery and normal queue work. When ready, it starts a bounded validation request through the same manual-budget trial gate and records a `validation-rerun-started` tick with `manualBudgetValidationRun`.
- Manual-budget, blocked, missing-flow, login/CAPTCHA, selector, target-surface, and real-page blockers remain excluded from automatic validation reruns. These routes do not consume the one automatic validation retry budget.
- Dashboard Advanced `Validation Closure` now shows the rerun policy summary, and queue daemon tick history links validation rerun request ids. The daily unattended dashboard remains unchanged and still hides validation/proof/trial/rerun details by default.
- Daily `自动通过率` KPI now counts only default `queue-run` full-flow jobs. Direct Advanced runs, `recovery-run`, `manual-budget-trial` validation/rerun jobs, safe-retry release batches, jobs with a `repairPlanFile`, and products already released from manual-step budget are excluded from the main-path pass rate.
- Daily `单品人工触发` KPI now counts only real operator triggers: `manual-budget` publish outcomes, non-auto repair actions, or non-safe/non-auto failure diagnoses. Auto-ready repair plans, safe auto retry, recovery batches, validation reruns, and Advanced-only diagnostics stay out of the daily manual-trigger average.
- `docs/operating-principles.md` now locks the refined KPI rules so future repair/rerun/proof work cannot accidentally inflate or deflate the default daily metrics.
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- Browser profile lock health now separates fresh/uncertain locks from stale abandoned locks. `profile.lockFiles` contains active or unreadable lock files that still warn/block startup, while `profile.staleLockFiles` contains old lock files ignored by the startup gate.
- The stale profile-lock threshold defaults to 12 hours and can be tuned with `PROFILE_LOCK_STALE_MINUTES`; the override is clamped from 5 minutes to 7 days so a bad value cannot disable the gate entirely.
- Dashboard Advanced queue health shows active lock count, stale lock count, and the profile lock file names separately. The daily unattended dashboard remains unchanged and does not expose lock-debug details by default.
- Server regression coverage now verifies an old `SingletonLock` stays visible as stale without warning/blocking the browser-profile startup check, while a fresh `SingletonLock` still appears in `lockFiles` and keeps the startup warning.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- Profile lock health now persists a cleanup audit ledger at `.runtime/data/profile-lock-ledger.json` by default, with `PROFILE_LOCK_LEDGER_PATH` available for isolated tests or custom runtime storage.
- The profile lock ledger records `ignored-stale-lock` events during health polling and `archived-stale-lock` events only after the guarded archive action succeeds. Health polling still does not delete, move, or archive browser files automatically, and audit entries are de-duplicated by profile path, file name, action, and lock mtime.
- Queue health now exposes `profile.lockAudit` with recent audit entries plus ignored/archived counts. Dashboard Advanced shows the audit summary and the latest entries under `Profile`; the daily unattended dashboard remains unchanged.
- Server regression coverage now verifies stale lock audit persistence, no automatic archive marking, and no duplicate audit entry on repeated startup-health checks.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `GET /automation/profile-locks/archive-readiness` exposes a read-only stale-profile-lock archive readiness check. It accepts the same launch query inputs as readiness/startup-check, uses the current daemon profile when called without inputs, and never creates directories, moves files, deletes files, or marks anything archived.
- `POST /automation/profile-locks/archive` now performs the guarded stale-lock archive action. It only runs when readiness is `ready`, re-checks every target lock is still stale and has the same `mtime` immediately before moving, writes successful `archived-stale-lock` audit entries, and leaves fresh or unreadable locks as hard blockers.
- Archived locks are moved under `.archived-profile-locks`, and that archive directory is excluded from future profile lock scans so it cannot become a false active/stale lock.
- Dashboard Advanced `Profile` now shows archive readiness status, archive directory, ready/blocked counts, up to three lock-file readiness details, and the disabled/enabled `archive stale locks` action. The default daily unattended dashboard still hides stale-lock, audit, archive-readiness, and archive-action diagnostics.
- Server regression coverage now verifies stale-only profile locks are archive-ready without moving the lock file, the guarded archive moves the stale lock and persists `archived-stale-lock`, archived profiles become archive-idle, the archive directory is not reported as a lock, fresh locks block archive readiness, missing profile configuration blocks readiness, and missing profile directories block readiness.
- `apps/server/test/profile-lock-archive-route.test.ts` now starts a temporary HTTP server and verifies the real `POST /automation/profile-locks/archive` route preserves `profile`/`limit` input, handles UTF-8 profile paths, moves only the stale fixture lock, leaves readiness `idle`, and writes the archive audit entry. This catches route schema regressions that function-level tests cannot see.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- `npx tsc -p apps/dashboard/tsconfig.json --noEmit`
- `npm test --workspace @temu-ai-ops/server`
- `npm run build --workspaces --if-present`
- Local HTTP checks: `http://localhost:8787/automation/profile-locks/archive-readiness` returned `status=blocked` with no profile configured, `POST /automation/profile-locks/archive` with no profile returned safe `status=blocked`, a temporary UTF-8 fixture profile archived one stale `SingletonLock` and then returned readiness `idle`, `http://localhost:8787/automation/queue-daemon/health` returned 200, and `http://localhost:5173/` returned 200.
- Browser verification on `http://localhost:5173/`: default dashboard did not leak `archive readiness`, `.archived-profile-locks`, `lock audit`, `stale locks`, `active locks`, `ignored-stale-lock`, `archived-stale-lock`, `Validation Closure`, `Bounded Trial`, `Proof Confidence`, `Manual Proof Ledger`, `Replacement Queue`, `rerunPolicy`, or `repair-*`; no horizontal overflow and no console errors.
- Browser verification after entering Advanced: `Profile` showed archive readiness and the `archive stale locks` button only in Advanced; with no ready locks the button was disabled, with no horizontal overflow and no console errors.

## Next Development Target

Next, continue hardening the unattended publish success/failure loop: add route-level coverage that a queue/full-flow submit result persists `publishOutcome`, updates the work item route, and feeds auto-retry/browser-recovery/manual-budget counts without adding default-screen controls.

## Code Health Refactor (2026-06-04)

### App.tsx split — DONE

- 538 行纯 helpers / 常量 / 类型从 `apps/dashboard/src/App.tsx` 抽到 `apps/dashboard/src/lib/dashboard-helpers.ts`。
- 约 160 行 daily 派生（`readyWorkItems`、`blockedWorkItems`、`*RecoveryCandidateCount`、`startup*Checks`、`dailyBackendOffline*`、`dailyTrialGate`、`dailyCanStart`、`dailyAutomaticPass*`、`dailyManualTriggers*`、`dailyAlerts` 数组等）从 `App()` 体内抽到 `apps/dashboard/src/lib/use-daily-dashboard.ts` hook，App.tsx 调用点用扁平解构保持所有局部变量名不变 → JSX 引用零修改。
- App.tsx 3300 → 2695 行。
- `npm run typecheck --workspace @temu-ai-ops/dashboard` 通过；`npm test` 通过。

### automation-runner.ts split — ATTEMPTED, ROLLED BACK

- **目标**: 9 文件 + re-export shim 拆分（详见 `.claude/plans/snuggly-painting-pancake.md` 第二节）。
- **状态**: 拆分脚本（`.runtime/split_runner.cjs`）成功按计划从 dist `apps/server/dist/apps/server/src/automation-runner.js`（5645 行）切出 9 个子文件：
  - `errors.ts` (14 行) / `paths.ts` (54 行) / `proof-ledger.ts` / `profile-lock-ledger.ts` / `jobs.ts` (1280 行) / `queue-runs.ts` (122 行) / `recovery.ts` (821 行) / `manual-budget.ts` (1360 行) / `queue-daemon.ts` (1598 行) + `index.ts` barrel + 原文件 2 行 shim。
  - 子文件之间通过 `paths.ts`、`jobs.ts`、`manual-budget.ts` 共享纯 helpers 和可变 state（`fullFlowJobs`、`manualBudgetTrialHistory`、`recoveryRuns` 等），由 split 脚本自动检测并加 `import`。
- **遇到回归**: 拆分后 `apps/server/test/automation-runner.test.ts:1056` 失败——`unit-manual-trial-auto-retry-work-item` 的 `failureDiagnosis.autoRetryRecommended` 期望 `false`（target-surface 分类），实际为 `true`（task-file 分类）。日志显示 catch 块的 error 从 dist 版的 `"target URL is not a real Dianxiaomi product edit URL: demo/smoke Dianxiaomi URL is not allowed for real automation"` 变成了拆分版的 `"task file does not exist: .runtime/automation-tasks/task-dxm-work-manual-trial-auto-retry-work-item-XXX.json"`。两者在 `getAutomationPageUrlGate` 函数内的不同分支。
- **根因假设（未完全验证）**: `exportTaskFile` 写盘和 `readAutomationTaskFile` 读盘的相对路径在拆分 vs 单文件下走不同的 `getRepoRoot()` 解析，导致读到的 task 文件路径不匹配。planner 模块的 `getRepoRoot` 是 `path.resolve(path.dirname(import.meta.url), "../../..")`，拆分后 planner 通过 `apps/server/src/automation-runner/index.ts` → `../planner.js` 加载，`import.meta.url` 与单文件 dist 直接 `./planner.js` 不同，进而 `repoRoot` 偏移。
- **当前处理**: 回退到 `apps/server/dist/apps/server/src/automation-runner.js` 的副本（5645 行 + `// @ts-nocheck`），所有运行时行为恢复。`npm test` 通过、dev:server (8787) 正常。server `typecheck` 仍有 565 个 `any` 相关错误（dist 失类型注解，已记录在 [docs/development-plan.md](development-plan.md) 下一步条目）。
- **后续路径（用户决定）**:
  1. 找回原 6947 行 .ts 源（git history / IDE 撤销 / 备份），重新走 9 文件拆分；
  2. 或：先修 planner 的 `getRepoRoot` 路径（多用 1-2 层 `..`），再重试拆分；
  3. 或：跳过拆分，保持 5645 行单文件，专注 [docs/roadmap-to-production.md](roadmap-to-production.md) 下一步。
- **关键纪律（已写进 .claude/plans）**: 任何对 `automation-runner.ts` 的大改动都必须先 `cp automation-runner.ts automation-runner.ts.bak` 备份，或先 `git stash`，避免再次丢失源文件。本次回退就是严格按这条纪律执行的（保留了 dist 副本）。

### automation-runner.ts typecheck 修复（部分成功）

- **起点**: 565 个 typecheck 错误（去掉 dist 上的 `// @ts-nocheck` 后，dist 失类型注解导致）。
- **手动 + 脚本半自动注解**:
  - 加 `import type * as SharedTypes from "@temu-ai-ops/shared"` 与 `clampInteger/getProfileLockStaleMs` 等共享 helpers。
  - 为 8 个 job Map + `recoveryRuns` + `recoveryReleases` + `manualBudgetProofLedger` + `manualBudgetTrialHistory` + `profileLockAuditLedger` + `queueRunHistory` 加 `<K, V>` 类型参数。
  - `.runtime/annotate_params.cjs`（已清理）批量给 198 个函数参数加 `: any`，跳过带默认值的参数（让 TS 从默认值推断类型），保留箭头函数返回值（如 `productCount > 0 ? ... : 0`）。
  - 修 4 处顶层 `let foo = []` → `let foo: any[] = []`。
  - 为 3 个导出函数加返回类型注解（`getAutomationModeReadiness`、`getDianxiaomiQueueDaemonHealth`、`getDianxiaomiQueueDaemonState`）。
- **结果**: 565 → **273** 错误（减少 52%）。`npm test`（server + extension）通过，dev:server (8787) 正常。
- **剩余 273 错误的分布**:
  - `TS7006` (143): 嵌套箭头函数参数未注解（`.filter((entry) => ...)`, `.sort((left, right) => ...)`），正则匹配不到
  - `TS2339` (78): 对象字面量在 `{}` 类型上访问属性，需要给变量加具体类型
  - `TS2322` (24): consumer 端（`automation-preflight.ts`）拿不到正确的 `AutomationModeReadiness` 类型
  - `TS7005` (6): 仍有个别变量隐式 `any`
  - `TS2345` (6) / `TS7031` (4) / `TS2503` (4) / `TS7034` (3) / `TS18047` (3) / `TS18046` (2): 零星下游错误
- **继续修的路径（用户决定）**:
  1. 给嵌套箭头函数参数加 `: any`（每处手动加，约 143 处，~1-2 小时）
  2. 给关键对象字面量加类型（影响 78+24 个错误）
  3. 在 `automation-preflight.ts` 端加 `as AutomationModeReadiness` 类型断言（快速压平 6 个 consumer 错误）
  4. 恢复 `// @ts-nocheck` 并接受当前状态（runtime + test 优先）
- **本次会话保留**: `apps/server/src/automation-runner.ts` 当前是不带 `@ts-nocheck` 的、做了部分注解的版本（比 dist 副本多了 198 处参数注解 + 9 处集合/数组类型 + 3 处导出返回类型）。如果不再继续修复，建议在文件头加回 `// @ts-nocheck` 并把本次注解作为"已知缺失"，分批增量重做。

### 真实 Dianxiaomi 页面校准 runbook

- 已创建 [docs/real-dianxiaomi-calibration-runbook.md](real-dianxiaomi-calibration-runbook.md)，从采集 → 诊断 → 生成 selector config → 验证 → 试跑 6 步。
- 当前 `.runtime/dianxiaomi-selector-config.json` 是从 fixture 校准的占位符（`input[name="productTitle"]` 等），需要真实 Dianxiaomi 页面校准才能验证。
- 校准工具链已就位：`apps/automation/src/snapshot.ts`（Playwright headed 模式采集）、`snapshot-diagnose.ts`（诊断）、`selector-config-generate.ts`（生成）。
- 启动无人值守 daemon 之前必须满足的 `real Dianxiaomi calibration` 启动检查路径已明确。
- 真实环境要求：已登录的 Chromium browser profile + 真实 Dianxiaomi 商品编辑/刊登页 URL。Headless 环境无法跑真实校准。
- 校准后续：[docs/roadmap-to-production.md](roadmap-to-production.md) 下一步（AI 内容生成、数据库升级、批量发布前检查）。

### selector-config:generate 路径 bug 修复

- **症状**：fixture 校准端到端验证时发现，`npm run selector-config:generate` 把 config 写到了 `apps/automation/.runtime/dianxiaomi-selector-config.json`（automation 工作区），但 server 读的是 `<repoRoot>/.runtime/dianxiaomi-selector-config.json`（项目根）。两个文件独立，server 看到的 config 缺 `mediaTools` / `mediaToolActions` 字段。
- **根因**：`selector-config-generate.ts` 默认 `outputPath = ".runtime/dianxiaomi-selector-config.json"` 相对 CWD 解析。`npm run --workspace` 在 automation 工作目录下运行，所以写到 `apps/automation/.runtime/`。
- **修复**：给 `selector-config-generate.ts` 加 `getRepoRoot()`（基于 `import.meta.url` 向上 3 层到项目根），默认 `outputPath` 改为 `path.join(getRepoRoot(), ".runtime/dianxiaomi-selector-config.json")`。`--output` 参数仍可覆盖。
- **验证**：fixture 流程后跑 generator，`.runtime/dianxiaomi-selector-config.json` 现在 5 个 key 全有（fields、buttons、mediaTools、mediaToolActions、skuRows），`mediaTools.imageTranslation = ["button#imageTranslationTool"]` 等。`npm test` 通过。

### 品类（category-selection）根因 + 回写 + 验证（2026/06/27）

完整说明见新文档 [docs/dianxiaomi-category-selection.md](dianxiaomi-category-selection.md)。摘要：

- **根因**：上一轮（`4e79568`）新加的 `required` 校验 `category-selection`（`planner.ts` 的 `hasCategorySelectionSignal`）会把"无品类信号（label / categoryId / fullCid 全空）"的 work item 卡在 `needs-revision`，进不了无人值守。不是 bug，是有意硬门 —— 缺品类硬跑会在店小秘"未选择分类"那步失败。卡的是**存量 work item 没带品类信号**。
- **诊断脚本（只读）**：
  - [probe-readonly-category-state.ts](../apps/automation/src/probes/probe-readonly-category-state.ts)：纯读真实编辑页，确认到底有没有已选品类（`missingCategory` / 按钮可见性 / 附近文本），不点击不写。
  - [verify-category-label-only.ts](../apps/automation/src/verify-category-label-only.ts)：半只读，验证"只给 label（无 categoryId/fullCid）时 `normalizeCategorySelection` 能否自己选中品类"，会开弹窗选品类但不填字段/不保存/不提交。
- **回写脚本**：[scripts/backfill-category-hint.mjs](../scripts/backfill-category-hint.mjs) 走既有 `POST /dianxiaomi/product-work-items` 给存量 work item 批量补 `categoryHint.label`（`source=manual`），server 原地更新并重算 requirements + status，期望 `categorySelectionOk=true` / `newStatus=ready-for-automation`。属 `高级区` 一次性运维工具。
- **测试固化**：[automation-runner.test.ts](../apps/server/test/automation-runner.test.ts) 所有"完整/ready"型 fixture 显式补 `categoryHint: { label: "Home & Garden" }`，否则被新必填校验拉回 `needs-revision`，破坏 publish/recovery 路由断言。
- **验证**：`npm test --workspace @temu-ai-ops/server` 通过；`npm run typecheck --workspace @temu-ai-ops/automation` 通过（含两个新脚本）。
- **退出条件**：采集/录入阶段稳定带品类信号，或 `normalizeCategorySelection` 公共品类回退足够稳，则这两个过渡工具可下线。

### 阻塞墙推进：媒体 + 图片缺失（2026/06/29）

完整诊断见 [docs/blocking-walls-diagnosis.md](blocking-walls-diagnosis.md)。本轮把真实写链路从 `save-draft` 卡点继续往前推：

- **墙 2 媒体工具（部分解）**：image-editor「批量编辑」弹窗第一层 bug（没选图就点确定 → 店小秘报「请选择要编辑的图片」，已选中 0）已修——apply 前调 `ensureCheckboxNearText(mediaSurface, "选择全部", true)`（[dianxiaomi-adapter.ts](../apps/automation/src/adapters/dianxiaomi-adapter.ts) `applyUnattendedMediaTools` 内，仅 `tool.id === "image-editor"` 路径）。第二层「点确定弹窗不推进」未真修，临时方案仍是把 image-editor 移出 `mediaAutomationTools` 白名单放行 submit。
- **墙 3 图片缺失（已写修复，未真实验证）**：234/238 个「页面引用型」work item 完全没有图片 URL → fill 阶段 `fillSkuImageLinks` skip → save-draft 被「服装类颜色属性必须上传3张图片」拒。修复：新增 `fetchProductImagesFromEditJson(page)` 从店小秘 `edit.json`（`mainProductSkuSpecReqsList[].previewImgUrls`，`|` 分隔按色变体；`materialImgUrl`/`mainImage`/`extraImages` 兜底）即时把现有图捞回，`fillDraft` 在 `productImages` 为空时调用它，恢复后正常走 `fillSkuImageLinks` + `normalizeDescriptionImageModules`。`npm run typecheck --workspace @temu-ai-ops/automation` 通过。**尚未在真实页面跑过 fill→save 验证能否过「每色3图」门**。
- **墙 4 主题颜色（新发现，仅探针）**：save 还会被「主题颜色至少需要选一个」拒。只读探针 [probe-theme-color-structure.ts](../apps/automation/src/probes/probe-theme-color-structure.ts) 已就位（dump 主题颜色提及 + `.skuAttrItem_1001` SKC 勾选态 + color-table 行），**适配代码未写**，下轮处理。
- **辅助探针**：[probe-category-detection-compare.ts](../apps/automation/src/probes/probe-category-detection-compare.ts) 对比 `textContent` vs `innerText` 两种「未选择分类」判定差异（只读）。
