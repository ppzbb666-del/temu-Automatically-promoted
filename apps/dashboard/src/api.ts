import type {
  AutomationDryRunStartInput,
  AutomationDryRunStartResult,
  AutomationDryRunJob,
  AutomationDryRunJobLog,
  AutomationFullFlowJob,
  AutomationFullFlowStartInput,
  AutomationFullFlowStartResult,
  AutomationQueueDaemonHealth,
  AutomationQueueDaemonInput,
  AutomationQueueDaemonState,
  AutomationQueueDaemonTick,
  AutomationRecoveryRun,
  AutomationRecoveryRunStartInput,
  AutomationQueueRunStartInput,
  AutomationQueueRunStartResult,
  AutomationRepairApplyJob,
  AutomationRepairApplyJobLog,
  AutomationRepairApplyStartInput,
  AutomationRepairApplyStartResult,
  AutomationRepairPreviewJob,
  AutomationRepairPreviewJobLog,
  AutomationRepairPreviewStartInput,
  AutomationRepairPreviewStartResult,
  AutomationFillDraftJob,
  AutomationFillDraftJobLog,
  AutomationFillDraftStartInput,
  AutomationFillDraftStartResult,
  AutomationSaveDraftJob,
  AutomationSaveDraftJobLog,
  AutomationSaveDraftStartInput,
  AutomationSaveDraftStartResult,
  AutomationSubmitListingJob,
  AutomationSubmitListingJobLog,
  AutomationSubmitListingStartInput,
  AutomationSubmitListingStartResult,
  AutomationExecutionReport,
  AutomationLaunchPreset,
  AutomationLaunchPresetDeleteResult,
  AutomationLaunchPresetInput,
  AutomationLaunchPresetUpdateInput,
  AutomationManualStepBudgetProofInput,
  AutomationManualStepBudgetProofRecord,
  AutomationManualStepBudgetTrialRequestInput,
  AutomationManualStepBudgetTrialRequestResult,
  AutomationPreflightReport,
  AutomationProfileLockArchiveResult,
  AutomationProfileLockArchiveReadiness,
  AutomationReadiness,
  AutomationTaskFileExportInput,
  AutomationTaskFileExportResult,
  AutomationTaskSnapshotDiffResult,
  AutomationUnattendedStartupCheck,
  BatchDraftRestoreResult,
  CsvImportResult,
  DianxiaomiCollectedProduct,
  DianxiaomiCollectedProductImportResult,
  DianxiaomiListingRequirementRules,
  DianxiaomiProductWorkItem,
  DianxiaomiProductWorkItemRetryAfterFixResult,
  DianxiaomiProductWorkItemTaskResult,
  DraftUpdateInput,
  ManualProductInput,
  PageDebugSnapshot,
  PricingRules,
  ProductUpdateInput,
  PublishTask,
  ReviewDecision,
  PublishCheckResult,
  SelectorConfigRestoreResult,
  SelectorConfigDiffInput,
  SelectorConfigDiffResult,
  SelectorConfigRestoreInput,
  SelectorConfigSaveInput,
  SelectorConfigSaveResult,
  SelectorConfigGenerationResult,
  SelectorConfigStatus,
  SelectorConfigValidationResult,
  SelectorConfigVersion,
  SelectorConfigVersionDiffResult,
  SelectorWorkbench,
  SelectorDiagnosisReport,
  SelectorCalibrationJob,
  SelectorCalibrationJobLog,
  SelectorCalibrationStartInput,
  SelectorCalibrationStartResult,
  DianxiaomiAccountScanImportInput,
  DianxiaomiAccountScanImportResult,
  DianxiaomiAccountScanJob,
  DianxiaomiAccountScanJobLog,
  DianxiaomiAccountScanStartInput,
  DianxiaomiAccountScanStartResult,
  DianxiaomiPageContext,
  DianxiaomiImageCheckJob,
  DianxiaomiImageCheckJobLog,
  DianxiaomiImageCheckStartInput,
  DianxiaomiImageCheckStartResult,
  DianxiaomiStoreMetrics
} from "@temu-ai-ops/shared"

const API_BASE = "http://localhost:8787"

export const csvTemplateUrl = `${API_BASE}/imports/csv-template`

