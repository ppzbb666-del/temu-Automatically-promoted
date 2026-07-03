import type {
  AutomationDryRunStartInput,
  AutomationMode,
  AutomationPreflightCheck,
  AutomationPreflightReport
} from "@temu-ai-ops/shared"
import {
  getAutomationModeReadiness,
  listDianxiaomiDryRunJobs,
  listDianxiaomiFillDraftJobs,
  listDianxiaomiRepairApplyJobs,
  listDianxiaomiRepairPreviewJobs,
  listDianxiaomiSaveDraftJobs,
  listDianxiaomiSubmitListingJobs
} from "./automation-runner"
import {
  getActiveTask,
  getPublishCheck,
  getTaskFileExportSnapshotStatus,
  listAutomationReports,
  validateSelectorConfig
} from "./planner"

type AutomationPreflightInput = Pick<AutomationDryRunStartInput, "url" | "taskFile" | "repairPlanFile" | "selectorConfig" | "mediaAutomationMode" | "mediaAutomationTools" | "submitAfterSave">

const statusFromReady = (ready: boolean): AutomationPreflightCheck["status"] => ready ? "pass" : "block"

const buildModeCheck = (
  mode: AutomationMode,
  ready: boolean,
  reason: string
): AutomationPreflightCheck => ({
  id: `mode-${mode}`,
  label: `${mode} readiness`,
  status: statusFromReady(ready),
  message: reason
})

const recommendedMode = (readyModes: AutomationMode[]): AutomationMode | null => {
  if (readyModes.includes("submit-listing")) {
    return "submit-listing"
  }

  if (readyModes.includes("save-draft")) {
    return "save-draft"
  }

  if (readyModes.includes("fill-draft")) {
    return "fill-draft"
  }

  if (readyModes.includes("repair-apply")) {
    return "repair-apply"
  }

  if (readyModes.includes("repair-preview")) {
    return "repair-preview"
  }

  if (readyModes.includes("dry-run")) {
    return "dry-run"
  }

  return null
}

export const getAutomationPreflight = (input: AutomationPreflightInput = {}): AutomationPreflightReport => {
  const dryRun = getAutomationModeReadiness("dry-run", input)
  const repairPreview = getAutomationModeReadiness("repair-preview", input)
  const repairApply = getAutomationModeReadiness("repair-apply", input)
  const fillDraft = getAutomationModeReadiness("fill-draft", input)
  const saveDraft = getAutomationModeReadiness("save-draft", input)
  const submitListing = getAutomationModeReadiness("submit-listing", input)
  const selectorValidation = validateSelectorConfig(input.selectorConfig)
  const taskFileSnapshot = getTaskFileExportSnapshotStatus(input.taskFile)
  const activeTask = input.taskFile ? null : getActiveTask()
  const publishCheck = activeTask ? getPublishCheck(activeTask.id) : null
  const readyModes = ([
    dryRun.ready ? "dry-run" : null,
    repairPreview.ready ? "repair-preview" : null,
    repairApply.ready ? "repair-apply" : null,
    fillDraft.ready ? "fill-draft" : null,
    saveDraft.ready ? "save-draft" : null,
    submitListing.ready ? "submit-listing" : null
  ] as Array<AutomationMode | null>).filter((mode): mode is AutomationMode => Boolean(mode))
  const checks: AutomationPreflightCheck[] = [
    input.taskFile
      ? taskFileSnapshot.tracked
        ? {
            id: "task-source",
            label: "task source",
            status: taskFileSnapshot.ready ? "pass" : "warning",
            message: taskFileSnapshot.ready
              ? `tracked task file is current: ${input.taskFile}`
              : taskFileSnapshot.reason,
            details: taskFileSnapshot.details
          }
        : {
            id: "task-source",
            label: "task source",
            status: "pass",
            message: `task file provided: ${input.taskFile}`
          }
      : activeTask && publishCheck
        ? {
            id: "publish-check",
            label: "active task publish check",
            status: publishCheck.canPublish ? "pass" : "block",
            message: publishCheck.canPublish ? "active task can be used for automation" : "active task is not ready for automation",
            details: publishCheck.issues.map((issue) => `${issue.level}: ${issue.message}`)
          }
        : {
            id: "publish-check",
            label: "active task publish check",
            status: "block",
            message: "no active task is available; provide a task file or approve a task"
          },
    {
      id: "selector-validation",
      label: "selector validation",
      status: selectorValidation.valid
        ? selectorValidation.issues.length > 0 ? "warning" : "pass"
        : "block",
      message: selectorValidation.valid ? "selector config is valid" : "selector config has blocking errors",
      details: selectorValidation.issues.map((issue) => `${issue.level}: ${issue.message}`)
    },
    buildModeCheck("dry-run", dryRun.ready, dryRun.reason),
    buildModeCheck("repair-preview", repairPreview.ready, repairPreview.reason),
    buildModeCheck("repair-apply", repairApply.ready, repairApply.reason),
    buildModeCheck("fill-draft", fillDraft.ready, fillDraft.reason),
    buildModeCheck("save-draft", saveDraft.ready, saveDraft.reason),
    buildModeCheck("submit-listing", submitListing.ready, submitListing.reason)
  ]
  const blockingChecks = checks.filter((check) => check.status === "block")
  const warningChecks = checks.filter((check) => check.status === "warning")

  return {
    checkedAt: new Date().toISOString(),
    targetFingerprint: dryRun.targetFingerprint,
    overallStatus: blockingChecks.length > 0 ? "blocked" : warningChecks.length > 0 ? "warning" : "ready",
    readyModes,
    recommendedMode: recommendedMode(readyModes),
    checks,
    readiness: {
      dryRun,
      repairPreview,
      repairApply,
      fillDraft,
      saveDraft,
      submitListing
    },
    selectorValidation,
    publishCheck,
    activeTask: activeTask ? {
      id: activeTask.id,
      status: activeTask.status,
      updatedAt: activeTask.updatedAt
    } : null,
    latestJobs: {
      dryRun: listDianxiaomiDryRunJobs(1)[0] ?? null,
      repairPreview: listDianxiaomiRepairPreviewJobs(1)[0] ?? null,
      repairApply: listDianxiaomiRepairApplyJobs(1)[0] ?? null,
      fillDraft: listDianxiaomiFillDraftJobs(1)[0] ?? null,
      saveDraft: listDianxiaomiSaveDraftJobs(1)[0] ?? null,
      submitListing: listDianxiaomiSubmitListingJobs(1)[0] ?? null
    },
    latestReport: listAutomationReports(1)[0] ?? null
  }
}
