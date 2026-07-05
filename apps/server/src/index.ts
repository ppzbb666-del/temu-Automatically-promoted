// 最先执行：加载 .env（必须在下面读取 env 的模块 import 之前）。
import "./load-env.ts"
import cors from "@fastify/cors"
import multipart from "@fastify/multipart"
import Fastify from "fastify"
import { z } from "zod"
import {
  CSV_IMPORT_TEMPLATE,
  createManualProductTask,
  createTaskFromDianxiaomiCollectedProduct,
  createTaskFromDianxiaomiProductWorkItem,
  exportDianxiaomiRepairPreview,
  exportTaskFile,
  generateSelectorConfigFromLatestDiagnosis,
  getSelectorConfigDiff,
  getActiveTask,
  getDianxiaomiRequirementRules,
  getPricingRules,
  getSelectorConfigStatus,
  getSelectorConfigVersions,
  getSelectorConfigVersionDiff,
  getSelectorWorkbench,
  getTaskFileExportDiff,
  validateSelectorConfig,
  getTaskById,
  getPublishCheck,
  getPublishChecks,
  importCsvProducts,
  importExcelProducts,
  listDianxiaomiCollectedProducts,
  getDianxiaomiPageContext,
  listDianxiaomiStoreMetrics,
  listDianxiaomiProductWorkItems,
  listAutomationReports,
  listDebugSnapshots,
  listSelectorDiagnosisReports,
  listTaskFileExports,
  listTasks,
  planTaskForProduct,
  restoreLatestAiDraftVersions,
  restoreTaskDraftVersion,
  reviewTask,
  reviewTasks,
  requeueDianxiaomiProductWorkItemAfterFix,
  restoreSelectorConfigVersion,
  saveDebugSnapshot,
  saveDianxiaomiCollectedProduct,
  saveDianxiaomiPageContext,
  saveDianxiaomiProductWorkItem,
  saveSelectorConfig,
  SelectorConfigChangeRiskError,
  setActiveTask,
  updateDianxiaomiRequirementRules,
  updatePricingRules,
  updateTaskDraft,
  updateTaskProduct
} from "./planner"
import {
  AutomationSafetyGateError,
  archiveStaleProfileLocks,
  getDianxiaomiQueueDaemonHealth,
  getDianxiaomiQueueDaemonState,
  getDianxiaomiDryRunJob,
  getDianxiaomiDryRunJobLog,
  getDianxiaomiFillDraftJob,
  getDianxiaomiFillDraftJobLog,
  getDianxiaomiFullFlowJob,
  getAutomationModeReadiness,
  getDianxiaomiRepairApplyJob,
  getDianxiaomiRepairApplyJobLog,
  getDianxiaomiRepairPreviewJob,
  getDianxiaomiRepairPreviewJobLog,
  getDianxiaomiRecoveryRun,
  getDianxiaomiSaveDraftJob,
  getDianxiaomiSaveDraftJobLog,
  getDianxiaomiSubmitListingJob,
  getDianxiaomiSubmitListingJobLog,
  getDianxiaomiUnattendedStartupCheck,
  getProfileLockArchiveReadiness,
  listDianxiaomiQueueRuns,
  listDianxiaomiDryRunJobs,
  listDianxiaomiFillDraftJobs,
  listDianxiaomiFullFlowJobs,
  listManualBudgetProofRecords,
  listManualBudgetTrials,
  listDianxiaomiRepairApplyJobs,
  listDianxiaomiRepairPreviewJobs,
  listDianxiaomiRecoveryRuns,
  listDianxiaomiSaveDraftJobs,
  listDianxiaomiSubmitListingJobs,
  recordManualBudgetProof,
  startManualBudgetTrial,
  startNextManualBudgetValidationRun,
  startDianxiaomiDryRun,
  startDianxiaomiFillDraft,
  startDianxiaomiFullFlow,
  startDianxiaomiQueueDaemon,
  startDianxiaomiQueueRun,
  startDianxiaomiRecoveryRun,
  startDianxiaomiRepairApply,
  startDianxiaomiRepairApplyForWorkItem,
  startDianxiaomiRepairPreview,
  startDianxiaomiRepairPreviewForWorkItem,
  startDianxiaomiSaveDraft,
  startDianxiaomiSubmitListing,
  pauseDianxiaomiQueueDaemon,
  restoreDianxiaomiQueueDaemon,
  tickDianxiaomiQueueDaemon,
  // P1-7: alert webhook config
  getAlertWebhookConfig,
  setAlertWebhookConfig
} from "./automation-runner"
import { getAutomationPreflight } from "./automation-preflight"
import {
  createAutomationLaunchPreset,
  deleteAutomationLaunchPreset,
  listAutomationLaunchPresets,
  updateAutomationLaunchPreset
} from "./automation-presets"
import {
  getDianxiaomiAccountScanJob,
  getDianxiaomiAccountScanJobLog,
  listDianxiaomiAccountScanLinks,
  listDianxiaomiAccountScanJobs,
  startDianxiaomiAccountScan
} from "./dianxiaomi-account-scan-runner"
import {
  getDianxiaomiImageCheckJob,
  getDianxiaomiImageCheckJobLog,
  listDianxiaomiImageCheckJobs,
  startDianxiaomiImageCheck
} from "./dianxiaomi-image-check-runner"
import {
  getSelectorCalibrationJob,
  getSelectorCalibrationJobLog,
  listSelectorCalibrationJobs,
  startSelectorCalibration
} from "./selector-calibration-runner"

const app = Fastify({
  logger: true
})

await app.register(cors, {
  origin: true
})

await app.register(multipart, {
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  }
})

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof AutomationSafetyGateError) {
    reply.code(error.statusCode).send({
      message: error.message
    })
    return
  }

  if (error instanceof SelectorConfigChangeRiskError) {
    reply.code(error.statusCode).send({
      message: error.message,
      diff: error.diff
    })
    return
  }

  reply.send(error)
})

const skuInputSchema = z.object({
  skuId: z.string().optional(),
  skuName: z.string().min(1),
  costCny: z.number().nonnegative(),
  stock: z.number().int().nonnegative(),
  attributes: z.record(z.string()).optional()
})

const logisticsRateTierSchema = z.object({
  minWeightKg: z.number().nonnegative(),
  maxWeightKg: z.number().positive().optional(),
  baseFeeUsd: z.number().nonnegative(),
  usdPerKg: z.number().nonnegative()
})

