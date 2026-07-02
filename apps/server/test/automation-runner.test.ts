import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const testDir = path.join(tmpdir(), `temu-ai-ops-automation-runner-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
process.env.QUEUE_DAEMON_STATE_PATH = path.join(testDir, "queue-daemon-state.json")
process.env.RECOVERY_RUN_HISTORY_PATH = path.join(testDir, "recovery-runs.json")
process.env.MANUAL_BUDGET_PROOF_LEDGER_PATH = path.join(testDir, "manual-budget-proof-ledger.json")
process.env.MANUAL_BUDGET_TRIAL_HISTORY_PATH = path.join(testDir, "manual-budget-trials.json")
process.env.PROFILE_LOCK_LEDGER_PATH = path.join(testDir, "profile-lock-ledger.json")
process.env.PLANNER_STATE_PATH = path.join(testDir, "planner-state.json")
process.env.TASK_EXPORT_HISTORY_PATH = path.join(testDir, "automation-task-exports.json")
process.env.SELECTOR_DIAGNOSIS_DIRS = path.join(testDir, "selector-diagnoses")

const {
  AutomationSafetyGateError,
  archiveStaleProfileLocks,
  buildDianxiaomiPublishOutcomeForFullFlow,
  buildAutomationModeArgs,
  buildAutomationTargetFingerprint,
  classifyDianxiaomiWorkFailure,
  collectDianxiaomiSnapshotEnrichmentFromReports,
  getAutomationModeReadiness,
  getAutomationJobTimeoutMs,
  getDianxiaomiQueueDaemonHealth,
  getDianxiaomiQueueDaemonState,
  getDianxiaomiUnattendedStartupCheck,
  getFullFlowJobTimeoutMs,
  getProfileLockArchiveReadiness,
  listManualBudgetProofRecords,
  listManualBudgetTrials,
  pauseDianxiaomiQueueDaemon,
  recordManualBudgetProof,
  recordManualBudgetProofFromRecoveryTrial,
  restoreDianxiaomiQueueDaemon,
  startDianxiaomiDryRun,
  getDianxiaomiFullFlowJob,
  startDianxiaomiQueueDaemon,
  startDianxiaomiQueueRun,
  startDianxiaomiRecoveryRun,
  startManualBudgetTrial,
  startNextManualBudgetValidationRun,
  getDianxiaomiRecoveryRun,
  listDianxiaomiRecoveryRuns,
  tickDianxiaomiQueueDaemon
} = await import("../src/automation-runner")
const {
  createTaskFromDianxiaomiCollectedProduct,
  createTaskFromDianxiaomiProductWorkItem,
  exportDianxiaomiRepairPreview,
  getDianxiaomiPageContext,
  getDianxiaomiProductWorkItem,
  listDianxiaomiStoreMetrics,
  mergeDianxiaomiProductWorkItemSnapshot,
  requeueDianxiaomiProductWorkItemAfterFix,
  saveDianxiaomiPageContext,
  saveDianxiaomiCollectedProduct,
  saveDianxiaomiProductWorkItem,
  updateDianxiaomiProductWorkItemStatus,
  exportTaskFile,
  listTaskFileExports,
  validateSelectorConfig,
  validateDianxiaomiAutomationPageUrl
} = await import("../src/planner")

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const loginFailure = classifyDianxiaomiWorkFailure("login captcha required")
assert.equal(loginFailure.category, "login-or-captcha", "login/captcha failures should be classified")
assert.equal(loginFailure.retryable, false, "login/captcha failures should wait for manual session recovery")
assert.equal(loginFailure.autoRetryRecommended, false, "login/captcha failures should not auto retry")

const selectorFailure = classifyDianxiaomiWorkFailure("selector config validation failed")
assert.equal(selectorFailure.category, "selector-config", "selector config failures should be classified")
assert.equal(selectorFailure.autoRetryRecommended, false, "selector failures need calibration before retry")

const mediaFailure = classifyDianxiaomiWorkFailure("media processing failed during batch resize")
assert.equal(mediaFailure.category, "media-processing", "media tool failures should be classified")
assert.equal(mediaFailure.retryable, false, "unclassified media failures should wait for a structured tool result")
assert.equal(mediaFailure.autoRetryRecommended, false, "media failures should not auto retry without a successful tool signal")

const transientMediaFailure = classifyDianxiaomiWorkFailure("media-processing-plan: Batch resize failed; failureKind=transient; retryable=true; service busy, please try again")
assert.equal(transientMediaFailure.category, "media-processing", "structured transient media failures should stay in media category")
assert.equal(transientMediaFailure.retryable, true, "transient media failures should be retryable after operator review")
assert.equal(transientMediaFailure.autoRetryRecommended, false, "transient media failures should not auto retry by the queue daemon")

const invalidMediaFailure = classifyDianxiaomiWorkFailure("media-processing-plan: Batch resize failed; failureKind=invalid-media; retryable=false; image size invalid")
assert.equal(invalidMediaFailure.category, "media-processing", "structured invalid media failures should stay in media category")
assert.equal(invalidMediaFailure.retryable, false, "invalid media failures should not be retryable until images are fixed")

const helpUrlValidation = validateDianxiaomiAutomationPageUrl("https://help.dianxiaomi.com/search?searchValue=temu")
assert.equal(helpUrlValidation.valid, false, "help-center URLs should not be accepted as Dianxiaomi automation targets")
assert.match(helpUrlValidation.reason ?? "", /help-center|product listing edit page/i, "help-center URL validation should explain the block")

const storageQuotaMediaFailure = classifyDianxiaomiWorkFailure("media-processing-plan: Batch resize failed; failureKind=storage-quota; retryable=false; 错误：图片空间不足，您可以通过删除已发布产品的图片或者购买获取更多空间。")
assert.equal(storageQuotaMediaFailure.category, "media-processing", "image space quota failures should stay in media category")
assert.equal(storageQuotaMediaFailure.retryable, false, "image space quota failures should not be retryable until space is fixed")
assert.equal(storageQuotaMediaFailure.autoRetryRecommended, false, "image space quota failures should not auto retry")
assert.match(storageQuotaMediaFailure.nextAction, /image space|图片空间|购买/, "image space quota failures should point to freeing or buying image space")

const taskFileFailure = classifyDianxiaomiWorkFailure("task file snapshot is stale")
assert.equal(taskFileFailure.category, "task-file", "task file failures should be classified")
assert.equal(taskFileFailure.retryable, true, "task file failures can be retried after refresh")
assert.equal(taskFileFailure.autoRetryRecommended, true, "task file refresh is safe to auto retry")

const publishFailure = classifyDianxiaomiWorkFailure("publish failed because required attribute is missing")
assert.equal(publishFailure.category, "publish-validation", "publish validation failures should be classified")
assert.equal(publishFailure.autoRetryRecommended, false, "publish validation failures should not auto retry")

const waitForLatestQueueTick = async () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = getDianxiaomiQueueDaemonState()
    if (!state.running && state.ticks[0]) {
      return state.ticks[0]
    }
    await sleep(100)
  }

  throw new Error("queue daemon tick did not finish")
}

const waitForNextQueueTick = async (previousTickId: string | null) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = getDianxiaomiQueueDaemonState()
    if (!state.running && state.ticks[0] && state.ticks[0].id !== previousTickId) {
      return state.ticks[0]
    }
    await sleep(100)
  }

  throw new Error("next queue daemon tick did not finish")
}

const waitForWorkItemStatus = async (id: string, status: string) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const item = getDianxiaomiProductWorkItem(id)
    if (item?.status === status) {
      return item
    }
    await sleep(100)
  }

  throw new Error(`work item ${id} did not reach ${status}`)
}

const waitForRecoveryRun = async (id: string) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const run = getDianxiaomiRecoveryRun(id)
    if (run && run.status !== "running") {
      return run
    }
    await sleep(100)
  }

  throw new Error(`recovery run ${id} did not finish`)
}

const writeRealSelectorDiagnosis = (fileName: string, pageUrl: string, pageTitle: string, offsetMs = 1_000) => {
  writeFileSync(path.join(process.env.SELECTOR_DIAGNOSIS_DIRS ?? testDir, fileName), JSON.stringify({
    pageUrl,
    pageTitle,
    createdAt: new Date(Date.now() + offsetMs).toISOString(),
    requiredOk: true,
    targetSurface: {
      id: "target-surface",
      label: "Target surface",
      status: "done",
      detail: "real Dianxiaomi listing edit page",
      data: {
        surfaceStatus: "real-dianxiaomi",
        isDianxiaomiHost: true,
        isDataFixture: false,
        canInspect: true,
        fieldReadiness: {
          stock: 1
        }
      }
    },
    summary: {
      fieldCount: 4,
      buttonCount: 2,
      skuRowCount: 1,
      mediaToolCount: 1
    },
    fields: {
      title: {
        ok: true,
        candidates: [{ selectorHint: "input[name='title']", score: 10, text: "title" }]
      },
      description: {
        ok: true,
        candidates: [{ selectorHint: "textarea[name='description']", score: 10, text: "description" }]
      },
      price: {
        ok: true,
        candidates: [{ selectorHint: "input[name='price']", score: 10, text: "price" }]
      },
      stock: {
        ok: true,
        candidates: [{ selectorHint: "input[name='stock']", score: 10, text: "stock" }]
      },
      attribute: {
        ok: true,
        candidates: [{ selectorHint: "[data-attribute-editor]", score: 10, text: "attribute" }]
      }
    },
    buttons: {
      save: {
        ok: true,
        candidates: [{ selectorHint: "button.save", score: 10, text: "save" }]
      },
      submit: {
        ok: true,
        candidates: [{ selectorHint: "button.submit", score: 10, text: "submit" }]
      }
    },
    mediaTools: {
      batchResize: {
        ok: true,
        candidates: [{ selectorHint: "[data-media-tool='batchResize']", score: 10, text: "batch resize" }]
      }
    },
    mediaToolActions: {
      apply: {
        batchResize: {
          ok: true,
          candidates: [{ selectorHint: "[data-media-action='batchResize-apply']", score: 10, text: "apply" }]
        }
      },
      close: {
        batchResize: {
          ok: true,
          candidates: [{ selectorHint: "[data-media-action='batchResize-close']", score: 10, text: "close" }]
        }
      }
    },
    skuRows: {
      ok: true,
      count: 1,
      samples: []
    }
  }, null, 2), "utf8")
}

const cases = [
  {
    mode: "dry-run",
    expected: ["--dry-run=true"],
    forbidden: ["--save-draft=true", "--submit=true"]
  },
  {
    mode: "repair-preview",
    expected: ["--dry-run=true"],
    forbidden: ["--save-draft=true", "--submit=true"]
  },
  {
    mode: "repair-apply",
    expected: ["--dry-run=false", "--repair-mode=apply", "--review=true", "--save-draft=false", "--submit=false"],
    forbidden: ["--save-draft=true", "--submit=true"]
  },
  {
    mode: "fill-draft",
    expected: ["--dry-run=false", "--review=true", "--save-draft=false", "--submit=false"],
    forbidden: ["--save-draft=true", "--submit=true"]
  },
  {
    mode: "save-draft",
    expected: ["--dry-run=false", "--review=false", "--save-draft=true", "--submit=false"],
    forbidden: ["--review=true", "--submit=true"]
  },
  {
    mode: "submit-listing",
    expected: ["--dry-run=false", "--review=false", "--save-draft=false", "--submit=true"],
    forbidden: ["--review=true", "--save-draft=true"]
  }
] as const

for (const testCase of cases) {
  const args = buildAutomationModeArgs(testCase.mode)
  assert.deepEqual(args, testCase.expected, `${testCase.mode} should use the expected safety flags`)

  for (const forbiddenArg of testCase.forbidden) {
    assert(!args.includes(forbiddenArg), `${testCase.mode} must not include ${forbiddenArg}`)
  }
}

assert.equal(getAutomationJobTimeoutMs("dry-run"), 10 * 60 * 1000, "dry-run timeout should stay bounded")
assert.equal(getAutomationJobTimeoutMs("fill-draft"), 20 * 60 * 1000, "fill-draft timeout should cover unattended media processing")
assert.equal(getAutomationJobTimeoutMs("save-draft"), 15 * 60 * 1000, "save-draft timeout should exceed default job timeout")
assert.equal(getAutomationJobTimeoutMs("submit-listing"), 20 * 60 * 1000, "submit-listing timeout should allow post-save publish waits")
assert.equal(getFullFlowJobTimeoutMs(), 60 * 60 * 1000, "full-flow timeout should exceed the sum of long-running stage budgets")

mkdirSync(testDir, {
  recursive: true
})

const publishSuccessReportPath = path.join(testDir, "publish-success-report.json")
writeFileSync(publishSuccessReportPath, JSON.stringify({
  id: "publish-success-report",
  taskId: "task-success",
  taskTitle: "Publish success",
  platform: "dianxiaomi",
  pageUrl: "https://www.dianxiaomi.com/product/edit/publish-success",
  pageTitle: "Publish success",
  status: "completed",
  createdAt: new Date().toISOString(),
  screenshotPath: "",
  steps: [
    {
      id: "submit-listing",
      label: "Submit listing",
      status: "done",
      detail: "Dianxiaomi submit succeeded: success",
      data: {
        attempts: [
          {
            attempt: 1,
            clickedSubmit: true,
            clickedConfirm: true,
            state: "success",
            message: "success",
            source: "toast"
          }
        ],
        maxAttempts: 3,
        success: true,
        verified: true
      }
    }
]

}, null, 2), "utf8")
const publishSuccessOutcome = buildDianxiaomiPublishOutcomeForFullFlow({
  id: "flow-publish-success",
  startedAt: new Date().toISOString(),
  targetFingerprint: "publish-success",
  artifactDir: testDir,
  status: "completed",
  finishedAt: new Date().toISOString(),
  error: null,
  input: {
    submitAfterSave: true
  },
  source: "queue-run",
  workItemId: "work-publish-success",
  taskId: "task-success",
  taskFile: null,
  stages: [
    {
      name: "submit-listing",
      status: "completed",
      jobId: "submit-job-success",
      reportPath: publishSuccessReportPath,
      reportStatus: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: null
    }
  ]
})
assert.equal(publishSuccessOutcome?.status, "succeeded", "successful submit reports should create a succeeded publish outcome")
assert.equal(publishSuccessOutcome?.route, "published", "successful submit reports should route to published")
assert.equal(publishSuccessOutcome?.attempts, 1, "successful publish outcome should keep attempt count")
assert.equal(publishSuccessOutcome?.submitStageJobId, "submit-job-success", "publish outcome should keep the submit job id")

const publishFailureReportPath = path.join(testDir, "publish-failure-report.json")
writeFileSync(publishFailureReportPath, JSON.stringify({
  id: "publish-failure-report",
  taskId: "task-failure",
  taskTitle: "Publish failure",
  platform: "dianxiaomi",
  pageUrl: "https://www.dianxiaomi.com/product/edit/publish-failure",
  pageTitle: "Publish failure",
  status: "failed",
  createdAt: new Date().toISOString(),
  screenshotPath: "",
  steps: [
    {
      id: "submit-listing",
      label: "Submit listing",
      status: "failed",
      detail: "Dianxiaomi submit did not succeed: missing required attribute Color",
      data: {
        attempts: [
          {
            attempt: 1,
            clickedSubmit: true,
            clickedConfirm: true,
            state: "failure",
            message: "missing required attribute Color",
            source: "validation"
          },
          {
            attempt: 2,
            clickedSubmit: true,
            clickedConfirm: true,
            state: "failure",
            message: "missing required attribute Color",
            source: "validation"
          }
        ],
        maxAttempts: 2,
        success: false,
        failureReason: "missing required attribute Color"
      }
    }
  ]
}, null, 2), "utf8")
const publishFailureDiagnosis = classifyDianxiaomiWorkFailure("submit-listing: missing required attribute Color", "full-flow")
const publishFailureOutcome = buildDianxiaomiPublishOutcomeForFullFlow({
  id: "flow-publish-failure",
  startedAt: new Date().toISOString(),
  targetFingerprint: "publish-failure",
  artifactDir: testDir,
  status: "failed",
  finishedAt: new Date().toISOString(),
  error: "submit-listing failed",
  input: {
    submitAfterSave: true
  },
  source: "queue-run",
  workItemId: "work-publish-failure",
  taskId: "task-failure",
  taskFile: null,
  stages: [
    {
      name: "submit-listing",
      status: "failed",
      jobId: "submit-job-failure",
      reportPath: publishFailureReportPath,
      reportStatus: "failed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: "submit-listing failed"
    }
  ]
}, publishFailureDiagnosis)
assert.equal(publishFailureOutcome?.status, "failed", "failed submit reports should create a failed publish outcome")
assert.equal(publishFailureOutcome?.route, "browser-recovery", "publish-validation failures should route toward browser recovery/fix handling")
assert.equal(publishFailureOutcome?.attempts, 2, "failed publish outcome should keep all submit attempts")
assert.equal(publishFailureOutcome?.maxAttempts, 2, "failed publish outcome should keep max attempts")
assert.equal(publishFailureOutcome?.failureReason, "missing required attribute Color", "failed publish outcome should keep the Dianxiaomi validation reason")
assert(publishFailureOutcome, "publish failure outcome should be available for route tests")

const publishOutcomeWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-publish-outcome-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-publish-outcome-work-item",
  pageTitle: "Publish outcome page",
  title: "Publish outcome work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "ready-for-automation"
})
const publishOutcomeUpdatedWorkItem = updateDianxiaomiProductWorkItemStatus(
  publishOutcomeWorkItem.id,
  "blocked",
  "publish outcome fixture failed",
  publishFailureDiagnosis,
  publishFailureOutcome
)
assert.equal(publishOutcomeUpdatedWorkItem?.publishOutcome?.route, "browser-recovery", "work item status updates should persist publish outcome routing")
assert.equal(publishOutcomeUpdatedWorkItem?.publishOutcome?.attempts, 2, "work item status updates should persist publish outcome attempt counts")
const publishOutcomeHealth = getDianxiaomiQueueDaemonHealth()
assert(publishOutcomeHealth.workItems.publishFailed >= 1, "queue health should count failed publish outcomes")
assert(publishOutcomeHealth.workItems.publishRecoveryCandidates >= 1, "queue health should count publish outcomes that can feed recovery handling")

const mediaEnrichmentReportPath = path.join(testDir, "media-enrichment-report.json")
writeFileSync(mediaEnrichmentReportPath, JSON.stringify({
  id: "media-enrichment-report",
  taskId: "task-media-enrichment",
  taskTitle: "Media enrichment",
  platform: "dianxiaomi",
  pageUrl: "https://www.dianxiaomi.com/product/edit/media-enrichment",
  pageTitle: "Media enrichment",
  status: "completed",
  createdAt: new Date().toISOString(),
  screenshotPath: "",
  steps: [
    {
      id: "media-processing-plan",
      label: "Media processing",
      status: "done",
      detail: "media tools applied",
      data: {
        tools: [
          {
            id: "image-translation",
            label: "Image translation",
            status: "applied",
            applied: true
          },
          {
            id: "batch-resize",
            label: "Batch resize",
            status: "applied",
            applied: true
          },
          {
            id: "image-editor",
            label: "Xiaomi image editor",
            status: "applied",
            applied: true
          },
          {
            id: "image-management",
            label: "Image management",
            status: "applied",
            applied: true,
            feedbackState: "success",
            feedbackMessage: "image check passed"
          },
          {
            id: "white-background",
            label: "White background",
            status: "open-failed",
            applied: false
          }
        ]
      }
    }
  ]
}, null, 2), "utf8")
const mediaEnrichmentPatch = collectDianxiaomiSnapshotEnrichmentFromReports([mediaEnrichmentReportPath])
assert.deepEqual(mediaEnrichmentPatch, {
  mediaToolSignals: ["image translation", "batch resize", "Xiaomi image editor", "image check"],
  imageCheck: {
    passed: true
  }
}, "completed media reports should map applied Dianxiaomi tools into work item snapshot signals")

const imageCheckIssueReportPath = path.join(testDir, "image-check-issue-report.json")
writeFileSync(imageCheckIssueReportPath, JSON.stringify({
  id: "image-check-issue-report",
  taskId: "task-image-check-issue",
  taskTitle: "Image check issue",
  platform: "dianxiaomi",
  pageUrl: "https://www.dianxiaomi.com/product/edit/image-check-issue",
  pageTitle: "Image check issue",
  status: "failed",
  createdAt: new Date().toISOString(),
  screenshotPath: "",
  steps: [
    {
      id: "media-processing-plan",
      label: "Media processing",
      status: "failed",
      detail: "image management failed",
      data: {
        tools: [
          {
            id: "image-management",
            label: "Image management",
            status: "apply-failed",
            applied: false,
            failureKind: "invalid-media",
            retryable: false,
            feedbackMessage: "图片检测发现问题：轮播图尺寸不符合要求；产品图比例错误",
            imageCheckIssues: [
              {
                category: "轮播图",
                issue: "尺寸",
                detail: "轮播图尺寸不符合要求"
              },
              {
                category: "产品图",
                issue: "比例",
                detail: "产品图比例错误"
              }
            ]
          }
        ]
      }
    }
  ]
}, null, 2), "utf8")
const imageCheckIssuePatch = collectDianxiaomiSnapshotEnrichmentFromReports([imageCheckIssueReportPath])
assert.deepEqual(imageCheckIssuePatch, {
  mediaToolSignals: [],
  imageCheck: {
    passed: false,
    issues: [
      {
        category: "轮播图",
        issue: "尺寸",
        detail: "轮播图尺寸不符合要求"
      },
      {
        category: "产品图",
        issue: "比例",
        detail: "产品图比例错误"
      }
    ]
  }
}, "image check issue reports should preserve categorized issue details in snapshot enrichment")

const mediaEnrichmentWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-media-enrichment-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-media-enrichment-work-item",
  pageTitle: "Media enrichment page",
  title: "Media enrichment work item title",
  rawTextSample: "complete listing with compliant text and existing image translation",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    imageStats: {
      minWidthPx: 1200,
      minHeightPx: 1200,
      maxWidthPx: 1600,
      maxHeightPx: 1600,
      unknownDimensionCount: 0
    },
    mediaToolSignals: ["image translation"]
  },
  status: "blocked"
})
assert(
  mediaEnrichmentWorkItem.requirements.checks.some((check) => check.id === "media-editor-review" && !check.ok),
  "before enrichment the image editor review signal should still be missing"
)
assert(
  mediaEnrichmentWorkItem.requirements.checks.some((check) => check.id === "media-english-only-images" && !check.ok),
  "before enrichment the english-only image check should still be missing"
)
const mergedMediaEnrichmentWorkItem = mergeDianxiaomiProductWorkItemSnapshot(
  mediaEnrichmentWorkItem.id,
  mediaEnrichmentPatch ?? {}
)
assert.equal(mergedMediaEnrichmentWorkItem?.status, "blocked", "snapshot enrichment should preserve the current blocked status until full-flow resolution updates it")
assert.deepEqual(mergedMediaEnrichmentWorkItem?.snapshot.mediaToolSignals, [
  "image translation",
  "batch resize",
  "Xiaomi image editor",
  "image check"
], "snapshot enrichment should merge new media signals without dropping existing ones")
assert.equal(mergedMediaEnrichmentWorkItem?.snapshot.imageCheck?.passed, true, "snapshot enrichment should persist the image-check pass flag")
assert(
  mergedMediaEnrichmentWorkItem?.requirements.checks.some((check) => check.id === "media-editor-review" && check.ok),
  "snapshot enrichment should rescore the image editor review requirement"
)
assert(
  mergedMediaEnrichmentWorkItem?.requirements.checks.some((check) => check.id === "media-english-only-images" && check.ok),
  "snapshot enrichment should rescore the english-only image requirement"
)
const resolvedMediaEnrichmentWorkItem = updateDianxiaomiProductWorkItemStatus(
  mediaEnrichmentWorkItem.id,
  "edited",
  "media enrichment test resolved"
)
assert(
  resolvedMediaEnrichmentWorkItem?.requirements.checks.some((check) => check.id === "media-english-only-images" && check.ok),
  "status updates after snapshot enrichment should retain the recomputed media requirements"
)

const publishAutoRetryRouteOutcome = {
  ...publishFailureOutcome,
  flowJobId: "flow-publish-auto-retry-route",
  failureReason: "stale publish task file",
  message: "stale publish task file",
  route: "auto-retry" as const
}
const beforePublishAutoRetryRouteHealth = getDianxiaomiQueueDaemonHealth()
const publishAutoRetryRouteWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-publish-auto-retry-route-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-publish-auto-retry-route-work-item",
  pageTitle: "Publish auto retry route page",
  title: "Publish auto retry route work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  publishOutcome: publishAutoRetryRouteOutcome
})
const afterPublishAutoRetryRouteHealth = getDianxiaomiQueueDaemonHealth()
assert.equal(
  afterPublishAutoRetryRouteHealth.workItems.autoRetryCandidates,
  beforePublishAutoRetryRouteHealth.workItems.autoRetryCandidates + 1,
  "publishOutcome auto-retry route should feed safe retry candidates"
)
assert(
  !afterPublishAutoRetryRouteHealth.manualBudget.publishOutcomes.some((item) => item.workItemId === publishAutoRetryRouteWorkItem.id),
  "publishOutcome auto-retry route should not enter the manual-step budget"
)
updateDianxiaomiProductWorkItemStatus(publishAutoRetryRouteWorkItem.id, "edited", "publish auto-retry route fixture complete")

const publishBrowserRecoveryRouteOutcome = {
  ...publishFailureOutcome,
  flowJobId: "flow-publish-browser-recovery-route",
  route: "browser-recovery" as const
}
const beforePublishBrowserRouteHealth = getDianxiaomiQueueDaemonHealth()
const publishBrowserRouteWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-publish-browser-recovery-route-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-publish-browser-recovery-route-work-item",
  pageTitle: "Publish browser recovery route page",
  title: "Publish browser recovery route work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...transientMediaFailure,
    updatedAt: new Date().toISOString()
  },
  publishOutcome: publishBrowserRecoveryRouteOutcome
})
const afterPublishBrowserRouteHealth = getDianxiaomiQueueDaemonHealth()
assert.equal(
  afterPublishBrowserRouteHealth.workItems.browserRecoveryCandidates,
  beforePublishBrowserRouteHealth.workItems.browserRecoveryCandidates + 1,
  "publishOutcome browser-recovery route should feed browser recovery candidates when the repair plan is auto-ready"
)
assert.equal(
  afterPublishBrowserRouteHealth.workItems.autoRetryCandidates,
  beforePublishBrowserRouteHealth.workItems.autoRetryCandidates,
  "publishOutcome browser-recovery route should not also feed direct safe retry"
)
assert(
  !afterPublishBrowserRouteHealth.manualBudget.publishOutcomes.some((item) => item.workItemId === publishBrowserRouteWorkItem.id),
  "publishOutcome browser-recovery route should not enter the manual-step budget"
)
updateDianxiaomiProductWorkItemStatus(publishBrowserRouteWorkItem.id, "edited", "publish browser-recovery route fixture complete")

const publishManualBudgetRouteOutcome = {
  ...publishFailureOutcome,
  flowJobId: "flow-publish-manual-budget-route",
  route: "manual-budget" as const
}
const beforePublishManualRouteHealth = getDianxiaomiQueueDaemonHealth()
const publishManualRouteWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-publish-manual-budget-route-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-publish-manual-budget-route-work-item",
  pageTitle: "Publish manual budget route page",
  title: "Publish manual budget route work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...transientMediaFailure,
    updatedAt: new Date().toISOString()
  },
  publishOutcome: publishManualBudgetRouteOutcome
})
const afterPublishManualRouteHealth = getDianxiaomiQueueDaemonHealth()
assert.equal(
  afterPublishManualRouteHealth.workItems.autoRetryCandidates,
  beforePublishManualRouteHealth.workItems.autoRetryCandidates,
  "publishOutcome manual-budget route should not feed safe retry candidates"
)
assert.equal(
  afterPublishManualRouteHealth.workItems.browserRecoveryCandidates,
  beforePublishManualRouteHealth.workItems.browserRecoveryCandidates,
  "publishOutcome manual-budget route should not feed browser recovery candidates even when the repair plan is auto-ready"
)
assert.equal(
  afterPublishManualRouteHealth.workItems.publishManualBudget,
  beforePublishManualRouteHealth.workItems.publishManualBudget + 1,
  "publishOutcome manual-budget route should remain visible as manual-step budget work"
)
assert.equal(
  afterPublishManualRouteHealth.manualBudget.total,
  beforePublishManualRouteHealth.manualBudget.total + 1,
  "publishOutcome manual-budget route should add a concrete manual-step budget entry"
)
const manualBudgetEntry = afterPublishManualRouteHealth.manualBudget.publishOutcomes.find((item) => item.workItemId === publishManualRouteWorkItem.id)
assert(manualBudgetEntry, "manual-step budget should expose the affected work item")
assert.equal(manualBudgetEntry.source, "publish-outcome", "manual-step budget entry should identify publish outcome as its source")
assert.match(manualBudgetEntry.reason, /manual-budget/, "manual-step budget entry should explain why unattended automation is excluded")
assert.match(manualBudgetEntry.operatorAction, /Retry|Check|Review|Use|Open|Inspect|Fix/i, "manual-step budget entry should include a concrete operator action")
assert.match(manualBudgetEntry.releaseCondition, /ready-for-automation|auto-ready/, "manual-step budget entry should include a release condition before unattended retry")
const manualBudgetReplacement = afterPublishManualRouteHealth.manualBudget.replacementQueue.find((candidate) =>
  candidate.sampleWorkItemIds.includes(publishManualRouteWorkItem.id)
)
assert(manualBudgetReplacement, "manual-step budget should group repeated reasons into a replacement queue")
assert.equal(manualBudgetReplacement.activeCount, 1, "replacement queue should count active manual-budget work")
assert.equal(manualBudgetReplacement.defaultEligible, false, "replacement queue candidates should not enter the default flow without proof")
assert.equal(manualBudgetReplacement.proofGate.status, "needs-proof", "replacement queue candidates should require click/decision reduction proof")
assert.match(manualBudgetReplacement.replacementPlan, /AI|browser|automation|monitor|calibration|deterministic/i, "replacement queue should provide an automation replacement plan")
const manualBudgetAlert = afterPublishManualRouteHealth.alerts.find((alert) => alert.id === "manual-step-budget")
assert(manualBudgetAlert, "queue health should surface one compact manual-step budget alert")
assert.match(manualBudgetAlert.action, /Release condition/, "manual-step budget alert should include the release condition")
updateDianxiaomiProductWorkItemStatus(publishManualRouteWorkItem.id, "edited", "publish manual-budget route fixture complete")
const afterPublishManualRouteClosedHealth = getDianxiaomiQueueDaemonHealth()
assert(
  !afterPublishManualRouteClosedHealth.manualBudget.publishOutcomes.some((item) => item.workItemId === publishManualRouteWorkItem.id),
  "manual-step budget should only count currently blocked manual-budget work"
)

const validSelectorConfigPath = path.join(testDir, "valid-selectors.json")
const missingSelectorConfigPath = path.join(testDir, "missing-selectors.json")
const incompleteSelectorConfigPath = path.join(testDir, "incomplete-selectors.json")

const target = {
  url: "https://www.dianxiaomi.com/product/edit/unit-real-product",
  taskFile: path.join(testDir, "valid-task-file.json"),
  selectorConfig: validSelectorConfigPath
}
mkdirSync(testDir, {
  recursive: true
})
mkdirSync(process.env.SELECTOR_DIAGNOSIS_DIRS, {
  recursive: true
})
writeFileSync(target.taskFile, JSON.stringify({
  id: "valid-task-file",
  product: {
    id: "valid-product",
    source: "dianxiaomi",
    sourceUrl: "https://www.dianxiaomi.com/product/edit/unit-real-product",
    title: "Valid task file",
    category: "Dianxiaomi product edit",
    supplierPriceCny: 1,
    estimatedDomesticShippingCny: 0,
    estimatedWeightKg: 0.1,
    images: [],
    attributes: {},
    skus: []
  },
  draft: {
    productId: "valid-product",
    listingTitle: "Valid task file",
    sellingPoints: [],
    description: "",
    categoryPath: [],
    attributes: {
      dianxiaomiPageUrl: "https://www.dianxiaomi.com/product/edit/unit-real-product"
    },
    skuPricing: []
  }
}, null, 2), "utf8")
writeFileSync(target.selectorConfig, JSON.stringify({
  fields: {
    title: ["input[name='title']"],
    description: ["textarea[name='description']"],
    price: ["input[name='price']"],
    stock: ["input[name='stock']"]
  },
  buttons: {
    save: ["button.save"]
  },
  skuRows: []
}, null, 2), "utf8")

const targetFingerprint = buildAutomationTargetFingerprint(target)
assert.equal(targetFingerprint, buildAutomationTargetFingerprint({ ...target }), "same target input should produce the same fingerprint")
assert.notEqual(
  targetFingerprint,
  buildAutomationTargetFingerprint({ ...target, url: "https://www.dianxiaomi.com/product/edit/unit-another-product" }),
  "different target input should produce a different fingerprint"
)

assert.equal(getAutomationModeReadiness("dry-run", target).ready, true, "dry-run should always be ready for a target")
assert.equal(getAutomationModeReadiness("dry-run", target).targetFingerprint, targetFingerprint)
assert.equal(getAutomationModeReadiness("repair-preview", target).ready, false, "repair-preview should require a repair plan file")
assert.match(
  getAutomationModeReadiness("repair-preview", target).reason,
  /repair plan file/i,
  "repair-preview readiness should explain missing repair plan file"
)
const repairPreviewFile = path.join(testDir, "repair-preview.json")
writeFileSync(repairPreviewFile, JSON.stringify({
  workItemId: "unit-repair-preview",
  pageUrl: target.url,
  pageTitle: "Repair preview",
  exportedAt: new Date().toISOString(),
  repairPlan: {
    status: "assisted",
    source: "failure-diagnosis",
    summary: "fix Color",
    canAutoRepair: false,
    canRetryAfterRepair: true,
    blockers: [],
    createdAt: new Date().toISOString(),
    actions: [{
      id: "repair-color",
      type: "fix-field",
      label: "fix Color",
      detail: "Color is required",
      automation: "assisted",
      required: true,
      field: "attribute",
      target: "Color",
      payload: {
        writer: "fill-attributes",
        selectorGroup: "fields",
        selectorKey: "attribute",
        fieldKind: "attribute",
        attributeKey: "Color",
        reasonCode: "publish-attribute"
      }
    }]
  }
}, null, 2), "utf8")
const repairPreviewTarget = {
  ...target,
  repairPlanFile: repairPreviewFile
}
assert.equal(getAutomationModeReadiness("repair-preview", repairPreviewTarget).ready, true, "repair-preview should be ready with selectors, task file, target, and repair plan")
assert.equal(getAutomationModeReadiness("repair-apply", target).ready, false, "repair-apply should require a repair plan file")
assert.match(
  getAutomationModeReadiness("repair-apply", target).reason,
  /repair plan file/i,
  "repair-apply readiness should explain missing repair plan file"
)
assert.equal(getAutomationModeReadiness("repair-apply", repairPreviewTarget).ready, true, "repair-apply should be ready with selectors, task file, target, and repair plan")
assert.match(
  getAutomationModeReadiness("repair-apply", repairPreviewTarget).reason,
  /without save or submit/i,
  "repair-apply readiness should explain the safe execution boundary"
)
assert.notEqual(
  buildAutomationTargetFingerprint(target),
  buildAutomationTargetFingerprint(repairPreviewTarget),
  "repair plan file should be part of the target fingerprint"
)
assert.equal(getAutomationModeReadiness("fill-draft", target).ready, false, "fill-draft should require a matching dry-run")
assert.equal(
  getAutomationModeReadiness("fill-draft", target).reason,
  "fill-draft requires a completed dry-run report",
  "valid selector config should let fill-draft fail on the dry-run prerequisite"
)
assert.equal(getAutomationModeReadiness("save-draft", target).ready, false, "save-draft should require a matching fill-draft")
assert.equal(
  getAutomationModeReadiness("save-draft", target).reason,
  "save-draft requires a completed fill-draft report",
  "valid selector config should let save-draft fail on the fill-draft prerequisite"
)
assert.equal(getAutomationModeReadiness("submit-listing", target).ready, false, "submit-listing should require a matching save-draft")
assert.equal(
  getAutomationModeReadiness("submit-listing", target).reason,
  "submit-listing requires a completed save-draft report",
  "valid selector config should let submit-listing fail on the save-draft prerequisite"
)

const missingSelectorTarget = {
  ...target,
  selectorConfig: missingSelectorConfigPath
}
const missingSelectorReadiness = getAutomationModeReadiness("fill-draft", missingSelectorTarget)
assert.equal(missingSelectorReadiness.ready, false, "fill-draft should block when selector config is missing")
assert(missingSelectorReadiness.selectorValidation, "fill-draft readiness should include selector validation details")
assert.equal(missingSelectorReadiness.selectorValidation.valid, false, "missing selector config should be invalid")
assert(
  missingSelectorReadiness.selectorBlockers?.some((issue) => issue.id === "selector-config-missing"),
  "missing selector config should be exposed as a selector blocker"
)
assert.match(missingSelectorReadiness.reason, /selector config validation failed/, "selector blockers should drive the readiness reason")

const incompleteSelectorTarget = {
  ...target,
  selectorConfig: incompleteSelectorConfigPath
}
writeFileSync(incompleteSelectorTarget.selectorConfig, JSON.stringify({
  fields: {
    title: ["input[name='title']"]
  },
  buttons: {},
  skuRows: []
}, null, 2), "utf8")
const incompleteSelectorReadiness = getAutomationModeReadiness("save-draft", incompleteSelectorTarget)
assert.equal(incompleteSelectorReadiness.ready, false, "save-draft should block when required selectors are missing")
assert(
  incompleteSelectorReadiness.selectorBlockers?.some((issue) => issue.id === "field-description-missing"),
  "missing required field selectors should be exposed as selector blockers"
)
assert(
  incompleteSelectorReadiness.selectorBlockers?.some((issue) => issue.id === "button-save-missing"),
  "missing save selector should be exposed as a selector blocker"
)

const previousStockViaSkuRowsDiagnosisDirs = process.env.SELECTOR_DIAGNOSIS_DIRS
try {
  const stockViaSkuRowsDiagnosisDir = path.join(testDir, "stock-via-sku-rows-diagnoses")
  mkdirSync(stockViaSkuRowsDiagnosisDir, { recursive: true })
  process.env.SELECTOR_DIAGNOSIS_DIRS = stockViaSkuRowsDiagnosisDir
  writeFileSync(path.join(stockViaSkuRowsDiagnosisDir, "dianxiaomi-diagnosis-unit-stock-via-sku-rows.json"), JSON.stringify({
    pageUrl: target.url,
    pageTitle: "Stock via SKU rows real Dianxiaomi calibration",
    createdAt: new Date(Date.now() + 2_000).toISOString(),
    requiredOk: true,
    targetSurface: {
      id: "target-surface",
      label: "Target surface",
      status: "done",
      detail: "real Dianxiaomi listing edit page",
      data: {
        surfaceStatus: "real-dianxiaomi",
        isDianxiaomiHost: true,
        isDataFixture: false,
        canInspect: true,
        fieldReadiness: {
          stock: 1
        }
      }
    },
    summary: {
      fieldCount: 4,
      buttonCount: 2,
      skuRowCount: 1,
      mediaToolCount: 0
    },
    fields: {
      title: {
        ok: true,
        candidates: [{ selectorHint: "input[name='title']", score: 10, text: "title" }]
      },
      description: {
        ok: true,
        candidates: [{ selectorHint: "textarea[name='description']", score: 10, text: "description" }]
      },
      price: {
        ok: true,
        candidates: [{ selectorHint: "input[name='price']", score: 10, text: "price" }]
      },
      stock: {
        ok: false,
        candidates: []
      },
      attribute: {
        ok: true,
        candidates: [{ selectorHint: "[data-attribute-editor]", score: 10, text: "attribute" }]
      }
    },
    buttons: {
      save: {
        ok: true,
        candidates: [{ selectorHint: "button.save", score: 10, text: "save" }]
      },
      submit: {
        ok: true,
        candidates: [{ selectorHint: "button.submit", score: 10, text: "submit" }]
      }
    },
    mediaTools: {},
    mediaToolActions: {
      apply: {},
      close: {}
    },
    skuRows: {
      ok: true,
      count: 1,
      samples: []
    }
  }, null, 2), "utf8")
  writeFileSync(incompleteSelectorTarget.selectorConfig, JSON.stringify({
    fields: {
      title: ["input[name='title']"],
      description: ["textarea[name='description']"],
      price: ["input[name='price']"],
      stock: [],
      attribute: ["[data-attribute-editor]"]
    },
    buttons: {
      save: ["button.save"],
      submit: ["button.submit"]
    },
    skuRows: ["tr, [role='row'], [class*='sku' i], [class*='table-row' i], [class*='row' i]"]
  }, null, 2), "utf8")
  const stockViaSkuRowsValidation = validateSelectorConfig(incompleteSelectorTarget.selectorConfig)
  assert.equal(stockViaSkuRowsValidation.valid, true, "stock selector should not block when the latest diagnosis proves SKU rows are writable")
  assert(
    stockViaSkuRowsValidation.issues.some((issue) =>
      issue.id === "field-stock-preserved"
      && issue.level === "warning"
      && /SKU rows/i.test(issue.message)
    ),
    "stock via SKU rows should be downgraded to a preserved warning"
  )
} finally {
  process.env.SELECTOR_DIAGNOSIS_DIRS = previousStockViaSkuRowsDiagnosisDirs
}

const staleProfileLockPath = path.join(testDir, "stale-profile-lock")
mkdirSync(staleProfileLockPath, { recursive: true })
const staleProfileLockFile = path.join(staleProfileLockPath, "SingletonLock")
writeFileSync(staleProfileLockFile, "stale lock from abandoned browser session", "utf8")
const staleProfileLockTime = new Date(Date.now() - 48 * 60 * 60 * 1000)
utimesSync(staleProfileLockFile, staleProfileLockTime, staleProfileLockTime)
const staleProfileStartup = getDianxiaomiUnattendedStartupCheck({
  profile: staleProfileLockPath,
  selectorConfig: validSelectorConfigPath,
  limit: 1
})
assert.deepEqual(staleProfileStartup.health.profile.lockFiles, [], "stale profile locks should not be treated as active startup blockers")
assert(
  staleProfileStartup.health.profile.staleLockFiles.some((fileName) => fileName.includes("SingletonLock")),
  "stale profile locks should remain visible in queue health"
)
assert.equal(
  staleProfileStartup.checks.find((check) => check.id === "browser-profile")?.status,
  "pass",
  "stale profile locks should not make the browser profile startup check warning or block"
)
assert.equal(staleProfileStartup.health.profile.lockAudit.ignored, 1, "stale profile locks should be recorded in the ignored lock audit")
assert.equal(staleProfileStartup.health.profile.lockAudit.archived, 0, "stale profile lock audit should not mark files archived automatically")
assert.equal(
  staleProfileStartup.health.profile.lockAudit.recent[0]?.action,
  "ignored-stale-lock",
  "stale profile lock audit should record the safe ignored action"
)
assert(
  staleProfileStartup.health.profile.lockAudit.recent[0]?.detail.includes("SingletonLock"),
  "stale profile lock audit should include the lock file detail"
)
assert(existsSync(process.env.PROFILE_LOCK_LEDGER_PATH ?? ""), "profile lock audit ledger should persist to disk")
const staleProfileLockLedger = JSON.parse(readFileSync(process.env.PROFILE_LOCK_LEDGER_PATH ?? "", "utf8")) as {
  entries: Array<{ action: string; profilePath: string; fileName: string }>
}
assert.equal(staleProfileLockLedger.entries.length, 1, "profile lock audit ledger should persist the stale lock once")
assert.equal(staleProfileLockLedger.entries[0]?.action, "ignored-stale-lock", "persisted profile lock audit should keep the ignored action")
const repeatedStaleProfileStartup = getDianxiaomiUnattendedStartupCheck({
  profile: staleProfileLockPath,
  selectorConfig: validSelectorConfigPath,
  limit: 1
})
assert.equal(
  repeatedStaleProfileStartup.health.profile.lockAudit.ignored,
  1,
  "profile lock audit should not duplicate the same stale lock on repeated health checks"
)
const staleProfileArchiveReadiness = getProfileLockArchiveReadiness({
  profile: staleProfileLockPath,
  selectorConfig: validSelectorConfigPath,
  limit: 1
})
assert.equal(staleProfileArchiveReadiness.status, "ready", "stale-only profile locks should be archive-ready")
assert.equal(staleProfileArchiveReadiness.readyItems.length, 1, "stale-only profile should expose one ready archive item")
assert.equal(staleProfileArchiveReadiness.readyItems[0]?.fileName, "SingletonLock", "stale archive item should name the lock file")
assert(
  staleProfileArchiveReadiness.readyItems[0]?.archiveTarget.includes(".archived-profile-locks"),
  "stale archive item should expose the future archive target"
)
assert(existsSync(staleProfileLockFile), "archive readiness should not delete or move stale profile locks")
const staleProfileArchiveResult = archiveStaleProfileLocks({
  profile: staleProfileLockPath,
  selectorConfig: validSelectorConfigPath,
  limit: 1
})
assert.equal(staleProfileArchiveResult.status, "archived", "stale-only profile locks should be archived by the guarded action")
assert.equal(staleProfileArchiveResult.archivedItems.length, 1, "guarded archive should return the archived stale lock")
assert.equal(staleProfileArchiveResult.archivedItems[0]?.fileName, "SingletonLock", "archive result should name the moved lock file")
assert(!existsSync(staleProfileLockFile), "guarded archive should move the original stale profile lock")
assert(
  existsSync(staleProfileArchiveResult.archivedItems[0]?.archiveTarget ?? ""),
  "guarded archive should create the archive target file"
)
const archivedStaleProfileReadiness = getProfileLockArchiveReadiness({
  profile: staleProfileLockPath,
  selectorConfig: validSelectorConfigPath,
  limit: 1
})
assert.equal(archivedStaleProfileReadiness.status, "idle", "archived stale profile should become archive-idle")
assert.deepEqual(archivedStaleProfileReadiness.readyItems, [], "archived stale profile should not keep ready archive items")
const archivedStaleProfileStartup = getDianxiaomiUnattendedStartupCheck({
  profile: staleProfileLockPath,
  selectorConfig: validSelectorConfigPath,
  limit: 1
})
assert.deepEqual(archivedStaleProfileStartup.health.profile.lockFiles, [], "archive directory should not be reported as an active lock")
assert.deepEqual(archivedStaleProfileStartup.health.profile.staleLockFiles, [], "archive directory should not be reported as a stale lock")
assert.equal(archivedStaleProfileStartup.health.profile.lockAudit.ignored, 1, "archived profile should keep the ignored stale-lock audit")
assert.equal(archivedStaleProfileStartup.health.profile.lockAudit.archived, 1, "archived profile should record the stale-lock archive audit")
const archivedProfileLockLedger = JSON.parse(readFileSync(process.env.PROFILE_LOCK_LEDGER_PATH ?? "", "utf8")) as {
  entries: Array<{ action: string; profilePath: string; fileName: string; detail: string }>
}
const staleProfileLockLedgerEntries = archivedProfileLockLedger.entries.filter((entry) => entry.profilePath === staleProfileLockPath)
assert(
  staleProfileLockLedgerEntries.some((entry) => entry.action === "ignored-stale-lock"),
  "profile lock ledger should retain the ignored stale-lock audit entry"
)
assert(
  staleProfileLockLedgerEntries.some((entry) => entry.action === "archived-stale-lock"),
  "profile lock ledger should persist the archived stale-lock audit entry"
)
assert(
  ![...archivedStaleProfileStartup.health.profile.lockFiles, ...archivedStaleProfileStartup.health.profile.staleLockFiles]
    .some((fileName) => fileName.includes(".archived-profile-locks")),
  "archive directory should be excluded from profile lock scans"
)

const activeProfileLockPath = path.join(testDir, "active-profile-lock")
mkdirSync(activeProfileLockPath, { recursive: true })
writeFileSync(path.join(activeProfileLockPath, "SingletonLock"), "active lock from current browser session", "utf8")
const activeProfileStartup = getDianxiaomiUnattendedStartupCheck({
  profile: activeProfileLockPath,
  selectorConfig: validSelectorConfigPath,
  limit: 1
})
assert(
  activeProfileStartup.health.profile.lockFiles.some((fileName) => fileName.includes("SingletonLock")),
  "fresh profile locks should still be treated as active startup blockers"
)
assert.deepEqual(activeProfileStartup.health.profile.staleLockFiles, [], "fresh profile locks should not be marked stale")
assert.equal(
  activeProfileStartup.checks.find((check) => check.id === "browser-profile")?.status,
  "block",
  "fresh profile locks should block unattended startup until the profile lock clears"
)
const previousMissingProfileTickId = getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null
const blockedWithoutProfile = startDianxiaomiQueueDaemon({
  intervalSeconds: 15,
  maxConsecutiveFailures: 1,
  limit: 1,
  selectorConfig: validSelectorConfigPath
})
assert.equal(blockedWithoutProfile.status, "PAUSED", "queue daemon should not activate unattended mode without a configured browser profile")
assert.equal(blockedWithoutProfile.nextRunAt, null, "missing browser profile startup block should not schedule another queue daemon run")
assert.match(blockedWithoutProfile.lastError ?? "", /browser profile path is not configured/i, "missing browser profile startup block should explain the profile requirement")
assert.equal(getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null, previousMissingProfileTickId, "missing browser profile startup block should not create a queue tick")
const previousUninitializedProfileTickId = getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null
const blockedWithoutInitializedProfile = startDianxiaomiQueueDaemon({
  intervalSeconds: 15,
  maxConsecutiveFailures: 1,
  limit: 1,
  profile: path.join(testDir, "missing-daemon-profile"),
  selectorConfig: validSelectorConfigPath
})
assert.equal(blockedWithoutInitializedProfile.status, "PAUSED", "queue daemon should not activate unattended mode with an uninitialized browser profile directory")
assert.equal(blockedWithoutInitializedProfile.nextRunAt, null, "uninitialized browser profile startup block should not schedule another queue daemon run")
assert.match(blockedWithoutInitializedProfile.lastError ?? "", /browser profile directory is missing|initialize/i, "uninitialized browser profile startup block should explain the headed profile setup requirement")
assert.equal(getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null, previousUninitializedProfileTickId, "uninitialized browser profile startup block should not create a queue tick")
const activeProfileArchiveReadiness = getProfileLockArchiveReadiness({
  profile: activeProfileLockPath,
  selectorConfig: validSelectorConfigPath,
  limit: 1
})
assert.equal(activeProfileArchiveReadiness.status, "blocked", "fresh profile locks should block archive readiness")
assert.equal(activeProfileArchiveReadiness.readyItems.length, 0, "fresh profile locks should not be archive-ready")
assert(
  activeProfileArchiveReadiness.blockedItems.some((item) => item.fileName === "SingletonLock"),
  "blocked archive readiness should include the fresh lock file"
)
assert.equal(
  getProfileLockArchiveReadiness({ selectorConfig: validSelectorConfigPath, limit: 1 }).status,
  "blocked",
  "profile lock archive readiness should block when no profile is configured"
)
assert.equal(
  getProfileLockArchiveReadiness({ profile: path.join(testDir, "missing-profile-lock"), selectorConfig: validSelectorConfigPath, limit: 1 }).status,
  "blocked",
  "profile lock archive readiness should block when the profile directory is missing"
)

const daemonProfilePath = path.join(testDir, "daemon-default-profile")
mkdirSync(daemonProfilePath, { recursive: true })
const daemonStarted = startDianxiaomiQueueDaemon({
  intervalSeconds: 15,
  maxConsecutiveFailures: 2,
  limit: 2,
  profile: daemonProfilePath,
  submitAfterSave: true,
  submitMaxAttempts: 4
})
assert.equal(daemonStarted.status, "ACTIVE", "queue daemon should start active")
assert.equal(daemonStarted.intervalSeconds, 15, "queue daemon should persist interval")
assert.equal(daemonStarted.maxConsecutiveFailures, 2, "queue daemon should persist failure threshold")
assert.equal(daemonStarted.input.limit, 2, "queue daemon should persist queue limit")
assert.equal(daemonStarted.input.submitAfterSave, true, "queue daemon should persist submitAfterSave")
assert.equal(daemonStarted.input.submitMaxAttempts, 4, "queue daemon should persist submit attempts")
assert(Array.isArray(daemonStarted.trackedFlowJobIds), "queue daemon should expose tracked full-flow ids")
assert(Array.isArray(daemonStarted.resolvedFlowJobIds), "queue daemon should expose resolved full-flow ids")
assert(Array.isArray(daemonStarted.flowOutcomes), "queue daemon should expose recovered full-flow outcomes")
assert.equal(getDianxiaomiQueueDaemonHealth().flows.unresolved, 0, "queue daemon startup without queued work should not report unresolved flows")
assert(getDianxiaomiQueueDaemonState().nextRunAt, "queue daemon should schedule a next run")
assert(existsSync(process.env.QUEUE_DAEMON_STATE_PATH), "queue daemon should persist state to disk")
const persistedDaemonState = JSON.parse(readFileSync(process.env.QUEUE_DAEMON_STATE_PATH, "utf8")) as { status: string; input: { limit?: number }; trackedFlowJobIds?: string[]; resolvedFlowJobIds?: string[]; flowOutcomes?: unknown[] }
assert.equal(persistedDaemonState.status, "ACTIVE", "persisted queue daemon state should retain active status")
assert.equal(persistedDaemonState.input.limit, 2, "persisted queue daemon state should retain launch input")
assert(Array.isArray(persistedDaemonState.trackedFlowJobIds), "persisted queue daemon state should retain tracked full-flow ids")
assert(Array.isArray(persistedDaemonState.resolvedFlowJobIds), "persisted queue daemon state should retain resolved full-flow ids")
assert(Array.isArray(persistedDaemonState.flowOutcomes), "persisted queue daemon state should retain recovered flow outcomes")
const restoredDaemonState = restoreDianxiaomiQueueDaemon()
assert.equal(restoredDaemonState.status, "ACTIVE", "queue daemon restore should reload persisted active status")
assert.equal(restoredDaemonState.running, false, "queue daemon restore should not preserve a stale running tick")
assert(restoredDaemonState.nextRunAt, "queue daemon restore should reschedule active daemon")
const daemonPaused = pauseDianxiaomiQueueDaemon()
assert.equal(daemonPaused.status, "PAUSED", "queue daemon should pause")
assert.equal(daemonPaused.nextRunAt, null, "paused queue daemon should clear next run")
const pausedTick = await tickDianxiaomiQueueDaemon()
assert.equal(pausedTick.status, "skipped", "paused queue daemon tick should be skipped")
assert.equal(pausedTick.category, "daemon-paused", "paused queue daemon tick should be classified")
assert.deepEqual(pausedTick.flowOutcomes, [], "paused queue daemon tick should expose no recovered outcomes")
const pausedTickAudit = getDianxiaomiQueueDaemonHealth().audit.recent.find((entry) => entry.tickId === pausedTick.id)
assert(pausedTickAudit, "queue health should audit skipped daemon ticks")
assert.equal(pausedTickAudit?.decision, "skipped", "paused daemon audit should classify the decision")
assert.equal(pausedTickAudit?.subject, "daemon paused", "paused daemon audit should explain the subject")
assert.equal(pausedTickAudit?.countsAsFailure, true, "paused daemon audit should mark skipped paused ticks as non-successful")
assert.equal(getDianxiaomiQueueDaemonHealth().recommendation.kind, "wait-for-products", "paused empty daemon should recommend waiting for products when no runnable work exists")

const autoRetryWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-auto-retry-task-file-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-auto-retry-task-file-work-item",
  pageTitle: "Auto retry task file page",
  title: "Auto retry task file work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  pageProfile: "ready listing profile",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["Color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...taskFileFailure,
    updatedAt: new Date().toISOString()
  }
})
assert.equal(autoRetryWorkItem.status, "blocked", "auto retry fixture should start blocked")
assert.equal(autoRetryWorkItem.repairPlan?.status, "auto-ready", "task-file failure should create an auto-ready repair plan")
assert.equal(autoRetryWorkItem.repairPlan?.canAutoRepair, true, "task-file repair plan should be auto repairable")
assert(autoRetryWorkItem.repairPlan?.actions.some((action) => action.type === "refresh-task-file"), "task-file repair plan should refresh the task file")
assert(autoRetryWorkItem.repairPlan?.actions.some((action) => action.payload?.writer === "refresh-task-file"), "task-file repair plan should expose executable refresh payload")
assert.equal(getDianxiaomiQueueDaemonHealth().workItems.autoRetryCandidates, 1, "queue health should count safe auto-retry candidates")
const previousAutoRetryTickId = getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null
const autoRetryProfilePath = path.join(testDir, "auto-retry-profile")
mkdirSync(autoRetryProfilePath, { recursive: true })
startDianxiaomiQueueDaemon({
  intervalSeconds: 15,
  maxConsecutiveFailures: 1,
  limit: 1,
  profile: autoRetryProfilePath,
  selectorConfig: validSelectorConfigPath
})
const autoRetryTick = await waitForNextQueueTick(previousAutoRetryTickId)
assert.match(autoRetryTick.reason ?? "", /released 1 auto-recovery item/, "queue tick should report released auto-recovery candidates")
assert.equal(getDianxiaomiProductWorkItem(autoRetryWorkItem.id)?.status, "ready-for-automation", "safe auto-retry candidates should return to ready status")
assert.equal(getDianxiaomiProductWorkItem(autoRetryWorkItem.id)?.failureDiagnosis, null, "auto-retry release should clear stale failure diagnosis")
updateDianxiaomiProductWorkItemStatus(autoRetryWorkItem.id, "edited", "auto retry fixture complete")
pauseDianxiaomiQueueDaemon()

const manualTrialAutoRetryWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-manual-trial-auto-retry-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-manual-trial-auto-retry-work-item",
  pageTitle: "Manual trial auto retry page",
  title: "Manual trial auto retry work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...taskFileFailure,
    updatedAt: new Date().toISOString()
  }
})
const manualTrialAutoRetryRun = startDianxiaomiQueueRun({
  limit: 1,
  url: "https://example.com/not-dianxiaomi",
  selectorConfig: validSelectorConfigPath
})
assert.deepEqual(
  manualTrialAutoRetryRun.autoRetryReleasedIds,
  [manualTrialAutoRetryWorkItem.id],
  "manual queue-run should release safe auto-retry candidates before collecting ready items"
)
assert.equal(manualTrialAutoRetryRun.queued, 0, "manual queue-run release test should not start a full-flow job")
assert.equal(manualTrialAutoRetryRun.skipped, 1, "manual queue-run should skip the released item when the forced target URL is invalid")
assert.equal(getDianxiaomiProductWorkItem(manualTrialAutoRetryWorkItem.id)?.status, "blocked", "invalid forced target should re-block the released work item without starting automation")
assert.equal(getDianxiaomiProductWorkItem(manualTrialAutoRetryWorkItem.id)?.failureDiagnosis?.autoRetryRecommended, false, "invalid forced target should replace the stale safe-retry diagnosis")

const manualFullFlowFailureWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-manual-full-flow-failure-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-manual-full-flow-failure-work-item",
  pageTitle: "Manual full flow failure page",
  title: "Manual full flow failure work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "ready-for-automation"
})
const manualFullFlowFailureRun = startDianxiaomiQueueRun({
  limit: 1,
  url: "https://example.com/not-dianxiaomi",
  selectorConfig: validSelectorConfigPath
})
assert.equal(manualFullFlowFailureRun.queued, 0, "manual queue-run safety gate should not start a full-flow job")
assert.equal(manualFullFlowFailureRun.skipped, 1, "manual queue-run safety gate should skip the bad target")
const blockedManualFlowItem = await waitForWorkItemStatus(manualFullFlowFailureWorkItem.id, "blocked")
assert(blockedManualFlowItem.failureDiagnosis, "manual queue-run safety failure should persist a work item diagnosis")
assert.equal(blockedManualFlowItem.failureDiagnosis?.source, "queue-daemon", "manual queue-run diagnosis should keep queue source")
assert.equal(blockedManualFlowItem.failureDiagnosis?.autoRetryRecommended, false, "manual queue-run wrong-surface failures should not auto retry")

const scopedPendingPublishWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-scope-pending-publish-work-item",
  storeId: "unit-scope-store",
  storeName: "Unit Scope Store",
  sourceBucket: "pending-publish",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-scope-pending-publish-work-item",
  pageTitle: "Scoped pending publish page",
  title: "Scoped pending publish work item",
  rawTextSample: "",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "ready-for-automation"
})
const scopedListingDraftWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-scope-listing-draft-work-item",
  storeId: "unit-scope-store",
  storeName: "Unit Scope Store",
  sourceBucket: "listing-draft",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-scope-listing-draft-work-item",
  pageTitle: "Scoped listing draft page",
  title: "Scoped listing draft work item",
  rawTextSample: "Temu半托管产品>待发布>编辑",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "ready-for-automation"
})
const otherStorePendingPublishWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-scope-other-store-work-item",
  storeId: "unit-scope-other-store",
  storeName: "Unit Scope Other Store",
  sourceBucket: "pending-publish",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-scope-other-store-work-item",
  pageTitle: "Other store pending publish page",
  title: "Other store pending publish work item",
  rawTextSample: "",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "ready-for-automation"
})
const scopedPendingPublishRun = startDianxiaomiQueueRun({
  limit: 5,
  storeId: "unit-scope-store",
  storeName: "Unit Scope Store",
  sourceBuckets: ["pending-publish"],
  url: "https://example.com/not-dianxiaomi",
  selectorConfig: validSelectorConfigPath
})
assert.deepEqual(
  scopedPendingPublishRun.sourceBuckets,
  ["pending-publish"],
  "queue-run results should retain requested source bucket scope"
)
assert.equal(scopedPendingPublishRun.storeId, "unit-scope-store", "queue-run results should retain requested store scope")
assert.deepEqual(
  scopedPendingPublishRun.skippedItems.map((item) => item.workItemId),
  [scopedPendingPublishWorkItem.id],
  "queue-run source bucket scope should only target matching work items in the selected store"
)
assert.equal(
  getDianxiaomiProductWorkItem(scopedListingDraftWorkItem.id)?.status,
  "ready-for-automation",
  "non-matching source bucket work items should remain untouched"
)
assert.equal(
  getDianxiaomiProductWorkItem(otherStorePendingPublishWorkItem.id)?.status,
  "ready-for-automation",
  "other-store work items should remain untouched by a scoped queue-run"
)
updateDianxiaomiProductWorkItemStatus(scopedPendingPublishWorkItem.id, "edited", "scoped pending publish fixture complete")
updateDianxiaomiProductWorkItemStatus(scopedListingDraftWorkItem.id, "edited", "scoped listing draft fixture complete")
updateDianxiaomiProductWorkItemStatus(otherStorePendingPublishWorkItem.id, "edited", "other store scoped fixture complete")

const scopedItemUrlTargetWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-scope-item-url-target-work-item",
  storeId: "unit-item-url-store",
  storeName: "Unit Item URL Store",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-scope-item-url-target-work-item",
  pageTitle: "Scoped item-url target page",
  title: "Scoped item-url target work item",
  rawTextSample: "Temu半托管产品>待发布>编辑",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "ready-for-automation"
})
const scopedItemUrlUntouchedWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-scope-item-url-untouched-work-item",
  storeId: "unit-item-url-store",
  storeName: "Unit Item URL Store",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-scope-item-url-untouched-work-item",
  pageTitle: "Scoped item-url untouched page",
  title: "Scoped item-url untouched work item",
  rawTextSample: "Temu半托管产品>待发布>编辑",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "ready-for-automation"
})
const scopedItemUrlRun = startDianxiaomiQueueRun({
  limit: 5,
  storeId: "unit-item-url-store",
  storeName: "Unit Item URL Store",
  itemUrls: [scopedItemUrlTargetWorkItem.pageUrl],
  url: "https://example.com/not-dianxiaomi",
  selectorConfig: validSelectorConfigPath
})
assert.deepEqual(
  scopedItemUrlRun.itemUrls,
  [scopedItemUrlTargetWorkItem.pageUrl],
  "queue-run results should retain requested item-url scope"
)
assert.deepEqual(
  scopedItemUrlRun.skippedItems.map((item) => item.workItemId),
  [scopedItemUrlTargetWorkItem.id],
  "queue-run item-url scope should only target explicitly requested work items"
)
assert.equal(
  getDianxiaomiProductWorkItem(scopedItemUrlUntouchedWorkItem.id)?.status,
  "ready-for-automation",
  "work items outside the requested item-url scope should remain untouched"
)
updateDianxiaomiProductWorkItemStatus(scopedItemUrlTargetWorkItem.id, "edited", "scoped item-url target fixture complete")
updateDianxiaomiProductWorkItemStatus(scopedItemUrlUntouchedWorkItem.id, "edited", "scoped item-url untouched fixture complete")

const retryAfterFixPublishWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-retry-after-fix-publish-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-retry-after-fix-publish-work-item",
  pageTitle: "Retry after fix publish page",
  title: "Retry after fix publish work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...publishFailure,
    updatedAt: new Date().toISOString()
  },
  publishOutcome: {
    ...publishManualBudgetRouteOutcome,
    flowJobId: "flow-retry-after-fix-manual-budget-route"
  }
})
const retryManualBudgetQueuedHealth = getDianxiaomiQueueDaemonHealth()
assert(
  retryManualBudgetQueuedHealth.manualBudget.publishOutcomes.some((item) => item.workItemId === retryAfterFixPublishWorkItem.id),
  "manual-budget publish outcome should be visible before retry-after-fix release"
)
const retryAfterFixPublishResult = requeueDianxiaomiProductWorkItemAfterFix(retryAfterFixPublishWorkItem.id)
assert.equal(retryAfterFixPublishResult?.requeued, true, "retry-after-fix should release fixed publish-validation blockers")
assert.equal(retryAfterFixPublishResult?.workItem.status, "ready-for-automation", "released publish-validation item should return to ready")
assert.equal(retryAfterFixPublishResult?.workItem.failureDiagnosis, null, "released retry-after-fix item should clear stale diagnosis")
assert.equal(retryAfterFixPublishResult?.workItem.manualBudgetReleases?.[0]?.releaseType, "retry-after-fix", "manual-budget release should record retry-after-fix as the release type")
assert.match(retryAfterFixPublishResult?.workItem.manualBudgetReleases?.[0]?.releaseCondition ?? "", /ready-for-automation|auto-ready/, "manual-budget release should keep its release condition")
const retryManualBudgetReleasedHealth = getDianxiaomiQueueDaemonHealth()
assert(
  !retryManualBudgetReleasedHealth.manualBudget.publishOutcomes.some((item) => item.workItemId === retryAfterFixPublishWorkItem.id),
  "released manual-budget work should leave the current manual budget"
)
assert(
  retryManualBudgetReleasedHealth.manualBudget.releases.some((release) =>
    release.workItemId === retryAfterFixPublishWorkItem.id
    && release.releaseType === "retry-after-fix"
  ),
  "queue health should expose manual-budget release history after retry-after-fix"
)
const releasedReplacementCandidate = retryManualBudgetReleasedHealth.manualBudget.replacementQueue.find((candidate) =>
  candidate.sampleWorkItemIds.includes(retryAfterFixPublishWorkItem.id)
)
assert(releasedReplacementCandidate, "replacement queue should include released manual-budget history")
assert(releasedReplacementCandidate.releasedCount >= 1, "replacement queue should count released manual-budget occurrences")
assert.equal(releasedReplacementCandidate.defaultEligible, false, "released history alone should not promote a replacement into the default flow")
assert.match(releasedReplacementCandidate.proofGate.requiredProof, /clicks|decisions|trial/i, "replacement proof gate should require reduced clicks or decisions")
const failedManualBudgetProof = recordManualBudgetProof({
  candidateKey: releasedReplacementCandidate.key,
  source: releasedReplacementCandidate.source,
  reason: releasedReplacementCandidate.reason,
  replacementPlan: releasedReplacementCandidate.replacementPlan,
  baseline: {
    productCount: 2,
    operatorClicks: 10,
    operatorDecisions: 4
  },
  trial: {
    productCount: 2,
    operatorClicks: 10,
    operatorDecisions: 4,
    status: "failed"
  },
  evidence: "unit failed trial with no click or decision reduction",
  recordedBy: "unit-test"
})
assert.equal(failedManualBudgetProof.status, "needs-proof", "failed proof should not promote the replacement")
assert.equal(failedManualBudgetProof.confidence, "weak", "failed proof should be weak confidence")
assert.equal(failedManualBudgetProof.defaultEligible, false, "failed proof should stay out of the default flow")
assert(existsSync(process.env.MANUAL_BUDGET_PROOF_LEDGER_PATH ?? ""), "manual budget proof ledger should persist to disk")
const afterFailedManualBudgetProofHealth = getDianxiaomiQueueDaemonHealth()
const failedProofCandidate = afterFailedManualBudgetProofHealth.manualBudget.replacementQueue.find((candidate) => candidate.key === releasedReplacementCandidate.key)
assert(failedProofCandidate, "replacement candidate should remain visible after a failed proof")
assert.equal(failedProofCandidate.proofGate.status, "needs-proof", "failed/no-improvement proof should keep the proof gate closed")
assert.equal(failedProofCandidate.proofGate.confidence, "weak", "failed/no-improvement proof gate should stay weak confidence")
assert.equal(failedProofCandidate.defaultEligible, false, "failed/no-improvement proof should not make the candidate default eligible")
assert.equal(failedProofCandidate.proofGate.proofRecordId, failedManualBudgetProof.id, "proof gate should reference the latest failed proof")
await sleep(10)
const passedManualBudgetProof = recordManualBudgetProof({
  candidateKey: releasedReplacementCandidate.key,
  source: releasedReplacementCandidate.source,
  reason: releasedReplacementCandidate.reason,
  replacementPlan: releasedReplacementCandidate.replacementPlan,
  baseline: {
    productCount: 2,
    operatorClicks: 10,
    operatorDecisions: 4
  },
  trial: {
    productCount: 2,
    operatorClicks: 6,
    operatorDecisions: 4,
    status: "passed"
  },
  evidence: "unit passed trial reduced browser clicks per product",
  recordedBy: "unit-test"
})
assert.equal(passedManualBudgetProof.status, "ready-for-default", "passed proof with reduced clicks should promote the replacement")
assert.equal(passedManualBudgetProof.confidence, "estimated", "passed proof without measured reports should be estimated confidence")
assert.equal(passedManualBudgetProof.defaultEligible, true, "passed proof with reduced clicks should be default eligible")
assert(passedManualBudgetProof.clickReductionPerProduct > 0, "passed proof should calculate click reduction per product")
const manualBudgetProofRecords = listManualBudgetProofRecords(5)
assert.equal(manualBudgetProofRecords[0]?.id, passedManualBudgetProof.id, "manual budget proof list should return latest proof first")
const persistedManualBudgetProofLedger = JSON.parse(readFileSync(process.env.MANUAL_BUDGET_PROOF_LEDGER_PATH ?? "", "utf8")) as {
  proofs: Array<{ id: string }>
}
assert(
  persistedManualBudgetProofLedger.proofs.some((proof) => proof.id === passedManualBudgetProof.id),
  "manual budget proof ledger should include the latest passed proof"
)
const afterPassedManualBudgetProofHealth = getDianxiaomiQueueDaemonHealth()
const passedProofCandidate = afterPassedManualBudgetProofHealth.manualBudget.replacementQueue.find((candidate) => candidate.key === releasedReplacementCandidate.key)
assert(passedProofCandidate, "replacement candidate should remain visible after a passed proof")
assert.equal(passedProofCandidate.proofGate.status, "ready-for-default", "passed proof with click reduction should open the proof gate")
assert.equal(passedProofCandidate.proofGate.confidence, "estimated", "passed proof gate without measured reports should be estimated confidence")
assert.equal(passedProofCandidate.defaultEligible, false, "estimated proof should not mark the candidate default eligible without measured validation evidence")
assert.equal(passedProofCandidate.proofGate.proofRecordId, passedManualBudgetProof.id, "proof gate should reference the latest passed proof")
assert(
  afterPassedManualBudgetProofHealth.manualBudget.proofs.some((proof) => proof.id === passedManualBudgetProof.id),
  "queue health should expose recent manual budget proofs"
)
const autoProofReleaseAt = new Date().toISOString()
const autoProofWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-auto-proof-capture-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-auto-proof-capture-work-item",
  pageTitle: "Auto proof capture page",
  title: "Auto proof capture work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "ready-for-automation",
  manualBudgetReleases: [{
    workItemId: "unit-auto-proof-capture-work-item",
    title: "Auto proof capture work item",
    source: "publish-outcome",
    reason: "publish outcome manual-budget: required attribute auto proof fixture",
    operatorAction: "Fix the required attribute, check the listing, then retry after fix.",
    releaseCondition: "Return to ready-for-automation only after the item has an auto-ready repair path.",
    releasedAt: autoProofReleaseAt,
    releaseEventAt: autoProofReleaseAt,
    releaseType: "retry-after-fix",
    fromStatus: "blocked",
    toStatus: "ready-for-automation",
    note: "unit automatic proof capture fixture"
  }]
})
const autoProofRepairReportPath = path.join(testDir, "unit-auto-proof-repair-report.json")
const autoProofSubmitReportPath = path.join(testDir, "unit-auto-proof-submit-report.json")
writeFileSync(autoProofRepairReportPath, JSON.stringify({
  id: "unit-auto-proof-repair-report",
  taskId: "unit-auto-proof-task",
  taskTitle: "Auto proof task",
  platform: "dianxiaomi",
  pageUrl: autoProofWorkItem.pageUrl,
  pageTitle: autoProofWorkItem.pageTitle,
  status: "completed",
  createdAt: new Date().toISOString(),
  screenshotPath: "",
  steps: [
    {
      id: "media-processing-plan",
      label: "Media processing",
      status: "done",
      detail: "media tools applied",
      data: {
        tools: [
          {
            clicked: true,
            applied: true,
            applyAttempts: 2
          }
        ]
      }
    },
    {
      id: "fill-sku-pricing",
      label: "Fill SKU pricing",
      status: "done",
      detail: "SKU pricing filled",
      data: {
        filledPrices: 2,
        filledStocks: 1
      }
    }
  ]
}, null, 2), "utf8")
writeFileSync(autoProofSubmitReportPath, JSON.stringify({
  id: "unit-auto-proof-submit-report",
  taskId: "unit-auto-proof-task",
  taskTitle: "Auto proof task",
  platform: "dianxiaomi",
  pageUrl: autoProofWorkItem.pageUrl,
  pageTitle: autoProofWorkItem.pageTitle,
  status: "completed",
  createdAt: new Date().toISOString(),
  screenshotPath: "",
  steps: [
    {
      id: "submit-listing",
      label: "Submit listing",
      status: "done",
      detail: "submit clicked",
      data: {
        attempts: [
          {
            clickedSubmit: true,
            clickedConfirm: true
          },
          {
            clickedSubmit: true,
            clickedConfirm: false
          }
        ]
      }
    }
  ]
}, null, 2), "utf8")
const autoCapturedProof = recordManualBudgetProofFromRecoveryTrial({
  workItemId: autoProofWorkItem.id,
  recoveryRunId: "unit-auto-proof-recovery-run",
  recoveryStatus: "completed",
  repairPreviewJobId: "unit-auto-proof-preview",
  repairApplyJobId: "unit-auto-proof-apply",
  fullFlowJobId: "unit-auto-proof-full-flow",
  automationReportPaths: [
    autoProofRepairReportPath,
    autoProofSubmitReportPath
  ]
})
assert(autoCapturedProof, "completed recovery trial should auto-record proof for a work item with manual-budget release history")
assert.equal(autoCapturedProof.status, "ready-for-default", "completed unattended recovery trial should pass the proof gate")
assert.equal(autoCapturedProof.confidence, "measured", "auto-captured proof with automation reports should be measured confidence")
assert.equal(autoCapturedProof.recordedBy, "recovery-run", "auto-captured proof should identify recovery-run as the recorder")
assert.equal(autoCapturedProof.trial.operatorClicks, 0, "auto-captured unattended trial should record zero operator clicks")
assert.equal(autoCapturedProof.trial.operatorDecisions, 0, "auto-captured unattended trial should record zero operator decisions")
assert(autoCapturedProof.baseline.operatorClicks > autoCapturedProof.trial.operatorClicks, "auto-captured proof should estimate a reduced operator click baseline")
assert.equal(autoCapturedProof.automationMeasurement?.browserClicks, 6, "auto-captured proof should measure browser clicks from automation reports")
assert.equal(autoCapturedProof.automationMeasurement?.browserActions, 8, "auto-captured proof should measure browser actions from automation reports")
assert.equal(autoCapturedProof.automationMeasurement?.reportCount, 2, "auto-captured proof should count measured automation reports")
assert.deepEqual(autoCapturedProof.automationMeasurement?.reportIds, [
  "unit-auto-proof-repair-report",
  "unit-auto-proof-submit-report"
], "auto-captured proof should retain measured report ids")
const duplicateAutoCapturedProof = recordManualBudgetProofFromRecoveryTrial({
  workItemId: autoProofWorkItem.id,
  recoveryRunId: "unit-auto-proof-recovery-run",
  recoveryStatus: "completed",
  repairPreviewJobId: "unit-auto-proof-preview",
  repairApplyJobId: "unit-auto-proof-apply",
  fullFlowJobId: "unit-auto-proof-full-flow",
  automationReportPaths: [
    autoProofRepairReportPath,
    autoProofSubmitReportPath
  ]
})
assert.equal(duplicateAutoCapturedProof?.id, autoCapturedProof.id, "same recovery trial should not duplicate proof records")
const noReleaseProofWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-no-release-proof-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-no-release-proof-work-item",
  pageTitle: "No release proof page",
  title: "No release proof work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "ready-for-automation"
})
const noReleaseAutoProof = recordManualBudgetProofFromRecoveryTrial({
  workItemId: noReleaseProofWorkItem.id,
  recoveryRunId: "unit-no-release-proof-run",
  recoveryStatus: "completed"
})
assert.equal(noReleaseAutoProof, null, "work items without manual-budget release history should not auto-record proof")
const autoProofHealth = getDianxiaomiQueueDaemonHealth()
const autoProofCandidate = autoProofHealth.manualBudget.replacementQueue.find((candidate) => candidate.key === autoCapturedProof.candidateKey)
assert(autoProofCandidate, "auto-captured proof should be visible through the replacement queue")
assert.equal(autoProofCandidate.proofGate.status, "ready-for-default", "auto-captured proof should promote its replacement candidate metadata")
assert.equal(autoProofCandidate.proofGate.confidence, "measured", "auto-captured proof gate should expose measured confidence")
assert.equal(autoProofCandidate.proofGate.proofRecordId, autoCapturedProof.id, "auto-captured proof should be linked from the proof gate")
assert.equal(autoProofCandidate.defaultEligible, false, "measured proof should still stay out of the default flow until a clean validation run passes")
assert(
  autoProofHealth.issues.some((issue) => issue.id === "manual-budget-promotion-gate" && issue.level === "warning"),
  "queue health should warn when measured manual-step replacements are held out of the default flow"
)
const autoProofStartupCheck = getDianxiaomiUnattendedStartupCheck({
  selectorConfig: validSelectorConfigPath,
  profile: path.join(testDir, "manual-budget-promotion-gate-profile")
})
const autoProofStartupGate = autoProofStartupCheck.checks.find((check) => check.id === "manual-budget-promotion-gate")
assert(autoProofStartupGate, "startup checks should include the manual-step promotion validation gate")
assert.equal(autoProofStartupGate?.status, "warning", "startup checks should warn until measured replacements pass validation")
const weakSortReason = "publish outcome manual-budget: unit weak proof sort candidate"
for (let index = 0; index < 4; index += 1) {
  const releasedAt = new Date(Date.now() + index).toISOString()
  saveDianxiaomiProductWorkItem({
    id: `unit-proof-sort-weak-work-item-${index + 1}`,
    pageUrl: `https://www.dianxiaomi.com/product/edit/unit-proof-sort-weak-work-item-${index + 1}`,
    pageTitle: `Proof sort weak page ${index + 1}`,
    title: `Proof sort weak work item ${index + 1}`,
    categoryHint: { label: "Home & Garden" },
    rawTextSample: "complete real listing with SKU and image signals",
    notes: [],
    snapshot: {
      hasTitle: true,
      imageCount: 2,
      skuCount: 1,
      priceFieldCount: 1,
      stockFieldCount: 1,
      attributeKeys: ["color"],
      mediaToolSignals: ["image translation"]
    },
    status: "edited",
    manualBudgetReleases: [{
      workItemId: `unit-proof-sort-weak-work-item-${index + 1}`,
      title: `Proof sort weak work item ${index + 1}`,
      source: "publish-outcome",
      reason: weakSortReason,
      operatorAction: "Fix the recurring validation issue before retrying.",
      releaseCondition: "Return to ready-for-automation only after a proven automatic replacement exists.",
      releasedAt,
      releaseEventAt: releasedAt,
      releaseType: "retry-after-fix",
      fromStatus: "blocked",
      toStatus: "edited",
      note: "unit replacement queue proof sorting fixture"
    }]
  })
}
const sortedProofHealth = getDianxiaomiQueueDaemonHealth()
const measuredProofSortIndex = sortedProofHealth.manualBudget.replacementQueue.findIndex((candidate) => candidate.key === autoCapturedProof.candidateKey)
const estimatedProofSortIndex = sortedProofHealth.manualBudget.replacementQueue.findIndex((candidate) => candidate.key === passedManualBudgetProof.candidateKey)
const weakProofSortIndex = sortedProofHealth.manualBudget.replacementQueue.findIndex((candidate) =>
  candidate.sampleWorkItemIds.includes("unit-proof-sort-weak-work-item-1")
)
assert(measuredProofSortIndex >= 0, "measured proof candidate should be present in the sorted replacement queue")
assert(estimatedProofSortIndex >= 0, "estimated proof candidate should be present in the sorted replacement queue")
assert(weakProofSortIndex >= 0, "weak proof candidate should be present in the sorted replacement queue")
assert(
  measuredProofSortIndex < estimatedProofSortIndex,
  "replacement queue should rank measured ready candidates ahead of estimated ready candidates"
)
assert(
  estimatedProofSortIndex < weakProofSortIndex,
  "replacement queue should rank ready proof candidates ahead of weak/needs-proof candidates even when weak candidates have more occurrences"
)
assert.equal(sortedProofHealth.manualBudget.replacementQueue[measuredProofSortIndex]?.proofGate.confidence, "measured")
assert.equal(sortedProofHealth.manualBudget.replacementQueue[estimatedProofSortIndex]?.proofGate.confidence, "estimated")
assert.equal(sortedProofHealth.manualBudget.replacementQueue[weakProofSortIndex]?.proofGate.confidence, "weak")
const measuredTrialProposal = sortedProofHealth.manualBudget.trialProposals.find((proposal) =>
  proposal.candidateKey === autoCapturedProof.candidateKey
)
assert(measuredTrialProposal, "measured ready replacement candidates should create bounded trial proposals")
assert.equal(measuredTrialProposal.proofConfidence, "measured", "bounded trial proposals should only use measured proof")
assert.equal(measuredTrialProposal.proofRecordId, autoCapturedProof.id, "bounded trial proposal should reference the measured proof")
assert.equal(measuredTrialProposal.trialSize, 1, "bounded trial proposal should cap to the available sample work items")
assert(measuredTrialProposal.acceptanceCriteria.some((criteria) => /operator|click|decision/i.test(criteria)), "bounded trial proposal should include manual-reduction acceptance criteria")
assert(measuredTrialProposal.rollbackCriteria.some((criteria) => /operator|submit|media|selector/i.test(criteria)), "bounded trial proposal should include rollback criteria")
assert.equal(measuredTrialProposal.readinessStatus, "blocked", "bounded trial proposals should stay blocked until execution readiness is explicit")
assert.equal(measuredTrialProposal.executionReady, false, "bounded trial proposals should not be executable by default")
assert.equal(measuredTrialProposal.rollbackAcknowledgementRequired, true, "bounded trial proposals should require rollback acknowledgement before execution")
assert(
  measuredTrialProposal.readinessChecks.some((check) => check.id === "sample-availability"),
  "bounded trial proposals should expose sample availability readiness"
)
assert(
  measuredTrialProposal.readinessChecks.some((check) => check.id === "rollback-acknowledgement" && check.status === "block"),
  "bounded trial proposals should block on rollback acknowledgement until an execution gate exists"
)
const nextValidationBlockedByReadiness = startNextManualBudgetValidationRun({
  selectorConfig: validSelectorConfigPath,
  profile: path.join(testDir, "next-validation-profile")
})
assert.equal(nextValidationBlockedByReadiness.candidateKey, measuredTrialProposal.candidateKey, "next validation launcher should select the current held measured candidate")
assert.equal(nextValidationBlockedByReadiness.status, "blocked", "next validation launcher should keep readiness blockers instead of bypassing the gate")
assert.equal(nextValidationBlockedByReadiness.rollbackAcknowledged, true, "next validation launcher should acknowledge proposal rollback criteria automatically")
assert.deepEqual(
  nextValidationBlockedByReadiness.acceptedRollbackCriteria,
  measuredTrialProposal.rollbackCriteria,
  "next validation launcher should accept the selected proposal rollback criteria"
)
assert.equal(nextValidationBlockedByReadiness.flowJobIds.length, 0, "blocked next validation launcher should not start full-flow jobs")
assert.equal(nextValidationBlockedByReadiness.outcome.status, "blocked", "blocked next validation launcher should persist a blocked outcome")
assert.equal(nextValidationBlockedByReadiness.proposal?.candidateKey, measuredTrialProposal.candidateKey, "next validation launcher should persist the selected proposal")
assert(
  nextValidationBlockedByReadiness.readinessChecks.some((check) => check.id === "rollback-acknowledgement" && check.status === "pass"),
  "next validation launcher should satisfy rollback acknowledgement without operator input"
)
assert(
  nextValidationBlockedByReadiness.readinessChecks.some((check) => check.status === "block"),
  "next validation launcher should still expose non-rollback readiness blockers"
)
const unacknowledgedTrialRequest = startManualBudgetTrial({
  candidateKey: measuredTrialProposal.candidateKey,
  rollbackAcknowledged: false,
  acceptedRollbackCriteria: measuredTrialProposal.rollbackCriteria
})
assert.equal(unacknowledgedTrialRequest.status, "blocked", "unacknowledged bounded trial requests should be blocked")
assert.equal(unacknowledgedTrialRequest.updatedAt, unacknowledgedTrialRequest.requestedAt, "blocked bounded trial requests should record an update timestamp")
assert.equal(unacknowledgedTrialRequest.acceptedRollbackCriteria.length, measuredTrialProposal.rollbackCriteria.length, "bounded trial requests should persist accepted rollback criteria")
assert.equal(unacknowledgedTrialRequest.outcome.status, "blocked", "unacknowledged bounded trial requests should persist a blocked outcome")
assert.equal(unacknowledgedTrialRequest.outcome.flowOutcomes.length, 0, "blocked bounded trial requests should not persist flow outcomes")
assert.equal(unacknowledgedTrialRequest.flowJobIds.length, 0, "blocked bounded trial requests should not start full-flow jobs")
assert(
  unacknowledgedTrialRequest.readinessChecks.some((check) =>
    check.id === "rollback-acknowledgement" && check.status === "block"
  ),
  "unacknowledged bounded trial requests should keep the rollback acknowledgement blocker"
)
const acknowledgedTrialRequest = startManualBudgetTrial({
  candidateKey: measuredTrialProposal.candidateKey,
  rollbackAcknowledged: true,
  acceptedRollbackCriteria: measuredTrialProposal.rollbackCriteria
})
assert.equal(acknowledgedTrialRequest.status, "blocked", "readiness blockers should still prevent bounded trial execution")
assert.equal(acknowledgedTrialRequest.updatedAt, acknowledgedTrialRequest.requestedAt, "blocked acknowledged bounded trial requests should record an update timestamp")
assert.equal(acknowledgedTrialRequest.acceptedRollbackCriteria.length, measuredTrialProposal.rollbackCriteria.length, "acknowledged bounded trial requests should persist accepted rollback criteria")
assert.equal(acknowledgedTrialRequest.outcome.status, "blocked", "acknowledged bounded trial requests should persist a blocked outcome while readiness blocks remain")
assert.equal(acknowledgedTrialRequest.outcome.flowOutcomes.length, 0, "blocked acknowledged bounded trial requests should not persist flow outcomes")
assert.equal(acknowledgedTrialRequest.flowJobIds.length, 0, "blocked acknowledged bounded trial requests should not start full-flow jobs")
assert(
  acknowledgedTrialRequest.readinessChecks.some((check) =>
    check.id === "rollback-acknowledgement" && check.status === "pass"
  ),
  "acknowledged bounded trial requests should pass the rollback acknowledgement check"
)
assert(
  acknowledgedTrialRequest.readinessChecks.some((check) => check.status === "block"),
  "other readiness blockers should still prevent trial execution in the isolated test environment"
)
const recentTrialHistory = listManualBudgetTrials(5)
assert(
  recentTrialHistory.some((trial) => trial.id === acknowledgedTrialRequest.id),
  "bounded trial requests should be readable from the runtime history"
)
assert(existsSync(process.env.MANUAL_BUDGET_TRIAL_HISTORY_PATH ?? ""), "bounded trial requests should be persisted to disk")
const persistedTrialHistory = JSON.parse(readFileSync(process.env.MANUAL_BUDGET_TRIAL_HISTORY_PATH ?? "", "utf8")) as {
  trials?: unknown[]
}
assert(
  persistedTrialHistory.trials?.some((trial) => {
    const record = trial as { id?: string; outcome?: { status?: string } }
    return record.id === acknowledgedTrialRequest.id && record.outcome?.status === "blocked"
  }),
  "bounded trial history should persist blocked request outcomes"
)
assert(
  !sortedProofHealth.manualBudget.trialProposals.some((proposal) => proposal.candidateKey === passedManualBudgetProof.candidateKey),
  "estimated proof candidates should not create bounded trial proposals"
)
assert(
  sortedProofHealth.manualBudget.trialProposals.every((proposal) => proposal.proofConfidence === "measured"),
  "bounded trial proposals should stay limited to measured proof candidates"
)

