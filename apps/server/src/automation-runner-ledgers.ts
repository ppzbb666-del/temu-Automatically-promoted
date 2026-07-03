// Ledger persistence, extracted from automation-runner.ts (domain-split refactor).
// Owns the manual-budget proof ledger and the profile-lock audit ledger:
// build/normalize/clone helpers, disk persistence, and the report-measurement
// helpers that feed proof records.
//
// State ownership:
//  - manualBudgetProofLedger is an `export let` owned here; every reassignment
//    lives in this module (load/record), so external readers consume the live
//    binding.
//  - the profile-lock audit ledger is reassigned both here and in the archive
//    path in automation-runner.ts, so it lives behind profileLockAuditHolder in
//    ./automation-runner-state (mutate .current).
//
// readAutomationExecutionReport is imported back from ./automation-runner; it is
// only invoked at runtime (inside measureAutomationReports), so the cyclic import
// is safe.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
    timestampId,
    clampInteger,
    averagePerProduct,
    getManualBudgetProofLedgerPath,
    getProfileLockLedgerPath,
    MANUAL_BUDGET_PROOF_LEDGER_LIMIT,
    PROFILE_LOCK_AUDIT_LIMIT,
    DEFAULT_PROFILE_LOCK_STALE_MS
} from "./automation-runner-constants";
import { profileLockAuditHolder } from "./automation-runner-state";
import { readAutomationExecutionReport } from "./automation-runner";

// Manual-budget proof ledger. All reassignments live in this module (load/record).
export let manualBudgetProofLedger: any[] = [];