const dianxiaomiRequirementRulesSchema = z.object({
  presetName: z.string().min(1),
  title: z.object({
    required: z.boolean(),
    minLength: z.number().int().nonnegative(),
    maxLength: z.number().int().positive()
  }),
  images: z.object({
    required: z.boolean(),
    minCount: z.number().int().nonnegative()
  }),
  media: z.object({
    required: z.boolean(),
    requireImageTranslation: z.boolean(),
    requireWhiteBackground: z.boolean(),
    requireSizeNormalization: z.boolean(),
    requireImageEditorReview: z.boolean(),
    targetLanguage: z.string(),
    minWidthPx: z.number().int().nonnegative(),
    minHeightPx: z.number().int().nonnegative(),
    maxWidthPx: z.number().int().positive(),
    maxHeightPx: z.number().int().positive(),
    maxSizeMb: z.number().nonnegative(),
    dianxiaomiTools: z.array(z.string())
  }),
  sku: z.object({
    required: z.boolean(),
    minCount: z.number().int().nonnegative()
  }),
  price: z.object({
    required: z.boolean(),
    minEditableFieldCount: z.number().int().nonnegative()
  }),
  stock: z.object({
    required: z.boolean(),
    minEditableFieldCount: z.number().int().nonnegative()
  }),
  attributes: z.object({
    required: z.boolean(),
    minCount: z.number().int().nonnegative(),
    recommendedKeys: z.array(z.string())
  }),
  compliance: z.object({
    required: z.boolean(),
    blockedTerms: z.array(z.string())
  })
})

const draftSkuPricingSchema = z.object({
  skuId: z.string(),
  skuName: z.string().optional(),
  salePriceUsd: z.number().nonnegative().optional(),
  stock: z.number().int().nonnegative().optional(),
  attributes: z.record(z.string()).optional(),
  attributeSummary: z.string().optional()
})

const productInputShape = {
  title: z.string().min(1),
  category: z.string().min(1),
  supplierPriceCny: z.number().nonnegative(),
  estimatedDomesticShippingCny: z.number().nonnegative().default(0),
  estimatedWeightKg: z.number().nonnegative().default(0.2),
  stock: z.number().int().nonnegative().default(0),
  skuName: z.string().optional(),
  skus: z.array(skuInputSchema).optional(),
  sourceUrl: z.string().optional(),
  attributes: z.record(z.string()).optional(),
  images: z.array(z.string()).optional()
}

const automationSourceBucketSchema = z.enum(["collection-box", "pending-publish", "listing-draft"])

const automationDryRunSchema = z.object({
  url: z.string().optional(),
  taskFile: z.string().optional(),
  repairPlanFile: z.string().optional(),
  storeId: z.string().optional(),
  storeName: z.string().optional(),
  itemUrls: z.array(z.string()).optional(),
  sourceBuckets: z.array(automationSourceBucketSchema).optional(),
  headed: z.boolean().optional(),
  profile: z.string().optional(),
  screenshots: z.string().optional(),
  selectorConfig: z.string().optional(),
  mediaAutomationMode: z.enum(["plan-only", "unattended-open", "unattended-apply"]).optional(),
  mediaAutomationTools: z.array(z.string()).optional(),
  submitAfterSave: z.boolean().optional(),
  submitMaxAttempts: z.number().int().positive().max(10).optional()
})

const automationQueueRunSchema = automationDryRunSchema.extend({
  limit: z.number().int().positive().max(20).optional()
})

const automationRecoveryRunSchema = automationQueueRunSchema.extend({
  workItemIds: z.array(z.string()).optional()
})

const automationQueueDaemonSchema = automationQueueRunSchema.extend({
  intervalSeconds: z.number().int().positive().min(15).max(24 * 60 * 60).optional(),
  maxConsecutiveFailures: z.number().int().positive().max(100).optional()
})

const manualBudgetProofMetricSchema = z.object({
  productCount: z.number().int().positive(),
  operatorClicks: z.number().nonnegative(),
  operatorDecisions: z.number().nonnegative()
})

const manualBudgetProofAutomationMeasurementSchema = z.object({
  source: z.literal("automation-reports"),
  browserClicks: z.number().nonnegative(),
  browserActions: z.number().nonnegative(),
  reportCount: z.number().int().nonnegative(),
  reportIds: z.array(z.string()),
  reportPaths: z.array(z.string())
})

const manualBudgetProofSchema = z.object({
  candidateKey: z.string().trim().min(1),
  source: z.enum(["publish-outcome", "repair-plan", "failure-diagnosis"]),
  reason: z.string().trim().min(1),
  replacementPlan: z.string().trim().min(1),
  baseline: manualBudgetProofMetricSchema,
  trial: manualBudgetProofMetricSchema.extend({
    status: z.enum(["passed", "failed"])
  }),
  evidence: z.string().trim().min(1),
  automationMeasurement: manualBudgetProofAutomationMeasurementSchema.optional(),
  recordedBy: z.string().trim().min(1).optional()
})

const manualBudgetTrialSchema = automationDryRunSchema.extend({
  candidateKey: z.string().trim().min(1),
  rollbackAcknowledged: z.boolean(),
  acceptedRollbackCriteria: z.array(z.string().trim().min(1))
})

const queryBooleanSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value
  }

  const normalized = value.trim().toLowerCase()
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false
  }
  return value
}, z.boolean())

const queryStringArraySchema = z.array(z.string()).or(z.string()).optional().transform((value) =>
  Array.isArray(value) ? value : value ? [value] : undefined
)

const automationReadinessSchema = z.object({
  url: z.string().optional(),
  taskFile: z.string().optional(),
  repairPlanFile: z.string().optional(),
  storeId: z.string().optional(),
  storeName: z.string().optional(),
  itemUrls: queryStringArraySchema,
  sourceBuckets: queryStringArraySchema.transform((value) =>
    value?.filter((item): item is z.infer<typeof automationSourceBucketSchema> =>
      ["collection-box", "pending-publish", "listing-draft"].includes(item)
    )
  ),
  profile: z.string().optional(),
  screenshots: z.string().optional(),
  selectorConfig: z.string().optional(),
  mediaAutomationMode: z.enum(["plan-only", "unattended-open", "unattended-apply"]).optional(),
  submitAfterSave: queryBooleanSchema.optional(),
  submitMaxAttempts: z.coerce.number().int().positive().max(10).optional(),
  mediaAutomationTools: queryStringArraySchema
})

const automationPresetInputSchema = z.object({
  name: z.string().min(1),
  input: automationDryRunSchema
})

const automationPresetUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  input: automationDryRunSchema.optional()
})

const automationTaskFileExportSchema = z.object({
  outputPath: z.string().optional()
})

const dianxiaomiCollectedProductSchema = z.object({
  id: z.string().optional(),
  storeId: z.string().optional(),
  storeName: z.string().optional(),
  sourceBucket: automationSourceBucketSchema.optional(),
  pageUrl: z.string(),
  pageTitle: z.string(),
  collectedAt: z.string().optional(),
  quality: z.object({
    status: z.enum(["ready", "partial", "poor"]),
    score: z.number().min(0).max(100),
    checks: z.array(
      z.object({
        id: z.string(),
        ok: z.boolean(),
        message: z.string()
      })
    )
  }).optional(),
  title: z.string().default(""),
  category: z.string().default("Dianxiaomi collected"),
  sourceUrl: z.string().optional(),
  images: z.array(z.string()).default([]),
  attributes: z.record(z.string()).default({}),
  skus: z.array(
    z.object({
      skuName: z.string().default(""),
      priceCny: z.number().optional(),
      stock: z.number().int().nonnegative().optional(),
      attributes: z.record(z.string()).default({}),
      rowText: z.string().default("")
    })
  ).default([]),
  rawTextSample: z.string().default(""),
  notes: z.array(z.string()).default([])
})