const staleRunningTrialRecord = {
  id: "unit-stale-running-manual-budget-trial",
  requestedAt: new Date(Date.now() + 90_000).toISOString(),
  updatedAt: new Date(Date.now() + 90_000).toISOString(),
  candidateKey: measuredTrialProposal.candidateKey,
  status: "started",
  message: "unit stale running bounded trial",
  rollbackAcknowledged: true,
  acceptedRollbackCriteria: measuredTrialProposal.rollbackCriteria,
  proposal: measuredTrialProposal,
  readinessStatus: "ready",
  readinessChecks: measuredTrialProposal.readinessChecks.map((check) => ({
    ...check,
    status: check.id === "rollback-acknowledgement" ? "pass" : check.status
  })),
  trialSize: 1,
  flowJobIds: ["unit-missing-manual-budget-flow"],
  skippedItems: [],
  outcome: {
    status: "running",
    resolvedAt: null,
    message: "waiting for missing unit flow",
    completed: 0,
    failed: 0,
    running: 1,
    missing: 0,
    proofRecordId: null,
    flowOutcomes: [{
      flowJobId: "unit-missing-manual-budget-flow",
      workItemId: autoProofWorkItem.id,
      status: "running",
      finishedAt: null,
      reportPaths: [],
      failureReason: null
    }]
  }
}
writeFileSync(process.env.MANUAL_BUDGET_TRIAL_HISTORY_PATH ?? "", JSON.stringify({
  trials: [
    staleRunningTrialRecord,
    ...(persistedTrialHistory.trials ?? [])
  ]
}, null, 2), "utf8")
restoreDianxiaomiQueueDaemon()
pauseDianxiaomiQueueDaemon()
const staleRunningTrial = listManualBudgetTrials(10).find((trial) => trial.id === staleRunningTrialRecord.id)
assert(staleRunningTrial, "stale running bounded trial should reload from persisted history")
assert.equal(staleRunningTrial?.outcome.status, "failed", "stale running bounded trial should become failed after restart when its flow is missing")
assert.equal(staleRunningTrial?.outcome.missing, 1, "stale running bounded trial should count the missing flow")
assert.equal(staleRunningTrial?.outcome.flowOutcomes[0]?.status, "missing", "stale running bounded trial should expose a missing flow outcome")
const staleNormalizedHistory = JSON.parse(readFileSync(process.env.MANUAL_BUDGET_TRIAL_HISTORY_PATH ?? "", "utf8")) as {
  trials?: Array<{ id?: string; outcome?: { status?: string; missing?: number } }>
}
assert(
  staleNormalizedHistory.trials?.some((trial) =>
    trial.id === staleRunningTrialRecord.id
    && trial.outcome?.status === "failed"
    && trial.outcome.missing === 1
  ),
  "stale running bounded trial normalization should persist the failed/missing outcome"
)
const staleValidationHealth = getDianxiaomiQueueDaemonHealth()
const staleValidationClosure = staleValidationHealth.manualBudget.validationClosure
assert.equal(staleValidationClosure.status, "failed", "validation closure should summarize the latest failed validation result")
assert.equal(staleValidationClosure.latestTrialId, staleRunningTrialRecord.id, "validation closure should point to the latest failed trial")
assert.equal(staleValidationClosure.latestCandidateKey, measuredTrialProposal.candidateKey, "validation closure should keep the failed candidate key")
assert.equal(staleValidationClosure.latestStatus, "failed", "validation closure should expose the latest failed outcome status")
assert(staleValidationClosure.failed >= 1, "validation closure should count failed validation runs")
assert.match(staleValidationClosure.message, /failed|missing/i, "validation closure should explain the failed validation result")
assert.equal(staleValidationClosure.failureTriage.status, "blocked", "missing validation flows should block promotion instead of entering recovery")
assert.equal(staleValidationClosure.failureTriage.category, "missing-flow", "missing validation flows should be classified explicitly")
assert.equal(staleValidationClosure.failureTriage.route, "blocked", "missing validation flows should route to rerun validation")
assert.equal(staleValidationClosure.failureTriage.countsAsManualBudget, false, "missing validation flows should not consume manual-step budget")
assert.equal(staleValidationClosure.rerunPolicy.status, "blocked", "missing validation flows should not be eligible for unattended validation rerun")
assert(
  staleValidationHealth.alerts.some((alert) => alert.id === "manual-budget-validation-triage"),
  "queue health should surface one compact validation triage alert"
)

