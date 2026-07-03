import { strict as assert } from "node:assert"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import path from "node:path"

type AutomationMode = "dry-run" | "repair-apply" | "fill-draft" | "save-draft" | "submit-listing"

type StartResult = {
  id: string
  logPath: string
  errorLogPath: string
  targetFingerprint: string
  artifactDir: string
}

type Job = StartResult & {
  status: "running" | "completed" | "failed"
  exitCode: number | null
  error: string | null
  reportPath: string | null
  reportStatus: "completed" | "partial" | "failed" | null
  command?: string | null
}

type FullFlowJob = {
  id: string
  status: "running" | "completed" | "failed"
  startedAt: string
  finishedAt: string | null
  targetFingerprint: string
  artifactDir: string
  workItemId?: string | null
  taskId?: string | null
  taskFile?: string | null
  error: string | null
  stages: Array<{
    name: AutomationMode
    status: "pending" | "running" | "completed" | "failed" | "skipped"
    jobId: string | null
    reportPath: string | null
    reportStatus: "completed" | "partial" | "failed" | null
    startedAt?: string | null
    finishedAt?: string | null
  }>
}

type QueueRunStartResult = {
  id: string
  queued: number
  skipped: number
  flowJobIds: string[]
  skippedItems: Array<{
    workItemId: string
    reason: string
  }>
}

type QueueDaemonState = {
  status: "ACTIVE" | "PAUSED"
  intervalSeconds: number
  maxConsecutiveFailures: number
  running: boolean
  consecutiveFailures: number
  lastError: string | null
  nextRunAt: string | null
  trackedFlowJobIds: string[]
  resolvedFlowJobIds: string[]
  flowOutcomes: QueueDaemonFlowOutcome[]
  ticks: QueueDaemonTick[]
  input: {
    limit?: number
    submitAfterSave?: boolean
    submitMaxAttempts?: number
  }
}

type QueueDaemonTick = {
  id: string
  status: "completed" | "failed" | "skipped"
  category: string
  reason?: string
  error: string | null
  queueRun: QueueRunStartResult | null
  flowOutcomes: QueueDaemonFlowOutcome[]
}

type QueueDaemonFlowOutcome = {
  flowJobId: string
  workItemId: string
  taskId: string | null
  status: "completed" | "failed"
  resolvedAt: string
  note: string
  error: string | null
}

type QueueDaemonHealth = {
  status: "healthy" | "warning" | "blocked"
  issues: Array<{
    id: string
    level: "info" | "warning" | "block"
    message: string
  }>
  alerts: Array<{
    id: string
    level: "info" | "warning" | "block"
    message: string
    action: string
  }>
  queue: {
    daemonStatus: "ACTIVE" | "PAUSED"
    consecutiveFailures: number
    maxConsecutiveFailures: number
    lastFailedCategory: string | null
  }
  recommendation: {
    kind: string
    level: string
    title: string
    detail: string
    action: string
    source: string
    workItemIds: string[]
  }
  workItems: {
    total: number
    ready: number
    blocked: number
    edited: number
    needsRevision: number
    autoRetryCandidates: number
    browserRecoveryCandidates: number
    releasedBrowserRecoveryCandidates: number
    pausedBrowserRecoveryCandidates: number
    publishSucceeded: number
    publishFailed: number
    publishRecoveryCandidates: number
    publishManualBudget: number
  }
  manualBudget: {
    total: number
    publishOutcomes: Array<{
      workItemId: string
      source: string
      reason: string
      operatorAction: string
      releaseCondition: string
    }>
  }
  profile: {
    path: string | null
    exists: boolean
    lockFiles: string[]
  }
  flows: {
    tracked: number
    unresolved: number
    recentFailures: number
  }
  audit: {
    recent: Array<{
      tickId: string
      category: string
      decision: string
      subject: string
      nextAction: string
      workItemIds: string[]
    }>
  }
  recovery: {
    history: number
    repeatedFailures: Array<{
      key: string
      kind: "work-item" | "repair-action"
      count: number
    }>
    paused: Array<{
      key: string
      kind: "work-item" | "repair-action"
      count: number
    }>
    releasedRetryCandidates: Array<{
      workItemId: string
      title: string
      latestReleaseAt: string
    }>
    releasedRetryOutcomes: Array<{
      runId: string
      workItemId: string
      status: string
      nextState: string
      nextAction: string
    }>
    releases: Array<{
      key: string
      kind: "work-item" | "repair-action"
      releaseType: string
      releaseReason: string
    }>
  }
}

type UnattendedStartupCheck = {
  status: "ready" | "warning" | "blocked"
  canStart: boolean
  recommendedAction: string
  checks: Array<{
    id: string
    status: "pass" | "warning" | "block"
    message: string
  }>
  health: QueueDaemonHealth
  normalizedInput: {
    profile?: string
    mediaAutomationMode?: "plan-only" | "unattended-open" | "unattended-apply"
    submitAfterSave?: boolean
    submitMaxAttempts?: number
  }
  runbook: string[]
}

type JobLog = {
  stdout: string
  stderr: string
}

type AutomationPreflightReport = {
  targetFingerprint: string
  overallStatus: "ready" | "warning" | "blocked"
  readyModes: AutomationMode[]
  recommendedMode: AutomationMode | null
  checks: Array<{
    id: string
    status: "pass" | "warning" | "block"
    message: string
  }>
  readiness: {
    dryRun: {
      ready: boolean
      reason: string
    }
    repairApply?: {
      ready: boolean
      reason: string
    }
    fillDraft: {
      ready: boolean
      reason: string
    }
    saveDraft: {
      ready: boolean
      reason: string
    }
    submitListing: {
      ready: boolean
      reason: string
    }
  }
}

type AutomationLaunchPreset = {
  id: string
  name: string
  input: {
    url?: string
    taskFile?: string
    selectorConfig?: string
    profile?: string
    screenshots?: string
    headed?: boolean
    mediaAutomationMode?: "plan-only" | "unattended-open" | "unattended-apply"
    mediaAutomationTools?: string[]
    submitAfterSave?: boolean
  }
}

type AutomationLaunchPresetDeleteResult = {
  id: string
  deleted: boolean
}

type AutomationTaskFileExportResult = {
  exportId: string
  taskId: string
  taskStatus: string
  taskFile: string
  absolutePath: string
  exportedAt: string
  bytes: number
  sha256: string
}

type AutomationTaskSnapshotDiffResult = {
  summary: {
    totalCount: number
    changedCount: number
    addedCount: number
    removedCount: number
    unchangedCount: number
    stale: boolean
  }
  entries: Array<{
    path: string
    status: "unchanged" | "added" | "removed" | "changed"
    currentDisplay: string
    snapshotDisplay: string
  }>
}

type DianxiaomiCollectedProduct = {
  id: string
  title: string
  category: string
  images: string[]
  quality: {
    status: "ready" | "partial" | "poor"
    score: number
  }
  skus: Array<{
    skuName: string
  }>
}

type DianxiaomiCollectedProductImportResult = {
  product: DianxiaomiCollectedProduct
  task: {
    id: string
    product: {
      source: string
      sourceUrl?: string
      title: string
      images?: string[]
      skus?: Array<{
        costCny?: number
      }>
    }
  }
}

type DianxiaomiProductWorkItem = {
  id: string
  source: "dianxiaomi"
  collectedProductId?: string
  title: string
  pageUrl: string
  status: "needs-revision" | "ready-for-automation" | "blocked" | "edited"
  snapshot: {
    imageCount: number
    skuCount: number
    priceFieldCount: number
    stockFieldCount: number
  }
  requirements: {
    summary: {
      requiredTotal: number
      requiredPassed: number
      ready: boolean
    }
    checks: Array<{
      id: string
      ok: boolean
      message: string
    }>
  }
  suggestedEdits: Array<{
    field: string
    priority: "required" | "recommended"
  }>
  failureDiagnosis?: {
    category: string
    source: string
    autoRetryRecommended: boolean
  } | null
  publishOutcome?: {
    status: "not-attempted" | "succeeded" | "failed"
    flowJobId: string
    submitStageJobId: string | null
    attempts: number
    maxAttempts: number
    failureReason: string | null
    route: "published" | "auto-retry" | "browser-recovery" | "manual-budget" | "not-attempted"
  } | null
}

type DianxiaomiProductWorkItemTaskResult = {
  workItem: DianxiaomiProductWorkItem
  task: {
    id: string
    product: {
      source: string
      sourceUrl?: string
      title: string
      images?: string[]
      attributes?: Record<string, string>
      skus?: Array<{
        costCny?: number
      }>
    }
    status: string
    risks: Array<{
      id: string
      level: "low" | "medium" | "high"
    }>
  }
}

type DianxiaomiListingRequirementRules = {
  presetName: string
  title: {
    required: boolean
    minLength: number
    maxLength: number
  }
  images: {
    required: boolean
    minCount: number
  }
  media: {
    required: boolean
    requireImageTranslation: boolean
    requireWhiteBackground: boolean
    requireSizeNormalization: boolean
    requireImageEditorReview: boolean
    targetLanguage: string
    minWidthPx: number
    minHeightPx: number
    maxWidthPx: number
    maxHeightPx: number
    maxSizeMb: number
    dianxiaomiTools: string[]
  }
  sku: {
    required: boolean
    minCount: number
  }
  price: {
    required: boolean
    minEditableFieldCount: number
  }
  stock: {
    required: boolean
    minEditableFieldCount: number
  }
  attributes: {
    required: boolean
    minCount: number
    recommendedKeys: string[]
  }
  compliance: {
    required: boolean
    blockedTerms: string[]
  }
}

type PublishCheckResult = {
  taskId: string
  canPublish: boolean
  issues: Array<{
    id: string
    level: "low" | "medium" | "high"
    message: string
  }>
}

type SelectorCalibrationJob = {
  id: string
  status: "running" | "completed" | "failed"
  exitCode: number | null
  error: string | null
  artifactDir: string
}

type SelectorWorkbench = {
  diagnosis: {
    diagnosisPath: string
    pageUrl: string
    targetSurface?: {
      status: string
      data?: Record<string, unknown>
    }
  } | null
  validation: {
    valid: boolean
    issues: Array<{
      id: string
      level: string
      message: string
    }>
  }
  summary: {
    requiredReadyCount: number
    requiredCount: number
    candidateCount: number
    mediaToolReadyCount?: number
    mediaToolCount?: number
    mediaToolActionReadyCount?: number
    mediaToolActionCount?: number
  }
  items: Array<{
    group: "fields" | "buttons" | "mediaTools"
    key: string
    status: string
    recommendedSelector: string | null
  }>
  mediaTools?: Array<{
    group: "fields" | "buttons" | "mediaTools"
    key: string
    status: string
    recommendedSelector: string | null
  }>
  mediaToolActions?: Array<{
    group: "mediaToolActions"
    key: string
    status: string
    recommendedSelector: string | null
  }>
  skuRows: {
    diagnosisCount: number
    diagnosisOk: boolean
    status: string
  }
}

const selectorConfigFromWorkbench = (workbench: SelectorWorkbench): DianxiaomiSelectorConfig => ({
  fields: Object.fromEntries(
    workbench.items
      .filter((item) => item.group === "fields")
      .map((item) => [item.key, item.recommendedSelector ? [item.recommendedSelector] : []])
  ),
  buttons: Object.fromEntries(
    workbench.items
      .filter((item) => item.group === "buttons")
      .map((item) => [item.key, item.recommendedSelector ? [item.recommendedSelector] : []])
  ),
  mediaTools: Object.fromEntries(
    (workbench.mediaTools ?? [])
      .map((item) => [item.key, item.recommendedSelector ? [item.recommendedSelector] : []])
  ),
  mediaToolActions: {
    apply: Object.fromEntries(
      (workbench.mediaToolActions ?? [])
        .filter((item) => item.key.startsWith("apply."))
        .map((item) => [item.key.replace("apply.", ""), item.recommendedSelector ? [item.recommendedSelector] : []])
    ),
    close: Object.fromEntries(
      (workbench.mediaToolActions ?? [])
        .filter((item) => item.key.startsWith("close."))
        .map((item) => [item.key.replace("close.", ""), item.recommendedSelector ? [item.recommendedSelector] : []])
    )
  },
  skuRows: workbench.skuRows.diagnosisOk ? [defaultSkuRowSelector] : []
})

const selectorConfigEquals = (left: DianxiaomiSelectorConfig, right: DianxiaomiSelectorConfig) =>
  JSON.stringify(left) === JSON.stringify(right)

const assertSelectorConfigEquals = (actual: DianxiaomiSelectorConfig, expected: DianxiaomiSelectorConfig, message: string) => {
  assert(selectorConfigEquals(actual, expected), `${message}\nactual: ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`)
}

type DianxiaomiSelectorConfig = {
  fields: Record<string, string[]>
  buttons: Record<string, string[]>
  mediaTools?: Record<string, string[]>
  mediaToolActions?: Record<string, Record<string, string[]>>
  skuRows: string[]
}

type SelectorConfigStatus = {
  exists: boolean
  config: DianxiaomiSelectorConfig | null
}

type SelectorConfigVersion = {
  id: string
  config: DianxiaomiSelectorConfig
}

type SelectorConfigSaveResult = {
  version: SelectorConfigVersion | null
  config: DianxiaomiSelectorConfig
}

type SelectorConfigRestoreResult = {
  restoredVersion: SelectorConfigVersion
  config: DianxiaomiSelectorConfig
}

type SelectorConfigGenerationResult = {
  config: DianxiaomiSelectorConfig
}

type SelectorConfigDiffResult = {
  version?: SelectorConfigVersion
  requiresConfirmation: boolean
  blocked: boolean
  entries: Array<{
    group: "fields" | "buttons" | "mediaTools" | "skuRows"
    key: string
    status: "unchanged" | "added" | "removed" | "changed"
    addedSelectors: string[]
    removedSelectors: string[]
  }>
  summary: {
    totalCount: number
    changedCount: number
    addedCount: number
    removedCount: number
    unchangedCount: number
    confirmRiskCount: number
    blockRiskCount: number
  }
}

type ExecutionReport = {
  id: string
  status: "completed" | "partial" | "failed"
  steps: Array<{
    id: string
    status: string
    data?: Record<string, unknown>
    detail?: string
  }>
}

