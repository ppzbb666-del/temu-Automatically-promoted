import { createHash } from "node:crypto";
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { createTaskFromDianxiaomiProductWorkItem, exportTaskFile, findTaskByDianxiaomiWorkItemId, getTaskFileExportSnapshotStatus, exportDianxiaomiRepairPreview, getSelectorConfigVersions, listSelectorDiagnosisReports, listDianxiaomiProductWorkItems, mergeDianxiaomiProductWorkItemSnapshot, persistPlannerState, recomputeDraftPricingIfStale, restoreSelectorConfigVersion, updateDianxiaomiProductWorkItemStatus, validateDianxiaomiAutomationPageUrl, validateSelectorConfig } from "./planner";
import { startDianxiaomiImageCheck } from "./dianxiaomi-image-check-runner";
import { hasAutomationItemScope, matchesAutomationItemScope, normalizeAutomationItemUrls, normalizeAutomationSourceBuckets } from "@temu-ai-ops/shared";
import type { AutomationDryRunStartInput, AutomationModeReadiness, AutomationQueueDaemonInput, AutomationQueueDaemonState, AutomationQueueDaemonTick, AutomationRecoveryFailureSummary, DianxiaomiProductWorkItem, DianxiaomiPublishOutcome, DianxiaomiWorkFailureDiagnosis } from "@temu-ai-ops/shared";
export class AutomationSafetyGateError extends Error {
    statusCode = 409;
    constructor(message) {
        super(message);
        this.name = "AutomationSafetyGateError";
    }
}
// Constants, persistence-path getters, and dependency-free utilities were
// extracted to ./automation-runner-constants during the domain-split refactor.
// getAutomationJobTimeoutMs / getFullFlowJobTimeoutMs are re-exported below to
// preserve this module's public API.
import {
    getRepoRoot,
    timestampId,
    DEFAULT_SCREENSHOT_DIR,
    DEFAULT_ARTIFACT_ROOT,
    DEFAULT_UNATTENDED_MEDIA_AUTOMATION_TOOLS,
    DEFAULT_AUTOMATION_JOB_TIMEOUT_MS,
    DEFAULT_FULL_FLOW_JOB_TIMEOUT_MS,
    AUTOMATION_JOB_TIMEOUT_MS_BY_MODE,
    getAutomationJobTimeoutMs,
    getFullFlowJobTimeoutMs,
    getQueueDaemonStatePath,
    getRecoveryRunHistoryPath,
    getManualBudgetProofLedgerPath,
    getManualBudgetTrialHistoryPath,
    getProfileLockLedgerPath,
    RECOVERY_RUN_HISTORY_LIMIT,
    RECOVERY_RELEASE_HISTORY_LIMIT,
    RECOVERY_MAX_CUMULATIVE_ATTEMPTS,
    MANUAL_BUDGET_PROOF_LEDGER_LIMIT,
    MANUAL_BUDGET_TRIAL_HISTORY_LIMIT,
    PROFILE_LOCK_AUDIT_LIMIT,
    RECOVERY_FAILURE_ALERT_THRESHOLD,
    RECOVERY_RELEASED_RETRY_BATCH_LIMIT,
    DEFAULT_PROFILE_LOCK_STALE_MS,
    DEFAULT_REAL_CALIBRATION_STALE_MS,
    allowDianxiaomiSmokeCalibration,
    clampInteger,
    getProfileLockStaleMs,
    getRealCalibrationStaleMs,
    formatDurationCompact,
    parseTimestampMs,
    averagePerProduct
} from "./automation-runner-constants";
export { getAutomationJobTimeoutMs, getFullFlowJobTimeoutMs };
// Ledger persistence (manual-budget proof + profile-lock audit) was extracted
// to ./automation-runner-ledgers. Symbols used by the remaining domains are
// imported below; the two public-API functions are re-exported.
import {
    manualBudgetProofLedger,
    manualBudgetProofSources,
    normalizeManualBudgetProofText,
    normalizeManualBudgetProofNumber,
    profileLockAuditId,
    normalizeProfileLockAuditEntry,
    persistProfileLockAuditLedger,
    loadProfileLockAuditLedger,
    profileLockAuditSummary,
    cloneManualBudgetProofAutomationMeasurement,
    cloneManualBudgetProofRecord,
    normalizeManualBudgetProofAutomationMeasurement,
    measureAutomationReports,
    loadManualBudgetProofLedger,
    listManualBudgetProofRecords,
    recordManualBudgetProof
} from "./automation-runner-ledgers";
export { listManualBudgetProofRecords, recordManualBudgetProof };
const cloneManualBudgetTrialProposal = (proposal) => proposal
    ? {
        ...proposal,
        sampleWorkItemIds: [...proposal.sampleWorkItemIds],
        sampleTitles: [...proposal.sampleTitles],
        acceptanceCriteria: [...proposal.acceptanceCriteria],
        rollbackCriteria: [...proposal.rollbackCriteria],
        readinessChecks: proposal.readinessChecks.map((check) => ({ ...check }))
    }
    : null;
const cloneManualBudgetTrialFlowOutcome = (outcome) => ({
    ...outcome,
    reportPaths: [...outcome.reportPaths]
});
const cloneManualBudgetTrialOutcome = (outcome) => ({
    ...outcome,
    automationMeasurement: outcome.automationMeasurement
        ? cloneManualBudgetProofAutomationMeasurement(outcome.automationMeasurement)
        : undefined,
    flowOutcomes: outcome.flowOutcomes.map(cloneManualBudgetTrialFlowOutcome)
});
const cloneManualBudgetTrialRecord = (record) => ({
    ...record,
    validationRerun: record.validationRerun ? { ...record.validationRerun } : null,
    acceptedRollbackCriteria: [...record.acceptedRollbackCriteria],
    proposal: cloneManualBudgetTrialProposal(record.proposal),
    readinessChecks: record.readinessChecks.map((check) => ({ ...check })),
    flowJobIds: [...record.flowJobIds],
    skippedItems: record.skippedItems.map((item) => ({ ...item })),
    outcome: cloneManualBudgetTrialOutcome(record.outcome)
});
const buildBlockedManualBudgetTrialOutcome = (message, resolvedAt) => ({
    status: "blocked",
    resolvedAt,
    message,
    completed: 0,
    failed: 0,
    running: 0,
    missing: 0,
    proofRecordId: null,
    flowOutcomes: []
});
const buildRunningManualBudgetTrialOutcome = (flowJobIds, message) => ({
    status: "running",
    resolvedAt: null,
    message,
    completed: 0,
    failed: 0,
    running: flowJobIds.length,
    missing: 0,
    proofRecordId: null,
    flowOutcomes: flowJobIds.map((flowJobId) => ({
        flowJobId,
        workItemId: fullFlowJobs.get(flowJobId)?.workItemId ?? null,
        status: fullFlowJobs.get(flowJobId)?.status ?? "running",
        finishedAt: fullFlowJobs.get(flowJobId)?.finishedAt ?? null,
        reportPaths: [],
        failureReason: null
    }))
});
const isManualBudgetTrialReadinessStatus = (status) => status === "ready" || status === "warning" || status === "blocked";
const isManualBudgetTrialOutcomeStatus = (status) => status === "blocked" || status === "running" || status === "passed" || status === "failed";
const isAutomationPreflightCheckStatus = (status) => status === "pass" || status === "warning" || status === "block";
const isManualBudgetValidationRerunRoute = (route) => route === "auto-retry" || route === "browser-recovery" || route === "profile-fix";
const normalizeManualBudgetValidationRerun = (value) => {
    if (!value || typeof value !== "object") {
        return null;
    }
    const candidate = value;
    const sourceTrialId = normalizeManualBudgetProofText(candidate.sourceTrialId);
    const route = candidate.route;
    if (!sourceTrialId || !isManualBudgetValidationRerunRoute(route)) {
        return null;
    }
    return {
        sourceTrialId,
        route,
        reason: normalizeManualBudgetProofText(candidate.reason) || `validation rerun after ${route}`,
        requestedBy: "queue-daemon"
    };
};
const normalizeManualBudgetTrialProposal = (proposal) => {
    if (!proposal || typeof proposal !== "object") {
        return null;
    }
    const candidate = proposal;
    const candidateKey = normalizeManualBudgetProofText(candidate.candidateKey);
    const source = candidate.source;
    const reason = normalizeManualBudgetProofText(candidate.reason);
    const replacementPlan = normalizeManualBudgetProofText(candidate.replacementPlan);
    const proofRecordId = normalizeManualBudgetProofText(candidate.proofRecordId);
    if (!candidateKey || !source || !manualBudgetProofSources.has(source) || !reason || !replacementPlan || !proofRecordId) {
        return null;
    }
    const readinessStatus = isManualBudgetTrialReadinessStatus(candidate.readinessStatus)
        ? candidate.readinessStatus
        : "blocked";
    return {
        candidateKey,
        source,
        reason,
        replacementPlan,
        proofRecordId,
        proofConfidence: "measured",
        trialSize: clampInteger(candidate.trialSize, 1, 1, 100),
        trialScope: normalizeManualBudgetProofText(candidate.trialScope) || "Run a bounded measured Dianxiaomi trial before default promotion.",
        sampleWorkItemIds: Array.isArray(candidate.sampleWorkItemIds)
            ? candidate.sampleWorkItemIds.map(normalizeManualBudgetProofText).filter(Boolean).slice(0, 20)
            : [],
        sampleTitles: Array.isArray(candidate.sampleTitles)
            ? candidate.sampleTitles.map(normalizeManualBudgetProofText).filter(Boolean).slice(0, 20)
            : [],
        measuredReportCount: clampInteger(candidate.measuredReportCount, 0, 0, 100),
        measuredBrowserClicks: Math.max(0, normalizeManualBudgetProofNumber(candidate.measuredBrowserClicks)),
        measuredBrowserActions: Math.max(0, normalizeManualBudgetProofNumber(candidate.measuredBrowserActions)),
        acceptanceCriteria: Array.isArray(candidate.acceptanceCriteria)
            ? candidate.acceptanceCriteria.map(normalizeManualBudgetProofText).filter(Boolean).slice(0, 20)
            : [],
        rollbackCriteria: Array.isArray(candidate.rollbackCriteria)
            ? candidate.rollbackCriteria.map(normalizeManualBudgetProofText).filter(Boolean).slice(0, 20)
            : [],
        readinessStatus,
        readinessChecks: Array.isArray(candidate.readinessChecks)
            ? candidate.readinessChecks
                .map((check) => {
                if (!check || typeof check !== "object") {
                    return null;
                }
                const normalizedCheck = check;
                const status = isAutomationPreflightCheckStatus(normalizedCheck.status)
                    ? normalizedCheck.status
                    : "block";
                return {
                    id: normalizeManualBudgetProofText(normalizedCheck.id) || "readiness-check",
                    label: normalizeManualBudgetProofText(normalizedCheck.label) || "readiness check",
                    status,
                    message: normalizeManualBudgetProofText(normalizedCheck.message) || "readiness check restored from history"
                };
            })
                .filter((check) => Boolean(check))
                .slice(0, 20)
            : [],
        executionReady: candidate.executionReady === true,
        rollbackAcknowledgementRequired: candidate.rollbackAcknowledgementRequired === true,
        note: normalizeManualBudgetProofText(candidate.note)
    };
};
const normalizeManualBudgetTrialOutcome = (outcome, fallback) => {
    if (!outcome || typeof outcome !== "object") {
        return fallback.status === "started" && fallback.flowJobIds.length > 0
            ? buildRunningManualBudgetTrialOutcome(fallback.flowJobIds, fallback.message)
            : buildBlockedManualBudgetTrialOutcome(fallback.message, fallback.updatedAt);
    }
    const candidate = outcome;
    const status = isManualBudgetTrialOutcomeStatus(candidate.status)
        ? candidate.status
        : fallback.status === "started" ? "running" : "blocked";
    return {
        status,
        resolvedAt: normalizeManualBudgetProofText(candidate.resolvedAt) || (status === "running" ? null : fallback.updatedAt),
        message: normalizeManualBudgetProofText(candidate.message) || fallback.message,
        completed: clampInteger(candidate.completed, 0, 0, 100),
        failed: clampInteger(candidate.failed, 0, 0, 100),
        running: clampInteger(candidate.running, status === "running" ? fallback.flowJobIds.length : 0, 0, 100),
        missing: clampInteger(candidate.missing, 0, 0, 100),
        proofRecordId: normalizeManualBudgetProofText(candidate.proofRecordId) || null,
        automationMeasurement: normalizeManualBudgetProofAutomationMeasurement(candidate.automationMeasurement),
        flowOutcomes: Array.isArray(candidate.flowOutcomes)
            ? candidate.flowOutcomes
                .map((flowOutcome) => {
                if (!flowOutcome || typeof flowOutcome !== "object") {
                    return null;
                }
                const normalized = flowOutcome;
                const flowJobId = normalizeManualBudgetProofText(normalized.flowJobId);
                if (!flowJobId) {
                    return null;
                }
                const flowStatus = normalized.status === "completed" || normalized.status === "failed" || normalized.status === "running" || normalized.status === "missing"
                    ? normalized.status
                    : "missing";
                return {
                    flowJobId,
                    workItemId: normalizeManualBudgetProofText(normalized.workItemId) || null,
                    status: flowStatus,
                    finishedAt: normalizeManualBudgetProofText(normalized.finishedAt) || null,
                    reportPaths: Array.isArray(normalized.reportPaths)
                        ? normalized.reportPaths.map(normalizeManualBudgetProofText).filter(Boolean).slice(0, 20)
                        : [],
                    failureReason: normalizeManualBudgetProofText(normalized.failureReason) || null
                };
            })
                .filter((flowOutcome) => Boolean(flowOutcome))
                .slice(0, 100)
            : []
    };
};
const normalizeManualBudgetTrialRecord = (record) => {
    const id = normalizeManualBudgetProofText(record.id);
    const requestedAt = normalizeManualBudgetProofText(record.requestedAt);
    const candidateKey = normalizeManualBudgetProofText(record.candidateKey);
    const status = record.status === "started" ? "started" : "blocked";
    const message = normalizeManualBudgetProofText(record.message) || "manual-budget bounded trial restored from history";
    if (!id || !requestedAt || !candidateKey) {
        return null;
    }
    const updatedAt = normalizeManualBudgetProofText(record.updatedAt) || requestedAt;
    const readinessStatus = isManualBudgetTrialReadinessStatus(record.readinessStatus)
        ? record.readinessStatus
        : "blocked";
    const flowJobIds = Array.isArray(record.flowJobIds)
        ? record.flowJobIds.map(normalizeManualBudgetProofText).filter(Boolean).slice(0, 100)
        : [];
    return {
        id,
        requestedAt,
        updatedAt,
        candidateKey,
        validationRerun: normalizeManualBudgetValidationRerun(record.validationRerun),
        status,
        message,
        rollbackAcknowledged: record.rollbackAcknowledged === true,
        acceptedRollbackCriteria: Array.isArray(record.acceptedRollbackCriteria)
            ? record.acceptedRollbackCriteria.map(normalizeManualBudgetProofText).filter(Boolean).slice(0, 20)
            : [],
        proposal: normalizeManualBudgetTrialProposal(record.proposal),
        readinessStatus,
        readinessChecks: Array.isArray(record.readinessChecks)
            ? record.readinessChecks
                .map((check) => {
                if (!check || typeof check !== "object") {
                    return null;
                }
                const normalizedCheck = check;
                const checkStatus = isAutomationPreflightCheckStatus(normalizedCheck.status)
                    ? normalizedCheck.status
                    : "block";
                return {
                    id: normalizeManualBudgetProofText(normalizedCheck.id) || "readiness-check",
                    label: normalizeManualBudgetProofText(normalizedCheck.label) || "readiness check",
                    status: checkStatus,
                    message: normalizeManualBudgetProofText(normalizedCheck.message) || "readiness check restored from history"
                };
            })
                .filter((check) => Boolean(check))
                .slice(0, 20)
            : [],
        trialSize: clampInteger(record.trialSize, flowJobIds.length, 0, 100),
        flowJobIds,
        skippedItems: Array.isArray(record.skippedItems)
            ? record.skippedItems
                .map((item) => {
                if (!item || typeof item !== "object") {
                    return null;
                }
                const normalizedItem = item;
                const workItemId = normalizeManualBudgetProofText(normalizedItem.workItemId);
                const reason = normalizeManualBudgetProofText(normalizedItem.reason);
                return workItemId && reason ? { workItemId, reason } : null;
            })
                .filter((item) => Boolean(item))
                .slice(0, 100)
            : [],
        outcome: normalizeManualBudgetTrialOutcome(record.outcome, {
            status,
            message,
            updatedAt,
            flowJobIds
        })
    };
};
const persistManualBudgetTrialHistory = () => {
    const historyPath = getManualBudgetTrialHistoryPath();
    mkdirSync(path.dirname(historyPath), {
        recursive: true
    });
    writeFileSync(historyPath, JSON.stringify({
        trials: manualBudgetTrialHistory
            .slice(0, MANUAL_BUDGET_TRIAL_HISTORY_LIMIT)
            .map(cloneManualBudgetTrialRecord)
    }, null, 2), "utf8");
};
const loadManualBudgetTrialHistory = () => {
    const historyPath = getManualBudgetTrialHistoryPath();
    if (!existsSync(historyPath)) {
        return;
    }
    try {
        const parsed = JSON.parse(readFileSync(historyPath, "utf8"));
        const trials = Array.isArray(parsed) ? parsed : Array.isArray(parsed.trials) ? parsed.trials : [];
        manualBudgetTrialHistory = trials
            .map(normalizeManualBudgetTrialRecord)
            .filter((record) => Boolean(record))
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .slice(0, MANUAL_BUDGET_TRIAL_HISTORY_LIMIT);
        refreshRunningManualBudgetTrialOutcomes();
    }
    catch {
        manualBudgetTrialHistory = [];
    }
};
const saveManualBudgetTrialRecord = (record) => {
    manualBudgetTrialHistory = [
        record,
        ...manualBudgetTrialHistory.filter((existing) => existing.id !== record.id)
    ]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, MANUAL_BUDGET_TRIAL_HISTORY_LIMIT);
    persistManualBudgetTrialHistory();
    return cloneManualBudgetTrialRecord(record);
};
const buildEmptyManualBudgetValidationFailureTriage = (status = "none", nextAction = "No validation failure needs triage.") => ({
    status,
    category: null,
    route: status === "running" ? "wait" : "none",
    reason: null,
    nextAction,
    recoverable: false,
    countsAsManualBudget: false,
    trialId: null,
    candidateKey: null,
    workItemIds: []
});
const buildManualBudgetValidationFailureTriage = (latest, status) => {
    if (!latest) {
        return buildEmptyManualBudgetValidationFailureTriage();
    }
    if (status === "running") {
        return buildEmptyManualBudgetValidationFailureTriage("running", `Wait for validation request ${latest.id} to finish before routing the result.`);
    }
    if (status === "passed") {
        return buildEmptyManualBudgetValidationFailureTriage("none", `Validation request ${latest.id} passed; no failure route is needed.`);
    }
    if (latest.outcome.status === "blocked" && latest.flowJobIds.length === 0) {
        return buildEmptyManualBudgetValidationFailureTriage("none", `Validation request ${latest.id} did not start; readiness checks explain the blocker.`);
    }
    const failureReasons = [
        ...latest.skippedItems.map((item) => item.reason),
        ...latest.outcome.flowOutcomes.map((outcome) => outcome.failureReason).filter((reason) => Boolean(reason)),
        latest.outcome.missing > 0 ? "manual-budget validation full-flow job missing after restart" : null,
        latest.outcome.message,
        latest.message
    ].filter((reason) => Boolean(reason?.trim()));
    const reason = failureReasons[0] ?? "manual-budget validation did not produce a clean pass";
    const missingOnly = latest.outcome.missing > 0
        && latest.outcome.failed === 0
        && latest.outcome.completed === 0;
    const diagnosis = missingOnly
        ? null
        : classifyDianxiaomiWorkFailure(reason, "queue-daemon");
    const workItemIds = Array.from(new Set([
        ...latest.skippedItems.map((item) => item.workItemId),
        ...latest.outcome.flowOutcomes.map((outcome) => outcome.workItemId).filter((workItemId) => Boolean(workItemId))
    ])).slice(0, 20);
    const blockedCategories = new Set([
        "login-or-captcha",
        "real-page-calibration",
        "selector-config",
        "target-surface"
    ]);
    const browserRecoveryCategories = new Set([
        "media-processing",
        "publish-validation"
    ]);
    const route = missingOnly
        ? "blocked"
        : diagnosis?.autoRetryRecommended
            ? "auto-retry"
            : diagnosis?.category === "browser-profile"
                ? "profile-fix"
                : diagnosis && browserRecoveryCategories.has(diagnosis.category)
                    ? "browser-recovery"
                    : diagnosis && blockedCategories.has(diagnosis.category)
                        ? "blocked"
                        : "manual-budget";
    const triageStatus = route === "auto-retry" || route === "browser-recovery" || route === "profile-fix"
        ? "recoverable"
        : route === "blocked"
            ? "blocked"
            : "manual-budget";
    const nextAction = missingOnly
        ? "Do not promote this replacement; rerun the bounded validation because the original full-flow job is no longer available."
        : route === "auto-retry"
            ? "Refresh the task file or transient input, then let the existing unattended safe retry path handle the next queue pass."
            : route === "profile-fix"
                ? diagnosis?.nextAction ?? "Fix the browser profile issue, then rerun bounded validation."
                : route === "browser-recovery"
                    ? "Keep this outside the default path and route the affected product through the existing browser recovery loop before rerunning validation."
                    : route === "blocked"
                        ? diagnosis?.nextAction ?? "Resolve the blocking environment or calibration issue, then rerun validation."
                        : diagnosis?.nextAction ?? "Keep the candidate in manual-step budget until a replacement plan proves it reduces operator work.";
    return {
        status: triageStatus,
        category: missingOnly ? "missing-flow" : diagnosis?.category ?? null,
        route,
        reason,
        nextAction,
        recoverable: route === "auto-retry" || route === "browser-recovery" || route === "profile-fix",
        countsAsManualBudget: route === "manual-budget",
        trialId: latest.id,
        candidateKey: latest.candidateKey,
        workItemIds
    };
};
const buildEmptyManualBudgetValidationRerunPolicy = (status = "not-needed", reason = "No validation rerun is needed.", nextAction = "Keep the daemon running.") => ({
    status,
    route: "none",
    sourceTrialId: null,
    retryTrialId: null,
    candidateKey: null,
    attemptsUsed: 0,
    maxAttempts: 1,
    prerequisiteStatus: "none",
    prerequisiteCompletedAt: null,
    reason,
    nextAction,
    workItemIds: []
});
const latestValidationRerunForSource = (sourceTrialId) => manualBudgetTrialHistory
    .filter((trial) => trial.validationRerun?.sourceTrialId === sourceTrialId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
const latestIso = (values) => values
    .filter((value) => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
const buildValidationRerunPrerequisite = (latest, triage) => {
    const workItemIds = triage.workItemIds;
    if (triage.route === "auto-retry") {
        if (workItemIds.length === 0) {
            return {
                prerequisiteStatus: "blocked",
                prerequisiteCompletedAt: null,
                reason: "auto-retry validation rerun has no affected work item to verify",
                nextAction: "Keep this validation failure out of automatic rerun until the failed sample work item is known."
            };
        }
        const workItems = workItemIds.map((id) => listDianxiaomiProductWorkItems(Number.MAX_SAFE_INTEGER).find((item) => item.id === id) ?? null);
        const missing = workItems.findIndex((item) => !item);
        if (missing >= 0) {
            return {
                prerequisiteStatus: "blocked",
                prerequisiteCompletedAt: null,
                reason: `auto-retry validation sample ${workItemIds[missing]} is no longer in the work queue`,
                nextAction: "Regenerate the measured replacement proposal before another validation rerun."
            };
        }
        const released = workItems.every((item) => item
            && ["ready-for-automation", "edited"].includes(item.status)
            && item.updatedAt.localeCompare(latest.updatedAt) > 0);
        if (!released) {
            return {
                prerequisiteStatus: "pending",
                prerequisiteCompletedAt: null,
                reason: "auto-retry prerequisite is waiting for the affected task/input to be refreshed and released after the failed validation",
                nextAction: "Let the safe retry release path refresh the item, then the daemon can request one bounded validation rerun."
            };
        }
        return {
            prerequisiteStatus: "met",
            prerequisiteCompletedAt: latestIso(workItems.map((item) => item?.updatedAt)),
            reason: "affected auto-retry item was refreshed and released after the failed validation",
            nextAction: "The daemon may request one guarded validation rerun through the existing bounded trial gate."
        };
    }
    if (triage.route === "profile-fix") {
        const profile = inspectQueueDaemonProfile();
        if (!profile.path) {
            return {
                prerequisiteStatus: "blocked",
                prerequisiteCompletedAt: null,
                reason: "browser profile path is not configured",
                nextAction: "Configure a persistent logged-in Dianxiaomi profile before validation can rerun unattended."
            };
        }
        if (!profile.exists) {
            return {
                prerequisiteStatus: "pending",
                prerequisiteCompletedAt: null,
                reason: "browser profile directory does not exist yet",
                nextAction: "Create or initialize the configured Dianxiaomi browser profile before validation rerun."
            };
        }
        if (profile.lockFiles.length > 0) {
            return {
                prerequisiteStatus: "pending",
                prerequisiteCompletedAt: null,
                reason: `browser profile still has possible lock file(s): ${profile.lockFiles.join(", ")}`,
                nextAction: "Close other browser windows using this profile, then let the daemon retry validation once."
            };
        }
        return {
            prerequisiteStatus: "met",
            prerequisiteCompletedAt: statSync(profile.path).mtime.toISOString(),
            reason: "browser profile exists and has no detected lock files",
            nextAction: "The daemon may request one guarded validation rerun through the existing bounded trial gate."
        };
    }
    if (triage.route === "browser-recovery") {
        if (workItemIds.length === 0) {
            return {
                prerequisiteStatus: "blocked",
                prerequisiteCompletedAt: null,
                reason: "browser-recovery validation rerun has no affected work item to verify",
                nextAction: "Keep this validation failure out of automatic rerun until the failed sample work item is known."
            };
        }
        const completedRecoveryTimes = workItemIds.map((workItemId) => Array.from(recoveryRuns.values())
            .filter((run) => run.status === "completed")
            .flatMap((run) => run.items.map((item) => ({ run, item })))
            .filter(({ item }) => item.workItemId === workItemId
            && item.status === "completed"
            && Boolean(item.finishedAt)
            && item.finishedAt.localeCompare(latest.updatedAt) > 0)
            .sort((left, right) => (right.item.finishedAt ?? "").localeCompare(left.item.finishedAt ?? ""))[0]?.item.finishedAt ?? null);
        if (!completedRecoveryTimes.every(Boolean)) {
            return {
                prerequisiteStatus: "pending",
                prerequisiteCompletedAt: null,
                reason: "browser-recovery prerequisite is waiting for the affected product to complete the existing recovery loop",
                nextAction: "Let browser recovery finish successfully first; only then can validation rerun once."
            };
        }
        return {
            prerequisiteStatus: "met",
            prerequisiteCompletedAt: latestIso(completedRecoveryTimes),
            reason: "affected browser-recovery product completed a recovery run after the failed validation",
            nextAction: "The daemon may request one guarded validation rerun through the existing bounded trial gate."
        };
    }
    return {
        prerequisiteStatus: "blocked",
        prerequisiteCompletedAt: null,
        reason: `validation route ${triage.route} is not eligible for automatic rerun`,
        nextAction: triage.nextAction
    };
};
const buildManualBudgetValidationRerunPolicy = (latest, status, triage) => {
    if (!latest) {
        return buildEmptyManualBudgetValidationRerunPolicy();
    }
    if (status === "running") {
        return {
            ...buildEmptyManualBudgetValidationRerunPolicy("running", `validation request ${latest.id} is still running`, "Wait for the current validation request to finish before considering a rerun."),
            route: "wait",
            sourceTrialId: latest.validationRerun?.sourceTrialId ?? latest.id,
            retryTrialId: latest.validationRerun ? latest.id : null,
            candidateKey: latest.candidateKey
        };
    }
    if (status === "passed" || triage.status === "none") {
        return buildEmptyManualBudgetValidationRerunPolicy("not-needed", status === "passed" ? `validation request ${latest.id} passed` : triage.nextAction, "No validation rerun is needed.");
    }
    const eligibleRoutes = new Set(["auto-retry", "browser-recovery", "profile-fix"]);
    const sourceTrialId = latest.validationRerun?.sourceTrialId ?? latest.id;
    const retryTrial = latestValidationRerunForSource(sourceTrialId);
    const attemptsUsed = retryTrial ? 1 : 0;
    const base = {
        route: triage.route,
        sourceTrialId,
        retryTrialId: retryTrial?.id ?? null,
        candidateKey: triage.candidateKey,
        attemptsUsed,
        maxAttempts: 1,
        workItemIds: triage.workItemIds
    };
    if (!eligibleRoutes.has(triage.route)) {
        return {
            ...base,
            status: triage.status === "blocked" ? "blocked" : "ineligible",
            prerequisiteStatus: "blocked",
            prerequisiteCompletedAt: null,
            reason: `validation route ${triage.route} is not eligible for unattended rerun`,
            nextAction: triage.nextAction
        };
    }
    if (attemptsUsed >= 1) {
        return {
            ...base,
            status: retryTrial?.outcome.status === "running" ? "running" : "spent",
            prerequisiteStatus: retryTrial?.outcome.status === "running" ? "met" : "none",
            prerequisiteCompletedAt: null,
            reason: retryTrial
                ? `validation rerun budget already used by ${retryTrial.id}`
                : "validation rerun budget already used",
            nextAction: retryTrial?.outcome.status === "running"
                ? "Wait for the guarded validation rerun to finish."
                : "Do not rerun automatically again unless a newer measured validation request is created after another fix."
        };
    }
    const prerequisite = buildValidationRerunPrerequisite(latest, triage);
    if (prerequisite.prerequisiteStatus === "met") {
        return {
            ...base,
            ...prerequisite,
            status: "ready"
        };
    }
    return {
        ...base,
        ...prerequisite,
        status: prerequisite.prerequisiteStatus === "blocked" ? "blocked" : "waiting-for-fix"
    };
};
const buildManualBudgetValidationClosure = () => {
    const trials = manualBudgetTrialHistory.slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const latest = trials[0] ?? null;
    const running = trials.filter((trial) => trial.outcome.status === "running").length;
    const passed = trials.filter((trial) => trial.outcome.status === "passed").length;
    const failed = trials.filter((trial) => trial.outcome.status === "failed").length;
    const blocked = trials.filter((trial) => trial.outcome.status === "blocked").length;
    const status = trials.length === 0
        ? "idle"
        : running > 0
            ? "running"
            : latest?.outcome.status ?? "idle";
    const message = trials.length === 0
        ? "no manual-step validation requests have been recorded"
        : status === "running"
            ? `${running} manual-step validation request(s) still running`
            : latest?.outcome.message ?? "manual-step validation closure is available";
    const failureTriage = buildManualBudgetValidationFailureTriage(latest, status);
    const rerunPolicy = buildManualBudgetValidationRerunPolicy(latest, status, failureTriage);
    return {
        status,
        message,
        total: trials.length,
        running,
        passed,
        failed,
        blocked,
        latestTrialId: latest?.id ?? null,
        latestCandidateKey: latest?.candidateKey ?? null,
        latestStatus: latest?.outcome.status ?? null,
        latestUpdatedAt: latest?.updatedAt ?? null,
        latestMessage: latest?.outcome.message ?? null,
        latestProofRecordId: latest?.outcome.proofRecordId ?? null,
        latestMeasurement: latest?.outcome.automationMeasurement
            ? cloneManualBudgetProofAutomationMeasurement(latest.outcome.automationMeasurement)
            : null,
        failureTriage,
        rerunPolicy
    };
};
export const listManualBudgetTrials = (limit = 20) => {
    refreshRunningManualBudgetTrialOutcomes();
    return manualBudgetTrialHistory
        .slice(0, clampInteger(limit, 20, 1, MANUAL_BUDGET_TRIAL_HISTORY_LIMIT))
        .map(cloneManualBudgetTrialRecord);
};
const estimateManualBudgetBaselineClicks = (release) => {
    const normalized = `${release.reason} ${release.operatorAction}`.toLowerCase();
    let clicks = 2;
    if (normalized.includes("image") || normalized.includes("media") || normalized.includes("translation") || normalized.includes("resize")) {
        clicks += 2;
    }
    if (normalized.includes("attribute") || normalized.includes("required") || normalized.includes("validation")) {
        clicks += 1;
    }
    if (normalized.includes("login") || normalized.includes("captcha")) {
        clicks += 2;
    }
    return clicks;
};
const estimateManualBudgetBaselineDecisions = (release) => {
    const normalized = `${release.reason} ${release.operatorAction}`.toLowerCase();
    let decisions = 1;
    if (normalized.includes("image") || normalized.includes("media") || normalized.includes("attribute") || normalized.includes("validation")) {
        decisions += 1;
    }
    if (normalized.includes("login") || normalized.includes("captcha")) {
        decisions += 1;
    }
    return decisions;
};
const latestManualBudgetReleaseForWorkItem = (workItem) => (workItem.manualBudgetReleases ?? [])
    .slice()
    .sort((left, right) => right.releaseEventAt.localeCompare(left.releaseEventAt))[0] ?? null;
const measureRecoveryTrialAutomationReports = (input) => {
    const explicitReportPaths = input.automationReportPaths ?? [];
    const repairApplyReportPath = input.repairApplyJobId
        ? repairApplyJobs.get(input.repairApplyJobId)?.reportPath
        : null;
    const fullFlowReportPaths = input.fullFlowJobId
        ? fullFlowJobs.get(input.fullFlowJobId)?.stages.map((stage) => stage.reportPath) ?? []
        : [];
    return measureAutomationReports([
        ...explicitReportPaths,
        repairApplyReportPath,
        ...fullFlowReportPaths
    ]);
};
export const recordManualBudgetProofFromRecoveryTrial = (input) => {
    if (input.recoveryStatus === "skipped" || input.recoveryStatus.endsWith("-running")) {
        return null;
    }
    const workItem = listDianxiaomiProductWorkItems(Number.MAX_SAFE_INTEGER)
        .find((candidate) => candidate.id === input.workItemId);
    const release = workItem ? latestManualBudgetReleaseForWorkItem(workItem) : null;
    if (!workItem || !release) {
        return null;
    }
    const candidateKey = normalizeManualBudgetReplacementKey(release.source, release.reason);
    const duplicate = manualBudgetProofLedger.find((proof) => proof.candidateKey === candidateKey
        && proof.recordedBy === "recovery-run"
        && proof.evidence.includes(`recovery ${input.recoveryRunId}`)
        && proof.evidence.includes(`item ${workItem.id}`));
    if (duplicate) {
        return cloneManualBudgetProofRecord(duplicate);
    }
    const trialPassed = input.recoveryStatus === "completed";
    const automationMeasurement = measureRecoveryTrialAutomationReports(input);
    return recordManualBudgetProof({
        candidateKey,
        source: release.source,
        reason: release.reason,
        replacementPlan: buildManualBudgetReplacementPlan(release.reason, release.operatorAction),
        baseline: {
            productCount: 1,
            operatorClicks: estimateManualBudgetBaselineClicks(release),
            operatorDecisions: estimateManualBudgetBaselineDecisions(release)
        },
        trial: {
            productCount: 1,
            operatorClicks: 0,
            operatorDecisions: 0,
            status: trialPassed ? "passed" : "failed"
        },
        evidence: [
            `automatic recovery proof: recovery ${input.recoveryRunId}`,
            `item ${workItem.id}`,
            `status ${input.recoveryStatus}`,
            input.repairPreviewJobId ? `repair-preview ${input.repairPreviewJobId}` : null,
            input.repairApplyJobId ? `repair-apply ${input.repairApplyJobId}` : null,
            input.fullFlowJobId ? `full-flow ${input.fullFlowJobId}` : null,
            `baseline from manual-budget release ${release.releaseEventAt}`,
            "trial ran unattended with zero operator clicks and zero operator decisions",
            automationMeasurement
                ? `automation reports measured ${automationMeasurement.browserClicks} browser clicks and ${automationMeasurement.browserActions} browser actions across ${automationMeasurement.reportCount} reports`
                : "automation report measurement was unavailable for this trial"
        ].filter(Boolean).join("; "),
        automationMeasurement,
        recordedBy: "recovery-run"
    });
};
// Cross-domain mutable singletons (job stores, recoveryRuns, locks, in-flight,
// queue-run history, resolved-outcome guard) and getJobStore were hoisted to
// ./automation-runner-state. Each is a const container mutated in place, so
// call sites are unchanged. The `let` ledgers below stay here — they are
// reassigned only by their own domain's load/record helpers.
import {
    dryRunJobs,
    repairPreviewJobs,
    repairApplyJobs,
    fillDraftJobs,
    saveDraftJobs,
    submitListingJobs,
    fullFlowJobs,
    recoveryRuns,
    resolvedFullFlowWorkItemIds,
    runningTargetLocks,
    runningFullFlowProfileLocks,
    waitingFullFlowProfileLockResolvers,
    inFlightWorkItemIds,
    queueRunHistory,
    getJobStore,
    defaultQueueDaemonState,
    daemonStateHolder,
    profileLockAuditHolder
} from "./automation-runner-state";
let recoveryReleases = [];
let manualBudgetTrialHistory = [];
// P1-7: alert webhook config. Set via PUT /automation/alert-webhook. When
// `url` is non-empty, the queue daemon fires a POST with a small JSON
// payload (decision, reason, affected work item ids, tick id) on every
// `decision === "block"` audit entry so off-hours operators can see the
// problem without watching the dashboard.
// The alert-webhook domain (config state + fireAlertWebhook) was extracted to
// ./automation-runner-alert-webhook. The two config accessors are re-exported
// here to preserve this module's public API.
import { getAlertWebhookConfig, setAlertWebhookConfig, fireAlertWebhook } from "./automation-runner-alert-webhook";
export { getAlertWebhookConfig, setAlertWebhookConfig };

export const markWorkItemInFlight = (workItemId: string) => {
    if (!workItemId) {
        return
    }
    inFlightWorkItemIds.add(workItemId)
}

export const clearWorkItemInFlight = (workItemId: string) => {
    inFlightWorkItemIds.delete(workItemId)
}

export const listInFlightWorkItemIds = () => Array.from(inFlightWorkItemIds)
const waitForFullFlowProfileTurn = (profilePath: string) => new Promise<void>((resolve) => {
    const waiters = waitingFullFlowProfileLockResolvers.get(profilePath) ?? [];
    waiters.push(resolve);
    waitingFullFlowProfileLockResolvers.set(profilePath, waiters);
});
const acquireFullFlowProfileLock = async (profileInput, flowId) => {
    const profilePath = resolveProfilePath(profileInput);
    if (!profilePath) {
        return null;
    }
    while (true) {
        const holder = runningFullFlowProfileLocks.get(profilePath);
        if (!holder || holder === flowId) {
            runningFullFlowProfileLocks.set(profilePath, flowId);
            return profilePath;
        }
        await waitForFullFlowProfileTurn(profilePath);
    }
};
const releaseFullFlowProfileLock = (profilePath: string | null, flowId) => {
    if (!profilePath) {
        return;
    }
    if (runningFullFlowProfileLocks.get(profilePath) !== flowId) {
        return;
    }
    runningFullFlowProfileLocks.delete(profilePath);
    const waiters = waitingFullFlowProfileLockResolvers.get(profilePath);
    const next = waiters?.shift();
    if (waiters && waiters.length === 0) {
        waitingFullFlowProfileLockResolvers.delete(profilePath);
    }
    next?.();
};
const pushArg = (args, name, value) => {
    if (value === undefined || value === "") {
        return;
    }
    args.push(`--${name}=${value}`);
};
const getTsxCliPath = () => {
    const repoRoot = getRepoRoot();
    const tsxCliPath = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs");
    if (!existsSync(tsxCliPath)) {
        throw new Error(`tsx CLI not found: ${tsxCliPath}`);
    }
    return tsxCliPath;
};
export const buildAutomationModeArgs = (mode) => {
    if (mode === "dry-run") {
        return ["--dry-run=true"];
    }
    if (mode === "repair-preview") {
        return ["--dry-run=true"];
    }
    if (mode === "repair-apply") {
        return ["--dry-run=false", "--repair-mode=apply", "--review=true", "--save-draft=false", "--submit=false"];
    }
    if (mode === "fill-draft") {
        return ["--dry-run=false", "--review=true", "--save-draft=false", "--submit=false"];
    }
    if (mode === "save-draft") {
        return ["--dry-run=false", "--review=false", "--save-draft=true", "--submit=false"];
    }
    return ["--dry-run=false", "--review=false", "--save-draft=false", "--submit=true"];
};
export const buildAutomationTargetFingerprint = (input: AutomationDryRunStartInput = {}) => {
    const payload = JSON.stringify({
        url: input.url?.trim() ?? "",
        taskFile: input.taskFile?.trim() ?? "",
        repairPlanFile: input.repairPlanFile?.trim() ?? "",
        selectorConfig: input.selectorConfig?.trim() ?? "",
        mediaAutomationMode: input.mediaAutomationMode ?? "",
        mediaAutomationTools: input.mediaAutomationTools ?? []
    });
    return createHash("sha256").update(payload).digest("hex");
};
const resolveTaskFilePath = (taskFile) => {
    const trimmed = taskFile.trim();
    if (!trimmed) {
        return null;
    }
    return path.isAbsolute(trimmed) ? trimmed : path.join(getRepoRoot(), trimmed);
};
const readAutomationTaskFile = (taskFile) => {
    if (!taskFile?.trim()) {
        return {
            path: null,
            task: null,
            error: null
        };
    }
    const taskFilePath = resolveTaskFilePath(taskFile);
    if (!taskFilePath || !existsSync(taskFilePath)) {
        return {
            path: taskFilePath,
            task: null,
            error: `task file does not exist: ${taskFile}`
        };
    }
    try {
        return {
            path: taskFilePath,
            task: JSON.parse(readFileSync(taskFilePath, "utf8")),
            error: null
        };
    }
    catch (error) {
        return {
            path: taskFilePath,
            task: null,
            error: `task file is not readable JSON: ${error instanceof Error ? error.message : String(error)}`
        };
    }
};
const exportFallbackRepairPreviewFile = (workItem, taskFileRead) => {
    if (!workItem.repairPlan) {
        return null;
    }
    const repoRoot = getRepoRoot();
    const exportedAt = new Date().toISOString();
    const repairPlanFile = `.runtime/repair-plans/${workItem.id}.json`;
    const absoluteRepairPlanFile = path.join(repoRoot, repairPlanFile);
    mkdirSync(path.dirname(absoluteRepairPlanFile), {
        recursive: true
    });
    writeFileSync(absoluteRepairPlanFile, JSON.stringify({
        workItemId: workItem.id,
        pageUrl: workItem.pageUrl,
        pageTitle: workItem.pageTitle,
        exportedAt,
        repairPlan: workItem.repairPlan
    }, null, 2), "utf8");
    return {
        workItem,
        task: {
            id: taskFileRead.task?.id ?? workItem.id,
            product: {
                title: taskFileRead.task?.product?.title ?? workItem.title
            }
        },
        taskFile: taskFileRead.path ?? "",
        absoluteTaskFile: taskFileRead.path ?? "",
        repairPlanFile,
        absoluteRepairPlanFile,
        exportedAt
    };
};
const uniqueAutomationPageUrlSources = (sources) => {
    const seen = new Set();
    return sources.filter((source) => {
        const key = `${source.label}:${source.url.trim().toLowerCase()}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
};
type MediaAutomationInput = Pick<AutomationDryRunStartInput, "mediaAutomationMode" | "mediaAutomationTools">;
const normalizeMediaAutomationTools = (tools: MediaAutomationInput["mediaAutomationTools"]) => Array.isArray(tools)
    ? Array.from(new Set(tools.map((tool) => typeof tool === "string" ? tool.trim() : "").filter(Boolean)))
    : [];
const resolveMediaAutomationTools = (
    mode: MediaAutomationInput["mediaAutomationMode"],
    tools: MediaAutomationInput["mediaAutomationTools"]
) => {
    const normalizedTools = normalizeMediaAutomationTools(tools);
    if (normalizedTools.length > 0) {
        return normalizedTools;
    }
    return mode === "unattended-apply" ? [...DEFAULT_UNATTENDED_MEDIA_AUTOMATION_TOOLS] : undefined;
};
const applyAutomationMediaDefaults = <T extends MediaAutomationInput>(
    input: T,
    fallbackMode?: MediaAutomationInput["mediaAutomationMode"]
): T => {
    const mediaAutomationMode = input.mediaAutomationMode ?? fallbackMode;
    const mediaAutomationTools = resolveMediaAutomationTools(mediaAutomationMode, input.mediaAutomationTools);
    return {
        ...input,
        ...(mediaAutomationMode ? {
            mediaAutomationMode
        } : {}),
        ...(mediaAutomationTools ? {
            mediaAutomationTools
        } : {})
    } as T;
};
const readTaskFileDianxiaomiPageUrls = (taskFileRead) => {
    const parsed = taskFileRead.task;
    if (!parsed) {
        return [];
    }
    const sources = [];
    const productSourceUrl = parsed.product?.sourceUrl;
    if (parsed.product?.source === "dianxiaomi" && typeof productSourceUrl === "string" && productSourceUrl.trim()) {
        sources.push({
            label: "task product source URL",
            url: productSourceUrl
        });
    }
    const draftPageUrl = parsed.draft?.attributes?.dianxiaomiPageUrl;
    if (typeof draftPageUrl === "string" && draftPageUrl.trim()) {
        sources.push({
            label: "task Dianxiaomi page URL",
            url: draftPageUrl
        });
    }
    return uniqueAutomationPageUrlSources(sources);
};
const getAutomationPageUrlGate = (input: AutomationDryRunStartInput = {}) => {
    const explicitUrl = input.url?.trim();
    const taskFileRead = readAutomationTaskFile(input.taskFile);
    if (taskFileRead.error) {
        return {
            ready: false,
            reason: taskFileRead.error,
            effectiveUrl: explicitUrl,
            checkedSources: []
        };
    }
    const sources = [
        ...(explicitUrl ? [{
                label: "target URL",
                url: explicitUrl
            }] : []),
        ...readTaskFileDianxiaomiPageUrls(taskFileRead)
    ];
    const checkedSources = uniqueAutomationPageUrlSources(sources);
    for (const source of checkedSources) {
        const validation = validateDianxiaomiAutomationPageUrl(source.url);
        if (!validation.valid) {
            return {
                ready: false,
                reason: `${source.label} is not a real Dianxiaomi product edit URL: ${validation.reason}`,
                effectiveUrl: explicitUrl || checkedSources[0]?.url,
                checkedSources
            };
        }
    }
    return {
        ready: true,
        reason: checkedSources.length > 0 ? "Dianxiaomi target URL is valid" : "no Dianxiaomi target URL provided",
        effectiveUrl: explicitUrl || checkedSources[0]?.url,
        checkedSources
    };
};
const normalizeAutomationStartInput = (input: AutomationDryRunStartInput = {}) => {
    const normalizedInput = applyAutomationMediaDefaults(input);
    const pageUrlGate = getAutomationPageUrlGate(input);
    if (!pageUrlGate.ready) {
        throw new AutomationSafetyGateError(pageUrlGate.reason);
    }
    if (!normalizedInput.url?.trim() && pageUrlGate.effectiveUrl) {
        return {
            ...normalizedInput,
            url: pageUrlGate.effectiveUrl
        };
    }
    return normalizedInput;
};
// The store/queue scope-filter cluster was extracted to
// ./automation-runner-scope (pure leaf). matchesQueueDaemonTickStoreScope stays
// below because it reads the live daemonStateHolder.current singleton.
import {
    normalizeStoreScopeValue,
    getAutomationStoreScope,
    getAutomationItemScope,
    hasAutomationStoreScope,
    hasAutomationQueueScope,
    matchesAutomationStoreScope,
    matchesAutomationQueueScope,
    filterItemsByAutomationStoreScope,
    summarizeScopedWorkItems,
    scopedWorkItemIds,
    listScopedDianxiaomiProductWorkItems,
    matchesRequestedScopeValues,
    matchesQueueRunStoreScope,
    matchesRecoveryRunStoreScope
} from "./automation-runner-scope";
const matchesQueueDaemonTickStoreScope = (tick: AutomationQueueDaemonTick, input: AutomationDryRunStartInput = {}) => {
    if (!hasAutomationQueueScope(input)) {
        return true;
    }
    if (tick?.queueRun) {
        return matchesQueueRunStoreScope(tick.queueRun, input);
    }
    if (tick?.recoveryRun) {
        return matchesRecoveryRunStoreScope(tick.recoveryRun, input);
    }
    if (!matchesAutomationStoreScope(daemonStateHolder.current.input, input)) {
        return false;
    }
    const itemScope = getAutomationItemScope(input);
    return matchesRequestedScopeValues(normalizeAutomationItemUrls(daemonStateHolder.current.input.itemUrls), itemScope.itemUrls)
        && matchesRequestedScopeValues(normalizeAutomationSourceBuckets(daemonStateHolder.current.input.sourceBuckets), itemScope.sourceBuckets);
};
const filterRecoveryFailureSummariesForItems = (summaries: AutomationRecoveryFailureSummary[], items: DianxiaomiProductWorkItem[]) => {
    const itemIds = scopedWorkItemIds(items);
    return summaries.filter((summary) => {
        if (summary.workItemId) {
            return itemIds.has(summary.workItemId);
        }
        if (!summary.repairAction) {
            return false;
        }
        return items.some((item) => repairActionLabelsForActions(item.repairPlan?.actions ?? []).includes(summary.repairAction));
    });
};
const resolveScreenshotDir = (repoRoot, input) => {
    const screenshotDir = input.screenshots?.trim() || DEFAULT_SCREENSHOT_DIR;
    return path.isAbsolute(screenshotDir) ? screenshotDir : path.join(repoRoot, screenshotDir);
};
const buildJobArtifactDir = (id) => `${DEFAULT_ARTIFACT_ROOT}/${id}`;
const readLatestExecutionReport = (repoRoot, input) => {
    const reportDir = resolveScreenshotDir(repoRoot, input);
    if (!existsSync(reportDir)) {
        return null;
    }
    const reportPath = readdirSync(reportDir)
        .filter((fileName) => /^dianxiaomi-(run|dry-run|repair-preview|repair-apply|error)-.*\.json$/.test(fileName))
        .map((fileName) => path.join(reportDir, fileName))
        .flatMap((filePath) => {
        try {
            return [{
                    filePath,
                    report: JSON.parse(readFileSync(filePath, "utf8"))
                }];
        }
        catch {
            return [];
        }
    })
        .sort((left, right) => right.report.createdAt.localeCompare(left.report.createdAt))[0];
    return reportPath ?? null;
};
const startRepairApplyFollowUpImageCheck = (job, input) => {
    if (!job.workItemId) {
        return null;
    }
    const screenshots = path.join(job.artifactDir, "follow-up-image-check");
    return startDianxiaomiImageCheck({
        workItemId: job.workItemId,
        url: input.url,
        profile: input.profile,
        headed: false,
        screenshots
    });
};
const startAutomationJob = (mode, input: AutomationDryRunStartInput = {}) => {
    const normalizedInput = normalizeAutomationStartInput(input);
    const targetFingerprint = buildAutomationTargetFingerprint(normalizedInput);
    const repoRoot = getRepoRoot();
    const id = `automation-${mode}-${timestampId()}`;
    assertAutomationModeReady(mode, normalizedInput);
    runningTargetLocks.set(targetFingerprint, id);
    const artifactDir = normalizedInput.screenshots?.trim() || buildJobArtifactDir(id);
    const effectiveInput = {
        ...normalizedInput,
        screenshots: artifactDir
    };
    const logDir = path.join(repoRoot, ".runtime/logs");
    mkdirSync(logDir, {
        recursive: true
    });
    const logPath = path.join(logDir, `${id}.log`);
    const errorLogPath = path.join(logDir, `${id}.err.log`);
    const args = [
        path.join(repoRoot, "apps/automation/src/temu-publish.ts"),
        ...buildAutomationModeArgs(mode)
    ];
    // Unattended queue jobs must exit on completion. Headed mode is still
    // available when explicitly requested for login/debug calibration.
    pushArg(args, "headed", effectiveInput.headed ?? false);
    pushArg(args, "url", effectiveInput.url);
    pushArg(args, "task-file", effectiveInput.taskFile);
    pushArg(args, "repair-plan-file", effectiveInput.repairPlanFile);
    pushArg(args, "profile", effectiveInput.profile);
    pushArg(args, "screenshots", effectiveInput.screenshots);
    pushArg(args, "selector-config", effectiveInput.selectorConfig);
    pushArg(args, "media-automation-mode", effectiveInput.mediaAutomationMode);
    pushArg(args, "media-automation-tools", effectiveInput.mediaAutomationTools?.join(","));
    pushArg(args, "skip-draft-fill", effectiveInput.skipDraftFill ? "true" : undefined);
    pushArg(args, "submit-max-attempts", effectiveInput.submitMaxAttempts?.toString());
    const tsxCliPath = getTsxCliPath();
    const commandArgs = [tsxCliPath, ...args];
    const child = spawn(process.execPath, commandArgs, {
        cwd: repoRoot,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.pipe(createWriteStream(logPath, { flags: "a" }));
    child.stderr.pipe(createWriteStream(errorLogPath, { flags: "a" }));
    const result = {
        id,
        startedAt: new Date().toISOString(),
        command: `node ${commandArgs.join(" ")}`,
        cwd: repoRoot,
        logPath,
        errorLogPath,
        targetFingerprint,
        artifactDir
    };
    const store = getJobStore(mode);
    store.set(id, {
        ...result,
        status: "running",
        finishedAt: null,
        exitCode: null,
        error: null,
        reportPath: null,
        reportStatus: null
    });
    child.on("exit", (code) => {
        const current = store.get(id);
        if (!current) {
            return;
        }
        const executionReport = code === 0 ? readLatestExecutionReport(repoRoot, effectiveInput) : null;
        if (mode === "repair-apply" && code === 0 && current.workItemId && executionReport?.report.status === "completed") {
            const snapshotEnrichment = collectDianxiaomiSnapshotEnrichmentFromReports([executionReport.filePath]);
            if (snapshotEnrichment) {
                mergeDianxiaomiProductWorkItemSnapshot(current.workItemId, snapshotEnrichment, `repair apply updated from job ${id}`);
            }
        }
        store.set(id, {
            ...current,
            status: code === 0 ? "completed" : "failed",
            finishedAt: new Date().toISOString(),
            exitCode: code,
            error: null,
            reportPath: executionReport?.filePath ?? null,
            reportStatus: executionReport?.report.status ?? null
        });
        releaseTargetLock(targetFingerprint, id);
        if (mode === "repair-apply" && code === 0 && current.workItemId && executionReport?.report.status === "completed") {
            try {
                startRepairApplyFollowUpImageCheck({
                    ...current,
                    artifactDir: current.artifactDir
                }, effectiveInput);
            }
            catch (error) {
                console.warn(`repair-apply follow-up image check failed to start: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    });
    child.on("error", (error) => {
        const current = store.get(id);
        if (!current) {
            return;
        }
        store.set(id, {
            ...current,
            status: "failed",
            finishedAt: new Date().toISOString(),
            exitCode: null,
            error: error.message,
            reportPath: null,
            reportStatus: null
        });
        releaseTargetLock(targetFingerprint, id);
    });
    return result;
};
const listAutomationJobs = (mode, limit = 20) => Array.from(getJobStore(mode).values())
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit);
const getAutomationJob = (mode, id) => getJobStore(mode).get(id) ?? null;
const latestAutomationJob = (mode) => listAutomationJobs(mode, 1)[0] ?? null;
const waitForAutomationJob = async (mode, id, timeoutMs = getAutomationJobTimeoutMs(mode)) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const job = getAutomationJob(mode, id);
        if (!job) {
            throw new Error(`${mode} job not found: ${id}`);
        }
        if (job.status !== "running") {
            return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`${mode} job timed out: ${id}`);
};
const waitForFullFlowJob = async (id, timeoutMs = getFullFlowJobTimeoutMs()) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const job = fullFlowJobs.get(id);
        if (!job) {
            throw new Error(`full-flow job not found: ${id}`);
        }
        if (job.status !== "running") {
            return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`full-flow job timed out: ${id}`);
};
const getRunningTargetJobId = (targetFingerprint) => runningTargetLocks.get(targetFingerprint) ?? null;
const isSuccessfulJob = (job) => Boolean(job && job.status === "completed" && job.exitCode === 0 && job.reportStatus === "completed");
const latestSuccessfulAutomationJob = (mode, targetFingerprint) => listAutomationJobs(mode, Number.MAX_SAFE_INTEGER)
    .find((job) => isSuccessfulJob(job) && job.targetFingerprint === targetFingerprint) ?? null;