const getManualBudgetProofStatus = (input) => {
    const clickReductionPerProduct = averagePerProduct(input.baseline.operatorClicks, input.baseline.productCount)
        - averagePerProduct(input.trial.operatorClicks, input.trial.productCount);
    const decisionReductionPerProduct = averagePerProduct(input.baseline.operatorDecisions, input.baseline.productCount)
        - averagePerProduct(input.trial.operatorDecisions, input.trial.productCount);
    return input.trial.status === "passed" && (clickReductionPerProduct > 0 || decisionReductionPerProduct > 0)
        ? "ready-for-default"
        : "needs-proof";
};
const getManualBudgetProofConfidence = (input, status = getManualBudgetProofStatus(input)) => {
    if (status !== "ready-for-default") {
        return "weak";
    }
    return input.automationMeasurement?.reportCount && input.automationMeasurement.reportCount > 0
        ? "measured"
        : "estimated";
};
const buildManualBudgetProofRecord = (input) => {
    const clickReductionPerProduct = averagePerProduct(input.baseline.operatorClicks, input.baseline.productCount)
        - averagePerProduct(input.trial.operatorClicks, input.trial.productCount);
    const decisionReductionPerProduct = averagePerProduct(input.baseline.operatorDecisions, input.baseline.productCount)
        - averagePerProduct(input.trial.operatorDecisions, input.trial.productCount);
    const status = getManualBudgetProofStatus(input);
    const confidence = getManualBudgetProofConfidence(input, status);
    return {
        ...input,
        recordedBy: input.recordedBy?.trim() || "system",
        id: `manual-budget-proof-${timestampId()}-${Math.random().toString(36).slice(2, 8)}`,
        recordedAt: new Date().toISOString(),
        status,
        confidence,
        defaultEligible: status === "ready-for-default",
        clickReductionPerProduct,
        decisionReductionPerProduct
    };
};
export const manualBudgetProofSources = new Set([
    "publish-outcome",
    "repair-plan",
    "failure-diagnosis"
]);
export const normalizeManualBudgetProofText = (value) => typeof value === "string" ? value.trim() : "";
export const normalizeManualBudgetProofNumber = (value, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const profileLockAuditActions = new Set([
    "ignored-stale-lock",
    "archived-stale-lock"
]);
const cloneProfileLockAuditEntry = (entry) => ({
    ...entry
});
export const profileLockAuditId = (action, profilePath, fileName, mtime) => `profile-lock-${createHash("sha1")
    .update([action, profilePath, fileName, mtime ?? "unknown"].join("\0"))
    .digest("hex")
    .slice(0, 12)}`;
export const normalizeProfileLockAuditEntry = (entry) => {
    const action = entry.action && profileLockAuditActions.has(entry.action) ? entry.action : null;
    const profilePath = normalizeManualBudgetProofText(entry.profilePath);
    const fileName = normalizeManualBudgetProofText(entry.fileName);
    const detail = normalizeManualBudgetProofText(entry.detail) || fileName;
    if (!action || !profilePath || !fileName) {
        return null;
    }
    const mtime = normalizeManualBudgetProofText(entry.mtime) || null;
    return {
        id: normalizeManualBudgetProofText(entry.id) || profileLockAuditId(action, profilePath, fileName, mtime),
        recordedAt: normalizeManualBudgetProofText(entry.recordedAt) || new Date().toISOString(),
        action,
        profilePath,
        fileName,
        detail,
        mtime,
        ageMinutes: typeof entry.ageMinutes === "number" && Number.isFinite(entry.ageMinutes)
            ? Math.max(0, Math.floor(entry.ageMinutes))
            : null,
        staleThresholdMinutes: clampInteger(entry.staleThresholdMinutes, DEFAULT_PROFILE_LOCK_STALE_MS / 60_000, 5, 7 * 24 * 60),
        nextAction: normalizeManualBudgetProofText(entry.nextAction)
            || "Keep ignored in startup gate; archive only after confirming no Dianxiaomi browser session is using this profile."
    };
};
export const persistProfileLockAuditLedger = () => {
    const ledgerPath = getProfileLockLedgerPath();
    mkdirSync(path.dirname(ledgerPath), {
        recursive: true
    });
    writeFileSync(ledgerPath, JSON.stringify({
        entries: profileLockAuditHolder.current
            .slice(0, PROFILE_LOCK_AUDIT_LIMIT)
            .map(cloneProfileLockAuditEntry)
    }, null, 2), "utf8");
};
export const loadProfileLockAuditLedger = () => {
    const ledgerPath = getProfileLockLedgerPath();
    if (!existsSync(ledgerPath)) {
        return;
    }
    try {
        const parsed = JSON.parse(readFileSync(ledgerPath, "utf8"));
        const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : [];
        profileLockAuditHolder.current = entries
            .map(normalizeProfileLockAuditEntry)
            .filter((entry) => Boolean(entry))
            .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
            .slice(0, PROFILE_LOCK_AUDIT_LIMIT);
    }
    catch {
        profileLockAuditHolder.current = [];
    }
};
export const profileLockAuditSummary = (profilePath) => {
    const entries = profilePath
        ? profileLockAuditHolder.current.filter((entry) => entry.profilePath === profilePath)
        : [];
    return {
        recent: entries.slice(0, 10).map(cloneProfileLockAuditEntry),
        ignored: entries.filter((entry) => entry.action === "ignored-stale-lock").length,
        archived: entries.filter((entry) => entry.action === "archived-stale-lock").length
    };
};
export const cloneManualBudgetProofAutomationMeasurement = (measurement) => ({
    ...measurement,
    reportIds: [...measurement.reportIds],
    reportPaths: [...measurement.reportPaths]
});
export const cloneManualBudgetProofRecord = (record) => ({
    ...record,
    baseline: {
        ...record.baseline
    },
    trial: {
        ...record.trial
    },
    automationMeasurement: record.automationMeasurement
        ? cloneManualBudgetProofAutomationMeasurement(record.automationMeasurement)
        : undefined
});
export const normalizeManualBudgetProofAutomationMeasurement = (measurement) => {
    if (!measurement || typeof measurement !== "object") {
        return undefined;
    }
    const candidate = measurement;
    return {
        source: "automation-reports",
        browserClicks: Math.max(0, normalizeManualBudgetProofNumber(candidate.browserClicks)),
        browserActions: Math.max(0, normalizeManualBudgetProofNumber(candidate.browserActions)),
        reportCount: clampInteger(candidate.reportCount, 0, 0, 100),
        reportIds: Array.isArray(candidate.reportIds)
            ? candidate.reportIds.map(normalizeManualBudgetProofText).filter(Boolean).slice(0, 20)
            : [],
        reportPaths: Array.isArray(candidate.reportPaths)
            ? candidate.reportPaths.map(normalizeManualBudgetProofText).filter(Boolean).slice(0, 20)
            : []
    };
};
const countTruthy = (items) => items.filter(Boolean).length;
const numberFromRecord = (record, key) => normalizeManualBudgetProofNumber(record[key]);
const measureAutomationReportStep = (step) => {
    let browserClicks = 0;
    let browserActions = step.status === "done" ? 1 : 0;
    const data = step.data ?? {};
    if (step.id === "submit-listing" && Array.isArray(data.attempts)) {
        for (const attempt of data.attempts) {
            if (!attempt || typeof attempt !== "object") {
                continue;
            }
            const normalizedAttempt = attempt;
            browserClicks += countTruthy([
                normalizedAttempt.clickedSubmit,
                normalizedAttempt.clickedConfirm
            ]);
        }
    }
    if (Array.isArray(data.tools)) {
        for (const tool of data.tools) {
            if (!tool || typeof tool !== "object") {
                continue;
            }
            const normalizedTool = tool;
            const applyAttempts = numberFromRecord(normalizedTool, "applyAttempts");
            browserClicks += countTruthy([normalizedTool.clicked]);
            browserClicks += applyAttempts > 0
                ? applyAttempts
                : countTruthy([normalizedTool.applied]);
            browserActions += countTruthy([
                normalizedTool.clicked,
                normalizedTool.applied
            ]);
        }
    }
    browserActions += numberFromRecord(data, "filledPrices");
    browserActions += numberFromRecord(data, "filledStocks");
    return {
        browserClicks,
        browserActions
    };
};
export const measureAutomationReports = (reportPaths) => {
    const reports = reportPaths
        .filter((reportPath) => Boolean(reportPath))
        .map((reportPath) => ({
        reportPath,
        report: readAutomationExecutionReport(reportPath)
    }))
        .filter((item) => Boolean(item.report));
    if (reports.length === 0) {
        return undefined;
    }
    const measured = reports.reduce((summary, item) => {
        for (const step of item.report.steps) {
            const stepMeasurement = measureAutomationReportStep(step);
            summary.browserClicks += stepMeasurement.browserClicks;
            summary.browserActions += stepMeasurement.browserActions;
        }
        return summary;
    }, {
        browserClicks: 0,
        browserActions: 0
    });
    return {
        source: "automation-reports",
        browserClicks: measured.browserClicks,
        browserActions: measured.browserActions,
        reportCount: reports.length,
        reportIds: reports.map((item) => item.report.id).slice(0, 20),
        reportPaths: reports.map((item) => item.reportPath).slice(0, 20)
    };
};
const normalizeManualBudgetProofRecord = (record) => {
    const id = normalizeManualBudgetProofText(record.id);
    const candidateKey = normalizeManualBudgetProofText(record.candidateKey);
    const source = record.source;
    const reason = normalizeManualBudgetProofText(record.reason);
    const replacementPlan = normalizeManualBudgetProofText(record.replacementPlan);
    const evidence = normalizeManualBudgetProofText(record.evidence);
    if (!id || !candidateKey || !source || !manualBudgetProofSources.has(source) || !reason || !replacementPlan || !evidence) {
        return null;
    }
    const baseline = {
        productCount: clampInteger(record.baseline?.productCount, 1, 1, 100000),
        operatorClicks: Math.max(0, normalizeManualBudgetProofNumber(record.baseline?.operatorClicks)),
        operatorDecisions: Math.max(0, normalizeManualBudgetProofNumber(record.baseline?.operatorDecisions))
    };
    const trial = {
        productCount: clampInteger(record.trial?.productCount, 1, 1, 100000),
        operatorClicks: Math.max(0, normalizeManualBudgetProofNumber(record.trial?.operatorClicks)),
        operatorDecisions: Math.max(0, normalizeManualBudgetProofNumber(record.trial?.operatorDecisions)),
        status: record.trial?.status === "passed" ? "passed" : "failed"
    };
    const input = {
        candidateKey,
        source,
        reason,
        replacementPlan,
        baseline,
        trial,
        evidence,
        automationMeasurement: normalizeManualBudgetProofAutomationMeasurement(record.automationMeasurement),
        recordedBy: normalizeManualBudgetProofText(record.recordedBy) || "system"
    };
    const status = getManualBudgetProofStatus(input);
    const recordedAt = normalizeManualBudgetProofText(record.recordedAt) || new Date().toISOString();
    return {
        ...input,
        id,
        recordedAt,
        status,
        confidence: getManualBudgetProofConfidence(input, status),
        defaultEligible: status === "ready-for-default",
        clickReductionPerProduct: averagePerProduct(baseline.operatorClicks, baseline.productCount)
            - averagePerProduct(trial.operatorClicks, trial.productCount),
        decisionReductionPerProduct: averagePerProduct(baseline.operatorDecisions, baseline.productCount)
            - averagePerProduct(trial.operatorDecisions, trial.productCount)
    };
};
const persistManualBudgetProofLedger = () => {
    const ledgerPath = getManualBudgetProofLedgerPath();
    mkdirSync(path.dirname(ledgerPath), {
        recursive: true
    });
    writeFileSync(ledgerPath, JSON.stringify({
        proofs: manualBudgetProofLedger
            .slice(0, MANUAL_BUDGET_PROOF_LEDGER_LIMIT)
            .map(cloneManualBudgetProofRecord)
    }, null, 2), "utf8");
};
export const loadManualBudgetProofLedger = () => {
    const ledgerPath = getManualBudgetProofLedgerPath();
    if (!existsSync(ledgerPath)) {
        return;
    }
    try {
        const parsed = JSON.parse(readFileSync(ledgerPath, "utf8"));
        const proofs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.proofs) ? parsed.proofs : [];
        manualBudgetProofLedger = proofs
            .map(normalizeManualBudgetProofRecord)
            .filter((record) => Boolean(record))
            .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
            .slice(0, MANUAL_BUDGET_PROOF_LEDGER_LIMIT);
    }
    catch {
        manualBudgetProofLedger = [];
    }
};
export const listManualBudgetProofRecords = (limit = 20) => manualBudgetProofLedger
    .slice(0, clampInteger(limit, 20, 1, MANUAL_BUDGET_PROOF_LEDGER_LIMIT))
    .map(cloneManualBudgetProofRecord);
export const recordManualBudgetProof = (input) => {
    const record = normalizeManualBudgetProofRecord(buildManualBudgetProofRecord(input));
    if (!record) {
        throw new Error("manual budget proof input is invalid");
    }
    manualBudgetProofLedger = [
        record,
        ...manualBudgetProofLedger.filter((existing) => existing.id !== record.id)
    ]
        .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
        .slice(0, MANUAL_BUDGET_PROOF_LEDGER_LIMIT);
    persistManualBudgetProofLedger();
    return cloneManualBudgetProofRecord(record);
};