const repoRoot = path.resolve(process.cwd(), "../..")
const resolveSmokePort = async () => {
  if (process.env.SMOKE_PORT) {
    return Number(process.env.SMOKE_PORT)
  }

  const server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("smoke test could not resolve a free TCP port"))
        return
      }
      resolve(address.port)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  return port
}
const port = await resolveSmokePort()
const baseUrl = `http://127.0.0.1:${port}`
const runId = new Date().toISOString().replace(/[:.]/g, "-")
const smokeRoot = `.runtime/automation-safety-smoke/${runId}`
const fixturePath = path.join(repoRoot, ".runtime/dianxiaomi-dry-run-fixture.html")
const taskFile = ".runtime/dianxiaomi-dry-run-task.json"
const repairPlanFile = ".runtime/dianxiaomi-repair-apply-plan.json"
const repairPlanPath = path.join(repoRoot, repairPlanFile)
const selectorConfig = ".runtime/dianxiaomi-selector-config.json"
const selectorConfigPath = path.join(repoRoot, selectorConfig)
const plannerStatePath = path.join(repoRoot, ".runtime/data/planner-state.json")
const defaultSkuRowSelector = "tr, [role='row'], [class*='sku' i], [class*='table-row' i], [class*='row' i]"
const wrongSurfaceUrl = `data:text/html;charset=utf-8,${encodeURIComponent("<!doctype html><html><head><title>Dianxiaomi Empty Fixture</title></head><body><main><h1>No product found</h1><p>There are no products on this page.</p></main></body></html>")}`
const smokeOnly = new Set(
  (process.env.SMOKE_ONLY ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const shouldRunSmokeStep = (id: string) => smokeOnly.size === 0 || smokeOnly.has(id)

const firstConfiguredSelector = (
  config: DianxiaomiSelectorConfig,
  group: "fields" | "buttons",
  key: string,
  fallback: string
) => config[group]?.[key]?.[0] ?? fallback

const selectorCandidate = (selectorHint: string, text: string) => ({
  selectorHint,
  score: 10,
  text
})

const writeBootstrapSelectorDiagnosis = (createdAtOffsetMs = 0) => {
  const diagnosisDir = path.join(repoRoot, smokeRoot)
  mkdirSync(diagnosisDir, {
    recursive: true
  })

  const config = JSON.parse(readFileSync(selectorConfigPath, "utf8")) as DianxiaomiSelectorConfig
  const diagnosisPath = path.join(diagnosisDir, `dianxiaomi-diagnosis-${runId}-bootstrap.json`)
  writeFileSync(diagnosisPath, JSON.stringify({
    pageUrl: "data:fixture",
    pageTitle: "Dianxiaomi Dry Run Fixture",
    createdAt: new Date(Date.now() + createdAtOffsetMs).toISOString(),
    requiredOk: true,
    targetSurface: {
      id: "target-surface",
      label: "Target surface",
      status: "done",
      detail: "Smoke bootstrap diagnosis recognized the Dianxiaomi fixture surface.",
      data: {
        pageUrl: "data:fixture",
        pageTitle: "Dianxiaomi Dry Run Fixture",
        host: "",
        isDianxiaomiHost: false,
        isDataFixture: true,
        loginOrCaptchaDetected: false,
        surfaceStatus: "fixture",
        canWrite: true,
        canInspect: true
      }
    },
    summary: {
      fieldCount: 4,
      buttonCount: 2,
      mediaToolCount: 0,
      skuRowCount: 1
    },
    fields: {
      title: {
        ok: true,
        candidates: [selectorCandidate(firstConfiguredSelector(config, "fields", "title", "input[name='title']"), "title")]
      },
      description: {
        ok: true,
        candidates: []
      },
      price: {
        ok: true,
        candidates: [selectorCandidate(firstConfiguredSelector(config, "fields", "price", "input[name='price']"), "price")]
      },
      stock: {
        ok: true,
        candidates: [selectorCandidate(firstConfiguredSelector(config, "fields", "stock", "input[name='stock']"), "stock")]
      },
      attribute: {
        ok: true,
        candidates: [selectorCandidate(firstConfiguredSelector(config, "fields", "attribute", "input[name='variationSku']"), "attribute")]
      }
    },
    buttons: {
      save: {
        ok: true,
        candidates: [selectorCandidate(firstConfiguredSelector(config, "buttons", "save", "button:has-text('保存')"), "save")]
      },
      submit: {
        ok: true,
        candidates: [selectorCandidate(firstConfiguredSelector(config, "buttons", "submit", "button:has-text('发布')"), "submit")]
      }
    },
    mediaTools: {
      imageTranslation: { ok: false, candidates: [] },
      whiteBackground: { ok: false, candidates: [] },
      imageEditor: { ok: false, candidates: [] },
      batchResize: { ok: false, candidates: [] },
      imageManagement: { ok: false, candidates: [] }
    },
    mediaToolActions: {
      apply: {
        imageTranslation: { ok: false, candidates: [] },
        whiteBackground: { ok: false, candidates: [] },
        imageEditor: { ok: false, candidates: [] },
        batchResize: { ok: false, candidates: [] },
        imageManagement: { ok: false, candidates: [] }
      },
      close: {
        imageTranslation: { ok: false, candidates: [] },
        whiteBackground: { ok: false, candidates: [] },
        imageEditor: { ok: false, candidates: [] },
        batchResize: { ok: false, candidates: [] },
        imageManagement: { ok: false, candidates: [] }
      }
    },
    skuRows: {
      ok: true,
      count: 1,
      samples: []
    }
  }, null, 2), "utf8")
}

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init)
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} failed: ${response.status} ${body}`)
  }

  return body ? JSON.parse(body) as T : undefined as T
}

const requestStatus = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init)
  await response.text()
  return response.status
}

const writeRepairApplyFixturePlan = () => {
  writeFileSync(repairPlanPath, JSON.stringify({
    workItemId: `smoke-repair-apply-${runId}`,
    pageUrl: "data:fixture",
    pageTitle: "Dianxiaomi Dry Run Fixture",
    exportedAt: new Date().toISOString(),
    repairPlan: {
      status: "assisted",
      source: "combined",
      summary: "repair title, description, attribute, sku, and one media tool",
      canAutoRepair: false,
      canRetryAfterRepair: true,
      blockers: [],
      createdAt: new Date().toISOString(),
      actions: [
        {
          id: "title",
          type: "fix-field",
          label: "title",
          detail: "known title value",
          automation: "assisted",
          required: true,
          field: "title",
          target: "title",
          payload: {
            writer: "fill-single-field",
            selectorGroup: "fields",
            selectorKey: "title",
            fieldKind: "title",
            reasonCode: "smoke-title"
          }
        },
        {
          id: "description",
          type: "fix-field",
          label: "description",
          detail: "known description value",
          automation: "assisted",
          required: true,
          field: "description",
          target: "description",
          payload: {
            writer: "fill-single-field",
            selectorGroup: "fields",
            selectorKey: "description",
            fieldKind: "description",
            reasonCode: "smoke-description"
          }
        },
        {
          id: "color",
          type: "fix-field",
          label: "color",
          detail: "known color attribute",
          automation: "assisted",
          required: true,
          field: "attribute",
          target: "color",
          payload: {
            writer: "fill-attributes",
            selectorGroup: "fields",
            selectorKey: "attribute",
            fieldKind: "attribute",
            attributeKey: "color",
            reasonCode: "smoke-attribute"
          }
        },
        {
          id: "sku",
          type: "fix-field",
          label: "sku price stock",
          detail: "known SKU values",
          automation: "assisted",
          required: true,
          field: "sku",
          target: "skuRows",
          payload: {
            writer: "fill-sku-pricing",
            selectorGroup: "skuRows",
            selectorKey: "skuRows",
            skuMode: "price-stock",
            reasonCode: "smoke-sku"
          }
        },
        {
          id: "batch-resize",
          type: "retry-transient",
          label: "batch resize",
          detail: "产品图 尺寸",
          automation: "auto",
          required: true,
          field: "image",
          target: "batchResize",
          tool: "batchResize",
          payload: {
            writer: "run-media-tool",
            selectorGroup: "mediaTools",
            selectorKey: "batchResize",
            mediaTool: "batchResize",
            expectedValue: "产品图 尺寸",
            reasonCode: "requirement-image-check"
          }
        },
        {
          id: "manual",
          type: "manual-session",
          label: "manual action",
          detail: "must remain skipped",
          automation: "manual",
          required: true,
          payload: {
            writer: "manual",
            reasonCode: "smoke-manual"
          }
        }
      ]
    }
  }, null, 2), "utf8")
}

const expectPreflight = async () => {
  const report = await requestJson<AutomationPreflightReport>(
    `${baseUrl}/automation/preflight?taskFile=${encodeURIComponent(taskFile)}&selectorConfig=${encodeURIComponent(selectorConfig)}`
  )

  assert(report.targetFingerprint, "automation preflight should include a target fingerprint")
  assert(report.readyModes.includes("dry-run"), "automation preflight should mark dry-run as ready")
  assert.equal(report.recommendedMode, "dry-run", "automation preflight should recommend dry-run before staged reports exist")
  assert.equal(report.readiness.dryRun.ready, true, "automation preflight should include dry-run readiness")
  assert.equal(report.readiness.fillDraft.ready, false, "automation preflight should include fill-draft gate")
  assert.equal(report.readiness.saveDraft.ready, false, "automation preflight should include save-draft gate")
  assert.equal(report.readiness.submitListing.ready, false, "automation preflight should include submit-listing gate")
  assert(report.checks.some((check) => check.id === "task-source" && check.status === "pass"), "automation preflight should pass when a task file is provided")
  assert(report.checks.some((check) => check.id === "selector-validation"), "automation preflight should include selector validation")
  assert(report.checks.some((check) => check.id === "mode-fill-draft" && check.status === "block"), "automation preflight should include blocked fill-draft before dry-run")
  assert(report.checks.some((check) => check.id === "mode-submit-listing" && check.status === "block"), "automation preflight should include blocked submit-listing before save-draft")

  const repairReport = await requestJson<AutomationPreflightReport>(
    `${baseUrl}/automation/preflight?taskFile=${encodeURIComponent(taskFile)}&repairPlanFile=${encodeURIComponent(repairPlanFile)}&selectorConfig=${encodeURIComponent(selectorConfig)}`
  )
  assert.equal(repairReport.readiness.repairApply?.ready, true, "automation preflight should mark repair-apply ready when a repair plan file is provided")
  assert(repairReport.readyModes.includes("repair-apply"), "automation preflight should include repair-apply in ready modes")
  assert(repairReport.checks.some((check) => check.id === "mode-repair-apply" && check.status === "pass"), "automation preflight should include repair-apply readiness")
}

const expectAutomationPresets = async () => {
  const presetName = `smoke preset ${runId}`
  const created = await requestJson<AutomationLaunchPreset>(`${baseUrl}/automation/presets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: presetName,
      input: {
        url: "https://example.com/dianxiaomi",
        taskFile,
        selectorConfig,
        profile: `${smokeRoot}/preset-profile`,
        screenshots: `${smokeRoot}/preset-shots`,
        headed: false,
        mediaAutomationMode: "unattended-apply",
        mediaAutomationTools: ["image-translation"]
      }
    })
  })
  assert(created.id, "automation preset create should return an id")
  assert.equal(created.name, presetName, "automation preset create should persist the name")
  assert.equal(created.input.headed, false, "automation preset create should persist headed=false")
  assert.equal(created.input.mediaAutomationMode, "unattended-apply", "automation preset create should persist unattended-apply media mode")
  assert.deepEqual(created.input.mediaAutomationTools, ["image-translation"], "automation preset create should persist media automation tools")

  const presets = await requestJson<AutomationLaunchPreset[]>(`${baseUrl}/automation/presets`)
  assert(presets.some((preset) => preset.id === created.id), "automation preset list should include the created preset")

  const updated = await requestJson<AutomationLaunchPreset>(`${baseUrl}/automation/presets/${created.id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: `${presetName} updated`,
      input: {
        ...created.input,
        url: "https://example.com/dianxiaomi-updated",
        headed: true,
        mediaAutomationMode: "unattended-open",
        mediaAutomationTools: ["batch-resize"]
      }
    })
  })
  assert.equal(updated.name, `${presetName} updated`, "automation preset update should persist the new name")
  assert.equal(updated.input.url, "https://example.com/dianxiaomi-updated", "automation preset update should persist the new url")
  assert.equal(updated.input.headed, true, "automation preset update should persist headed=true")
  assert.equal(updated.input.mediaAutomationMode, "unattended-open", "automation preset update should persist media mode changes")
  assert.deepEqual(updated.input.mediaAutomationTools, ["batch-resize"], "automation preset update should persist media tool changes")

  const deleted = await requestJson<AutomationLaunchPresetDeleteResult>(`${baseUrl}/automation/presets/${created.id}`, {
    method: "DELETE"
  })
  assert.equal(deleted.deleted, true, "automation preset delete should report success")

  const afterDelete = await requestJson<AutomationLaunchPreset[]>(`${baseUrl}/automation/presets`)
  assert(!afterDelete.some((preset) => preset.id === created.id), "automation preset delete should remove the preset from the list")
}

const expectTaskFileExport = async () => {
  const task = await requestJson<{ id: string; draft: { listingTitle: string } }>(`${baseUrl}/products/manual`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: `Smoke snapshot product ${runId}`,
      category: "Smoke test",
      supplierPriceCny: 12.5,
      estimatedDomesticShippingCny: 1.2,
      estimatedWeightKg: 0.2,
      stock: 10,
      skuName: "Smoke SKU",
      sourceUrl: "https://example.com/smoke-snapshot",
      attributes: {
        color: "black"
      },
      images: ["https://example.com/smoke-snapshot.jpg"]
    })
  })
  assert(task?.id, "automation task file export smoke requires at least one server task")
  const outputPath = `${smokeRoot}/exported-task.json`
  const exported = await requestJson<AutomationTaskFileExportResult>(`${baseUrl}/tasks/${task.id}/automation-file`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      outputPath
    })
  })
  assert.equal(exported.taskId, task.id, "automation task file export should identify the exported task")
  assert.equal(exported.taskFile, outputPath, "automation task file export should return the requested relative path")
  assert(exported.exportId, "automation task file export should return an export id")
  assert(exported.bytes > 0, "automation task file export should return the written byte size")
  assert.match(exported.sha256, /^[a-f0-9]{64}$/, "automation task file export should return a sha256")
  assert(existsSync(exported.absolutePath), "automation task file export should create the JSON file")

  const exportedTask = JSON.parse(readFileSync(exported.absolutePath, "utf8")) as { id: string }
  assert.equal(exportedTask.id, task.id, "automation task file export should write the selected task JSON")

  const exports = await requestJson<AutomationTaskFileExportResult[]>(`${baseUrl}/automation/task-file-exports`)
  assert(exports.some((item) => item.exportId === exported.exportId), "automation task file export history should include the latest export")

  const freshDiff = await requestJson<AutomationTaskSnapshotDiffResult>(`${baseUrl}/automation/task-file-exports/${exported.exportId}/diff`)
  assert.equal(freshDiff.summary.stale, false, "automation task file snapshot diff should be fresh immediately after export")
  assert.equal(freshDiff.summary.changedCount + freshDiff.summary.addedCount + freshDiff.summary.removedCount, 0, "automation task file snapshot diff should have no changes immediately after export")
  assert(freshDiff.summary.totalCount > 0, "automation task file snapshot diff should compare task fields")

  const changedTitle = `${task.draft.listingTitle} smoke snapshot change`
  await requestJson(`${baseUrl}/tasks/${task.id}/draft`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      listingTitle: changedTitle
    })
  })

  const staleDiff = await requestJson<AutomationTaskSnapshotDiffResult>(`${baseUrl}/automation/task-file-exports/${exported.exportId}/diff`)
  assert.equal(staleDiff.summary.stale, true, "automation task file snapshot diff should become stale after task edits")
  assert(staleDiff.summary.changedCount > 0, "automation task file snapshot diff should count changed fields after task edits")
  assert(
    staleDiff.entries.some((entry) =>
      entry.path === "draft.listingTitle"
        && entry.status === "changed"
        && entry.currentDisplay === changedTitle
        && entry.snapshotDisplay === task.draft.listingTitle
    ),
    "automation task file snapshot diff should include listing title changes"
  )

  const stalePreflight = await requestJson<AutomationPreflightReport>(
    `${baseUrl}/automation/preflight?taskFile=${encodeURIComponent(outputPath)}&selectorConfig=${encodeURIComponent(selectorConfig)}`
  )
  assert.equal(stalePreflight.overallStatus, "blocked", "stale tracked task files should contribute a preflight warning while staged gates still block writes")
  assert(
    stalePreflight.checks.some((check) =>
      check.id === "task-source"
        && check.status === "warning"
        && check.message.includes("stale")
    ),
    "stale tracked task files should be shown in the task-source preflight check"
  )
  assert.equal(stalePreflight.readiness.fillDraft.ready, false, "stale tracked task files should block fill-draft readiness")
  assert.match(stalePreflight.readiness.fillDraft.reason, /stale/, "fill-draft readiness should explain stale task file snapshots")
  assert.equal(stalePreflight.readiness.saveDraft.ready, false, "stale tracked task files should block save-draft readiness")
}

const expectDianxiaomiCollectedProductImport = async () => {
  const collected = await requestJson<DianxiaomiCollectedProduct>(`${baseUrl}/dianxiaomi/collected-products`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: `dxm-smoke-${runId}`,
      pageUrl: "https://www.dianxiaomi.com/product/edit/smoke",
      pageTitle: "Smoke Dianxiaomi Product",
      collectedAt: new Date().toISOString(),
      title: `Dianxiaomi smoke product ${runId}`,
      category: "Dianxiaomi smoke category",
      sourceUrl: "https://www.dianxiaomi.com/product/edit/smoke",
      images: ["https://example.com/dxm-smoke.jpg"],
      attributes: {
        color: "black"
      },
      skus: [{
        skuName: "Black M",
        priceCny: 15.5,
        stock: 12,
        attributes: {
          size: "M"
        },
        rowText: "Black M 15.5 12"
      }],
      rawTextSample: "Dianxiaomi smoke product raw text",
      notes: ["smoke"]
    })
  })
  assert.equal(collected.title, `Dianxiaomi smoke product ${runId}`, "dianxiaomi collected product upload should persist title")
  assert.equal(collected.skus.length, 1, "dianxiaomi collected product upload should persist skus")
  assert.equal(collected.quality.status, "ready", "dianxiaomi collected product upload should compute collection quality")
  assert(collected.quality.score >= 80, "dianxiaomi collected product upload should score complete captures highly")

  const collectedProducts = await requestJson<DianxiaomiCollectedProduct[]>(`${baseUrl}/dianxiaomi/collected-products`)
  assert(collectedProducts.some((item) => item.id === collected.id), "dianxiaomi collected product list should include uploaded product")

  const imported = await requestJson<DianxiaomiCollectedProductImportResult>(`${baseUrl}/dianxiaomi/collected-products/${collected.id}/task`, {
    method: "POST"
  })
  assert.equal(imported.product.id, collected.id, "dianxiaomi collected product task import should identify source product")
  assert.equal(imported.task.product.source, "dianxiaomi", "dianxiaomi collected product task import should mark product source")
  assert.equal(imported.task.product.title, collected.title, "dianxiaomi collected product task import should preserve title")
  assert.deepEqual(imported.task.product.images, collected.images, "dianxiaomi collected product task import should preserve images")
}

const expectDianxiaomiProductWorkQueue = async () => {
  const workItem = await requestJson<DianxiaomiProductWorkItem>(`${baseUrl}/dianxiaomi/product-work-items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: `dxm-work-smoke-${runId}`,
      pageUrl: "https://www.dianxiaomi.com/product/edit/work-smoke",
      pageTitle: "Smoke Dianxiaomi Work Item",
      pageProfile: "Dianxiaomi product edit",
      title: `DXM work item ${runId}`,
      rawTextSample: "short listing with missing images and no SKU rows",
      notes: ["smoke work queue"],
      snapshot: {
        hasTitle: true,
        imageCount: 0,
        skuCount: 0,
        priceFieldCount: 0,
        stockFieldCount: 0,
        attributeKeys: []
      }
    })
  })

  assert.equal(workItem.source, "dianxiaomi", "work queue item should keep Dianxiaomi as source of truth")
  assert.equal(workItem.status, "needs-revision", "incomplete Dianxiaomi items should require edits before automation")
  assert.equal(workItem.requirements.summary.ready, false, "missing required fields should block readiness")
  assert(workItem.requirements.checks.some((check) => check.id === "images-present" && !check.ok), "work queue should require product images")
  assert(workItem.requirements.checks.some((check) => check.id === "sku-present" && !check.ok), "work queue should require SKU rows")
  assert(workItem.suggestedEdits.some((edit) => edit.field === "image" && edit.priority === "required"), "missing images should create a required edit")

  const workItems = await requestJson<DianxiaomiProductWorkItem[]>(`${baseUrl}/dianxiaomi/product-work-items`)
  assert(workItems.some((item) => item.id === workItem.id), "work queue list should include uploaded item")

  const updatedWorkItem = await requestJson<DianxiaomiProductWorkItem>(`${baseUrl}/dianxiaomi/product-work-items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: `dxm-work-smoke-duplicate-${runId}`,
      pageUrl: "https://www.dianxiaomi.com/product/edit/work-smoke#rescan",
      pageTitle: "Smoke Dianxiaomi Work Item Rescan",
      pageProfile: "Dianxiaomi product edit",
      title: `DXM work item rescanned ${runId}`,
      rawTextSample: "complete listing without restricted terms",
      notes: ["smoke work queue rescan"],
      snapshot: {
        hasTitle: true,
        imageCount: 3,
        skuCount: 2,
        priceFieldCount: 2,
        stockFieldCount: 2,
        attributeKeys: ["color", "size"],
        imageStats: {
          minWidthPx: 1000,
          minHeightPx: 1000,
          maxWidthPx: 1200,
          maxHeightPx: 1200,
          unknownDimensionCount: 0
        },
        mediaToolSignals: ["image translation", "Xiaomi image editor"]
      }
    })
  })
  assert.equal(updatedWorkItem.id, workItem.id, "same Dianxiaomi page URL should update the existing queue item")
  assert.equal(updatedWorkItem.status, "ready-for-automation", "rescanned complete item should become automation-ready")
  assert.equal(updatedWorkItem.requirements.summary.ready, true, "rescanned complete item should pass required checks")
  assert.equal(updatedWorkItem.suggestedEdits.filter((edit) => edit.priority === "required").length, 0, "ready item should not keep required edit suggestions")

  const afterUpdateWorkItems = await requestJson<DianxiaomiProductWorkItem[]>(`${baseUrl}/dianxiaomi/product-work-items`)
  assert.equal(afterUpdateWorkItems.filter((item) => item.pageUrl.includes("/work-smoke")).length, 1, "work queue should not duplicate the same Dianxiaomi page")

  const taskResult = await requestJson<DianxiaomiProductWorkItemTaskResult>(`${baseUrl}/dianxiaomi/product-work-items/${workItem.id}/task`, {
    method: "POST"
  })
  assert.equal(taskResult.workItem.id, workItem.id, "work queue task create should identify source item")
  assert.equal(taskResult.task.product.source, "dianxiaomi", "work queue task should keep Dianxiaomi source")
  assert.equal(taskResult.task.product.sourceUrl, updatedWorkItem.pageUrl, "work queue task should point back to latest Dianxiaomi page")
  assert.equal(taskResult.task.product.attributes?.dianxiaomiWorkItemId, workItem.id, "work queue task should retain work item linkage metadata")
  assert.equal(taskResult.task.draft.skuPricing[0]?.salePriceUsd, 999, "work queue task should default Dianxiaomi declared price to 999")
  assert.equal(taskResult.task.draft.skuPricing[0]?.stock, 20, "work queue task should default Dianxiaomi stock to 20")

  const linkedCollected = await requestJson<DianxiaomiCollectedProduct>(`${baseUrl}/dianxiaomi/collected-products`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: `dxm-linked-${runId}`,
      pageUrl: "https://www.dianxiaomi.com/product/edit/work-smoke",
      pageTitle: "Linked Dianxiaomi Product",
      collectedAt: new Date().toISOString(),
      title: `Linked Dianxiaomi product ${runId}`,
      category: "Linked Dianxiaomi category",
      sourceUrl: "https://www.dianxiaomi.com/product/edit/work-smoke",
      images: ["https://example.com/dxm-linked.jpg"],
      attributes: {
        color: "green"
      },
      skus: [{
        skuName: "Green L",
        priceCny: 18.2,
        stock: 7,
        attributes: {
          size: "L"
        },
        rowText: "Green L 18.2 7"
      }],
      rawTextSample: "linked dianxiaomi product raw text",
      notes: ["linked"]
    })
  })
  const linkedWorkItem = await requestJson<DianxiaomiProductWorkItem>(`${baseUrl}/dianxiaomi/product-work-items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: `dxm-work-linked-${runId}`,
      collectedProductId: linkedCollected.id,
      pageUrl: "https://www.dianxiaomi.com/product/edit/work-linked",
      pageTitle: "Linked work item page",
      pageProfile: "Dianxiaomi product edit",
      title: `Linked work item ${runId}`,
      rawTextSample: "complete listing with linked collected product",
      notes: ["linked work item"],
      snapshot: {
        hasTitle: true,
        imageCount: 2,
        skuCount: 1,
        priceFieldCount: 1,
        stockFieldCount: 1,
        attributeKeys: ["color", "size"],
        mediaToolSignals: ["image translation", "Xiaomi image editor"]
      },
      status: "ready-for-automation"
    })
  })
  const linkedTaskResult = await requestJson<DianxiaomiProductWorkItemTaskResult>(`${baseUrl}/dianxiaomi/product-work-items/${linkedWorkItem.id}/task`, {
    method: "POST"
  })
  assert.equal(linkedTaskResult.task.product.title, linkedCollected.title, "linked work item task should use collected product title")
  assert.equal(linkedTaskResult.task.product.sourceUrl, linkedWorkItem.pageUrl, "linked work item task should still target the current work item page")
  assert.deepEqual(linkedTaskResult.task.product.images, linkedCollected.images, "linked work item task should carry collected product images")
  assert.equal(linkedTaskResult.task.product.skus?.[0]?.costCny, 18.2, "linked work item task should carry collected product SKU price")
  assert.equal(linkedTaskResult.task.product.attributes?.color, "green", "linked work item task should carry collected product attributes")
  assert.deepEqual(linkedTaskResult.task.draft.attributes, {
    color: "green",
    size: "L",
    dianxiaomiWorkItemId: linkedWorkItem.id,
    dianxiaomiPageUrl: linkedWorkItem.pageUrl,
    dianxiaomiRequirementPreset: "temu-basic-listing-readiness",
    dianxiaomiCollectedProductId: linkedCollected.id
  }, "linked work item draft should keep collected Dianxiaomi attributes plus linkage metadata")
  assert(!("usage" in linkedTaskResult.task.draft.attributes), "linked work item draft should not inject generated usage attributes")
  assert(!("package" in linkedTaskResult.task.draft.attributes), "linked work item draft should not inject generated package attributes")
  assert(!("source" in linkedTaskResult.task.draft.attributes), "linked work item draft should not inject generated source attributes")
  assert.equal(linkedTaskResult.task.draft.skuPricing[0]?.salePriceUsd, 999, "linked work item draft should default declared price to 999")
  assert.equal(linkedTaskResult.task.draft.skuPricing[0]?.stock, 20, "linked work item draft should default stock to 20")
  assert.deepEqual(linkedTaskResult.task.draft.skuPricing[0]?.attributes, {
    color: "green",
    size: "L",
    dianxiaomiWorkItemId: linkedWorkItem.id,
    dianxiaomiPageUrl: linkedWorkItem.pageUrl,
    dianxiaomiRequirementPreset: "temu-basic-listing-readiness",
    dianxiaomiCollectedProductId: linkedCollected.id
  }, "linked work item draft SKU attributes should keep collected values plus linkage metadata")

  const chineseCollected = await requestJson<DianxiaomiCollectedProduct>(`${baseUrl}/dianxiaomi/collected-products`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: `dxm-linked-cn-${runId}`,
      pageUrl: "https://www.dianxiaomi.com/product/edit/work-linked-cn",
      pageTitle: "Linked Chinese Dianxiaomi Product",
      collectedAt: new Date().toISOString(),
      title: "女士情趣内衣连体衣睡衣套装",
      category: "女士情趣服装",
      sourceUrl: "https://www.dianxiaomi.com/product/edit/work-linked-cn",
      images: ["https://example.com/dxm-linked-cn.jpg"],
      attributes: {
        material: "polyester"
      },
      skus: [{
        skuName: "White S",
        priceCny: 21.5,
        stock: 9,
        attributes: {
          size: "S"
        },
        rowText: "White S 21.5 9"
      }],
      rawTextSample: "complete linked dianxiaomi product with Chinese source title",
      notes: ["linked-cn"]
    })
  })
  const chineseWorkItem = await requestJson<DianxiaomiProductWorkItem>(`${baseUrl}/dianxiaomi/product-work-items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: `dxm-work-linked-cn-${runId}`,
      collectedProductId: chineseCollected.id,
      pageUrl: "https://www.dianxiaomi.com/product/edit/work-linked-cn",
      pageTitle: "Linked Chinese work item page",
      pageProfile: "Dianxiaomi product edit",
      title: "女士情趣内衣连体衣睡衣套装",
      rawTextSample: "complete listing with linked Chinese collected product",
      notes: ["linked cn work item"],
      snapshot: {
        hasTitle: true,
        imageCount: 2,
        skuCount: 1,
        priceFieldCount: 1,
        stockFieldCount: 1,
        attributeKeys: ["material", "size"],
        mediaToolSignals: ["image translation", "Xiaomi image editor"]
      },
      status: "ready-for-automation"
    })
  })
  const chineseTaskResult = await requestJson<DianxiaomiProductWorkItemTaskResult>(`${baseUrl}/dianxiaomi/product-work-items/${chineseWorkItem.id}/task`, {
    method: "POST"
  })
  const cjkPattern = /[\u3400-\u9fff\uf900-\ufaff]/
  assert(!cjkPattern.test(chineseTaskResult.task.draft.listingTitle), "Chinese Dianxiaomi source title should generate an English automation draft title")
  assert(!cjkPattern.test(chineseTaskResult.task.draft.description), "Chinese Dianxiaomi source title should not leak into the automation draft description")
  assert.match(chineseTaskResult.task.draft.listingTitle, /Women|Lingerie|Bodysuit/, "English draft title should preserve the product direction")
  assert.equal(chineseTaskResult.task.draft.skuPricing[0]?.salePriceUsd, 999, "Chinese Dianxiaomi work item should keep the declared price default")
  assert.equal(chineseTaskResult.task.draft.skuPricing[0]?.stock, 20, "Chinese Dianxiaomi work item should keep the stock default")

  const publishCheckBeforeReview = await requestJson<PublishCheckResult>(`${baseUrl}/tasks/${taskResult.task.id}/publish-check`)
  assert.equal(publishCheckBeforeReview.canPublish, false, "new work queue task should still require manual review before publishing")
  assert(!publishCheckBeforeReview.issues.some((issue) => issue.id.startsWith("dxm-requirement-") && issue.level === "high"), "ready work queue task should not be blocked by Dianxiaomi requirement checks")

  await requestJson(`${baseUrl}/tasks/${taskResult.task.id}/review`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      decision: "approve",
      note: "smoke approval"
    })
  })

  const publishCheckAfterReview = await requestJson<PublishCheckResult>(`${baseUrl}/tasks/${taskResult.task.id}/publish-check`)
  assert.equal(publishCheckAfterReview.canPublish, true, "approved ready work queue task should pass publish checks")
}

const expectDianxiaomiRequirementRules = async () => {
  const defaultRules = await requestJson<DianxiaomiListingRequirementRules>(`${baseUrl}/dianxiaomi/requirement-rules`)
  assert(defaultRules.presetName, "dianxiaomi requirement rules should expose a preset name")
  assert(defaultRules.images.minCount >= 0, "dianxiaomi requirement rules should expose image requirements")
  assert(defaultRules.media.dianxiaomiTools.length > 0, "dianxiaomi requirement rules should expose native media tools")

  const workItem = await requestJson<DianxiaomiProductWorkItem>(`${baseUrl}/dianxiaomi/product-work-items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: `dxm-rules-smoke-${runId}`,
      pageUrl: "https://www.dianxiaomi.com/product/edit/rules-smoke",
      pageTitle: "Smoke Dianxiaomi Requirement Rules",
      pageProfile: "Dianxiaomi product edit",
      title: `DXM requirement rules smoke item ${runId}`,
      rawTextSample: "complete listing without restricted terms",
      notes: ["smoke requirement rules"],
      snapshot: {
        hasTitle: true,
        imageCount: 3,
        skuCount: 2,
        priceFieldCount: 2,
        stockFieldCount: 2,
        attributeKeys: ["color", "size"],
        imageStats: {
          minWidthPx: 1000,
          minHeightPx: 1000,
          maxWidthPx: 1200,
          maxHeightPx: 1200,
          unknownDimensionCount: 0
        },
        mediaToolSignals: ["image translation", "Xiaomi image editor"]
      }
    })
  })
  assert.equal(workItem.status, "ready-for-automation", "baseline rules should allow a complete three-image item")

  const stricterRules = await requestJson<DianxiaomiListingRequirementRules>(`${baseUrl}/dianxiaomi/requirement-rules`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...defaultRules,
      presetName: `${defaultRules.presetName}-smoke-strict`,
      images: {
        ...defaultRules.images,
        required: true,
        minCount: 4
      }
    })
  })
  assert.equal(stricterRules.images.minCount, 4, "dianxiaomi requirement rules update should persist image minimum")

  const workItemsAfterRuleUpdate = await requestJson<DianxiaomiProductWorkItem[]>(`${baseUrl}/dianxiaomi/product-work-items`)
  const rescored = workItemsAfterRuleUpdate.find((item) => item.id === workItem.id)
  assert(rescored, "requirement rules update should keep existing work queue items")
  assert.equal(rescored.status, "needs-revision", "stricter image rules should rescore queued work items")
  assert.equal(rescored.requirements.summary.ready, false, "stricter image rules should block readiness")
  assert(
    rescored.requirements.checks.some((check) => check.id === "images-present" && !check.ok),
    "stricter image rules should fail the image requirement check"
  )

  await requestJson<DianxiaomiListingRequirementRules>(`${baseUrl}/dianxiaomi/requirement-rules`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(defaultRules)
  })

  const workItemsAfterRestore = await requestJson<DianxiaomiProductWorkItem[]>(`${baseUrl}/dianxiaomi/product-work-items`)
  const restored = workItemsAfterRestore.find((item) => item.id === workItem.id)
  assert(restored, "restored requirement rules should keep existing work queue items")
  assert.equal(restored.status, "ready-for-automation", "restored rules should rescore queued work items back to ready")

  const mediaWorkItem = await requestJson<DianxiaomiProductWorkItem>(`${baseUrl}/dianxiaomi/product-work-items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: `dxm-media-rules-smoke-${runId}`,
      pageUrl: "https://www.dianxiaomi.com/product/edit/media-rules-smoke",
      pageTitle: "Smoke Dianxiaomi Media Requirement Rules",
      pageProfile: "Dianxiaomi product edit",
      title: `DXM media requirement smoke item ${runId}`,
      rawTextSample: "complete listing without media tool confirmation",
      notes: ["smoke media requirement rules"],
      snapshot: {
        hasTitle: true,
        imageCount: 4,
        skuCount: 2,
        priceFieldCount: 2,
        stockFieldCount: 2,
        attributeKeys: ["color", "size"],
        imageStats: {
          minWidthPx: 1000,
          minHeightPx: 1000,
          maxWidthPx: 1200,
          maxHeightPx: 1200,
          unknownDimensionCount: 0
        },
        mediaToolSignals: []
      }
    })
  })
  assert.equal(mediaWorkItem.status, "ready-for-automation", "baseline media rules should not block when media required is disabled")

  await requestJson<DianxiaomiListingRequirementRules>(`${baseUrl}/dianxiaomi/requirement-rules`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...defaultRules,
      presetName: `${defaultRules.presetName}-smoke-media-required`,
      media: {
        ...defaultRules.media,
        required: true,
        requireImageTranslation: true,
        requireSizeNormalization: true,
        requireImageEditorReview: true,
        requireWhiteBackground: false
      }
    })
  })

  const mediaWorkItemsAfterRuleUpdate = await requestJson<DianxiaomiProductWorkItem[]>(`${baseUrl}/dianxiaomi/product-work-items`)
  const mediaRescored = mediaWorkItemsAfterRuleUpdate.find((item) => item.id === mediaWorkItem.id)
  assert(mediaRescored, "media requirement rules update should keep existing work queue items")
  assert.equal(mediaRescored.status, "needs-revision", "required image translation should rescore queued work items")
  assert(
    mediaRescored.requirements.checks.some((check) => check.id === "media-image-translation" && !check.ok),
    "required image translation should fail without a Dianxiaomi media signal"
  )
  assert(
    mediaRescored.suggestedEdits.some((edit) => edit.field === "image" && edit.priority === "required"),
    "required media checks should create required image edit suggestions"
  )

  const mediaUpdatedWorkItem = await requestJson<DianxiaomiProductWorkItem>(`${baseUrl}/dianxiaomi/product-work-items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...mediaWorkItem,
      rawTextSample: "complete listing with Dianxiaomi image translation and image editor confirmation",
      snapshot: {
        ...mediaWorkItem.snapshot,
        mediaToolSignals: ["image translation", "Xiaomi image editor"]
      }
    })
  })
  assert.equal(mediaUpdatedWorkItem.status, "ready-for-automation", "Dianxiaomi media tool signals should satisfy required media checks")

  await requestJson<DianxiaomiListingRequirementRules>(`${baseUrl}/dianxiaomi/requirement-rules`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(defaultRules)
  })
}

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await requestJson(`${baseUrl}/health`)
      return
    } catch {
      await sleep(250)
    }
  }

  throw new Error(`server did not become healthy at ${baseUrl}`)
}

