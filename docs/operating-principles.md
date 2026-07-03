# Operating Principles

Updated: 2026-06-01

This project is optimized for unattended Dianxiaomi-to-Temu listing. The default product path must stay narrow: use Dianxiaomi-collected products, automatically edit/list through Dianxiaomi, click Dianxiaomi publish, then stop before Temu pricing approval and final listing.

## Default Entry

- `无人值守主流程` is the only default entry in the dashboard.
- Manual product entry, review workbench, repair tools, selector workbench, import tools, and raw automation launch controls stay under `高级区` and are hidden by default.
- The first screen may show only three groups: status, alerts, and actions.
- The daily operator should not need to inspect task files, selectors, logs, repair plans, or AI drafts during normal operation.

## Manual Step Budget

Permanent manual steps allowed in the main business flow:

- Temu 核价确认.
- Temu 最终上架确认.

Any other manual step is temporary. Before adding it, the implementation or documentation must state:

- Why the manual step exists.
- Which automatic replacement will remove it.
- The trigger or owner for removal.
- The sunset date or measurable removal condition.

Manual steps that do not have this budget entry must stay out of the default flow. They can live only in `高级区` as diagnostics, recovery, or development tools.

## KPI Rules

Daily KPI:

- Automatic pass rate: completed default `queue-run` full-flow jobs divided by finished default `queue-run` full-flow jobs. Exclude direct advanced runs, `recovery-run`, `manual-budget-trial` validation/rerun jobs, safe-retry release batches, jobs with a `repairPlanFile`, and jobs for products already released from the manual-step budget.
- Manual triggers per product: per Dianxiaomi work item, count the largest current manual trigger from `manual-budget` publish outcomes, non-auto repair actions, or non-auto/non-safe failure diagnosis. Auto-ready repair plans, `autoRetryRecommended` failures, recovery/rerun activity, and Advanced-only diagnostics are not manual triggers.

Fault recovery KPI:

- `repair-preview` and `repair-apply` are recovery tools only.
- `repair-*` readiness, job count, and success are useful for debugging and recovery, but they are not daily main-path KPI.
- `recovery-run` history and repeated-failure alerts are operational safety signals. They can appear as compact daily alerts when automation stops reducing manual work for a specific product or repair action, but recovery controls stay in `高级区`.
- Repeated browser recovery failures must pause unattended retries until the product, repair plan, or relevant selector/media calibration changes. Manual recovery retries can remain available in `高级区` for troubleshooting, but the daemon should not spend cycles on a known bad recovery path.
- Recovery pause releases should be auditable in `高级区`: the system must show what changed before a paused product/action became eligible for unattended recovery again.
- Released recovery pauses must use a bounded retry lane first: at most one released item per daemon tick, marked as `recoveryPolicy="released-retry"`, before the item/action returns to normal unattended recovery behavior.
- A release event can clear only failures that happened before that event was recorded. If released retry fails again, the same release event is spent and the product/action must pause until a newer product, repair-plan, or selector/media calibration change exists.
- Unattended daemon decisions must remain auditable in `高级区`. Recent ticks should explain the decision, subject, reason, linked queue/recovery run, affected work items, failure impact, and next action without adding controls or diagnostic bulk to the default flow.

## AI Admission Gate

AI features enter the default flow only when they reduce manual work. A feature must prove at least one of:

- Fewer operator clicks per product.
- Fewer human judgment decisions per product.
- Higher automatic pass rate without increasing manual triggers.

AI features that only add explanation, extra review text, or another screen stay in `高级区` until they meet this gate.