const assertOk = (response: Response, message: string) => {
  if (!response.ok) {
    throw new Error(message)
  }
}

const assertOkWithResponseMessage = async (response: Response, message: string) => {
  if (response.ok) {
    return
  }

  const detail = await response.json().then((body) => typeof body?.message === "string" ? body.message : "").catch(() => "")
  throw new Error(detail ? `${message}: ${detail}` : message)
}

const automationQuery = (input: AutomationDryRunStartInput = {}) => {
  const params = new URLSearchParams()

  for (const key of ["url", "taskFile", "repairPlanFile", "storeId", "storeName", "profile", "screenshots", "selectorConfig", "mediaAutomationMode"] as const) {
    const value = input[key]?.trim()
    if (value) {
      params.set(key, value)
    }
  }

  for (const itemUrl of input.itemUrls ?? []) {
    if (itemUrl.trim()) {
      params.append("itemUrls", itemUrl.trim())
    }
  }

  for (const sourceBucket of input.sourceBuckets ?? []) {
    if (sourceBucket.trim()) {
      params.append("sourceBuckets", sourceBucket.trim())
    }
  }

  if (input.submitAfterSave !== undefined) {
    params.set("submitAfterSave", String(input.submitAfterSave))
  }

  if (input.submitMaxAttempts !== undefined) {
    params.set("submitMaxAttempts", String(input.submitMaxAttempts))
  }

  for (const tool of input.mediaAutomationTools ?? []) {
    if (tool.trim()) {
      params.append("mediaAutomationTools", tool.trim())
    }
  }

  const query = params.toString()
  return query ? `?${query}` : ""
}

export const fetchTasks = async (): Promise<PublishTask[]> => {
  const response = await fetch(`${API_BASE}/tasks`)
  assertOk(response, "任务列表加载失败")
  return response.json()
}

export const fetchActiveTask = async (): Promise<PublishTask | null> => {
  const response = await fetch(`${API_BASE}/tasks/active`)
  assertOk(response, "当前任务加载失败")
  return response.json()
}

export const fetchDebugSnapshots = async (): Promise<PageDebugSnapshot[]> => {
  const response = await fetch(`${API_BASE}/debug-snapshots`)
  assertOk(response, "调试快照加载失败")
  return response.json()
}

export const fetchDianxiaomiCollectedProducts = async (): Promise<DianxiaomiCollectedProduct[]> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/collected-products?limit=100`)
  assertOk(response, "dianxiaomi collected products loading failed")
  return response.json()
}

export const createTaskFromDianxiaomiCollectedProduct = async (id: string): Promise<DianxiaomiCollectedProductImportResult> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/collected-products/${encodeURIComponent(id)}/task`, {
    method: "POST"
  })
  await assertOkWithResponseMessage(response, "dianxiaomi collected product task create failed")
  return response.json()
}

export const fetchDianxiaomiProductWorkItems = async (
  input: Pick<AutomationDryRunStartInput, "storeId" | "storeName" | "itemUrls" | "sourceBuckets"> = {},
  limit = 100
): Promise<DianxiaomiProductWorkItem[]> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/product-work-items?limit=${limit}${automationQuery(input) ? `&${automationQuery(input).slice(1)}` : ""}`)
  assertOk(response, "dianxiaomi product work items loading failed")
  return response.json()
}

export const fetchDianxiaomiPageContext = async (): Promise<DianxiaomiPageContext | null> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/page-context`)
  assertOk(response, "dianxiaomi page context loading failed")
  return response.json()
}

export const fetchDianxiaomiStoreMetrics = async (): Promise<DianxiaomiStoreMetrics[]> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/store-metrics`)
  assertOk(response, "dianxiaomi store metrics loading failed")
  return response.json()
}

export const createTaskFromDianxiaomiProductWorkItem = async (id: string): Promise<DianxiaomiProductWorkItemTaskResult> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/product-work-items/${encodeURIComponent(id)}/task`, {
    method: "POST"
  })
  await assertOkWithResponseMessage(response, "dianxiaomi product work item task create failed")
  return response.json()
}