const startServer = () => {
  const tsxCliPath = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs")
  assert(existsSync(tsxCliPath), `tsx CLI not found: ${tsxCliPath}`)

  return spawn(process.execPath, [tsxCliPath, path.join(repoRoot, "apps/server/src/index.ts")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      PLANNER_STATE_PATH: path.join(repoRoot, smokeRoot, "planner-state.json"),
      QUEUE_DAEMON_STATE_PATH: path.join(repoRoot, smokeRoot, "queue-daemon-state.json"),
      TASK_EXPORT_HISTORY_PATH: path.join(repoRoot, smokeRoot, "automation-task-exports.json"),
      SELECTOR_DIAGNOSIS_DIRS: path.join(repoRoot, smokeRoot),
      ALLOW_DIANXIAOMI_SMOKE_URLS: "true"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  })
}

const stopServer = async (server: ChildProcessWithoutNullStreams) => {
  if (server.exitCode !== null || server.signalCode !== null) {
    return
  }

  server.kill()
  await new Promise<void>((resolve) => {
    server.once("exit", () => resolve())
    setTimeout(resolve, 3000)
  })
}

const waitForJob = async (mode: AutomationMode, id: string) => {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const job = await requestJson<Job>(`${baseUrl}/automation/${mode}/jobs/${id}`)
    if (job.status !== "running") {
      return job
    }
    await sleep(1000)
  }

  throw new Error(`${mode} job timed out: ${id}`)
}

const waitForFullFlowJob = async (id: string) => {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const job = await requestJson<FullFlowJob>(`${baseUrl}/automation/full-flow/jobs/${id}`)
    if (job.status !== "running") {
      return job
    }
    await sleep(1000)
  }

  throw new Error(`full-flow job timed out: ${id}`)
}

const waitForSelectorCalibrationJob = async (id: string) => {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const job = await requestJson<SelectorCalibrationJob>(`${baseUrl}/selector-calibration/jobs/${id}`)
    if (job.status !== "running") {
      return job
    }
    await sleep(1000)
  }

  throw new Error(`selector calibration job timed out: ${id}`)
}

const runAutomationCli = async (args: string[]) => {
  const tsxCliPath = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs")
  assert(existsSync(tsxCliPath), `tsx CLI not found: ${tsxCliPath}`)

  const child = spawn(process.execPath, [tsxCliPath, path.join(repoRoot, "apps/automation/src/temu-publish.ts"), ...args], {
    cwd: repoRoot,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code))
  })

  return {
    exitCode,
    stdout,
    stderr
  }
}

const latestReport = (directory: string) => {
  const reports = readdirSync(path.join(repoRoot, directory))
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => path.join(repoRoot, directory, fileName))
    .sort((left, right) => right.localeCompare(left))

  assert(reports[0], `no execution report found in ${directory}`)
  return JSON.parse(readFileSync(reports[0], "utf8")) as ExecutionReport
}

const readExecutionReport = (reportPath: string) => {
  const resolvedPath = path.isAbsolute(reportPath) ? reportPath : path.join(repoRoot, reportPath)
  return JSON.parse(readFileSync(resolvedPath, "utf8")) as ExecutionReport
}