const selectorBlockReason = (blockers) => `selector config validation failed: ${blockers.map((issue) => issue.message).join("; ")}`;
const getSelectorReadinessGate = (input) => {
    const selectorValidation = validateSelectorConfig(input.selectorConfig);
    const selectorBlockers = selectorValidation.issues.filter((issue) => issue.level === "error");
    return {
        selectorValidation,
        selectorBlockers,
        selectorReady: selectorBlockers.length === 0
    };
};
const getTaskFileSnapshotGate = (input) => getTaskFileExportSnapshotStatus(input.taskFile);
export const getAutomationModeReadiness = (mode, input: AutomationDryRunStartInput = {}): AutomationModeReadiness => {
    const pageUrlGate = getAutomationPageUrlGate(input);
    const inputForReadiness = pageUrlGate.ready && !input.url?.trim() && pageUrlGate.effectiveUrl
        ? {
            ...input,
            url: pageUrlGate.effectiveUrl
        }
        : input;
    const targetFingerprint = buildAutomationTargetFingerprint(inputForReadiness);
    const runningJobId = getRunningTargetJobId(targetFingerprint);
    if (mode === "dry-run") {
        return {
            mode,
            ready: pageUrlGate.ready && !runningJobId,
            targetFingerprint,
            runningJobId,
            reason: !pageUrlGate.ready
                ? pageUrlGate.reason
                : runningJobId
                    ? `target already has a running automation job: ${runningJobId}`
                    : "dry-run can always start"
        };
    }
    if (mode === "repair-preview") {
        const selectorGate = getSelectorReadinessGate(inputForReadiness);
        const taskFileGate = getTaskFileSnapshotGate(inputForReadiness);
        return {
            mode,
            ready: pageUrlGate.ready && !runningJobId && selectorGate.selectorReady && taskFileGate.ready && Boolean(inputForReadiness.repairPlanFile?.trim()),
            targetFingerprint,
            runningJobId,
            selectorValidation: selectorGate.selectorValidation,
            selectorBlockers: selectorGate.selectorBlockers,
            reason: !pageUrlGate.ready
                ? pageUrlGate.reason
                : runningJobId
                    ? `target already has a running automation job: ${runningJobId}`
                    : !selectorGate.selectorReady
                        ? selectorBlockReason(selectorGate.selectorBlockers)
                        : !taskFileGate.ready
                            ? taskFileGate.reason
                            : !inputForReadiness.repairPlanFile?.trim()
                                ? "repair-preview requires a repair plan file"
                                : "repair-preview can inspect the repair plan without writing"
        };
    }
    if (mode === "repair-apply") {
        const selectorGate = getSelectorReadinessGate(inputForReadiness);
        const taskFileGate = getTaskFileSnapshotGate(inputForReadiness);
        return {
            mode,
            ready: pageUrlGate.ready && !runningJobId && selectorGate.selectorReady && taskFileGate.ready && Boolean(inputForReadiness.repairPlanFile?.trim()),
            targetFingerprint,
            runningJobId,
            selectorValidation: selectorGate.selectorValidation,
            selectorBlockers: selectorGate.selectorBlockers,
            reason: !pageUrlGate.ready
                ? pageUrlGate.reason
                : runningJobId
                    ? `target already has a running automation job: ${runningJobId}`
                    : !selectorGate.selectorReady
                        ? selectorBlockReason(selectorGate.selectorBlockers)
                        : !taskFileGate.ready
                            ? taskFileGate.reason
                            : !inputForReadiness.repairPlanFile?.trim()
                                ? "repair-apply requires a repair plan file"
                                : "repair-apply can apply safe repair actions without save or submit"
        };
    }
    if (mode === "fill-draft") {
        const selectorGate = getSelectorReadinessGate(inputForReadiness);
        const taskFileGate = getTaskFileSnapshotGate(inputForReadiness);
        const latestDryRunJob = latestSuccessfulAutomationJob("dry-run", targetFingerprint);
        const latestAnyDryRunJob = latestAutomationJob("dry-run");
        return {
            mode,
            ready: pageUrlGate.ready && !runningJobId && selectorGate.selectorReady && taskFileGate.ready && Boolean(latestDryRunJob),
            requiredMode: "dry-run",
            latestJobId: latestDryRunJob?.id ?? null,
            targetFingerprint,
            runningJobId,
            selectorValidation: selectorGate.selectorValidation,
            selectorBlockers: selectorGate.selectorBlockers,
            reason: !pageUrlGate.ready
                ? pageUrlGate.reason
                : runningJobId
                    ? `target already has a running automation job: ${runningJobId}`
                    : !selectorGate.selectorReady
                        ? selectorBlockReason(selectorGate.selectorBlockers)
                        : !taskFileGate.ready
                            ? taskFileGate.reason
                            : latestDryRunJob
                                ? "matching dry-run completed with a completed report"
                                : latestAnyDryRunJob
                                    ? "fill-draft requires a completed dry-run report for the same target fingerprint"
                                    : "fill-draft requires a completed dry-run report"
        };
    }
    if (mode === "save-draft") {
        const selectorGate = getSelectorReadinessGate(inputForReadiness);
        const taskFileGate = getTaskFileSnapshotGate(inputForReadiness);
        const latestFillDraftJob = latestSuccessfulAutomationJob("fill-draft", targetFingerprint);
        const latestAnyFillDraftJob = latestAutomationJob("fill-draft");
        return {
            mode,
            ready: pageUrlGate.ready && !runningJobId && selectorGate.selectorReady && taskFileGate.ready && Boolean(latestFillDraftJob),
            requiredMode: "fill-draft",
            latestJobId: latestFillDraftJob?.id ?? null,
            targetFingerprint,
            runningJobId,
            selectorValidation: selectorGate.selectorValidation,
            selectorBlockers: selectorGate.selectorBlockers,
            reason: !pageUrlGate.ready
                ? pageUrlGate.reason
                : runningJobId
                    ? `target already has a running automation job: ${runningJobId}`
                    : !selectorGate.selectorReady
                        ? selectorBlockReason(selectorGate.selectorBlockers)
                        : !taskFileGate.ready
                            ? taskFileGate.reason
                            : latestFillDraftJob
                                ? "matching fill-draft completed with a completed report"
                                : latestAnyFillDraftJob
                                    ? "save-draft requires a completed fill-draft report for the same target fingerprint"
                                    : "save-draft requires a completed fill-draft report"
        };
    }
    const selectorGate = getSelectorReadinessGate(inputForReadiness);
    const taskFileGate = getTaskFileSnapshotGate(inputForReadiness);
    const latestSaveDraftJob = latestSuccessfulAutomationJob("save-draft", targetFingerprint);
    const latestAnySaveDraftJob = latestAutomationJob("save-draft");
    return {
        mode,
        ready: pageUrlGate.ready && !runningJobId && selectorGate.selectorReady && taskFileGate.ready && Boolean(latestSaveDraftJob),
        requiredMode: "save-draft",
        latestJobId: latestSaveDraftJob?.id ?? null,
        targetFingerprint,
        runningJobId,
        selectorValidation: selectorGate.selectorValidation,
        selectorBlockers: selectorGate.selectorBlockers,
        reason: !pageUrlGate.ready
            ? pageUrlGate.reason
            : runningJobId
                ? `target already has a running automation job: ${runningJobId}`
                : !selectorGate.selectorReady
                    ? selectorBlockReason(selectorGate.selectorBlockers)
                    : !taskFileGate.ready
                        ? taskFileGate.reason
                        : latestSaveDraftJob
                            ? "matching save-draft completed with a completed report"
                            : latestAnySaveDraftJob
                                ? "submit-listing requires a completed save-draft report for the same target fingerprint"
                                : "submit-listing requires a completed save-draft report"
    };
};
const assertAutomationModeReady = (mode, input) => {
    const readiness = getAutomationModeReadiness(mode, input);
    if (!readiness.ready) {
        throw new AutomationSafetyGateError(readiness.reason);
    }
};
const releaseTargetLock = (targetFingerprint, id) => {
    if (runningTargetLocks.get(targetFingerprint) === id) {
        runningTargetLocks.delete(targetFingerprint);
    }
};
const readLogTail = (filePath, maxChars) => {
    if (!existsSync(filePath)) {
        return {
            text: "",
            truncated: false
        };
    }
    const size = statSync(filePath).size;
    const text = readFileSync(filePath, "utf8");
    return {
        text: text.length > maxChars ? text.slice(-maxChars) : text,
        truncated: text.length > maxChars || size > Buffer.byteLength(text, "utf8")
    };
};
export const readAutomationExecutionReport = (filePath) => {
    if (!filePath || !existsSync(filePath)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(filePath, "utf8"));
    }
    catch {
        return null;
    }
};
const resolveProfilePath = (profileInput) => {
    const profile = profileInput?.trim();
    if (!profile) {
        return null;
    }
    return path.isAbsolute(profile) ? profile : path.join(getRepoRoot(), profile);
};
const resolveQueueDaemonProfilePath = () => resolveProfilePath(daemonStateHolder.current.input.profile);
const profileLockFileNamePattern = /lock|singleton/i;
const profileLockArchiveDirectoryName = ".archived-profile-locks";
const profileLockCandidateFileNames = (profilePath) => readdirSync(profilePath)
    .filter((fileName) => fileName !== profileLockArchiveDirectoryName && profileLockFileNamePattern.test(fileName));