export const retryDianxiaomiProductWorkItemAfterFix = async (id: string): Promise<DianxiaomiProductWorkItemRetryAfterFixResult> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/product-work-items/${encodeURIComponent(id)}/retry-after-fix`, {
    method: "POST"
  })
  await assertOkWithResponseMessage(response, "dianxiaomi product work item retry-after-fix failed")
  return response.json()
}

export const fetchDianxiaomiRequirementRules = async (): Promise<DianxiaomiListingRequirementRules> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/requirement-rules`)
  assertOk(response, "dianxiaomi requirement rules loading failed")
  return response.json()
}

export const updateDianxiaomiRequirementRules = async (rules: DianxiaomiListingRequirementRules): Promise<DianxiaomiListingRequirementRules> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/requirement-rules`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(rules)
  })
  await assertOkWithResponseMessage(response, "dianxiaomi requirement rules save failed")
  return response.json()
}

export const fetchAutomationReports = async (): Promise<AutomationExecutionReport[]> => {
  const response = await fetch(`${API_BASE}/automation-reports`)
  assertOk(response, "自动化执行报告加载失败")
  return response.json()
}

export const fetchAutomationTaskFileExports = async (): Promise<AutomationTaskFileExportResult[]> => {
  const response = await fetch(`${API_BASE}/automation/task-file-exports`)
  assertOk(response, "automation task file exports loading failed")
  return response.json()
}

export const fetchAutomationTaskFileExportDiff = async (exportId: string): Promise<AutomationTaskSnapshotDiffResult> => {
  const response = await fetch(`${API_BASE}/automation/task-file-exports/${encodeURIComponent(exportId)}/diff`)
  await assertOkWithResponseMessage(response, "automation task file export diff loading failed")
  return response.json()
}

export const fetchAutomationReadiness = async (input: AutomationDryRunStartInput = {}): Promise<AutomationReadiness> => {
  const response = await fetch(`${API_BASE}/automation/readiness${automationQuery(input)}`)
  assertOk(response, "automation readiness loading failed")
  return response.json()
}

export const fetchAutomationPreflight = async (input: AutomationDryRunStartInput = {}): Promise<AutomationPreflightReport> => {
  const response = await fetch(`${API_BASE}/automation/preflight${automationQuery(input)}`)
  assertOk(response, "automation preflight loading failed")
  return response.json()
}

export const fetchAutomationLaunchPresets = async (): Promise<AutomationLaunchPreset[]> => {
  const response = await fetch(`${API_BASE}/automation/presets`)
  assertOk(response, "automation launch presets loading failed")
  return response.json()
}

export const createAutomationLaunchPreset = async (input: AutomationLaunchPresetInput): Promise<AutomationLaunchPreset> => {
  const response = await fetch(`${API_BASE}/automation/presets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "automation launch preset create failed")
  return response.json()
}

export const updateAutomationLaunchPreset = async ({
  id,
  input
}: {
  id: string
  input: AutomationLaunchPresetUpdateInput
}): Promise<AutomationLaunchPreset> => {
  const response = await fetch(`${API_BASE}/automation/presets/${id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "automation launch preset update failed")
  return response.json()
}

export const deleteAutomationLaunchPreset = async (id: string): Promise<AutomationLaunchPresetDeleteResult> => {
  const response = await fetch(`${API_BASE}/automation/presets/${id}`, {
    method: "DELETE"
  })
  await assertOkWithResponseMessage(response, "automation launch preset delete failed")
  return response.json()
}

export const startAutomationDryRun = async (input: AutomationDryRunStartInput = {}): Promise<AutomationDryRunStartResult> => {
  const response = await fetch(`${API_BASE}/automation/dry-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "automation dry run start failed")
  return response.json()
}

export const fetchAutomationDryRunJobs = async (): Promise<AutomationDryRunJob[]> => {
  const response = await fetch(`${API_BASE}/automation/dry-run/jobs`)
  assertOk(response, "automation dry run jobs loading failed")
  return response.json()
}

export const fetchAutomationDryRunJobLog = async (id: string): Promise<AutomationDryRunJobLog> => {
  const response = await fetch(`${API_BASE}/automation/dry-run/jobs/${id}/logs?maxChars=3000`)
  assertOk(response, "automation dry run job log loading failed")
  return response.json()
}