const profileFailureValidationAt = new Date(Date.now() + 105_000).toISOString()
const profileFailureValidationTrialRecord = {
  ...staleRunningTrialRecord,
  id: "unit-profile-failed-manual-budget-trial",
  requestedAt: profileFailureValidationAt,
  updatedAt: profileFailureValidationAt,
  flowJobIds: ["unit-profile-failed-manual-budget-flow"],
  outcome: {
    status: "failed",
    resolvedAt: profileFailureValidationAt,
    message: "bounded trial failed: browser profile has possible lock file",
    completed: 0,
    failed: 1,
    running: 0,
    missing: 0,
    proofRecordId: null,
    flowOutcomes: [{
      flowJobId: "unit-profile-failed-manual-budget-flow",
      workItemId: autoProofWorkItem.id,
      status: "failed",
      finishedAt: profileFailureValidationAt,
      reportPaths: [],
      failureReason: "browser profile has possible lock file"
    }]
  }
}
const currentTrialHistoryForProfileTriage = JSON.parse(readFileSync(process.env.MANUAL_BUDGET_TRIAL_HISTORY_PATH ?? "", "utf8")) as {
  trials?: unknown[]
}
writeFileSync(process.env.MANUAL_BUDGET_TRIAL_HISTORY_PATH ?? "", JSON.stringify({
  trials: [
    profileFailureValidationTrialRecord,
    ...(currentTrialHistoryForProfileTriage.trials ?? [])
  ]
}, null, 2), "utf8")
restoreDianxiaomiQueueDaemon()
pauseDianxiaomiQueueDaemon()
const profileFailureValidationClosure = getDianxiaomiQueueDaemonHealth().manualBudget.validationClosure
assert.equal(profileFailureValidationClosure.latestTrialId, profileFailureValidationTrialRecord.id, "latest validation closure should follow the newest failed validation")
assert.equal(profileFailureValidationClosure.failureTriage.status, "recoverable", "browser profile validation failures should be recoverable after profile repair")
assert.equal(profileFailureValidationClosure.failureTriage.category, "browser-profile", "browser profile validation failures should keep their failure category")
assert.equal(profileFailureValidationClosure.failureTriage.route, "profile-fix", "browser profile validation failures should route to profile fix")
assert.equal(profileFailureValidationClosure.failureTriage.recoverable, true, "profile-fix validation failures should be marked recoverable")
assert.equal(profileFailureValidationClosure.failureTriage.countsAsManualBudget, false, "profile-fix validation failures should not consume manual-step budget")
const profileRerunProfilePath = path.join(testDir, "manual-budget-validation-rerun-profile")
mkdirSync(profileRerunProfilePath, { recursive: true })
writeRealSelectorDiagnosis(
  "dianxiaomi-diagnosis-unit-validation-rerun.json",
  autoProofWorkItem.pageUrl,
  "Unit validation rerun calibration",
  2_000
)
const profileRerunStartup = getDianxiaomiUnattendedStartupCheck({
  intervalSeconds: 15,
  maxConsecutiveFailures: 1,
  limit: 1,
  profile: profileRerunProfilePath,
  selectorConfig: validSelectorConfigPath,
  url: "https://example.com/not-dianxiaomi"
})
assert.equal(profileRerunStartup.health.manualBudget.validationClosure.rerunPolicy.status, "ready", "profile-fix validation failures should be ready for one guarded rerun after profile repair")
assert.equal(profileRerunStartup.health.manualBudget.validationClosure.rerunPolicy.route, "profile-fix", "validation rerun policy should keep the recoverable route")
const previousValidationRerunTickId = getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null
startDianxiaomiQueueDaemon({
  intervalSeconds: 15,
  maxConsecutiveFailures: 1,
  limit: 1,
  profile: profileRerunProfilePath,
  selectorConfig: validSelectorConfigPath,
  url: "https://example.com/not-dianxiaomi"
})
const validationRerunTick = await waitForNextQueueTick(previousValidationRerunTickId)
assert.equal(validationRerunTick.category, "validation-rerun-started", "queue daemon should start a bounded validation rerun before recovery or normal queue work")
assert.equal(validationRerunTick.queueRun, null, "validation rerun tick should not also start a normal queue run")
assert.equal(validationRerunTick.recoveryRun, null, "validation rerun tick should not also start a recovery run")
assert(validationRerunTick.manualBudgetValidationRun, "validation rerun tick should include the bounded validation request")
assert.equal(validationRerunTick.manualBudgetValidationRun?.validationRerun?.sourceTrialId, profileFailureValidationTrialRecord.id, "validation rerun should point back to the failed source validation")
assert.equal(validationRerunTick.manualBudgetValidationRun?.validationRerun?.route, "profile-fix", "validation rerun should persist its recoverable route")
assert.equal(validationRerunTick.manualBudgetValidationRun?.validationRerun?.requestedBy, "queue-daemon", "validation rerun should identify the daemon as requester")
const afterProfileRerunClosure = getDianxiaomiQueueDaemonHealth().manualBudget.validationClosure
assert.equal(afterProfileRerunClosure.rerunPolicy.sourceTrialId, profileFailureValidationTrialRecord.id, "rerun policy should keep the original failed source id after the retry")
assert.equal(afterProfileRerunClosure.rerunPolicy.retryTrialId, validationRerunTick.manualBudgetValidationRun?.id, "rerun policy should link the spent retry request")
assert.equal(afterProfileRerunClosure.rerunPolicy.attemptsUsed, 1, "validation rerun should spend the single automatic retry budget")
assert.equal(afterProfileRerunClosure.rerunPolicy.status, "spent", "validation rerun should not be offered a second time for the same source trial")
assert(
  getDianxiaomiQueueDaemonHealth().audit.recent.some((entry) =>
    entry.tickId === validationRerunTick.id
    && entry.decision === "validation-rerun-started"
    && entry.workItemIds.includes(autoProofWorkItem.id)
  ),
  "queue health audit should record validation rerun daemon decisions"
)
pauseDianxiaomiQueueDaemon()