const runRepairApply = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/repair-apply`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<StartResult>(`${baseUrl}/automation/repair-apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: fixtureUrl,
      taskFile,
      repairPlanFile,
      profile: `${smokeRoot}/repair-apply-profile`,
      screenshots,
      selectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: ["batchResize"]
    })
  })

  const job = await waitForJob("repair-apply", started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/automation/repair-apply/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `repair-apply should complete. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `repair-apply should exit cleanly. stderr: ${log.stderr}`)
  assert.equal(job.reportStatus, "completed", "repair-apply should complete when only manual actions are skipped")
  assert.equal(job.artifactDir, screenshots, "repair-apply should return the effective artifact directory")
  assert(job.reportPath?.includes(screenshots.replace(/\//g, path.sep)), "repair-apply report should be inside the artifact directory")

  const report = latestReport(screenshots)
  const stepIds = report.steps.map((step) => step.id)
  assert(stepIds.includes("target-surface"), "repair-apply should identify the current target surface")
  assert(stepIds.includes("repair-apply-title"), "repair-apply should run the title repair action")
  assert(stepIds.includes("repair-apply-description"), "repair-apply should run the description repair action")
  assert(stepIds.includes("repair-apply-color"), "repair-apply should run the attribute repair action")
  assert(stepIds.includes("repair-apply-sku"), "repair-apply should run the SKU repair action")
  assert(stepIds.includes("repair-apply-batch-resize"), "repair-apply should run the allowlisted media repair action")
  assert(stepIds.includes("repair-apply-manual"), "repair-apply should report manual repair actions as skipped")
  assert(stepIds.includes("repair-apply-summary"), "repair-apply should summarize repair actions")
  assert(!stepIds.includes("save-draft"), "repair-apply must not save drafts")
  assert(!stepIds.includes("submit-listing"), "repair-apply must not submit/publish listings")
  assert(!stepIds.includes("review-hold"), "repair-apply should not call the save/submit review hold path")

  const targetSurface = report.steps.find((step) => step.id === "target-surface")
  assert.equal(targetSurface?.data?.surfaceStatus, "fixture", "repair-apply should label the local data page as a fixture")
  assert.equal(targetSurface?.data?.canWrite, true, "repair-apply fixture should be writable in smoke")

  const titleStep = report.steps.find((step) => step.id === "repair-apply-title")
  const descriptionStep = report.steps.find((step) => step.id === "repair-apply-description")
  const attributeStep = report.steps.find((step) => step.id === "repair-apply-color")
  const skuStep = report.steps.find((step) => step.id === "repair-apply-sku")
  const mediaStep = report.steps.find((step) => step.id === "repair-apply-batch-resize")
  const manualStep = report.steps.find((step) => step.id === "repair-apply-manual")
  const summaryStep = report.steps.find((step) => step.id === "repair-apply-summary")
  assert.equal(titleStep?.status, "done", "repair-apply should fill the title from task data")
  assert.equal(descriptionStep?.status, "done", "repair-apply should fill the description from task data")
  assert.equal(attributeStep?.status, "done", "repair-apply should fill the specific known attribute")
  assert.equal(skuStep?.status, "done", "repair-apply should fill SKU price/stock from task data")
  assert.equal(mediaStep?.status, "done", "repair-apply should apply the allowlisted media tool")
  assert.equal(manualStep?.status, "skipped", "repair-apply should skip manual actions")
  assert.equal(summaryStep?.status, "done", "repair-apply summary should be done when only manual actions are skipped")

  const titleWriter = titleStep?.data?.writerResult as { status?: string; data?: Record<string, unknown> } | undefined
  const skuWriter = skuStep?.data?.writerResult as { status?: string; data?: Record<string, unknown> } | undefined
  const mediaWriter = mediaStep?.data?.writerResult as { status?: string; data?: Record<string, unknown> } | undefined
  assert.equal(titleWriter?.status, "done", "repair-apply title writer should succeed")
  assert.equal(skuWriter?.data?.filledPrices, 2, "repair-apply should fill both SKU prices")
  assert.equal(skuWriter?.data?.filledStocks, 2, "repair-apply should fill both SKU stocks")
  assert.equal(mediaWriter?.data?.safeMode, "unattended-apply", "repair-apply media action should use unattended apply mode")
  assert.equal(mediaWriter?.data?.wouldApply, true, "repair-apply media action should apply the allowlisted tool")
  const imageCheckSelection = mediaStep?.data?.imageCheckSelection as { selection?: { status?: string; categories?: unknown[] } } | null | undefined
  assert(imageCheckSelection, "requirement-image-check repairs should be routed through categorized image-check selection")
  assert.equal(imageCheckSelection?.selection?.status, "applied", "categorized image-check selection should apply in repair-apply mode")
  assert((imageCheckSelection?.selection?.categories?.length ?? 0) > 0, "categorized image-check selection should record matched categories")
  assert.equal(summaryStep?.data?.savedOrSubmitted, false, "repair-apply summary should state that it did not save or submit")

  return {
    mode: "repair-apply" as const,
    jobId: job.id,
    reportId: report.id,
    targetFingerprint: job.targetFingerprint,
    artifactDir: job.artifactDir,
    stepIds
  }
}

const runMode = async (mode: AutomationMode, fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/${mode}`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<StartResult>(`${baseUrl}/automation/${mode}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: fixtureUrl,
      taskFile,
      profile: `${smokeRoot}/${mode}-profile`,
      screenshots,
      selectorConfig
    })
  })

  const job = await waitForJob(mode, started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/automation/${mode}/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `${mode} should complete. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `${mode} should exit cleanly. stderr: ${log.stderr}`)
  assert.equal(job.reportStatus, "completed", `${mode} should produce a completed execution report`)
  assert.equal(job.artifactDir, screenshots, `${mode} should return the effective artifact directory`)
  assert(job.reportPath?.includes(screenshots.replace(/\//g, path.sep)), `${mode} report should be inside the artifact directory`)

  const report = latestReport(screenshots)
  const stepIds = report.steps.map((step) => step.id)
  if (mode !== "submit-listing") {
    assert(!stepIds.includes("submit-listing"), `${mode} must not submit/publish listings`)
  }
  assert(stepIds.includes("target-surface"), `${mode} should identify the current target surface before work`)
  const targetSurface = report.steps.find((step) => step.id === "target-surface")
  assert.equal(targetSurface?.data?.surfaceStatus, "fixture", `${mode} should label the local data page as a fixture`)
  assert.equal(targetSurface?.data?.isDataFixture, true, `${mode} should expose that this is not a real Dianxiaomi host`)
  assert.equal(targetSurface?.data?.isDianxiaomiHost, false, `${mode} should not claim the fixture is Dianxiaomi`)
  assert.equal(targetSurface?.data?.canInspect, true, `${mode} fixture should be inspectable in smoke`)
  assert.equal(targetSurface?.data?.canWrite, true, `${mode} fixture should remain writable for smoke coverage`)

  if (mode === "dry-run") {
    assert(stepIds.includes("inspect-submit-button"), "dry-run should inspect submit button only")
    assert(stepIds.includes("inspect-media-image-translation"), "dry-run should inspect Dianxiaomi image translation tool")
    assert(stepIds.includes("inspect-media-batch-resize"), "dry-run should inspect Dianxiaomi batch resize tool")
    assert(stepIds.includes("inspect-media-image-management"), "dry-run should inspect Dianxiaomi image management tool")
    assert(stepIds.includes("media-processing-safety"), "dry-run should include media processing safety checks")
    assert(stepIds.includes("inspect-media-summary"), "dry-run should summarize Dianxiaomi media tools")
    assert(!stepIds.includes("fill-title"), "dry-run must not fill fields")
  }

  if (mode === "fill-draft") {
    assert(stepIds.includes("review-hold"), "fill-draft should stop at review hold")
    assert(stepIds.includes("media-processing-safety"), "fill-draft should include media processing safety checks")
    assert(stepIds.includes("media-processing-plan"), "fill-draft should create a plan-only Dianxiaomi media processing step")
    assert(!stepIds.includes("save-draft"), "fill-draft must not save drafts")
  }

  if (mode === "save-draft") {
    assert(stepIds.includes("save-draft"), "save-draft should click the save draft control")
    assert(stepIds.includes("media-processing-safety"), "save-draft should include media processing safety checks")
    assert(stepIds.includes("media-processing-plan"), "save-draft should report the media processing handoff before saving")
  }

  if (mode === "submit-listing") {
    assert(stepIds.includes("submit-listing"), "submit-listing should click the submit control")
    assert(!stepIds.includes("save-draft"), "direct submit-listing should not click save draft")
    assert(stepIds.includes("media-processing-safety"), "submit-listing should include media processing safety checks")
    assert(stepIds.includes("media-processing-plan"), "submit-listing should create a plan-only Dianxiaomi media processing step before submitting")
    const submitStep = report.steps.find((step) => step.id === "submit-listing")
    const attempts = submitStep?.data?.attempts as Array<{ state: string; message: string }> | undefined
    assert.equal(submitStep?.status, "done", "submit-listing should succeed after retrying a transient Dianxiaomi failure")
    assert.equal(attempts?.length, 2, "submit-listing should retry after the first Dianxiaomi failure")
    assert.equal(attempts?.[0]?.state, "failure", "submit-listing should record the first failure state")
    assert.equal(attempts?.[1]?.state, "success", "submit-listing should record the final success state")
  }

  if (["fill-draft", "save-draft", "submit-listing"].includes(mode)) {
    const titleStep = report.steps.find((step) => step.id === "fill-title")
    const skuStep = report.steps.find((step) => step.id === "fill-sku-pricing")
    const skuCodeSamples = skuStep?.data?.skuCodeSamples as string[] | undefined
    const cjkPattern = /[\u3400-\u9fff\uf900-\ufaff]/
    assert(Number(titleStep?.data?.filledTitleFields ?? 0) >= 2, `${mode} should fill product title and English title fields`)
    assert(Number(skuStep?.data?.filledSkuCodes ?? 0) >= 2, `${mode} should replace Chinese SKU identifier fields`)
    assert(skuCodeSamples?.every((sample) => !cjkPattern.test(sample)), `${mode} SKU identifier samples should not contain Chinese text`)
  }

  const mediaSafety = report.steps.find((step) => step.id === "media-processing-safety")
  assert(mediaSafety, `${mode} should include a media-processing-safety report step`)
  assert.equal(mediaSafety.data?.safeMode, "plan-only", `${mode} media safety should use plan-only safe mode by default`)
  assert.equal(mediaSafety.data?.wouldClick, false, `${mode} media safety must not click Dianxiaomi media tools`)
  assert.equal(mediaSafety.data?.manualConfirmationRequired, true, `${mode} media safety should require manual confirmation when fixture tools exist`)
  assert.equal(mediaSafety.data?.guardStatus, "manual-ready", `${mode} media safety should report manual-ready for the clean fixture`)
  const mediaTools = mediaSafety.data?.tools as Array<{ id: string; wouldClick: boolean }> | undefined
  assert(mediaTools?.some((tool) => tool.id === "image-management"), `${mode} media safety should include image management in the tool plan`)
  assert(mediaTools.every((tool) => tool.wouldClick === false), `${mode} media safety tool plan must remain non-clicking`)

  const mediaPlan = report.steps.find((step) => step.id === "media-processing-plan")
  if (mediaPlan) {
    if (mode === "save-draft") {
      assert.equal(mediaPlan.status, "skipped", "save-draft media plan should be skipped after the fill-draft handoff")
      assert.equal(
        mediaPlan.detail,
        "Save-draft stage reuses the current media state and does not rerun billable Dianxiaomi media tools",
        "save-draft should explain that billable Dianxiaomi media tools are not rerun"
      )
    } else {
      assert.equal(mediaPlan.data?.safeMode, "plan-only", `${mode} media plan should expose plan-only safe mode`)
      assert.equal(mediaPlan.data?.wouldClick, false, `${mode} media plan must not click Dianxiaomi media tools`)
      assert.equal(mediaPlan.data?.manualConfirmationRequired, true, `${mode} media plan should require manual confirmation when fixture tools exist`)
    }
  }

  return {
    mode,
    jobId: job.id,
    reportId: report.id,
    targetFingerprint: job.targetFingerprint,
    artifactDir: job.artifactDir,
    stepIds
  }
}

const runFillDraftSizeChartCleanup = async (fixtureUrl: string) => {
  const mode: AutomationMode = "fill-draft"
  const screenshots = `${smokeRoot}/fill-draft-size-chart-cleanup`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<StartResult>(`${baseUrl}/automation/${mode}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: `${fixtureUrl}#size-chart-template-missing`,
      taskFile,
      profile: `${smokeRoot}/fill-draft-size-chart-cleanup-profile`,
      screenshots,
      selectorConfig
    })
  })

  const job = await waitForJob(mode, started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/automation/${mode}/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `fill-draft size chart cleanup should complete. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `fill-draft size chart cleanup should exit cleanly. stderr: ${log.stderr}`)
  assert.equal(job.reportStatus, "completed", "fill-draft size chart cleanup should not leave a partial execution report")

  const report = latestReport(screenshots)
  const sizeChartStep = report.steps.find((step) => step.id === "normalize-size-chart")
  const mediaSafety = report.steps.find((step) => step.id === "media-processing-safety")
  const mediaPlan = report.steps.find((step) => step.id === "media-processing-plan")

  assert(sizeChartStep, "fill-draft size chart cleanup should report the size chart normalization step")
  assert.equal(sizeChartStep?.status, "skipped", "fill-draft should skip size chart normalization when no reusable template exists")
  assert.match(sizeChartStep?.detail ?? "", /closed/i, "fill-draft should close the size chart modal before skipping")
  assert.equal(mediaSafety?.status, "done", "fill-draft should leave media safety in a usable state after size chart cleanup")
  assert.equal(mediaSafety?.data?.guardStatus, "manual-ready", "fill-draft should restore media tools after size chart cleanup")
  assert.equal(mediaSafety?.data?.pageState?.visibleDialogCount, 0, "fill-draft should not leave the size chart dialog open")
  assert.equal(mediaPlan?.status, "skipped", "fill-draft size chart cleanup should keep the media plan non-blocking in plan-only mode")
  assert.equal(mediaPlan?.data?.guardStatus, "manual-ready", "fill-draft media plan should remain ready after size chart cleanup")
}

const runUnattendedMediaDryRun = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/dry-run-unattended-media`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<StartResult>(`${baseUrl}/automation/dry-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: fixtureUrl,
      taskFile,
      profile: `${smokeRoot}/dry-run-unattended-media-profile`,
      screenshots,
      selectorConfig,
      mediaAutomationMode: "unattended-open",
      mediaAutomationTools: ["image-translation"]
    })
  })

  const job = await waitForJob("dry-run", started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/automation/dry-run/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `unattended media dry-run should complete. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `unattended media dry-run should exit cleanly. stderr: ${log.stderr}`)

  const report = latestReport(screenshots)
  const stepIds = report.steps.map((step) => step.id)
  assert(!stepIds.includes("submit-listing"), "unattended media dry-run must not submit/publish listings")
  assert(stepIds.includes("media-processing-safety"), "unattended media dry-run should include media safety")
  assert(stepIds.includes("media-processing-plan"), "unattended media dry-run should include media plan")

  const mediaSafety = report.steps.find((step) => step.id === "media-processing-safety")
  assert.equal(mediaSafety?.data?.safeMode, "unattended-open", "unattended media safety should expose unattended mode")
  assert.equal(mediaSafety?.data?.wouldClick, true, "unattended media safety should plan a click for the allowed tool")
  assert.equal(mediaSafety?.data?.manualConfirmationRequired, true, "unattended media safety should still require manual confirmation for non-allowed tools")

  const mediaPlan = report.steps.find((step) => step.id === "media-processing-plan")
  assert.equal(mediaPlan?.data?.safeMode, "unattended-open", "unattended media plan should expose unattended mode")
  assert.equal(mediaPlan?.data?.wouldClick, true, "unattended media plan should report that an entry was opened")
  const tools = mediaPlan?.data?.tools as Array<{ id: string; clicked?: boolean; status: string; screenshotPath?: string }> | undefined
  const opened = tools?.find((tool) => tool.id === "image-translation")
  assert.equal(opened?.clicked, true, "unattended media plan should click the allowed image translation entry")
  assert.equal(opened?.status, "opened", "unattended media plan should mark the allowed entry opened")
  const openedScreenshotPath = opened?.screenshotPath
    ? path.isAbsolute(opened.screenshotPath) ? opened.screenshotPath : path.join(repoRoot, opened.screenshotPath)
    : ""
  assert(openedScreenshotPath && existsSync(openedScreenshotPath), "unattended media plan should capture an after-open screenshot")
  assert(tools?.filter((tool) => tool.clicked).length === 1, "unattended media plan should open only the allowlisted media tool")
}

const runUnattendedMediaApplyDryRun = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/dry-run-unattended-media-apply`
  const expectedAppliedTools = ["image-translation", "white-background", "image-editor", "batch-resize", "image-management"]
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<StartResult>(`${baseUrl}/automation/dry-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: fixtureUrl,
      taskFile,
      profile: `${smokeRoot}/dry-run-unattended-media-apply-profile`,
      screenshots,
      selectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: expectedAppliedTools
    })
  })

  const job = await waitForJob("dry-run", started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/automation/dry-run/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `unattended media apply dry-run should complete. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `unattended media apply dry-run should exit cleanly. stderr: ${log.stderr}`)

  const report = latestReport(screenshots)
  const stepIds = report.steps.map((step) => step.id)
  assert(!stepIds.includes("submit-listing"), "unattended media apply dry-run must not submit/publish listings")
  assert(stepIds.includes("media-processing-safety"), "unattended media apply dry-run should include media safety")
  assert(stepIds.includes("media-processing-plan"), "unattended media apply dry-run should include media plan")

  const mediaSafety = report.steps.find((step) => step.id === "media-processing-safety")
  assert.equal(mediaSafety?.data?.safeMode, "unattended-apply", "unattended media apply safety should expose apply mode")
  assert.equal(mediaSafety?.data?.wouldClick, true, "unattended media apply safety should plan a click for the allowed tool")
  assert.equal(mediaSafety?.data?.wouldApply, true, "unattended media apply safety should plan an internal apply for the allowed tool")
  assert.equal(mediaSafety?.data?.manualConfirmationRequired, false, "unattended media apply safety should not require manual confirmation when all detected tools are allowlisted")

  const mediaPlan = report.steps.find((step) => step.id === "media-processing-plan")
  assert.equal(mediaPlan?.status, "done", "unattended media apply plan should complete when the internal apply succeeds")
  assert.equal(mediaPlan?.data?.safeMode, "unattended-apply", "unattended media apply plan should expose apply mode")
  assert.equal(mediaPlan?.data?.wouldClick, true, "unattended media apply plan should report that an entry was opened")
  assert.equal(mediaPlan?.data?.wouldApply, true, "unattended media apply plan should report that an internal apply was clicked")
  const tools = mediaPlan?.data?.tools as Array<{
    id: string
    clicked?: boolean
    applied?: boolean
    status: string
    screenshotPath?: string
    beforeApplyScreenshotPath?: string
    afterApplyScreenshotPath?: string
    returnDialogCount?: number
    applyAttempts?: number
    maxApplyAttempts?: number
    feedbackAttempts?: Array<{ attempt: number; state: string; message?: string; failureKind?: string; retryable?: boolean }>
  }> | undefined
  for (const toolId of expectedAppliedTools) {
    const applied = tools?.find((tool) => tool.id === toolId)
    assert.equal(applied?.clicked, true, `unattended media apply plan should click the allowed ${toolId} entry`)
    assert.equal(applied?.applied, true, `unattended media apply plan should click the internal ${toolId} apply action`)
    assert.equal(applied?.status, "applied", `unattended media apply plan should mark ${toolId} applied`)
    assert.equal(applied?.returnDialogCount, 0, `unattended media apply plan should return to the listing editor after applying ${toolId}`)
    assert.equal(applied?.applyAttempts, 1, `unattended media apply plan should apply ${toolId} once when it succeeds immediately`)
    assert.equal(applied?.maxApplyAttempts, 3, `unattended media apply plan should expose the transient retry cap for ${toolId}`)
    assert.equal(applied?.feedbackAttempts?.length, 1, `unattended media apply plan should record one feedback attempt for ${toolId}`)
    assert.equal(applied?.feedbackAttempts?.[0]?.state, "success", `unattended media apply plan should record success feedback for ${toolId}`)
    for (const screenshotPath of [applied?.screenshotPath, applied?.beforeApplyScreenshotPath, applied?.afterApplyScreenshotPath]) {
      const absolutePath = screenshotPath
        ? path.isAbsolute(screenshotPath) ? screenshotPath : path.join(repoRoot, screenshotPath)
        : ""
      assert(absolutePath && existsSync(absolutePath), `unattended media apply plan should capture open/before/after screenshots for ${toolId}`)
    }
  }
  assert.equal(tools?.filter((tool) => tool.clicked).length, expectedAppliedTools.length, "unattended media apply plan should open every allowlisted media tool")
  assert.equal(tools?.filter((tool) => tool.applied).length, expectedAppliedTools.length, "unattended media apply plan should apply every allowlisted media tool")
}

const runUnattendedMediaTransientRetrySuccessDryRun = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/dry-run-unattended-media-transient-retry-success`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<StartResult>(`${baseUrl}/automation/dry-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: `${fixtureUrl}#media-transient-once-batch-resize`,
      taskFile,
      profile: `${smokeRoot}/dry-run-unattended-media-transient-retry-success-profile`,
      screenshots,
      selectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: ["batch-resize", "white-background"]
    })
  })

  const job = await waitForJob("dry-run", started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/automation/dry-run/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `transient retry success dry-run should complete. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `transient retry success dry-run should exit cleanly. stderr: ${log.stderr}`)
  assert.equal(job.reportStatus, "completed", "transient retry success dry-run should produce a completed execution report")

  const report = latestReport(screenshots)
  const mediaPlan = report.steps.find((step) => step.id === "media-processing-plan")
  assert.equal(mediaPlan?.status, "done", "transient feedback should succeed after the bounded internal retry")
  const tools = mediaPlan?.data?.tools as Array<{
    id: string
    status: string
    applied?: boolean
    feedbackState?: string
    feedbackMessage?: string
    failureKind?: string
    retryable?: boolean
    applyAttempts?: number
    maxApplyAttempts?: number
    feedbackAttempts?: Array<{ attempt: number; state: string; message?: string; failureKind?: string; retryable?: boolean }>
  }> | undefined
  const resize = tools?.find((tool) => tool.id === "batch-resize")
  const whiteBackground = tools?.find((tool) => tool.id === "white-background")

  assert.equal(resize?.status, "applied", "transient retry success should mark batch resize applied")
  assert.equal(resize?.applied, true, "transient retry success should mark the retried tool applied")
  assert.equal(resize?.feedbackState, "success", "transient retry success should keep the final feedback state")
  assert.equal(resize?.applyAttempts, 2, "transient retry success should click the apply control twice")
  assert.equal(resize?.maxApplyAttempts, 3, "transient retry success should expose the bounded retry cap")
  assert.equal(resize?.feedbackAttempts?.length, 2, "transient retry success should record both feedback attempts")
  assert.equal(resize?.feedbackAttempts?.[0]?.state, "failure", "transient retry success should record the first failure")
  assert.equal(resize?.feedbackAttempts?.[0]?.failureKind, "transient", "transient retry success should classify the first failure")
  assert.equal(resize?.feedbackAttempts?.[0]?.retryable, true, "transient retry success should mark the first failure retryable")
  assert.equal(resize?.feedbackAttempts?.[1]?.state, "success", "transient retry success should record final success")
  assert.match(String(resize?.feedbackAttempts?.[0]?.message ?? ""), /try again|busy|temporary/i, "transient retry success should preserve the temporary failure message")
  assert.equal(whiteBackground?.status, "applied", "later media tools should continue after a successful transient retry")
  assert.equal(whiteBackground?.applied, true, "later media tools should still be applied")
}

const runUnattendedMediaConfiguredActionsDryRun = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/dry-run-unattended-media-configured-actions`
  const configuredSelectorConfig = `${smokeRoot}/configured-media-actions-selector-config.json`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })
  mkdirSync(path.dirname(path.join(repoRoot, configuredSelectorConfig)), {
    recursive: true
  })

  const baseConfig = JSON.parse(readFileSync(selectorConfigPath, "utf8")) as DianxiaomiSelectorConfig
  const configWithActions: DianxiaomiSelectorConfig = {
    ...baseConfig,
    mediaToolActions: {
      ...baseConfig.mediaToolActions,
      apply: {
        ...(baseConfig.mediaToolActions?.apply ?? {}),
        batchResize: ["[data-media-action='batch-resize-apply']"]
      },
      close: {
        ...(baseConfig.mediaToolActions?.close ?? {}),
        batchResize: ["[data-media-action='batch-resize-close']"]
      }
    }
  }
  writeFileSync(path.join(repoRoot, configuredSelectorConfig), JSON.stringify(configWithActions, null, 2), "utf8")

  const started = await requestJson<StartResult>(`${baseUrl}/automation/dry-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: `${fixtureUrl}#media-configured-actions-batch-resize`,
      taskFile,
      profile: `${smokeRoot}/dry-run-unattended-media-configured-actions-profile`,
      screenshots,
      selectorConfig: configuredSelectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: ["batch-resize"]
    })
  })

  const job = await waitForJob("dry-run", started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/automation/dry-run/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `configured media action dry-run should complete. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `configured media action dry-run should exit cleanly. stderr: ${log.stderr}`)
  assert.equal(job.reportStatus, "completed", "configured media action dry-run should produce a completed execution report")

  const report = latestReport(screenshots)
  const mediaPlan = report.steps.find((step) => step.id === "media-processing-plan")
  assert.equal(mediaPlan?.status, "done", "configured media action selectors should allow media apply to complete")
  const tools = mediaPlan?.data?.tools as Array<{
    id: string
    status: string
    applied?: boolean
    applyButton?: { text?: string }
    returnDialogCount?: number
  }> | undefined
  const resize = tools?.find((tool) => tool.id === "batch-resize")
  assert.equal(resize?.status, "applied", "configured media action selectors should mark batch resize applied")
  assert.equal(resize?.applied, true, "configured media action selectors should click the custom internal apply control")
  assert.equal(resize?.applyButton?.text, "Run custom control", "configured media action selectors should prefer the configured apply control")
  assert.equal(resize?.returnDialogCount, 0, "configured media action selectors should use the configured close control")
}

const runUnattendedMediaApplyFailureDryRun = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/dry-run-unattended-media-apply-failure`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<StartResult>(`${baseUrl}/automation/dry-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: `${fixtureUrl}#media-fail-batch-resize`,
      taskFile,
      profile: `${smokeRoot}/dry-run-unattended-media-apply-failure-profile`,
      screenshots,
      selectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: ["image-translation", "batch-resize", "white-background", "image-editor", "image-management"]
    })
  })

  const job = await waitForJob("dry-run", started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/automation/dry-run/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `unattended media apply failure dry-run should still write a report. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `unattended media apply failure dry-run should exit cleanly. stderr: ${log.stderr}`)
  assert.equal(job.reportStatus, "completed", "media apply failure dry-run should keep the main report completed while preserving media failure evidence")

  const report = latestReport(screenshots)
  const stepIds = report.steps.map((step) => step.id)
  assert(!stepIds.includes("save-draft"), "media apply failure dry-run must not save drafts")
  assert(!stepIds.includes("submit-listing"), "media apply failure dry-run must not submit/publish listings")

  const mediaPlan = report.steps.find((step) => step.id === "media-processing-plan")
  assert.equal(mediaPlan?.status, "failed", "unattended media apply should fail the plan when a tool returns failure feedback")
  const tools = mediaPlan?.data?.tools as Array<{
    id: string
    clicked?: boolean
    applied?: boolean
    status: string
    feedbackState?: string
    feedbackMessage?: string
    failureKind?: string
    retryable?: boolean
    applyAttempts?: number
    maxApplyAttempts?: number
    feedbackAttempts?: Array<{ attempt: number; state: string; failureKind?: string; retryable?: boolean }>
    error?: string
  }> | undefined
  const translation = tools?.find((tool) => tool.id === "image-translation")
  const resize = tools?.find((tool) => tool.id === "batch-resize")
  const afterFailure = tools?.filter((tool) => ["white-background", "image-editor", "image-management"].includes(tool.id)) ?? []

  assert.equal(translation?.status, "applied", "media apply failure path should preserve successful tools before the failure")
  assert.equal(translation?.feedbackState, "success", "successful media tools should record success feedback")
  assert.equal(resize?.clicked, true, "failing media tool should be opened")
  assert.equal(resize?.applied, false, "failing media tool should not be marked applied")
  assert.equal(resize?.status, "apply-failed", "failing media tool should be marked apply-failed")
  assert.equal(resize?.feedbackState, "failure", "failing media tool should record failure feedback")
  assert.equal(resize?.failureKind, "invalid-media", "invalid image size feedback should be classified")
  assert.equal(resize?.retryable, false, "invalid image size feedback should not be auto retryable")
  assert.equal(resize?.applyAttempts, 1, "invalid image size feedback should not be retried internally")
  assert.equal(resize?.maxApplyAttempts, 3, "invalid image size feedback should still expose the retry cap")
  assert.equal(resize?.feedbackAttempts?.length, 1, "invalid image size feedback should record one attempt")
  assert.equal(resize?.feedbackAttempts?.[0]?.failureKind, "invalid-media", "invalid image size feedback should classify the first attempt")
  assert.equal(resize?.feedbackAttempts?.[0]?.retryable, false, "invalid image size feedback attempt should not be retryable")
  assert.match(String(resize?.feedbackMessage ?? resize?.error ?? ""), /failed|invalid|失败|无效/i, "failing media tool should include the Dianxiaomi failure reason")
  assert(afterFailure.length > 0, "failure path should include later media tools in the report")
  assert(afterFailure.every((tool) => tool.status === "blocked-by-media-failure"), "later media tools should be blocked after the first media failure")
  assert(afterFailure.every((tool) => !tool.clicked && !tool.applied), "later media tools should not be clicked after the first media failure")
}

const runUnattendedMediaSilentBatchResizeDryRun = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/dry-run-unattended-media-silent-batch-resize`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<StartResult>(`${baseUrl}/automation/dry-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: `${fixtureUrl}#media-batch-resize-silent`,
      taskFile,
      profile: `${smokeRoot}/dry-run-unattended-media-silent-batch-resize-profile`,
      screenshots,
      selectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: ["batch-resize"]
    })
  })

  const job = await waitForJob("dry-run", started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/automation/dry-run/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `silent batch resize dry-run should complete. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `silent batch resize dry-run should exit cleanly. stderr: ${log.stderr}`)
  assert.equal(job.reportStatus, "completed", "silent batch resize dry-run should produce a completed execution report")

  const report = latestReport(screenshots)
  const mediaPlan = report.steps.find((step) => step.id === "media-processing-plan")
  assert.equal(mediaPlan?.status, "done", "silent batch resize should no longer fail the media plan")
  const tools = mediaPlan?.data?.tools as Array<{
    id: string
    status: string
    applied?: boolean
    feedbackState?: string
    feedbackMessage?: string
    returnDialogCount?: number
  }> | undefined
  const resize = tools?.find((tool) => tool.id === "batch-resize")
  assert.equal(resize?.status, "applied", "silent batch resize should be accepted as applied")
  assert.equal(resize?.applied, true, "silent batch resize should be applied")
  assert.equal(resize?.feedbackState, "success", "silent batch resize should recover to success without a toast")
  assert.equal(resize?.returnDialogCount, 0, "silent batch resize should return to the editor")
}

const runUnattendedMediaSurfaceMismatchDryRun = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/dry-run-unattended-media-surface-mismatch`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<StartResult>(`${baseUrl}/automation/dry-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: `${fixtureUrl}#media-wrong-surface-batch-resize`,
      taskFile,
      profile: `${smokeRoot}/dry-run-unattended-media-surface-mismatch-profile`,
      screenshots,
      selectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: ["batch-resize", "white-background"]
    })
  })

  const job = await waitForJob("dry-run", started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/automation/dry-run/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `surface mismatch dry-run should still write a report. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `surface mismatch dry-run should exit cleanly. stderr: ${log.stderr}`)
  assert.equal(job.reportStatus, "completed", "surface mismatch dry-run should keep the main report completed while preserving media failure evidence")

  const report = latestReport(screenshots)
  const mediaPlan = report.steps.find((step) => step.id === "media-processing-plan")
  assert.equal(mediaPlan?.status, "failed", "surface mismatch should fail the media processing plan")
  const tools = mediaPlan?.data?.tools as Array<{
    id: string
    clicked?: boolean
    applied?: boolean
    status: string
    surfaceState?: string
    surfaceMatchedKeyword?: string | null
    surfaceText?: string
    failureKind?: string
    retryable?: boolean
    error?: string
  }> | undefined
  const resize = tools?.find((tool) => tool.id === "batch-resize")
  const afterMismatch = tools?.find((tool) => tool.id === "white-background")
  assert.equal(resize?.clicked, true, "surface mismatch tool should be clicked")
  assert.equal(resize?.applied, false, "surface mismatch tool should not be marked applied")
  assert.equal(resize?.status, "apply-failed", "surface mismatch should mark the tool apply-failed")
  assert.equal(resize?.surfaceState, "mismatched", "surface mismatch should record mismatched media surface state")
  assert.equal(resize?.failureKind, "surface-mismatch", "surface mismatch should be classified")
  assert.equal(resize?.retryable, false, "surface mismatch should not be auto retryable")
  assert.equal(resize?.surfaceMatchedKeyword ?? null, null, "surface mismatch should not record a matched keyword")
  assert.match(String(resize?.surfaceText ?? resize?.error ?? ""), /Image Management|selected|media surface/i, "surface mismatch should include the unexpected surface text")
  assert.equal(afterMismatch?.status, "blocked-by-media-failure", "later tools should be blocked after a surface mismatch")
  assert.equal(afterMismatch?.clicked, false, "later tools should not be clicked after a surface mismatch")
}

const runUnattendedMediaTransientFailureDryRun = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/dry-run-unattended-media-transient-failure`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<StartResult>(`${baseUrl}/automation/dry-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: `${fixtureUrl}#media-transient-batch-resize`,
      taskFile,
      profile: `${smokeRoot}/dry-run-unattended-media-transient-failure-profile`,
      screenshots,
      selectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: ["batch-resize", "white-background"]
    })
  })

  const job = await waitForJob("dry-run", started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/automation/dry-run/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `transient media failure dry-run should still write a report. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `transient media failure dry-run should exit cleanly. stderr: ${log.stderr}`)
  assert.equal(job.reportStatus, "completed", "transient media failure dry-run should keep the main report completed while preserving media failure evidence")

  const report = latestReport(screenshots)
  const mediaPlan = report.steps.find((step) => step.id === "media-processing-plan")
  assert.equal(mediaPlan?.status, "failed", "transient feedback should still fail the current media plan")
  const tools = mediaPlan?.data?.tools as Array<{
    id: string
    status: string
    feedbackState?: string
    feedbackMessage?: string
    failureKind?: string
    retryable?: boolean
    applyAttempts?: number
    maxApplyAttempts?: number
    feedbackAttempts?: Array<{ attempt: number; state: string; message?: string; failureKind?: string; retryable?: boolean }>
  }> | undefined
  const resize = tools?.find((tool) => tool.id === "batch-resize")
  const afterTransient = tools?.find((tool) => tool.id === "white-background")
  assert.equal(resize?.status, "apply-failed", "transient feedback should mark the tool apply-failed")
  assert.equal(resize?.feedbackState, "failure", "transient feedback should be recorded as failure feedback")
  assert.equal(resize?.failureKind, "transient", "temporary busy feedback should be classified as transient")
  assert.equal(resize?.retryable, true, "temporary busy feedback should be retryable")
  assert.equal(resize?.applyAttempts, 3, "persistent transient feedback should retry up to the bounded cap")
  assert.equal(resize?.maxApplyAttempts, 3, "persistent transient feedback should expose the bounded retry cap")
  assert.equal(resize?.feedbackAttempts?.length, 3, "persistent transient feedback should record every retry attempt")
  assert(resize?.feedbackAttempts?.every((attempt) => attempt.state === "failure"), "persistent transient feedback should record all attempts as failures")
  assert(resize?.feedbackAttempts?.every((attempt) => attempt.failureKind === "transient"), "persistent transient feedback should classify all attempts as transient")
  assert(resize?.feedbackAttempts?.every((attempt) => attempt.retryable === true), "persistent transient feedback attempts should remain retryable")
  assert.match(String(resize?.feedbackMessage ?? ""), /try again|busy|temporary/i, "transient feedback should keep the Dianxiaomi message")
  assert.equal(afterTransient?.status, "blocked-by-media-failure", "later media tools should remain blocked after a transient failure")
}

const runMediaFailureBlocksSaveDraft = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/save-draft-media-apply-failure`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const result = await runAutomationCli([
    "--dry-run=false",
    "--review=false",
    "--save-draft=true",
    "--submit=false",
    "--headed=false",
    `--url=${fixtureUrl}#media-fail-batch-resize`,
    `--task-file=${taskFile}`,
    `--profile=${smokeRoot}/save-draft-media-apply-failure-profile`,
    `--screenshots=${screenshots}`,
    `--selector-config=${selectorConfig}`,
    "--media-automation-mode=unattended-apply",
    "--media-automation-tools=image-translation,batch-resize,white-background,image-editor,image-management"
  ])
  assert.equal(result.exitCode, 0, `media failure save-draft runner should exit cleanly. stderr: ${result.stderr}`)

  const report = latestReport(screenshots)
  assert.equal(report.status, "partial", "media failure save-draft should stop before save and leave a partial report")
  const stepIds = report.steps.map((step) => step.id)
  assert(stepIds.includes("media-processing-plan"), "media failure save-draft should include media processing plan")
  assert(stepIds.includes("write-blocked-media-processing"), "media failure save-draft should block later writes")
  assert(!stepIds.includes("save-draft"), "media failure save-draft should stop before the save control")
  assert(!stepIds.includes("submit-listing"), "media failure save-draft must not submit/publish listings")
  assert.equal(report.steps.find((step) => step.id === "media-processing-plan")?.status, "failed", "media failure should fail the media processing plan")
  assert.equal(report.steps.find((step) => step.id === "write-blocked-media-processing")?.status, "failed", "media failure save-draft should record the hard write block")
}