export const startAutomationRepairPreview = async (input: AutomationRepairPreviewStartInput = {}): Promise<AutomationRepairPreviewStartResult> => {
  const response = await fetch(`${API_BASE}/automation/repair-preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "automation repair preview start failed")
  return response.json()
}

export const startDianxiaomiWorkItemRepairPreview = async (id: string, input: AutomationRepairPreviewStartInput = {}): Promise<AutomationRepairPreviewStartResult> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/product-work-items/${encodeURIComponent(id)}/repair-preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "dianxiaomi work item repair preview start failed")
  return response.json()
}

export const fetchAutomationRepairPreviewJobs = async (): Promise<AutomationRepairPreviewJob[]> => {
  const response = await fetch(`${API_BASE}/automation/repair-preview/jobs`)
  assertOk(response, "automation repair preview jobs loading failed")
  return response.json()
}

export const fetchAutomationRepairPreviewJobLog = async (id: string): Promise<AutomationRepairPreviewJobLog> => {
  const response = await fetch(`${API_BASE}/automation/repair-preview/jobs/${id}/logs?maxChars=3000`)
  assertOk(response, "automation repair preview job log loading failed")
  return response.json()
}

export const startAutomationRepairApply = async (input: AutomationRepairApplyStartInput = {}): Promise<AutomationRepairApplyStartResult> => {
  const response = await fetch(`${API_BASE}/automation/repair-apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "automation repair apply start failed")
  return response.json()
}

export const startDianxiaomiWorkItemRepairApply = async (id: string, input: AutomationRepairApplyStartInput = {}): Promise<AutomationRepairApplyStartResult> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/product-work-items/${encodeURIComponent(id)}/repair-apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "dianxiaomi work item repair apply start failed")
  return response.json()
}

export const fetchAutomationRepairApplyJobs = async (): Promise<AutomationRepairApplyJob[]> => {
  const response = await fetch(`${API_BASE}/automation/repair-apply/jobs`)
  assertOk(response, "automation repair apply jobs loading failed")
  return response.json()
}

export const fetchAutomationRepairApplyJob = async (id: string): Promise<AutomationRepairApplyJob> => {
  const response = await fetch(`${API_BASE}/automation/repair-apply/jobs/${encodeURIComponent(id)}`)
  assertOk(response, "automation repair apply job loading failed")
  return response.json()
}

export const fetchAutomationRepairApplyJobLog = async (id: string): Promise<AutomationRepairApplyJobLog> => {
  const response = await fetch(`${API_BASE}/automation/repair-apply/jobs/${id}/logs?maxChars=3000`)
  assertOk(response, "automation repair apply job log loading failed")
  return response.json()
}

export const startAutomationFullFlow = async (input: AutomationFullFlowStartInput = {}): Promise<AutomationFullFlowStartResult> => {
  const response = await fetch(`${API_BASE}/automation/full-flow`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "automation full flow start failed")
  return response.json()
}

export const fetchAutomationFullFlowJobs = async (): Promise<AutomationFullFlowJob[]> => {
  const response = await fetch(`${API_BASE}/automation/full-flow/jobs`)
  assertOk(response, "automation full flow jobs loading failed")
  return response.json()
}

export const startAutomationQueueRun = async (input: AutomationQueueRunStartInput = {}): Promise<AutomationQueueRunStartResult> => {
  const response = await fetch(`${API_BASE}/automation/queue-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "automation queue run start failed")
  return response.json()
}

export const fetchAutomationQueueRuns = async (): Promise<AutomationQueueRunStartResult[]> => {
  const response = await fetch(`${API_BASE}/automation/queue-runs`)
  assertOk(response, "automation queue runs loading failed")
  return response.json()
}

export const startAutomationRecoveryRun = async (input: AutomationRecoveryRunStartInput = {}): Promise<AutomationRecoveryRun> => {
  const response = await fetch(`${API_BASE}/automation/recovery-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "automation recovery run start failed")
  return response.json()
}

export const fetchAutomationRecoveryRuns = async (): Promise<AutomationRecoveryRun[]> => {
  const response = await fetch(`${API_BASE}/automation/recovery-runs`)
  assertOk(response, "automation recovery runs loading failed")
  return response.json()
}

export const fetchAutomationQueueDaemon = async (): Promise<AutomationQueueDaemonState> => {
  const response = await fetch(`${API_BASE}/automation/queue-daemon`)
  assertOk(response, "automation queue daemon loading failed")
  return response.json()
}

