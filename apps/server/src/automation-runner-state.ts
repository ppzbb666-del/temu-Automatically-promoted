// Shared mutable runtime state for the automation runner (domain-split refactor).
//
// These singletons are read and mutated across many runner domains (job
// lifecycle, full-flow, queue-run, recovery, queue-daemon health/tick). Hoisting
// them into one leaf module lets every domain import the state without importing
// each other — turning the old intra-file web of shared closures into a star
// topology around this module and breaking the J/K and O/F/Q import cycles.
//
// IMPORTANT: every binding here is a `const` container mutated IN PLACE
// (Map.set/delete, Set.add/delete, Array.push/splice). None is ever reassigned,
// so importers can mutate them directly with no accessor indirection. Domain
// ledgers that ARE reassigned (manual-budget proof/trial, recovery releases,
// profile-lock audit, queueDaemonState) deliberately stay with their owning
// domain, where the `let` binding and its mutators live together.
import type { AutomationMode, AutomationQueueDaemonState } from "@temu-ai-ops/shared";
import { DEFAULT_UNATTENDED_MEDIA_AUTOMATION_TOOLS } from "./automation-runner-constants";

// Queue-daemon state machine + scheduler handle. Reassigned across ~120 sites
// in many domains (daemon lifecycle/tick, startup check, health, scope-tick), so
// it lives behind a holder object rather than a bare `let`: every consumer reads
// and writes daemonStateHolder.current / .timer, which works across module
// boundaries because it mutates a property on this shared const object.
export const defaultQueueDaemonState = (): AutomationQueueDaemonState => ({
    status: "PAUSED",
    input: {
        limit: 1,
        mediaAutomationMode: "unattended-apply",
        mediaAutomationTools: [...DEFAULT_UNATTENDED_MEDIA_AUTOMATION_TOOLS],
        submitAfterSave: false,
        submitMaxAttempts: 3
    },
    intervalSeconds: 300,
    maxConsecutiveFailures: 3,
    running: false,
    consecutiveFailures: 0,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastError: null,
    lastQueueRunId: null,
    lastRecoveryRunId: null,
    nextRunAt: null,
    trackedFlowJobIds: [],
    resolvedFlowJobIds: [],
    flowOutcomes: [],
    ticks: []
});
export const daemonStateHolder: { current: any; timer: any } = { current: defaultQueueDaemonState(), timer: null };

// Profile-lock archive audit ledger. Reassigned both by the ledger-persistence
// module (load/reset) and by the archive-action path in automation-runner.ts, so
// it lives behind a holder object (mutate profileLockAuditHolder.current) rather
// than a bare `let` that importers could not reassign.
export const profileLockAuditHolder: { current: any[] } = { current: [] };

// Per-mode single-automation job stores (dry-run / repair-preview / repair-apply
// / fill-draft / save-draft / submit-listing). Routed by getJobStore below.
export const dryRunJobs = new Map();
export const repairPreviewJobs = new Map();
export const repairApplyJobs = new Map();
export const fillDraftJobs = new Map();
export const saveDraftJobs = new Map();
export const submitListingJobs = new Map();

// Full-flow job store — the single most cross-cutting singleton (full-flow,
// queue-daemon health, manual-budget trial, flow-outcome recovery all read it).
export const fullFlowJobs = new Map();

// Recovery-run store.
export const recoveryRuns = new Map();

// Dedup guard so a full-flow work item's terminal outcome is resolved once.
export const resolvedFullFlowWorkItemIds = new Set();

// Target fingerprint -> running job id, so a second start targeting the same
// surface is rejected instead of racing the first.
export const runningTargetLocks = new Map();

// Full-flow stages launch Playwright persistent contexts when a profile is
// configured. Chromium cannot safely open the same user-data-dir from
// concurrent launches, so full-flow executions sharing one profile must run
// serially even when they target different products.
export const runningFullFlowProfileLocks = new Map<string, string>();
export const waitingFullFlowProfileLockResolvers = new Map<string, Array<() => void>>();

// P1-5: in-flight Dianxiaomi work item ids. A work item enters the set when its
// full-flow job starts and leaves when the job resolves (completed / failed /
// recovery-released). queue-run / recovery-run / manual-trial paths consult this
// set so concurrent triggers don't double-pick the same item.
export const inFlightWorkItemIds = new Set<string>();

// Queue-run result history (capped at 50 by the queue-run domain on write).
export const queueRunHistory = [];

// Route an automation mode to its job store.
export const getJobStore = (mode: AutomationMode) => {
    if (mode === "dry-run") {
        return dryRunJobs;
    }
    if (mode === "repair-preview") {
        return repairPreviewJobs;
    }
    if (mode === "repair-apply") {
        return repairApplyJobs;
    }
    if (mode === "fill-draft") {
        return fillDraftJobs;
    }
    if (mode === "save-draft") {
        return saveDraftJobs;
    }
    return submitListingJobs;
};