const manualBudgetFailureValidationAt = new Date(Date.now() + 110_000).toISOString()
const manualBudgetFailureValidationTrialRecord = {
  ...staleRunningTrialRecord,
  id: "unit-hard-failed-manual-budget-trial",
  requestedAt: manualBudgetFailureValidationAt,
  updatedAt: manualBudgetFailureValidationAt,
  flowJobIds: ["unit-hard-failed-manual-budget-flow"],
  outcome: {
    status: "failed",
    resolvedAt: manualBudgetFailureValidationAt,
    message: "bounded trial failed: ambiguous business rule needs operator judgment",
    completed: 0,
    failed: 1,
    running: 0,
    missing: 0,
    proofRecordId: null,
    flowOutcomes: [{
      flowJobId: "unit-hard-failed-manual-budget-flow",
      workItemId: autoProofWorkItem.id,
      status: "failed",
      finishedAt: manualBudgetFailureValidationAt,
      reportPaths: [],
      failureReason: "ambiguous business rule needs operator judgment"
    }]
  }
}
const currentTrialHistoryForManualBudgetTriage = JSON.parse(readFileSync(process.env.MANUAL_BUDGET_TRIAL_HISTORY_PATH ?? "", "utf8")) as {
  trials?: unknown[]
}
writeFileSync(process.env.MANUAL_BUDGET_TRIAL_HISTORY_PATH ?? "", JSON.stringify({
  trials: [
    manualBudgetFailureValidationTrialRecord,
    ...(currentTrialHistoryForManualBudgetTriage.trials ?? [])
  ]
}, null, 2), "utf8")
restoreDianxiaomiQueueDaemon()
pauseDianxiaomiQueueDaemon()
const manualBudgetFailureValidationHealth = getDianxiaomiQueueDaemonHealth()
const manualBudgetFailureValidationClosure = manualBudgetFailureValidationHealth.manualBudget.validationClosure
assert.equal(manualBudgetFailureValidationClosure.latestTrialId, manualBudgetFailureValidationTrialRecord.id, "latest validation closure should follow the newest hard failure")
assert.equal(manualBudgetFailureValidationClosure.failureTriage.status, "manual-budget", "hard validation failures should stay in manual-step budget")
assert.equal(manualBudgetFailureValidationClosure.failureTriage.route, "manual-budget", "hard validation failures should route to manual-step budget")
assert.equal(manualBudgetFailureValidationClosure.failureTriage.countsAsManualBudget, true, "hard validation failures should count against manual-step budget")
assert.equal(manualBudgetFailureValidationClosure.failureTriage.workItemIds[0], autoProofWorkItem.id, "validation triage should keep affected work item ids")
assert.equal(manualBudgetFailureValidationClosure.rerunPolicy.status, "ineligible", "manual-budget validation failures should never auto-start a validation rerun")
assert.equal(manualBudgetFailureValidationClosure.rerunPolicy.attemptsUsed, 0, "manual-budget validation failures should not consume validation rerun budget")
assert(
  manualBudgetFailureValidationHealth.alerts.some((alert) =>
    alert.id === "manual-budget-validation-triage" && /manual-budget/i.test(alert.message)
  ),
  "queue health should summarize hard validation failure routing in one alert"
)