export const fetchAutomationQueueDaemonHealth = async (input: AutomationDryRunStartInput = {}): Promise<AutomationQueueDaemonHealth> => {
  const response = await fetch(`${API_BASE}/automation/queue-daemon/health${automationQuery(input)}`)
  assertOk(response, "automation queue daemon health loading failed")
  return response.json()
}

export const fetchProfileLockArchiveReadiness = async (input: AutomationDryRunStartInput = {}): Promise<AutomationProfileLockArchiveReadiness> => {
  const response = await fetch(`${API_BASE}/automation/profile-locks/archive-readiness${automationQuery(input)}`)
  assertOk(response, "profile lock archive readiness loading failed")
  return response.json()
}

export const archiveStaleProfileLocks = async (input: AutomationDryRunStartInput = {}): Promise<AutomationProfileLockArchiveResult> => {
  const response = await fetch(`${API_BASE}/automation/profile-locks/archive`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "profile lock archive failed")
  return response.json()
}

export const fetchManualBudgetProofs = async (): Promise<AutomationManualStepBudgetProofRecord[]> => {
  const response = await fetch(`${API_BASE}/automation/manual-budget/proofs`)
  assertOk(response, "manual budget proofs loading failed")
  return response.json()
}

export const fetchManualBudgetTrials = async (limit = 20): Promise<AutomationManualStepBudgetTrialRequestResult[]> => {
  const response = await fetch(`${API_BASE}/automation/manual-budget/trials?limit=${encodeURIComponent(String(limit))}`)
  assertOk(response, "manual budget trial history loading failed")
  return response.json()
}

export const recordManualBudgetProof = async (input: AutomationManualStepBudgetProofInput): Promise<AutomationManualStepBudgetProofRecord> => {
  const response = await fetch(`${API_BASE}/automation/manual-budget/proofs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "manual budget proof record failed")
  return response.json()
}

export const startManualBudgetTrial = async (input: AutomationManualStepBudgetTrialRequestInput): Promise<AutomationManualStepBudgetTrialRequestResult> => {
  const response = await fetch(`${API_BASE}/automation/manual-budget/trials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "manual budget bounded trial request failed")
  return response.json()
}

export const startNextManualBudgetValidationRun = async (input: AutomationFullFlowStartInput = {}): Promise<AutomationManualStepBudgetTrialRequestResult> => {
  const response = await fetch(`${API_BASE}/automation/manual-budget/validation-runs/next`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "manual budget validation run request failed")
  return response.json()
}

export const fetchAutomationUnattendedStartupCheck = async (input: AutomationDryRunStartInput = {}): Promise<AutomationUnattendedStartupCheck> => {
  const response = await fetch(`${API_BASE}/automation/unattended-startup-check${automationQuery(input)}`)
  assertOk(response, "automation unattended startup check loading failed")
  return response.json()
}