const dianxiaomiProductWorkItemSchema = z.object({
  id: z.string().optional(),
  source: z.literal("dianxiaomi").optional(),
  storeId: z.string().optional(),
  storeName: z.string().optional(),
  sourceBucket: automationSourceBucketSchema.optional(),
  collectedProductId: z.string().optional(),
  pageUrl: z.string(),
  pageTitle: z.string(),
  pageProfile: z.string().optional(),
  categoryHint: z.object({
    label: z.string().optional(),
    categoryId: z.string().optional(),
    fullCid: z.string().optional(),
    source: z.enum(["account-scan", "collected-product", "manual"]).optional()
  }).optional(),
  title: z.string().default(""),
  queuedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  rawTextSample: z.string().default(""),
  notes: z.array(z.string()).default([]),
  snapshot: z.object({
    hasTitle: z.boolean().default(false),
    imageCount: z.number().int().nonnegative().default(0),
    skuCount: z.number().int().nonnegative().default(0),
    priceFieldCount: z.number().int().nonnegative().default(0),
    stockFieldCount: z.number().int().nonnegative().default(0),
    attributeKeys: z.array(z.string()).default([]),
    imageStats: z.object({
      minWidthPx: z.number().int().nonnegative(),
      minHeightPx: z.number().int().nonnegative(),
      maxWidthPx: z.number().int().nonnegative(),
      maxHeightPx: z.number().int().nonnegative(),
      unknownDimensionCount: z.number().int().nonnegative(),
      minAspectRatio: z.number().nonnegative().optional(),
      maxAspectRatio: z.number().nonnegative().optional()
    }).optional(),
    imageCheck: z.object({
      passed: z.boolean()
    }).optional(),
    mediaToolSignals: z.array(z.string()).default([]),
    targetLanguage: z.string().optional()
  }),
  status: z.enum(["needs-revision", "ready-for-automation", "blocked", "edited"]).optional(),
  requirements: z.object({
    presetName: z.string(),
    checkedAt: z.string(),
    checks: z.array(z.object({
      id: z.string(),
      level: z.enum(["required", "recommended"]),
      ok: z.boolean(),
      message: z.string(),
      recommendation: z.string().optional()
    })),
    summary: z.object({
      requiredTotal: z.number().int().nonnegative(),
      requiredPassed: z.number().int().nonnegative(),
      recommendedTotal: z.number().int().nonnegative(),
      recommendedPassed: z.number().int().nonnegative(),
      ready: z.boolean()
    })
  }).optional(),
  suggestedEdits: z.array(z.object({
    id: z.string(),
    field: z.enum(["title", "description", "image", "sku", "price", "stock", "attribute", "compliance"]),
    priority: z.enum(["required", "recommended"]),
    reason: z.string(),
    currentValue: z.string().optional(),
    suggestedValue: z.string().optional()
  })).optional(),
  failureDiagnosis: z.object({
    category: z.enum([
      "login-or-captcha",
      "real-page-calibration",
      "selector-config",
      "media-processing",
      "publish-validation",
      "target-surface",
      "task-file",
      "browser-profile",
      "sku-count-over-cap",
      "broken-source-images",
      "unknown"
    ]),
    retryable: z.boolean(),
    autoRetryRecommended: z.boolean(),
    message: z.string(),
    nextAction: z.string(),
    source: z.enum(["queue-daemon", "full-flow", "work-item-validation"]),
    updatedAt: z.string()
  }).nullable().optional(),
  repairPlan: z.object({
    status: z.enum(["auto-ready", "assisted", "manual", "blocked"]),
    source: z.enum(["requirements", "failure-diagnosis", "combined"]),
    summary: z.string(),
    canAutoRepair: z.boolean(),
    canRetryAfterRepair: z.boolean(),
    blockers: z.array(z.string()),
    actions: z.array(z.object({
      id: z.string(),
      type: z.enum([
        "apply-media-tool",
        "retry-transient",
        "refresh-task-file",
        "fix-field",
        "review-image",
        "clear-browser-profile",
        "manual-session",
        "recalibrate-selectors",
        "replace-target-url",
        "inspect-logs"
      ]),
      label: z.string(),
      detail: z.string(),
      automation: z.enum(["auto", "assisted", "manual"]),
      required: z.boolean(),
      field: z.enum(["title", "description", "image", "sku", "price", "stock", "attribute", "compliance"]).optional(),
      target: z.string().optional(),
      tool: z.string().optional(),
      payload: z.object({
        writer: z.enum([
          "fill-single-field",
          "fill-attributes",
          "fill-sku-pricing",
          "run-media-tool",
          "refresh-task-file",
          "clear-browser-profile",
          "manual"
        ]),
        selectorGroup: z.enum(["fields", "skuRows", "mediaTools", "mediaToolActions", "buttons"]).optional(),
        selectorKey: z.string().optional(),
        fieldKind: z.enum(["title", "description", "price", "stock", "attribute"]).optional(),
        attributeKey: z.string().optional(),
        skuMode: z.enum(["price-stock", "variation"]).optional(),
        mediaTool: z.enum(["imageTranslation", "whiteBackground", "imageEditor", "batchResize", "imageManagement"]).optional(),
        expectedValue: z.string().optional(),
        reasonCode: z.string().optional()
      }).optional()
    })),
    createdAt: z.string()
  }).nullable().optional()
})

const dianxiaomiPageContextSchema = z.object({
  storeId: z.string().optional(),
  storeName: z.string().optional(),
  availableStores: z.array(z.object({
    storeId: z.string().optional(),
    storeName: z.string().min(1)
  })).optional(),
  siteName: z.string().optional(),
  pageUrl: z.string().min(1),
  pageTitle: z.string().optional(),
  pageProfile: z.string().optional(),
  updatedAt: z.string().optional()
})

const selectorConfigValidationSchema = z.object({
  selectorConfig: z.string().optional()
})

const selectorCalibrationSchema = z.object({
  url: z.string().optional(),
  headed: z.boolean().optional(),
  profile: z.string().optional(),
  screenshots: z.string().optional(),
  sampleMediaActions: z.boolean().optional(),
  mediaAutomationTools: z.array(z.string()).optional()
})

const dianxiaomiAccountScanSchema = z.object({
  headed: z.boolean().optional(),
  profile: z.string().optional(),
  screenshots: z.string().optional(),
  sourceBuckets: z.array(automationSourceBucketSchema).optional(),
  maxPages: z.number().int().positive().max(100).optional(),
  storeId: z.string().optional(),
  storeName: z.string().optional()
})