const cleanValidationProof = recordManualBudgetProof({
  candidateKey: autoCapturedProof.candidateKey,
  source: autoCapturedProof.source,
  reason: autoCapturedProof.reason,
  replacementPlan: autoCapturedProof.replacementPlan,
  baseline: autoCapturedProof.baseline,
  trial: {
    productCount: 1,
    operatorClicks: 0,
    operatorDecisions: 0,
    status: "passed"
  },
  evidence: "unit clean bounded validation run with measured automation reports",
  automationMeasurement: autoCapturedProof.automationMeasurement,
  recordedBy: "manual-budget-trial"
})
const cleanValidationAt = new Date(Date.now() + 120_000).toISOString()
const cleanValidationTrialRecord = {
  id: "unit-clean-passed-manual-budget-trial",
  requestedAt: cleanValidationAt,
  updatedAt: cleanValidationAt,
  candidateKey: autoCapturedProof.candidateKey,
  status: "started",
  message: "unit clean validation passed",
  rollbackAcknowledged: true,
  acceptedRollbackCriteria: measuredTrialProposal.rollbackCriteria,
  proposal: measuredTrialProposal,
  readinessStatus: "ready",
  readinessChecks: measuredTrialProposal.readinessChecks.map((check) => ({
    ...check,
    status: "pass"
  })),
  trialSize: 1,
  flowJobIds: ["unit-clean-passed-manual-budget-flow"],
  skippedItems: [],
  outcome: {
    status: "passed",
    resolvedAt: cleanValidationAt,
    message: "unit clean validation passed",
    completed: 1,
    failed: 0,
    running: 0,
    missing: 0,
    proofRecordId: cleanValidationProof.id,
    automationMeasurement: cleanValidationProof.automationMeasurement,
    flowOutcomes: [{
      flowJobId: "unit-clean-passed-manual-budget-flow",
      workItemId: autoProofWorkItem.id,
      status: "completed",
      finishedAt: cleanValidationAt,
      reportPaths: cleanValidationProof.automationMeasurement?.reportPaths ?? [],
      failureReason: null
    }]
  }
}
const currentTrialHistoryForCleanValidation = JSON.parse(readFileSync(process.env.MANUAL_BUDGET_TRIAL_HISTORY_PATH ?? "", "utf8")) as {
  trials?: unknown[]
}
writeFileSync(process.env.MANUAL_BUDGET_TRIAL_HISTORY_PATH ?? "", JSON.stringify({
  trials: [
    cleanValidationTrialRecord,
    ...(currentTrialHistoryForCleanValidation.trials ?? [])
  ]
}, null, 2), "utf8")
restoreDianxiaomiQueueDaemon()
pauseDianxiaomiQueueDaemon()
const cleanValidationHealth = getDianxiaomiQueueDaemonHealth()
const cleanValidationCandidate = cleanValidationHealth.manualBudget.replacementQueue.find((candidate) => candidate.key === autoCapturedProof.candidateKey)
assert(cleanValidationCandidate, "clean passed validation should keep the measured candidate visible")
assert.equal(cleanValidationCandidate?.proofGate.proofRecordId, cleanValidationProof.id, "clean passed validation proof should become the active proof gate")
assert.equal(cleanValidationCandidate?.defaultEligible, true, "clean passed validation with measured reports should allow default-flow promotion")
assert.equal(cleanValidationHealth.manualBudget.validationClosure.status, "passed", "validation closure should summarize the latest clean validation pass")
assert.equal(cleanValidationHealth.manualBudget.validationClosure.latestTrialId, cleanValidationTrialRecord.id, "validation closure should point to the latest passed validation")
assert.equal(cleanValidationHealth.manualBudget.validationClosure.latestProofRecordId, cleanValidationProof.id, "validation closure should expose the passed validation proof")
assert.equal(cleanValidationHealth.manualBudget.validationClosure.latestMeasurement?.reportCount, cleanValidationProof.automationMeasurement?.reportCount, "validation closure should keep the latest measured report count")
assert(cleanValidationHealth.manualBudget.validationClosure.passed >= 1, "validation closure should count passed validation runs")
assert(
  !cleanValidationHealth.manualBudget.trialProposals.some((proposal) => proposal.candidateKey === autoCapturedProof.candidateKey),
  "clean passed validation should stop proposing another validation run for the same candidate"
)
assert(
  !cleanValidationHealth.issues.some((issue) => issue.id === "manual-budget-promotion-gate"),
  "clean passed validation should clear the manual-step promotion health warning"
)
const cleanValidationStartupGate = getDianxiaomiUnattendedStartupCheck({
  selectorConfig: validSelectorConfigPath,
  profile: path.join(testDir, "manual-budget-clean-validation-profile")
}).checks.find((check) => check.id === "manual-budget-promotion-gate")
assert.equal(cleanValidationStartupGate?.status, "pass", "startup gate should pass once clean measured validation exists")
const noHeldValidationRun = startNextManualBudgetValidationRun({
  selectorConfig: validSelectorConfigPath,
  profile: path.join(testDir, "manual-budget-clean-validation-profile")
})
assert.equal(noHeldValidationRun.status, "blocked", "next validation launcher should not start when no held measured candidate remains")
assert.equal(noHeldValidationRun.candidateKey, "next-held-manual-budget-validation", "next validation launcher should return a stable no-candidate marker")
assert.equal(noHeldValidationRun.flowJobIds.length, 0, "no-candidate validation launcher should not start full-flow jobs")
assert.equal(noHeldValidationRun.outcome.status, "blocked", "no-candidate validation launcher should persist a blocked outcome")
assert(
  noHeldValidationRun.readinessChecks.some((check) => check.id === "manual-budget-promotion-gate"),
  "no-candidate validation launcher should explain that the promotion gate is clear"
)

const retryAfterFixMediaWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-retry-after-fix-media-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-retry-after-fix-media-work-item",
  pageTitle: "Retry after fix media page",
  title: "Retry after fix media work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...transientMediaFailure,
    updatedAt: new Date().toISOString()
  }
})
const retryAfterFixMediaResult = requeueDianxiaomiProductWorkItemAfterFix(retryAfterFixMediaWorkItem.id)
assert.equal(retryAfterFixMediaResult?.requeued, true, "retry-after-fix should release retryable media blockers after operator fix")
assert.equal(retryAfterFixMediaResult?.workItem.status, "ready-for-automation", "released media item should return to ready")

const transientMediaRepairWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-transient-media-repair-plan-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-transient-media-repair-plan-work-item",
  pageTitle: "Transient media repair page",
  title: "Transient media repair plan work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  pageProfile: "ready listing profile",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["Color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...transientMediaFailure,
    updatedAt: new Date().toISOString()
  }
})
assert.equal(transientMediaRepairWorkItem.repairPlan?.status, "auto-ready", "transient media failure should create an auto-ready repair plan")
assert.equal(transientMediaRepairWorkItem.repairPlan?.canAutoRepair, true, "transient media repair should be auto repairable")
assert.equal(transientMediaRepairWorkItem.repairActionGate?.defaultActionAllowed, true, "auto-ready repair plans should keep default unattended actions enabled")
assert.equal(transientMediaRepairWorkItem.repairActionGate?.status, "auto-ready", "auto-ready repair plans should expose an auto-ready action gate")
assert(transientMediaRepairWorkItem.repairPlan?.actions.some((action) => action.type === "retry-transient"), "transient media repair plan should retry the media tool")
assert(transientMediaRepairWorkItem.repairPlan?.actions.some((action) => action.payload?.writer === "run-media-tool" && action.payload.mediaTool === "batchResize"), "transient media repair should expose media tool payload")
const transientMediaRepairPreviewExport = exportDianxiaomiRepairPreview(transientMediaRepairWorkItem.id)
assert(transientMediaRepairPreviewExport, "repair preview export should be created for work items with a repair plan")
assert(existsSync(transientMediaRepairPreviewExport!.absoluteTaskFile), "repair preview should export a task file")
assert(existsSync(transientMediaRepairPreviewExport!.absoluteRepairPlanFile), "repair preview should export a repair plan file")
const exportedRepairPreview = JSON.parse(readFileSync(transientMediaRepairPreviewExport!.absoluteRepairPlanFile, "utf8")) as { workItemId: string; repairPlan: { actions: Array<{ payload?: { writer?: string; mediaTool?: string } }> } }
assert.equal(exportedRepairPreview.workItemId, transientMediaRepairWorkItem.id, "repair preview file should identify the work item")
assert(
  exportedRepairPreview.repairPlan.actions.some((action) => action.payload?.writer === "run-media-tool" && action.payload.mediaTool === "batchResize"),
  "repair preview file should preserve executable repair payload metadata"
)
assert.equal(getDianxiaomiProductWorkItem(transientMediaRepairWorkItem.id)?.status, "blocked", "repair preview export must not release or edit the work item")
assert.equal(getDianxiaomiProductWorkItem(transientMediaRepairWorkItem.id)?.repairPlan?.status, "auto-ready", "repair preview export must keep the repair plan")
const taskFileRecoverySkipWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-recovery-skip-task-file-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-recovery-skip-task-file-work-item",
  pageTitle: "Recovery skip task file page",
  title: "Recovery skip task file work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...taskFileFailure,
    updatedAt: new Date().toISOString()
  }
})
const blockedRecoveryRun = startDianxiaomiRecoveryRun({
  limit: 3,
  workItemIds: [
    transientMediaRepairWorkItem.id,
    taskFileRecoverySkipWorkItem.id,
    "missing-recovery-work-item"
  ],
  url: "https://example.com/not-dianxiaomi",
  selectorConfig: validSelectorConfigPath
})
assert.equal(blockedRecoveryRun.queued, 1, "recovery run should queue only browser-executable auto-ready repair plans")
assert.equal(blockedRecoveryRun.skipped, 2, "recovery run should skip non-browser repair plans and missing ids before running")
assert.equal(blockedRecoveryRun.items.find((item) => item.workItemId === taskFileRecoverySkipWorkItem.id)?.status, "skipped", "task-file refresh repair should stay outside browser recovery loop")
assert(existsSync(process.env.RECOVERY_RUN_HISTORY_PATH), "recovery run should persist history on start")
const finishedBlockedRecoveryRun = await waitForRecoveryRun(blockedRecoveryRun.id)
assert.equal(finishedBlockedRecoveryRun.status, "failed", "bad recovery target should fail the queued browser recovery item")
assert.equal(finishedBlockedRecoveryRun.failed, 1, "bad recovery target should count the browser recovery item as failed")
assert.equal(finishedBlockedRecoveryRun.items.find((item) => item.workItemId === transientMediaRepairWorkItem.id)?.status, "failed", "browser recovery item should fail before preview on invalid target")
const persistedRecoveryHistory = JSON.parse(readFileSync(process.env.RECOVERY_RUN_HISTORY_PATH, "utf8")) as { runs?: Array<{ id: string; status: string; failed: number }> } | Array<{ id: string; status: string; failed: number }>
const persistedRecoveryRuns = Array.isArray(persistedRecoveryHistory) ? persistedRecoveryHistory : persistedRecoveryHistory.runs ?? []
assert(persistedRecoveryRuns.some((run) => run.id === blockedRecoveryRun.id && run.status === "failed" && run.failed === 1), "recovery history should persist the final failed outcome")
const restoredRecoveryState = restoreDianxiaomiQueueDaemon()
assert(restoredRecoveryState, "restore should keep daemon state available while reloading recovery history")
assert(listDianxiaomiRecoveryRuns(10).some((run) => run.id === blockedRecoveryRun.id), "restore should reload persisted recovery-run history")
const repeatedBlockedRecoveryRun = startDianxiaomiRecoveryRun({
  limit: 1,
  workItemIds: [transientMediaRepairWorkItem.id],
  url: "https://example.com/not-dianxiaomi",
  selectorConfig: validSelectorConfigPath
})
const finishedRepeatedBlockedRecoveryRun = await waitForRecoveryRun(repeatedBlockedRecoveryRun.id)
assert.equal(finishedRepeatedBlockedRecoveryRun.status, "failed", "second bad recovery target should fail the same product")
const repeatedRecoveryHealth = getDianxiaomiQueueDaemonHealth()
assert(
  repeatedRecoveryHealth.recovery.repeatedFailures.some((failure) =>
    failure.kind === "work-item"
    && failure.workItemId === transientMediaRepairWorkItem.id
    && failure.count >= 2
  ),
  "queue health should summarize repeated recovery failures for the same product"
)
assert(
  repeatedRecoveryHealth.alerts.some((alert) => alert.id === "repeated-recovery-failures"),
  "queue health should expose repeated automatic recovery failure as a compact alert"
)
assert.equal(repeatedRecoveryHealth.workItems.browserRecoveryCandidates, 0, "repeated recovery failures should pause browser recovery candidates from unattended runs")
assert.equal(repeatedRecoveryHealth.workItems.pausedBrowserRecoveryCandidates, 1, "queue health should count browser recovery candidates paused by the repeated-failure budget")
assert(
  repeatedRecoveryHealth.recovery.paused.some((pause) => pause.workItemId === transientMediaRepairWorkItem.id),
  "queue health should expose the paused recovery candidate reason"
)
updateDianxiaomiProductWorkItemStatus(transientMediaRepairWorkItem.id, "edited", "repair plan classification fixture complete")
updateDianxiaomiProductWorkItemStatus(taskFileRecoverySkipWorkItem.id, "edited", "recovery skip fixture complete")

const daemonBrowserRecoveryWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-daemon-browser-recovery-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-daemon-browser-recovery-work-item",
  pageTitle: "Daemon browser recovery page",
  title: "Daemon browser recovery work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...transientMediaFailure,
    autoRetryRecommended: false,
    updatedAt: new Date().toISOString()
  }
})
assert.equal(daemonBrowserRecoveryWorkItem.repairPlan?.status, "auto-ready", "daemon browser recovery fixture should be auto-ready")
const initialDaemonBrowserRecoveryHealth = getDianxiaomiQueueDaemonHealth()
assert.equal(initialDaemonBrowserRecoveryHealth.workItems.browserRecoveryCandidates, 0, "released action-level recovery candidates should stay out of the normal browser recovery lane")
assert.equal(initialDaemonBrowserRecoveryHealth.workItems.releasedBrowserRecoveryCandidates, 1, "queue health should count released retry candidates separately")
assert.equal(initialDaemonBrowserRecoveryHealth.workItems.autoRetryCandidates, 0, "browser recovery candidates should not be counted as direct safe retry candidates")
writeFileSync(path.join(process.env.SELECTOR_DIAGNOSIS_DIRS, "dianxiaomi-diagnosis-unit-real-browser-recovery.json"), JSON.stringify({
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-daemon-browser-recovery-work-item",
  pageTitle: "Unit real browser recovery calibration",
  createdAt: new Date(Date.now() + 1000).toISOString(),
  requiredOk: true,
  targetSurface: {
    id: "target-surface",
    label: "Target surface",
    status: "done",
    detail: "real Dianxiaomi listing edit page",
    data: {
      surfaceStatus: "real-dianxiaomi",
      isDianxiaomiHost: true,
      isDataFixture: false,
      canInspect: true
    }
  },
  summary: {
    fieldCount: 4,
    buttonCount: 2,
    skuRowCount: 1,
    mediaToolCount: 1
  },
  fields: {
    title: {
      ok: true,
      candidates: [{ selectorHint: "input[name='title']", score: 10, text: "title" }]
    },
    description: {
      ok: true,
      candidates: [{ selectorHint: "textarea[name='description']", score: 10, text: "description" }]
    },
    price: {
      ok: true,
      candidates: [{ selectorHint: "input[name='price']", score: 10, text: "price" }]
    },
    stock: {
      ok: true,
      candidates: [{ selectorHint: "input[name='stock']", score: 10, text: "stock" }]
    },
    attribute: {
      ok: true,
      candidates: [{ selectorHint: "[data-attribute-editor]", score: 10, text: "attribute" }]
    }
  },
  buttons: {
    save: {
      ok: true,
      candidates: [{ selectorHint: "button.save", score: 10, text: "save" }]
    },
    submit: {
      ok: true,
      candidates: [{ selectorHint: "button.submit", score: 10, text: "submit" }]
    }
  },
  mediaTools: {
    batchResize: {
      ok: true,
      candidates: [{ selectorHint: "[data-media-tool='batchResize']", score: 10, text: "batch resize" }]
    }
  },
  mediaToolActions: {
    apply: {
      batchResize: {
        ok: true,
        candidates: [{ selectorHint: "[data-media-action='batchResize-apply']", score: 10, text: "apply" }]
      }
    },
    close: {
      batchResize: {
        ok: true,
        candidates: [{ selectorHint: "[data-media-action='batchResize-close']", score: 10, text: "close" }]
      }
    }
  },
  skuRows: {
    ok: true,
    count: 1,
    samples: []
  }
}, null, 2), "utf8")
writeFileSync(validSelectorConfigPath, JSON.stringify({
  fields: {
    title: ["input[name='title']"],
    description: ["textarea[name='description']"],
    price: ["input[name='price']"],
    stock: ["input[name='stock']"],
    attribute: ["[data-attribute-editor]"]
  },
  buttons: {
    save: ["button.save"],
    submit: ["button.submit"]
  },
  mediaTools: {
    batchResize: ["[data-media-tool='batchResize']"]
  },
  mediaToolActions: {
    apply: {
      batchResize: ["[data-media-action='batchResize-apply']"]
    },
    close: {
      batchResize: ["[data-media-action='batchResize-close']"]
    }
  },
  skuRows: ["tr, [role='row'], [class*='sku' i], [class*='table-row' i], [class*='row' i]"]
}, null, 2), "utf8")
process.env.ALLOW_DIANXIAOMI_SMOKE_URLS = "true"
const daemonBrowserRecoveryProfilePath = path.join(testDir, "daemon-browser-recovery-profile")
mkdirSync(daemonBrowserRecoveryProfilePath, { recursive: true })
const previousBrowserRecoveryTickId = getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null
startDianxiaomiQueueDaemon({
  intervalSeconds: 15,
  maxConsecutiveFailures: 1,
  limit: 1,
  profile: daemonBrowserRecoveryProfilePath,
  selectorConfig: validSelectorConfigPath,
  url: "https://example.com/not-dianxiaomi"
})
const browserRecoveryTick = await waitForNextQueueTick(previousBrowserRecoveryTickId)
assert.equal(browserRecoveryTick.category, "recovery-run-started", "queue daemon should start recovery-run before the normal ready queue")
assert(browserRecoveryTick.recoveryRun, "recovery tick should include recovery-run details")
assert.equal(browserRecoveryTick.recoveryRun?.queued, 1, "daemon recovery run should queue the browser repair candidate")
assert.equal(browserRecoveryTick.recoveryRun?.input.recoveryPolicy, "released-retry", "daemon should retry released recovery candidates in the bounded lane first")
assert.equal(browserRecoveryTick.queueRun, null, "recovery tick should not also start a ready queue run")
assert.equal(getDianxiaomiQueueDaemonState().lastRecoveryRunId, browserRecoveryTick.recoveryRun?.id, "queue daemon should remember the latest recovery run")
const browserRecoveryAudit = getDianxiaomiQueueDaemonHealth().audit.recent.find((entry) => entry.tickId === browserRecoveryTick.id)
assert(browserRecoveryAudit, "queue health should audit recovery-started ticks")
assert.equal(browserRecoveryAudit?.decision, "recovery-started", "recovery audit should classify daemon recovery starts")
assert.equal(browserRecoveryAudit?.recoveryRunId, browserRecoveryTick.recoveryRun?.id, "recovery audit should link to the recovery-run")
assert(browserRecoveryAudit?.workItemIds.includes(daemonBrowserRecoveryWorkItem.id), "recovery audit should include the selected work item")
assert.equal(getDianxiaomiQueueDaemonHealth().recommendation.kind, "continue-running", "running daemon with runnable work should recommend continuing unattended mode")
const finishedDaemonRecoveryRun = await waitForRecoveryRun(browserRecoveryTick.recoveryRun!.id)
assert.equal(finishedDaemonRecoveryRun.status, "failed", "bad daemon recovery target should fail the recovery run without hanging")
assert.equal(getDianxiaomiProductWorkItem(daemonBrowserRecoveryWorkItem.id)?.status, "blocked", "failed browser recovery should leave the item blocked")
const repeatedDaemonRecoveryRun = startDianxiaomiRecoveryRun({
  limit: 1,
  workItemIds: [daemonBrowserRecoveryWorkItem.id],
  url: "https://example.com/not-dianxiaomi",
  selectorConfig: validSelectorConfigPath
})
const finishedRepeatedDaemonRecoveryRun = await waitForRecoveryRun(repeatedDaemonRecoveryRun.id)
assert.equal(finishedRepeatedDaemonRecoveryRun.status, "failed", "second daemon recovery failure should finish without hanging")
const pausedDaemonRecoveryHealth = getDianxiaomiQueueDaemonHealth()
assert.equal(pausedDaemonRecoveryHealth.workItems.browserRecoveryCandidates, 0, "repeated daemon recovery failure should remove the item from unattended browser recovery candidates")
assert.equal(pausedDaemonRecoveryHealth.workItems.pausedBrowserRecoveryCandidates, 1, "repeated daemon recovery failure should count the paused browser recovery candidate")
const previousPausedRecoveryTickId = getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null
startDianxiaomiQueueDaemon({
  intervalSeconds: 15,
  maxConsecutiveFailures: 1,
  limit: 1,
  profile: daemonBrowserRecoveryProfilePath,
  selectorConfig: validSelectorConfigPath,
  url: "https://example.com/not-dianxiaomi"
})
const pausedRecoveryTick = await waitForNextQueueTick(previousPausedRecoveryTickId)
assert.notEqual(pausedRecoveryTick.category, "recovery-run-started", "queue daemon should not start recovery-run for candidates paused by repeated failures")
assert.equal(pausedRecoveryTick.recoveryRun, null, "paused repeated recovery candidate should not create a recovery run")
pauseDianxiaomiQueueDaemon()
const releasedDaemonRecoveryWorkItem = saveDianxiaomiProductWorkItem({
  ...daemonBrowserRecoveryWorkItem,
  notes: [...daemonBrowserRecoveryWorkItem.notes, "operator changed product after repeated recovery failure"],
  status: "blocked",
  rawTextSample: `${daemonBrowserRecoveryWorkItem.rawTextSample} updated after recovery pause`
})
const releasedDaemonRecoveryHealth = getDianxiaomiQueueDaemonHealth()
assert.equal(releasedDaemonRecoveryHealth.workItems.browserRecoveryCandidates, 0, "product update should not return a released pause directly to the normal browser recovery lane")
assert.equal(releasedDaemonRecoveryHealth.workItems.releasedBrowserRecoveryCandidates, 1, "product update should move the released pause into the bounded released-retry lane")
assert(
  releasedDaemonRecoveryHealth.recovery.releases.some((release) =>
    release.workItemId === releasedDaemonRecoveryWorkItem.id
    && ["work-item-updated", "repair-plan-regenerated"].includes(release.releaseType)
  ),
  "queue health should record why a repeated-failure recovery pause was released"
)
assert(
  releasedDaemonRecoveryHealth.recovery.releasedRetryCandidates.some((candidate) => candidate.workItemId === releasedDaemonRecoveryWorkItem.id),
  "queue health should expose released retry candidates separately from normal browser recovery"
)
const secondReleasedDaemonRecoveryWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-daemon-browser-recovery-work-item-released-2",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-daemon-browser-recovery-work-item-released-2",
  pageTitle: "Second released daemon browser recovery page",
  title: "Second released daemon browser recovery work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals after recovery pause",
  notes: ["new product after repeated recovery action failure"],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...transientMediaFailure,
    autoRetryRecommended: false,
    updatedAt: new Date().toISOString()
  }
})
const multiReleasedDaemonRecoveryHealth = getDianxiaomiQueueDaemonHealth()
assert.equal(multiReleasedDaemonRecoveryHealth.workItems.releasedBrowserRecoveryCandidates, 2, "multiple released pauses should stay in the released-retry lane")
assert.equal(multiReleasedDaemonRecoveryHealth.recovery.releasedRetryBatch.pendingCount, 2, "released retry batch policy should expose pending released retry candidates")
assert.equal(multiReleasedDaemonRecoveryHealth.recovery.releasedRetryBatch.maxItemsPerTick, 1, "released retry batch policy should stay bounded to one item per daemon tick")
assert.equal(multiReleasedDaemonRecoveryHealth.recovery.releasedRetryBatch.nextWorkItemIds.length, 1, "released retry batch policy should identify only the next bounded item")
const previousReleasedRetryTickId = getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null
startDianxiaomiQueueDaemon({
  intervalSeconds: 15,
  maxConsecutiveFailures: 1,
  limit: 5,
  profile: daemonBrowserRecoveryProfilePath,
  selectorConfig: validSelectorConfigPath,
  url: "https://example.com/not-dianxiaomi"
})
const releasedRetryTick = await waitForNextQueueTick(previousReleasedRetryTickId)
assert.equal(releasedRetryTick.category, "recovery-run-started", "queue daemon should retry released recovery candidates before normal browser recovery")
assert(releasedRetryTick.recoveryRun, "released retry tick should include a recovery-run")
assert.equal(releasedRetryTick.recoveryRun?.input.recoveryPolicy, "released-retry", "released retry recovery-runs should be marked with their policy")
assert.equal(releasedRetryTick.recoveryRun?.limit, 1, "released retry lane should run at most one item per daemon tick")
assert.equal(releasedRetryTick.recoveryRun?.items.length, 1, "released retry lane should not mix every released candidate into one recovery batch")
assert(
  [releasedDaemonRecoveryWorkItem.id, secondReleasedDaemonRecoveryWorkItem.id].includes(releasedRetryTick.recoveryRun!.items[0]!.workItemId),
  "released retry lane should select one of the released candidates"
)
const releasedRetrySelectedWorkItemId = releasedRetryTick.recoveryRun!.items[0]!.workItemId
await waitForRecoveryRun(releasedRetryTick.recoveryRun!.id)
const releasedRetryOutcomeHealth = getDianxiaomiQueueDaemonHealth()
assert.equal(releasedRetryOutcomeHealth.workItems.releasedBrowserRecoveryCandidates, 0, "failed action-level released retry should pause same-action released candidates until a new release event")
assert(releasedRetryOutcomeHealth.workItems.pausedBrowserRecoveryCandidates >= 1, "failed released retry should re-pause browser recovery candidates until a new product or calibration change")
assert(
  releasedRetryOutcomeHealth.recovery.releasedRetryOutcomes.some((outcome) =>
    outcome.runId === releasedRetryTick.recoveryRun!.id
    && outcome.workItemId === releasedRetrySelectedWorkItemId
    && outcome.nextState === "repaused"
  ),
  "queue health should summarize released retry failure closure as repaused"
)
updateDianxiaomiProductWorkItemStatus(daemonBrowserRecoveryWorkItem.id, "edited", "daemon browser recovery fixture complete")
updateDianxiaomiProductWorkItemStatus(secondReleasedDaemonRecoveryWorkItem.id, "edited", "second daemon browser recovery fixture complete")
delete process.env.ALLOW_DIANXIAOMI_SMOKE_URLS
pauseDianxiaomiQueueDaemon()

const repairPlanAutoReleaseWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-repair-plan-auto-release-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-repair-plan-auto-release-work-item",
  pageTitle: "Repair plan auto release page",
  title: "Repair plan auto release work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...transientMediaFailure,
    autoRetryRecommended: false,
    updatedAt: new Date().toISOString()
  }
})
assert.equal(repairPlanAutoReleaseWorkItem.repairPlan?.status, "auto-ready", "repair-plan auto release fixture should be auto-ready")
const repairPlanAutoReleaseRun = startDianxiaomiQueueRun({
  limit: 1,
  url: "https://example.com/not-dianxiaomi",
  selectorConfig: validSelectorConfigPath
})
assert.deepEqual(
  repairPlanAutoReleaseRun.autoRetryReleasedIds,
  [],
  "manual queue-run must not direct-release browser-executable repair-plan candidates"
)
assert.equal(repairPlanAutoReleaseRun.queued, 0, "repair-plan auto release test should not start a full-flow job")
assert(
  !repairPlanAutoReleaseRun.skippedItems.some((item) => item.workItemId === repairPlanAutoReleaseWorkItem.id),
  "browser repair candidates should stay out of the normal ready queue"
)
assert.equal(getDianxiaomiProductWorkItem(repairPlanAutoReleaseWorkItem.id)?.status, "blocked", "browser repair candidate should remain blocked until recovery-run")
const repairPlanAutoReleaseHealth = getDianxiaomiQueueDaemonHealth()
assert(
  repairPlanAutoReleaseHealth.workItems.browserRecoveryCandidates + repairPlanAutoReleaseHealth.workItems.releasedBrowserRecoveryCandidates >= 1,
  "browser repair candidate should be counted for recovery-run"
)
updateDianxiaomiProductWorkItemStatus(repairPlanAutoReleaseWorkItem.id, "edited", "browser repair candidate queue-run fixture complete")

const invalidMediaRepairWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-invalid-media-repair-plan-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-invalid-media-repair-plan-work-item",
  pageTitle: "Invalid media repair page",
  title: "Invalid media repair plan work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...invalidMediaFailure,
    updatedAt: new Date().toISOString()
  }
})
assert.equal(invalidMediaRepairWorkItem.repairPlan?.status, "assisted", "invalid media failure should require assisted repair")
assert.equal(invalidMediaRepairWorkItem.repairPlan?.canAutoRepair, false, "invalid media repair should not be fully automatic")
assert.equal(invalidMediaRepairWorkItem.repairActionGate?.defaultActionAllowed, false, "assisted repair plans should pause default unattended actions")
assert.equal(invalidMediaRepairWorkItem.repairActionGate?.status, "assisted", "assisted repair plans should expose an assisted action gate")
assert.match(invalidMediaRepairWorkItem.repairActionGate?.message ?? "", /默认无人值守动作已暂停/, "assisted action gates should explain why default actions are paused")
assert(invalidMediaRepairWorkItem.repairPlan?.actions.some((action) => action.type === "review-image"), "invalid media repair plan should review images")

const storageQuotaMediaRepairWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-storage-quota-media-repair-plan-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-storage-quota-media-repair-plan-work-item",
  pageTitle: "Storage quota media repair page",
  title: "Storage quota media repair plan work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["batch resize", "image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...storageQuotaMediaFailure,
    updatedAt: new Date().toISOString()
  }
})
assert.equal(storageQuotaMediaRepairWorkItem.repairPlan?.status, "manual", "image space quota failures should enter manual-step budget")
assert.equal(storageQuotaMediaRepairWorkItem.repairPlan?.canAutoRepair, false, "image space quota failures must not be auto repairable")
assert.equal(storageQuotaMediaRepairWorkItem.repairActionGate?.defaultActionAllowed, false, "manual image-space failures should pause default unattended actions")
assert.equal(storageQuotaMediaRepairWorkItem.repairActionGate?.status, "manual", "manual image-space failures should expose a manual action gate")
assert(storageQuotaMediaRepairWorkItem.repairPlan?.actions.some((action) => action.payload?.reasonCode === "storage-quota"), "image space quota repair plan should expose the storage-quota reason code")
assert(storageQuotaMediaRepairWorkItem.repairPlan?.actions.some((action) => action.automation === "manual"), "image space quota repair plan should require manual action")

const publishRepairWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-publish-repair-plan-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-publish-repair-plan-work-item",
  pageTitle: "Publish repair page",
  title: "Publish repair plan work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...publishFailure,
    updatedAt: new Date().toISOString()
  }
})
assert.equal(publishRepairWorkItem.repairPlan?.status, "assisted", "publish validation should create an assisted repair plan")
assert(publishRepairWorkItem.repairPlan?.actions.some((action) => action.type === "fix-field"), "publish repair plan should fix missing fields")
assert(publishRepairWorkItem.repairPlan?.actions.some((action) => action.field === "attribute" && action.target === "商品属性"), "generic publish repair should fall back to product attributes")

const publishAttributeFailure = classifyDianxiaomiWorkFailure("publish failed: missing required attribute: Color; 缺少必填属性：材质")
const publishAttributeRepairWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-publish-attribute-repair-plan-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-publish-attribute-repair-plan-work-item",
  pageTitle: "Publish attribute repair page",
  title: "Publish attribute repair plan work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...publishAttributeFailure,
    updatedAt: new Date().toISOString()
  }
})
assert.equal(publishAttributeRepairWorkItem.repairPlan?.status, "assisted", "specific publish attributes should remain assisted")
assert.equal(publishAttributeRepairWorkItem.repairPlan?.canAutoRepair, false, "specific publish attributes should not auto repair")
assert(publishAttributeRepairWorkItem.repairPlan?.actions.some((action) => action.field === "attribute" && action.target === "Color"), "publish repair should extract English attribute target")
assert(publishAttributeRepairWorkItem.repairPlan?.actions.some((action) => action.field === "attribute" && action.target === "材质"), "publish repair should extract Chinese attribute target")
assert(publishAttributeRepairWorkItem.repairPlan?.actions.some((action) => action.payload?.writer === "fill-attributes" && action.payload.attributeKey === "Color"), "publish repair should expose executable attribute payload")

const linkedPublishCollectedProduct = saveDianxiaomiCollectedProduct({
  id: "unit-linked-publish-collected-product",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-linked-publish-collected-product",
  pageTitle: "Linked publish collected product",
  title: "Linked publish collected product",
  category: "Linked publish category",
  sourceUrl: "https://www.dianxiaomi.com/product/edit/unit-linked-publish-collected-product",
  images: ["https://example.com/linked-publish.jpg"],
  attributes: {
    color: "black",
    material: "cotton"
  },
  skus: [{
    skuName: "Black Cotton",
    priceCny: 15.6,
    stock: 8,
    attributes: {
      color: "black",
      material: "cotton"
    },
    rowText: "Black Cotton 15.6 8"
  }],
  rawTextSample: "linked publish collected product raw text",
  notes: ["unit"]
})
const linkedPublishAttributeRepairWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-linked-publish-attribute-repair-plan-work-item",
  collectedProductId: linkedPublishCollectedProduct.id,
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-linked-publish-attribute-repair-plan-work-item",
  pageTitle: "Linked publish attribute repair page",
  title: "Linked publish attribute repair plan work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with linked collected attributes",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color", "material"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...publishAttributeFailure,
    updatedAt: new Date().toISOString()
  }
})
assert.equal(linkedPublishAttributeRepairWorkItem.repairPlan?.status, "auto-ready", "linked collected publish attributes should become auto-ready")
assert.equal(linkedPublishAttributeRepairWorkItem.repairPlan?.canAutoRepair, true, "linked collected publish attributes should auto repair")
assert(linkedPublishAttributeRepairWorkItem.repairPlan?.actions.every((action) => action.automation === "auto"), "linked collected publish attributes should only emit automatic repair actions")
assert(linkedPublishAttributeRepairWorkItem.repairPlan?.actions.some((action) => action.payload?.attributeKey === "Color" && action.payload.expectedValue === "black"), "linked collected publish attributes should carry the Color expected value")
assert(linkedPublishAttributeRepairWorkItem.repairPlan?.actions.some((action) => action.payload?.attributeKey === "材质" && action.payload.expectedValue === "cotton"), "linked collected publish attributes should carry the material expected value")
updateDianxiaomiProductWorkItemStatus(linkedPublishAttributeRepairWorkItem.id, "edited", "linked publish attribute auto-ready fixture complete")

const linkedPublishNoColonFailure = classifyDianxiaomiWorkFailure("submit-listing: missing required attribute Color", "full-flow")
const linkedPublishNoColonRepairWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-linked-publish-no-colon-repair-plan-work-item",
  collectedProductId: linkedPublishCollectedProduct.id,
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-linked-publish-no-colon-repair-plan-work-item",
  pageTitle: "Linked publish no-colon repair page",
  title: "Linked publish no-colon repair plan work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with linked collected attributes",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color", "material"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...linkedPublishNoColonFailure,
    updatedAt: new Date().toISOString()
  },
  publishOutcome: {
    status: "failed",
    flowJobId: "unit-linked-publish-no-colon-flow",
    route: "browser-recovery",
    message: "submit-listing failed",
    failureReason: "missing required attribute Color",
    attempts: 2,
    maxAttempts: 2,
    submitStageJobId: "submit-job-no-colon",
    updatedAt: new Date().toISOString()
  }
})
assert.equal(linkedPublishNoColonRepairWorkItem.repairPlan?.status, "auto-ready", "linked collected publish attributes without colon should still become auto-ready")
assert.equal(linkedPublishNoColonRepairWorkItem.repairPlan?.canAutoRepair, true, "linked collected publish attributes without colon should auto repair")
assert(linkedPublishNoColonRepairWorkItem.repairPlan?.actions.every((action) => action.automation === "auto"), "linked collected publish attributes without colon should stay automatic")
assert(linkedPublishNoColonRepairWorkItem.repairPlan?.actions.some((action) => action.payload?.attributeKey === "Color" && action.payload.expectedValue === "black"), "linked collected publish attributes without colon should keep the Color expected value")
assert.equal(
  getDianxiaomiQueueDaemonHealth().workItems.browserRecoveryCandidates >= 1,
  true,
  "linked collected publish attributes without colon should feed browser recovery candidates"
)
updateDianxiaomiProductWorkItemStatus(linkedPublishNoColonRepairWorkItem.id, "edited", "linked publish no-colon attribute auto-ready fixture complete")

const linkedPublishOutcomeFallbackFailure = classifyDianxiaomiWorkFailure("submit-listing failed: partial", "full-flow")
const linkedPublishOutcomeFallbackRepairWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-linked-publish-outcome-fallback-repair-plan-work-item",
  collectedProductId: linkedPublishCollectedProduct.id,
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-linked-publish-outcome-fallback-repair-plan-work-item",
  pageTitle: "Linked publish outcome fallback repair page",
  title: "Linked publish outcome fallback repair plan work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with linked collected attributes",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color", "material"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...linkedPublishOutcomeFallbackFailure,
    updatedAt: new Date().toISOString()
  },
  publishOutcome: {
    status: "failed",
    flowJobId: "unit-linked-publish-outcome-fallback-flow",
    route: "browser-recovery",
    message: "submit-listing failed: partial",
    failureReason: "Publish failed: missing required attribute Color",
    attempts: 2,
    maxAttempts: 2,
    submitStageJobId: "submit-job-outcome-fallback",
    checkedAt: new Date().toISOString(),
    reportPath: null
  }
})
assert.equal(linkedPublishOutcomeFallbackRepairWorkItem.repairPlan?.status, "auto-ready", "publish outcome failure reason should recover attribute targets when diagnosis text is generic")
assert.equal(linkedPublishOutcomeFallbackRepairWorkItem.repairPlan?.canAutoRepair, true, "publish outcome failure reason should keep linked collected attribute repairs automatic")
assert(linkedPublishOutcomeFallbackRepairWorkItem.repairPlan?.actions.some((action) => action.payload?.attributeKey === "Color" && action.payload.expectedValue === "black"), "publish outcome failure reason should preserve the Color expected value")
updateDianxiaomiProductWorkItemStatus(linkedPublishOutcomeFallbackRepairWorkItem.id, "edited", "linked publish outcome fallback fixture complete")

const publishSkuImageFailure = classifyDianxiaomiWorkFailure("publish failed: SKU variation missing; main image required")
const publishSkuImageRepairWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-publish-sku-image-repair-plan-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-publish-sku-image-repair-plan-work-item",
  pageTitle: "Publish sku image repair page",
  title: "Publish sku image repair plan work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...publishSkuImageFailure,
    updatedAt: new Date().toISOString()
  }
})
assert(publishSkuImageRepairWorkItem.repairPlan?.actions.some((action) => action.field === "sku" && action.target === "SKU/规格"), "publish repair should classify SKU failures")
assert(publishSkuImageRepairWorkItem.repairPlan?.actions.some((action) => action.field === "image" && action.type === "review-image"), "publish repair should classify image failures")
assert(publishSkuImageRepairWorkItem.repairPlan?.actions.some((action) => action.payload?.writer === "fill-sku-pricing" && action.payload.selectorGroup === "skuRows"), "publish repair should expose SKU writer payload")
assert(publishSkuImageRepairWorkItem.repairPlan?.actions.some((action) => action.payload?.writer === "run-media-tool" && action.payload.mediaTool === "imageManagement"), "publish repair should expose image media payload")

const retryAfterFixLoginWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-retry-after-fix-login-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-retry-after-fix-login-work-item",
  pageTitle: "Retry after fix login page",
  title: "Retry after fix login work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...loginFailure,
    updatedAt: new Date().toISOString()
  }
})
const retryAfterFixLoginResult = requeueDianxiaomiProductWorkItemAfterFix(retryAfterFixLoginWorkItem.id)
assert.equal(retryAfterFixLoginResult?.requeued, false, "retry-after-fix must not release login/CAPTCHA blockers")
assert.equal(retryAfterFixLoginResult?.workItem.status, "blocked", "login/CAPTCHA item should remain blocked")
assert.equal(retryAfterFixLoginWorkItem.repairPlan?.status, "blocked", "login/CAPTCHA should keep a blocked repair plan")
assert.equal(retryAfterFixLoginWorkItem.repairPlan?.canAutoRepair, false, "login/CAPTCHA repair must not be automatic")
assert.equal(retryAfterFixLoginWorkItem.repairActionGate?.defaultActionAllowed, false, "blocked repair plans should pause default unattended actions")
assert.equal(retryAfterFixLoginWorkItem.repairActionGate?.status, "blocked", "blocked repair plans should expose a blocked action gate")

const retryAfterFixBadUrlWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-retry-after-fix-bad-url-work-item",
  pageUrl: "https://example.com/product/edit/unit-retry-after-fix-bad-url-work-item",
  pageTitle: "Retry after fix bad URL page",
  title: "Retry after fix bad URL work item",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...publishFailure,
    updatedAt: new Date().toISOString()
  }
})
const retryAfterFixBadUrlResult = requeueDianxiaomiProductWorkItemAfterFix(retryAfterFixBadUrlWorkItem.id)
assert.equal(retryAfterFixBadUrlResult?.requeued, false, "retry-after-fix must not release invalid target URLs")
assert.equal(retryAfterFixBadUrlResult?.workItem.status, "blocked", "invalid URL item should remain blocked")
assert.match(retryAfterFixBadUrlResult?.reason ?? "", /host|Dianxiaomi|URL/i, "invalid URL retry denial should explain the target issue")

writeFileSync(path.join(process.env.SELECTOR_DIAGNOSIS_DIRS, "dianxiaomi-diagnosis-unit-fixture.json"), JSON.stringify({
  pageUrl: "data:text/html,<main>fixture</main>",
  pageTitle: "Unit fixture calibration",
  createdAt: new Date(Date.now() + 60_000).toISOString(),
  requiredOk: true,
  targetSurface: {
    id: "target-surface",
    label: "Target surface",
    status: "done",
    detail: "fixture",
    data: {
      surfaceStatus: "fixture",
      isDianxiaomiHost: false,
      isDataFixture: true,
      canInspect: true
    }
  },
  summary: {
    fieldCount: 4,
    buttonCount: 1,
    skuRowCount: 1,
    mediaToolCount: 1
  },
  fields: {
    title: {
      ok: true,
      candidates: [{ selectorHint: "input[name='title']", score: 10, text: "title" }]
    },
    description: {
      ok: true,
      candidates: [{ selectorHint: "textarea[name='description']", score: 10, text: "description" }]
    },
    price: {
      ok: true,
      candidates: [{ selectorHint: "input[name='price']", score: 10, text: "price" }]
    },
    stock: {
      ok: true,
      candidates: [{ selectorHint: "input[name='stock']", score: 10, text: "stock" }]
    }
  },
  buttons: {
    save: {
      ok: true,
      candidates: [{ selectorHint: "button.save", score: 10, text: "save" }]
    }
  },
  mediaTools: {},
  skuRows: {
    ok: true,
    count: 1,
    samples: []
  }
}, null, 2), "utf8")

const readyWorkItemForCalibrationGate = saveDianxiaomiProductWorkItem({
  id: "unit-real-url-work-item-for-calibration-gate",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-real-url-work-item-for-calibration-gate",
  pageTitle: "Real URL calibration gate page",
  title: "Real URL work item for calibration gate",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "ready-for-automation"
})
assert.equal(readyWorkItemForCalibrationGate.status, "ready-for-automation", "real URL work item should be ready before calibration gate")
const blockedStartupBrowserRecoveryCandidate = saveDianxiaomiProductWorkItem({
  id: "unit-browser-recovery-work-item-for-startup-block",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-browser-recovery-work-item-for-startup-block",
  pageTitle: "Browser recovery candidate for startup block",
  title: "Browser recovery candidate for startup block",
  categoryHint: { label: "Home & Garden" },
  rawTextSample: "complete real listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "blocked",
  failureDiagnosis: {
    ...transientMediaFailure,
    autoRetryRecommended: false,
    updatedAt: new Date().toISOString()
  }
})
assert.equal(blockedStartupBrowserRecoveryCandidate.repairPlan?.status, "auto-ready", "startup-block recovery fixture should be auto-ready")