const inspectProfileLockFile = (profilePath, fileName) => {
    const absolutePath = path.join(profilePath, fileName);
    try {
        const stats = lstatSync(absolutePath);
        const ageMs = Date.now() - stats.mtimeMs;
        const mtime = new Date(stats.mtimeMs).toISOString();
        const target = stats.isSymbolicLink()
            ? (() => {
                try {
                    return readlinkSync(absolutePath);
                }
                catch {
                    return null;
                }
            })()
            : null;
        return {
            fileName,
            stale: ageMs >= getProfileLockStaleMs(),
            mtime,
            ageMinutes: Math.max(0, Math.floor(ageMs / 60_000)),
            detail: target ? `${fileName} -> ${target}` : fileName
        };
    }
    catch {
        return {
            fileName,
            stale: false,
            mtime: null,
            ageMinutes: null,
            detail: fileName
        };
    }
};
const profileLockArchiveTarget = (profilePath, fileName, mtime) => {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const suffix = (mtime ?? new Date().toISOString()).replace(/[^0-9a-zA-Z-]/g, "-");
    return path.join(profilePath, profileLockArchiveDirectoryName, `${safeName}.${suffix}`);
};
const buildProfileLockArchiveReadinessItem = (profilePath, inspection, ready, reason) => ({
    fileName: inspection.fileName,
    detail: inspection.detail,
    mtime: inspection.mtime,
    ageMinutes: inspection.ageMinutes,
    staleThresholdMinutes: getProfileLockStaleMs() / 60_000,
    archiveTarget: profileLockArchiveTarget(profilePath, inspection.fileName, inspection.mtime),
    ready,
    reason
});
const recordProfileLockAuditEntries = (records) => {
    let changed = false;
    for (const record of records) {
        if (profileLockAuditHolder.current.some((entry) => entry.id === record.id)) {
            continue;
        }
        profileLockAuditHolder.current.unshift(record);
        changed = true;
    }
    if (!changed) {
        return;
    }
    profileLockAuditHolder.current = profileLockAuditHolder.current
        .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
        .slice(0, PROFILE_LOCK_AUDIT_LIMIT);
    persistProfileLockAuditLedger();
};
export const getProfileLockArchiveReadiness = (input) => {
    const checkedAt = new Date().toISOString();
    const profilePath = input
        ? resolveProfilePath(normalizeQueueDaemonInput(input).input.profile)
        : resolveQueueDaemonProfilePath();
    if (!profilePath) {
        return {
            checkedAt,
            status: "blocked",
            profilePath: null,
            profileExists: false,
            archiveDirectory: null,
            activeLocks: [],
            staleLocks: [],
            readyItems: [],
            blockedItems: [],
            message: "browser profile path is not configured",
            nextAction: "Configure a persistent Dianxiaomi browser profile before reviewing stale lock archive readiness."
        };
    }
    const profileExists = existsSync(profilePath);
    if (!profileExists) {
        return {
            checkedAt,
            status: "blocked",
            profilePath,
            profileExists,
            archiveDirectory: path.join(profilePath, profileLockArchiveDirectoryName),
            activeLocks: [],
            staleLocks: [],
            readyItems: [],
            blockedItems: [],
            message: "browser profile directory does not exist",
            nextAction: "Create or initialize the configured Dianxiaomi browser profile before reviewing stale lock archive readiness."
        };
    }
    const inspections = profileLockCandidateFileNames(profilePath)
        .map((fileName) => inspectProfileLockFile(profilePath, fileName))
        .slice(0, 20);
    const activeInspections = inspections.filter((item) => !item.stale);
    const staleInspections = inspections.filter((item) => item.stale);
    const activeLocks = activeInspections.map((item) => item.detail);
    const staleLocks = staleInspections.map((item) => item.detail);
    const archiveDirectory = path.join(profilePath, profileLockArchiveDirectoryName);
    if (activeInspections.length > 0) {
        return {
            checkedAt,
            status: "blocked",
            profilePath,
            profileExists,
            archiveDirectory,
            activeLocks,
            staleLocks,
            readyItems: [],
            blockedItems: [
                ...activeInspections.map((item) => buildProfileLockArchiveReadinessItem(profilePath, item, false, "active or unreadable profile lock remains a hard startup gate")),
                ...staleInspections.map((item) => buildProfileLockArchiveReadinessItem(profilePath, item, false, "stale lock is not archive-ready while active or uncertain locks are present"))
            ],
            message: `profile has ${activeInspections.length} active or uncertain lock file(s)`,
            nextAction: "Close every browser using this profile first; archive review stays blocked while fresh or unreadable locks exist."
        };
    }
    if (staleInspections.length === 0) {
        return {
            checkedAt,
            status: "idle",
            profilePath,
            profileExists,
            archiveDirectory,
            activeLocks,
            staleLocks,
            readyItems: [],
            blockedItems: [],
            message: "no stale profile lock files are available for archive review",
            nextAction: "No archive action is needed."
        };
    }
    return {
        checkedAt,
        status: "ready",
        profilePath,
        profileExists,
        archiveDirectory,
        activeLocks,
        staleLocks,
        readyItems: staleInspections.map((item) => buildProfileLockArchiveReadinessItem(profilePath, item, true, "stale lock is eligible for an Advanced-only archive action after operator confirmation")),
        blockedItems: [],
        message: `${staleInspections.length} stale profile lock file(s) are archive-ready`,
        nextAction: "Use Advanced-only archive flow after confirming no Dianxiaomi browser session is using this profile."
    };
};
export const archiveStaleProfileLocks = (input) => {
    const checkedAt = new Date().toISOString();
    const readiness = getProfileLockArchiveReadiness(input);
    if (readiness.status !== "ready" || !readiness.profilePath || !readiness.archiveDirectory) {
        return {
            checkedAt,
            status: readiness.status === "idle" ? "idle" : "blocked",
            profilePath: readiness.profilePath,
            archiveDirectory: readiness.archiveDirectory,
            archivedItems: [],
            blockedItems: readiness.blockedItems,
            readiness,
            message: readiness.message,
            nextAction: readiness.nextAction
        };
    }
    const archiveCandidates = [];
    const blockedItems = [];
    for (const item of readiness.readyItems) {
        const currentInspection = inspectProfileLockFile(readiness.profilePath, item.fileName);
        if (!currentInspection.stale || currentInspection.mtime !== item.mtime) {
            blockedItems.push(buildProfileLockArchiveReadinessItem(readiness.profilePath, currentInspection, false, "profile lock changed during archive confirmation; rerun readiness before archiving"));
            continue;
        }
        archiveCandidates.push(item);
    }
    if (blockedItems.length > 0) {
        return {
            checkedAt,
            status: "blocked",
            profilePath: readiness.profilePath,
            archiveDirectory: readiness.archiveDirectory,
            archivedItems: [],
            blockedItems,
            readiness,
            message: `profile lock archive blocked because ${blockedItems.length} lock file(s) changed during confirmation`,
            nextAction: "Run archive readiness again after confirming no browser session is using this profile."
        };
    }
    mkdirSync(readiness.archiveDirectory, { recursive: true });
    const archivedAt = new Date().toISOString();
    const archivedItems = [];
    const auditEntries = [];
    for (const item of archiveCandidates) {
        const sourcePath = path.join(readiness.profilePath, item.fileName);
        let archiveTarget = item.archiveTarget;
        let targetSuffix = 1;
        while (existsSync(archiveTarget)) {
            archiveTarget = `${item.archiveTarget}.${targetSuffix}`;
            targetSuffix += 1;
        }
        try {
            renameSync(sourcePath, archiveTarget);
        }
        catch {
            blockedItems.push({
                ...item,
                ready: false,
                archiveTarget,
                reason: "profile lock could not be moved during guarded archive"
            });
            continue;
        }
        archivedItems.push({
            ...item,
            archiveTarget,
            sourcePath,
            archivedAt
        });
        const auditEntry = normalizeProfileLockAuditEntry({
            id: profileLockAuditId("archived-stale-lock", readiness.profilePath, item.fileName, item.mtime),
            recordedAt: archivedAt,
            action: "archived-stale-lock",
            profilePath: readiness.profilePath,
            fileName: item.fileName,
            detail: `${item.detail} -> ${archiveTarget}`,
            mtime: item.mtime,
            ageMinutes: item.ageMinutes,
            staleThresholdMinutes: item.staleThresholdMinutes,
            nextAction: "Archived stale browser profile lock; rerun unattended startup checks before restarting the queue daemon."
        });
        if (auditEntry) {
            auditEntries.push(auditEntry);
        }
    }
    recordProfileLockAuditEntries(auditEntries);
    return {
        checkedAt,
        status: blockedItems.length > 0 ? "blocked" : archivedItems.length > 0 ? "archived" : "idle",
        profilePath: readiness.profilePath,
        archiveDirectory: readiness.archiveDirectory,
        archivedItems,
        blockedItems,
        readiness,
        message: blockedItems.length > 0
            ? `archived ${archivedItems.length} stale profile lock file(s), blocked ${blockedItems.length}`
            : archivedItems.length > 0
                ? `archived ${archivedItems.length} stale profile lock file(s)`
                : "no stale profile lock files were archived",
        nextAction: blockedItems.length > 0
            ? "Review blocked archive items and rerun readiness before retrying."
            : "Rerun unattended startup checks; archived locks no longer block this browser profile."
    };
};
const recordStaleProfileLockAudit = (profilePath, inspections) => {
    const staleInspections = inspections.filter((item) => item.stale);
    if (staleInspections.length === 0) {
        return;
    }
    const recordedAt = new Date().toISOString();
    const records = staleInspections
        .map((item) => normalizeProfileLockAuditEntry({
        id: profileLockAuditId("ignored-stale-lock", profilePath, item.fileName, item.mtime),
        recordedAt,
        action: "ignored-stale-lock",
        profilePath,
        fileName: item.fileName,
        detail: item.detail,
        mtime: item.mtime,
        ageMinutes: item.ageMinutes,
        staleThresholdMinutes: getProfileLockStaleMs() / 60_000,
        nextAction: "Ignored by startup gate because the lock is stale; archive only after confirming no Dianxiaomi browser session is using this profile."
    }))
        .filter((entry) => Boolean(entry));
    recordProfileLockAuditEntries(records);
};
const inspectQueueDaemonProfile = (profileInput?: string | null) => {
    const profilePath = resolveProfilePath(profileInput) ?? resolveQueueDaemonProfilePath();
    if (!profilePath) {
        return {
            path: null,
            exists: false,
            lockFiles: [],
            staleLockFiles: [],
            lockAudit: profileLockAuditSummary(null)
        };
    }
    const lockFileInspections = existsSync(profilePath)
        ? profileLockCandidateFileNames(profilePath)
            .map((fileName) => inspectProfileLockFile(profilePath, fileName))
            .slice(0, 20)
        : [];
    const lockFiles = lockFileInspections
        .filter((item) => !item.stale)
        .map((item) => item.detail);
    const staleLockFiles = lockFileInspections
        .filter((item) => item.stale)
        .map((item) => item.detail);
    recordStaleProfileLockAudit(profilePath, lockFileInspections);
    return {
        path: profilePath,
        exists: existsSync(profilePath),
        lockFiles,
        staleLockFiles,
        lockAudit: profileLockAuditSummary(profilePath)
    };
};
const queueDaemonIssueStatus = (issues) => issues.some((issue) => issue.level === "block")
    ? "blocked"
    : issues.some((issue) => issue.level === "warning")
        ? "warning"
        : "healthy";
const queueDaemonSuccessfulCategories = new Set([
    "idle-no-items",
    "ready-queued",
    "awaiting-flow-completion",
    "flow-outcome-recovered",
    "recovery-run-started",
    "validation-rerun-started"
]);
const listQueueDaemonUnresolvedFlowJobs = (input: AutomationDryRunStartInput = {}) => {
    const scopedWorkItemIds = hasAutomationQueueScope(input)
        ? new Set(listScopedDianxiaomiProductWorkItems(input).map((item) => item.id))
        : null;
    return daemonStateHolder.current.trackedFlowJobIds
        .filter((id) => !daemonStateHolder.current.resolvedFlowJobIds.includes(id))
        .map((id) => fullFlowJobs.get(id) ?? null)
        .filter((job) => Boolean(job))
        .filter((job) => job.status === "running")
        .filter((job) => !scopedWorkItemIds || Boolean(job.workItemId && scopedWorkItemIds.has(job.workItemId)));
};
const queueDaemonWorkItemIdsForTick = (tick) => Array.from(new Set([
    ...(tick.recoveryRun?.items.map((item) => item.workItemId) ?? []),
    ...(tick.manualBudgetValidationRun?.proposal?.sampleWorkItemIds ?? []),
    ...(tick.manualBudgetValidationRun?.skippedItems.map((item) => item.workItemId) ?? []),
    ...(tick.manualBudgetValidationRun?.outcome.flowOutcomes.map((outcome) => outcome.workItemId).filter((id) => Boolean(id)) ?? []),
    ...(tick.queueRun?.skippedItems.map((item) => item.workItemId) ?? []),
    ...(tick.queueRun?.flowJobIds.map((id) => fullFlowJobs.get(id)?.workItemId ?? null).filter((id) => Boolean(id)) ?? []),
    ...tick.flowOutcomes.map((outcome) => outcome.workItemId)
])).slice(0, 20);
const queueDaemonAuditEntryForTick = (tick) => {
    const reason = tick.reason ?? tick.error ?? "done";
    const workItemIds = queueDaemonWorkItemIdsForTick(tick);
    const countsAsFailure = tick.status === "failed" || !queueDaemonSuccessfulCategories.has(tick.category);
    if (tick.status === "failed") {
        return {
            tickId: tick.id,
            startedAt: tick.startedAt,
            finishedAt: tick.finishedAt,
            status: tick.status,
            category: tick.category,
            decision: "failed",
            subject: tick.category,
            reason,
            nextAction: "Inspect the latest daemon error and fix the blocker before continuing unattended runs.",
            workItemIds,
            queueRunId: null,
            recoveryRunId: null,
            countsAsFailure
        };
    }
    if (tick.category === "recovery-run-started" && tick.recoveryRun) {
        const policy = tick.recoveryRun.input.recoveryPolicy ?? "normal";
        return {
            tickId: tick.id,
            startedAt: tick.startedAt,
            finishedAt: tick.finishedAt,
            status: tick.status,
            category: tick.category,
            decision: "recovery-started",
            subject: `${policy} recovery ${tick.recoveryRun.id}`,
            reason,
            nextAction: policy === "released-retry"
                ? "Wait for the released retry outcome; a repeated failure will pause the product/action until a newer release event."
                : "Wait for repair-preview, repair-apply, and full-flow outcomes before returning the item to normal operation.",
            workItemIds,
            queueRunId: null,
            recoveryRunId: tick.recoveryRun.id,
            countsAsFailure
        };
    }
    if (tick.category === "validation-rerun-started" && tick.manualBudgetValidationRun) {
        return {
            tickId: tick.id,
            startedAt: tick.startedAt,
            finishedAt: tick.finishedAt,
            status: tick.status,
            category: tick.category,
            decision: "validation-rerun-started",
            subject: `validation rerun ${tick.manualBudgetValidationRun.id}`,
            reason,
            nextAction: tick.manualBudgetValidationRun.outcome.status === "running"
                ? "Wait for the guarded validation rerun to finish before promoting the replacement."
                : "Inspect the validation rerun result; the one automatic rerun budget is now spent for this failed validation.",
            workItemIds,
            queueRunId: null,
            recoveryRunId: null,
            countsAsFailure
        };
    }
    if (tick.category === "ready-queued" && tick.queueRun) {
        return {
            tickId: tick.id,
            startedAt: tick.startedAt,
            finishedAt: tick.finishedAt,
            status: tick.status,
            category: tick.category,
            decision: "queue-started",
            subject: `queue run ${tick.queueRun.id}`,
            reason,
            nextAction: "Wait for full-flow outcomes; failed flows will be recovered into blocked work item diagnoses.",
            workItemIds,
            queueRunId: tick.queueRun.id,
            recoveryRunId: null,
            countsAsFailure
        };
    }
    if (tick.category === "awaiting-flow-completion") {
        return {
            tickId: tick.id,
            startedAt: tick.startedAt,
            finishedAt: tick.finishedAt,
            status: tick.status,
            category: tick.category,
            decision: "awaiting-flow-completion",
            subject: "previous full-flow still running",
            reason,
            nextAction: "Wait for the running full-flow to finish before queueing the next product.",
            workItemIds,
            queueRunId: null,
            recoveryRunId: null,
            countsAsFailure
        };
    }
    if (tick.category === "flow-outcome-recovered") {
        const failed = tick.flowOutcomes.filter((outcome) => outcome.status === "failed").length;
        return {
            tickId: tick.id,
            startedAt: tick.startedAt,
            finishedAt: tick.finishedAt,
            status: tick.status,
            category: tick.category,
            decision: "outcomes-recovered",
            subject: `${tick.flowOutcomes.length} full-flow outcome(s)`,
            reason,
            nextAction: failed > 0
                ? "Review recovered failed outcomes before expanding unattended volume."
                : "Keep the daemon running; completed outcomes were resolved.",
            workItemIds,
            queueRunId: tick.queueRun?.id ?? null,
            recoveryRunId: null,
            countsAsFailure
        };
    }
    if (tick.category === "idle-no-items") {
        return {
            tickId: tick.id,
            startedAt: tick.startedAt,
            finishedAt: tick.finishedAt,
            status: tick.status,
            category: tick.category,
            decision: "idle",
            subject: "no runnable work",
            reason,
            nextAction: "Add ready Dianxiaomi work items or wait for collected products to become ready.",
            workItemIds,
            queueRunId: tick.queueRun?.id ?? null,
            recoveryRunId: null,
            countsAsFailure
        };
    }
    if (tick.category === "daemon-paused" || tick.category === "tick-already-running") {
        return {
            tickId: tick.id,
            startedAt: tick.startedAt,
            finishedAt: tick.finishedAt,
            status: tick.status,
            category: tick.category,
            decision: "skipped",
            subject: tick.category === "daemon-paused" ? "daemon paused" : "previous tick running",
            reason,
            nextAction: tick.category === "daemon-paused"
                ? "Run startup checks, then start the queue daemon when blockers are clear."
                : "Wait for the running tick to finish before starting another one.",
            workItemIds,
            queueRunId: null,
            recoveryRunId: null,
            countsAsFailure
        };
    }
    return {
        tickId: tick.id,
        startedAt: tick.startedAt,
        finishedAt: tick.finishedAt,
        status: tick.status,
        category: tick.category,
        decision: "startup-blocked",
        subject: tick.category,
        reason,
        nextAction: "Fix the listed blocker, then rerun startup checks or tick the daemon.",
        workItemIds,
        queueRunId: tick.queueRun?.id ?? null,
        recoveryRunId: tick.recoveryRun?.id ?? null,
        countsAsFailure
    };
};
const collectQueueDaemonAuditEntries = (limit = 10) => daemonStateHolder.current.ticks
    .slice(0, limit)
    .map(queueDaemonAuditEntryForTick);
const queueDaemonRecommendation = (input) => {
    const issueIds = new Set(input.issues.map((issue) => issue.id));
    const latestAudit = input.auditEntries[0];
    const runnableWorkItems = input.readyWorkItems
        + input.autoRetryCandidates
        + input.browserRecoveryCandidates
        + input.releasedBrowserRecoveryCandidates;
    if ((input.unresolvedRunningFlows ?? 0) > 0) {
        return {
            kind: "wait-for-running-flow",
            level: "info",
            title: "Wait for the current product to finish",
            detail: `${input.unresolvedRunningFlows} unattended full-flow job(s) are still running.`,
            action: "Let the current Dianxiaomi flow finish; the daemon will queue the next product automatically.",
            source: "queue",
            workItemIds: []
        };
    }
    if (issueIds.has("real-dianxiaomi-calibration")) {
        return {
            kind: "run-calibration",
            level: "block",
            title: "Run real Dianxiaomi calibration",
            detail: input.issues.find((issue) => issue.id === "real-dianxiaomi-calibration")?.message ?? "Real Dianxiaomi listing edit calibration is required.",
            action: "Open a real Dianxiaomi product edit page, run production calibration, then restart or tick the daemon.",
            source: "health",
            workItemIds: []
        };
    }
    if (issueIds.has("login-or-captcha-session")) {
        return {
            kind: "resolve-login-or-captcha",
            level: "block",
            title: "Resolve Dianxiaomi login or CAPTCHA",
            detail: input.issues.find((issue) => issue.id === "login-or-captcha-session")?.message ?? "Latest Dianxiaomi session health is blocked by login or CAPTCHA.",
            action: "Open the automation browser profile, finish login or CAPTCHA, then capture a fresh real Dianxiaomi diagnosis before restarting unattended mode.",
            source: "health",
            workItemIds: []
        };
    }
    if (latestAudit?.category === "login-or-captcha") {
        return {
            kind: "resolve-login-or-captcha",
            level: "block",
            title: "Resolve Dianxiaomi login or CAPTCHA",
            detail: latestAudit.reason,
            action: "Open the automation browser profile, finish login or CAPTCHA, then restart unattended mode.",
            source: "audit",
            workItemIds: latestAudit.workItemIds
        };
    }
    // Recommendation priority: blocking issues first (so a hard stop wins
    // over "wait for products"), then state-based next-step, then warning
    // issues. The `alerts` / `issues` arrays already surface warnings, so
    // the recommendation field can focus on the primary next action.
    if (runnableWorkItems === 0) {
        return {
            kind: "wait-for-products",
            level: "info",
            title: "Wait for ready products",
            detail: "No ready, safe retry, browser recovery, or released retry items are currently runnable.",
            action: "Collect products in Dianxiaomi or wait for existing products to pass listing requirements.",
            source: "queue",
            workItemIds: []
        };
    }
    if (input.profileLockFiles.length > 0 || issueIds.has("profile-missing-config") || issueIds.has("profile-not-created")) {
        return {
            kind: "fix-browser-profile",
            level: "block",
            title: "Fix browser profile",
            detail: input.profileLockFiles.length > 0
                ? `Possible profile locks: ${input.profileLockFiles.join(", ")}`
                : issueIds.has("profile-not-created")
                    ? "Browser profile directory has not been initialized yet."
                    : "Browser profile path is not configured.",
            action: input.profileLockFiles.length > 0
                ? "Close other browser windows using this profile, then restart the queue daemon."
                : issueIds.has("profile-not-created")
                    ? "Initialize the configured Dianxiaomi browser profile in headed mode, confirm it stays logged in, then restart unattended mode."
                    : "Set a persistent logged-in Dianxiaomi browser profile before long unattended runs.",
            source: "health",
            workItemIds: []
        };
    }
    if (input.daemonStatus === "ACTIVE" && runnableWorkItems > 0) {
        return {
            kind: "continue-running",
            level: "info",
            title: "Keep unattended mode running",
            detail: `${runnableWorkItems} runnable item(s): ${input.readyWorkItems} ready, ${input.autoRetryCandidates} safe retry, ${input.browserRecoveryCandidates} browser recovery, ${input.releasedBrowserRecoveryCandidates} released retry.`,
            action: "No operator action needed unless alerts change.",
            source: "queue",
            workItemIds: []
        };
    }
    if (input.daemonStatus === "PAUSED" && runnableWorkItems > 0) {
        return {
            kind: "start-daemon",
            level: input.status === "blocked" ? "block" : "warning",
            title: "Start unattended daemon",
            detail: `${runnableWorkItems} runnable item(s) are waiting while the daemon is paused.`,
            action: input.status === "blocked"
                ? "Clear blocking health checks first, then start the queue daemon."
                : "Run startup checks, then start the queue daemon.",
            source: "queue",
            workItemIds: []
        };
    }
    if (input.recoveryFailureSummaries.length > 0 || input.pausedBrowserRecoveryCandidates > 0) {
        const first = input.recoveryFailureSummaries[0];
        return {
            kind: "regenerate-repair-plan",
            level: "warning",
            title: "Refresh blocked recovery path",
            detail: first
                ? `${first.kind}: ${first.workItemId ?? first.repairAction ?? first.key}; latest reason: ${first.latestReason ?? "unknown"}`
                : `${input.pausedBrowserRecoveryCandidates} browser recovery candidate(s) are paused.`,
            action: "Update the product, regenerate the repair plan, or rerun real selector/media calibration before unattended recovery retries.",
            source: "recovery",
            workItemIds: first?.workItemId ? [first.workItemId] : []
        };
    }
    if (input.recentFailures > 0 || latestAudit?.decision === "failed") {
        return {
            kind: "review-failed-outcomes",
            level: "warning",
            title: "Review failed automation outcomes",
            detail: latestAudit?.reason ?? `${input.recentFailures} recent full-flow outcome(s) failed.`,
            action: "Inspect recovered failed outcomes or the latest daemon error before expanding unattended volume.",
            source: latestAudit?.decision === "failed" ? "audit" : "health",
            workItemIds: latestAudit?.workItemIds ?? []
        };
    }
    return {
        kind: "inspect-blocker",
        level: input.status === "blocked" ? "block" : "warning",
        title: "Inspect queue blocker",
        detail: latestAudit?.reason ?? input.issues[0]?.message ?? "Queue health needs attention.",
        action: latestAudit?.nextAction ?? input.issues[0]?.message ?? "Open advanced queue health and inspect the latest blocker.",
        source: latestAudit ? "audit" : "health",
        workItemIds: latestAudit?.workItemIds ?? []
    };
};
const queueDaemonHealthAlerts = (issues, input) => {
    const issueIds = new Set(issues.map((issue) => issue.id));
    const alerts = [];
    const runnableWorkItems = input.readyWorkItems
        + input.autoRetryCandidates
        + input.browserRecoveryCandidates
        + input.releasedBrowserRecoveryCandidates;
    if (issueIds.has("consecutive-failures")) {
        alerts.push({
            id: "clear-consecutive-failures",
            level: input.daemonStatus === "PAUSED" ? "block" : "warning",
            message: `Queue has consecutive failures${input.lastFailedCategory ? ` after ${input.lastFailedCategory}` : ""}.`,
            action: "Open the latest failed full-flow report, fix the listed blocker, then restart or tick the queue daemon."
        });
    }
    if (issueIds.has("real-dianxiaomi-calibration")) {
        alerts.push({
            id: "run-real-dianxiaomi-calibration",
            level: "block",
            message: "Unattended queue needs a real Dianxiaomi listing edit page calibration.",
            action: "Open a real Dianxiaomi product edit/listing page, run selector calibration, confirm real-dianxiaomi-calibration passes, then restart the queue daemon."
        });
    }
    if (issueIds.has("login-or-captcha-session")) {
        alerts.push({
            id: "resolve-login-or-captcha",
            level: "block",
            message: issues.find((issue) => issue.id === "login-or-captcha-session")?.message ?? "Latest Dianxiaomi session health is blocked by login or CAPTCHA.",
            action: "Open the automation browser profile, finish login or CAPTCHA, then capture a fresh real Dianxiaomi diagnosis before restarting unattended mode."
        });
    }
    if (input.profileLockFiles.length > 0) {
        alerts.push({
            id: "clear-browser-profile-lock",
            level: "block",
            message: `Browser profile has ${input.profileLockFiles.length} possible lock file(s).`,
            action: "Close other Chrome/Playwright windows using this profile, then start the queue daemon again."
        });
    }
    if (issueIds.has("profile-missing-config")) {
        alerts.push({
            id: "configure-browser-profile",
            level: "block",
            message: "Browser profile path is not configured.",
            action: "Set a persistent logged-in Dianxiaomi browser profile before long unattended runs."
        });
    }
    if (issueIds.has("profile-not-created")) {
        alerts.push({
            id: "initialize-browser-profile",
            level: "block",
            message: "Browser profile directory has not been initialized yet.",
            action: "Initialize the configured Dianxiaomi browser profile in headed mode, confirm it stays logged in, then start the queue daemon again."
        });
    }
    if (input.autoRetryCandidates > 0) {
        alerts.push({
            id: "auto-retry-candidate-work-items",
            level: "info",
            message: `${input.autoRetryCandidates} blocked Dianxiaomi work item(s) can be safely recovered.`,
            action: "Keep the daemon running; it will release safe non-browser recovery candidates automatically before the next queue run."
        });
    }
    if (input.browserRecoveryCandidates > 0) {
        alerts.push({
            id: "browser-recovery-candidate-work-items",
            level: "info",
            message: `${input.browserRecoveryCandidates} blocked Dianxiaomi work item(s) can be repaired by browser recovery.`,
            action: "Keep the daemon running; it will start a recovery batch before the normal ready queue."
        });
    }
    if (input.pausedBrowserRecoveryCandidates > 0) {
        alerts.push({
            id: "paused-browser-recovery-candidates",
            level: "warning",
            message: `${input.pausedBrowserRecoveryCandidates} browser recovery candidate(s) are paused by the repeated-failure budget.`,
            action: "Fix the product, regenerate its repair plan, or rerun real selector/media calibration before unattended recovery is allowed again."
        });
    }
    if (input.recoveryFailureSummaries.length > 0) {
        const first = input.recoveryFailureSummaries[0];
        const subject = first.kind === "work-item"
            ? `${first.workItemId}${first.title ? ` (${first.title})` : ""}`
            : first.repairAction ?? first.key;
        alerts.push({
            id: "repeated-recovery-failures",
            level: "warning",
            message: `Automatic recovery repeatedly failed for ${subject}.`,
            action: "Open Advanced > recovery runs, inspect the latest failed reason, then fix the product or selector/media action before retrying."
        });
    }
    if (input.manualBudget.total > 0) {
        const first = input.manualBudget.publishOutcomes[0];
        alerts.push({
            id: "manual-step-budget",
            level: "warning",
            message: `${input.manualBudget.total} Dianxiaomi item(s) are excluded from unattended publish/recovery by the manual-step budget${first ? `; first item ${first.title}` : ""}.`,
            action: first
                ? `${first.operatorAction} Release condition: ${first.releaseCondition}`
                : "Review the manual-step budget entries, define the automation replacement, then release corrected items back to ready-for-automation."
        });
    }
    if (issueIds.has("manual-budget-promotion-gate")) {
        alerts.push({
            id: "manual-budget-promotion-gate",
            level: "warning",
            message: "A measured manual-step replacement is held outside default automation until validation evidence is clean.",
            action: "Run the small validation path from Advanced; default unattended publishing will keep using only already proven automation."
        });
    }
    if (input.manualBudget.validationClosure.failureTriage.status !== "none") {
        const triage = input.manualBudget.validationClosure.failureTriage;
        alerts.push({
            id: "manual-budget-validation-triage",
            level: triage.status === "blocked" || triage.status === "manual-budget" ? "warning" : "info",
            message: `Manual-step validation ${triage.status}: ${triage.category ?? "unknown"} routed to ${triage.route}.`,
            action: triage.nextAction
        });
    }
    if (input.blockedWorkItems > 0) {
        alerts.push({
            id: "review-blocked-work-items",
            level: "warning",
            message: `${input.blockedWorkItems} Dianxiaomi work item(s) are blocked.`,
            action: "Review blocked work items, apply the suggested edits or failure note, then move corrected items back to ready-for-automation."
        });
    }
    if (input.recentFailures > 0) {
        alerts.push({
            id: "review-failed-flow-outcomes",
            level: "warning",
            message: `${input.recentFailures} recent full-flow outcome(s) failed.`,
            action: "Inspect recent recovered flow outcomes before allowing more unattended publish attempts."
        });
    }
    if (issueIds.has("daemon-paused") && runnableWorkItems > 0) {
        alerts.push({
            id: "resume-paused-daemon",
            level: "warning",
            message: `Queue daemon is paused while ${runnableWorkItems} item(s) are runnable.`,
            action: "Run the unattended startup check; if only warnings remain, start the queue daemon."
        });
    }
    if (alerts.length === 0) {
        alerts.push({
            id: "queue-health-ok",
            level: "info",
            message: "No queue health alert needs action.",
            action: "Keep the daemon running or add more ready Dianxiaomi work items."
        });
    }
    return alerts.slice(0, 6);
};
const buildPublishOutcomeManualBudgetItem = (item) => {
    const outcome = item.publishOutcome;
    if (item.status !== "blocked" || outcome?.status !== "failed" || outcome.route !== "manual-budget") {
        return null;
    }
    const reason = outcome.failureReason
        ?? item.failureDiagnosis?.message
        ?? outcome.message
        ?? "Dianxiaomi publish failed and no automatic route is currently allowed.";
    const operatorAction = item.failureDiagnosis?.nextAction
        ?? "Inspect the latest submit-listing report, fix the Dianxiaomi listing issue, then retry only after the item passes checks.";
    const releaseCondition = "Fix the issue, regenerate or update the work item so it is no longer manual-budget, then move it back to ready-for-automation through retry-after-fix or a new auto-ready repair plan.";
    return {
        workItemId: item.id,
        title: item.title || item.pageTitle || item.id,
        source: "publish-outcome",
        reason: `publish outcome manual-budget: ${reason}`,
        operatorAction,
        releaseCondition,
        updatedAt: outcome.checkedAt ?? item.updatedAt
    };
};
const normalizeManualBudgetReplacementKey = (source, reason) => `${source}:${reason.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ").trim().replace(/\s+/g, "-").slice(0, 96) || "unknown"}`;
const buildManualBudgetReplacementPlan = (reason, operatorAction) => {
    const normalized = `${reason} ${operatorAction}`.toLowerCase();
    if (normalized.includes("login") || normalized.includes("captcha") || normalized.includes("登录") || normalized.includes("验证码")) {
        return "Keep this outside default automation; add a session health monitor and only resume unattended runs after the logged-in profile is healthy.";
    }
    if (normalized.includes("selector") || normalized.includes("calibration") || normalized.includes("选择器") || normalized.includes("校准")) {
        return "Build a browser calibration recovery that captures the changed Dianxiaomi selector, verifies it on a real page, then reruns a small unattended trial.";
    }
    if (normalized.includes("attribute") || normalized.includes("required") || normalized.includes("validation") || normalized.includes("属性") || normalized.includes("必填")) {
        return "Use AI only as a field-decision helper: infer the missing required attribute from the collected Dianxiaomi product text, apply it through browser automation, then prove fewer operator decisions.";
    }
    if (normalized.includes("image") || normalized.includes("media") || normalized.includes("resize") || normalized.includes("translation") || normalized.includes("图片") || normalized.includes("翻译") || normalized.includes("尺寸")) {
        return "Route the recurring image issue through Dianxiaomi media tools first; add AI only if it removes manual image judgment before the default flow.";
    }
    if (normalized.includes("page url") || normalized.includes("wrong") || normalized.includes("surface") || normalized.includes("页面") || normalized.includes("链接")) {
        return "Add a browser surface detector that rejects non-edit pages before queueing and automatically refreshes the work item URL when Dianxiaomi exposes the real edit page.";
    }
    return "Keep this in the replacement backlog until the repeated reason can be mapped to a deterministic browser action or an AI decision with measurable click/decision reduction.";
};
const buildManualBudgetProofGate = (activeCount, releasedCount, proofRecord = null) => {
    const totalOccurrences = activeCount + releasedCount;
    const requiredProof = "Before entering the default unattended flow, prove this replacement reduces operator clicks or product-level decisions and passes a small real Dianxiaomi trial.";
    if (proofRecord?.status === "ready-for-default") {
        return {
            status: "ready-for-default",
            confidence: proofRecord.confidence,
            requiredProof,
            evidence: `${proofRecord.evidence} Click reduction/product ${proofRecord.clickReductionPerProduct.toFixed(2)}, decision reduction/product ${proofRecord.decisionReductionPerProduct.toFixed(2)}.`,
            proofRecordId: proofRecord.id
        };
    }
    if (proofRecord) {
        return {
            status: "needs-proof",
            confidence: proofRecord.confidence,
            requiredProof,
            evidence: `${proofRecord.evidence} Latest proof did not pass the gate: trial ${proofRecord.trial.status}, click reduction/product ${proofRecord.clickReductionPerProduct.toFixed(2)}, decision reduction/product ${proofRecord.decisionReductionPerProduct.toFixed(2)}.`,
            proofRecordId: proofRecord.id
        };
    }
    const evidence = totalOccurrences >= 3
        ? `${totalOccurrences} occurrence(s) found; enough repetition to design a replacement, but no click/decision reduction proof is recorded yet.`
        : `${totalOccurrences} occurrence(s) found; keep collecting evidence before promoting an AI/browser replacement.`;
    return {
        status: "needs-proof",
        confidence: "weak",
        requiredProof,
        evidence,
        proofRecordId: null
    };
};
const getManualBudgetProofGateSortRank = (proofGate) => {
    if (proofGate.status === "ready-for-default" && proofGate.confidence === "measured") {
        return 0;
    }
    if (proofGate.status === "ready-for-default" && proofGate.confidence === "estimated") {
        return 1;
    }
    return 2;
};
const latestManualBudgetTrialForCandidate = (candidateKey) => manualBudgetTrialHistory
    .filter((trial) => trial.status === "started" && trial.candidateKey === candidateKey)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