const dianxiaomiImageCheckSchema = z.object({
  workItemId: z.string().optional(),
  url: z.string().optional(),
  headed: z.boolean().optional(),
  profile: z.string().optional(),
  screenshots: z.string().optional()
})

const dianxiaomiAccountScanImportSchema = z.object({
  linkIds: z.array(z.string()).optional(),
  editUrls: z.array(z.string()).optional(),
  storeId: z.string().optional(),
  storeName: z.string().optional(),
  sourceBuckets: z.array(automationSourceBucketSchema).optional()
}).refine((value) =>
  (value.linkIds?.length ?? 0) > 0
  || (value.editUrls?.length ?? 0) > 0
  || Boolean(value.storeId?.trim())
  || Boolean(value.storeName?.trim())
  || (value.sourceBuckets?.length ?? 0) > 0,
{
  message: "at least one link id, edit url, store, or source bucket is required"
})

const selectorConfigSchema = z.object({
  fields: z.record(z.array(z.string())),
  buttons: z.record(z.array(z.string())),
  mediaTools: z.record(z.array(z.string())).optional(),
  mediaToolActions: z.record(z.record(z.array(z.string()))).optional(),
  skuRows: z.array(z.string())
})

const selectorConfigSaveSchema = z.object({
  config: selectorConfigSchema,
  note: z.string().optional(),
  confirmDangerousChanges: z.boolean().optional()
})

const selectorConfigRestoreSchema = z.object({
  confirmDangerousChanges: z.boolean().optional()
})

app.get("/health", async () => ({
  ok: true,
  service: "temu-ai-ops-server"
}))

app.get("/tasks", async () => listTasks())

app.get("/tasks/active", async (request, reply) => {
  const query = z.object({
    requireApproved: z.coerce.boolean().default(false)
  }).parse(request.query)
  const task = getActiveTask({
    requireApproved: query.requireApproved
  })

  if (!task && query.requireApproved) {
    reply.code(409)
    return {
      message: "当前任务尚未审核通过，禁止进入店小秘同步"
    }
  }

  return task
})

app.get("/debug-snapshots", async () => listDebugSnapshots())

app.get("/automation-reports", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listAutomationReports(query.limit)
})

app.get("/automation/task-file-exports", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listTaskFileExports(query.limit)
})

app.get("/automation/task-file-exports/:exportId/diff", async (request, reply) => {
  const params = z.object({
    exportId: z.string()
  }).parse(request.params)
  const result = getTaskFileExportDiff(params.exportId)

  if (!result) {
    reply.code(404)
    return {
      message: "automation task file export snapshot not found"
    }
  }

  return result
})

app.get("/automation/readiness", async (request) => {
  const query = automationReadinessSchema.parse(request.query ?? {})
  return {
    dryRun: getAutomationModeReadiness("dry-run", query),
    repairPreview: getAutomationModeReadiness("repair-preview", query),
    repairApply: getAutomationModeReadiness("repair-apply", query),
    fillDraft: getAutomationModeReadiness("fill-draft", query),
    saveDraft: getAutomationModeReadiness("save-draft", query),
    submitListing: getAutomationModeReadiness("submit-listing", query)
  }
})

app.get("/automation/preflight", async (request) => {
  const query = automationReadinessSchema.parse(request.query ?? {})
  return getAutomationPreflight(query)
})

app.get("/automation/presets", async () => listAutomationLaunchPresets())

app.post("/automation/presets", async (request) => {
  const body = automationPresetInputSchema.parse(request.body)
  return createAutomationLaunchPreset(body as any)
})

app.put("/automation/presets/:id", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const body = automationPresetUpdateSchema.parse(request.body)
  const result = updateAutomationLaunchPreset(params.id, body)

  if (!result) {
    reply.code(404)
    return {
      message: "automation launch preset not found"
    }
  }

  return result
})

app.delete("/automation/presets/:id", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const result = deleteAutomationLaunchPreset(params.id)

  if (!result) {
    reply.code(404)
    return {
      message: "automation launch preset not found"
    }
  }

  return result
})

app.post("/automation/dry-run", async (request) => {
  const body = automationDryRunSchema.default({}).parse(request.body ?? {})
  return startDianxiaomiDryRun(body)
})

app.get("/automation/dry-run/jobs", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listDianxiaomiDryRunJobs(query.limit)
})

app.get("/automation/dry-run/jobs/:id", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const job = getDianxiaomiDryRunJob(params.id)

  if (!job) {
    reply.code(404)
    return {
      message: "automation dry-run job not found"
    }
  }

  return job
})

app.get("/automation/dry-run/jobs/:id/logs", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const query = z.object({
    maxChars: z.coerce.number().int().positive().max(20000).default(4000)
  }).parse(request.query)
  const log = getDianxiaomiDryRunJobLog(params.id, query.maxChars)

  if (!log) {
    reply.code(404)
    return {
      message: "automation dry-run job log not found"
    }
  }

  return log
})

app.post("/automation/repair-preview", async (request) => {
  const body = automationDryRunSchema.default({}).parse(request.body ?? {})
  return startDianxiaomiRepairPreview(body)
})

app.post("/dianxiaomi/product-work-items/:id/repair-preview", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const body = automationDryRunSchema.default({}).parse(request.body ?? {})
  const result = startDianxiaomiRepairPreviewForWorkItem(params.id, body)

  if (!result) {
    reply.code(404)
    return {
      message: "dianxiaomi product work item repair preview could not be started"
    }
  }

  return result
})

app.post("/dianxiaomi/product-work-items/:id/repair-preview-export", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const result = exportDianxiaomiRepairPreview(params.id)

  if (!result) {
    reply.code(404)
    return {
      message: "dianxiaomi product work item repair preview could not be exported"
    }
  }

  return result
})

app.get("/automation/repair-preview/jobs", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listDianxiaomiRepairPreviewJobs(query.limit)
})

app.get("/automation/repair-preview/jobs/:id", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const job = getDianxiaomiRepairPreviewJob(params.id)

  if (!job) {
    reply.code(404)
    return {
      message: "automation repair-preview job not found"
    }
  }

  return job
})

app.get("/automation/repair-preview/jobs/:id/logs", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const query = z.object({
    maxChars: z.coerce.number().int().positive().max(20000).default(4000)
  }).parse(request.query)
  const log = getDianxiaomiRepairPreviewJobLog(params.id, query.maxChars)

  if (!log) {
    reply.code(404)
    return {
      message: "automation repair-preview job log not found"
    }
  }

  return log
})

app.post("/automation/repair-apply", async (request) => {
  const body = automationDryRunSchema.default({}).parse(request.body ?? {})
  return startDianxiaomiRepairApply(body)
})