const runMediaSurfaceMismatchBlocksSaveDraft = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/save-draft-media-surface-mismatch`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const result = await runAutomationCli([
    "--dry-run=false",
    "--review=false",
    "--save-draft=true",
    "--submit=false",
    "--headed=false",
    `--url=${fixtureUrl}#media-wrong-surface-batch-resize`,
    `--task-file=${taskFile}`,
    `--profile=${smokeRoot}/save-draft-media-surface-mismatch-profile`,
    `--screenshots=${screenshots}`,
    `--selector-config=${selectorConfig}`,
    "--media-automation-mode=unattended-apply",
    "--media-automation-tools=batch-resize,white-background"
  ])
  assert.equal(result.exitCode, 0, `surface mismatch save-draft runner should exit cleanly. stderr: ${result.stderr}`)

  const report = latestReport(screenshots)
  assert.equal(report.status, "partial", "surface mismatch save-draft should stop before save and leave a partial report")
  const stepIds = report.steps.map((step) => step.id)
  assert(stepIds.includes("media-processing-plan"), "surface mismatch save-draft should include media processing plan")
  assert(stepIds.includes("write-blocked-media-processing"), "surface mismatch save-draft should block later writes")
  assert(!stepIds.includes("save-draft"), "surface mismatch save-draft should stop before the save control")
  assert(!stepIds.includes("submit-listing"), "surface mismatch save-draft must not submit/publish listings")
  assert.equal(report.steps.find((step) => step.id === "media-processing-plan")?.status, "failed", "surface mismatch should fail the media processing plan")
  assert.equal(report.steps.find((step) => step.id === "write-blocked-media-processing")?.status, "failed", "surface mismatch save-draft should record the hard write block")
}