const previousCalibrationGateTickId = getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null
const fixtureCalibrationProfilePath = path.join(testDir, "fixture-calibration-profile")
mkdirSync(fixtureCalibrationProfilePath, { recursive: true })
const blockedByFixtureCalibration = startDianxiaomiQueueDaemon({
  intervalSeconds: 15,
  maxConsecutiveFailures: 1,
  limit: 1,
  profile: fixtureCalibrationProfilePath,
  selectorConfig: validSelectorConfigPath
})
assert.equal(blockedByFixtureCalibration.status, "PAUSED", "queue daemon should remain paused when startup precheck blocks activation")
assert.equal(blockedByFixtureCalibration.nextRunAt, null, "blocked startup should not schedule another queue daemon run")
assert.match(blockedByFixtureCalibration.lastError ?? "", /real Dianxiaomi|fixture/i, "blocked startup should explain the real Dianxiaomi requirement")
assert.equal(getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null, previousCalibrationGateTickId, "blocked startup should not create a failed queue tick")
assert.equal(
  getDianxiaomiQueueDaemonHealth().workItems.browserRecoveryCandidates + getDianxiaomiQueueDaemonHealth().workItems.releasedBrowserRecoveryCandidates >= 1,
  true,
  "startup calibration block regression should still have a browser recovery candidate present"
)
const staleCalibrationDiagnosisDir = path.join(testDir, "stale-calibration-diagnoses")
mkdirSync(staleCalibrationDiagnosisDir, { recursive: true })
const previousSelectorDiagnosisDirs = process.env.SELECTOR_DIAGNOSIS_DIRS
try {
  process.env.SELECTOR_DIAGNOSIS_DIRS = staleCalibrationDiagnosisDir
  const staleCalibrationProfilePath = path.join(testDir, "stale-calibration-profile")
  mkdirSync(staleCalibrationProfilePath, { recursive: true })
  writeRealSelectorDiagnosis(
    "dianxiaomi-diagnosis-unit-stale-real.json",
    readyWorkItemForCalibrationGate.pageUrl,
    "Stale real Dianxiaomi calibration",
    -(48 * 60 * 60 * 1000)
  )
  const staleCalibrationStartup = getDianxiaomiUnattendedStartupCheck({
    intervalSeconds: 15,
    maxConsecutiveFailures: 1,
    limit: 1,
    profile: staleCalibrationProfilePath,
    selectorConfig: validSelectorConfigPath
  })
  const staleCalibrationCheck = staleCalibrationStartup.checks.find((check) => check.id === "real-dianxiaomi-calibration")
  assert(staleCalibrationCheck, "startup checks should include real Dianxiaomi calibration freshness")
  assert.equal(staleCalibrationCheck?.status, "block", "stale real Dianxiaomi calibration should block unattended startup")
  assert.match(staleCalibrationCheck?.message ?? "", /stale|old/i, "stale real calibration should explain the freshness problem")
  assert.equal(staleCalibrationStartup.canStart, false, "stale real calibration should keep unattended startup blocked")
  const previousStaleCalibrationTickId = getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null
  const blockedByStaleCalibration = startDianxiaomiQueueDaemon({
    intervalSeconds: 15,
    maxConsecutiveFailures: 1,
    limit: 1,
    profile: staleCalibrationProfilePath,
    selectorConfig: validSelectorConfigPath
  })
  assert.equal(blockedByStaleCalibration.status, "PAUSED", "queue daemon should remain paused when the real Dianxiaomi calibration is stale")
  assert.equal(blockedByStaleCalibration.nextRunAt, null, "stale calibration startup block should not schedule another queue daemon run")
  assert.match(blockedByStaleCalibration.lastError ?? "", /stale|calibration|real Dianxiaomi/i, "stale calibration startup block should explain the freshness problem")
  assert.equal(getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null, previousStaleCalibrationTickId, "stale calibration startup block should not create a queue tick")
} finally {
  process.env.SELECTOR_DIAGNOSIS_DIRS = previousSelectorDiagnosisDirs
}

const sessionHealthDiagnosisDir = path.join(testDir, "session-health-diagnoses")
mkdirSync(sessionHealthDiagnosisDir, { recursive: true })
const previousSessionDiagnosisDirs = process.env.SELECTOR_DIAGNOSIS_DIRS
try {
  process.env.SELECTOR_DIAGNOSIS_DIRS = sessionHealthDiagnosisDir
  const sessionHealthProfilePath = path.join(testDir, "session-health-profile")
  mkdirSync(sessionHealthProfilePath, { recursive: true })
  writeRealSelectorDiagnosis(
    "dianxiaomi-diagnosis-unit-session-baseline.json",
    readyWorkItemForCalibrationGate.pageUrl,
    "Session baseline real Dianxiaomi calibration",
    -(60 * 1000)
  )
  const loginBlockedWorkItem = saveDianxiaomiProductWorkItem({
    id: "unit-login-session-block-work-item",
    pageUrl: "https://www.dianxiaomi.com/product/edit/unit-login-session-block-work-item",
    pageTitle: "Login session blocker",
    title: "Login session blocker",
    categoryHint: { label: "Home & Garden" },
    rawTextSample: "complete real listing but session expired",
    notes: [],
    snapshot: {
      hasTitle: true,
      imageCount: 2,
      skuCount: 1,
      priceFieldCount: 1,
      stockFieldCount: 1,
      attributeKeys: ["color"],
      mediaToolSignals: ["image translation"]
    },
    status: "blocked",
    failureDiagnosis: {
      ...loginFailure,
      message: "login captcha required before Dianxiaomi automation can continue",
      updatedAt: new Date().toISOString()
    }
  })
  const blockedSessionStartup = getDianxiaomiUnattendedStartupCheck({
    intervalSeconds: 15,
    maxConsecutiveFailures: 1,
    limit: 1,
    profile: sessionHealthProfilePath,
    selectorConfig: validSelectorConfigPath
  })
  const blockedSessionCheck = blockedSessionStartup.checks.find((check) => check.id === "dianxiaomi-session")
  assert(blockedSessionCheck, "startup checks should include Dianxiaomi session health")
  assert.equal(blockedSessionCheck?.status, "block", "latest login-or-captcha blocker should block unattended startup")
  assert.match(blockedSessionCheck?.message ?? "", /login|captcha/i, "session blocker should explain the login-or-captcha problem")
  assert.equal(blockedSessionStartup.canStart, false, "session blocker should keep unattended startup blocked")
  assert.equal(
    blockedSessionStartup.health.recommendation.kind,
    "resolve-login-or-captcha",
    "queue health should prioritize resolving the Dianxiaomi session blocker"
  )
  assert(
    blockedSessionStartup.health.alerts.some((alert) => alert.id === "resolve-login-or-captcha"),
    "queue health should expose a compact session blocker alert"
  )
  const previousSessionBlockTickId = getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null
  const blockedBySession = startDianxiaomiQueueDaemon({
    intervalSeconds: 15,
    maxConsecutiveFailures: 1,
    limit: 1,
    profile: sessionHealthProfilePath,
    selectorConfig: validSelectorConfigPath
  })
  assert.equal(blockedBySession.status, "PAUSED", "queue daemon should remain paused when the latest Dianxiaomi session signal is blocked")
  assert.equal(blockedBySession.nextRunAt, null, "session blocker should not schedule another queue daemon run")
  assert.match(blockedBySession.lastError ?? "", /login|captcha/i, "session blocker should explain the login-or-captcha requirement")
  assert.equal(getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null, previousSessionBlockTickId, "session startup block should not create a queue tick")
  writeRealSelectorDiagnosis(
    "dianxiaomi-diagnosis-unit-session-recovered.json",
    readyWorkItemForCalibrationGate.pageUrl,
    "Session recovered real Dianxiaomi calibration",
    60 * 1000
  )
  const recoveredSessionStartup = getDianxiaomiUnattendedStartupCheck({
    intervalSeconds: 15,
    maxConsecutiveFailures: 1,
    limit: 1,
    profile: sessionHealthProfilePath,
    selectorConfig: validSelectorConfigPath
  })
  assert.equal(
    recoveredSessionStartup.checks.find((check) => check.id === "dianxiaomi-session")?.status,
    "pass",
    "a newer real Dianxiaomi diagnosis should clear the session startup blocker"
  )
  assert.equal(
    recoveredSessionStartup.health.issues.some((issue) => issue.id === "login-or-captcha-session"),
    false,
    "recovered session should be removed from queue health blockers"
  )
  updateDianxiaomiProductWorkItemStatus(loginBlockedWorkItem.id, "edited", "session recovered after fresh real-page diagnosis")
} finally {
  process.env.SELECTOR_DIAGNOSIS_DIRS = previousSessionDiagnosisDirs
}

// The session-health scenario above started a queue daemon that recorded a
// login/CAPTCHA pause in the global queue-daemon audit ledger. That audit
// blocker is not diagnosis-dir scoped, so the recovery diagnosis written inside
// the isolated session dir is no longer visible once SELECTOR_DIAGNOSIS_DIRS is
// restored. Capture a fresh real-page diagnosis here to prove the session
// recovered before exercising the selector-config startup block below.
writeRealSelectorDiagnosis(
  "dianxiaomi-diagnosis-unit-selector-override-session-recovered.json",
  readyWorkItemForCalibrationGate.pageUrl,
  "Selector override session recovered real Dianxiaomi calibration",
  60 * 1000
)

process.env.ALLOW_DIANXIAOMI_SMOKE_URLS = "true"
const previousFixtureOverrideTickId = getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null
const fixtureOverrideStarted = startDianxiaomiQueueDaemon({
  intervalSeconds: 15,
  maxConsecutiveFailures: 1,
  limit: 1,
  profile: fixtureCalibrationProfilePath,
  selectorConfig: incompleteSelectorConfigPath
})
assert.equal(fixtureOverrideStarted.status, "PAUSED", "smoke override should still keep the daemon paused when selector config blocks startup")
assert.match(fixtureOverrideStarted.lastError ?? "", /selector config/i, "selector-blocked startup should explain the selector config problem")
assert.equal(getDianxiaomiQueueDaemonState().ticks[0]?.id ?? null, previousFixtureOverrideTickId, "selector-blocked startup should not create a queue tick")
delete process.env.ALLOW_DIANXIAOMI_SMOKE_URLS
pauseDianxiaomiQueueDaemon()
updateDianxiaomiProductWorkItemStatus(blockedStartupBrowserRecoveryCandidate.id, "edited", "startup block recovery fixture complete")

const smokeUrlValidation = validateDianxiaomiAutomationPageUrl("https://www.dianxiaomi.com/product/edit/work-smoke#rescan")
assert.equal(smokeUrlValidation.valid, false, "production URL validation should reject smoke Dianxiaomi URLs by default")
assert.match(smokeUrlValidation.reason ?? "", /demo\/smoke/i, "smoke URL validation should explain the demo/smoke block")

const smokeTargetReadiness = getAutomationModeReadiness("dry-run", {
  url: "https://www.dianxiaomi.com/product/edit/work-smoke#rescan"
})
assert.equal(smokeTargetReadiness.ready, false, "automation readiness should block smoke Dianxiaomi target URLs")
assert.match(smokeTargetReadiness.reason, /not a real Dianxiaomi product edit URL/i)
assert.throws(
  () => startDianxiaomiDryRun({
    url: "https://www.dianxiaomi.com/product/edit/work-smoke#rescan"
  }),
  AutomationSafetyGateError,
  "starting automation should reject smoke Dianxiaomi target URLs before browser launch"
)

const smokeTaskFile = path.join(testDir, "smoke-task-file.json")
writeFileSync(smokeTaskFile, JSON.stringify({
  id: "smoke-task-file",
  product: {
    id: "smoke-product",
    source: "dianxiaomi",
    sourceUrl: "https://www.dianxiaomi.com/product/edit/work-smoke#rescan",
    title: "Smoke task file",
    category: "fixture",
    supplierPriceCny: 1,
    estimatedDomesticShippingCny: 0,
    estimatedWeightKg: 0.1,
    images: [],
    attributes: {},
    skus: []
  },
  draft: {
    productId: "smoke-product",
    listingTitle: "Smoke task file",
    sellingPoints: [],
    description: "",
    categoryPath: [],
    attributes: {
      dianxiaomiPageUrl: "https://www.dianxiaomi.com/product/edit/work-smoke#rescan"
    },
    skuPricing: []
  }
}, null, 2), "utf8")
const smokeTaskFileReadiness = getAutomationModeReadiness("dry-run", {
  taskFile: smokeTaskFile
})
assert.equal(smokeTaskFileReadiness.ready, false, "automation readiness should block smoke Dianxiaomi URLs embedded in task files")
assert.match(smokeTaskFileReadiness.reason, /task product source URL|task Dianxiaomi page URL/i)
assert.throws(
  () => startDianxiaomiDryRun({
    taskFile: smokeTaskFile
  }),
  AutomationSafetyGateError,
  "starting automation should reject smoke task-file URLs before browser launch"
)

const missingTaskFileReadiness = getAutomationModeReadiness("dry-run", {
  taskFile: path.join(testDir, "missing-task-file.json")
})
assert.equal(missingTaskFileReadiness.ready, false, "automation readiness should block missing task files")
assert.match(missingTaskFileReadiness.reason, /task file does not exist/i)
assert.throws(
  () => startDianxiaomiDryRun({
    taskFile: path.join(testDir, "missing-task-file.json")
  }),
  AutomationSafetyGateError,
  "starting automation should reject missing task files before browser launch"
)

const smokeWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-smoke-url-work-item",
  pageUrl: "https://www.dianxiaomi.com/product/edit/work-smoke#rescan",
  pageTitle: "Smoke page",
  title: "Smoke URL work item should be blocked",
  rawTextSample: "complete smoke listing with SKU and image signals",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color"],
    mediaToolSignals: ["image translation"]
  },
  status: "ready-for-automation"
})
assert.equal(smokeWorkItem.status, "blocked", "saving a smoke URL work item should force blocked status in production mode")
assert(
  smokeWorkItem.suggestedEdits.some((edit) => edit.id === "edit-page-url-real-dianxiaomi"),
  "blocked smoke URL work items should explain the real Dianxiaomi URL requirement"
)
const dataFixtureHashWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-data-fixture-hash-work-item",
  pageUrl: "data:text/html,<main>fixture</main>#one",
  pageTitle: "Fixture hash one",
  title: "Fixture hash one",
  rawTextSample: "fixture hash one",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 0,
    skuCount: 0,
    priceFieldCount: 0,
    stockFieldCount: 0,
    attributeKeys: []
  },
  status: "ready-for-automation"
})
const dataFixtureHashWorkItemTwo = saveDianxiaomiProductWorkItem({
  id: "unit-data-fixture-hash-work-item-two",
  pageUrl: "data:text/html,<main>fixture</main>#two",
  pageTitle: "Fixture hash two",
  title: "Fixture hash two",
  rawTextSample: "fixture hash two",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 0,
    skuCount: 0,
    priceFieldCount: 0,
    stockFieldCount: 0,
    attributeKeys: []
  },
  status: "ready-for-automation"
})
assert.notEqual(dataFixtureHashWorkItemTwo.id, dataFixtureHashWorkItem.id, "data fixture URLs with different hashes should stay distinct for smoke recovery scenarios")
updateDianxiaomiProductWorkItemStatus(dataFixtureHashWorkItem.id, "edited", "data fixture hash one fixture complete")
updateDianxiaomiProductWorkItemStatus(dataFixtureHashWorkItemTwo.id, "edited", "data fixture hash two fixture complete")
const linkedCollectedProduct = saveDianxiaomiCollectedProduct({
  id: "unit-linked-collected-product",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-linked-collected-product",
  pageTitle: "Linked collected product",
  title: "Linked collected product title",
  category: "Linked collected category",
  sourceUrl: "https://www.dianxiaomi.com/product/edit/unit-linked-collected-product",
  images: ["https://example.com/linked-collected.jpg"],
  attributes: {
    color: "black"
  },
  skus: [{
    skuName: "Black M",
    priceCny: 16.8,
    stock: 9,
    attributes: {
      size: "M"
    },
    rowText: "Black M 16.8 9"
  }],
  rawTextSample: "linked collected product raw text",
  notes: ["unit"]
})
saveDianxiaomiPageContext({
  storeName: "Mergeable Store",
  pageUrl: "https://www.dianxiaomi.com/web/popTemu/pageList/draft",
  availableStores: [
    {
      storeName: "Mergeable Store"
    },
    {
      storeId: "unit-mergeable-store-id",
      storeName: "Mergeable Store"
    },
    {
      storeId: "unit-duplicate-store-a",
      storeName: "Duplicate Store"
    },
    {
      storeId: "unit-duplicate-store-b",
      storeName: "Duplicate Store"
    }
  ]
})
saveDianxiaomiProductWorkItem({
  id: "unit-store-metrics-primary-store",
  storeId: "unit-mergeable-store-id",
  storeName: "Mergeable Store",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-store-metrics-primary-store",
  pageTitle: "Primary store scoped item",
  title: "Primary store scoped item",
  rawTextSample: "primary store scoped item",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 1,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: []
  },
  status: "ready-for-automation"
})
saveDianxiaomiCollectedProduct({
  id: "unit-store-metrics-name-only-store",
  storeName: "Mergeable Store",
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-store-metrics-name-only-store",
  pageTitle: "Name only store collected product",
  title: "Name only store collected product",
  category: "unit",
  sourceUrl: "https://example.com/unit-store-metrics-name-only-store",
  images: ["https://example.com/unit-store-metrics-name-only-store.jpg"],
  attributes: {},
  skus: [{
    skuName: "Default",
    priceCny: 10,
    stock: 5,
    attributes: {},
    rowText: "Default 10 5"
  }],
  rawTextSample: "name only store collected product",
  notes: []
})
const storeMetricsById = new Map(
  listDianxiaomiStoreMetrics().map((item) => [`${item.storeId ?? ""}|${item.storeName ?? ""}`, item] as const)
)
assert.equal(storeMetricsById.get("unit-mergeable-store-id|Mergeable Store")?.collectedCount, 1, "name-only entries should merge into the unique matching store id")
assert.equal(storeMetricsById.get("unit-mergeable-store-id|Mergeable Store")?.workItemCount, 1, "id-backed work-item metrics should stay attached to the same store id")
assert.equal(storeMetricsById.get("unit-duplicate-store-a|Duplicate Store")?.workItemCount, 0, "same-name stores with different ids should stay distinct")
assert.equal(storeMetricsById.get("unit-duplicate-store-b|Duplicate Store")?.workItemCount, 0, "all duplicate id-backed stores should remain visible")
assert(!storeMetricsById.has("|Mergeable Store"), "name-only fallback store should disappear when exactly one matching id exists in current data")
assert(getDianxiaomiPageContext()?.availableStores?.some((item) => item.storeId === "unit-mergeable-store-id" && item.storeName === "Mergeable Store"), "page context should retain the unique id-backed store option")
assert(getDianxiaomiPageContext()?.availableStores?.some((item) => item.storeId === "unit-duplicate-store-a" && item.storeName === "Duplicate Store"), "page context should retain the first duplicate-name store id")
assert(getDianxiaomiPageContext()?.availableStores?.some((item) => item.storeId === "unit-duplicate-store-b" && item.storeName === "Duplicate Store"), "page context should retain the second duplicate-name store id")
const linkedWorkItem = saveDianxiaomiProductWorkItem({
  id: "unit-linked-collected-work-item",
  collectedProductId: linkedCollectedProduct.id,
  pageUrl: "https://www.dianxiaomi.com/product/edit/unit-linked-collected-work-item",
  pageTitle: "Linked work item page",
  title: "Linked work item title",
  rawTextSample: "linked work item raw text",
  notes: [],
  snapshot: {
    hasTitle: true,
    imageCount: 2,
    skuCount: 1,
    priceFieldCount: 1,
    stockFieldCount: 1,
    attributeKeys: ["color", "size"],
    mediaToolSignals: ["image translation"]
  },
  status: "ready-for-automation"
})
const linkedTaskResult = createTaskFromDianxiaomiProductWorkItem(linkedWorkItem.id)
assert(linkedTaskResult, "linked collected product work item should create a task")
assert.equal(linkedTaskResult.task.product.title, linkedCollectedProduct.title, "linked collected product should override placeholder work item title")
assert.equal(linkedTaskResult.task.product.sourceUrl, linkedWorkItem.pageUrl, "linked collected product tasks should still target the latest Dianxiaomi work item URL")
assert.deepEqual(linkedTaskResult.task.product.images, linkedCollectedProduct.images, "linked collected product images should carry into the generated task")
assert.equal(linkedTaskResult.task.product.skus[0]?.costCny, 16.8, "linked collected product SKU price should carry into the generated task product")
assert.equal(linkedTaskResult.task.draft.attributes.color, "black", "linked collected product attributes should carry into the generated draft")
assert.equal(linkedTaskResult.task.draft.attributes.dianxiaomiWorkItemId, linkedWorkItem.id, "generated task draft should retain work item linkage metadata")
const importedLinkedCollectedTask = createTaskFromDianxiaomiCollectedProduct(linkedCollectedProduct.id)
assert(importedLinkedCollectedTask, "linked collected product should still import directly")
assert.equal(importedLinkedCollectedTask.task.product.title, linkedCollectedProduct.title, "direct collected product import should preserve title")
const smokeTaskResult = createTaskFromDianxiaomiProductWorkItem(smokeWorkItem.id)
assert(smokeTaskResult, "smoke work item task should be created for export status regression")
const exportedSmokeTask = exportTaskFile(smokeTaskResult.task.id, path.join(testDir, "exported-smoke-task-file.json"))
assert(exportedSmokeTask, "smoke task export should be created")
assert.equal(exportedSmokeTask.launchStatus.status, "blocked", "exported smoke task files should carry blocked launch status")
assert.match(exportedSmokeTask.launchStatus.reason, /not a real Dianxiaomi product edit URL/i)
const listedSmokeTaskExport = listTaskFileExports(20).find((item) => item.exportId === exportedSmokeTask.exportId)
assert(listedSmokeTaskExport, "task export history should include exported smoke task")
assert.equal(listedSmokeTaskExport.launchStatus.status, "blocked", "task export history should expose launch status")

console.log("automation runner mode safety tests passed")