app.post("/dianxiaomi/product-work-items/:id/repair-apply", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const body = automationDryRunSchema.default({}).parse(request.body ?? {})
  const result = startDianxiaomiRepairApplyForWorkItem(params.id, body)

  if (!result) {
    reply.code(404)
    return {
      message: "dianxiaomi product work item repair apply could not be started"
    }
  }

  return result
})

app.get("/automation/repair-apply/jobs", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listDianxiaomiRepairApplyJobs(query.limit)
})

app.get("/automation/repair-apply/jobs/:id", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const job = getDianxiaomiRepairApplyJob(params.id)

  if (!job) {
    reply.code(404)
    return {
      message: "automation repair-apply job not found"
    }
  }

  return job
})

app.get("/automation/repair-apply/jobs/:id/logs", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const query = z.object({
    maxChars: z.coerce.number().int().positive().max(20000).default(4000)
  }).parse(request.query)
  const log = getDianxiaomiRepairApplyJobLog(params.id, query.maxChars)

  if (!log) {
    reply.code(404)
    return {
      message: "automation repair-apply job log not found"
    }
  }

  return log
})

app.post("/automation/fill-draft", async (request) => {
  const body = automationDryRunSchema.default({}).parse(request.body ?? {})
  return startDianxiaomiFillDraft(body)
})

app.get("/automation/fill-draft/jobs", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listDianxiaomiFillDraftJobs(query.limit)
})

app.get("/automation/fill-draft/jobs/:id", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const job = getDianxiaomiFillDraftJob(params.id)

  if (!job) {
    reply.code(404)
    return {
      message: "automation fill-draft job not found"
    }
  }

  return job
})

app.get("/automation/fill-draft/jobs/:id/logs", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const query = z.object({
    maxChars: z.coerce.number().int().positive().max(20000).default(4000)
  }).parse(request.query)
  const log = getDianxiaomiFillDraftJobLog(params.id, query.maxChars)

  if (!log) {
    reply.code(404)
    return {
      message: "automation fill-draft job log not found"
    }
  }

  return log
})

app.post("/automation/save-draft", async (request) => {
  const body = automationDryRunSchema.default({}).parse(request.body ?? {})
  return startDianxiaomiSaveDraft(body)
})

app.post("/automation/submit-listing", async (request) => {
  const body = automationDryRunSchema.default({}).parse(request.body ?? {})
  return startDianxiaomiSubmitListing(body)
})

app.post("/automation/full-flow", async (request) => {
  const body = automationDryRunSchema.default({}).parse(request.body ?? {})
  return startDianxiaomiFullFlow(body)
})

app.post("/automation/queue-run", async (request) => {
  const body = automationQueueRunSchema.default({}).parse(request.body ?? {})
  return startDianxiaomiQueueRun(body)
})

app.get("/automation/queue-runs", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listDianxiaomiQueueRuns(query.limit)
})

app.post("/automation/recovery-run", async (request) => {
  const body = automationRecoveryRunSchema.default({}).parse(request.body ?? {})
  return startDianxiaomiRecoveryRun(body)
})

app.get("/automation/recovery-runs", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listDianxiaomiRecoveryRuns(query.limit)
})

app.get("/automation/recovery-runs/:id", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const run = getDianxiaomiRecoveryRun(params.id)

  if (!run) {
    reply.code(404)
    return {
      message: "automation recovery run not found"
    }
  }

  return run
})

app.get("/automation/queue-daemon", async () => getDianxiaomiQueueDaemonState())

app.get("/automation/queue-daemon/health", async (request) => {
  const query = automationReadinessSchema.parse(request.query ?? {})
  return getDianxiaomiQueueDaemonHealth(query)
})

// P1-7: alert webhook config. Empty url disables the webhook; any
// http(s):// endpoint gets a POST on every "block" audit decision.
app.get("/automation/alert-webhook", async () => getAlertWebhookConfig())
app.put("/automation/alert-webhook", async (request) => {
  const body = z.object({ url: z.string().optional() }).parse(request.body)
  return setAlertWebhookConfig(body)
})

app.get("/automation/profile-locks/archive-readiness", async (request) => {
  const query = automationReadinessSchema.parse(request.query)
  return getProfileLockArchiveReadiness(query)
})

app.post("/automation/profile-locks/archive", async (request) => {
  const body = automationQueueRunSchema.default({}).parse(request.body ?? {})
  return archiveStaleProfileLocks(body)
})

app.get("/automation/manual-budget/proofs", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listManualBudgetProofRecords(query.limit)
})

app.post("/automation/manual-budget/proofs", async (request) => {
  const body = manualBudgetProofSchema.parse(request.body)
  return recordManualBudgetProof(body)
})

app.get("/automation/manual-budget/trials", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listManualBudgetTrials(query.limit)
})

app.post("/automation/manual-budget/trials", async (request) => {
  const body = manualBudgetTrialSchema.parse(request.body)
  return startManualBudgetTrial(body)
})

app.post("/automation/manual-budget/validation-runs/next", async (request) => {
  const body = automationDryRunSchema.default({}).parse(request.body ?? {})
  return startNextManualBudgetValidationRun(body)
})

app.get("/automation/unattended-startup-check", async (request) => {
  const query = automationReadinessSchema.parse(request.query)
  return getDianxiaomiUnattendedStartupCheck(query)
})

app.post("/automation/queue-daemon/start", async (request) => {
  const body = automationQueueDaemonSchema.default({}).parse(request.body ?? {})
  return startDianxiaomiQueueDaemon(body)
})

app.post("/automation/queue-daemon/pause", async () => pauseDianxiaomiQueueDaemon())

app.post("/automation/queue-daemon/tick", async () => tickDianxiaomiQueueDaemon())

app.get("/automation/full-flow/jobs", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listDianxiaomiFullFlowJobs(query.limit)
})

app.get("/automation/full-flow/jobs/:id", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const job = getDianxiaomiFullFlowJob(params.id)

  if (!job) {
    reply.code(404)
    return {
      message: "automation full-flow job not found"
    }
  }

  return job
})

app.get("/automation/save-draft/jobs", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listDianxiaomiSaveDraftJobs(query.limit)
})

app.get("/automation/save-draft/jobs/:id", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const job = getDianxiaomiSaveDraftJob(params.id)

  if (!job) {
    reply.code(404)
    return {
      message: "automation save-draft job not found"
    }
  }

  return job
})

app.get("/automation/save-draft/jobs/:id/logs", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const query = z.object({
    maxChars: z.coerce.number().int().positive().max(20000).default(4000)
  }).parse(request.query)
  const log = getDianxiaomiSaveDraftJobLog(params.id, query.maxChars)

  if (!log) {
    reply.code(404)
    return {
      message: "automation save-draft job log not found"
    }
  }

  return log
})

app.get("/automation/submit-listing/jobs", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listDianxiaomiSubmitListingJobs(query.limit)
})