export const startAutomationQueueDaemon = async (input: AutomationQueueDaemonInput = {}): Promise<AutomationQueueDaemonState> => {
  const response = await fetch(`${API_BASE}/automation/queue-daemon/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "automation queue daemon start failed")
  return response.json()
}

export const pauseAutomationQueueDaemon = async (): Promise<AutomationQueueDaemonState> => {
  const response = await fetch(`${API_BASE}/automation/queue-daemon/pause`, {
    method: "POST"
  })
  await assertOkWithResponseMessage(response, "automation queue daemon pause failed")
  return response.json()
}

export const tickAutomationQueueDaemon = async (): Promise<AutomationQueueDaemonTick> => {
  const response = await fetch(`${API_BASE}/automation/queue-daemon/tick`, {
    method: "POST"
  })
  await assertOkWithResponseMessage(response, "automation queue daemon tick failed")
  return response.json()
}

export const startAutomationFillDraft = async (input: AutomationFillDraftStartInput = {}): Promise<AutomationFillDraftStartResult> => {
  const response = await fetch(`${API_BASE}/automation/fill-draft`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "automation fill draft start failed")
  return response.json()
}

export const fetchAutomationFillDraftJobs = async (): Promise<AutomationFillDraftJob[]> => {
  const response = await fetch(`${API_BASE}/automation/fill-draft/jobs`)
  assertOk(response, "automation fill draft jobs loading failed")
  return response.json()
}

export const fetchAutomationFillDraftJobLog = async (id: string): Promise<AutomationFillDraftJobLog> => {
  const response = await fetch(`${API_BASE}/automation/fill-draft/jobs/${id}/logs?maxChars=3000`)
  assertOk(response, "automation fill draft job log loading failed")
  return response.json()
}

export const startAutomationSaveDraft = async (input: AutomationSaveDraftStartInput = {}): Promise<AutomationSaveDraftStartResult> => {
  const response = await fetch(`${API_BASE}/automation/save-draft`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "automation save draft start failed")
  return response.json()
}

export const fetchAutomationSaveDraftJobs = async (): Promise<AutomationSaveDraftJob[]> => {
  const response = await fetch(`${API_BASE}/automation/save-draft/jobs`)
  assertOk(response, "automation save draft jobs loading failed")
  return response.json()
}

export const fetchAutomationSaveDraftJobLog = async (id: string): Promise<AutomationSaveDraftJobLog> => {
  const response = await fetch(`${API_BASE}/automation/save-draft/jobs/${id}/logs?maxChars=3000`)
  assertOk(response, "automation save draft job log loading failed")
  return response.json()
}

export const startAutomationSubmitListing = async (input: AutomationSubmitListingStartInput = {}): Promise<AutomationSubmitListingStartResult> => {
  const response = await fetch(`${API_BASE}/automation/submit-listing`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "automation submit listing start failed")
  return response.json()
}

export const fetchAutomationSubmitListingJobs = async (): Promise<AutomationSubmitListingJob[]> => {
  const response = await fetch(`${API_BASE}/automation/submit-listing/jobs`)
  assertOk(response, "automation submit listing jobs loading failed")
  return response.json()
}

export const fetchAutomationSubmitListingJobLog = async (id: string): Promise<AutomationSubmitListingJobLog> => {
  const response = await fetch(`${API_BASE}/automation/submit-listing/jobs/${id}/logs?maxChars=3000`)
  assertOk(response, "automation submit listing job log loading failed")
  return response.json()
}

export const fetchSelectorDiagnoses = async (): Promise<SelectorDiagnosisReport[]> => {
  const response = await fetch(`${API_BASE}/selector-diagnoses`)
  assertOk(response, "selector diagnosis loading failed")
  return response.json()
}

export const fetchSelectorWorkbench = async (): Promise<SelectorWorkbench> => {
  const response = await fetch(`${API_BASE}/selector-workbench`)
  assertOk(response, "selector workbench loading failed")
  return response.json()
}

export const startSelectorCalibration = async (input: SelectorCalibrationStartInput = {}): Promise<SelectorCalibrationStartResult> => {
  const response = await fetch(`${API_BASE}/selector-calibration`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "selector calibration start failed")
  return response.json()
}

export const fetchSelectorCalibrationJobs = async (): Promise<SelectorCalibrationJob[]> => {
  const response = await fetch(`${API_BASE}/selector-calibration/jobs`)
  assertOk(response, "selector calibration jobs loading failed")
  return response.json()
}

export const fetchSelectorCalibrationJobLog = async (id: string): Promise<SelectorCalibrationJobLog> => {
  const response = await fetch(`${API_BASE}/selector-calibration/jobs/${id}/logs?maxChars=3000`)
  assertOk(response, "selector calibration job log loading failed")
  return response.json()
}

export const startDianxiaomiAccountScan = async (input: DianxiaomiAccountScanStartInput = {}): Promise<DianxiaomiAccountScanStartResult> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/account-scan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "dianxiaomi account scan start failed")
  return response.json()
}

export const fetchDianxiaomiAccountScanJobs = async (): Promise<DianxiaomiAccountScanJob[]> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/account-scan/jobs`)
  assertOk(response, "dianxiaomi account scan jobs loading failed")
  return response.json()
}