const runWrongSurfaceDryRun = async () => {
  const screenshots = `${smokeRoot}/dry-run-wrong-surface`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<StartResult>(`${baseUrl}/automation/dry-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: wrongSurfaceUrl,
      taskFile,
      profile: `${smokeRoot}/dry-run-wrong-surface-profile`,
      screenshots,
      selectorConfig
    })
  })

  const job = await waitForJob("dry-run", started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/automation/dry-run/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `wrong surface dry-run should still write a report. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `wrong surface dry-run should exit cleanly. stderr: ${log.stderr}`)
  assert.equal(job.reportStatus, "failed", "wrong surface dry-run should fail the execution report")

  const report = latestReport(screenshots)
  const stepIds = report.steps.map((step) => step.id)
  assert.deepEqual(stepIds, ["target-surface"], "wrong surface dry-run should stop after target surface inspection")
  const targetSurface = report.steps[0]
  assert.equal(targetSurface.status, "failed", "wrong surface target inspection should fail")
  assert.equal(targetSurface.data?.surfaceStatus, "missing-fields", "wrong local data page should report missing fields")
  assert.equal(targetSurface.data?.canInspect, false, "wrong surface should not be inspectable")
  assert.equal(targetSurface.data?.canWrite, false, "wrong surface should never be writable")
}

const runDryRunWithDefaultArtifactDir = async (fixtureUrl: string) => {
  const started = await requestJson<StartResult>(`${baseUrl}/automation/dry-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: fixtureUrl,
      taskFile,
      profile: `${smokeRoot}/default-artifact-profile`,
      selectorConfig
    })
  })

  assert.equal(started.artifactDir, `.runtime/automation-artifacts/${started.id}`)
  const job = await waitForJob("dry-run", started.id)
  assert.equal(job.artifactDir, started.artifactDir)
  assert.equal(job.reportStatus, "completed")
  assert(job.reportPath?.includes(started.id), "default artifact report path should include the job id")
}

const runFullFlow = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/full-flow`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<StartResult>(`${baseUrl}/automation/full-flow`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: fixtureUrl,
      taskFile,
      profile: `${smokeRoot}/full-flow-profile`,
      screenshots,
      selectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: ["image-translation"]
    })
  })

  assert.equal(started.artifactDir, screenshots, "full-flow should return the effective artifact directory")
  const job = await waitForFullFlowJob(started.id)
  assert.equal(job.status, "completed", `full-flow should complete. error: ${job.error}`)
  assert.equal(job.artifactDir, screenshots, "full-flow job should keep the requested artifact directory")
  assert.deepEqual(job.stages.map((stage) => stage.name), ["dry-run", "fill-draft", "save-draft"], "full-flow should expose the ordered stage list")
  assert(job.stages.every((stage) => stage.status === "completed"), "full-flow should complete every stage")
  assert(job.stages.every((stage) => stage.reportStatus === "completed"), "full-flow stages should produce completed reports")

  const fillDraftStage = job.stages.find((stage) => stage.name === "fill-draft")
  const saveDraftStage = job.stages.find((stage) => stage.name === "save-draft")
  assert(fillDraftStage?.reportPath, "full-flow should keep the fill-draft stage report path")
  assert(saveDraftStage?.jobId, "full-flow should keep the save-draft stage job id")

  const report = latestReport(screenshots)
  const stepIds = report.steps.map((step) => step.id)
  assert(stepIds.includes("save-draft"), "full-flow final report should be the save-draft stage")
  assert(!stepIds.includes("submit-listing"), "full-flow must not submit/publish listings")

  const fillDraftReport = readExecutionReport(fillDraftStage.reportPath)
  const mediaPlan = fillDraftReport.steps.find((step) => step.id === "media-processing-plan")
  assert.equal(mediaPlan?.data?.safeMode, "unattended-apply", "full-flow should use unattended apply media processing when requested")

  const saveDraftJob = await requestJson<Job>(`${baseUrl}/automation/save-draft/jobs/${saveDraftStage.jobId}`)
  const saveDraftLog = await requestJson<JobLog>(`${baseUrl}/automation/save-draft/jobs/${saveDraftStage.jobId}/logs?maxChars=10000`)
  assert(String(saveDraftJob.command ?? "").includes("--skip-draft-fill=true"), "full-flow save-draft stage should skip draft refill")
  assert(!saveDraftLog.stdout.includes("fill-draft stage:"), "full-flow save-draft stage must not rerun fill-draft")
  assert(saveDraftLog.stdout.includes("save-or-submit stage: entering save draft flow"), "full-flow save-draft stage should enter the save flow directly")
}

const runFullFlowWithSubmit = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/full-flow-submit`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<StartResult>(`${baseUrl}/automation/full-flow`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: fixtureUrl,
      taskFile,
      profile: `${smokeRoot}/full-flow-submit-profile`,
      screenshots,
      selectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: ["image-translation"],
      submitAfterSave: true
    })
  })

  assert.equal(started.artifactDir, screenshots, "submit full-flow should return the effective artifact directory")
  const job = await waitForFullFlowJob(started.id)
  assert.equal(job.status, "completed", `submit full-flow should complete. error: ${job.error}`)
  assert.deepEqual(job.stages.map((stage) => stage.name), ["dry-run", "fill-draft", "save-draft", "submit-listing"], "submit full-flow should expose the ordered stage list")
  assert(job.stages.every((stage) => stage.status === "completed"), "submit full-flow should complete every stage")
  assert(job.stages.every((stage) => stage.reportStatus === "completed"), "submit full-flow stages should produce completed reports")

  const fillDraftStage = job.stages.find((stage) => stage.name === "fill-draft")
  const submitStage = job.stages.find((stage) => stage.name === "submit-listing")
  assert(fillDraftStage?.reportPath, "submit full-flow should keep the fill-draft stage report path")
  assert(submitStage?.jobId, "submit full-flow should keep the submit-listing stage job id")

  const report = latestReport(screenshots)
  const stepIds = report.steps.map((step) => step.id)
  assert(stepIds.includes("submit-listing"), "submit full-flow final report should be the submit-listing stage")
  assert(!stepIds.includes("save-draft"), "submit full-flow final report should not be the save-draft stage")

  const fillDraftReport = readExecutionReport(fillDraftStage.reportPath)
  const mediaPlan = fillDraftReport.steps.find((step) => step.id === "media-processing-plan")
  assert.equal(mediaPlan?.data?.safeMode, "unattended-apply", "submit full-flow should still run unattended apply media processing during fill-draft")

  const submitStep = report.steps.find((step) => step.id === "submit-listing")
  const attempts = submitStep?.data?.attempts as Array<{ state: string; message: string }> | undefined
  assert.equal(submitStep?.status, "done", "submit full-flow should verify Dianxiaomi publish success")
  assert.equal(attempts?.length, 2, "submit full-flow should retry after a transient Dianxiaomi failure")
  assert.equal(attempts?.[0]?.state, "failure", "submit full-flow should record the first failure")
  assert.equal(attempts?.[1]?.state, "success", "submit full-flow should record the success")

  const submitJob = await requestJson<Job>(`${baseUrl}/automation/submit-listing/jobs/${submitStage.jobId}`)
  const submitLog = await requestJson<JobLog>(`${baseUrl}/automation/submit-listing/jobs/${submitStage.jobId}/logs?maxChars=10000`)
  assert(String(submitJob.command ?? "").includes("--skip-draft-fill=true"), "submit full-flow should skip draft refill before submit-listing")
  assert(!submitLog.stdout.includes("fill-draft stage:"), "submit full-flow submit-listing stage must not rerun fill-draft")
  assert(submitLog.stdout.includes("save-or-submit stage: entering submit listing flow"), "submit full-flow should enter the submit flow directly")
}

const runSubmitListingFailure = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/submit-listing-failure`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<StartResult>(`${baseUrl}/automation/submit-listing`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: `${fixtureUrl}#submit-fail`,
      taskFile,
      profile: `${smokeRoot}/submit-listing-failure-profile`,
      screenshots,
      selectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: ["image-translation"],
      submitMaxAttempts: 2
    })
  })

  const job = await waitForJob("submit-listing", started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/automation/submit-listing/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `failed Dianxiaomi publish validation should still write a report. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `failed Dianxiaomi publish validation should exit cleanly. stderr: ${log.stderr}`)
  assert.equal(job.reportStatus, "partial", "submit-listing should produce a partial report when Dianxiaomi reports publish failure")

  const report = latestReport(screenshots)
  const submitStep = report.steps.find((step) => step.id === "submit-listing")
  const attempts = submitStep?.data?.attempts as Array<{ state: string; message: string }> | undefined
  assert.equal(submitStep?.status, "failed", "submit-listing failure should be explicit in the report")
  assert.equal(attempts?.length, 2, "submit-listing should honor submitMaxAttempts for persistent failures")
  assert(attempts?.every((attempt) => attempt.state === "failure"), "submit-listing should record each failed Dianxiaomi attempt")
  assert.match(String(submitStep?.data?.failureReason ?? submitStep?.detail ?? ""), /缺少必填属性|required|failed|失败/i, "submit-listing should record the Dianxiaomi failure reason")
}

const runQueueRun = async (fixtureUrl: string) => {
  const queuedWorkItem = await requestJson<DianxiaomiProductWorkItem>(`${baseUrl}/dianxiaomi/product-work-items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: `queue-run-work-item-${runId}`,
      pageUrl: fixtureUrl,
      pageTitle: "Queue Run Fixture Item",
      title: `Queue run ready item ${runId}`,
      rawTextSample: "Queue run fixture with SKU, price, stock, image tools, and compliant text",
      notes: ["queue run smoke"],
      snapshot: {
        hasTitle: true,
        imageCount: 2,
        skuCount: 1,
        priceFieldCount: 1,
        stockFieldCount: 1,
        attributeKeys: ["color"],
        imageStats: {
          minWidthPx: 1000,
          minHeightPx: 1000,
          maxWidthPx: 1200,
          maxHeightPx: 1200,
          unknownDimensionCount: 0
        },
        mediaToolSignals: ["image translation", "image editor", "batch resize"]
      },
      status: "ready-for-automation"
    })
  })
  assert.equal(queuedWorkItem.status, "ready-for-automation", "queue-run smoke work item should be ready")

  const screenshots = `${smokeRoot}/queue-run`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const queueRun = await requestJson<QueueRunStartResult>(`${baseUrl}/automation/queue-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      screenshots,
      selectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: ["image-translation"],
      limit: 1
    })
  })
  assert.equal(queueRun.queued, 1, `queue-run should start one full-flow job. skipped: ${JSON.stringify(queueRun.skippedItems)}`)
  assert.equal(queueRun.flowJobIds.length, 1, "queue-run should return the started full-flow job id")

  const flowJob = await waitForFullFlowJob(queueRun.flowJobIds[0])
  assert.equal(flowJob.status, "completed", `queue-run full-flow should complete. error: ${flowJob.error}`)
  assert.equal(flowJob.workItemId, queuedWorkItem.id, "queue-run full-flow should record the source work item id")
  assert(flowJob.taskId, "queue-run full-flow should record the generated task id")
  assert(flowJob.taskFile, "queue-run full-flow should record the exported task file")
  assert(flowJob.stages.every((stage) => stage.status === "completed"), "queue-run full-flow should complete every stage")

  const workItems = await requestJson<DianxiaomiProductWorkItem[]>(`${baseUrl}/dianxiaomi/product-work-items`)
  const updatedWorkItem = workItems.find((item) => item.id === queuedWorkItem.id)
  assert.equal(updatedWorkItem?.status, "edited", "queue-run should mark the queued work item edited to avoid duplicate starts")
}

const runSharedProfileQueueRun = async (fixtureUrl: string) => {
  const scopedStoreId = `shared-profile-store-${runId}`
  const scopedStoreName = `Shared Profile Store ${runId}`
  const sharedProfile = path.join(repoRoot, smokeRoot, "queue-run-shared-profile")
  mkdirSync(sharedProfile, {
    recursive: true
  })

  const workItems = await Promise.all([0, 1, 2].map((index) =>
    requestJson<DianxiaomiProductWorkItem>(`${baseUrl}/dianxiaomi/product-work-items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        id: `queue-run-shared-profile-work-item-${runId}-${index}`,
        storeId: scopedStoreId,
        storeName: scopedStoreName,
        pageUrl: `${fixtureUrl}#shared-profile-${index}`,
        pageTitle: `Queue Run Shared Profile Fixture ${index}`,
        title: `Queue run shared profile ready item ${index}`,
        rawTextSample: "Queue run shared profile fixture with SKU, price, stock, image tools, and compliant text",
        notes: ["queue run smoke", "shared profile"],
        snapshot: {
          hasTitle: true,
          imageCount: 2,
          skuCount: 1,
          priceFieldCount: 1,
          stockFieldCount: 1,
          attributeKeys: ["color"],
          imageStats: {
            minWidthPx: 1000,
            minHeightPx: 1000,
            maxWidthPx: 1200,
            maxHeightPx: 1200,
            unknownDimensionCount: 0
          },
          mediaToolSignals: ["image translation", "image editor", "batch resize"]
        },
        status: "ready-for-automation"
      })
    })
  ))
  assert(workItems.every((item) => item.status === "ready-for-automation"), "shared-profile queue-run fixtures should stay ready before launch")

  const screenshots = `${smokeRoot}/queue-run-shared-profile`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const queueRun = await requestJson<QueueRunStartResult>(`${baseUrl}/automation/queue-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      profile: `${smokeRoot}/queue-run-shared-profile`,
      screenshots,
      selectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: ["image-translation"],
      storeId: scopedStoreId,
      storeName: scopedStoreName,
      limit: 3
    })
  })
  assert.equal(queueRun.queued, 3, `shared-profile queue-run should start all scoped full-flow jobs. skipped: ${JSON.stringify(queueRun.skippedItems)}`)
  assert.equal(queueRun.flowJobIds.length, 3, "shared-profile queue-run should return every started full-flow job id")

  const jobs = await Promise.all(queueRun.flowJobIds.map((id) => waitForFullFlowJob(id)))
  assert(jobs.every((job) => job.status !== "running"), `shared-profile queue-run should reach a terminal state instead of hanging. jobs: ${JSON.stringify(jobs.map((job) => ({ id: job.id, status: job.status, error: job.error })))}`)

  const collisionPattern = /launchPersistentContext|Target page, context or browser has been closed/i
  for (const job of jobs) {
    const dryRunStage = job.stages.find((stage) => stage.name === "dry-run")
    assert(dryRunStage?.jobId, `shared-profile queue-run should keep the dry-run job id for ${job.id}`)
    const dryRunLog = await requestJson<JobLog>(`${baseUrl}/automation/dry-run/jobs/${dryRunStage.jobId}/logs?maxChars=4000`)
    assert(
      !collisionPattern.test(`${job.error ?? ""}\n${dryRunLog.stderr}`),
      `shared-profile queue-run should avoid persistent-profile collisions. job=${job.id} error=${job.error ?? "none"} stderr=${dryRunLog.stderr}`
    )
  }

  for (let index = 0; index < jobs.length - 1; index += 1) {
    const current = jobs[index]
    const next = jobs[index + 1]
    const currentFinishedAt = current.finishedAt
    const nextDryRunStartedAt = next.stages.find((stage) => stage.name === "dry-run")?.startedAt ?? null
    assert(currentFinishedAt, "serialized shared-profile full-flow should record current completion time")
    assert(nextDryRunStartedAt, "serialized shared-profile full-flow should record next dry-run start time")
    assert(
      Date.parse(nextDryRunStartedAt) >= Date.parse(currentFinishedAt),
      `shared-profile queue-run should not start ${next.id} before ${current.id} finishes`
    )
  }
}

const runQueueDaemon = async () => {
  const queueDaemonProfilePath = path.join(repoRoot, smokeRoot, "queue-daemon-profile")
  mkdirSync(queueDaemonProfilePath, {
    recursive: true
  })
  const startupBefore = await requestJson<UnattendedStartupCheck>(
    `${baseUrl}/automation/unattended-startup-check?profile=${encodeURIComponent(`${smokeRoot}/queue-daemon-profile`)}&selectorConfig=${encodeURIComponent(selectorConfig)}&mediaAutomationMode=unattended-apply&mediaAutomationTools=image-translation&submitAfterSave=true&submitMaxAttempts=2`
  )
  assert(["ready", "warning", "blocked"].includes(startupBefore.status), "unattended startup check should expose a status")
  assert(startupBefore.checks.some((check) => check.id === "ready-work-items"), "unattended startup check should include ready work items")
  assert(startupBefore.checks.some((check) => check.id === "selector-config"), "unattended startup check should include selector config")
  const calibrationCheck = startupBefore.checks.find((check) => check.id === "real-dianxiaomi-calibration")
  assert(calibrationCheck, "unattended startup check should include real Dianxiaomi calibration")
  assert.equal(calibrationCheck.status, "warning", "fixture selector calibration should warn instead of passing as a real Dianxiaomi page")
  assert.match(calibrationCheck.message, /fixture|real Dianxiaomi/i, "fixture calibration warning should explain real Dianxiaomi calibration is still needed")
  assert(startupBefore.checks.some((check) => check.id === "browser-profile"), "unattended startup check should include browser profile")
  assert(startupBefore.runbook.length >= 3, "unattended startup check should include operator runbook steps")
  assert.equal(startupBefore.normalizedInput.submitAfterSave, true, "unattended startup check should normalize submitAfterSave")
  assert.equal(startupBefore.normalizedInput.submitMaxAttempts, 2, "unattended startup check should normalize submit attempts")

  const initialHealth = await requestJson<QueueDaemonHealth>(`${baseUrl}/automation/queue-daemon/health`)
  assert(["healthy", "warning", "blocked"].includes(initialHealth.status), "queue daemon health should expose an aggregate status")
  assert.equal(initialHealth.queue.daemonStatus, "PAUSED", "queue daemon health should reflect the initial paused state")
  assert.equal(initialHealth.workItems.total >= initialHealth.workItems.ready, true, "queue daemon health should expose work item totals")
  assert(initialHealth.issues.some((issue) => issue.id === "daemon-paused"), "queue daemon health should report the paused daemon")
  assert(initialHealth.alerts.length > 0, "queue daemon health should expose operator alerts")
  assert(
    initialHealth.alerts.some((alert) => alert.id === "resume-paused-daemon" && alert.action.includes("startup check")),
    "queue daemon health should tell the operator how to resume a paused queue with ready work"
  )

  const started = await requestJson<QueueDaemonState>(`${baseUrl}/automation/queue-daemon/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      intervalSeconds: 15,
      maxConsecutiveFailures: 2,
      profile: `${smokeRoot}/queue-daemon-profile`,
      screenshots: `${smokeRoot}/queue-daemon`,
      selectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: ["image-translation"],
      limit: 1,
      submitAfterSave: true,
      submitMaxAttempts: 2
    })
  })
  assert.equal(started.status, "ACTIVE", "queue daemon should start active")
  assert.equal(started.intervalSeconds, 15, "queue daemon should persist interval")
  assert.equal(started.maxConsecutiveFailures, 2, "queue daemon should persist max failure threshold")
  assert.equal(started.input.limit, 1, "queue daemon should persist queue limit")
  assert.equal(started.input.submitAfterSave, true, "queue daemon should persist submitAfterSave")
  assert.equal(started.input.submitMaxAttempts, 2, "queue daemon should persist submit attempts")
  assert(started.nextRunAt, "queue daemon should schedule a next run")
  assert(Array.isArray(started.trackedFlowJobIds), "queue daemon state should expose tracked full-flow ids")
  assert(Array.isArray(started.resolvedFlowJobIds), "queue daemon state should expose resolved full-flow ids")
  assert(Array.isArray(started.flowOutcomes), "queue daemon state should expose recovered flow outcomes")
  const startedHealth = await requestJson<QueueDaemonHealth>(`${baseUrl}/automation/queue-daemon/health`)
  assert.equal(startedHealth.queue.daemonStatus, "ACTIVE", "queue daemon health should reflect active daemon state")
  assert(startedHealth.profile.path?.includes("queue-daemon-profile"), "queue daemon health should expose the configured profile path")
  assert.equal(startedHealth.queue.maxConsecutiveFailures, 2, "queue daemon health should expose the failure threshold")
  assert(startedHealth.alerts.length > 0, "queue daemon health should keep an alerts array available")
  const startupAfter = await requestJson<UnattendedStartupCheck>(
    `${baseUrl}/automation/unattended-startup-check?profile=${encodeURIComponent(`${smokeRoot}/queue-daemon-profile`)}&selectorConfig=${encodeURIComponent(selectorConfig)}&mediaAutomationMode=unattended-apply&mediaAutomationTools=image-translation&submitAfterSave=true&submitMaxAttempts=2`
  )
  assert.equal(startupAfter.health.profile.path?.includes("queue-daemon-profile"), true, "startup check should expose the configured profile path")
  assert.equal(startupAfter.normalizedInput.mediaAutomationMode, "unattended-apply", "startup check should normalize media mode")
  assert.equal(
    startupAfter.checks.find((check) => check.id === "real-dianxiaomi-calibration")?.status,
    "warning",
    "startup check should keep fixture selector calibration visible after daemon start"
  )

  const tick = await requestJson<QueueDaemonTick>(`${baseUrl}/automation/queue-daemon/tick`, {
    method: "POST"
  })
  assert(["completed", "skipped"].includes(tick.status), "queue daemon tick should return a terminal status")
  assert(["ready-queued", "idle-no-items", "work-item-skipped", "tick-already-running", "flow-outcome-recovered"].includes(tick.category), "queue daemon tick should classify the queue result")
  assert(Array.isArray(tick.flowOutcomes), "queue daemon tick should expose recovered flow outcomes")

  const stateAfterTick = await requestJson<QueueDaemonState>(`${baseUrl}/automation/queue-daemon`)
  assert(stateAfterTick.ticks.length > 0, "queue daemon should retain tick history")
  if (tick.category === "idle-no-items") {
    assert.equal(stateAfterTick.consecutiveFailures, 0, "idle queue daemon ticks should not count as failures")
  }

  const paused = await requestJson<QueueDaemonState>(`${baseUrl}/automation/queue-daemon/pause`, {
    method: "POST"
  })
  assert.equal(paused.status, "PAUSED", "queue daemon should pause")
  assert.equal(paused.nextRunAt, null, "paused queue daemon should clear next run")
}