app.get("/automation/submit-listing/jobs/:id", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const job = getDianxiaomiSubmitListingJob(params.id)

  if (!job) {
    reply.code(404)
    return {
      message: "automation submit-listing job not found"
    }
  }

  return job
})

app.get("/automation/submit-listing/jobs/:id/logs", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const query = z.object({
    maxChars: z.coerce.number().int().positive().max(20000).default(4000)
  }).parse(request.query)
  const log = getDianxiaomiSubmitListingJobLog(params.id, query.maxChars)

  if (!log) {
    reply.code(404)
    return {
      message: "automation submit-listing job log not found"
    }
  }

  return log
})

app.get("/selector-diagnoses", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(50).default(10)
  }).parse(request.query)

  return listSelectorDiagnosisReports(query.limit)
})

app.get("/selector-workbench", async () => getSelectorWorkbench())

app.post("/selector-calibration", async (request) => {
  const body = selectorCalibrationSchema.default({}).parse(request.body ?? {})
  return startSelectorCalibration(body)
})

app.post("/dianxiaomi/account-scan", async (request) => {
  const body = dianxiaomiAccountScanSchema.default({}).parse(request.body ?? {})
  return startDianxiaomiAccountScan(body)
})

app.post("/dianxiaomi/image-check", async (request) => {
  const body = dianxiaomiImageCheckSchema.parse(request.body ?? {})
  return startDianxiaomiImageCheck(body)
})

app.get("/dianxiaomi/image-check/jobs", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listDianxiaomiImageCheckJobs(query.limit)
})

app.get("/dianxiaomi/image-check/jobs/:id", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const job = getDianxiaomiImageCheckJob(params.id)

  if (!job) {
    reply.code(404)
    return {
      message: "dianxiaomi image check job not found"
    }
  }

  return job
})

app.get("/dianxiaomi/image-check/jobs/:id/logs", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const query = z.object({
    maxChars: z.coerce.number().int().positive().max(20000).default(4000)
  }).parse(request.query)
  const log = getDianxiaomiImageCheckJobLog(params.id, query.maxChars)

  if (!log) {
    reply.code(404)
    return {
      message: "dianxiaomi image check job log not found"
    }
  }

  return log
})

app.get("/dianxiaomi/account-scan/jobs", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listDianxiaomiAccountScanJobs(query.limit)
})

app.get("/dianxiaomi/account-scan/jobs/:id", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const job = getDianxiaomiAccountScanJob(params.id)

  if (!job) {
    reply.code(404)
    return {
      message: "dianxiaomi account scan job not found"
    }
  }

  return job
})

app.get("/dianxiaomi/account-scan/jobs/:id/logs", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const query = z.object({
    maxChars: z.coerce.number().int().positive().max(20000).default(4000)
  }).parse(request.query)
  const log = getDianxiaomiAccountScanJobLog(params.id, query.maxChars)

  if (!log) {
    reply.code(404)
    return {
      message: "dianxiaomi account scan job log not found"
    }
  }

  return log
})

app.post("/dianxiaomi/account-scan/jobs/:id/import", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const body = dianxiaomiAccountScanImportSchema.parse(request.body ?? {})
  const job = getDianxiaomiAccountScanJob(params.id)

  if (!job) {
    reply.code(404)
    return {
      message: "dianxiaomi account scan job not found"
    }
  }

  if (!job.result) {
    reply.code(409)
    return {
      message: "dianxiaomi account scan result is not ready"
    }
  }

  const selectedLinkIds = new Set((body.linkIds ?? []).map((item) => item.trim()).filter(Boolean))
  const selectedEditUrls = new Set((body.editUrls ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean))
  const normalizedStoreId = body.storeId?.trim() || ""
  const normalizedStoreName = body.storeName?.trim() || ""
  const selectedSourceBuckets = new Set(body.sourceBuckets ?? [])
  const requested = selectedLinkIds.size
    + selectedEditUrls.size
    + (normalizedStoreId ? 1 : 0)
    + (normalizedStoreName ? 1 : 0)
    + selectedSourceBuckets.size
  const selectedLinks = listDianxiaomiAccountScanLinks(params.id).filter((link) => {
    const matchesExplicitSelection = selectedLinkIds.has(link.id) || selectedEditUrls.has(link.editUrl.trim().toLowerCase())
    if (matchesExplicitSelection) {
      return true
    }

    const matchesStoreId = normalizedStoreId ? (link.shopId?.trim() || "") === normalizedStoreId : true
    const matchesStoreName = normalizedStoreName ? link.storeName.trim() === normalizedStoreName : true
    const matchesSourceBucket = selectedSourceBuckets.size > 0 ? selectedSourceBuckets.has(link.sourceBucket) : true
    const hasScopedFilter = Boolean(normalizedStoreId || normalizedStoreName || selectedSourceBuckets.size > 0)

    return hasScopedFilter && matchesStoreId && matchesStoreName && matchesSourceBucket
  })
  const importedAt = new Date().toISOString()
  const importedWorkItemIds = new Set<string>()
  const skipped: Array<{ id: string; reason: string }> = []
  let readyCount = 0
  let needsRevisionCount = 0

  for (const link of selectedLinks) {
    const title = link.title?.trim() || link.storeName || "Dianxiaomi account scan"
    const workItem = saveDianxiaomiProductWorkItem({
      storeId: link.shopId?.trim() || undefined,
      storeName: link.storeName,
      sourceBucket: link.sourceBucket,
      pageUrl: link.editUrl,
      pageTitle: title,
      pageProfile: "Dianxiaomi account scan",
      categoryHint: {
        categoryId: link.categoryId?.trim() || undefined,
        fullCid: link.fullCid?.trim() || undefined,
        source: "account-scan"
      },
      title,
      rawTextSample: [link.title, link.siteLabel, link.sourcePlatform].filter(Boolean).join(" | "),
      notes: [
        `imported from account scan job ${params.id}`,
        `source bucket: ${link.sourceBucket}`,
        ...(link.sourceUrl ? [`source url: ${link.sourceUrl}`] : [])
      ],
      snapshot: {
        hasTitle: Boolean(title),
        imageCount: 1,
        skuCount: 1,
        priceFieldCount: 1,
        stockFieldCount: 1,
        attributeKeys: [],
        mediaToolSignals: [],
        targetLanguage: "en"
      }
    })

    importedWorkItemIds.add(workItem.id)
    if (workItem.status === "ready-for-automation") {
      readyCount += 1
    } else {
      needsRevisionCount += 1
      skipped.push({
        id: link.id,
        reason: `imported as ${workItem.status}`
      })
    }
  }

  for (const id of selectedLinkIds) {
    if (!selectedLinks.some((link) => link.id === id)) {
      skipped.push({
        id,
        reason: "link id not found in scan result"
      })
    }
  }

  for (const url of selectedEditUrls) {
    if (!selectedLinks.some((link) => link.editUrl.trim().toLowerCase() === url)) {
      skipped.push({
        id: url,
        reason: "edit url not found in scan result"
      })
    }
  }

  return {
    jobId: params.id,
    importedAt,
    requested,
    importedCount: importedWorkItemIds.size,
    readyCount,
    needsRevisionCount,
    importedWorkItemIds: Array.from(importedWorkItemIds),
    skipped
  }
})