export const fetchDianxiaomiAccountScanJob = async (id: string): Promise<DianxiaomiAccountScanJob> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/account-scan/jobs/${encodeURIComponent(id)}`)
  await assertOkWithResponseMessage(response, "dianxiaomi account scan job loading failed")
  return response.json()
}

export const fetchDianxiaomiAccountScanJobLog = async (id: string): Promise<DianxiaomiAccountScanJobLog> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/account-scan/jobs/${id}/logs?maxChars=3000`)
  assertOk(response, "dianxiaomi account scan job log loading failed")
  return response.json()
}

export const importDianxiaomiAccountScanJobLinks = async (
  jobId: string,
  input: DianxiaomiAccountScanImportInput
): Promise<DianxiaomiAccountScanImportResult> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/account-scan/jobs/${encodeURIComponent(jobId)}/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "dianxiaomi account scan import failed")
  return response.json()
}

export const startDianxiaomiImageCheck = async (input: DianxiaomiImageCheckStartInput): Promise<DianxiaomiImageCheckStartResult> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/image-check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "dianxiaomi image check start failed")
  return response.json()
}

export const startDianxiaomiWorkItemImageCheck = async (id: string, input: DianxiaomiImageCheckStartInput = {}): Promise<DianxiaomiImageCheckStartResult> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/product-work-items/${encodeURIComponent(id)}/image-check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "dianxiaomi work item image check start failed")
  return response.json()
}

export const fetchDianxiaomiImageCheckJobs = async (): Promise<DianxiaomiImageCheckJob[]> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/image-check/jobs`)
  assertOk(response, "dianxiaomi image check jobs loading failed")
  return response.json()
}

export const fetchDianxiaomiImageCheckJob = async (id: string): Promise<DianxiaomiImageCheckJob> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/image-check/jobs/${encodeURIComponent(id)}`)
  assertOk(response, "dianxiaomi image check job loading failed")
  return response.json()
}

export const fetchDianxiaomiImageCheckJobLog = async (id: string): Promise<DianxiaomiImageCheckJobLog> => {
  const response = await fetch(`${API_BASE}/dianxiaomi/image-check/jobs/${encodeURIComponent(id)}/logs?maxChars=3000`)
  assertOk(response, "dianxiaomi image check job log loading failed")
  return response.json()
}

export const fetchSelectorConfig = async (): Promise<SelectorConfigStatus> => {
  const response = await fetch(`${API_BASE}/selector-config`)
  assertOk(response, "selector config loading failed")
  return response.json()
}

export const saveSelectorConfig = async (input: SelectorConfigSaveInput): Promise<SelectorConfigSaveResult> => {
  const response = await fetch(`${API_BASE}/selector-config`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "selector config save failed")
  return response.json()
}

export const previewSelectorConfigDiff = async (input: SelectorConfigDiffInput): Promise<SelectorConfigDiffResult> => {
  const response = await fetch(`${API_BASE}/selector-config/diff`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "selector config diff preview failed")
  return response.json()
}

export const fetchSelectorConfigVersions = async (): Promise<SelectorConfigVersion[]> => {
  const response = await fetch(`${API_BASE}/selector-config/versions`)
  assertOk(response, "selector config versions loading failed")
  return response.json()
}

export const fetchSelectorConfigVersionDiff = async (id: string): Promise<SelectorConfigVersionDiffResult> => {
  const response = await fetch(`${API_BASE}/selector-config/versions/${id}/diff`)
  assertOk(response, "selector config version diff loading failed")
  return response.json()
}

export const restoreSelectorConfigVersion = async (id: string): Promise<SelectorConfigRestoreResult> => {
  const response = await fetch(`${API_BASE}/selector-config/versions/${id}/restore`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  })
  await assertOkWithResponseMessage(response, "selector config restore failed")
  return response.json()
}

export const restoreSelectorConfigVersionWithInput = async ({
  id,
  input
}: {
  id: string
  input: SelectorConfigRestoreInput
}): Promise<SelectorConfigRestoreResult> => {
  const response = await fetch(`${API_BASE}/selector-config/versions/${id}/restore`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })
  await assertOkWithResponseMessage(response, "selector config restore failed")
  return response.json()
}

export const fetchSelectorConfigValidation = async (): Promise<SelectorConfigValidationResult> => {
  const response = await fetch(`${API_BASE}/selector-config/validation`)
  assertOk(response, "selector config validation loading failed")
  return response.json()
}