const runQueueDaemonOutcomeRecovery = async (fixtureUrl: string) => {
  const linkedCollected = await requestJson<DianxiaomiCollectedProduct>(`${baseUrl}/dianxiaomi/collected-products`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: `queue-daemon-recovery-collected-${runId}`,
      pageUrl: `${fixtureUrl}#submit-fail`,
      pageTitle: "Queue Daemon Recovery Collected Product",
      collectedAt: new Date().toISOString(),
      title: `Queue daemon recovery collected product ${runId}`,
      category: "Queue daemon recovery category",
      sourceUrl: `${fixtureUrl}#submit-fail`,
      images: ["https://example.com/queue-daemon-recovery.jpg"],
      attributes: {
        color: "green"
      },
      skus: [{
        skuName: "Green L",
        priceCny: 18.2,
        stock: 7,
        attributes: {
          color: "green",
          size: "L"
        },
        rowText: "Green L 18.2 7"
      }],
      rawTextSample: "queue daemon recovery linked collected product",
      notes: ["queue daemon recovery smoke"]
    })
  })
  const queuedWorkItem = await requestJson<DianxiaomiProductWorkItem>(`${baseUrl}/dianxiaomi/product-work-items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: `queue-daemon-recovery-work-item-${runId}`,
      collectedProductId: linkedCollected.id,
      pageUrl: `${fixtureUrl}#submit-fail`,
      pageTitle: "Queue Daemon Recovery Fixture Item",
      title: `Queue daemon recovery ready item ${runId}`,
      rawTextSample: "Queue daemon recovery fixture with SKU, price, stock, image tools, and compliant text",
      notes: ["queue daemon recovery smoke"],
      snapshot: {
        hasTitle: true,
        imageCount: 2,
        skuCount: 1,
        priceFieldCount: 1,
        stockFieldCount: 1,
        attributeKeys: ["color"],
        imageStats: {
          minWidthPx: 1000,
          minHeightPx: 1000,
          maxWidthPx: 1200,
          maxHeightPx: 1200,
          unknownDimensionCount: 0
        },
        mediaToolSignals: ["image translation", "image editor", "batch resize"]
      },
      status: "ready-for-automation"
    })
  })
  assert.equal(queuedWorkItem.status, "ready-for-automation", "queue daemon recovery work item should be ready")
  assert.equal(queuedWorkItem.collectedProductId, linkedCollected.id, "queue daemon recovery work item should retain linked collected product id")

  const screenshots = `${smokeRoot}/queue-daemon-recovery`
  const queueDaemonRecoveryProfilePath = path.join(repoRoot, smokeRoot, "queue-daemon-recovery-profile")
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })
  mkdirSync(queueDaemonRecoveryProfilePath, {
    recursive: true
  })

  await requestJson<QueueDaemonState>(`${baseUrl}/automation/queue-daemon/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      intervalSeconds: 15,
      maxConsecutiveFailures: 2,
      headed: false,
      profile: `${smokeRoot}/queue-daemon-recovery-profile`,
      screenshots,
      selectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: ["image-translation"],
      limit: 1,
      submitAfterSave: true,
      submitMaxAttempts: 2
    })
  })

  let stateAfterQueue = await requestJson<QueueDaemonState>(`${baseUrl}/automation/queue-daemon`)
  for (let attempt = 0; attempt < 20 && stateAfterQueue.trackedFlowJobIds.length === 0; attempt += 1) {
    await sleep(500)
    stateAfterQueue = await requestJson<QueueDaemonState>(`${baseUrl}/automation/queue-daemon`)
  }
  assert(stateAfterQueue.trackedFlowJobIds.length > 0, "queue daemon should track full-flow jobs it starts")

  let trackedFlowJob: FullFlowJob | null = null
  for (let attempt = 0; attempt < 20 && !trackedFlowJob; attempt += 1) {
    stateAfterQueue = await requestJson<QueueDaemonState>(`${baseUrl}/automation/queue-daemon`)
    for (const trackedFlowJobId of stateAfterQueue.trackedFlowJobIds) {
      const candidate = await requestJson<FullFlowJob>(`${baseUrl}/automation/full-flow/jobs/${trackedFlowJobId}`)
      if (candidate.workItemId === queuedWorkItem.id) {
        trackedFlowJob = candidate
        break
      }
    }
    if (!trackedFlowJob) {
      await sleep(500)
    }
  }
  assert(trackedFlowJob, "queue daemon should track the full-flow job for the new work item")

  const flowJobId = trackedFlowJob.id
  const flowJob = await waitForFullFlowJob(flowJobId)
  assert.equal(flowJob.status, "failed", "queue daemon recovery fixture should produce a failed full-flow")
  assert.equal(flowJob.workItemId, queuedWorkItem.id, "failed full-flow should retain the source work item id")

  const recoveryTick = await requestJson<QueueDaemonTick>(`${baseUrl}/automation/queue-daemon/tick`, {
    method: "POST"
  })

  const workItems = await requestJson<DianxiaomiProductWorkItem[]>(`${baseUrl}/dianxiaomi/product-work-items`)
  const updatedWorkItem = workItems.find((item) => item.id === queuedWorkItem.id)
  assert.equal(updatedWorkItem?.status, "blocked", "failed full-flow should mark the work item blocked")
  assert.equal(updatedWorkItem?.failureDiagnosis?.category, "publish-validation", "queue daemon should classify failed submit output as publish validation")
  assert.equal(updatedWorkItem?.failureDiagnosis?.source, "full-flow", "full-flow should persist the publish failure diagnosis before queue recovery")
  assert.equal(updatedWorkItem?.publishOutcome?.status, "failed", "queue daemon should persist failed publish outcomes on the work item")
  assert.equal(updatedWorkItem?.publishOutcome?.flowJobId, flowJobId, "persisted publish outcome should point at the failed full-flow job")
  assert.equal(updatedWorkItem?.publishOutcome?.route, "browser-recovery", "publish validation failures should route toward browser recovery")
  assert.equal(updatedWorkItem?.publishOutcome?.attempts, 2, "persisted publish outcome should keep submit attempt count")
  assert.equal(updatedWorkItem?.publishOutcome?.maxAttempts, 2, "persisted publish outcome should keep submit max attempts")
  assert.match(updatedWorkItem?.publishOutcome?.failureReason ?? "", /required|failed|失败|缺少/i, "persisted publish outcome should keep the Dianxiaomi validation reason")

  const stateAfterRecovery = await requestJson<QueueDaemonState>(`${baseUrl}/automation/queue-daemon`)
  assert(stateAfterRecovery.resolvedFlowJobIds.includes(flowJobId), "queue daemon should remember recovered full-flow ids")
  const recoveredOutcome = stateAfterRecovery.flowOutcomes.find((outcome) => outcome.flowJobId === flowJobId)
  assert(recoveredOutcome, "queue daemon should retain recent recovered outcomes")
  assert.equal(recoveredOutcome.status, "failed", "recovered outcome should retain the failed status")
  assert.match(recoveredOutcome.error ?? "", /submit-listing|publish|failed/i, "recovered flow outcome should keep the publish failure summary")

  const healthAfterRecovery = await requestJson<QueueDaemonHealth>(`${baseUrl}/automation/queue-daemon/health`)
  assert(healthAfterRecovery.workItems.publishFailed >= 1, "queue health should count failed publish outcomes")
  assert(healthAfterRecovery.workItems.publishRecoveryCandidates >= 1, "queue health should count recoverable publish outcomes")
  assert(healthAfterRecovery.workItems.browserRecoveryCandidates >= 1, "publish browser-recovery route should feed browser recovery candidates")
  assert(
    !healthAfterRecovery.manualBudget.publishOutcomes.some((item) => item.workItemId === queuedWorkItem.id),
    "publish browser-recovery route should stay out of manual budget details"
  )
  assert(
    recoveryTick.flowOutcomes.some((outcome) => outcome.flowJobId === flowJobId)
      || stateAfterRecovery.ticks.some((tick) => tick.category === "flow-outcome-recovered" && tick.flowOutcomes.some((outcome) => outcome.flowJobId === flowJobId)),
    "queue daemon should classify outcome-only recovery ticks"
  )

  const secondRecoveryTick = await requestJson<QueueDaemonTick>(`${baseUrl}/automation/queue-daemon/tick`, {
    method: "POST"
  })
  assert(
    !secondRecoveryTick.flowOutcomes.some((outcome) => outcome.flowJobId === flowJobId),
    "queue daemon should not recover the same full-flow twice"
  )

  const paused = await requestJson<QueueDaemonState>(`${baseUrl}/automation/queue-daemon/pause`, {
    method: "POST"
  })
  assert.equal(paused.status, "PAUSED", "queue daemon should pause after recovery smoke")
}

const expectRunningTargetLock = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/running-lock`
  const started = await requestJson<StartResult>(`${baseUrl}/automation/dry-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: fixtureUrl,
      taskFile,
      profile: `${smokeRoot}/running-lock-profile`,
      screenshots,
      selectorConfig
    })
  })

  const blockedStatus = await requestStatus(`${baseUrl}/automation/dry-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: fixtureUrl,
      taskFile,
      profile: `${smokeRoot}/running-lock-profile-2`,
      screenshots: `${smokeRoot}/running-lock-2`,
      selectorConfig
    })
  })

  assert.equal(blockedStatus, 409, "same target should reject a second running automation job")
  const job = await waitForJob("dry-run", started.id)
  assert.equal(job.reportStatus, "completed")
}