app.get("/selector-calibration/jobs", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listSelectorCalibrationJobs(query.limit)
})

app.get("/selector-calibration/jobs/:id", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const job = getSelectorCalibrationJob(params.id)

  if (!job) {
    reply.code(404)
    return {
      message: "selector calibration job not found"
    }
  }

  return job
})

app.get("/selector-calibration/jobs/:id/logs", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const query = z.object({
    maxChars: z.coerce.number().int().positive().max(20000).default(4000)
  }).parse(request.query)
  const log = getSelectorCalibrationJobLog(params.id, query.maxChars)

  if (!log) {
    reply.code(404)
    return {
      message: "selector calibration job log not found"
    }
  }

  return log
})

app.get("/selector-config", async () => getSelectorConfigStatus())

app.put("/selector-config", async (request) => {
  const body = selectorConfigSaveSchema.parse(request.body)
  return saveSelectorConfig(body as any)
})

app.post("/selector-config/diff", async (request) => {
  const body = z.object({
    config: selectorConfigSchema
  }).parse(request.body)

  return getSelectorConfigDiff(body.config as any)
})

app.get("/selector-config/versions", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return getSelectorConfigVersions(query.limit)
})

app.get("/selector-config/versions/:id/diff", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const result = getSelectorConfigVersionDiff(params.id)

  if (!result) {
    reply.code(404)
    return {
      message: "selector config version not found"
    }
  }

  return result
})

app.post("/selector-config/versions/:id/restore", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const body = selectorConfigRestoreSchema.default({}).parse(request.body ?? {})
  const result = restoreSelectorConfigVersion(params.id, body)

  if (!result) {
    reply.code(404)
    return {
      message: "selector config version not found"
    }
  }

  return result
})

app.get("/selector-config/validation", async (request) => {
  const query = selectorConfigValidationSchema.parse(request.query ?? {})
  return validateSelectorConfig(query.selectorConfig)
})

app.post("/selector-config/generate", async (_request, reply) => {
  let result
  try {
    result = generateSelectorConfigFromLatestDiagnosis()
  } catch (error) {
    reply.code(409)
    return {
      message: error instanceof Error ? error.message : String(error)
    }
  }
  if (!result) {
    reply.code(404)
    return {
      message: "no selector diagnosis report found"
    }
  }

  return result
})

app.get("/pricing-rules", async () => getPricingRules())

app.put("/pricing-rules", async (request) => {
  const body = z.object({
    exchangeRateCnyPerUsd: z.number().positive(),
    logisticsUsdPerKg: z.number().nonnegative(),
    logisticsRateTiers: z.array(logisticsRateTierSchema).optional(),
    platformFeeUsd: z.number().nonnegative(),
    targetMarginRate: z.number().min(0).max(0.95),
    priceMultiplier: z.number().min(1),
    minimumMarginRate: z.number().min(0).max(0.95),
    minimumSuggestedPriceUsd: z.number().nonnegative()
  }).parse(request.body)

  return updatePricingRules(body as any)
})

app.get("/dianxiaomi/requirement-rules", async () => getDianxiaomiRequirementRules())

app.put("/dianxiaomi/requirement-rules", async (request) => {
  const body = dianxiaomiRequirementRulesSchema.parse(request.body)
  return updateDianxiaomiRequirementRules(body as any)
})

app.get("/imports/csv-template", async (_request, reply) => {
  reply
    .header("Content-Type", "text/csv; charset=utf-8")
    .header("Content-Disposition", "attachment; filename=\"temu-products-template.csv\"")
  return `\uFEFF${CSV_IMPORT_TEMPLATE}`
})

app.post("/tasks/active", async (request, reply) => {
  const body = z.object({
    taskId: z.string()
  }).parse(request.body)

  const result = setActiveTask(body.taskId)
  if (!result.task) {
    reply.code(result.error === "task not found" ? 404 : 409)
    return {
      message: "任务不存在"
    }
  }

  return result.task
})

app.post("/debug-snapshots", async (request) => {
  const body = z.object({
    id: z.string(),
    taskId: z.string().nullable(),
    taskTitle: z.string().nullable(),
    pageUrl: z.string(),
    pageTitle: z.string(),
    createdAt: z.string(),
    summary: z.object({
      titleFieldCount: z.number(),
      priceFieldCount: z.number(),
      stockFieldCount: z.number(),
      skuRowCount: z.number()
    }),
    fieldSnapshots: z.array(
      z.object({
        kind: z.enum(["title", "price", "stock", "attribute", "unknown"]),
        selectorHint: z.string(),
        labelText: z.string(),
        placeholder: z.string(),
        name: z.string(),
        tagName: z.string()
      })
    ),
    skuRows: z.array(
      z.object({
        rowText: z.string(),
        priceFieldCount: z.number(),
        stockFieldCount: z.number(),
        inputCount: z.number()
      })
    ),
    notes: z.array(z.string())
  }).parse(request.body)

  return saveDebugSnapshot(body as any)
})

app.get("/dianxiaomi/collected-products", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(100).default(20)
  }).parse(request.query)

  return listDianxiaomiCollectedProducts(query.limit)
})

app.get("/dianxiaomi/product-work-items", async (request) => {
  const query = z.object({
    limit: z.coerce.number().int().positive().max(1000).default(20),
    storeId: z.string().optional(),
    storeName: z.string().optional(),
    itemUrls: queryStringArraySchema,
    sourceBuckets: queryStringArraySchema.transform((value) =>
      value?.filter((item): item is z.infer<typeof automationSourceBucketSchema> =>
        ["collection-box", "pending-publish", "listing-draft"].includes(item)
      )
    )
  }).parse(request.query)

  return listDianxiaomiProductWorkItems(query.limit, query)
})

app.post("/dianxiaomi/product-work-items", async (request) => {
  const body = dianxiaomiProductWorkItemSchema.parse(request.body)
  return saveDianxiaomiProductWorkItem(body as any)
})

app.post("/dianxiaomi/product-work-items/:id/task", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const result = createTaskFromDianxiaomiProductWorkItem(params.id)

  if (!result) {
    reply.code(404)
    return {
      message: "dianxiaomi product work item not found"
    }
  }

  return result
})

app.post("/dianxiaomi/product-work-items/:id/retry-after-fix", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const result = requeueDianxiaomiProductWorkItemAfterFix(params.id)

  if (!result) {
    reply.code(404)
    return {
      message: "dianxiaomi product work item not found"
    }
  }

  if (!result.requeued) {
    reply.code(409)
  }

  return result
})