const hasMeasuredManualBudgetTrialEvidence = (outcome) => Boolean(outcome.automationMeasurement?.reportCount && outcome.automationMeasurement.reportCount > 0);
const manualBudgetTrialPromotionGateForCandidate = (candidateKey, proofGate) => {
    if (proofGate.status !== "ready-for-default"
        || proofGate.confidence !== "measured"
        || !proofGate.proofRecordId) {
        return {
            ready: false,
            status: "needs-measured-proof",
            message: "candidate still needs measured click/decision proof before default automation"
        };
    }
    const latestTrial = latestManualBudgetTrialForCandidate(candidateKey);
    if (!latestTrial) {
        return {
            ready: false,
            status: "needs-validation-run",
            message: "measured proof exists, but no clean validation run has passed yet"
        };
    }
    const outcome = latestTrial.outcome;
    if (outcome.status === "running") {
        return {
            ready: false,
            status: "validation-running",
            message: `latest validation run ${latestTrial.id} is still running`
        };
    }
    const cleanPassed = outcome.status === "passed"
        && outcome.proofRecordId === proofGate.proofRecordId
        && hasMeasuredManualBudgetTrialEvidence(outcome)
        && latestTrial.skippedItems.length === 0
        && latestTrial.flowJobIds.length > 0
        && outcome.completed === latestTrial.flowJobIds.length
        && outcome.failed === 0
        && outcome.running === 0
        && outcome.missing === 0
        && outcome.flowOutcomes.length === latestTrial.flowJobIds.length
        && outcome.flowOutcomes.every((flowOutcome) => flowOutcome.status === "completed" && flowOutcome.reportPaths.length > 0);
    if (cleanPassed) {
        return {
            ready: true,
            status: "ready-for-default",
            message: `validation run ${latestTrial.id} passed with measured report evidence`
        };
    }
    if (outcome.status === "failed") {
        return {
            ready: false,
            status: "validation-failed",
            message: outcome.message || `latest validation run ${latestTrial.id} failed`
        };
    }
    return {
        ready: false,
        status: "needs-clean-validation",
        message: `latest validation run ${latestTrial.id} did not produce clean measured evidence`
    };
};
const manualBudgetPromotionGate = (manualBudget) => {
    const heldCandidates = manualBudget.replacementQueue
        .map((candidate) => ({
        candidate,
        gate: manualBudgetTrialPromotionGateForCandidate(candidate.key, candidate.proofGate)
    }))
        .filter(({ candidate, gate }) => candidate.proofGate.status === "ready-for-default"
        && candidate.proofGate.confidence === "measured"
        && !gate.ready);
    return {
        heldCandidates,
        status: heldCandidates.length > 0 ? "warning" : "pass",
        message: heldCandidates.length > 0
            ? `${heldCandidates.length} measured manual-step replacement candidate(s) are held outside default automation until a clean validation run passes with report evidence`
            : "manual-step replacement promotion gate is clear",
        details: heldCandidates.map(({ candidate, gate }) => `${candidate.reason}: ${gate.message}`).slice(0, 5)
    };
};
const buildManualBudgetReplacementQueue = (publishOutcomeItems, releases, proofs = manualBudgetProofLedger) => {
    const groups = new Map();
    const register = (entry) => {
        const key = normalizeManualBudgetReplacementKey(entry.source, entry.reason);
        const group = groups.get(key) ?? {
            source: entry.source,
            reason: entry.reason,
            activeCount: 0,
            releasedCount: 0,
            sampleWorkItemIds: [],
            sampleTitles: [],
            latestAt: entry.latestAt,
            operatorAction: entry.operatorAction,
            releaseCondition: entry.releaseCondition
        };
        if (entry.released) {
            group.releasedCount += 1;
        }
        else {
            group.activeCount += 1;
        }
        if (!group.sampleWorkItemIds.includes(entry.workItemId)) {
            group.sampleWorkItemIds.push(entry.workItemId);
        }
        if (entry.title && !group.sampleTitles.includes(entry.title)) {
            group.sampleTitles.push(entry.title);
        }
        if (entry.latestAt.localeCompare(group.latestAt) > 0) {
            group.latestAt = entry.latestAt;
            group.operatorAction = entry.operatorAction;
            group.releaseCondition = entry.releaseCondition;
        }
        groups.set(key, group);
    };
    for (const item of publishOutcomeItems) {
        register({
            source: item.source,
            reason: item.reason,
            workItemId: item.workItemId,
            title: item.title,
            latestAt: item.updatedAt,
            operatorAction: item.operatorAction,
            releaseCondition: item.releaseCondition,
            released: false
        });
    }
    for (const release of releases) {
        register({
            source: release.source,
            reason: release.reason,
            workItemId: release.workItemId,
            title: release.title,
            latestAt: release.releasedAt,
            operatorAction: release.operatorAction,
            releaseCondition: release.releaseCondition,
            released: true
        });
    }
    return Array.from(groups.entries())
        .map(([key, group]) => {
        const totalOccurrences = group.activeCount + group.releasedCount;
        const latestProof = proofs
            .filter((proof) => proof.candidateKey === key)
            .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0] ?? null;
        const proofGate = buildManualBudgetProofGate(group.activeCount, group.releasedCount, latestProof);
        const trialPromotionGate = manualBudgetTrialPromotionGateForCandidate(key, proofGate);
        return {
            key,
            source: group.source,
            reason: group.reason,
            activeCount: group.activeCount,
            releasedCount: group.releasedCount,
            totalOccurrences,
            sampleWorkItemIds: group.sampleWorkItemIds.slice(0, 5),
            sampleTitles: group.sampleTitles.slice(0, 3),
            latestAt: group.latestAt,
            operatorAction: group.operatorAction,
            releaseCondition: group.releaseCondition,
            replacementPlan: buildManualBudgetReplacementPlan(group.reason, group.operatorAction),
            defaultEligible: trialPromotionGate.ready,
            proofGate
        };
    })
        .sort((left, right) => {
        const leftProofRank = getManualBudgetProofGateSortRank(left.proofGate);
        const rightProofRank = getManualBudgetProofGateSortRank(right.proofGate);
        if (leftProofRank !== rightProofRank) {
            return leftProofRank - rightProofRank;
        }
        if (right.activeCount !== left.activeCount) {
            return right.activeCount - left.activeCount;
        }
        if (right.totalOccurrences !== left.totalOccurrences) {
            return right.totalOccurrences - left.totalOccurrences;
        }
        return right.latestAt.localeCompare(left.latestAt);
    })
        .slice(0, 10);
};
const normalizeRollbackCriteria = (criteria) => criteria.map((item) => item.trim()).filter(Boolean);
const rollbackCriteriaAccepted = (required, accepted = []) => {
    const requiredCriteria = normalizeRollbackCriteria(required);
    const acceptedCriteria = normalizeRollbackCriteria(accepted);
    return requiredCriteria.length > 0
        && requiredCriteria.length === acceptedCriteria.length
        && requiredCriteria.every((criteria) => acceptedCriteria.includes(criteria));
};
const buildManualBudgetTrialReadiness = (input, context) => {
    const sampleAvailableCount = input.sampleWorkItemIds.filter((id) => context.allWorkItemIds.has(id)).length;
    const rollbackAccepted = context.rollbackAcknowledged === true
        && rollbackCriteriaAccepted(input.rollbackCriteria, context.acceptedRollbackCriteria);
    const readinessChecks = [
        {
            id: "real-dianxiaomi-calibration",
            label: "real Dianxiaomi calibration",
            status: context.calibrationCheck.status,
            message: context.calibrationCheck.message
        },
        !context.profile.path
            ? {
                id: "browser-profile",
                label: "browser profile",
                status: "block",
                message: "browser profile path is not configured; configure a persistent Dianxiaomi profile before trial execution"
            }
            : context.profile.lockFiles.length > 0
                ? {
                    id: "browser-profile",
                    label: "browser profile",
                    status: "block",
                    message: `browser profile has possible lock file(s): ${context.profile.lockFiles.join(", ")}`
                }
                : !context.profile.exists
                    ? {
                        id: "browser-profile",
                        label: "browser profile",
                        status: "warning",
                        message: "browser profile path is configured but the directory has not been created yet"
                    }
                    : {
                        id: "browser-profile",
                        label: "browser profile",
                        status: "pass",
                        message: "browser profile path exists and has no detected lock files"
                    },
        input.sampleWorkItemIds.length === 0 || sampleAvailableCount === 0
            ? {
                id: "sample-availability",
                label: "candidate sample availability",
                status: "block",
                message: "no proposed trial sample is still available in the Dianxiaomi work queue"
            }
            : sampleAvailableCount < input.sampleWorkItemIds.length
                ? {
                    id: "sample-availability",
                    label: "candidate sample availability",
                    status: "warning",
                    message: `${sampleAvailableCount}/${input.sampleWorkItemIds.length} proposed trial sample(s) are still available; regenerate the proposal before execution`
                }
                : {
                    id: "sample-availability",
                    label: "candidate sample availability",
                    status: "pass",
                    message: `${sampleAvailableCount}/${input.sampleWorkItemIds.length} proposed trial sample(s) are still available`
                },
        rollbackAccepted
            ? {
                id: "rollback-acknowledgement",
                label: "rollback acknowledgement",
                status: "pass",
                message: `rollback criteria acknowledged in Advanced (${input.rollbackCriteria.length} criteria)`
            }
            : {
                id: "rollback-acknowledgement",
                label: "rollback acknowledgement",
                status: "block",
                message: context.rollbackAcknowledged
                    ? "rollback acknowledgement does not match the current proposal criteria; refresh the proposal and acknowledge again"
                    : `rollback criteria must be acknowledged in Advanced before trial execution (${input.rollbackCriteria.length} criteria)`
            }
    ];
    const rollbackAcknowledgementRequired = readinessChecks.some((check) => check.id === "rollback-acknowledgement" && check.status === "block");
    const readinessStatus = readinessChecks.some((check) => check.status === "block")
        ? "blocked"
        : readinessChecks.some((check) => check.status === "warning")
            ? "warning"
            : "ready";
    const executionReady = readinessChecks.every((check) => check.status === "pass") && !rollbackAcknowledgementRequired;
    return {
        readinessStatus,
        readinessChecks,
        executionReady,
        rollbackAcknowledgementRequired
    };
};
const buildManualBudgetTrialProposals = (replacementQueue, proofs, readinessContext) => replacementQueue
    .flatMap((candidate) => {
    if (candidate.proofGate.status !== "ready-for-default"
        || candidate.proofGate.confidence !== "measured"
        || !candidate.proofGate.proofRecordId) {
        return [];
    }
    const proof = proofs.find((item) => item.id === candidate.proofGate.proofRecordId);
    if (!proof?.automationMeasurement || proof.confidence !== "measured") {
        return [];
    }
    if (manualBudgetTrialPromotionGateForCandidate(candidate.key, candidate.proofGate).ready) {
        return [];
    }
    const trialSize = Math.min(3, Math.max(1, candidate.sampleWorkItemIds.length || candidate.totalOccurrences));
    const rollbackCriteria = [
        "Any trial product needs operator action beyond Temu pricing/final listing approval.",
        "Any trial product fails Dianxiaomi submit, target-surface, selector, or media-processing checks.",
        "Measured automation reports are missing, incomplete, or show no click/decision reduction."
    ];
    const readiness = buildManualBudgetTrialReadiness({
        sampleWorkItemIds: candidate.sampleWorkItemIds.slice(0, trialSize),
        rollbackCriteria
    }, readinessContext);
    return [{
            candidateKey: candidate.key,
            source: candidate.source,
            reason: candidate.reason,
            replacementPlan: candidate.replacementPlan,
            proofRecordId: proof.id,
            proofConfidence: "measured",
            trialSize,
            trialScope: `Run at most ${trialSize} matching real Dianxiaomi product(s) through this replacement path before any default-flow promotion.`,
            sampleWorkItemIds: candidate.sampleWorkItemIds.slice(0, trialSize),
            sampleTitles: candidate.sampleTitles.slice(0, trialSize),
            measuredReportCount: proof.automationMeasurement.reportCount,
            measuredBrowserClicks: proof.automationMeasurement.browserClicks,
            measuredBrowserActions: proof.automationMeasurement.browserActions,
            acceptanceCriteria: [
                "Every trial product completes Dianxiaomi save and submit without adding a new operator step.",
                "Per-product operator clicks or product-level decisions stay below the recorded baseline.",
                "No trial product is routed back into manual-step budget, selector calibration, login/CAPTCHA, or media-processing failure."
            ],
            rollbackCriteria,
            ...readiness,
            note: "Advanced-only proposal; it does not enter the daily unattended default flow until a bounded trial passes and the proof gate remains measured."
        }];
})
    .slice(0, 5);
