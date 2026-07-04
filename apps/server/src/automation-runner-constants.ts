// Leaf module extracted from automation-runner.ts (domain-split refactor).
// Pure constants, persistence-path getters, and dependency-free utility helpers.
// No mutable state, no cross-domain imports — every runner domain module may
// import from here without risk of an import cycle.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const getRepoRoot = () => {
    const currentFile = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(currentFile), "../../..");
};

export const timestampId = () => new Date().toISOString().replace(/[:.]/g, "-");

export const DEFAULT_SCREENSHOT_DIR = "output/playwright";
export const DEFAULT_ARTIFACT_ROOT = ".runtime/automation-artifacts";
export const DEFAULT_UNATTENDED_MEDIA_AUTOMATION_TOOLS = ["image-translation", "batch-resize"];
export const DEFAULT_AUTOMATION_JOB_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_FULL_FLOW_JOB_TIMEOUT_MS = 60 * 60 * 1000;
export const AUTOMATION_JOB_TIMEOUT_MS_BY_MODE = {
    "dry-run": DEFAULT_AUTOMATION_JOB_TIMEOUT_MS,
    "repair-preview": DEFAULT_AUTOMATION_JOB_TIMEOUT_MS,
    "repair-apply": 15 * 60 * 1000,
    "fill-draft": 20 * 60 * 1000,
    "save-draft": 15 * 60 * 1000,
    "submit-listing": 20 * 60 * 1000
};
export const getAutomationJobTimeoutMs = (mode) => AUTOMATION_JOB_TIMEOUT_MS_BY_MODE[mode] ?? DEFAULT_AUTOMATION_JOB_TIMEOUT_MS;
export const getFullFlowJobTimeoutMs = () => DEFAULT_FULL_FLOW_JOB_TIMEOUT_MS;

export const getQueueDaemonStatePath = () => process.env.QUEUE_DAEMON_STATE_PATH ?? path.join(getRepoRoot(), ".runtime/data/queue-daemon-state.json");
export const getRecoveryRunHistoryPath = () => process.env.RECOVERY_RUN_HISTORY_PATH ?? path.join(getRepoRoot(), ".runtime/data/recovery-runs.json");
export const getQueueRunHistoryPath = () => process.env.QUEUE_RUN_HISTORY_PATH ?? path.join(getRepoRoot(), ".runtime/data/queue-run-history.json");
export const getManualBudgetProofLedgerPath = () => process.env.MANUAL_BUDGET_PROOF_LEDGER_PATH ?? path.join(getRepoRoot(), ".runtime/data/manual-budget-proof-ledger.json");
export const getManualBudgetTrialHistoryPath = () => process.env.MANUAL_BUDGET_TRIAL_HISTORY_PATH ?? path.join(getRepoRoot(), ".runtime/data/manual-budget-trials.json");
export const getProfileLockLedgerPath = () => process.env.PROFILE_LOCK_LEDGER_PATH ?? path.join(getRepoRoot(), ".runtime/data/profile-lock-ledger.json");

export const RECOVERY_RUN_HISTORY_LIMIT = 50;
export const RECOVERY_RELEASE_HISTORY_LIMIT = 50;
export const QUEUE_RUN_HISTORY_LIMIT = 50;
// P1-13: per-product / per-action cumulative recovery cap. After this many
// recovery failures, release events can no longer un-pause the item; it must
// go to the manual-step budget.
export const RECOVERY_MAX_CUMULATIVE_ATTEMPTS = 5;
export const MANUAL_BUDGET_PROOF_LEDGER_LIMIT = 100;
export const MANUAL_BUDGET_TRIAL_HISTORY_LIMIT = 100;
export const PROFILE_LOCK_AUDIT_LIMIT = 100;
export const RECOVERY_FAILURE_ALERT_THRESHOLD = 2;
export const RECOVERY_RELEASED_RETRY_BATCH_LIMIT = 1;
export const DEFAULT_PROFILE_LOCK_STALE_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_REAL_CALIBRATION_STALE_MS = 24 * 60 * 60 * 1000;

export const allowDianxiaomiSmokeCalibration = () => process.env.ALLOW_DIANXIAOMI_SMOKE_URLS === "true";

export const clampInteger = (value, fallback, min, max) => {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, Math.floor(value)));
};

export const getProfileLockStaleMs = () => clampInteger(Number.parseInt(process.env.PROFILE_LOCK_STALE_MINUTES ?? "", 10), DEFAULT_PROFILE_LOCK_STALE_MS / 60_000, 5, 7 * 24 * 60) * 60_000;
export const getRealCalibrationStaleMs = () => clampInteger(Number.parseInt(process.env.REAL_DIANXIAOMI_CALIBRATION_STALE_MINUTES ?? "", 10), DEFAULT_REAL_CALIBRATION_STALE_MS / 60_000, 30, 7 * 24 * 60) * 60_000;

// OOM mitigation (layer 1). See docs/oom-mitigation-plan.md.
// Unattended selection skips work items whose stored snapshot.skuCount exceeds
// this cap — large variant grids are the products that OOM the browser during
// fill-stage variant-remap (operator measured 189 stable, 322 crashes). Read the
// ALREADY-STORED snapshot; never open a page to probe (dry-run also triggers
// variant-remap). Default 200; clamp 1..2000.
export const DEFAULT_UNATTENDED_MAX_SKU = 200;
export const getUnattendedMaxSku = () => clampInteger(Number.parseInt(process.env.UNATTENDED_MAX_SKU ?? "", 10), DEFAULT_UNATTENDED_MAX_SKU, 1, 2000);
// Before spawning a full-flow, the daemon checks host free memory; below this
// floor it defers the tick (clean wait, not a failure) so a low-memory host
// doesn't crash a browser mid-run. Default 3072 MB; clamp 256..131072.
export const DEFAULT_UNATTENDED_MIN_FREE_MEM_MB = 3072;
export const getUnattendedMinFreeMemMb = () => clampInteger(Number.parseInt(process.env.UNATTENDED_MIN_FREE_MEM_MB ?? "", 10), DEFAULT_UNATTENDED_MIN_FREE_MEM_MB, 256, 131072);

export const formatDurationCompact = (durationMs) => {
    const minutes = Math.max(1, Math.round(durationMs / 60_000));
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = minutes / 60;
    if (hours < 48) {
        const roundedHours = Math.round(hours * 10) / 10;
        return Number.isInteger(roundedHours) ? `${roundedHours}h` : `${roundedHours.toFixed(1)}h`;
    }
    const days = hours / 24;
    const roundedDays = Math.round(days * 10) / 10;
    return Number.isInteger(roundedDays) ? `${roundedDays}d` : `${roundedDays.toFixed(1)}d`;
};

export const parseTimestampMs = (value) => {
    if (typeof value !== "string" || value.trim() === "") {
        return null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
};

export const averagePerProduct = (total, productCount) => productCount > 0 ? total / productCount : 0;