app.post("/dianxiaomi/product-work-items/:id/image-check", async (request) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const body = dianxiaomiImageCheckSchema.default({}).parse(request.body ?? {})
  return startDianxiaomiImageCheck({
    ...body,
    workItemId: params.id
  })
})

app.get("/dianxiaomi/page-context", async () => getDianxiaomiPageContext())

app.get("/dianxiaomi/store-metrics", async () => listDianxiaomiStoreMetrics())

app.post("/dianxiaomi/page-context", async (request) => {
  const body = dianxiaomiPageContextSchema.parse(request.body)
  return saveDianxiaomiPageContext({
    pageUrl: body.pageUrl,
    storeId: body.storeId,
    storeName: body.storeName,
    availableStores: body.availableStores?.map((item) => ({
      storeId: item.storeId,
      storeName: item.storeName
    })),
    siteName: body.siteName,
    pageTitle: body.pageTitle,
    pageProfile: body.pageProfile,
    updatedAt: body.updatedAt
  })
})

app.post("/dianxiaomi/collected-products", async (request) => {
  const body = dianxiaomiCollectedProductSchema.parse(request.body)
  return saveDianxiaomiCollectedProduct(body as any)
})

app.post("/dianxiaomi/collected-products/:id/task", async (request, reply) => {
  const params = z.object({
    id: z.string()
  }).parse(request.params)
  const result = createTaskFromDianxiaomiCollectedProduct(params.id)

  if (!result) {
    reply.code(404)
    return {
      message: "dianxiaomi collected product not found"
    }
  }

  return result
})

app.post("/imports/csv", async (request) => {
  const body = z.object({
    csvText: z.string().min(1)
  }).parse(request.body)

  return importCsvProducts(body.csvText)
})

app.post("/imports/excel", async (request, reply) => {
  const file = await request.file()

  if (!file) {
    reply.code(400)
    return {
      message: "缺少 Excel 文件"
    }
  }

  const buffer = await file.toBuffer()
  return importExcelProducts(buffer)
})

app.post("/products/manual", async (request) => {
  const body = z.object(productInputShape).parse(request.body)
  return createManualProductTask(body as any)
})

app.get("/tasks/:taskId", async (request, reply) => {
  const params = z.object({
    taskId: z.string()
  }).parse(request.params)

  const task = getTaskById(params.taskId)
  if (!task) {
    reply.code(404)
    return {
      message: "任务不存在"
    }
  }

  return task
})

app.post("/tasks/:taskId/automation-file", async (request, reply) => {
  const params = z.object({
    taskId: z.string()
  }).parse(request.params)
  const body = automationTaskFileExportSchema.default({}).parse(request.body ?? {})
  const result = exportTaskFile(params.taskId, body.outputPath)

  if (!result) {
    reply.code(404)
    return {
      message: "任务不存在"
    }
  }

  return result
})

app.get("/tasks/:taskId/publish-check", async (request, reply) => {
  const params = z.object({
    taskId: z.string()
  }).parse(request.params)

  const result = getPublishCheck(params.taskId)
  if (!result) {
    reply.code(404)
    return {
      message: "任务不存在"
    }
  }

  return result
})

app.post("/tasks/publish-check/batch", async (request) => {
  const body = z.object({
    taskIds: z.array(z.string().min(1)).min(1).max(200)
  }).parse(request.body)

  return getPublishChecks(body.taskIds)
})

app.patch("/tasks/:taskId/product", async (request, reply) => {
  const params = z.object({
    taskId: z.string()
  }).parse(request.params)
  const body = z.object({
    title: productInputShape.title.optional(),
    category: productInputShape.category.optional(),
    supplierPriceCny: productInputShape.supplierPriceCny.optional(),
    estimatedDomesticShippingCny: z.number().nonnegative().optional(),
    estimatedWeightKg: z.number().nonnegative().optional(),
    stock: z.number().int().nonnegative().optional(),
    skuName: z.string().optional(),
    skus: z.array(skuInputSchema).optional(),
    sourceUrl: z.string().optional(),
    attributes: z.record(z.string()).optional(),
    images: z.array(z.string()).optional()
  }).parse(request.body)

  const task = updateTaskProduct(params.taskId, body as any)
  if (!task) {
    reply.code(404)
    return {
      message: "任务不存在"
    }
  }

  return task
})

app.patch("/tasks/:taskId/draft", async (request, reply) => {
  const params = z.object({
    taskId: z.string()
  }).parse(request.params)
  const body = z.object({
    listingTitle: z.string().min(1).optional(),
    sellingPoints: z.array(z.string().min(1)).optional(),
    description: z.string().optional(),
    categoryPath: z.array(z.string().min(1)).optional(),
    attributes: z.record(z.string()).optional(),
    skuPricing: z.array(draftSkuPricingSchema).optional()
  }).parse(request.body)

  const task = updateTaskDraft(params.taskId, body as any)
  if (!task) {
    reply.code(404)
    return {
      message: "任务不存在"
    }
  }

  return task
})

app.post("/tasks/:taskId/draft/restore", async (request, reply) => {
  const params = z.object({
    taskId: z.string()
  }).parse(request.params)
  const body = z.object({
    versionId: z.string()
  }).parse(request.body)

  const task = restoreTaskDraftVersion(params.taskId, body.versionId)
  if (!task) {
    reply.code(404)
    return {
      message: "任务或草稿版本不存在"
    }
  }

  return task
})

app.post("/tasks/draft/restore-latest-ai/batch", async (request) => {
  const body = z.object({
    taskIds: z.array(z.string().min(1)).min(1).max(200)
  }).parse(request.body)

  return restoreLatestAiDraftVersions(body.taskIds)
})

app.post("/tasks/:taskId/review", async (request, reply) => {
  const params = z.object({
    taskId: z.string()
  }).parse(request.params)
  const body = z.object({
    decision: z.enum(["approve", "reject", "request_changes"]),
    note: z.string().default("")
  }).parse(request.body)

  const task = reviewTask(params.taskId, body.decision, body.note)
  if (!task) {
    reply.code(404)
    return {
      message: "任务不存在"
    }
  }

  return task
})

app.post("/tasks/review/batch", async (request) => {
  const body = z.object({
    taskIds: z.array(z.string().min(1)).min(1),
    decision: z.enum(["approve", "reject", "request_changes"]),
    note: z.string().default("")
  }).parse(request.body)

  return reviewTasks(body.taskIds, body.decision, body.note)
})

app.post("/plan/:productId", async (request, reply) => {
  const params = z.object({
    productId: z.string()
  }).parse(request.params)

  const task = await planTaskForProduct(params.productId)

  if (!task) {
    reply.code(404)
    return {
      message: "商品不存在"
    }
  }

  return task
})

const start = async () => {
  try {
    restoreDianxiaomiQueueDaemon()
    await app.listen({
      port: Number(process.env.PORT ?? 8787),
      host: "0.0.0.0"
    })
  } catch (error) {
    app.log.error(error)
    process.exit(1)
  }
}

await start()