const expectSafetyGate = async (mode: "fill-draft" | "save-draft" | "submit-listing", fixtureUrl: string) => {
  const status = await requestStatus(`${baseUrl}/automation/${mode}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: fixtureUrl,
      taskFile,
      profile: `${smokeRoot}/${mode}-blocked-profile`,
      screenshots: `${smokeRoot}/${mode}-blocked`,
      selectorConfig
    })
  })

  assert.equal(status, 409, `${mode} should be blocked before the required previous stage succeeds`)
}

const runSelectorCalibration = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/selector-calibration`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<{ id: string; artifactDir: string }>(`${baseUrl}/selector-calibration`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: `${fixtureUrl}#selector-media-actions`,
      profile: `${smokeRoot}/selector-calibration-profile`,
      screenshots
    })
  })

  assert.equal(started.artifactDir, screenshots)
  const job = await waitForSelectorCalibrationJob(started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/selector-calibration/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `selector calibration should complete. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `selector calibration should exit cleanly. stderr: ${log.stderr}`)
  assert.equal(job.artifactDir, screenshots)

  const artifacts = readdirSync(path.join(repoRoot, screenshots))
  assert(artifacts.some((fileName) => /^dianxiaomi-snapshot-.*\.json$/.test(fileName)), "selector calibration should create a snapshot json")
  assert(artifacts.some((fileName) => /^dianxiaomi-diagnosis-.*\.json$/.test(fileName)), "selector calibration should create a diagnosis json")

  const workbench = await requestJson<SelectorWorkbench>(`${baseUrl}/selector-workbench`)
  assert(workbench.diagnosis, "selector workbench should expose the latest diagnosis")
  assert(workbench.diagnosis.diagnosisPath.includes(screenshots.replace(/\//g, path.sep)), "selector workbench should use the calibration artifact diagnosis")
  assert.equal(workbench.diagnosis.targetSurface?.data?.surfaceStatus, "fixture", "selector workbench should expose the calibration target surface")
  assert.equal(workbench.diagnosis.targetSurface?.data?.isDataFixture, true, "selector workbench should label smoke calibration as fixture")
  assert(workbench.summary.requiredCount > 0, "selector workbench should expose required selector count")
  assert(workbench.summary.candidateCount > 0, "selector workbench should expose selector candidates")
  assert(workbench.items.some((item) => item.group === "fields" && item.key === "title" && item.recommendedSelector), "selector workbench should recommend a title selector")
  assert.equal(workbench.summary.mediaToolCount, 5, "selector workbench should expose all known media tool slots")
  assert((workbench.mediaTools ?? []).filter((item) => item.recommendedSelector).length >= 5, "selector workbench should recognize Dianxiaomi media tool candidates")
  assert(workbench.mediaTools?.some((item) => item.key === "imageTranslation" && item.recommendedSelector), "selector workbench should recommend an image translation selector")
  assert(workbench.mediaTools?.some((item) => item.key === "whiteBackground" && item.recommendedSelector), "selector workbench should recommend a white background selector")
  assert(workbench.mediaTools?.some((item) => item.key === "imageEditor" && item.recommendedSelector), "selector workbench should recommend an image editor selector")
  assert(workbench.mediaTools?.some((item) => item.key === "batchResize" && item.recommendedSelector), "selector workbench should recommend a batch resize selector")
  assert(workbench.mediaTools?.some((item) => item.key === "imageManagement" && item.recommendedSelector), "selector workbench should recommend an image management selector")
  assert.equal(workbench.summary.mediaToolActionCount, 10, "selector workbench should expose all media tool action selector slots")
  assert((workbench.mediaToolActions ?? []).filter((item) => item.recommendedSelector).length >= 10, "selector workbench should recommend media tool apply and close action selectors")
  assert(workbench.mediaToolActions?.some((item) => item.key === "apply.batchResize" && item.recommendedSelector), "selector workbench should recommend a batch resize apply selector")
  assert(workbench.mediaToolActions?.some((item) => item.key === "close.batchResize" && item.recommendedSelector), "selector workbench should recommend a batch resize close selector")
  assert(workbench.skuRows.diagnosisCount > 0, "selector workbench should expose sku row diagnosis")

  const savedConfig = selectorConfigFromWorkbench(workbench)
  assert(savedConfig.mediaTools?.imageTranslation?.length, "selector config generated from workbench should include image translation selector")
  assert(savedConfig.mediaTools?.whiteBackground?.length, "selector config generated from workbench should include white background selector")
  assert(savedConfig.mediaTools?.imageEditor?.length, "selector config generated from workbench should include image editor selector")
  assert(savedConfig.mediaTools?.batchResize?.length, "selector config generated from workbench should include batch resize selector")
  assert(savedConfig.mediaTools?.imageManagement?.length, "selector config generated from workbench should include image management selector")
  assert(savedConfig.mediaToolActions?.apply?.batchResize?.length, "selector config generated from workbench should include batch resize apply selector")
  assert(savedConfig.mediaToolActions?.close?.batchResize?.length, "selector config generated from workbench should include batch resize close selector")
  const saved = await requestJson<SelectorConfigSaveResult>(`${baseUrl}/selector-config`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      config: savedConfig,
      note: "smoke selector config save",
      confirmDangerousChanges: true
    })
  })
  assert(saved.version, "selector config save should create a backup version")
  assertSelectorConfigEquals(saved.config, savedConfig, "selector config save should persist the selected candidates")

  const currentStatus = await requestJson<SelectorConfigStatus>(`${baseUrl}/selector-config`)
  assert(currentStatus.exists, "selector config status should report an existing config after save")
  assert(currentStatus.config, "selector config status should include the saved config")
  assertSelectorConfigEquals(currentStatus.config, savedConfig, "selector config status should return the saved config")

  const generated = await requestJson<SelectorConfigGenerationResult>(`${baseUrl}/selector-config/generate`, {
    method: "POST"
  })
  assert(generated.config.mediaToolActions?.apply?.batchResize?.length, "selector config generation should include batch resize apply selector")
  assert(generated.config.mediaToolActions?.close?.batchResize?.length, "selector config generation should include batch resize close selector")
  const activeConfig = generated.config

  const noChangeDiff = await requestJson<SelectorConfigDiffResult>(`${baseUrl}/selector-config/diff`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      config: activeConfig
    })
  })
  assert.equal(noChangeDiff.summary.changedCount + noChangeDiff.summary.addedCount + noChangeDiff.summary.removedCount, 0, "selector config diff should detect no changes for the current config")

  const modifiedConfig: DianxiaomiSelectorConfig = {
    fields: {
      ...savedConfig.fields,
      title: ["input[name='smokeChangedTitle']"],
      stock: []
    },
    buttons: {
      ...activeConfig.buttons,
      save: []
    },
    mediaTools: activeConfig.mediaTools,
    mediaToolActions: activeConfig.mediaToolActions,
    skuRows: []
  }
  const modifiedDiff = await requestJson<SelectorConfigDiffResult>(`${baseUrl}/selector-config/diff`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      config: modifiedConfig
    })
  })
  assert(modifiedDiff.summary.changedCount > 0, "selector config diff should report changed selectors")
  assert(modifiedDiff.summary.removedCount > 0, "selector config diff should report removed selectors")
  assert.equal(modifiedDiff.blocked, true, "selector config diff should block empty critical selectors")
  assert(modifiedDiff.summary.blockRiskCount > 0, "selector config diff should count blocking risks")
  assert(modifiedDiff.entries.some((entry) => entry.group === "fields" && entry.key === "title" && entry.status === "changed"), "selector config diff should include changed title selector")
  assert(modifiedDiff.entries.some((entry) => entry.group === "buttons" && entry.key === "save" && entry.status === "removed"), "selector config diff should include removed save selector")
  const blockedSaveStatus = await requestStatus(`${baseUrl}/selector-config`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      config: modifiedConfig,
      note: "smoke selector config blocked",
      confirmDangerousChanges: true
    })
  })
  assert.equal(blockedSaveStatus, 409, "selector config save should reject blocked critical selector removals")

  const confirmConfig: DianxiaomiSelectorConfig = {
    ...activeConfig,
    fields: {
      ...activeConfig.fields,
      title: ["input[name='smokeChangedTitle']"]
    },
    mediaTools: {
      ...activeConfig.mediaTools,
      imageTranslation: []
    },
    skuRows: []
  }
  const confirmDiff = await requestJson<SelectorConfigDiffResult>(`${baseUrl}/selector-config/diff`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      config: confirmConfig
    })
  })
  assert.equal(confirmDiff.requiresConfirmation, true, "selector config diff should require confirmation for critical selector replacements")
  assert.equal(confirmDiff.blocked, false, "selector config diff should not block non-empty critical replacements")
  assert(confirmDiff.entries.some((entry) => entry.group === "mediaTools" && entry.key === "imageTranslation" && entry.status === "removed"), "selector config diff should include optional media tool selector removals")
  const unconfirmedSaveStatus = await requestStatus(`${baseUrl}/selector-config`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      config: confirmConfig,
      note: "smoke selector config unconfirmed"
    })
  })
  assert.equal(unconfirmedSaveStatus, 409, "selector config save should require confirmation for critical selector replacements")

  const modified = await requestJson<SelectorConfigSaveResult>(`${baseUrl}/selector-config`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      config: confirmConfig,
      note: "smoke selector config modified",
      confirmDangerousChanges: true
    })
  })
  assert(modified.version, "selector config modified save should create a backup version")

  const restoreDiff = await requestJson<SelectorConfigDiffResult>(`${baseUrl}/selector-config/versions/${modified.version.id}/diff`)
  assert.equal(restoreDiff.version?.id, modified.version.id, "selector config version diff should identify the compared version")
  assert(restoreDiff.summary.changedCount + restoreDiff.summary.addedCount + restoreDiff.summary.removedCount > 0, "selector config version diff should preview restore changes")
  assert.equal(restoreDiff.requiresConfirmation, true, "selector config version diff should require confirmation for critical restore changes")
  assert(restoreDiff.entries.some((entry) => entry.group === "fields" && entry.key === "title" && entry.status === "changed"), "selector config version diff should include title restore change")
  const unconfirmedRestoreStatus = await requestStatus(`${baseUrl}/selector-config/versions/${modified.version.id}/restore`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  })
  assert.equal(unconfirmedRestoreStatus, 409, "selector config restore should require confirmation for critical selector replacements")

  const restoreSaved = await requestJson<SelectorConfigRestoreResult>(`${baseUrl}/selector-config/versions/${modified.version.id}/restore`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      confirmDangerousChanges: true
    })
  })
  assertSelectorConfigEquals(restoreSaved.config, savedConfig, "selector config restore preview target should restore the saved config")

  const versions = await requestJson<SelectorConfigVersion[]>(`${baseUrl}/selector-config/versions`)
  assert(versions.some((version) => version.id === saved.version?.id), "selector config versions should include the save backup")

  const restored = await requestJson<SelectorConfigRestoreResult>(`${baseUrl}/selector-config/versions/${saved.version.id}/restore`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      confirmDangerousChanges: true
    })
  })
  assert.equal(restored.restoredVersion.id, saved.version.id, "selector config restore should identify the restored version")
  assertSelectorConfigEquals(restored.config, saved.version.config, "selector config restore should apply the backup config")
  writeBootstrapSelectorDiagnosis(1000)
}

const runSelectorCalibrationWithMediaSampling = async (fixtureUrl: string) => {
  const screenshots = `${smokeRoot}/selector-calibration-media-sampling`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<{ id: string; artifactDir: string }>(`${baseUrl}/selector-calibration`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: fixtureUrl,
      profile: `${smokeRoot}/selector-calibration-media-sampling-profile`,
      screenshots,
      sampleMediaActions: true,
      mediaAutomationTools: ["batch-resize", "image-translation"]
    })
  })

  assert.equal(started.artifactDir, screenshots)
  const job = await waitForSelectorCalibrationJob(started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/selector-calibration/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `selector calibration media sampling should complete. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `selector calibration media sampling should exit cleanly. stderr: ${log.stderr}`)

  const artifacts = readdirSync(path.join(repoRoot, screenshots))
  const snapshotFile = artifacts
    .filter((fileName) => /^dianxiaomi-snapshot-.*\.json$/.test(fileName))
    .sort()
    .at(-1)
  assert(snapshotFile, "selector calibration media sampling should create a snapshot json")
  const snapshot = JSON.parse(readFileSync(path.join(repoRoot, screenshots, snapshotFile!), "utf8")) as {
    mediaActionSampling?: {
      enabled: boolean
      tools: Array<{ id: string; status: string; sampledButtonCount: number }>
    }
  }
  assert.equal(snapshot.mediaActionSampling?.enabled, true, "selector calibration media sampling should mark sampling enabled")
  assert(snapshot.mediaActionSampling?.tools.some((tool) => tool.id === "batch-resize" && ["sampled", "close-failed", "no-dialog", "missing-tool"].includes(tool.status)), "selector calibration media sampling should include batch resize sampling result")
  assert(snapshot.mediaActionSampling?.tools.some((tool) => tool.id === "image-translation" && ["sampled", "close-failed", "no-dialog", "missing-tool"].includes(tool.status)), "selector calibration media sampling should include image translation sampling result")
  assert(snapshot.mediaActionSampling?.tools.some((tool) => tool.id === "white-background" && tool.status === "skipped"), "selector calibration media sampling should skip non-allowlisted tools")
  writeBootstrapSelectorDiagnosis(1000)
}

const runWrongSurfaceSelectorCalibration = async () => {
  const screenshots = `${smokeRoot}/selector-calibration-wrong-surface`
  mkdirSync(path.join(repoRoot, screenshots), {
    recursive: true
  })

  const started = await requestJson<{ id: string; artifactDir: string }>(`${baseUrl}/selector-calibration`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      headed: false,
      url: wrongSurfaceUrl,
      profile: `${smokeRoot}/selector-calibration-wrong-surface-profile`,
      screenshots
    })
  })

  assert.equal(started.artifactDir, screenshots)
  const job = await waitForSelectorCalibrationJob(started.id)
  const log = await requestJson<JobLog>(`${baseUrl}/selector-calibration/jobs/${started.id}/logs?maxChars=5000`)
  assert.equal(job.status, "completed", `wrong surface selector calibration should complete with a blocking diagnosis. stderr: ${log.stderr}`)
  assert.equal(job.exitCode, 0, `wrong surface selector calibration should exit cleanly. stderr: ${log.stderr}`)

  const workbench = await requestJson<SelectorWorkbench>(`${baseUrl}/selector-workbench`)
  assert(workbench.diagnosis?.diagnosisPath.includes(screenshots.replace(/\//g, path.sep)), "wrong surface workbench should expose the latest wrong-surface diagnosis")
  assert.equal(workbench.diagnosis?.targetSurface?.status, "failed", "wrong surface diagnosis should expose failed target surface")
  assert.equal(workbench.diagnosis?.targetSurface?.data?.surfaceStatus, "missing-fields", "wrong surface diagnosis should record missing fields")
  assert.equal(workbench.validation.valid, false, "wrong surface selector diagnosis should block selector validation")
  assert(
    workbench.validation.issues.some((issue) => issue.id === "selector-diagnosis-target-surface-blocked" && issue.level === "error"),
    "wrong surface selector diagnosis should include target surface validation error"
  )

  const generateStatus = await requestStatus(`${baseUrl}/selector-config/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  })
  assert.equal(generateStatus, 409, "selector config generation should reject a wrong-surface diagnosis")
}

const runQueueDaemonStartupBlockedByWrongSurface = async () => {
  const queuedWorkItem = await requestJson<DianxiaomiProductWorkItem>(`${baseUrl}/dianxiaomi/product-work-items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: `queue-daemon-startup-block-${runId}`,
      pageUrl: wrongSurfaceUrl,
      pageTitle: "Queue Daemon Startup Block Fixture",
      title: `Queue daemon startup blocked item ${runId}`,
      rawTextSample: "Queue daemon startup blocked fixture with SKU, price, stock, and compliant text",
      notes: ["queue daemon startup block smoke"],
      snapshot: {
        hasTitle: true,
        imageCount: 2,
        skuCount: 1,
        priceFieldCount: 1,
        stockFieldCount: 1,
        attributeKeys: ["color"],
        imageStats: {
          minWidthPx: 1000,
          minHeightPx: 1000,
          maxWidthPx: 1200,
          maxHeightPx: 1200,
          unknownDimensionCount: 0
        },
        mediaToolSignals: ["image translation", "batch resize"]
      },
      status: "ready-for-automation"
    })
  })
  assert.equal(queuedWorkItem.status, "ready-for-automation", "startup block work item should be ready before daemon precheck")
  const queueDaemonStartupBlockProfilePath = path.join(repoRoot, smokeRoot, "queue-daemon-startup-block-profile")
  mkdirSync(queueDaemonStartupBlockProfilePath, {
    recursive: true
  })

  const started = await requestJson<QueueDaemonState>(`${baseUrl}/automation/queue-daemon/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      intervalSeconds: 15,
      maxConsecutiveFailures: 2,
      profile: `${smokeRoot}/queue-daemon-startup-block-profile`,
      screenshots: `${smokeRoot}/queue-daemon-startup-block`,
      selectorConfig,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: ["image-translation"],
      limit: 1
    })
  })
  assert.equal(started.status, "PAUSED", "queue daemon should stay paused when startup precheck blocks activation")
  assert.equal(started.nextRunAt, null, "blocked startup should not schedule another run")
  assert.match(started.lastError ?? "", /Dianxiaomi|surface|page/i, "blocked startup should explain the target surface problem")

  const stateAfterTick = await requestJson<QueueDaemonState>(`${baseUrl}/automation/queue-daemon`)
  assert.equal(stateAfterTick.status, "PAUSED", "blocked startup should keep the daemon paused")
  assert.equal(stateAfterTick.nextRunAt, null, "blocked startup should not leave a scheduled tick")

  const paused = await requestJson<QueueDaemonState>(`${baseUrl}/automation/queue-daemon/pause`, {
    method: "POST"
  })
  assert.equal(paused.status, "PAUSED", "queue daemon should pause after startup block smoke")
}

const main = async () => {
  assert(existsSync(fixturePath), `fixture not found: ${fixturePath}`)
  assert(existsSync(path.join(repoRoot, taskFile)), `task fixture not found: ${taskFile}`)
  assert(existsSync(selectorConfigPath), `selector config not found: ${selectorConfig}`)
  writeRepairApplyFixturePlan()
  writeBootstrapSelectorDiagnosis()

  const fixtureHtml = readFileSync(fixturePath, "utf8")
  const originalSelectorConfig = readFileSync(selectorConfigPath, "utf8")
  const originalPlannerState = existsSync(plannerStatePath) ? readFileSync(plannerStatePath, "utf8") : null
  const fixtureUrl = `data:text/html;charset=utf-8,${encodeURIComponent(fixtureHtml)}`
  const server = startServer()
  let serverStdout = ""
  let serverStderr = ""
  server.stdout.on("data", (chunk: Buffer) => {
    serverStdout += chunk.toString("utf8")
  })
  server.stderr.on("data", (chunk: Buffer) => {
    serverStderr += chunk.toString("utf8")
  })

  try {
    await waitForHealth()
    await expectAutomationPresets()
    await expectDianxiaomiCollectedProductImport()
    await expectDianxiaomiProductWorkQueue()
    await expectDianxiaomiRequirementRules()
    await expectTaskFileExport()
    await expectPreflight()
    await expectSafetyGate("fill-draft", fixtureUrl)
    await expectSafetyGate("save-draft", fixtureUrl)
    await expectSafetyGate("submit-listing", fixtureUrl)
    await runDryRunWithDefaultArtifactDir(fixtureUrl)
    await expectRunningTargetLock(fixtureUrl)
    await runSelectorCalibration(fixtureUrl)
    await runSelectorCalibrationWithMediaSampling(fixtureUrl)

    const results = []
    if (shouldRunSmokeStep("mode-dry-run")) {
      results.push(await runMode("dry-run", fixtureUrl))
    }
    if (shouldRunSmokeStep("repair-apply")) {
      results.push(await runRepairApply(fixtureUrl))
    }
    if (shouldRunSmokeStep("wrong-surface-dry-run")) {
      await runWrongSurfaceDryRun()
    }
    if (shouldRunSmokeStep("unattended-media-dry-run")) {
      await runUnattendedMediaDryRun(fixtureUrl)
    }
    if (shouldRunSmokeStep("unattended-media-apply")) {
      await runUnattendedMediaApplyDryRun(fixtureUrl)
    }
    if (shouldRunSmokeStep("unattended-media-transient-retry-success")) {
      await runUnattendedMediaTransientRetrySuccessDryRun(fixtureUrl)
    }
    if (shouldRunSmokeStep("unattended-media-configured-actions")) {
      await runUnattendedMediaConfiguredActionsDryRun(fixtureUrl)
    }
    if (shouldRunSmokeStep("unattended-media-silent-batch-resize")) {
      await runUnattendedMediaSilentBatchResizeDryRun(fixtureUrl)
    }
    if (shouldRunSmokeStep("unattended-media-apply-failure")) {
      await runUnattendedMediaApplyFailureDryRun(fixtureUrl)
    }
    if (shouldRunSmokeStep("unattended-media-surface-mismatch")) {
      await runUnattendedMediaSurfaceMismatchDryRun(fixtureUrl)
    }
    if (shouldRunSmokeStep("unattended-media-transient-failure")) {
      await runUnattendedMediaTransientFailureDryRun(fixtureUrl)
    }
    if (shouldRunSmokeStep("media-failure-blocks-save-draft")) {
      await runMediaFailureBlocksSaveDraft(fixtureUrl)
    }
    if (shouldRunSmokeStep("media-surface-mismatch-blocks-save-draft")) {
      await runMediaSurfaceMismatchBlocksSaveDraft(fixtureUrl)
    }
    if (shouldRunSmokeStep("fill-draft-safety-mismatch")) {
      await expectSafetyGate("fill-draft", `${fixtureUrl}#mismatched-target`)
    }

    if (shouldRunSmokeStep("mode-fill-draft")) {
      results.push(await runMode("fill-draft", fixtureUrl))
    }
    if (shouldRunSmokeStep("fill-draft-size-chart-cleanup")) {
      await runFillDraftSizeChartCleanup(fixtureUrl)
    }
    if (shouldRunSmokeStep("save-draft-safety-mismatch")) {
      await expectSafetyGate("save-draft", `${fixtureUrl}#mismatched-target`)
    }

    if (shouldRunSmokeStep("mode-save-draft")) {
      results.push(await runMode("save-draft", fixtureUrl))
    }
    if (shouldRunSmokeStep("submit-listing-safety-mismatch")) {
      await expectSafetyGate("submit-listing", `${fixtureUrl}#mismatched-target`)
    }
    if (shouldRunSmokeStep("mode-submit-listing")) {
      results.push(await runMode("submit-listing", fixtureUrl))
    }
    if (shouldRunSmokeStep("target-fingerprint-consistency")) {
      assert.equal(
        new Set(results.filter((result) => result.mode !== "repair-apply").map((result) => result.targetFingerprint)).size,
        1,
        "normal flow should use one target fingerprint"
      )
    }
    if (shouldRunSmokeStep("full-flow")) {
      await runFullFlow(fixtureUrl)
    }
    if (shouldRunSmokeStep("full-flow-with-submit")) {
      await runFullFlowWithSubmit(fixtureUrl)
    }
    if (shouldRunSmokeStep("full-flow-submit-fail")) {
      await runFullFlow(`${fixtureUrl}#submit-fail`)
    }
    if (shouldRunSmokeStep("submit-listing-failure")) {
      await runSubmitListingFailure(fixtureUrl)
    }
    if (shouldRunSmokeStep("queue-run")) {
      await runQueueRun(fixtureUrl)
    }
    if (shouldRunSmokeStep("shared-profile-queue-run")) {
      await runSharedProfileQueueRun(fixtureUrl)
    }
    if (shouldRunSmokeStep("queue-daemon")) {
      await runQueueDaemon()
    }
    if (shouldRunSmokeStep("queue-daemon-outcome-recovery")) {
      await runQueueDaemonOutcomeRecovery(fixtureUrl)
    }
    if (shouldRunSmokeStep("wrong-surface-selector-calibration")) {
      await runWrongSurfaceSelectorCalibration()
    }
    if (shouldRunSmokeStep("queue-daemon-startup-blocked-by-wrong-surface")) {
      await runQueueDaemonStartupBlockedByWrongSurface()
    }
    if (shouldRunSmokeStep("selector-calibration-rerun")) {
      await runSelectorCalibration(fixtureUrl)
    }
    if (shouldRunSmokeStep("selector-calibration-media-sampling-rerun")) {
      await runSelectorCalibrationWithMediaSampling(fixtureUrl)
    }

    console.log(JSON.stringify({
      baseUrl,
      smokeRoot,
      results
    }, null, 2))
  } catch (error) {
    console.error(serverStdout)
    console.error(serverStderr)
    throw error
  } finally {
    writeFileSync(selectorConfigPath, originalSelectorConfig, "utf8")
    if (originalPlannerState !== null) {
      writeFileSync(plannerStatePath, originalPlannerState, "utf8")
    }
    await stopServer(server)
  }
}

await main()