const buildManualStepBudget = (workItems, trialReadinessContext) => {
    const publishOutcomeItems = workItems
        .map((item) => buildPublishOutcomeManualBudgetItem(item))
        .filter((item) => Boolean(item))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const releases = workItems
        .flatMap((item) => item.manualBudgetReleases ?? [])
        .sort((left, right) => right.releasedAt.localeCompare(left.releasedAt));
    const replacementQueue = buildManualBudgetReplacementQueue(publishOutcomeItems, releases, manualBudgetProofLedger);
    return {
        total: publishOutcomeItems.length,
        publishOutcomes: publishOutcomeItems.slice(0, 20),
        releases: releases.slice(0, 20),
        replacementQueue,
        trialProposals: buildManualBudgetTrialProposals(replacementQueue, manualBudgetProofLedger, trialReadinessContext),
        proofs: manualBudgetProofLedger.slice(0, 20),
        validationClosure: buildManualBudgetValidationClosure()
    };
};
const buildManualStepBudgetWithCurrentReadiness = (workItems, context = {}) => {
    const profile = inspectQueueDaemonProfile();
    const calibrationCheck = latestSelectorCalibrationCheck();
    return buildManualStepBudget(workItems, {
        calibrationCheck,
        profile,
        allWorkItemIds: new Set(workItems.map((item) => item.id)),
        ...context
    });
};
const blockedManualBudgetTrialResult = (input, partial) => {
    const record = {
        id: partial.id ?? `manual-budget-trial-request-${timestampId()}`,
        requestedAt: partial.requestedAt,
        updatedAt: partial.requestedAt,
        candidateKey: input.candidateKey,
        validationRerun: normalizeManualBudgetValidationRerun(input.validationRerun),
        status: "blocked",
        message: partial.message,
        rollbackAcknowledged: input.rollbackAcknowledged,
        acceptedRollbackCriteria: normalizeRollbackCriteria(input.acceptedRollbackCriteria),
        proposal: partial.proposal,
        readinessStatus: partial.readinessStatus,
        readinessChecks: partial.readinessChecks,
        trialSize: partial.trialSize ?? partial.proposal?.trialSize ?? 0,
        flowJobIds: [],
        skippedItems: partial.skippedItems ?? [],
        outcome: buildBlockedManualBudgetTrialOutcome(partial.message, partial.requestedAt)
    };
    return saveManualBudgetTrialRecord(record);
};
export const startManualBudgetTrial = (input) => {
    refreshRunningManualBudgetTrialOutcomes();
    const requestedAt = new Date().toISOString();
    const trialRequestId = `manual-budget-trial-request-${timestampId()}-${Math.random().toString(36).slice(2, 8)}`;
    const allWorkItems = listScopedDianxiaomiProductWorkItems(input);
    const manualBudget = buildManualStepBudgetWithCurrentReadiness(allWorkItems, {
        rollbackAcknowledged: input.rollbackAcknowledged,
        acceptedRollbackCriteria: input.acceptedRollbackCriteria
    });
    const proposal = manualBudget.trialProposals.find((item) => item.candidateKey === input.candidateKey) ?? null;
    if (!proposal) {
        return blockedManualBudgetTrialResult(input, {
            id: trialRequestId,
            requestedAt,
            message: "no measured bounded trial proposal exists for this candidate",
            proposal: null,
            readinessStatus: "blocked",
            readinessChecks: [{
                    id: "bounded-trial-proposal",
                    label: "bounded trial proposal",
                    status: "block",
                    message: "candidate must have a measured ready replacement proposal before trial execution"
                }]
        });
    }
    const runningTrial = latestManualBudgetTrialForCandidate(input.candidateKey);
    if (runningTrial?.outcome.status === "running") {
        return blockedManualBudgetTrialResult(input, {
            id: trialRequestId,
            requestedAt,
            message: `bounded trial request is blocked because ${runningTrial.id} is already running for this candidate`,
            proposal,
            readinessStatus: "blocked",
            readinessChecks: [
                ...proposal.readinessChecks,
                {
                    id: "bounded-trial-running",
                    label: "bounded trial running",
                    status: "block",
                    message: `wait for ${runningTrial.id} to pass or fail before starting another validation run`
                }
            ]
        });
    }
    if (!proposal.executionReady) {
        return blockedManualBudgetTrialResult(input, {
            id: trialRequestId,
            requestedAt,
            message: "bounded trial request is blocked until every readiness check passes",
            proposal,
            readinessStatus: proposal.readinessStatus,
            readinessChecks: proposal.readinessChecks
        });
    }
    const workItemsById = new Map(allWorkItems.map((item) => [item.id, item]));
    const { candidateKey: _candidateKey, rollbackAcknowledged: _rollbackAcknowledged, acceptedRollbackCriteria: _acceptedRollbackCriteria, validationRerun: _validationRerun, ...flowInput } = input;
    const flowJobIds = [];
    const skippedItems = [];
    for (const workItemId of proposal.sampleWorkItemIds.slice(0, proposal.trialSize)) {
        const workItem = workItemsById.get(workItemId);
        if (!workItem) {
            skippedItems.push({
                workItemId,
                reason: "bounded trial sample is no longer available"
            });
            continue;
        }
        const pageUrlValidation = validateDianxiaomiAutomationPageUrl(workItem.pageUrl);
        if (!pageUrlValidation.valid) {
            skippedItems.push({
                workItemId,
                reason: pageUrlValidation.reason ?? "invalid Dianxiaomi page URL"
            });
            continue;
        }
        const repairPlan = workItem.repairPlan;
        const taskFileRead = readAutomationTaskFile(input.taskFile);
        const repairExport = repairPlan
            ? input.taskFile?.trim() && taskFileRead.task && !taskFileRead.error
                ? exportFallbackRepairPreviewFile(workItem, taskFileRead)
                : exportDianxiaomiRepairPreview(workItem.id)
            : null;
        const taskResult = repairExport
            ? null
            : createTaskFromDianxiaomiProductWorkItem(workItem.id);
        if (!repairExport && !taskResult) {
            skippedItems.push({
                workItemId,
                reason: "could not create automation task from bounded trial sample"
            });
            continue;
        }
        const taskExport = repairExport
            ? {
                taskFile: repairExport.taskFile,
                absolutePath: repairExport.absoluteTaskFile
            }
            : taskResult
                ? exportTaskFile(taskResult.task.id)
                : null;
        if (!taskExport) {
            skippedItems.push({
                workItemId,
                reason: "could not export automation task file for bounded trial sample"
            });
            continue;
        }
        try {
            const taskId = repairExport?.task.id ?? taskResult?.task.id ?? null;
            const flow = startDianxiaomiFullFlow({
                ...flowInput,
                url: input.url ?? workItem.pageUrl,
                taskFile: taskExport.taskFile,
                repairPlanFile: input.repairPlanFile ?? repairExport?.repairPlanFile,
                mediaAutomationMode: input.mediaAutomationMode ?? "unattended-apply"
            }, {
                workItemId: workItem.id,
                taskId,
                taskFile: taskExport.taskFile,
                source: "manual-budget-trial"
            });
            flowJobIds.push(flow.id);
            updateDianxiaomiProductWorkItemStatus(workItem.id, "edited", `manual-budget bounded trial queued: ${flow.id}`);
        }
        catch (error) {
            skippedItems.push({
                workItemId,
                reason: error instanceof Error ? error.message : String(error)
            });
        }
    }
    if (flowJobIds.length === 0) {
        return blockedManualBudgetTrialResult(input, {
            id: trialRequestId,
            requestedAt,
            message: `bounded trial request passed readiness but no flow could be started; skipped ${skippedItems.length} sample(s)`,
            proposal,
            readinessStatus: proposal.readinessStatus,
            readinessChecks: proposal.readinessChecks,
            trialSize: proposal.trialSize,
            skippedItems
        });
    }
    return saveManualBudgetTrialRecord({
        id: trialRequestId,
        requestedAt,
        updatedAt: requestedAt,
        candidateKey: input.candidateKey,
        validationRerun: normalizeManualBudgetValidationRerun(input.validationRerun),
        status: "started",
        message: `bounded trial started ${flowJobIds.length} flow(s), skipped ${skippedItems.length}`,
        rollbackAcknowledged: input.rollbackAcknowledged,
        acceptedRollbackCriteria: normalizeRollbackCriteria(input.acceptedRollbackCriteria),
        proposal,
        readinessStatus: proposal.readinessStatus,
        readinessChecks: proposal.readinessChecks,
        trialSize: proposal.trialSize,
        flowJobIds,
        skippedItems,
        outcome: buildRunningManualBudgetTrialOutcome(flowJobIds, `waiting for ${flowJobIds.length} bounded trial full-flow job(s)`)
    });
};
export const startNextManualBudgetValidationRun = (input: AutomationDryRunStartInput = {}) => {
    refreshRunningManualBudgetTrialOutcomes();
    const allWorkItems = listScopedDianxiaomiProductWorkItems(input);
    const manualBudget = buildManualStepBudgetWithCurrentReadiness(allWorkItems);
    const proposal = manualBudget.trialProposals[0] ?? null;
    if (!proposal) {
        const requestedAt = new Date().toISOString();
        return blockedManualBudgetTrialResult({
            ...input,
            candidateKey: "next-held-manual-budget-validation",
            rollbackAcknowledged: true,
            acceptedRollbackCriteria: []
        }, {
            id: `manual-budget-validation-run-${timestampId()}-${Math.random().toString(36).slice(2, 8)}`,
            requestedAt,
            message: "no measured manual-step replacement candidate is currently held for validation",
            proposal: null,
            readinessStatus: "blocked",
            readinessChecks: [{
                    id: "manual-budget-promotion-gate",
                    label: "manual-step promotion validation",
                    status: "block",
                    message: "queue health has no measured manual-step replacement candidate waiting for a clean validation run"
                }]
        });
    }
    return startManualBudgetTrial({
        ...input,
        candidateKey: proposal.candidateKey,
        rollbackAcknowledged: true,
        acceptedRollbackCriteria: proposal.rollbackCriteria,
        mediaAutomationMode: input.mediaAutomationMode ?? "unattended-apply",
        submitAfterSave: input.submitAfterSave ?? true
    });
};
export const getDianxiaomiQueueDaemonHealth = (input: AutomationDryRunStartInput = {}) => {
    refreshRunningManualBudgetTrialOutcomes();
    const scopeInput = hasAutomationQueueScope(input) ? input : daemonStateHolder.current.input;
    const profile = inspectQueueDaemonProfile(input.profile);
    const allWorkItems = listScopedDianxiaomiProductWorkItems(scopeInput);
    const allWorkItemIds = scopedWorkItemIds(allWorkItems);
    const workItems = summarizeScopedWorkItems(allWorkItems);
    const calibrationCheck = latestSelectorCalibrationCheck();
    const sessionCheck = latestDianxiaomiSessionCheck();
    const manualBudget = buildManualStepBudget(allWorkItems, {
        calibrationCheck,
        profile,
        allWorkItemIds
    });
    const manualBudgetPromotionStatus = manualBudgetPromotionGate(manualBudget);
    const recoveryFailureSummaries = filterRecoveryFailureSummariesForItems(collectRecoveryFailureSummaries(), allWorkItems);
    const browserRecoveryCandidateItems = allWorkItems
        .filter((item) => isDianxiaomiWorkItemBrowserRecoveryCandidate(item));
    recordReleasedRecoveryPauses(browserRecoveryCandidateItems, recoveryFailureSummaries);
    const pausedBrowserRecoveryCandidateItems = browserRecoveryCandidateItems
        .filter((item) => isDianxiaomiWorkItemBrowserRecoveryPaused(item, recoveryFailureSummaries));
    const unpausedBrowserRecoveryCandidateItems = browserRecoveryCandidateItems
        .filter((item) => !isDianxiaomiWorkItemBrowserRecoveryPaused(item, recoveryFailureSummaries));
    const releasedRetryCandidates = unpausedBrowserRecoveryCandidateItems
        .map((item) => releasedRetryCandidateForWorkItem(item))
        .filter((item) => Boolean(item));
    const releasedRetryCandidateIds = new Set(releasedRetryCandidates.map((item) => item.workItemId));
    const autoRetryCandidates = allWorkItems
        .filter((item) => isDianxiaomiWorkItemAutoRetryCandidate(item) && !isDianxiaomiWorkItemBrowserRecoveryCandidate(item)).length;
    const browserRecoveryCandidates = unpausedBrowserRecoveryCandidateItems
        .filter((item) => !releasedRetryCandidateIds.has(item.id)).length;
    const releasedBrowserRecoveryCandidates = releasedRetryCandidates.length;
    const releasedRetryBatch = buildReleasedRetryBatchPolicy(releasedRetryCandidates, browserRecoveryCandidates);
    const pausedBrowserRecoveryCandidates = pausedBrowserRecoveryCandidateItems.length;
    const runnableWorkItems = workItems.ready + autoRetryCandidates + browserRecoveryCandidates + releasedBrowserRecoveryCandidates;
    const publishSucceeded = allWorkItems.filter((item) => item.publishOutcome?.status === "succeeded").length;
    const publishFailed = allWorkItems.filter((item) => item.publishOutcome?.status === "failed").length;
    const publishRecoveryCandidates = allWorkItems.filter((item) => item.publishOutcome?.status === "failed"
        && ["auto-retry", "browser-recovery"].includes(item.publishOutcome.route)).length;
    const publishManualBudget = manualBudget.total;
    const trackedFlowIds = daemonStateHolder.current.trackedFlowJobIds.filter((id) => {
        if (!hasAutomationQueueScope(scopeInput)) {
            return true;
        }
        const job = fullFlowJobs.get(id);
        return Boolean(job?.workItemId && allWorkItemIds.has(job.workItemId));
    });
    const unresolvedFlowIds = trackedFlowIds.filter((id) => !daemonStateHolder.current.resolvedFlowJobIds.includes(id));
    const unresolvedRunningFlows = trackedFlowIds
        .map((id) => fullFlowJobs.get(id))
        .filter((job) => Boolean(job))
        .filter((job) => job.status === "running").length;
    const recentFailures = daemonStateHolder.current.flowOutcomes
        .filter((outcome) => outcome.status === "failed" && allWorkItemIds.has(outcome.workItemId))
        .slice(0, 10).length;
    const auditEntries = daemonStateHolder.current.ticks
        .filter((tick) => matchesQueueDaemonTickStoreScope(tick, scopeInput))
        .slice(0, 10)
        .map(queueDaemonAuditEntryForTick);
    const lastFailedTick = daemonStateHolder.current.ticks.find((tick) => (tick.status === "failed"
        || !queueDaemonSuccessfulCategories.has(tick.category))
        && matchesQueueDaemonTickStoreScope(tick, scopeInput));
    const releasedRetryOutcomes = collectReleasedRetryOutcomes(recoveryFailureSummaries)
        .filter((outcome) => allWorkItemIds.has(outcome.workItemId));
    const scopedRecoveryReleases = recoveryReleases
        .filter((release) => allWorkItems.some((item) => recoveryReleaseMatchesWorkItem(release, item)))
        .slice(0, 10);
    const issues = [];
    if (daemonStateHolder.current.status === "PAUSED") {
        issues.push({
            id: "daemon-paused",
            level: runnableWorkItems > 0 ? "warning" : "info",
            message: runnableWorkItems > 0 ? `daemon paused while ${runnableWorkItems} work item(s) are runnable` : "daemon paused"
        });
    }
    if (daemonStateHolder.current.consecutiveFailures > 0) {
        issues.push({
            id: "consecutive-failures",
            level: daemonStateHolder.current.consecutiveFailures >= daemonStateHolder.current.maxConsecutiveFailures ? "block" : "warning",
            message: `consecutive failures ${daemonStateHolder.current.consecutiveFailures}/${daemonStateHolder.current.maxConsecutiveFailures}`
        });
    }
    if (daemonStateHolder.current.lastError) {
        issues.push({
            id: "last-error",
            level: "warning",
            message: daemonStateHolder.current.lastError
        });
    }
    if (!profile.path) {
        issues.push({
            id: "profile-missing-config",
            level: "warning",
            message: "browser profile path is not configured"
        });
    }
    else if (!profile.exists) {
        issues.push({
            id: "profile-not-created",
            level: "warning",
            message: "browser profile directory has not been initialized yet"
        });
    }
    if (profile.lockFiles.length > 0 && !daemonStateHolder.current.running) {
        issues.push({
            id: "profile-lock-files",
            level: "warning",
            message: `profile has possible browser lock file(s): ${profile.lockFiles.join(", ")}`
        });
    }
    if (profile.staleLockFiles.length > 0 && !daemonStateHolder.current.running) {
        issues.push({
            id: "profile-stale-lock-files",
            level: "info",
            message: `profile has stale browser lock file(s) ignored by startup gate: ${profile.staleLockFiles.join(", ")}`
        });
    }
    if (workItems.blocked > 0) {
        issues.push({
            id: "blocked-work-items",
            level: "warning",
            message: `${workItems.blocked} work item(s) are blocked`
        });
    }
    if (workItems.ready === 0 && browserRecoveryCandidates === 0 && releasedBrowserRecoveryCandidates === 0 && daemonStateHolder.current.status === "ACTIVE") {
        issues.push({
            id: "no-ready-work-items",
            level: "info",
            message: "no ready work items are available"
        });
    }
    if (recentFailures > 0) {
        issues.push({
            id: "recent-flow-failures",
            level: "warning",
            message: `${recentFailures} recent full-flow outcome(s) failed`
        });
    }
    if (manualBudgetPromotionStatus.heldCandidates.length > 0) {
        issues.push({
            id: "manual-budget-promotion-gate",
            level: "warning",
            message: manualBudgetPromotionStatus.message
        });
    }
    if (pausedBrowserRecoveryCandidates > 0) {
        issues.push({
            id: "paused-browser-recovery-candidates",
            level: "warning",
            message: `${pausedBrowserRecoveryCandidates} browser recovery candidate(s) paused by repeated-failure budget`
        });
    }
    if (recoveryFailureSummaries.length > 0) {
        issues.push({
            id: "repeated-recovery-failures",
            level: "warning",
            message: `${recoveryFailureSummaries.length} repeated automatic recovery failure pattern(s) detected`
        });
    }
    if (runnableWorkItems > 0 && calibrationCheck.status === "block") {
        issues.push({
            id: "real-dianxiaomi-calibration",
            level: "block",
            message: calibrationCheck.message
        });
    }
    if (runnableWorkItems > 0 && sessionCheck.status === "block") {
        issues.push({
            id: "login-or-captcha-session",
            level: "block",
            message: sessionCheck.message
        });
    }
    const alerts = queueDaemonHealthAlerts(issues, {
        daemonStatus: daemonStateHolder.current.status,
        readyWorkItems: workItems.ready,
        blockedWorkItems: workItems.blocked,
        autoRetryCandidates,
        browserRecoveryCandidates,
        releasedBrowserRecoveryCandidates,
        pausedBrowserRecoveryCandidates,
        recentFailures,
        profileLockFiles: profile.lockFiles,
        lastFailedCategory: lastFailedTick?.category ?? null,
        recoveryFailureSummaries,
        manualBudget
    });
    const recommendation = queueDaemonRecommendation({
        status: queueDaemonIssueStatus(issues),
        issues,
        auditEntries,
        daemonStatus: daemonStateHolder.current.status,
        readyWorkItems: workItems.ready,
        autoRetryCandidates,
        browserRecoveryCandidates,
        releasedBrowserRecoveryCandidates,
        pausedBrowserRecoveryCandidates,
        unresolvedRunningFlows,
        recentFailures,
        profileLockFiles: profile.lockFiles,
        recoveryFailureSummaries
    });
    return {
        checkedAt: new Date().toISOString(),
        status: queueDaemonIssueStatus(issues),
        issues,
        alerts,
        recommendation,
        queue: {
            daemonStatus: daemonStateHolder.current.status,
            running: daemonStateHolder.current.running,
            consecutiveFailures: daemonStateHolder.current.consecutiveFailures,
            maxConsecutiveFailures: daemonStateHolder.current.maxConsecutiveFailures,
            nextRunAt: daemonStateHolder.current.nextRunAt,
            lastError: daemonStateHolder.current.lastError,
            lastFailedCategory: lastFailedTick?.category ?? null
        },
        workItems: {
            ...workItems,
            autoRetryCandidates,
            browserRecoveryCandidates,
            releasedBrowserRecoveryCandidates,
            pausedBrowserRecoveryCandidates,
            publishSucceeded,
            publishFailed,
            publishRecoveryCandidates,
            publishManualBudget
        },
        manualBudget,
        profile,
        flows: {
            tracked: trackedFlowIds.length,
            unresolved: unresolvedFlowIds.length,
            recentFailures
        },
        audit: {
            recent: auditEntries
        },
        recovery: {
            history: recoveryRuns.size,
            repeatedFailures: recoveryFailureSummaries,
            paused: pausedBrowserRecoveryCandidateItems
                .map((item) => recoveryPauseForWorkItem(item, recoveryFailureSummaries))
                .filter((pause) => Boolean(pause)),
            releasedRetryBatch,
            releasedRetryCandidates,
            releasedRetryOutcomes,
            releases: scopedRecoveryReleases
        }
    };
};
const startupStatus = (checks) => checks.some((check) => check.status === "block")
    ? "blocked"
    : checks.some((check) => check.status === "warning")
        ? "warning"
        : "ready";