export const generateSelectorConfig = async (): Promise<SelectorConfigGenerationResult> => {
  const response = await fetch(`${API_BASE}/selector-config/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  })
  assertOk(response, "selector config generation failed")
  return response.json()
}

export const fetchPublishCheck = async (taskId: string): Promise<PublishCheckResult> => {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/publish-check`)
  assertOk(response, "发布前检查加载失败")
  return response.json()
}

export const fetchPublishChecks = async (taskIds: string[]): Promise<PublishCheckResult[]> => {
  const response = await fetch(`${API_BASE}/tasks/publish-check/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ taskIds })
  })

  assertOk(response, "batch publish check failed")
  return response.json()
}

export const fetchPricingRules = async (): Promise<PricingRules> => {
  const response = await fetch(`${API_BASE}/pricing-rules`)
  assertOk(response, "核价规则加载失败")
  return response.json()
}

export const updatePricingRules = async (rules: PricingRules): Promise<PricingRules> => {
  const response = await fetch(`${API_BASE}/pricing-rules`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(rules)
  })

  assertOk(response, "核价规则保存失败")
  return response.json()
}

export const importCsvProducts = async (csvText: string): Promise<CsvImportResult> => {
  const response = await fetch(`${API_BASE}/imports/csv`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ csvText })
  })

  assertOk(response, "CSV 商品导入失败")
  return response.json()
}

export const importExcelProducts = async (file: File): Promise<CsvImportResult> => {
  const formData = new FormData()
  formData.append("file", file)

  const response = await fetch(`${API_BASE}/imports/excel`, {
    method: "POST",
    body: formData
  })

  assertOk(response, "Excel 商品导入失败")
  return response.json()
}

export const createManualProductTask = async (input: ManualProductInput): Promise<PublishTask> => {
  const response = await fetch(`${API_BASE}/products/manual`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })

  assertOk(response, "手动商品录入失败")
  return response.json()
}

export const updateTaskProduct = async ({ taskId, input }: { taskId: string; input: ProductUpdateInput }): Promise<PublishTask> => {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/product`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })

  assertOk(response, "商品信息保存失败")
  return response.json()
}

export const updateTaskDraft = async ({ taskId, input }: { taskId: string; input: DraftUpdateInput }): Promise<PublishTask> => {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/draft`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })

  assertOk(response, "草稿内容保存失败")
  return response.json()
}

export const exportAutomationTaskFile = async ({
  taskId,
  input
}: {
  taskId: string
  input: Omit<AutomationTaskFileExportInput, "taskId">
}): Promise<AutomationTaskFileExportResult> => {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/automation-file`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  })

  await assertOkWithResponseMessage(response, "automation task file export failed")
  return response.json()
}

export const restoreTaskDraftVersion = async ({ taskId, versionId }: { taskId: string; versionId: string }): Promise<PublishTask> => {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/draft/restore`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ versionId })
  })

  assertOk(response, "草稿版本恢复失败")
  return response.json()
}

export const restoreLatestAiDraftVersions = async (taskIds: string[]): Promise<BatchDraftRestoreResult> => {
  const response = await fetch(`${API_BASE}/tasks/draft/restore-latest-ai/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ taskIds })
  })

  assertOk(response, "batch draft restore failed")
  return response.json()
}

export const reviewTask = async ({ taskId, decision, note }: { taskId: string; decision: ReviewDecision; note: string }): Promise<PublishTask> => {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/review`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ decision, note })
  })

  assertOk(response, "审核操作失败")
  return response.json()
}

export const reviewTasks = async ({ taskIds, decision, note }: { taskIds: string[]; decision: ReviewDecision; note: string }): Promise<PublishTask[]> => {
  const response = await fetch(`${API_BASE}/tasks/review/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ taskIds, decision, note })
  })

  assertOk(response, "批量审核操作失败")
  return response.json()
}

export const syncActiveTask = async (taskId: string): Promise<PublishTask> => {
  const response = await fetch(`${API_BASE}/tasks/active`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ taskId })
  })

  assertOk(response, "同步插件任务失败")
  return response.json()
}

export const planTask = async (productId: string): Promise<PublishTask> => {
  const response = await fetch(`${API_BASE}/plan/${productId}`, {
    method: "POST"
  })

  assertOk(response, "AI 规划任务失败")
  return response.json()
}
