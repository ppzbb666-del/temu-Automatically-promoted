# Recovery Run

Updated: 2026-06-01

`recovery-run` is the browser-backed fault recovery loop for blocked Dianxiaomi work items. It is a recovery tool, not part of the default daily dashboard KPI.

## Scope

The loop handles only blocked work items that are safe for unattended browser recovery:

- Work item status is `blocked`.
- Listing requirements still pass.
- Page URL is a valid Dianxiaomi product edit URL.
- Repair plan is `auto-ready`.
- Every required repair action is automatic and browser-executable.
- At least one repair action can run through a supported browser writer:
  - `fill-single-field`
  - `fill-attributes`
  - `fill-sku-pricing`
  - `run-media-tool`

The loop skips task-file refresh, browser-profile cleanup, login/CAPTCHA, selector calibration, wrong-page, and assisted/manual repair plans. Task-file refresh and other non-browser safe retries stay in queue auto-release; login/CAPTCHA, selector, target-surface, assisted, and manual repairs stay behind startup checks or the manual-step budget.

## Flow

For each eligible item:

1. Export the current Dianxiaomi task file and repair plan.
2. Run `repair-preview`.
3. If preview completes, run `repair-apply`.
4. If apply completes, start a normal `full-flow` without a repair plan file.
5. Full flow fills/saves/submits through Dianxiaomi according to the launch input.

The write ceiling remains unchanged: this can click Dianxiaomi publish, but it does not approve Temu 核价 or final 上架.

## Queue Daemon Policy

The queue daemon checks recovery before the normal ready queue:

1. Recover completed full-flow outcomes.
2. Release direct safe retry candidates that do not require browser field/media repair.
3. If released recovery-pause candidates exist and startup gates pass, start one `recovery-run` with `recoveryPolicy="released-retry"` and `limit=1`.
4. If no released retry candidate exists but normal browser recovery candidates exist, start `recovery-run` with `recoveryPolicy="normal"` and record tick category `recovery-run-started`.
5. If no browser recovery candidate exists, run the normal ready queue.

Browser recovery candidates stay `blocked` until `recovery-run` handles them. They are not released straight into `ready-for-automation`, which prevents field/media repairs from bypassing `repair-preview` and `repair-apply`.

The released retry lane is intentionally small. A product/action that was paused by repeated recovery failures must pass through a one-item daemon retry before it can blend back into normal unattended recovery behavior.

Release events are one-use safety gates. If a product update, repair-plan regeneration, or selector/media calibration releases a repeated failure and the released retry fails again, that same release event cannot release the next failure. The product/action pauses again until a newer product change, regenerated plan, or real calibration exists.

`recovery-run` full-flow jobs are marked with source `recovery-run`; daily automatic-pass KPI excludes them so repair activity cannot inflate the main-path pass rate.

## Persistence And Repeated Failures

Recovery-run history is persisted to `.runtime/data/recovery-runs.json` by default. Override it with `RECOVERY_RUN_HISTORY_PATH` for tests or isolated runtime folders.

The server keeps the latest 50 recovery batches. History is written when a batch starts and after each item/run status update, so the advanced recovery panel still shows recent recovery results after a server restart. If the server restores a batch that was still `running`, it normalizes the stale in-progress items to failed history instead of leaving them stuck as running forever.

Queue health derives a compact repeated-failure summary from this persisted history. It raises a `repeated-recovery-failures` warning when the same work item or the same browser repair action fails at least twice. The default daily dashboard shows only that compressed alert; detailed batch/item reasons stay in `高级区`.

Queue health and startup checks intentionally keep selector diagnosis lookup bounded. By default they read production calibration/report directories rather than recursively scanning the full `.runtime` history; tests or isolated runs can still set `SELECTOR_DIAGNOSIS_DIRS` when they need a specific diagnosis folder.

## Failure Budget Pause

The unattended queue daemon will not keep retrying a browser recovery candidate after the repeated-failure budget is hit.

When a work item or browser repair action fails at least twice:

- `browserRecoveryCandidates` excludes the paused item, so the daemon will not start another automatic recovery-run for it.
- `releasedBrowserRecoveryCandidates` counts unpaused items that were released by a concrete product, repair-plan, or selector/media-calibration change. The daemon tries only one of these per tick.
- `pausedBrowserRecoveryCandidates` counts the paused items.
- `recovery.paused` records the product/action, latest reason, and the release condition.
- `recovery.releasedRetryBatch` records the active batch policy: `maxItemsPerTick`, pending released retry count, next bounded work item ids, and whether normal browser recovery is held while released retry drains.
- `recovery.releasedRetryCandidates` records the currently eligible released retry products.
- `recovery.releasedRetryOutcomes` records recent released retry results and their next state, such as `completed`, `repaused`, or `released-pending`.
- `recovery.releases` records recent release events, including the product/action, release type, event time, and reason.

Release conditions are intentionally concrete:

- Product-level repeated failure: update the Dianxiaomi work item or regenerate its repair plan.
- Repair-action repeated failure: rerun real Dianxiaomi selector/media calibration, update the product, or regenerate the repair plan.

Manual `Run recovery` in `高级区` remains available for deliberate troubleshooting. The pause only protects unattended daemon loops from spending cycles on a known bad path.

Release history is stored with recovery history in `.runtime/data/recovery-runs.json`. Older array-only history files are still accepted; after the next write the file is normalized to `{ "runs": [...], "releases": [...] }`.

## API

Start a recovery batch:

```http
POST /automation/recovery-run
```

Body:

```json
{
  "limit": 5,
  "mediaAutomationMode": "unattended-apply",
  "submitAfterSave": true,
  "workItemIds": ["optional-work-item-id"],
  "recoveryPolicy": "normal"
}
```

List recent batches:

```http
GET /automation/recovery-runs
```

Fetch one batch:

```http
GET /automation/recovery-runs/:id
```

## Dashboard

The advanced recovery panel has `Run recovery (n)`. The count is the number of currently blocked browser-recovery candidates, including released retry candidates. Queue health separates direct `safe retry`, normal `browser recovery`, `released retry`, and `paused recovery`, and daemon tick history shows recovery-run ids when the daemon starts a recovery batch.

Advanced queue health also shows released retry outcomes. Operators can see whether a released item completed, re-paused, is still running, or is no longer recoverable without opening raw recovery history.

Advanced queue health also shows the released retry batch policy. This keeps the default daily page clean while making the unattended recovery throttle visible during troubleshooting.

Queue health also includes `audit.recent`. These entries summarize recent daemon ticks, including recovery-run starts, released retry attempts, ready queue starts, startup blocks, idle ticks, and skipped ticks. Each audit entry includes the decision, reason, next action, linked run id, affected work item ids, and whether the tick counts as a failure.

The default `无人值守主流程` remains minimal. It does not show recovery controls, but it can show one alert when automatic recovery repeatedly fails for the same product/action so operators know automation is no longer reducing manual work for that item.