const unattendedBrowserProfileStartupCheck = (profile) => {
    if (!profile.path) {
        return {
            id: "browser-profile",
            label: "浏览器配置",
            status: "block",
            message: "未配置浏览器配置路径；请先配置一个持久登录的店小秘配置，再启动无人值守"
        };
    }
    if (!profile.exists) {
        return {
            id: "browser-profile",
            label: "浏览器配置",
            status: "block",
            message: `浏览器配置目录不存在：${profile.path}；请先在有头模式下初始化并登录店小秘，再启动无人值守`
        };
    }
    if (profile.lockFiles.length > 0) {
        return {
            id: "browser-profile",
            label: "浏览器配置",
            status: "block",
            message: `配置可能存在锁文件：${profile.lockFiles.join(", ")}`
        };
    }
    return {
        id: "browser-profile",
        label: "浏览器配置",
        status: "pass",
        message: `配置就绪：${profile.path}`
    };
};
const summarizeCalibrationUrl = (url) => {
    if (url.length <= 160) {
        return url;
    }
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}${parsed.protocol === "data:" ? " fixture" : `//${parsed.host}${parsed.pathname}`} (${url.length} chars)`;
    }
    catch {
        return `${url.slice(0, 120)}... (${url.length} chars)`;
    }
};
const diagnosisSurfaceStatus = (report) => String(report?.targetSurface?.data?.surfaceStatus ?? "unknown");
const isUsableRealDianxiaomiDiagnosis = (report) => {
    const targetSurface = report?.targetSurface;
    const data = targetSurface?.data ?? {};
    return diagnosisSurfaceStatus(report) === "real-dianxiaomi"
        && data.isDianxiaomiHost === true
        && data.isDataFixture !== true
        && targetSurface?.status !== "failed"
        && data.canInspect !== false;
};
const latestSelectorCalibrationCheck = () => {
    const latestDiagnosis = listSelectorDiagnosisReports(20).find((report) => Boolean(report.targetSurface));
    if (!latestDiagnosis) {
        return {
            id: "real-dianxiaomi-calibration",
            label: "real Dianxiaomi calibration",
            status: "block",
            message: "no selector calibration report with target-surface data found; run calibration on a real Dianxiaomi listing edit page"
        };
    }
    const targetSurface = latestDiagnosis.targetSurface;
    const data = targetSurface?.data ?? {};
    const surfaceStatus = diagnosisSurfaceStatus(latestDiagnosis);
    const calibrationCreatedAtMs = parseTimestampMs(latestDiagnosis.createdAt);
    const calibrationAgeMs = Number.isFinite(calibrationCreatedAtMs)
        ? Math.max(0, Date.now() - calibrationCreatedAtMs)
        : null;
    const calibrationStaleMs = getRealCalibrationStaleMs();
    const isRealDianxiaomi = isUsableRealDianxiaomiDiagnosis(latestDiagnosis);
    const details = [
        `diagnosis: ${latestDiagnosis.createdAt}`,
        `surface: ${surfaceStatus}`,
        `page: ${latestDiagnosis.pageTitle || latestDiagnosis.pageUrl}`,
        `dianxiaomi host: ${String(data.isDianxiaomiHost ?? false)}`,
        `fixture: ${String(data.isDataFixture ?? false)}`,
        `can inspect: ${String(data.canInspect ?? targetSurface?.status !== "failed")}`,
        `age: ${calibrationAgeMs === null
            ? "unknown"
            : `${formatDurationCompact(calibrationAgeMs)} / max ${formatDurationCompact(calibrationStaleMs)}`}`,
        `url: ${summarizeCalibrationUrl(latestDiagnosis.pageUrl)}`
    ];
    if (isRealDianxiaomi && calibrationAgeMs === null) {
        return {
            id: "real-dianxiaomi-calibration",
            label: "real Dianxiaomi calibration",
            status: "block",
            message: "latest real Dianxiaomi calibration has an unreadable timestamp; rerun calibration on a current listing edit page",
            details
        };
    }
    if (isRealDianxiaomi && calibrationAgeMs > calibrationStaleMs) {
        return {
            id: "real-dianxiaomi-calibration",
            label: "real Dianxiaomi calibration",
            status: "block",
            message: `latest real Dianxiaomi calibration is stale (${formatDurationCompact(calibrationAgeMs)} old; max ${formatDurationCompact(calibrationStaleMs)}); rerun calibration on a current listing edit page`,
            details
        };
    }
    if (isRealDianxiaomi) {
        return {
            id: "real-dianxiaomi-calibration",
            label: "real Dianxiaomi calibration",
            status: "pass",
            message: "latest selector calibration was captured on a real Dianxiaomi listing edit page",
            details
        };
    }
    if (surfaceStatus === "fixture" || data.isDataFixture === true) {
        if (!allowDianxiaomiSmokeCalibration()) {
            return {
                id: "real-dianxiaomi-calibration",
                label: "real Dianxiaomi calibration",
                status: "block",
                message: "latest selector calibration is only the local fixture; production unattended queue requires a real Dianxiaomi listing edit page",
                details
            };
        }
        return {
            id: "real-dianxiaomi-calibration",
            label: "real Dianxiaomi calibration",
            status: "warning",
            message: "latest selector calibration is only the local fixture; smoke override is enabled for development",
            details
        };
    }
    return {
        id: "real-dianxiaomi-calibration",
        label: "real Dianxiaomi calibration",
        status: "block",
        message: `latest selector calibration is not a usable real Dianxiaomi listing edit page: ${surfaceStatus}`,
        details
    };
};
const latestDianxiaomiSessionCheck = () => {
    const targetSurfaceReports = listSelectorDiagnosisReports(20).filter((report) => Boolean(report.targetSurface));
    const latestRealDiagnosis = targetSurfaceReports.find((report) => isUsableRealDianxiaomiDiagnosis(report)) ?? null;
    const latestLoginDiagnosis = targetSurfaceReports.find((report) => diagnosisSurfaceStatus(report) === "login-or-captcha"
        || report.targetSurface?.data?.loginOrCaptchaDetected === true) ?? null;
    const latestLoginWorkItem = listDianxiaomiProductWorkItems(Number.MAX_SAFE_INTEGER)
        .filter((item) => item.failureDiagnosis?.category === "login-or-captcha")
        .sort((left, right) => (right.failureDiagnosis?.updatedAt ?? right.updatedAt ?? "").localeCompare(left.failureDiagnosis?.updatedAt ?? left.updatedAt ?? ""))[0] ?? null;
    const latestLoginAudit = collectQueueDaemonAuditEntries(20).find((entry) => entry.category === "login-or-captcha") ?? null;
    const blockers = [
        latestLoginDiagnosis
            ? {
                source: "selector-diagnosis",
                recordedAt: latestLoginDiagnosis.createdAt,
                recordedAtMs: parseTimestampMs(latestLoginDiagnosis.createdAt),
                reason: `latest target-surface diagnosis shows ${diagnosisSurfaceStatus(latestLoginDiagnosis)} on ${latestLoginDiagnosis.pageTitle || summarizeCalibrationUrl(latestLoginDiagnosis.pageUrl)}`
            }
            : null,
        latestLoginWorkItem
            ? {
                source: "work-item",
                recordedAt: latestLoginWorkItem.failureDiagnosis?.updatedAt ?? latestLoginWorkItem.updatedAt ?? null,
                recordedAtMs: parseTimestampMs(latestLoginWorkItem.failureDiagnosis?.updatedAt ?? latestLoginWorkItem.updatedAt ?? null),
                reason: `work item ${latestLoginWorkItem.id}${latestLoginWorkItem.title ? ` (${latestLoginWorkItem.title})` : ""} is blocked by login/CAPTCHA`
            }
            : null,
        latestLoginAudit
            ? {
                source: "queue-audit",
                recordedAt: latestLoginAudit.finishedAt ?? latestLoginAudit.startedAt ?? null,
                recordedAtMs: parseTimestampMs(latestLoginAudit.finishedAt ?? latestLoginAudit.startedAt ?? null),
                reason: latestLoginAudit.reason
            }
            : null
    ].filter((item) => Boolean(item))
        .sort((left, right) => {
        const leftTimestamp = left.recordedAtMs ?? -1;
        const rightTimestamp = right.recordedAtMs ?? -1;
        if (rightTimestamp !== leftTimestamp) {
            return rightTimestamp - leftTimestamp;
        }
        return (right.recordedAt ?? "").localeCompare(left.recordedAt ?? "");
    });
    const latestBlocker = blockers[0] ?? null;
    const latestRealDiagnosisAtMs = parseTimestampMs(latestRealDiagnosis?.createdAt ?? null);
    const recovered = latestBlocker
        && latestBlocker.recordedAtMs !== null
        && latestRealDiagnosisAtMs !== null
        && latestRealDiagnosisAtMs > latestBlocker.recordedAtMs;
    if (!latestBlocker) {
        return {
            id: "dianxiaomi-session",
            label: "Dianxiaomi session",
            status: "pass",
            message: latestRealDiagnosis
                ? "latest real Dianxiaomi diagnosis indicates an inspectable logged-in session"
                : "no unresolved Dianxiaomi login or CAPTCHA blocker is recorded"
        };
    }
    const details = [
        `latest blocker: ${latestBlocker.source} at ${latestBlocker.recordedAt ?? "unknown"}`,
        `reason: ${latestBlocker.reason}`,
        latestRealDiagnosis
            ? `latest real diagnosis: ${latestRealDiagnosis.createdAt} ${summarizeCalibrationUrl(latestRealDiagnosis.pageUrl)}`
            : "latest real diagnosis: none"
    ];
    if (recovered) {
        return {
            id: "dianxiaomi-session",
            label: "Dianxiaomi session",
            status: "pass",
            message: "a newer real Dianxiaomi diagnosis proves the session recovered after the latest login/CAPTCHA blocker",
            details
        };
    }
    return {
        id: "dianxiaomi-session",
        label: "Dianxiaomi session",
        status: "block",
        message: "latest Dianxiaomi session signal still points to login or CAPTCHA; finish login in the automation profile and capture a fresh real-page diagnosis before unattended startup",
        details
    };
};
export const getDianxiaomiUnattendedStartupCheck = (input: AutomationDryRunStartInput = {}) => {
    const normalized = normalizeQueueDaemonInput(input);
    const previousState = daemonStateHolder.current;
    daemonStateHolder.current = {
        ...daemonStateHolder.current,
        input: normalized.input,
        intervalSeconds: normalized.intervalSeconds,
        maxConsecutiveFailures: normalized.maxConsecutiveFailures
    };
    const health = getDianxiaomiQueueDaemonHealth(normalized.input);
    daemonStateHolder.current = previousState;
    const manualBudgetPromotionStatus = manualBudgetPromotionGate(health.manualBudget);
    const selectorGate = getSelectorReadinessGate(normalized.input);
    const taskFileGate = getTaskFileSnapshotGate(normalized.input);
    const selectorCalibrationCheck = latestSelectorCalibrationCheck();
    const sessionCheck = latestDianxiaomiSessionCheck();
    const browserProfileCheck = unattendedBrowserProfileStartupCheck(health.profile);
    const runnableWorkItems = health.workItems.ready
        + health.workItems.autoRetryCandidates
        + health.workItems.browserRecoveryCandidates
        + health.workItems.releasedBrowserRecoveryCandidates;
    const taskFileSnapshotRequired = health.workItems.ready > 0 || health.workItems.autoRetryCandidates > 0;
    const checks = [
        {
            id: "ready-work-items",
            label: "ready 商品",
            status: runnableWorkItems > 0 ? "pass" : "block",
            message: runnableWorkItems > 0
                ? `${health.workItems.ready} 个 ready 商品、${health.workItems.autoRetryCandidates} 个安全重试候选、${health.workItems.browserRecoveryCandidates} 个浏览器恢复候选、${health.workItems.releasedBrowserRecoveryCandidates} 个已释放重试候选`
                : "没有可自动化的店小秘商品"
        },
        {
            id: "selector-config",
            label: "选择器配置",
            status: selectorGate.selectorReady ? "pass" : "block",
            message: selectorGate.selectorReady ? "选择器配置有效" : selectorBlockReason(selectorGate.selectorBlockers),
            details: selectorGate.selectorValidation.issues.map((issue) => `${issue.level}: ${issue.message}`)
        },
        selectorCalibrationCheck,
        sessionCheck,
        {
            id: "task-file-snapshot",
            label: "task file snapshot",
            status: !taskFileSnapshotRequired || taskFileGate.ready ? "pass" : "block",
            message: taskFileSnapshotRequired
                ? taskFileGate.reason
                : "browser recovery exports fresh task files and repair plans at runtime",
            details: taskFileSnapshotRequired ? taskFileGate.details : []
        },
        browserProfileCheck,
        {
            id: "failure-budget",
            label: "failure budget",
            status: health.queue.consecutiveFailures >= health.queue.maxConsecutiveFailures ? "block" : health.queue.consecutiveFailures > 0 ? "warning" : "pass",
            message: `consecutive failures ${health.queue.consecutiveFailures}/${health.queue.maxConsecutiveFailures}`
        },
        {
            id: "blocked-backlog",
            label: "blocked backlog",
            status: health.workItems.blocked > 0 || health.flows.recentFailures > 0 ? "warning" : "pass",
            message: `${health.workItems.blocked} blocked work item(s), ${health.flows.recentFailures} recent failed flow(s)`
        },
        {
            id: "manual-budget-promotion-gate",
            label: "manual-step promotion validation",
            status: manualBudgetPromotionStatus.status,
            message: manualBudgetPromotionStatus.message,
            details: manualBudgetPromotionStatus.details
        }
    ];
    const status = startupStatus(checks);
    const runbook = [
        `Run selector calibration on a current real Dianxiaomi listing edit page, confirm target surface is real-dianxiaomi, and rerun it when older than ${formatDurationCompact(getRealCalibrationStaleMs())}.`,
        "If the latest queue run or diagnosis hit Dianxiaomi login/CAPTCHA, reopen the automation browser profile, finish the challenge, then capture a fresh real-page diagnosis before resuming unattended mode.",
        "Configure and initialize a persistent logged-in Dianxiaomi browser profile before unattended startup; the profile directory must already exist and have no active lock files.",
        "Use queue daemon health to clear profile locks, blocked work items, or repeated failures before restarting.",
        "Daily unattended mode can submit saved Dianxiaomi drafts into the Temu pricing review stage after real-page calibration passes.",
        "Temu/platform pricing confirmation and final listing approval remain manual."
    ];
    return {
        checkedAt: new Date().toISOString(),
        status,
        canStart: status !== "blocked",
        recommendedAction: status === "blocked"
            ? "请先解决被阻塞的启动检查项，再启动无人值守队列"
            : status === "warning"
                ? "队列可以启动，但请先查看警告项"
                : "队列已就绪，可以启动",
        checks,
        health,
        normalizedInput: normalized.input,
        runbook
    };
};
const getAutomationJobLog = (mode, id, maxChars = 4000) => {
    const job = getAutomationJob(mode, id);
    if (!job) {
        return null;
    }
    const stdout = readLogTail(job.logPath, maxChars);
    const stderr = readLogTail(job.errorLogPath, maxChars);
    return {
        id,
        logPath: job.logPath,
        errorLogPath: job.errorLogPath,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: {
            stdout: stdout.truncated,
            stderr: stderr.truncated
        }
    };
};
const formatFullFlowFailureReason = (job) => {
    const failedStage = job.stages.find((stage) => stage.status === "failed");
    return [
        job.error,
        failedStage ? `${failedStage.name}: ${failedStage.error ?? failedStage.reportStatus ?? "failed"}` : null
    ].filter(Boolean).join("; ") || "unknown automation full-flow failure";
};
const summarizeReportFailureStep = (report) => {
    const failedStep = report?.steps.find((step) => step.status === "failed") ?? null;
    if (!failedStep) {
        return null;
    }
    const mediaTools = failedStep.id === "media-processing-plan" && Array.isArray(failedStep.data?.tools)
        ? failedStep.data.tools
        : [];
    const failedMediaTool = mediaTools.find((tool) => ["open-failed", "apply-failed", "return-failed", "blocked-by-media-failure"].includes(String(tool.status ?? "")));
    if (failedMediaTool) {
        const label = String(failedMediaTool.label ?? failedMediaTool.id ?? "media tool");
        const failureKind = String(failedMediaTool.failureKind ?? "unknown");
        const retryable = failedMediaTool.retryable === true;
        const feedback = String(failedMediaTool.feedbackMessage ?? failedMediaTool.error ?? failedMediaTool.reason ?? "");
        const imageCheckIssues = Array.isArray(failedMediaTool.imageCheckIssues)
            ? failedMediaTool.imageCheckIssues
                .map((issue) => `${String(issue.category ?? "").trim()}:${String(issue.issue ?? "").trim()}`)
                .filter(Boolean)
                .join(", ")
            : "";
        return [
            `${failedStep.id}: ${label} failed`,
            `failureKind=${failureKind}`,
            `retryable=${retryable}`,
            imageCheckIssues ? `imageCheckIssues=${imageCheckIssues}` : null,
            feedback
        ].filter(Boolean).join("; ");
    }
    return `${failedStep.id}: ${failedStep.detail}`;
};
const readString = (value) => typeof value === "string" ? value : null;
const readPositiveNumber = (value, fallback = 0) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
const normalizeMediaToolKey = (value) => (readString(value) ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
const inferCompletedMediaToolKey = (tool) => {
    const candidates = [
        tool?.id,
        tool?.configKey,
        tool?.label,
        tool?.reason
    ]
        .map(normalizeMediaToolKey)
        .filter(Boolean);
    for (const candidate of candidates) {
        if (["image-translation", "imagetranslation"].includes(candidate) || candidate.includes("translation")) {
            return "image-translation";
        }
        if (["white-background", "whitebackground"].includes(candidate) || candidate.includes("white-background")) {
            return "white-background";
        }
        if (["image-editor", "xiaomi-image-editor", "imageeditor"].includes(candidate) || candidate.includes("image-editor")) {
            return "image-editor";
        }
        if (["batch-resize", "batchresize"].includes(candidate) || candidate.includes("resize")) {
            return "batch-resize";
        }
        if (["image-management", "imagemanagement"].includes(candidate) || candidate.includes("image-management")) {
            return "image-management";
        }
    }
    return null;
};
const isCompletedMediaToolApplied = (tool) => tool?.applied === true
    || normalizeMediaToolKey(tool?.status) === "applied";
const COMPLETED_MEDIA_SIGNAL_BY_TOOL = {
    "image-translation": "image translation",
    "white-background": "white background",
    "image-editor": "Xiaomi image editor",
    "batch-resize": "batch resize",
    "image-management": "image check"
};
const MEDIA_SIGNAL_PRIORITY = [
    "image translation",
    "batch resize",
    "white background",
    "Xiaomi image editor",
    "image check"
];
export const collectDianxiaomiSnapshotEnrichmentFromReports = (reportPaths) => {
    const mediaSignals = new Set();
    let imageCheckPassed = false;
    const imageCheckIssues = [];
    for (const reportPath of reportPaths) {
        const report = readAutomationExecutionReport(reportPath);
        if (!report) {
            continue;
        }
        for (const step of Array.isArray(report.steps) ? report.steps : []) {
            if (step?.id !== "media-processing-plan") {
                continue;
            }
            const tools = Array.isArray(step.data?.tools) ? step.data.tools : [];
            for (const tool of tools) {
                const key = inferCompletedMediaToolKey(tool);
                if (key === "image-management" && Array.isArray(tool.imageCheckIssues)) {
                    imageCheckIssues.push(...tool.imageCheckIssues
                        .filter((issue) => issue && typeof issue === "object")
                        .map((issue) => ({
                        category: String(issue.category ?? "").trim(),
                        issue: String(issue.issue ?? "").trim(),
                        detail: typeof issue.detail === "string" ? issue.detail.trim() : undefined
                    }))
                        .filter((issue) => issue.category && issue.issue));
                }
                if (!isCompletedMediaToolApplied(tool)) {
                    continue;
                }
                if (!key) {
                    continue;
                }
                const signal = COMPLETED_MEDIA_SIGNAL_BY_TOOL[key];
                if (signal) {
                    mediaSignals.add(signal);
                }
                if (key === "image-management") {
                    imageCheckPassed = true;
                }
            }
        }
    }
    const orderedSignals = MEDIA_SIGNAL_PRIORITY.filter((signal) => mediaSignals.has(signal));
    if (!orderedSignals.length && !imageCheckPassed && imageCheckIssues.length === 0) {
        return null;
    }
    const dedupedImageCheckIssues = imageCheckIssues.filter((issue, index, items) => items.findIndex((candidate) => candidate.category === issue.category
        && candidate.issue === issue.issue
        && candidate.detail === issue.detail) === index);
    return {
        mediaToolSignals: orderedSignals,
        imageCheck: imageCheckPassed || dedupedImageCheckIssues.length > 0
            ? {
                passed: imageCheckPassed,
                ...(dedupedImageCheckIssues.length > 0 ? {
                    issues: dedupedImageCheckIssues
                } : {})
            }
            : undefined
    };
};
const getSubmitListingStage = (job) => job.stages.find((stage) => stage.name === "submit-listing") ?? null;
const getSubmitListingStep = (report) => report?.steps.find((step) => step.id === "submit-listing") ?? null;
const isVerifiedSubmitAttemptSuccess = (attempt) => Boolean(attempt
    && typeof attempt === "object"
    && attempt.state === "success");
// The adapter's edit.json-verified verdict: the acceptance toast (「产品已提交
// 发布…」) trips the failure-keyword matcher, so the last attempt's state can
// read "failure" even when the submission registered and the publish state was
// verified via edit.json. Trust the polled verdict over the toast parse.
const isEditJsonVerifiedPublishOutcome = (data) => Boolean(data
    && typeof data === "object"
    && data.submissionAccepted === true
    && data.publishOutcome
    && typeof data.publishOutcome === "object"
    && data.publishOutcome.verdict === "no-fail-detected");
const getPublishOutcomeRoute = (status, diagnosis) => {
    if (status === "not-attempted") {
        return "not-attempted";
    }
    if (status === "succeeded") {
        return "published";
    }
    if (diagnosis?.autoRetryRecommended) {
        return "auto-retry";
    }
    if (diagnosis && ["publish-validation", "media-processing", "task-file", "browser-profile"].includes(diagnosis.category)) {
        return "browser-recovery";
    }
    return "manual-budget";
};
export const buildDianxiaomiPublishOutcomeForFullFlow = (job, failureDiagnosis = null) => {
    const submitStage = getSubmitListingStage(job);
    if (!submitStage) {
        return null;
    }
    const report = readAutomationExecutionReport(submitStage.reportPath);
    const submitStep = getSubmitListingStep(report);
    const data = submitStep?.data ?? {};
    const attemptRecords = Array.isArray(data.attempts) ? data.attempts : [];
    const attempts = attemptRecords.length;
    const maxAttempts = readPositiveNumber(data.maxAttempts, attempts);
    const verified = data.verified === true;
    const lastAttempt = attemptRecords[attemptRecords.length - 1];
    const success = data.success === true
        && verified
        && (isVerifiedSubmitAttemptSuccess(lastAttempt) || isEditJsonVerifiedPublishOutcome(data));
    const status = submitStage.status === "pending" || submitStage.status === "skipped"
        ? "not-attempted"
        : success
            ? "succeeded"
            : "failed";
    const failureReason = status === "failed"
        ? readString(data.failureReason) ?? submitStep?.detail ?? submitStage.error ?? null
        : null;
    const message = status === "succeeded"
        ? submitStep?.detail ?? "Dianxiaomi submit succeeded."
        : status === "failed"
            ? failureReason ?? "Dianxiaomi submit failed."
            : "Dianxiaomi submit was not attempted.";
    return {
        status,
        checkedAt: new Date().toISOString(),
        flowJobId: job.id,
        submitStageJobId: submitStage.jobId,
        reportPath: submitStage.reportPath,
        attempts,
        maxAttempts,
        message,
        failureReason,
        route: getPublishOutcomeRoute(status, failureDiagnosis)
    };
};
const formatFullFlowFailureDiagnosisReason = (job) => {
    const failedStage = job.stages.find((stage) => stage.status === "failed");
    const reportFailure = summarizeReportFailureStep(readAutomationExecutionReport(failedStage?.reportPath ?? null));
    return [
        job.error,
        failedStage ? `${failedStage.name}: ${failedStage.error ?? failedStage.reportStatus ?? "failed"}` : null,
        reportFailure
    ].filter(Boolean).join("; ") || "unknown automation full-flow failure";
};
const resolveFullFlowWorkItemOutcome = (job, source = "full-flow") => {
    if (!job.workItemId || job.status === "running") {
        return null;
    }
    // P1-5: clear the in-flight flag the moment the full-flow job
    // resolves. Done before the persistence side-effects so a crash in
    // updateDianxiaomiProductWorkItemStatus still releases the lock.
    clearWorkItemInFlight(job.workItemId);
    const snapshotEnrichment = collectDianxiaomiSnapshotEnrichmentFromReports(collectFullFlowReportPaths(job));
    if (snapshotEnrichment) {
        mergeDianxiaomiProductWorkItemSnapshot(job.workItemId, snapshotEnrichment);
    }
    const publishOutcome = buildDianxiaomiPublishOutcomeForFullFlow(job, null);
    const publishFailureReason = publishOutcome?.status === "failed"
        ? publishOutcome.failureReason ?? publishOutcome.message
        : null;
    const failureReason = job.status === "failed"
        ? formatFullFlowFailureDiagnosisReason(job)
        : publishFailureReason;
    const failureDiagnosis = failureReason ? classifyDianxiaomiWorkFailure(failureReason, source) : null;
    const finalPublishOutcome: DianxiaomiPublishOutcome | null = publishOutcome
        ? {
            ...publishOutcome,
            status: publishOutcome.status as DianxiaomiPublishOutcome["status"],
            route: getPublishOutcomeRoute(publishOutcome.status, failureDiagnosis)
        }
        : null;
    const note = !failureReason
        ? `automation full-flow completed: ${job.id}`
        : `automation full-flow failed: ${failureReason} (${job.id})`;
    if (!resolvedFullFlowWorkItemIds.has(job.id)) {
        updateDianxiaomiProductWorkItemStatus(job.workItemId, failureReason ? "blocked" : "edited", note, failureDiagnosis, finalPublishOutcome);
        resolvedFullFlowWorkItemIds.add(job.id);
    }
    return {
        failureReason,
        note
    };
};
const collectFullFlowReportPaths = (job) => job.stages.map((stage) => stage.reportPath).filter((reportPath) => Boolean(reportPath));
const buildManualBudgetTrialFlowOutcome = (flowJobId) => {
    const job = fullFlowJobs.get(flowJobId);
    if (!job) {
        return {
            flowJobId,
            workItemId: null,
            status: "missing",
            finishedAt: null,
            reportPaths: [],
            failureReason: "full-flow job no longer exists"
        };
    }
    return {
        flowJobId,
        workItemId: job.workItemId ?? null,
        status: job.status,
        finishedAt: job.finishedAt,
        reportPaths: collectFullFlowReportPaths(job),
        failureReason: job.status === "failed" ? formatFullFlowFailureDiagnosisReason(job) : null
    };
};
const findManualBudgetTrialProofRecord = (trialId) => manualBudgetProofLedger.find((proof) => proof.recordedBy === "manual-budget-trial"
    && proof.evidence.includes(`trial ${trialId}`)) ?? null;
const recordManualBudgetTrialProof = (trial, flowOutcomes, automationMeasurement) => {
    const proposal = trial.proposal;
    if (!proposal) {
        return null;
    }
    const duplicate = trial.outcome.proofRecordId
        ? manualBudgetProofLedger.find((proof) => proof.id === trial.outcome.proofRecordId) ?? null
        : findManualBudgetTrialProofRecord(trial.id);
    if (duplicate) {
        return cloneManualBudgetProofRecord(duplicate);
    }
    const baselineProof = manualBudgetProofLedger.find((proof) => proof.id === proposal.proofRecordId);
    const completed = Math.max(1, flowOutcomes.filter((outcome) => outcome.status === "completed").length);
    const baseline = baselineProof?.baseline ?? {
        productCount: Math.max(1, proposal.trialSize),
        operatorClicks: Math.max(1, proposal.trialSize),
        operatorDecisions: Math.max(1, proposal.trialSize)
    };
    return recordManualBudgetProof({
        candidateKey: proposal.candidateKey,
        source: proposal.source,
        reason: proposal.reason,
        replacementPlan: proposal.replacementPlan,
        baseline,
        trial: {
            productCount: completed,
            operatorClicks: 0,
            operatorDecisions: 0,
            status: "passed"
        },
        evidence: [
            `bounded manual-budget trial request: trial ${trial.id}`,
            `flows ${trial.flowJobIds.join(", ")}`,
            `work items ${flowOutcomes.map((outcome) => outcome.workItemId).filter(Boolean).join(", ") || "unknown"}`,
            "trial ran unattended with zero operator clicks and zero operator decisions",
            automationMeasurement
                ? `automation reports measured ${automationMeasurement.browserClicks} browser clicks and ${automationMeasurement.browserActions} browser actions across ${automationMeasurement.reportCount} reports`
                : "automation report measurement was unavailable for this trial"
        ].join("; "),
        automationMeasurement,
        recordedBy: "manual-budget-trial"
    });
};
const refreshManualBudgetTrialOutcome = (trialId) => {
    const existing = manualBudgetTrialHistory.find((trial) => trial.id === trialId);
    if (!existing || existing.status !== "started") {
        return existing ? cloneManualBudgetTrialRecord(existing) : null;
    }
    const flowOutcomes = existing.flowJobIds.map(buildManualBudgetTrialFlowOutcome);
    const completed = flowOutcomes.filter((outcome) => outcome.status === "completed").length;
    const failed = flowOutcomes.filter((outcome) => outcome.status === "failed").length;
    const running = flowOutcomes.filter((outcome) => outcome.status === "running").length;
    const missing = flowOutcomes.filter((outcome) => outcome.status === "missing").length;
    const reportPaths = flowOutcomes.flatMap((outcome) => outcome.reportPaths);
    const automationMeasurement = measureAutomationReports(reportPaths);
    const now = new Date().toISOString();
    const resolvedAt = running > 0 ? null : now;
    const status = running > 0
        ? "running"
        : failed > 0 || missing > 0 || completed !== existing.flowJobIds.length
            ? "failed"
            : "passed";
    const proofRecord = status === "passed"
        ? recordManualBudgetTrialProof(existing, flowOutcomes, automationMeasurement)
        : null;
    const message = status === "running"
        ? `bounded trial still running ${running}/${existing.flowJobIds.length} full-flow job(s)`
        : status === "passed"
            ? `bounded trial passed ${completed}/${existing.flowJobIds.length} full-flow job(s)`
            : `bounded trial failed: completed ${completed}, failed ${failed}, missing ${missing}`;
    return saveManualBudgetTrialRecord({
        ...existing,
        updatedAt: now,
        outcome: {
            status,
            resolvedAt,
            message,
            completed,
            failed,
            running,
            missing,
            proofRecordId: proofRecord?.id ?? existing.outcome.proofRecordId ?? null,
            automationMeasurement,
            flowOutcomes
        }
    });
};
function refreshRunningManualBudgetTrialOutcomes() {
    const trialIds = manualBudgetTrialHistory
        .filter((trial) => trial.status === "started"
        && trial.outcome.status === "running"
        && trial.flowJobIds.some((flowJobId) => {
            const job = fullFlowJobs.get(flowJobId);
            return !job || job.status !== "running";
        }))
        .map((trial) => trial.id);
    for (const trialId of trialIds) {
        refreshManualBudgetTrialOutcome(trialId);
    }
}
const refreshManualBudgetTrialOutcomesForFlow = (flowJobId) => {
    for (const trial of manualBudgetTrialHistory) {
        if (trial.flowJobIds.includes(flowJobId)) {
            refreshManualBudgetTrialOutcome(trial.id);
        }
    }
};
const isDianxiaomiWorkItemAutoRetryCandidate = (item) => item.status === "blocked"
    && item.requirements.summary.ready
    && (item.publishOutcome?.status !== "failed"
        || item.publishOutcome.route === "auto-retry")
    && ((item.publishOutcome?.status === "failed"
        && item.publishOutcome.route === "auto-retry")
        || item.failureDiagnosis?.autoRetryRecommended === true
        || (item.repairPlan?.status === "auto-ready"
            && item.repairPlan.canAutoRepair === true
            && item.repairPlan.actions.length > 0
            && item.repairPlan.actions.some((action) => ["refresh-task-file", "retry-transient"].includes(action.type))
            && item.repairPlan.actions.every((action) => action.automation === "auto"
                && ["refresh-task-file", "retry-transient", "apply-media-tool"].includes(action.type))))
    && validateDianxiaomiAutomationPageUrl(item.pageUrl).valid;
const isDianxiaomiWorkItemBrowserRecoveryRouteAllowed = (item) => item.publishOutcome?.status !== "failed"
    || item.publishOutcome.route === "browser-recovery";
const browserExecutableRepairWriters = new Set([
    "fill-single-field",
    "fill-attributes",
    "fill-sku-pricing",
    "run-media-tool"
]);
const isDianxiaomiWorkItemBrowserRecoveryCandidate = (item) => item.status === "blocked"
    && item.requirements.summary.ready
    && isDianxiaomiWorkItemBrowserRecoveryRouteAllowed(item)
    && validateDianxiaomiAutomationPageUrl(item.pageUrl).valid
    && item.repairPlan?.status === "auto-ready"
    && item.repairPlan.canAutoRepair === true
    && item.repairPlan.actions.length > 0
    && item.repairPlan.actions.some((action) => action.automation === "auto"
        && Boolean(action.payload?.writer)
        && browserExecutableRepairWriters.has(action.payload?.writer ?? ""))
    && item.repairPlan.actions.every((action) => action.automation === "auto"
        && (action.payload?.writer
            ? browserExecutableRepairWriters.has(action.payload.writer)
            : action.required === false));
const getDianxiaomiBrowserRecoveryBlockReason = (item) => {
    if (item.status !== "blocked") {
        return "work item is not blocked";
    }
    if (!isDianxiaomiWorkItemBrowserRecoveryRouteAllowed(item)) {
        return `publish outcome route is ${item.publishOutcome?.route ?? "unknown"}, not browser-recovery`;
    }
    const pageUrlValidation = validateDianxiaomiAutomationPageUrl(item.pageUrl);
    if (!pageUrlValidation.valid) {
        return pageUrlValidation.reason ?? "work item URL is not a valid Dianxiaomi listing edit page";
    }
    if (!item.requirements.summary.ready) {
        return "work item still fails required listing checks";
    }
    if (!item.repairPlan) {
        return "work item has no repair plan";
    }
    if (item.repairPlan.status !== "auto-ready" || item.repairPlan.canAutoRepair !== true) {
        return `repair plan is ${item.repairPlan.status}, not auto-ready`;
    }
    if (item.repairPlan.actions.length === 0) {
        return "repair plan has no actions";
    }
    const nonAutoAction = item.repairPlan.actions.find((action) => action.automation !== "auto");
    if (nonAutoAction) {
        return `repair action is not automatic: ${nonAutoAction.id}`;
    }
    const requiredNonBrowserAction = item.repairPlan.actions.find((action) => action.required
        && (!action.payload?.writer || !browserExecutableRepairWriters.has(action.payload.writer)));
    if (requiredNonBrowserAction) {
        return `required repair action is not browser-executable in recovery loop: ${requiredNonBrowserAction.payload?.writer ?? requiredNonBrowserAction.type}`;
    }
    const unsupportedPayloadAction = item.repairPlan.actions.find((action) => action.payload?.writer && !browserExecutableRepairWriters.has(action.payload.writer));
    if (unsupportedPayloadAction) {
        return `repair action writer is not supported in recovery loop: ${unsupportedPayloadAction.payload?.writer}`;
    }
    return null;
};
const getDianxiaomiAutoRecoveryReleaseLabel = (item) => item.publishOutcome?.status === "failed" && item.publishOutcome.route === "auto-retry"
    ? `publish outcome auto retry released: ${item.publishOutcome.failureReason ?? item.publishOutcome.message}`
    : item.failureDiagnosis?.autoRetryRecommended === true
        ? `auto retry released: ${item.failureDiagnosis?.category ?? "unknown"}`
        : `auto repair released: ${item.repairPlan?.summary ?? item.failureDiagnosis?.category ?? "unknown"}`;
const releaseAutoRetryDianxiaomiWorkItems = (input: AutomationDryRunStartInput = {}) => {
    const released = [];
    for (const item of listScopedDianxiaomiProductWorkItems(input)) {
        if (!isDianxiaomiWorkItemAutoRetryCandidate(item) || isDianxiaomiWorkItemBrowserRecoveryCandidate(item)) {
            continue;
        }
        const updated = updateDianxiaomiProductWorkItemStatus(item.id, "ready-for-automation", getDianxiaomiAutoRecoveryReleaseLabel(item));
        if (updated) {
            released.push(item.id);
        }
    }
    return released;
};
// Failure classification was extracted to ./automation-runner-failure-classification;
// re-exported here to preserve this module public API.
import { classifyDianxiaomiWorkFailure } from "./automation-runner-failure-classification";
export { classifyDianxiaomiWorkFailure };
export const startDianxiaomiDryRun = (input: AutomationDryRunStartInput = {}) => startAutomationJob("dry-run", input);
export const listDianxiaomiDryRunJobs = (limit = 20) => listAutomationJobs("dry-run", limit);
export const getDianxiaomiDryRunJob = (id) => getAutomationJob("dry-run", id);
export const getDianxiaomiDryRunJobLog = (id, maxChars = 4000) => getAutomationJobLog("dry-run", id, maxChars);
export const startDianxiaomiRepairPreview = (input: AutomationDryRunStartInput = {}) => startAutomationJob("repair-preview", input);
export const startDianxiaomiRepairPreviewForWorkItem = (workItemId: string, input: AutomationDryRunStartInput = {}) => {
    const exported = exportDianxiaomiRepairPreview(workItemId);
    if (!exported) {
        return null;
    }
    const result = startDianxiaomiRepairPreview({
        ...input,
        url: input.url ?? exported.workItem.pageUrl,
        taskFile: input.taskFile ?? exported.taskFile,
        repairPlanFile: input.repairPlanFile ?? exported.repairPlanFile
    });
    const job = repairPreviewJobs.get(result.id);
    if (job) {
        repairPreviewJobs.set(result.id, {
            ...job,
            workItemId,
            taskFile: exported.taskFile,
            repairPlanFile: exported.repairPlanFile
        });
    }
    return {
        ...result,
        workItemId,
        taskFile: exported.taskFile,
        repairPlanFile: exported.repairPlanFile
    };
};
export const listDianxiaomiRepairPreviewJobs = (limit = 20) => listAutomationJobs("repair-preview", limit);
export const getDianxiaomiRepairPreviewJob = (id) => getAutomationJob("repair-preview", id);
export const getDianxiaomiRepairPreviewJobLog = (id, maxChars = 4000) => getAutomationJobLog("repair-preview", id, maxChars);
export const startDianxiaomiRepairApply = (input: AutomationDryRunStartInput = {}) => startAutomationJob("repair-apply", input);
export const startDianxiaomiRepairApplyForWorkItem = (workItemId: string, input: AutomationDryRunStartInput = {}) => {
    const exported = exportDianxiaomiRepairPreview(workItemId);
    if (!exported) {
        return null;
    }
    const result = startDianxiaomiRepairApply({
        ...input,
        url: input.url ?? exported.workItem.pageUrl,
        taskFile: input.taskFile ?? exported.taskFile,
        repairPlanFile: input.repairPlanFile ?? exported.repairPlanFile
    });
    const job = repairApplyJobs.get(result.id);
    if (job) {
        repairApplyJobs.set(result.id, {
            ...job,
            workItemId,
            taskFile: exported.taskFile,
            repairPlanFile: exported.repairPlanFile
        });
    }
    return {
        ...result,
        workItemId,
        taskFile: exported.taskFile,
        repairPlanFile: exported.repairPlanFile
    };
};
export const listDianxiaomiRepairApplyJobs = (limit = 20) => listAutomationJobs("repair-apply", limit);
export const getDianxiaomiRepairApplyJob = (id) => getAutomationJob("repair-apply", id);
export const getDianxiaomiRepairApplyJobLog = (id, maxChars = 4000) => getAutomationJobLog("repair-apply", id, maxChars);
export const startDianxiaomiFillDraft = (input: AutomationDryRunStartInput = {}) => startAutomationJob("fill-draft", input);
export const listDianxiaomiFillDraftJobs = (limit = 20) => listAutomationJobs("fill-draft", limit);
export const getDianxiaomiFillDraftJob = (id) => getAutomationJob("fill-draft", id);
export const getDianxiaomiFillDraftJobLog = (id, maxChars = 4000) => getAutomationJobLog("fill-draft", id, maxChars);
export const startDianxiaomiSaveDraft = (input: AutomationDryRunStartInput = {}) => startAutomationJob("save-draft", input);
export const listDianxiaomiSaveDraftJobs = (limit = 20) => listAutomationJobs("save-draft", limit);
export const getDianxiaomiSaveDraftJob = (id) => getAutomationJob("save-draft", id);
export const getDianxiaomiSaveDraftJobLog = (id, maxChars = 4000) => getAutomationJobLog("save-draft", id, maxChars);
export const startDianxiaomiSubmitListing = (input: AutomationDryRunStartInput = {}) => startAutomationJob("submit-listing", input);
export const listDianxiaomiSubmitListingJobs = (limit = 20) => listAutomationJobs("submit-listing", limit);
export const getDianxiaomiSubmitListingJob = (id) => getAutomationJob("submit-listing", id);
export const getDianxiaomiSubmitListingJobLog = (id, maxChars = 4000) => getAutomationJobLog("submit-listing", id, maxChars);
const createFullFlowStage = (name) => ({
    name,
    status: "pending",
    jobId: null,
    reportPath: null,
    reportStatus: null,
    startedAt: null,
    finishedAt: null,
    error: null
});
const setFullFlowJob = (id, updater) => {
    const current = fullFlowJobs.get(id);
    if (current) {
        fullFlowJobs.set(id, updater(current));
    }
};
const updateFullFlowStage = (flowId, stageName, patch) => {
    setFullFlowJob(flowId, (job) => ({
        ...job,
        stages: job.stages.map((stage) => stage.name === stageName ? { ...stage, ...patch } : stage)
    }));
};
const runFullFlowStage = async (flowId, mode, input) => {
  const targetFingerprint = buildAutomationTargetFingerprint(input);
  const stageInput = mode === "submit-listing"
        ? {
            ...input,
            skipDraftFill: true
        }
        : input;
    updateFullFlowStage(flowId, mode, {
        status: "running",
        startedAt: new Date().toISOString(),
        error: null
    });
    releaseTargetLock(targetFingerprint, flowId);
    const started = startAutomationJob(mode, stageInput);
    runningTargetLocks.set(targetFingerprint, flowId);
    updateFullFlowStage(flowId, mode, {
        jobId: started.id
    });
    const job = await waitForAutomationJob(mode, started.id, getAutomationJobTimeoutMs(mode));
    updateFullFlowStage(flowId, mode, {
        status: job.status,
        finishedAt: job.finishedAt,
        reportPath: job.reportPath,
        reportStatus: job.reportStatus,
        error: job.error
    });
    if (!isSuccessfulJob(job)) {
        throw new Error(`${mode} failed: ${job.error ?? job.reportStatus ?? job.exitCode ?? "unknown error"}`);
    }
    return job;
};
const runFullFlow = async (id) => {
    const job = fullFlowJobs.get(id);
    if (!job) {
        return;
    }
    let lockedProfilePath: string | null = null;
    try {
        lockedProfilePath = await acquireFullFlowProfileLock(job.input.profile, id);
        await runFullFlowStage(id, "dry-run", job.input);
        if (job.input.repairPlanFile) {
            await runFullFlowStage(id, "repair-preview", job.input);
        }
        await runFullFlowStage(id, "fill-draft", job.input);
        await runFullFlowStage(id, "save-draft", job.input);
        if (job.input.submitAfterSave) {
            await runFullFlowStage(id, "submit-listing", job.input);
        }
        setFullFlowJob(id, (current) => ({
            ...current,
            status: "completed",
            finishedAt: new Date().toISOString(),
            error: null
        }));
        const completedJob = fullFlowJobs.get(id);
        if (completedJob) {
            resolveFullFlowWorkItemOutcome(completedJob, "full-flow");
            refreshManualBudgetTrialOutcomesForFlow(completedJob.id);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFullFlowJob(id, (current) => ({
            ...current,
            status: "failed",
            finishedAt: new Date().toISOString(),
            error: message
        }));
        const failedJob = fullFlowJobs.get(id);
        if (failedJob) {
            resolveFullFlowWorkItemOutcome(failedJob, "full-flow");
            refreshManualBudgetTrialOutcomesForFlow(failedJob.id);
        }
    }
    finally {
        releaseTargetLock(job.targetFingerprint, id);
        releaseFullFlowProfileLock(lockedProfilePath, id);
    }
};
export const startDianxiaomiFullFlow = (input: AutomationDryRunStartInput = {}, metadata: Record<string, any> = {}) => {
    const normalizedInput = applyAutomationMediaDefaults(normalizeAutomationStartInput(input), "unattended-apply");
    const targetFingerprint = buildAutomationTargetFingerprint(normalizedInput);
    if (getRunningTargetJobId(targetFingerprint)) {
        throw new AutomationSafetyGateError(`target already has a running automation job: ${getRunningTargetJobId(targetFingerprint)}`);
    }
    const id = `automation-full-flow-${timestampId()}`;
    runningTargetLocks.set(targetFingerprint, id);
    const artifactDir = normalizedInput.screenshots?.trim() || buildJobArtifactDir(id);
    const effectiveInput = {
        ...normalizedInput,
        screenshots: artifactDir
    };
    const result = {
        id,
        startedAt: new Date().toISOString(),
        targetFingerprint,
        artifactDir
    };
    fullFlowJobs.set(id, {
        ...result,
        status: "running",
        finishedAt: null,
        error: null,
        input: effectiveInput,
        source: metadata.source ?? "direct",
        workItemId: metadata.workItemId ?? null,
        taskId: metadata.taskId ?? null,
        taskFile: metadata.taskFile ?? effectiveInput.taskFile ?? null,
        stages: [
            createFullFlowStage("dry-run"),
            ...(effectiveInput.repairPlanFile ? [createFullFlowStage("repair-preview")] : []),
            createFullFlowStage("fill-draft"),
            createFullFlowStage("save-draft"),
            ...(effectiveInput.submitAfterSave ? [createFullFlowStage("submit-listing")] : [])
        ]
    });
    void runFullFlow(id);
    return result;
};
export const listDianxiaomiFullFlowJobs = (limit = 20) => Array.from(fullFlowJobs.values())
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit);
export const getDianxiaomiFullFlowJob = (id) => fullFlowJobs.get(id) ?? null;
// P0-G: if the last N (default 3) full-flow jobs all failed with
// `write-blocked-wrong-surface`, the active selector config is the suspect.
// Restore the previous selector config version so the next tick has a
// known-good baseline. Returns a structured rollback event for the audit
// trail; the caller (queue-run) surfaces it on the dashboard.
//
// This is intentionally narrow: only `write-blocked-wrong-surface` qualifies,
// so transient network / media / publish failures cannot trigger a rollback.
// It also requires at least 2 selector config versions to exist (so we have
// something to roll back TO).
const AUTO_ROLLBACK_BLOCKING_STEP_ID = "write-blocked-wrong-surface"

// P1-14: a full-flow failure counts toward auto-rollback when the failed
// report shows a SELECTOR regression, not a content/value problem. These are:
//   - target-surface failed (page not recognized as an edit surface)
//   - write-blocked-* (fill/save/submit refused because surface invalid)
//   - fill-<field> failed with "字段" / "field" not found (selector miss)
//   - write-verify-failed-* (P0-E: wrote but DOM value didn't take — usually
//     a wrong selector pointing at the wrong input)
// A publish-validation failure about a MISSING VALUE (e.g. "missing required
// attribute Color") is NOT a selector problem and must not trigger rollback.
const isFullFlowSurfaceFailure = (job) => {
    const failedStage = job?.stages?.find((stage) => stage.status === "failed")
    if (!failedStage?.reportPath) {
        return false
    }
    try {
        const report = JSON.parse(readFileSync(failedStage.reportPath, "utf8"))
        const steps = Array.isArray(report?.steps) ? report.steps : []
        const failedStep = steps.find((step) => step?.id === "target-surface" && step?.status === "failed")
        if (failedStep) {
            return true
        }
        // Downstream write-block step added when target-surface is unrecognized.
        const writeBlocked = steps.find((step) => step?.id?.startsWith("write-blocked-") && step?.status === "failed")
        if (writeBlocked) {
            return true
        }
        // P1-14: write-verify failure (P0-E) — the value was written but the DOM
        // value did not match, which points at a stale/wrong field selector.
        const writeVerifyFailed = steps.find((step) => step?.id?.startsWith("write-verify-failed-") && step?.status === "failed")
        if (writeVerifyFailed) {
            return true
        }
        // P1-14: a fill-<field> step that failed because the field selector was
        // not found ("未找到字段" / "field missing"). Distinguish from value
        // problems by requiring the not-found wording.
        const fillSelectorMiss = steps.find((step) =>
            typeof step?.id === "string"
            && step.id.startsWith("fill-")
            && step.status === "failed"
            && typeof step.detail === "string"
            && /未找到字段|field missing|field not found|未找到属性字段/i.test(step.detail))
        return Boolean(fillSelectorMiss)
    } catch {
        return false
    }
}

const maybeAutoRollbackBadSelectorConfig = (consecutiveThreshold = 3) => {
    const recent = listDianxiaomiFullFlowJobs(consecutiveThreshold)
    if (recent.length < consecutiveThreshold) {
        return null
    }
    if (!recent.every((job) => job.status === "failed" && isFullFlowSurfaceFailure(job))) {
        return null
    }
    // versions are sorted newest first; pick the second-newest so we restore
    // the version BEFORE the most recent (suspect) save.
    const versions = getSelectorConfigVersions(20)
    if (versions.length < 2) {
        return null
    }
    const targetVersion = versions[1]
    const restored = restoreSelectorConfigVersion(targetVersion.id, { confirmDangerousChanges: true })
    if (!restored) {
        return null
    }
    return {
        reason: `${consecutiveThreshold} consecutive full-flow jobs failed with a selector regression (target-surface / write-blocked / write-verify / field-not-found)`,
      restoredVersionId: targetVersion.id,
      restoredAt: targetVersion.createdAt,
      jobIds: recent.map((job) => job.id)
    }
}

// P1-4: walk every ready work item, recompute pricing when rules changed or
// drafts went stale, and persist the result. Returns a small audit summary
// the caller can surface on the dashboard.
const refreshStalePricingForReadyWorkItems = (input: AutomationDryRunStartInput = {}) => {
    const items = listScopedDianxiaomiProductWorkItems(input)
    const refreshed: Array<{ workItemId: string; reason: string }> = []
    for (const item of items) {
        if (item.status !== "ready-for-automation") {
            continue
        }
        // P1-4: only recompute pricing for items that ALREADY have a task.
        // Never create a task here — creating one re-touches the work item
        // (bumping updatedAt and selection order), which would let the
        // pricing-refresh pass change which item the queue picks.
        const task = findTaskByDianxiaomiWorkItemId(item.id)
        if (!task) {
            continue
        }
        const result = recomputeDraftPricingIfStale(task)
        if (result.recomputed) {
            persistPlannerState()
            refreshed.push({ workItemId: item.id, reason: result.reason })
        }
    }
    return {
        refreshedCount: refreshed.length,
        refreshedItemIds: refreshed.map((entry) => entry.workItemId),
        refreshed
    }
}

export const startDianxiaomiQueueRun = (input: any = {}, options: Record<string, any> = {}) => {
    const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 5)));
    const startedAt = new Date().toISOString();
    const id = `automation-queue-run-${timestampId()}`;
    const storeScope = getAutomationStoreScope(input);
    const itemScope = getAutomationItemScope(input);
    // P0-G: if the last few full-flow jobs all failed with the same selector
    // problem, the new selector config is the suspect. Roll it back to the
    // previous version so the next tick has a known-good baseline. This is
    // intentionally narrow: only `write-blocked-wrong-surface` qualifies, so
    // transient network / media / publish failures cannot trigger a rollback.
    const selectorRollback = maybeAutoRollbackBadSelectorConfig(3);
    // P1-4: refresh stale pricing on every ready work item before selecting.
    // This catches operators who changed pricing rules (rulesHash mismatch)
    // or whose drafts are older than 6 hours. The audit trail records
    // how many items were recomputed.
    const pricingRefresh = refreshStalePricingForReadyWorkItems(input);
    const autoRetryReleasedIds = options.releasedAutoRetryIds
        ?? (options.releaseAutoRetry === false ? [] : releaseAutoRetryDianxiaomiWorkItems(input));
    const readyItems = listScopedDianxiaomiProductWorkItems(input)
        .filter((item) =>
            item.status === "ready-for-automation"
            // P0-B: skip items that already completed a successful Dianxiaomi submit.
            // Defends against race conditions where full-flow success has not yet
            // promoted the item to `edited` (or the status flip raced with a tick).
            && item.publishOutcome?.route !== "published"
            // P1-5: skip items that another automation path is currently running.
            // This blocks concurrent queue-run / recovery-run / manual-trial
            // triggers from picking the same item twice.
            && !inFlightWorkItemIds.has(item.id)
        )
        .slice(0, limit);
    const flowJobIds = [];
    const skippedItems = [];
    const { limit: _limit, ...flowInput } = input;
    for (const workItem of readyItems) {
        const pageUrlValidation = validateDianxiaomiAutomationPageUrl(workItem.pageUrl);
        if (!pageUrlValidation.valid) {
            const reason = pageUrlValidation.reason ?? "invalid Dianxiaomi page URL";
            skippedItems.push({
                workItemId: workItem.id,
                reason
            });
            updateDianxiaomiProductWorkItemStatus(workItem.id, "blocked", `automation queue skipped: ${reason}`, classifyDianxiaomiWorkFailure(reason, "queue-daemon"));
            continue;
        }
        const repairPlan = workItem.repairPlan;
        const taskFileRead = readAutomationTaskFile(input.taskFile);
        const repairExport = repairPlan
            ? input.taskFile?.trim() && taskFileRead.task && !taskFileRead.error
                ? exportFallbackRepairPreviewFile(workItem, taskFileRead)
                : exportDianxiaomiRepairPreview(workItem.id)
            : null;
        const taskResult = repairExport
            ? null
            : createTaskFromDianxiaomiProductWorkItem(workItem.id);
        if (!repairExport && !taskResult) {
            const reason = "could not create automation task from work item";
            skippedItems.push({
                workItemId: workItem.id,
                reason
            });
            updateDianxiaomiProductWorkItemStatus(workItem.id, "blocked", `automation queue skipped: ${reason}`, classifyDianxiaomiWorkFailure(reason, "queue-daemon"));
            continue;
        }
        const taskExport = repairExport
            ? {
                taskFile: repairExport.taskFile,
                absolutePath: repairExport.absoluteTaskFile
            }
            : taskResult
                ? exportTaskFile(taskResult.task.id)
                : null;
        if (!taskExport) {
            const reason = "could not export automation task file";
            skippedItems.push({
                workItemId: workItem.id,
                reason
            });
            updateDianxiaomiProductWorkItemStatus(workItem.id, "blocked", `automation queue skipped: ${reason}`, classifyDianxiaomiWorkFailure(reason, "queue-daemon"));
            continue;
        }
        try {
            const taskId = repairExport?.task.id ?? taskResult?.task.id ?? null;
            // P1-5: mark this work item as in-flight before the full-flow
            // job starts so a concurrent queue / recovery / manual-trial
            // trigger cannot double-pick it. The flag is cleared when the
            // full-flow job resolves (in resolveFullFlowWorkItemOutcome).
            markWorkItemInFlight(workItem.id);
            const flow = startDianxiaomiFullFlow({
                ...flowInput,
                url: input.url ?? workItem.pageUrl,
                taskFile: taskExport.taskFile,
                repairPlanFile: input.repairPlanFile ?? repairExport?.repairPlanFile,
                mediaAutomationMode: input.mediaAutomationMode ?? "unattended-apply"
            }, {
                workItemId: workItem.id,
                taskId,
                taskFile: taskExport.taskFile,
                source: "queue-run"
            });
            flowJobIds.push(flow.id);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            skippedItems.push({
                workItemId: workItem.id,
                reason
            });
            updateDianxiaomiProductWorkItemStatus(workItem.id, "blocked", `automation queue skipped: ${reason}`, classifyDianxiaomiWorkFailure(reason, "queue-daemon"));
        }
    }
    const result = {
        id,
        startedAt,
        storeId: storeScope.storeId,
        storeName: storeScope.storeName,
        itemUrls: itemScope.itemUrls.length > 0 ? itemScope.itemUrls : undefined,
        sourceBuckets: itemScope.sourceBuckets.length > 0 ? itemScope.sourceBuckets : undefined,
        limit,
        queued: flowJobIds.length,
        skipped: skippedItems.length,
        autoRetryReleasedIds,
        flowJobIds,
        skippedItems,
        // P0-G: surfaces the auto-rollback event (if any) so the dashboard's
        // audit card can show what changed before this tick ran.
        selectorRollback,
        // P1-4: surfaces how many work items had their pricing recomputed
        // before this tick.
        pricingRefresh
    };
    queueRunHistory.unshift(result);
    queueRunHistory.splice(50);
    return result;
};
export const listDianxiaomiQueueRuns = (limit = 20) => queueRunHistory.slice(0, limit);
const cloneRecoveryRunItem = (item) => ({
    ...item
});
const cloneRecoveryRun = (run) => ({
    ...run,
    input: {
        ...run.input,
        mediaAutomationTools: run.input.mediaAutomationTools ? [...run.input.mediaAutomationTools] : undefined,
        itemUrls: run.input.itemUrls ? [...run.input.itemUrls] : undefined,
        sourceBuckets: run.input.sourceBuckets ? [...run.input.sourceBuckets] : undefined,
        workItemIds: run.input.workItemIds ? [...run.input.workItemIds] : undefined
    },
    items: run.items.map(cloneRecoveryRunItem)
});
const normalizeRecoveryRunItem = (item, fallbackStartedAt) => ({
    workItemId: typeof item.workItemId === "string" && item.workItemId.trim() ? item.workItemId : "unknown-work-item",
    title: typeof item.title === "string" && item.title.trim() ? item.title : typeof item.workItemId === "string" ? item.workItemId : "unknown work item",
    status: [
        "skipped",
        "repair-preview-running",
        "repair-preview-failed",
        "repair-apply-running",
        "repair-apply-failed",
        "full-flow-running",
        "completed",
        "failed"
    ].includes(String(item.status)) ? item.status : "failed",
    reason: typeof item.reason === "string" ? item.reason : null,
    repairPreviewJobId: typeof item.repairPreviewJobId === "string" ? item.repairPreviewJobId : null,
    repairApplyJobId: typeof item.repairApplyJobId === "string" ? item.repairApplyJobId : null,
    fullFlowJobId: typeof item.fullFlowJobId === "string" ? item.fullFlowJobId : null,
    taskFile: typeof item.taskFile === "string" ? item.taskFile : null,
    repairPlanFile: typeof item.repairPlanFile === "string" ? item.repairPlanFile : null,
    startedAt: typeof item.startedAt === "string" ? item.startedAt : fallbackStartedAt,
    finishedAt: typeof item.finishedAt === "string" ? item.finishedAt : null
});
const summarizeRecoveryRun = (run) => {
    const skipped = run.items.filter((item) => item.status === "skipped").length;
    const completed = run.items.filter((item) => item.status === "completed").length;
    const failed = run.items.filter((item) => item.status === "failed"
        || item.status === "repair-preview-failed"
        || item.status === "repair-apply-failed").length;
    return {
        ...run,
        queued: run.items.length - skipped,
        skipped,
        completed,
        failed
    };
};
const normalizeRecoveryRun = (run) => {
    if (typeof run.id !== "string" || !run.id.trim()) {
        return null;
    }
    const startedAt = typeof run.startedAt === "string" ? run.startedAt : new Date().toISOString();
    const wasRunning = run.status === "running";
    const status = run.status === "completed" || run.status === "failed" ? run.status : "failed";
    return summarizeRecoveryRun({
        id: run.id,
        startedAt,
        finishedAt: typeof run.finishedAt === "string" ? run.finishedAt : startedAt,
        status,
        limit: clampInteger(run.limit, 5, 1, 20),
        input: {
            ...(run.input ?? {}),
            recoveryPolicy: run.input?.recoveryPolicy === "released-retry" ? "released-retry" : "normal",
            workItemIds: Array.isArray(run.input?.workItemIds)
                ? run.input.workItemIds.filter((id) => typeof id === "string")
                : undefined
        },
        queued: 0,
        skipped: 0,
        completed: 0,
        failed: 0,
        items: Array.isArray(run.items)
            ? run.items.map((item) => {
                const normalized = normalizeRecoveryRunItem(item, startedAt);
                if (!wasRunning
                    || !["repair-preview-running", "repair-apply-running", "full-flow-running"].includes(normalized.status)) {
                    return normalized;
                }
                return {
                    ...normalized,
                    status: "failed",
                    reason: normalized.reason ?? "server restored before recovery run finished",
                    finishedAt: normalized.finishedAt ?? startedAt
                };
            })
            : []
    });
};
const normalizeRecoveryRelease = (release) => {
    if (typeof release.key !== "string" || !release.key.trim()) {
        return null;
    }
    if (release.kind !== "work-item" && release.kind !== "repair-action") {
        return null;
    }
    const releaseType = release.releaseType === "repair-plan-regenerated" || release.releaseType === "selector-recalibrated"
        ? release.releaseType
        : "work-item-updated";
    const now = new Date().toISOString();
    return {
        key: release.key,
        kind: release.kind,
        count: clampInteger(release.count, 1, 1, 1000),
        workItemId: typeof release.workItemId === "string" ? release.workItemId : null,
        title: typeof release.title === "string" ? release.title : null,
        repairAction: typeof release.repairAction === "string" ? release.repairAction : null,
        latestRunId: typeof release.latestRunId === "string" ? release.latestRunId : "unknown-recovery-run",
        latestFailureAt: typeof release.latestFailureAt === "string" ? release.latestFailureAt : now,
        latestReason: typeof release.latestReason === "string" ? release.latestReason : null,
        releasedAt: typeof release.releasedAt === "string" ? release.releasedAt : now,
        releaseEventAt: typeof release.releaseEventAt === "string" ? release.releaseEventAt : now,
        releaseType,
        releaseReason: typeof release.releaseReason === "string" ? release.releaseReason : releaseType
    };
};
const persistRecoveryRunHistory = () => {
    const historyPath = getRecoveryRunHistoryPath();
    mkdirSync(path.dirname(historyPath), {
        recursive: true
    });
    const runs = listDianxiaomiRecoveryRuns(RECOVERY_RUN_HISTORY_LIMIT);
    writeFileSync(historyPath, JSON.stringify({
        runs,
        releases: recoveryReleases.slice(0, RECOVERY_RELEASE_HISTORY_LIMIT)
    }, null, 2), "utf8");
};
const loadRecoveryRunHistory = () => {
    const historyPath = getRecoveryRunHistoryPath();
    if (!existsSync(historyPath)) {
        return;
    }
    try {
        const parsed = JSON.parse(readFileSync(historyPath, "utf8"));
        recoveryRuns.clear();
        recoveryReleases = [];
        const runs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.runs) ? parsed.runs : [];
        const releases = Array.isArray(parsed) ? [] : Array.isArray(parsed.releases) ? parsed.releases : [];
        for (const run of runs.map(normalizeRecoveryRun).filter((item) => Boolean(item))) {
            recoveryRuns.set(run.id, run);
        }
        recoveryReleases = releases
            .map(normalizeRecoveryRelease)
            .filter((item) => Boolean(item))
            .sort((left, right) => right.releasedAt.localeCompare(left.releasedAt))
            .slice(0, RECOVERY_RELEASE_HISTORY_LIMIT);
    }
    catch {
        recoveryRuns.clear();
        recoveryReleases = [];
    }
};
const recoveryFailedStatuses = new Set([
    "repair-preview-failed",
    "repair-apply-failed",
    "failed"
]);
const repairActionLabelsForWorkItem = (workItemId) => {
    const workItem = listDianxiaomiProductWorkItems(Number.MAX_SAFE_INTEGER)
        .find((item) => item.id === workItemId);
    const actions = workItem?.repairPlan?.actions ?? [];
    return repairActionLabelsForActions(actions);
};
const repairActionLabelsForActions = (actions) => Array.from(new Set(actions
    .filter((action) => action.automation === "auto")
    .map((action) => [
    action.payload?.writer ?? action.type,
    action.payload?.fieldKind ?? action.field,
    action.payload?.attributeKey ?? action.target,
    action.payload?.mediaTool ?? action.tool
].filter(Boolean).join(":"))
    .filter(Boolean)));
const latestRecoveryReleaseAt = () => {
    const latestCalibration = latestSelectorCalibrationCheck();
    const latestCalibrationAt = latestCalibration.status !== "block" && latestCalibration.details
        ? latestCalibration.details
            .map((detail) => /^diagnosis: (.+)$/.exec(detail)?.[1] ?? null)
            .find((value) => Boolean(value))
        : null;
    return latestCalibrationAt ?? null;
};
const collectRecoveryFailureSummaries = () => {
    const summaries = new Map();
    const runs = listDianxiaomiRecoveryRuns(RECOVERY_RUN_HISTORY_LIMIT);
    const register = (summary) => {
        const current = summaries.get(summary.key);
        if (!current) {
            summaries.set(summary.key, {
                ...summary,
                count: 1
            });
            return;
        }
        current.count += 1;
        if (summary.latestFailureAt.localeCompare(current.latestFailureAt) > 0) {
            current.latestRunId = summary.latestRunId;
            current.latestFailureAt = summary.latestFailureAt;
            current.latestReason = summary.latestReason;
            current.title = summary.title;
        }
    };
    for (const run of runs) {
        for (const item of run.items) {
            if (!recoveryFailedStatuses.has(item.status)) {
                continue;
            }
            const latestFailureAt = item.finishedAt ?? run.finishedAt ?? item.startedAt ?? run.startedAt;
            register({
                key: `work-item:${item.workItemId}`,
                kind: "work-item",
                workItemId: item.workItemId,
                title: item.title,
                repairAction: null,
                latestRunId: run.id,
                latestFailureAt,
                latestReason: item.reason
            });
            for (const repairAction of repairActionLabelsForWorkItem(item.workItemId)) {
                register({
                    key: `repair-action:${repairAction}`,
                    kind: "repair-action",
                    workItemId: null,
                    title: null,
                    repairAction,
                    latestRunId: run.id,
                    latestFailureAt,
                    latestReason: item.reason
                });
            }
        }
    }
    return Array.from(summaries.values())
        .filter((summary) => summary.count >= RECOVERY_FAILURE_ALERT_THRESHOLD)
        .sort((left, right) => {
        if (right.count !== left.count) {
            return right.count - left.count;
        }
        return right.latestFailureAt.localeCompare(left.latestFailureAt);
    })
        .slice(0, 5);
};
const isAfterRecoveryFailure = (value, failure) => Boolean(value && value.localeCompare(failure.latestFailureAt) > 0);
const hasSpentRecoveryReleaseEvent = (failure, release) => recoveryReleases.some((existing) => existing.key === failure.key
    && existing.releaseEventAt === release.releaseEventAt
    && existing.releaseType === release.releaseType
    && existing.releasedAt.localeCompare(failure.latestFailureAt) <= 0);
const unspentRecoveryRelease = (failure, release) => hasSpentRecoveryReleaseEvent(failure, release) ? null : release;
const recoveryReleaseForFailure = (item, failure) => {
    if (isAfterRecoveryFailure(item.repairPlan?.createdAt, failure)) {
        return unspentRecoveryRelease(failure, {
            releaseEventAt: item.repairPlan.createdAt,
            releaseType: "repair-plan-regenerated",
            releaseReason: "repair plan regenerated after repeated recovery failure"
        });
    }
    if (isAfterRecoveryFailure(item.updatedAt, failure)) {
        return unspentRecoveryRelease(failure, {
            releaseEventAt: item.updatedAt,
            releaseType: "work-item-updated",
            releaseReason: "Dianxiaomi work item updated after repeated recovery failure"
        });
    }
    const selectorCalibrationAt = latestRecoveryReleaseAt();
    if (failure.kind === "repair-action" && isAfterRecoveryFailure(selectorCalibrationAt, failure)) {
        return unspentRecoveryRelease(failure, {
            releaseEventAt: selectorCalibrationAt,
            releaseType: "selector-recalibrated",
            releaseReason: "real selector/media calibration rerun after repeated repair-action failure"
        });
    }
    return null;
};
const recordRecoveryRelease = (failure, release) => {
    const existing = recoveryReleases.find((item) => item.key === failure.key
        && item.latestFailureAt === failure.latestFailureAt
        && item.releaseEventAt === release.releaseEventAt
        && item.releaseType === release.releaseType);
    if (existing) {
        return;
    }
    recoveryReleases = [{
            ...failure,
            ...release,
            releasedAt: new Date().toISOString()
        }, ...recoveryReleases].slice(0, RECOVERY_RELEASE_HISTORY_LIMIT);
    persistRecoveryRunHistory();
};
const recoveryPauseForWorkItem = (item, failureSummaries = collectRecoveryFailureSummaries()) => {
    const actionLabels = repairActionLabelsForActions(item.repairPlan?.actions ?? []);
    const matchingFailures = failureSummaries.filter((failure) => {
        if (failure.kind === "work-item") {
            return failure.workItemId === item.id;
        }
        return typeof failure.repairAction === "string" && actionLabels.includes(failure.repairAction);
    });
    for (const matchingFailure of matchingFailures) {
        // P1-13: hard cumulative cap. Once a work item / repair action has
        // failed recovery RECOVERY_MAX_CUMULATIVE_ATTEMPTS times, a release
        // event can no longer un-pause it — it must go to the manual-step
        // budget. This prevents an item from bouncing through the
        // released-retry lane indefinitely on repeated one-use release
        // events.
        const capped = (matchingFailure.count ?? 0) >= RECOVERY_MAX_CUMULATIVE_ATTEMPTS;
        if (!capped) {
            const release = recoveryReleaseForFailure(item, matchingFailure);
            if (release) {
                recordRecoveryRelease(matchingFailure, release);
                continue;
            }
        }
        return {
            ...matchingFailure,
            cappedByAttemptLimit: capped,
            pausedUntil: capped
                ? "manual-step-budget"
                : matchingFailure.kind === "repair-action" ? "selector-recalibrated" : "work-item-updated",
            releaseReason: capped
                ? `recovery attempt cap reached (${matchingFailure.count}/${RECOVERY_MAX_CUMULATIVE_ATTEMPTS}); move this item to the manual-step budget and resolve it by hand`
                : matchingFailure.kind === "repair-action"
                    ? "rerun real Dianxiaomi selector/media calibration or regenerate the repair plan"
                    : "update the Dianxiaomi product or regenerate its repair plan before another automatic recovery attempt"
        };
    }
    return null;
};
const isDianxiaomiWorkItemBrowserRecoveryPaused = (item, failureSummaries = collectRecoveryFailureSummaries()) => Boolean(recoveryPauseForWorkItem(item, failureSummaries));
const recordReleasedRecoveryPauses = (items, failureSummaries) => {
    for (const item of items) {
        const actionLabels = repairActionLabelsForActions(item.repairPlan?.actions ?? []);
        const matchingFailures = failureSummaries.filter((failure) => (failure.kind === "work-item" && failure.workItemId === item.id)
            || (failure.kind === "repair-action" && typeof failure.repairAction === "string" && actionLabels.includes(failure.repairAction)));
        for (const failure of matchingFailures) {
            const release = recoveryReleaseForFailure(item, failure);
            if (release) {
                recordRecoveryRelease(failure, release);
            }
        }
    }
};
const recoveryReleaseMatchesWorkItem = (release, item) => {
    if (release.kind === "work-item") {
        return release.workItemId === item.id;
    }
    if (typeof release.repairAction !== "string") {
        return false;
    }
    return repairActionLabelsForActions(item.repairPlan?.actions ?? []).includes(release.repairAction);
};
const recoveryReleasesForWorkItem = (item) => recoveryReleases
    .filter((release) => recoveryReleaseMatchesWorkItem(release, item))
    .sort((left, right) => right.releasedAt.localeCompare(left.releasedAt));
const releasedRetryCandidateForWorkItem = (item) => {
    const releases = recoveryReleasesForWorkItem(item);
    if (releases.length === 0) {
        return null;
    }
    const releaseTypes = Array.from(new Set(releases.map((release) => release.releaseType)));
    const latest = releases[0];
    return {
        workItemId: item.id,
        title: item.title,
        releaseKeys: Array.from(new Set(releases.map((release) => release.key))).slice(0, 10),
        releaseTypes,
        latestReleaseAt: latest.releasedAt,
        releaseReason: latest.releaseReason
    };
};
const buildReleasedRetryBatchPolicy = (candidates, normalBrowserRecoveryCandidateCount) => ({
    policy: "released-retry",
    maxItemsPerTick: RECOVERY_RELEASED_RETRY_BATCH_LIMIT,
    pendingCount: candidates.length,
    normalRecoveryHeld: candidates.length > 0 && normalBrowserRecoveryCandidateCount > 0,
    nextWorkItemIds: candidates
        .slice(0, RECOVERY_RELEASED_RETRY_BATCH_LIMIT)
        .map((candidate) => candidate.workItemId),
    detail: candidates.length > 0
        ? `Released retry is bounded to ${RECOVERY_RELEASED_RETRY_BATCH_LIMIT} item(s) per daemon tick before normal browser recovery continues.`
        : "No released retry candidates are pending; normal browser recovery can run when eligible."
});
const releasedRetryOutcomeForItem = (run, item, failureSummaries) => {
    const workItem = listDianxiaomiProductWorkItems(Number.MAX_SAFE_INTEGER)
        .find((candidate) => candidate.id === item.workItemId);
    if (["repair-preview-running", "repair-apply-running", "full-flow-running"].includes(item.status)) {
        return {
            runId: run.id,
            workItemId: item.workItemId,
            title: item.title,
            status: item.status,
            finishedAt: item.finishedAt,
            reason: item.reason,
            nextState: "running",
            nextAction: "released retry is still running"
        };
    }
    if (item.status === "completed") {
        return {
            runId: run.id,
            workItemId: item.workItemId,
            title: item.title,
            status: item.status,
            finishedAt: item.finishedAt,
            reason: item.reason,
            nextState: "completed",
            nextAction: "no recovery action needed; Dianxiaomi save/publish flow completed"
        };
    }
    if (!workItem) {
        return {
            runId: run.id,
            workItemId: item.workItemId,
            title: item.title,
            status: item.status,
            finishedAt: item.finishedAt,
            reason: item.reason,
            nextState: "not-recoverable",
            nextAction: "work item no longer exists"
        };
    }
    if (workItem.status !== "blocked") {
        return {
            runId: run.id,
            workItemId: item.workItemId,
            title: item.title,
            status: item.status,
            finishedAt: item.finishedAt,
            reason: item.reason,
            nextState: "not-recoverable",
            nextAction: `work item is ${workItem.status}`
        };
    }
    const pause = recoveryPauseForWorkItem(workItem, failureSummaries);
    if (pause) {
        return {
            runId: run.id,
            workItemId: item.workItemId,
            title: item.title,
            status: item.status,
            finishedAt: item.finishedAt,
            reason: item.reason,
            nextState: "repaused",
            nextAction: pause.releaseReason
        };
    }
    if (releasedRetryCandidateForWorkItem(workItem)) {
        return {
            runId: run.id,
            workItemId: item.workItemId,
            title: item.title,
            status: item.status,
            finishedAt: item.finishedAt,
            reason: item.reason,
            nextState: "released-pending",
            nextAction: "daemon will retry one released recovery item per tick"
        };
    }
    if (isDianxiaomiWorkItemBrowserRecoveryCandidate(workItem)) {
        return {
            runId: run.id,
            workItemId: item.workItemId,
            title: item.title,
            status: item.status,
            finishedAt: item.finishedAt,
            reason: item.reason,
            nextState: "normal-recovery",
            nextAction: "item is eligible for normal browser recovery"
        };
    }
    return {
        runId: run.id,
        workItemId: item.workItemId,
        title: item.title,
        status: item.status,
        finishedAt: item.finishedAt,
        reason: item.reason,
        nextState: "not-recoverable",
        nextAction: getDianxiaomiBrowserRecoveryBlockReason(workItem) ?? "item is not eligible for browser recovery"
    };
};
const collectReleasedRetryOutcomes = (failureSummaries) => listDianxiaomiRecoveryRuns(RECOVERY_RUN_HISTORY_LIMIT)
    .filter((run) => run.input.recoveryPolicy === "released-retry")
    .flatMap((run) => run.items.map((item) => releasedRetryOutcomeForItem(run, item, failureSummaries)))
    .sort((left, right) => (right.finishedAt ?? "").localeCompare(left.finishedAt ?? ""))
    .slice(0, 10);
const setRecoveryRun = (id, updater) => {
    const current = recoveryRuns.get(id);
    if (!current) {
        return;
    }
    recoveryRuns.set(id, summarizeRecoveryRun(updater(current)));
    persistRecoveryRunHistory();
};
const updateRecoveryRunItem = (runId, workItemId, patch) => {
    setRecoveryRun(runId, (run) => ({
        ...run,
        items: run.items.map((item) => item.workItemId === workItemId ? { ...item, ...patch } : item)
    }));
};
const failRecoveryRunItem = (runId, workItemId, status, reason) => {
    updateRecoveryRunItem(runId, workItemId, {
        status,
        reason,
        finishedAt: new Date().toISOString()
    });
};
const runDianxiaomiRecoveryRun = async (id) => {
    const run = recoveryRuns.get(id);
    if (!run) {
        return;
    }
    const { limit: _limit, workItemIds: _workItemIds, repairPlanFile: _repairPlanFile, ...flowInput } = run.input;
    for (const item of run.items) {
        if (item.status === "skipped") {
            continue;
        }
        const workItem = listDianxiaomiProductWorkItems(Number.MAX_SAFE_INTEGER)
            .find((candidate) => candidate.id === item.workItemId);
        if (!workItem) {
            failRecoveryRunItem(id, item.workItemId, "failed", "work item no longer exists");
            continue;
        }
        if (!matchesAutomationStoreScope(workItem, run.input)) {
            failRecoveryRunItem(id, item.workItemId, "failed", "work item is outside selected store scope");
            continue;
        }
        const exported = exportDianxiaomiRepairPreview(workItem.id);
        if (!exported) {
            failRecoveryRunItem(id, item.workItemId, "failed", "could not export repair task and plan");
            continue;
        }
        const baseInput = {
            ...flowInput,
            url: flowInput.url ?? workItem.pageUrl,
            taskFile: exported.taskFile,
            repairPlanFile: exported.repairPlanFile,
            mediaAutomationMode: flowInput.mediaAutomationMode ?? "unattended-apply"
        };
        updateRecoveryRunItem(id, workItem.id, {
            status: "repair-preview-running",
            taskFile: exported.taskFile,
            repairPlanFile: exported.repairPlanFile
        });
        try {
            const previewStarted = startDianxiaomiRepairPreview(baseInput);
            updateRecoveryRunItem(id, workItem.id, {
                repairPreviewJobId: previewStarted.id
            });
            const previewJob = await waitForAutomationJob("repair-preview", previewStarted.id);
            if (!isSuccessfulJob(previewJob)) {
                failRecoveryRunItem(id, workItem.id, "repair-preview-failed", previewJob.error ?? previewJob.reportStatus ?? `repair-preview exit ${previewJob.exitCode}`);
                continue;
            }
            updateRecoveryRunItem(id, workItem.id, {
                status: "repair-apply-running"
            });
            const applyStarted = startDianxiaomiRepairApply(baseInput);
            updateRecoveryRunItem(id, workItem.id, {
                repairApplyJobId: applyStarted.id
            });
            const applyJob = await waitForAutomationJob("repair-apply", applyStarted.id);
            if (!isSuccessfulJob(applyJob)) {
                failRecoveryRunItem(id, workItem.id, "repair-apply-failed", applyJob.error ?? applyJob.reportStatus ?? `repair-apply exit ${applyJob.exitCode}`);
                continue;
            }
            const fullFlowInput = {
                ...flowInput,
                url: flowInput.url ?? workItem.pageUrl,
                taskFile: exported.taskFile,
                repairPlanFile: undefined,
                mediaAutomationMode: flowInput.mediaAutomationMode ?? "unattended-apply",
                submitAfterSave: flowInput.submitAfterSave ?? true
            };
            updateRecoveryRunItem(id, workItem.id, {
                status: "full-flow-running"
            });
            const fullFlow = startDianxiaomiFullFlow(fullFlowInput, {
                workItemId: workItem.id,
                taskId: exported.task.id,
                taskFile: exported.taskFile,
                source: "recovery-run"
            });
            updateRecoveryRunItem(id, workItem.id, {
                fullFlowJobId: fullFlow.id
            });
            const fullFlowJob = await waitForFullFlowJob(fullFlow.id);
            if (fullFlowJob.status !== "completed") {
                failRecoveryRunItem(id, workItem.id, "failed", fullFlowJob.error ?? "full-flow failed after repair");
                continue;
            }
            updateRecoveryRunItem(id, workItem.id, {
                status: "completed",
                reason: "repair-preview, repair-apply, and full-flow completed",
                finishedAt: new Date().toISOString()
            });
            recordManualBudgetProofFromRecoveryTrial({
                workItemId: workItem.id,
                recoveryRunId: id,
                recoveryStatus: "completed",
                repairPreviewJobId: previewStarted.id,
                repairApplyJobId: applyStarted.id,
                fullFlowJobId: fullFlow.id
            });
        }
        catch (error) {
            failRecoveryRunItem(id, workItem.id, "failed", error instanceof Error ? error.message : String(error));
        }
    }
    setRecoveryRun(id, (current) => ({
        ...current,
        status: current.items.some((item) => item.status === "failed"
            || item.status === "repair-preview-failed"
            || item.status === "repair-apply-failed") ? "failed" : "completed",
        finishedAt: new Date().toISOString()
    }));
};
export const startDianxiaomiRecoveryRun = (input: any = {}) => {
    const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 5)));
    const selectedIds = new Set((input.workItemIds ?? []).map((id) => id.trim()).filter(Boolean));
    const allWorkItems = listDianxiaomiProductWorkItems(Number.MAX_SAFE_INTEGER);
    const scopedWorkItems = filterItemsByAutomationStoreScope(allWorkItems, input);
    const requestedItems = selectedIds.size > 0
        ? [...selectedIds].map((id) => {
            const workItem = allWorkItems.find((item) => item.id === id);
            if (!workItem) {
                return {
                    kind: "missing",
                    workItemId: id,
                    title: id,
                    reason: "work item not found"
                };
            }
            if (!matchesAutomationStoreScope(workItem, input)) {
                return {
                    kind: "out-of-scope",
                    workItemId: id,
                    title: workItem.title ?? id,
                    reason: "work item is outside the selected store scope"
                };
            }
            return {
                kind: "work-item",
                workItem
            };
        })
        : scopedWorkItems.map((workItem) => ({
            kind: "work-item",
            workItem
        }));
    const items = requestedItems.slice(0, limit).map((candidate) => {
        if (candidate.kind !== "work-item") {
            return {
                workItemId: candidate.workItemId,
                title: candidate.title,
                status: "skipped",
                reason: candidate.reason,
                repairPreviewJobId: null,
                repairApplyJobId: null,
                fullFlowJobId: null,
                taskFile: null,
                repairPlanFile: null,
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString()
            };
        }
        const { workItem: candidateWorkItem } = candidate;
        const blockReason = getDianxiaomiBrowserRecoveryBlockReason(candidateWorkItem);
        return {
            workItemId: candidateWorkItem.id,
            title: candidateWorkItem.title,
            status: blockReason ? "skipped" : "repair-preview-running",
            reason: blockReason,
            repairPreviewJobId: null,
            repairApplyJobId: null,
            fullFlowJobId: null,
            taskFile: null,
            repairPlanFile: null,
            startedAt: new Date().toISOString(),
            finishedAt: blockReason ? new Date().toISOString() : null
        };
    });
    const id = `automation-recovery-run-${timestampId()}`;
    const run = summarizeRecoveryRun({
        id,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        status: "running",
        limit,
        input: {
            ...input,
            limit,
            recoveryPolicy: input.recoveryPolicy ?? "normal"
        },
        queued: 0,
        skipped: 0,
        completed: 0,
        failed: 0,
        items
    });
    recoveryRuns.set(id, run);
    persistRecoveryRunHistory();
    void runDianxiaomiRecoveryRun(id);
    return cloneRecoveryRun(run);
};
export const listDianxiaomiRecoveryRuns = (limit = 20) => Array.from(recoveryRuns.values())
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit)
    .map(cloneRecoveryRun);
export const getDianxiaomiRecoveryRun = (id) => {
    const run = recoveryRuns.get(id);
    return run ? cloneRecoveryRun(run) : null;
};
const cloneQueueDaemonFlowOutcome = (outcome) => ({
    ...outcome
});
const cloneQueueDaemonState = (state) => ({
    ...state,
    input: {
        ...state.input,
        mediaAutomationTools: state.input.mediaAutomationTools ? [...state.input.mediaAutomationTools] : undefined,
        itemUrls: state.input.itemUrls ? [...state.input.itemUrls] : undefined,
        sourceBuckets: state.input.sourceBuckets ? [...state.input.sourceBuckets] : undefined
    },
    trackedFlowJobIds: [...state.trackedFlowJobIds],
    resolvedFlowJobIds: [...state.resolvedFlowJobIds],
    flowOutcomes: state.flowOutcomes.map(cloneQueueDaemonFlowOutcome),
    ticks: state.ticks.map((tick) => ({
        ...tick,
        queueRun: tick.queueRun ? {
            ...tick.queueRun,
            autoRetryReleasedIds: [...(tick.queueRun.autoRetryReleasedIds ?? [])],
            itemUrls: tick.queueRun.itemUrls ? [...tick.queueRun.itemUrls] : undefined,
            sourceBuckets: tick.queueRun.sourceBuckets ? [...tick.queueRun.sourceBuckets] : undefined,
            flowJobIds: [...tick.queueRun.flowJobIds],
            skippedItems: tick.queueRun.skippedItems.map((item) => ({ ...item }))
        } : null,
        recoveryRun: tick.recoveryRun ? cloneRecoveryRun(tick.recoveryRun) : null,
        manualBudgetValidationRun: tick.manualBudgetValidationRun
            ? cloneManualBudgetTrialRecord(tick.manualBudgetValidationRun)
            : null,
        flowOutcomes: tick.flowOutcomes.map(cloneQueueDaemonFlowOutcome)
    }))
});
const persistQueueDaemonState = () => {
    const statePath = getQueueDaemonStatePath();
    mkdirSync(path.dirname(statePath), {
        recursive: true
    });
    const persisted = cloneQueueDaemonState({
        ...daemonStateHolder.current,
        running: false,
        nextRunAt: daemonStateHolder.current.status === "ACTIVE" ? daemonStateHolder.current.nextRunAt : null
    });
    writeFileSync(statePath, JSON.stringify(persisted, null, 2), "utf8");
};
const normalizeQueueDaemonState = (state) => {
    const fallback = defaultQueueDaemonState();
    const normalized = normalizeQueueDaemonInput(state.input ?? fallback.input);
    return {
        ...fallback,
        ...state,
        status: state.status === "ACTIVE" ? "ACTIVE" : "PAUSED",
        input: normalized.input,
        intervalSeconds: clampInteger(state.intervalSeconds, normalized.intervalSeconds, 15, 24 * 60 * 60),
        maxConsecutiveFailures: clampInteger(state.maxConsecutiveFailures, normalized.maxConsecutiveFailures, 1, 100),
        lastRecoveryRunId: state.lastRecoveryRunId ?? null,
        running: false,
        nextRunAt: null,
        trackedFlowJobIds: Array.isArray(state.trackedFlowJobIds) ? state.trackedFlowJobIds.filter((id) => typeof id === "string").slice(0, 500) : [],
        resolvedFlowJobIds: Array.isArray(state.resolvedFlowJobIds) ? state.resolvedFlowJobIds.filter((id) => typeof id === "string").slice(0, 500) : [],
        flowOutcomes: Array.isArray(state.flowOutcomes)
            ? state.flowOutcomes.slice(0, 100).map((outcome) => ({
                ...outcome,
                taskId: outcome.taskId ?? null,
                error: outcome.error ?? null
            }))
            : [],
        ticks: Array.isArray(state.ticks)
            ? state.ticks.slice(0, 50).map((tick) => ({
                ...tick,
                category: tick.category ?? (tick.status === "skipped" ? "daemon-paused" : tick.status === "failed" ? "system-error" : "idle-no-items"),
                queueRun: tick.queueRun ?? null,
                recoveryRun: tick.recoveryRun ?? null,
                manualBudgetValidationRun: tick.manualBudgetValidationRun
                    ? normalizeManualBudgetTrialRecord(tick.manualBudgetValidationRun) ?? null
                    : null,
                flowOutcomes: Array.isArray(tick.flowOutcomes) ? tick.flowOutcomes : []
            }))
            : []
    };
};
const loadQueueDaemonState = () => {
    const statePath = getQueueDaemonStatePath();
    if (!existsSync(statePath)) {
        return;
    }
    try {
        daemonStateHolder.current = normalizeQueueDaemonState(JSON.parse(readFileSync(statePath, "utf8")));
    }
    catch {
        daemonStateHolder.current = defaultQueueDaemonState();
    }
};
const loadAutomationRunnerRuntimeState = () => {
    loadRecoveryRunHistory();
    loadManualBudgetProofLedger();
    loadManualBudgetTrialHistory();
    loadProfileLockAuditLedger();
    loadQueueDaemonState();
};
const normalizeQueueDaemonInput = (input: Partial<AutomationQueueDaemonInput> = {}) => {
    const { intervalSeconds, maxConsecutiveFailures, ...queueInput } = input;
    const normalizedMediaInput = applyAutomationMediaDefaults(queueInput, "unattended-apply");
    const itemUrls = normalizeAutomationItemUrls(queueInput.itemUrls);
    const sourceBuckets = normalizeAutomationSourceBuckets(queueInput.sourceBuckets);
    return {
        input: {
            ...normalizedMediaInput,
            itemUrls: itemUrls.length > 0 ? itemUrls : undefined,
            sourceBuckets: sourceBuckets.length > 0 ? sourceBuckets : undefined,
            limit: clampInteger(queueInput.limit, 5, 1, 20),
            mediaAutomationMode: normalizedMediaInput.mediaAutomationMode ?? "unattended-apply",
            mediaAutomationTools: normalizedMediaInput.mediaAutomationTools,
            submitAfterSave: queueInput.submitAfterSave ?? false,
            submitMaxAttempts: clampInteger(queueInput.submitMaxAttempts, 3, 1, 10)
        } as AutomationQueueDaemonInput,
        intervalSeconds: clampInteger(intervalSeconds, 300, 15, 24 * 60 * 60),
        maxConsecutiveFailures: clampInteger(maxConsecutiveFailures, 3, 1, 100)
    };
};
const scheduleQueueDaemonNextRun = () => {
    if (daemonStateHolder.timer) {
        clearTimeout(daemonStateHolder.timer);
        daemonStateHolder.timer = null;
    }
    if (daemonStateHolder.current.status !== "ACTIVE") {
        daemonStateHolder.current = {
            ...daemonStateHolder.current,
            nextRunAt: null
        };
        persistQueueDaemonState();
        return;
    }
    const nextRunAt = new Date(Date.now() + daemonStateHolder.current.intervalSeconds * 1000).toISOString();
    daemonStateHolder.current = {
        ...daemonStateHolder.current,
        nextRunAt
    };
    daemonStateHolder.timer = setTimeout(() => {
        void tickDianxiaomiQueueDaemon();
    }, daemonStateHolder.current.intervalSeconds * 1000);
    persistQueueDaemonState();
};
const pushQueueDaemonTick = (tick) => {
    daemonStateHolder.current = {
        ...daemonStateHolder.current,
        ticks: [tick, ...daemonStateHolder.current.ticks].slice(0, 50)
    };
    persistQueueDaemonState();
    // P1-7: fire the alert webhook for "block" decisions so off-hours
    // operators can react without watching the dashboard.
    if (tick.decision === "block" || tick.status === "failed") {
        void fireAlertWebhook({
            decision: tick.decision ?? "block",
            reason: tick.reason ?? "queue daemon tick blocked",
            subject: tick.subject ?? null,
            workItemIds: tick.workItemIds ?? [],
            tickId: tick.id ?? null
        })
    }
};
const mergeQueueDaemonFlowJobIds = (nextIds) => Array.from(new Set([
    ...daemonStateHolder.current.trackedFlowJobIds,
    ...nextIds.filter((id) => id.trim())
])).slice(-500);
const trackQueueDaemonFlowJobs = (flowJobIds) => {
    if (flowJobIds.length === 0) {
        return;
    }
    daemonStateHolder.current = {
        ...daemonStateHolder.current,
        trackedFlowJobIds: mergeQueueDaemonFlowJobIds(flowJobIds)
    };
    persistQueueDaemonState();
};
const summarizeQueueDaemonFlowOutcomes = (outcomes) => {
    const completed = outcomes.filter((outcome) => outcome.status === "completed").length;
    const failed = outcomes.filter((outcome) => outcome.status === "failed").length;
    return `recovered ${outcomes.length} full-flow outcome(s): ${completed} completed, ${failed} failed`;
};
const recoverQueueDaemonFlowOutcomes = () => {
    const alreadyResolved = new Set(daemonStateHolder.current.resolvedFlowJobIds);
    const outcomes = [];
    for (const flowJobId of daemonStateHolder.current.trackedFlowJobIds) {
        if (alreadyResolved.has(flowJobId)) {
            continue;
        }
        const job = fullFlowJobs.get(flowJobId);
        if (!job || job.status === "running" || !job.workItemId) {
            continue;
        }
        const resolved = resolveFullFlowWorkItemOutcome(job, "queue-daemon");
        if (!resolved) {
            continue;
        }
        const outcome = {
            flowJobId: job.id,
            workItemId: job.workItemId,
            taskId: job.taskId ?? null,
            status: job.status,
            resolvedAt: new Date().toISOString(),
            note: resolved.note,
            error: resolved.failureReason
        };
        outcomes.push(outcome);
    }
    if (outcomes.length === 0) {
        return [];
    }
    daemonStateHolder.current = {
        ...daemonStateHolder.current,
        resolvedFlowJobIds: Array.from(new Set([
            ...daemonStateHolder.current.resolvedFlowJobIds,
            ...outcomes.map((outcome) => outcome.flowJobId)
        ])).slice(-500),
        flowOutcomes: [
            ...outcomes,
            ...daemonStateHolder.current.flowOutcomes
        ].slice(0, 100)
    };
    persistQueueDaemonState();
    return outcomes;
};
const classifyQueueDaemonSkippedReason = (reason) => {
    const normalized = reason.toLowerCase();
    if (normalized.includes("running automation job") || normalized.includes("already has a running")) {
        return "running-lock";
    }
    if (normalized.includes("selector config") || normalized.includes("selector")) {
        return "selector-blocked";
    }
    if (normalized.includes("export automation task file") || normalized.includes("task file")) {
        return "task-export-failed";
    }
    if (normalized.includes("target-surface") || normalized.includes("write-blocked-wrong-surface") || normalized.includes("listing edit surface")) {
        return "target-surface-blocked";
    }
    if (normalized.includes("repair-apply")) {
        return "repair-apply-failed";
    }
    if (normalized.includes("repair-preview")) {
        return "repair-preview-failed";
    }
    if (normalized.includes("login") || normalized.includes("captcha") || normalized.includes("验证码") || normalized.includes("登录")) {
        return "login-or-captcha";
    }
    if (normalized.includes("submit") || normalized.includes("publish") || normalized.includes("发布") || normalized.includes("提交") || normalized.includes("校验")) {
        return "publish-validation-failed";
    }
    return "work-item-skipped";
};
const classifyQueueDaemonRun = (queueRun) => {
    if (queueRun.queued > 0) {
        return {
            category: "ready-queued",
            countsAsFailure: false,
            reason: `queued ${queueRun.queued} full-flow job(s)`
        };
    }
    if (queueRun.skipped === 0) {
        return {
            category: "idle-no-items",
            countsAsFailure: false,
            reason: "no ready work items"
        };
    }
    const firstReason = queueRun.skippedItems[0]?.reason ?? "work items skipped";
    return {
        category: classifyQueueDaemonSkippedReason(firstReason),
        countsAsFailure: true,
        reason: `no jobs queued; skipped ${queueRun.skipped}: ${firstReason}`
    };
};
const listDianxiaomiReleasedRetryCandidateIds = (limit, input: AutomationDryRunStartInput = {}) => {
    const items = listScopedDianxiaomiProductWorkItems(input)
        .filter((item) => isDianxiaomiWorkItemBrowserRecoveryCandidate(item));
    const failureSummaries = filterRecoveryFailureSummariesForItems(collectRecoveryFailureSummaries(), items);
    recordReleasedRecoveryPauses(items, failureSummaries);
    return items
        .filter((item) => !isDianxiaomiWorkItemBrowserRecoveryPaused(item, failureSummaries))
        .map((item) => releasedRetryCandidateForWorkItem(item))
        .filter((item) => Boolean(item))
        .slice(0, limit)
        .map((item) => item.workItemId);
};
const listDianxiaomiBrowserRecoveryCandidateIds = (limit, input: AutomationDryRunStartInput = {}) => {
    const items = listScopedDianxiaomiProductWorkItems(input)
        .filter((item) => isDianxiaomiWorkItemBrowserRecoveryCandidate(item));
    const failureSummaries = filterRecoveryFailureSummariesForItems(collectRecoveryFailureSummaries(), items);
    recordReleasedRecoveryPauses(items, failureSummaries);
    const releasedRetryCandidateIds = new Set(items
        .filter((item) => !isDianxiaomiWorkItemBrowserRecoveryPaused(item, failureSummaries))
        .map((item) => releasedRetryCandidateForWorkItem(item))
        .filter((item) => Boolean(item))
        .map((item) => item.workItemId));
    return items
        .filter((item) => !isDianxiaomiWorkItemBrowserRecoveryPaused(item, failureSummaries))
        .filter((item) => !releasedRetryCandidateIds.has(item.id))
        .slice(0, limit)
        .map((item) => item.id);
};
const startQueueDaemonRecoveryRun = (input) => {
    const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 5)));
    const releasedRetryWorkItemIds = listDianxiaomiReleasedRetryCandidateIds(RECOVERY_RELEASED_RETRY_BATCH_LIMIT, input);
    if (releasedRetryWorkItemIds.length > 0) {
        return startDianxiaomiRecoveryRun({
            ...input,
            mediaAutomationMode: input.mediaAutomationMode ?? "unattended-apply",
            submitAfterSave: input.submitAfterSave ?? true,
            limit: RECOVERY_RELEASED_RETRY_BATCH_LIMIT,
            workItemIds: releasedRetryWorkItemIds,
            recoveryPolicy: "released-retry"
        });
    }
    const workItemIds = listDianxiaomiBrowserRecoveryCandidateIds(limit, input);
    if (workItemIds.length === 0) {
        return null;
    }
    return startDianxiaomiRecoveryRun({
        ...input,
        mediaAutomationMode: input.mediaAutomationMode ?? "unattended-apply",
        submitAfterSave: input.submitAfterSave ?? true,
        limit,
        workItemIds,
        recoveryPolicy: "normal"
    });
};
const startQueueDaemonValidationRerun = (input) => {
    const policy = getDianxiaomiQueueDaemonHealth(input).manualBudget.validationClosure.rerunPolicy;
    const eligibleRoutes = new Set([
        "auto-retry",
        "browser-recovery",
        "profile-fix"
    ]);
    if (policy.status !== "ready"
        || !policy.sourceTrialId
        || !policy.candidateKey
        || !eligibleRoutes.has(policy.route)) {
        return null;
    }
    const proposal = getDianxiaomiQueueDaemonHealth(input).manualBudget.trialProposals
        .find((item) => item.candidateKey === policy.candidateKey);
    if (!proposal) {
        return null;
    }
    return startManualBudgetTrial({
        ...input,
        candidateKey: policy.candidateKey,
        rollbackAcknowledged: true,
        acceptedRollbackCriteria: proposal.rollbackCriteria,
        mediaAutomationMode: input.mediaAutomationMode ?? "unattended-apply",
        submitAfterSave: input.submitAfterSave ?? true,
        validationRerun: {
            sourceTrialId: policy.sourceTrialId,
            route: policy.route,
            reason: policy.reason,
            requestedBy: "queue-daemon"
        }
    });
};
const queueDaemonStartupBlock = (input: any = {}) => {
    const health = getDianxiaomiQueueDaemonHealth(input);
    const profileStartupCheck = unattendedBrowserProfileStartupCheck(health.profile);
    if (input.forActivation === true && profileStartupCheck.status === "block") {
        return {
            category: "startup-check-blocked",
            reason: profileStartupCheck.message
        };
    }
    if (health.workItems.ready === 0
        && health.workItems.browserRecoveryCandidates === 0
        && health.workItems.releasedBrowserRecoveryCandidates === 0
        && health.manualBudget.validationClosure.rerunPolicy.status !== "ready") {
        return null;
    }
    const calibrationCheck = latestSelectorCalibrationCheck();
    if (calibrationCheck.status === "block") {
        return {
            category: "target-surface-blocked",
            reason: calibrationCheck.message
        };
    }
    const sessionCheck = latestDianxiaomiSessionCheck();
    if (sessionCheck.status === "block") {
        return {
            category: "login-or-captcha",
            reason: sessionCheck.message
        };
    }
    const selectorGate = getSelectorReadinessGate(daemonStateHolder.current.input);
    if (!selectorGate.selectorReady) {
        return {
            category: "selector-blocked",
            reason: selectorBlockReason(selectorGate.selectorBlockers)
        };
    }
    if (profileStartupCheck.status === "block") {
        return {
            category: "startup-check-blocked",
            reason: profileStartupCheck.message
        };
    }
    if (health.queue.consecutiveFailures >= health.queue.maxConsecutiveFailures) {
        return {
            category: "startup-check-blocked",
            reason: `failure budget exhausted: ${health.queue.consecutiveFailures}/${health.queue.maxConsecutiveFailures}`
        };
    }
    return null;
};
const classifyQueueDaemonError = (message) => {
    const normalized = message.toLowerCase();
    if (normalized.includes("repair-apply")) {
        return "repair-apply-failed";
    }
    if (normalized.includes("repair-preview")) {
        return "repair-preview-failed";
    }
    if (normalized.includes("selector")) {
        return "selector-blocked";
    }
    if (normalized.includes("target-surface") || normalized.includes("write-blocked-wrong-surface") || normalized.includes("listing edit surface")) {
        return "target-surface-blocked";
    }
    if (normalized.includes("login") || normalized.includes("captcha") || normalized.includes("验证码") || normalized.includes("登录")) {
        return "login-or-captcha";
    }
    if (normalized.includes("submit") || normalized.includes("publish") || normalized.includes("发布") || normalized.includes("提交")) {
        return "publish-validation-failed";
    }
    return "system-error";
};
export const tickDianxiaomiQueueDaemon = async () => {
    const startedAt = new Date().toISOString();
    const id = `automation-queue-daemon-tick-${timestampId()}`;
    if (daemonStateHolder.current.status !== "ACTIVE") {
        const tick = {
            id,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "skipped",
            category: "daemon-paused",
            reason: "daemon paused",
            queueRun: null,
            recoveryRun: null,
            flowOutcomes: [],
            error: null
        };
        pushQueueDaemonTick(tick);
        return tick;
    }
    if (daemonStateHolder.current.running) {
        const tick = {
            id,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "skipped",
            category: "tick-already-running",
            reason: "previous queue daemon tick still running",
            queueRun: null,
            recoveryRun: null,
            flowOutcomes: [],
            error: null
        };
        pushQueueDaemonTick(tick);
        return tick;
    }
    daemonStateHolder.current = {
        ...daemonStateHolder.current,
        running: true,
        lastStartedAt: startedAt,
        lastError: null
    };
    persistQueueDaemonState();
    let flowOutcomes = [];
    try {
        flowOutcomes = recoverQueueDaemonFlowOutcomes();
        const autoRetryReleasedIds = releaseAutoRetryDianxiaomiWorkItems(daemonStateHolder.current.input);
        const startupBlock = queueDaemonStartupBlock(daemonStateHolder.current.input);
        if (startupBlock) {
            const consecutiveFailures = daemonStateHolder.current.consecutiveFailures + 1;
            const shouldPause = consecutiveFailures >= daemonStateHolder.current.maxConsecutiveFailures;
            const finishedAt = new Date().toISOString();
            const tick = {
                id,
                startedAt,
                finishedAt,
                status: "skipped",
                category: startupBlock.category,
                reason: autoRetryReleasedIds.length > 0
                    ? `${startupBlock.reason}; released ${autoRetryReleasedIds.length} auto-recovery item(s)`
                    : startupBlock.reason,
                queueRun: null,
                recoveryRun: null,
                flowOutcomes,
                error: startupBlock.reason
            };
            daemonStateHolder.current = {
                ...daemonStateHolder.current,
                status: shouldPause ? "PAUSED" : daemonStateHolder.current.status,
                running: false,
                consecutiveFailures,
                lastFinishedAt: finishedAt,
                lastError: shouldPause ? `paused after ${consecutiveFailures} blocked startup check(s): ${startupBlock.category}` : startupBlock.reason
            };
            pushQueueDaemonTick(tick);
            scheduleQueueDaemonNextRun();
            return tick;
        }
        const validationRun = startQueueDaemonValidationRerun(daemonStateHolder.current.input);
        if (validationRun) {
            trackQueueDaemonFlowJobs(validationRun.flowJobIds);
            const finishedAt = new Date().toISOString();
            const releasedReason = autoRetryReleasedIds.length > 0
                ? `released ${autoRetryReleasedIds.length} non-browser auto-recovery item(s)`
                : null;
            const flowOutcomeReason = flowOutcomes.length > 0 ? summarizeQueueDaemonFlowOutcomes(flowOutcomes) : null;
            const reason = [
                releasedReason,
                `started validation rerun ${validationRun.id}: flows ${validationRun.flowJobIds.length}, skipped ${validationRun.skippedItems.length}, status ${validationRun.outcome.status}`,
                flowOutcomeReason
            ].filter(Boolean).join("; ");
            const tick = {
                id,
                startedAt,
                finishedAt,
                status: "completed",
                category: "validation-rerun-started",
                reason,
                queueRun: null,
                recoveryRun: null,
                manualBudgetValidationRun: validationRun,
                flowOutcomes,
                error: null
            };
            daemonStateHolder.current = {
                ...daemonStateHolder.current,
                running: false,
                consecutiveFailures: 0,
                lastFinishedAt: finishedAt,
                lastError: null
            };
            pushQueueDaemonTick(tick);
            scheduleQueueDaemonNextRun();
            return tick;
        }
        const unresolvedFlowJobs = listQueueDaemonUnresolvedFlowJobs(daemonStateHolder.current.input);
        if (unresolvedFlowJobs.length > 0) {
            const finishedAt = new Date().toISOString();
            const flowOutcomeReason = flowOutcomes.length > 0 ? summarizeQueueDaemonFlowOutcomes(flowOutcomes) : null;
            const reason = [
                `waiting for ${unresolvedFlowJobs.length} running full-flow job(s)`,
                flowOutcomeReason
            ].filter(Boolean).join("; ");
            const tick = {
                id,
                startedAt,
                finishedAt,
                status: "skipped",
                category: "awaiting-flow-completion",
                reason,
                queueRun: null,
                recoveryRun: null,
                flowOutcomes,
                error: null
            };
            daemonStateHolder.current = {
                ...daemonStateHolder.current,
                running: false,
                consecutiveFailures: 0,
                lastFinishedAt: finishedAt,
                lastError: null
            };
            pushQueueDaemonTick(tick);
            scheduleQueueDaemonNextRun();
            return tick;
        }
        const recoveryRun = startQueueDaemonRecoveryRun(daemonStateHolder.current.input);
        if (recoveryRun) {
            const finishedAt = new Date().toISOString();
            const releasedReason = autoRetryReleasedIds.length > 0
                ? `released ${autoRetryReleasedIds.length} non-browser auto-recovery item(s)`
                : null;
            const flowOutcomeReason = flowOutcomes.length > 0 ? summarizeQueueDaemonFlowOutcomes(flowOutcomes) : null;
            const reason = [
                releasedReason,
                `started recovery-run ${recoveryRun.id}: queued ${recoveryRun.queued}, skipped ${recoveryRun.skipped}`,
                flowOutcomeReason
            ].filter(Boolean).join("; ");
            const tick = {
                id,
                startedAt,
                finishedAt,
                status: "completed",
                category: "recovery-run-started",
                reason,
                queueRun: null,
                recoveryRun,
                flowOutcomes,
                error: null
            };
            daemonStateHolder.current = {
                ...daemonStateHolder.current,
                running: false,
                consecutiveFailures: 0,
                lastFinishedAt: finishedAt,
                lastRecoveryRunId: recoveryRun.id,
                lastError: null
            };
            pushQueueDaemonTick(tick);
            scheduleQueueDaemonNextRun();
            return tick;
        }
        const queueRun = startDianxiaomiQueueRun(daemonStateHolder.current.input, {
            releasedAutoRetryIds: autoRetryReleasedIds,
            releaseAutoRetry: false
        });
        trackQueueDaemonFlowJobs(queueRun.flowJobIds);
        const queueClassification = classifyQueueDaemonRun(queueRun);
        const releasedReason = queueRun.autoRetryReleasedIds.length > 0
            ? `released ${queueRun.autoRetryReleasedIds.length} auto-recovery item(s)`
            : null;
        const classification = flowOutcomes.length > 0 && queueRun.queued === 0 && queueRun.skipped === 0
            ? {
                category: "flow-outcome-recovered",
                countsAsFailure: false,
                reason: [releasedReason, summarizeQueueDaemonFlowOutcomes(flowOutcomes)].filter(Boolean).join("; ")
            }
            : flowOutcomes.length > 0
                ? {
                    ...queueClassification,
                    reason: [releasedReason, queueClassification.reason, summarizeQueueDaemonFlowOutcomes(flowOutcomes)].filter(Boolean).join("; ")
                }
                : {
                    ...queueClassification,
                    reason: [releasedReason, queueClassification.reason].filter(Boolean).join("; ")
                };
        const consecutiveFailures = classification.countsAsFailure ? daemonStateHolder.current.consecutiveFailures + 1 : 0;
        const shouldPause = consecutiveFailures >= daemonStateHolder.current.maxConsecutiveFailures;
        const finishedAt = new Date().toISOString();
        const tick = {
            id,
            startedAt,
            finishedAt,
            status: "completed",
            category: classification.category,
            reason: classification.reason,
            queueRun,
            recoveryRun: null,
            flowOutcomes,
            error: null
        };
        daemonStateHolder.current = {
            ...daemonStateHolder.current,
            status: shouldPause ? "PAUSED" : daemonStateHolder.current.status,
            running: false,
            consecutiveFailures,
            lastFinishedAt: finishedAt,
            lastQueueRunId: queueRun.id,
            lastError: shouldPause ? `paused after ${consecutiveFailures} consecutive failed queue ticks: ${classification.category}` : null
        };
        pushQueueDaemonTick(tick);
        scheduleQueueDaemonNextRun();
        return tick;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const consecutiveFailures = daemonStateHolder.current.consecutiveFailures + 1;
        const shouldPause = consecutiveFailures >= daemonStateHolder.current.maxConsecutiveFailures;
        const finishedAt = new Date().toISOString();
        const tick = {
            id,
            startedAt,
            finishedAt,
            status: "failed",
            category: classifyQueueDaemonError(message),
            queueRun: null,
            recoveryRun: null,
            flowOutcomes,
            error: message
        };
        daemonStateHolder.current = {
            ...daemonStateHolder.current,
            status: shouldPause ? "PAUSED" : daemonStateHolder.current.status,
            running: false,
            consecutiveFailures,
            lastFinishedAt: finishedAt,
            lastError: shouldPause ? `paused after ${consecutiveFailures} consecutive failures: ${message}` : message
        };
        pushQueueDaemonTick(tick);
        scheduleQueueDaemonNextRun();
        return tick;
    }
};
export const startDianxiaomiQueueDaemon = (input: any = {}) => {
    const normalized = normalizeQueueDaemonInput(input);
    if (daemonStateHolder.timer) {
        clearTimeout(daemonStateHolder.timer);
        daemonStateHolder.timer = null;
    }
    daemonStateHolder.current = {
        ...daemonStateHolder.current,
        input: normalized.input,
        intervalSeconds: normalized.intervalSeconds,
        maxConsecutiveFailures: normalized.maxConsecutiveFailures,
        consecutiveFailures: 0,
        lastError: null,
        nextRunAt: null
    };
    const startupBlock = queueDaemonStartupBlock({ forActivation: true });
    if (startupBlock) {
        daemonStateHolder.current = {
            ...daemonStateHolder.current,
            status: "PAUSED",
            running: false,
            lastStartedAt: new Date().toISOString(),
            lastFinishedAt: new Date().toISOString(),
            lastError: `startup blocked before queue daemon activation: ${startupBlock.reason}`
        };
        persistQueueDaemonState();
        return getDianxiaomiQueueDaemonState();
    }
    daemonStateHolder.current = {
        ...daemonStateHolder.current,
        status: "ACTIVE",
        running: false
    };
    persistQueueDaemonState();
    scheduleQueueDaemonNextRun();
    void tickDianxiaomiQueueDaemon();
    return getDianxiaomiQueueDaemonState();
};
export const pauseDianxiaomiQueueDaemon = () => {
    if (daemonStateHolder.timer) {
        clearTimeout(daemonStateHolder.timer);
        daemonStateHolder.timer = null;
    }
    daemonStateHolder.current = {
        ...daemonStateHolder.current,
        status: "PAUSED",
        nextRunAt: null
    };
    persistQueueDaemonState();
    return getDianxiaomiQueueDaemonState();
};
export const restoreDianxiaomiQueueDaemon = () => {
    loadAutomationRunnerRuntimeState();
    scheduleQueueDaemonNextRun();
    return getDianxiaomiQueueDaemonState();
};
export const getDianxiaomiQueueDaemonState = () => cloneQueueDaemonState(daemonStateHolder.current);
