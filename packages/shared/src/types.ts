export type ProductCandidate = {
  id: string
  source: "1688" | "manual" | "csv" | "dianxiaomi"
  sourceUrl?: string
  title: string
  category: string
  supplierPriceCny: number
  estimatedDomesticShippingCny: number
  estimatedWeightKg: number
  images: string[]
  attributes: Record<string, string>
  skus: ProductSku[]
}

export type ProductSku = {
  skuId: string
  name: string
  costCny: number
  stock: number
  attributes: Record<string, string>
}

export type DianxiaomiCollectedSku = {
  skuName: string
  priceCny?: number
  stock?: number
  attributes: Record<string, string>
  rowText: string
}

export type DianxiaomiCollectedProduct = {
  id: string
  storeId?: string
  storeName?: string
  sourceBucket?: AutomationSourceBucket
  pageUrl: string
  pageTitle: string
  collectedAt: string
  quality: {
    status: "ready" | "partial" | "poor"
    score: number
    checks: Array<{
      id: string
      ok: boolean
      message: string
    }>
  }
  title: string
  category: string
  sourceUrl?: string
  images: string[]
  attributes: Record<string, string>
  skus: DianxiaomiCollectedSku[]
  rawTextSample: string
  notes: string[]
}

export type DianxiaomiCollectedProductImportResult = {
  product: DianxiaomiCollectedProduct
  task: PublishTask
}

export type DianxiaomiProductWorkStatus = "needs-revision" | "ready-for-automation" | "blocked" | "edited"

export type DianxiaomiWorkFailureCategory =
  | "login-or-captcha"
  | "real-page-calibration"
  | "selector-config"
  | "media-processing"
  | "publish-validation"
  | "target-surface"
  | "task-file"
  | "browser-profile"
  | "unknown"

export type DianxiaomiWorkFailureDiagnosis = {
  category: DianxiaomiWorkFailureCategory
  retryable: boolean
  autoRetryRecommended: boolean
  message: string
  nextAction: string
  source: "queue-daemon" | "full-flow" | "work-item-validation"
  updatedAt: string
}

export type DianxiaomiListingRequirementRules = {
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
    // P1-12: allowed aspect-ratio range for listing images (width/height).
    // Temu description images accept 0.5–2; carousel images should stay
    // near 1:1. When `minAspectRatio`/`maxAspectRatio` are set and the
    // snapshot reports per-image dimensions, out-of-range images are flagged.
    minAspectRatio?: number
    maxAspectRatio?: number
    // P1-11: when true, listing images must be confirmed English-only /
    // watermark-free. The check is satisfied by a Dianxiaomi 图片检测
    // (image check) signal or an explicit snapshot flag; absent evidence
    // is a recommended-level warning, present-and-failed is required-level.
    requireEnglishOnlyImages?: boolean
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
  // P1-3: per-category overrides. When a DianxiaomiProductWorkItem.snapshot
  // contains a category hint, the requirement checks for size chart / manual
  // document / video metadata are pulled from these overrides. Categories
  // not in this map fall back to the global `listingMetadata` defaults.
  categoryRules?: Record<string, DianxiaomiCategoryRule>
}

// P1-3: per-category requirement override. All flags default to the global
// rule when omitted.
export type DianxiaomiCategoryRule = {
  requireSizeChart?: boolean
  requireManualDocument?: boolean
  requireVideo?: boolean
  requiredAttributes?: string[]
}

export type DianxiaomiListingRequirementCheck = {
  id: string
  level: "required" | "recommended"
  ok: boolean
  message: string
  recommendation?: string
}

export type DianxiaomiListingRequirementSummary = {
  requiredTotal: number
  requiredPassed: number
  recommendedTotal: number
  recommendedPassed: number
  ready: boolean
}

export type DianxiaomiProductSuggestedEdit = {
  id: string
  field: "title" | "description" | "image" | "sku" | "price" | "stock" | "attribute" | "compliance"
  priority: "required" | "recommended"
  reason: string
  currentValue?: string
  suggestedValue?: string
}

export type DianxiaomiProductRepairAction = {
  id: string
  type:
    | "apply-media-tool"
    | "retry-transient"
    | "refresh-task-file"
    | "fix-field"
    | "review-image"
    | "clear-browser-profile"
    | "manual-session"
    | "recalibrate-selectors"
    | "replace-target-url"
    | "inspect-logs"
  label: string
  detail: string
  automation: "auto" | "assisted" | "manual"
  required: boolean
  field?: DianxiaomiProductSuggestedEdit["field"]
  target?: string
  tool?: string
  payload?: {
    writer:
      | "fill-single-field"
      | "fill-attributes"
      | "fill-sku-pricing"
      | "run-media-tool"
      | "refresh-task-file"
      | "clear-browser-profile"
      | "manual"
    selectorGroup?: "fields" | "skuRows" | "mediaTools" | "mediaToolActions" | "buttons"
    selectorKey?: string
    fieldKind?: "title" | "description" | "price" | "stock" | "attribute"
    attributeKey?: string
    skuMode?: "price-stock" | "variation"
    mediaTool?: "imageTranslation" | "whiteBackground" | "imageEditor" | "batchResize" | "imageManagement"
    expectedValue?: string
    reasonCode?: string
  }
}

export type DianxiaomiProductRepairPlan = {
  status: "auto-ready" | "assisted" | "manual" | "blocked"
  source: "requirements" | "failure-diagnosis" | "combined"
  summary: string
  canAutoRepair: boolean
  canRetryAfterRepair: boolean
  blockers: string[]
  actions: DianxiaomiProductRepairAction[]
  createdAt: string
}

export type DianxiaomiProductRepairActionGate = {
  status: "none" | DianxiaomiProductRepairPlan["status"]
  defaultActionAllowed: boolean
  message: string
}

export type DianxiaomiPublishOutcomeRoute = "published" | "auto-retry" | "browser-recovery" | "manual-budget" | "not-attempted"

export type DianxiaomiPublishOutcome = {
  status: "not-attempted" | "succeeded" | "failed"
  checkedAt: string
  flowJobId: string
  submitStageJobId: string | null
  reportPath: string | null
  attempts: number
  maxAttempts: number
  message: string
  failureReason: string | null
  route: DianxiaomiPublishOutcomeRoute
}

export type DianxiaomiProductWorkItem = {
  id: string
  source: "dianxiaomi"
  storeId?: string
  storeName?: string
  sourceBucket?: AutomationSourceBucket
  collectedProductId?: string
  pageUrl: string
  pageTitle: string
  pageProfile?: string
  title: string
  queuedAt: string
  updatedAt: string
  rawTextSample: string
  notes: string[]
  categoryHint?: {
    label?: string
    categoryId?: string
    fullCid?: string
    source?: "account-scan" | "collected-product" | "manual"
  }
  // P1-6: stable dedupe key computed from pageUrl + first product-image
  // hash. Used by the work-item admission endpoint to detect duplicate
  // products (same source page or same primary image) and update the
  // existing item instead of creating a new one.
  dedupeKey?: string
  snapshot: {
    hasTitle: boolean
    imageCount: number
    skuCount: number
    priceFieldCount: number
    stockFieldCount: number
    attributeKeys: string[]
    imageStats?: {
      minWidthPx: number
      minHeightPx: number
      maxWidthPx: number
      maxHeightPx: number
      unknownDimensionCount: number
      // P1-12: min/max aspect ratio (width/height) seen across product
      // images. Populated by the snapshot collector when dimensions are
      // known. Used to flag out-of-range images.
      minAspectRatio?: number
      maxAspectRatio?: number
    }
    // P1-11: Dianxiaomi 图片检测 (image check) outcome when available.
    // `passed` means the page-level image check confirmed no non-English
    // text / watermark; undefined means the check has not run yet.
    imageCheck?: {
      passed: boolean
      issues?: Array<{
        // fixed category bucket surfaced by Dianxiaomi image-check UI,
        // e.g. carousel image / product image / description image / SKU image.
        category: string
        // stable issue summary such as size, aspect ratio, non-english text.
        issue: string
        detail?: string
      }>
    }
    mediaToolSignals?: string[]
    // P1-9: target country/language for the listing's media. A single
    // listing cannot upload product media in multiple country languages
    // at the same time. The value is the BCP-47 locale (e.g. "en-US",
    // "ja-JP", "fr-FR"). When omitted, the global default is "en".
    targetLanguage?: string
  }
  requirements: {
    presetName: string
    checkedAt: string
    checks: DianxiaomiListingRequirementCheck[]
    summary: DianxiaomiListingRequirementSummary
  }
  suggestedEdits: DianxiaomiProductSuggestedEdit[]
  status: DianxiaomiProductWorkStatus
  failureDiagnosis?: DianxiaomiWorkFailureDiagnosis | null
  repairPlan?: DianxiaomiProductRepairPlan | null
  repairActionGate?: DianxiaomiProductRepairActionGate | null
  publishOutcome?: DianxiaomiPublishOutcome | null
  manualBudgetReleases?: AutomationManualStepBudgetRelease[]
}

export type DianxiaomiProductWorkItemInput =
  Omit<DianxiaomiProductWorkItem, "id" | "source" | "queuedAt" | "updatedAt" | "requirements" | "suggestedEdits" | "status" | "repairPlan" | "repairActionGate" | "publishOutcome" | "manualBudgetReleases"> &
  Partial<Pick<DianxiaomiProductWorkItem, "id" | "source" | "queuedAt" | "updatedAt" | "requirements" | "suggestedEdits" | "status" | "repairPlan" | "repairActionGate" | "publishOutcome" | "manualBudgetReleases">>

export type DianxiaomiProductWorkItemTaskResult = {
  workItem: DianxiaomiProductWorkItem
  task: PublishTask
}

export type DianxiaomiProductWorkItemRetryAfterFixResult = {
  workItem: DianxiaomiProductWorkItem
  requeued: boolean
  reason: string
}

export type DianxiaomiPageContext = {
  storeId?: string
  storeName?: string
  availableStores?: Array<{
    storeId?: string
    storeName: string
  }>
  siteName?: string
  pageUrl: string
  pageTitle?: string
  pageProfile?: string
  updatedAt: string
}

export type DianxiaomiStoreMetrics = {
  storeId?: string
  storeName?: string
  workItemCount: number
  readyCount: number
  collectedCount: number
  blockedCount: number
  needsRevisionCount: number
  editedCount: number
}

export type DianxiaomiRepairPreviewFile = {
  workItemId: string
  pageUrl: string
  pageTitle: string
  exportedAt: string
  repairPlan: DianxiaomiProductRepairPlan
}

export type DianxiaomiRepairPreviewExportResult = {
  workItem: DianxiaomiProductWorkItem
  task: PublishTask
  taskFile: string
  absoluteTaskFile: string
  repairPlanFile: string
  absoluteRepairPlanFile: string
  exportedAt: string
}

export type PricingAnalysis = {
  productId: string
  suggestedPriceUsd: number
  floorPriceUsd: number
  targetMarginRate: number
  estimatedPlatformFeeUsd: number
  estimatedLogisticsUsd: number
  rationale: string[]
  // P1-4: fingerprint + timestamp of the pricing rules used to compute this
  // analysis. The queue-run layer compares `rulesHash` against the current
  // rules hash and re-runs `calculatePricing` when they mismatch or when
  // `computedAt` is older than the configured staleness window.
  rulesHash?: string
  computedAt?: string
}

export type PricingRules = {
  exchangeRateCnyPerUsd: number
  logisticsUsdPerKg: number
  logisticsRateTiers?: LogisticsRateTier[]
  platformFeeUsd: number
  targetMarginRate: number
  priceMultiplier: number
  minimumMarginRate: number
  minimumSuggestedPriceUsd: number
}

export type LogisticsRateTier = {
  minWeightKg: number
  maxWeightKg?: number
  baseFeeUsd: number
  usdPerKg: number
}

export type ListingDraft = {
  productId: string
  listingTitle: string
  sellingPoints: string[]
  description: string
  categoryPath: string[]
  attributes: Record<string, string>
  skuPricing: ListingSkuPricing[]
  // P1-8: platform-level discoverability fields surfaced to Temu and
  // used by the listing editor's SEO panel. searchKeywords appear in
  // Temu's "search terms" field; tags drive marketplace filters;
  // bulletPoints show as 5-bullet highlights on the listing detail page.
  searchKeywords?: string[]
  tags?: string[]
  bulletPoints?: string[]
}

export type ListingSkuPricing = {
  skuId: string
  skuName: string
  salePriceUsd: number
  stock: number
  attributes: Record<string, string>
  attributeSummary: string
  // P1-8: per-SKU platform fields. variantBarcode maps to the Temu
  // SKU barcode field; variantImageUrl is the optional per-SKU image
  // override shown in the variant picker.
  variantBarcode?: string
  variantImageUrl?: string
}

export type ExecutionStepStatus = "pending" | "running" | "done" | "failed"

export type ExecutionStep = {
  id: string
  title: string
  instruction: string
  targetField?: string
  status: ExecutionStepStatus
}

export type RiskAlert = {
  id: string
  level: "low" | "medium" | "high"
  message: string
}

export type PublishTask = {
  id: string
  product: ProductCandidate
  pricing: PricingAnalysis
  draft: ListingDraft
  draftVersions?: DraftVersion[]
  review?: ReviewState
  steps: ExecutionStep[]
  risks: RiskAlert[]
  status: "queued" | "planned" | "executing" | "reviewing" | "approved" | "rejected" | "completed" | "failed"
  updatedAt: string
}

export type DraftVersion = {
  id: string
  source: "ai" | "manual" | "restore"
  label: string
  draft: ListingDraft
  createdAt: string
}

export type ReviewDecision = "approve" | "reject" | "request_changes"

export type ReviewState = {
  status: "pending" | "approved" | "rejected" | "changes_requested"
  note: string
  reviewedAt: string
  history: ReviewEvent[]
}

export type ReviewEvent = {
  decision: ReviewDecision
  note: string
  createdAt: string
}

export type PublishCheckIssue = {
  id: string
  level: "low" | "medium" | "high"
  message: string
}

export type PublishCheckResult = {
  taskId: string
  canPublish: boolean
  issues: PublishCheckIssue[]
  checkedAt: string
}

export type BatchDraftRestoreResult = {
  restored: PublishTask[]
  skipped: Array<{
    taskId: string
    reason: string
  }>
}

export type FieldSnapshot = {
  kind: "title" | "price" | "stock" | "attribute" | "unknown"
  selectorHint: string
  labelText: string
  placeholder: string
  name: string
  tagName: string
}

export type SkuRowSnapshot = {
  rowText: string
  priceFieldCount: number
  stockFieldCount: number
  inputCount: number
}

export type PageDebugSnapshot = {
  id: string
  taskId: string | null
  taskTitle: string | null
  pageUrl: string
  pageTitle: string
  createdAt: string
  summary: {
    titleFieldCount: number
    priceFieldCount: number
    stockFieldCount: number
    skuRowCount: number
  }
  fieldSnapshots: FieldSnapshot[]
  skuRows: SkuRowSnapshot[]
  notes: string[]
}

export type AutomationReportStep = {
  id: string
  label: string
  status: "done" | "failed" | "skipped"
  detail: string
  data?: Record<string, unknown>
}

export type AutomationExecutionReport = {
  id: string
  taskId: string
  taskTitle: string
  platform: string
  pageUrl: string
  pageTitle: string
  status: "completed" | "partial" | "failed"
  createdAt: string
  screenshotPath: string
  steps: AutomationReportStep[]
}

export type SelectorDiagnosisCandidate = {
  selectorHint: string
  score: number
  text: string
}

export type SelectorDiagnosisCheck = {
  ok: boolean
  candidates: SelectorDiagnosisCandidate[]
}

export type SelectorDiagnosisReport = {
  pageUrl: string
  pageTitle: string
  createdAt: string
  requiredOk: boolean
  targetSurface?: AutomationReportStep
  summary: {
    fieldCount: number
    buttonCount: number
    skuRowCount: number
    mediaToolCount?: number
  }
  fields: Record<string, SelectorDiagnosisCheck>
  buttons: Record<string, SelectorDiagnosisCheck>
  mediaTools?: Record<string, SelectorDiagnosisCheck>
  mediaToolActions?: Record<string, Record<string, SelectorDiagnosisCheck>>
  skuRows: {
    ok: boolean
    count: number
    samples: Array<{
      rowText: string
      inputCount: number
    }>
  }
  // P0-D: optional media-action sampling report. Captures the per-tool
  // outcome (`sampled` for dialog-based apply path, `instant-action-recognized`
  // for in-page actions like 一键翻译 / 图片检测, `no-dialog` / `close-failed`
  // / etc. for the calibration failures).
  mediaActionSampling?: {
    enabled: boolean
    tools: SelectorMediaActionSamplingTool[]
  }
}

// P0-D: per-tool result of the media-action sampler. `instant-action-recognized`
// is the new status for tools whose entry click acts on the page in place
// rather than opening a closeable dialog.
export type SelectorMediaActionSamplingTool = {
  id: string
  configKey: string
  status: "sampled" | "missing-tool" | "no-dialog" | "close-failed" | "failed" | "skipped" | "instant-action-recognized"
  sampledButtonCount: number
  reason: string
  entryText?: string
  error?: string
}

export type DianxiaomiSelectorConfig = {
  fields: Record<string, string[]>
  buttons: Record<string, string[]>
  mediaTools?: Record<string, string[]>
  mediaToolActions?: Record<string, Record<string, string[]>>
  skuRows: string[]
}

export type SelectorConfigGenerationResult = {
  configPath: string
  sourceDiagnosisCreatedAt: string
  sourcePageUrl: string
  config: DianxiaomiSelectorConfig
  version?: SelectorConfigVersion | null
}

export type SelectorConfigStatus = {
  configPath: string
  exists: boolean
  config: DianxiaomiSelectorConfig | null
  error?: string | null
  summary: {
    fieldSelectorCount: number
    buttonSelectorCount: number
    mediaToolSelectorCount?: number
    mediaToolActionSelectorCount?: number
    skuRowSelectorCount: number
  }
}

export type SelectorConfigSaveInput = {
  config: DianxiaomiSelectorConfig
  note?: string
  confirmDangerousChanges?: boolean
}

export type SelectorConfigVersion = {
  id: string
  createdAt: string
  configPath: string
  backupPath: string
  note: string
  config: DianxiaomiSelectorConfig
}

export type SelectorConfigSaveResult = {
  configPath: string
  version: SelectorConfigVersion | null
  config: DianxiaomiSelectorConfig
}

export type SelectorConfigRestoreResult = {
  configPath: string
  restoredVersion: SelectorConfigVersion
  config: DianxiaomiSelectorConfig
}

export type SelectorConfigDiffEntry = {
  group: "fields" | "buttons" | "mediaTools" | "mediaToolActions" | "skuRows"
  key: string
  status: "unchanged" | "added" | "removed" | "changed"
  currentSelectors: string[]
  nextSelectors: string[]
  addedSelectors: string[]
  removedSelectors: string[]
  unchangedSelectors: string[]
}

export type SelectorConfigChangeRisk = {
  id: string
  level: "confirm" | "block"
  group: SelectorConfigDiffEntry["group"]
  key: string
  message: string
  currentSelectors: string[]
  nextSelectors: string[]
  addedSelectors: string[]
  removedSelectors: string[]
}

export type SelectorConfigDiffSummary = {
  totalCount: number
  changedCount: number
  addedCount: number
  removedCount: number
  unchangedCount: number
  confirmRiskCount: number
  blockRiskCount: number
}

export type SelectorConfigDiffInput = {
  config: DianxiaomiSelectorConfig
}

export type SelectorConfigRestoreInput = {
  confirmDangerousChanges?: boolean
}

export type SelectorConfigDiffResult = {
  checkedAt: string
  configPath: string
  currentExists: boolean
  entries: SelectorConfigDiffEntry[]
  risks: SelectorConfigChangeRisk[]
  requiresConfirmation: boolean
  blocked: boolean
  summary: SelectorConfigDiffSummary
}

export type SelectorConfigVersionDiffResult = SelectorConfigDiffResult & {
  version: SelectorConfigVersion
}

export type SelectorConfigValidationIssue = {
  id: string
  level: "info" | "warning" | "error"
  message: string
}

export type SelectorConfigValidationResult = {
  checkedAt: string
  configPath: string
  latestDiagnosisCreatedAt: string | null
  latestDiagnosisPageUrl: string | null
  valid: boolean
  issues: SelectorConfigValidationIssue[]
}

export type SelectorWorkbenchItemStatus = "ready" | "missing-config" | "missing-candidate" | "stale" | "optional"

export type SelectorWorkbenchItem = {
  group: "fields" | "buttons" | "mediaTools" | "mediaToolActions"
  key: string
  required: boolean
  configuredSelectors: string[]
  candidates: SelectorDiagnosisCandidate[]
  recommendedSelector: string | null
  latestCandidateConfigured: boolean
  status: SelectorWorkbenchItemStatus
}

export type SelectorWorkbench = {
  checkedAt: string
  diagnosis: (Pick<SelectorDiagnosisReport, "pageUrl" | "pageTitle" | "createdAt" | "requiredOk" | "summary"> & {
    diagnosisPath: string
    targetSurface?: AutomationReportStep
  }) | null
  config: SelectorConfigStatus
  validation: SelectorConfigValidationResult
  items: SelectorWorkbenchItem[]
  skuRows: {
    required: boolean
    configuredSelectors: string[]
    diagnosisOk: boolean
    diagnosisCount: number
    samples: SelectorDiagnosisReport["skuRows"]["samples"]
    status: SelectorWorkbenchItemStatus
  }
  mediaTools?: SelectorWorkbenchItem[]
  mediaToolActions?: SelectorWorkbenchItem[]
  summary: {
    requiredReadyCount: number
    requiredCount: number
    missingRequiredCount: number
    staleCount: number
    candidateCount: number
    configuredSelectorCount: number
    mediaToolReadyCount?: number
    mediaToolCount?: number
    mediaToolActionReadyCount?: number
    mediaToolActionCount?: number
  }
}

export type SelectorCalibrationStartInput = Partial<{
  url: string
  headed: boolean
  profile: string
  screenshots: string
  sampleMediaActions: boolean
  mediaAutomationTools: string[]
}>

export type SelectorCalibrationStartResult = {
  id: string
  startedAt: string
  command: string
  cwd: string
  logPath: string
  errorLogPath: string
  artifactDir: string
}

export type SelectorCalibrationJobStatus = "running" | "completed" | "failed"

export type SelectorCalibrationJob = SelectorCalibrationStartResult & {
  status: SelectorCalibrationJobStatus
  finishedAt: string | null
  exitCode: number | null
  error: string | null
}

export type SelectorCalibrationJobLog = {
  id: string
  logPath: string
  errorLogPath: string
  stdout: string
  stderr: string
  truncated: {
    stdout: boolean
    stderr: boolean
  }
}

export type MediaAutomationMode = "plan-only" | "unattended-open" | "unattended-apply"

export type AutomationSourceBucket = "collection-box" | "pending-publish" | "listing-draft"

export type AutomationDryRunStartInput = Partial<{
  url: string
  taskFile: string
  repairPlanFile: string
  storeId: string
  storeName: string
  itemUrls: string[]
  sourceBuckets: AutomationSourceBucket[]
  headed: boolean
  profile: string
  screenshots: string
  selectorConfig: string
  mediaAutomationMode: MediaAutomationMode
  mediaAutomationTools: string[]
  skipDraftFill: boolean
  submitAfterSave: boolean
  submitMaxAttempts: number
}>

export type AutomationDryRunStartResult = {
  id: string
  startedAt: string
  command: string
  cwd: string
  logPath: string
  errorLogPath: string
  targetFingerprint: string
  artifactDir: string
}

export type AutomationDryRunJobStatus = "running" | "completed" | "failed"

export type AutomationDryRunJob = AutomationDryRunStartResult & {
  status: AutomationDryRunJobStatus
  finishedAt: string | null
  exitCode: number | null
  error: string | null
  reportPath: string | null
  reportStatus: AutomationExecutionReport["status"] | null
}

export type AutomationDryRunJobLog = {
  id: string
  logPath: string
  errorLogPath: string
  stdout: string
  stderr: string
  truncated: {
    stdout: boolean
    stderr: boolean
  }
}

export type AutomationRepairPreviewStartInput = AutomationDryRunStartInput

export type AutomationRepairPreviewStartResult = AutomationDryRunStartResult & {
  workItemId?: string | null
  taskFile?: string | null
  repairPlanFile?: string | null
}

export type AutomationRepairPreviewJob = AutomationDryRunJob & {
  workItemId?: string | null
  taskFile?: string | null
  repairPlanFile?: string | null
}

export type AutomationRepairPreviewJobLog = AutomationDryRunJobLog

export type AutomationRepairApplyStartInput = AutomationDryRunStartInput

export type AutomationRepairApplyStartResult = AutomationDryRunStartResult & {
  workItemId?: string | null
  taskFile?: string | null
  repairPlanFile?: string | null
}

export type AutomationRepairApplyJob = AutomationDryRunJob & {
  workItemId?: string | null
  taskFile?: string | null
  repairPlanFile?: string | null
}

export type AutomationRepairApplyJobLog = AutomationDryRunJobLog

export type AutomationFullFlowStartInput = AutomationDryRunStartInput

export type AutomationFullFlowStartResult = {
  id: string
  startedAt: string
  targetFingerprint: string
  artifactDir: string
}

export type AutomationFullFlowJobStatus = "running" | "completed" | "failed"

export type AutomationFullFlowStageName = "dry-run" | "repair-preview" | "fill-draft" | "save-draft" | "submit-listing"

export type AutomationFullFlowStage = {
  name: AutomationFullFlowStageName
  status: "pending" | "running" | "completed" | "failed" | "skipped"
  jobId: string | null
  reportPath: string | null
  reportStatus: AutomationExecutionReport["status"] | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

export type AutomationFullFlowJob = AutomationFullFlowStartResult & {
  status: AutomationFullFlowJobStatus
  finishedAt: string | null
  error: string | null
  input: AutomationFullFlowStartInput
  source: "direct" | "queue-run" | "recovery-run" | "manual-budget-trial"
  workItemId?: string | null
  taskId?: string | null
  taskFile?: string | null
  stages: AutomationFullFlowStage[]
}

export type AutomationQueueRunStartInput = AutomationFullFlowStartInput & Partial<{
  limit: number
}>

export type AutomationQueueRunStartResult = {
  id: string
  startedAt: string
  storeId?: string
  storeName?: string
  itemUrls?: string[]
  sourceBuckets?: AutomationSourceBucket[]
  limit: number
  queued: number
  skipped: number
  autoRetryReleasedIds: string[]
  flowJobIds: string[]
  skippedItems: Array<{
    workItemId: string
    reason: string
  }>
}

export type AutomationRecoveryPolicy = "normal" | "released-retry"

export type AutomationRecoveryRunStartInput = AutomationQueueRunStartInput & Partial<{
  workItemIds: string[]
  recoveryPolicy: AutomationRecoveryPolicy
}>

export type AutomationRecoveryRunItemStatus =
  | "skipped"
  | "repair-preview-running"
  | "repair-preview-failed"
  | "repair-apply-running"
  | "repair-apply-failed"
  | "full-flow-running"
  | "completed"
  | "failed"

export type AutomationRecoveryRunItem = {
  workItemId: string
  title: string
  status: AutomationRecoveryRunItemStatus
  reason: string | null
  repairPreviewJobId: string | null
  repairApplyJobId: string | null
  fullFlowJobId: string | null
  taskFile: string | null
  repairPlanFile: string | null
  startedAt: string
  finishedAt: string | null
}

export type AutomationRecoveryRunStatus = "running" | "completed" | "failed"

export type AutomationRecoveryRun = {
  id: string
  startedAt: string
  finishedAt: string | null
  status: AutomationRecoveryRunStatus
  limit: number
  input: AutomationRecoveryRunStartInput
  queued: number
  skipped: number
  completed: number
  failed: number
  items: AutomationRecoveryRunItem[]
}

export type AutomationRecoveryFailureSummary = {
  key: string
  kind: "work-item" | "repair-action"
  count: number
  workItemId: string | null
  title: string | null
  repairAction: string | null
  latestRunId: string
  latestFailureAt: string
  latestReason: string | null
}

export type AutomationRecoveryPause = AutomationRecoveryFailureSummary & {
  pausedUntil: "work-item-updated" | "repair-plan-regenerated" | "selector-recalibrated"
  releaseReason: string
}

export type AutomationRecoveryRelease = AutomationRecoveryFailureSummary & {
  releasedAt: string
  releaseEventAt: string
  releaseType: "work-item-updated" | "repair-plan-regenerated" | "selector-recalibrated"
  releaseReason: string
}

export type AutomationRecoveryReleasedRetryCandidate = {
  workItemId: string
  title: string
  releaseKeys: string[]
  releaseTypes: AutomationRecoveryRelease["releaseType"][]
  latestReleaseAt: string
  releaseReason: string
}

export type AutomationRecoveryReleasedRetryOutcomeState =
  | "running"
  | "completed"
  | "repaused"
  | "released-pending"
  | "normal-recovery"
  | "not-recoverable"

export type AutomationRecoveryReleasedRetryOutcome = {
  runId: string
  workItemId: string
  title: string
  status: AutomationRecoveryRunItemStatus
  finishedAt: string | null
  reason: string | null
  nextState: AutomationRecoveryReleasedRetryOutcomeState
  nextAction: string
}

export type AutomationRecoveryReleasedRetryBatchPolicy = {
  policy: AutomationRecoveryPolicy
  maxItemsPerTick: number
  pendingCount: number
  normalRecoveryHeld: boolean
  nextWorkItemIds: string[]
  detail: string
}

export type AutomationQueueDaemonStatus = "ACTIVE" | "PAUSED"

export type AutomationQueueDaemonInput = AutomationQueueRunStartInput & Partial<{
  intervalSeconds: number
  maxConsecutiveFailures: number
}>

export type AutomationQueueDaemonFlowOutcome = {
  flowJobId: string
  workItemId: string
  taskId: string | null
  status: AutomationFullFlowJobStatus
  resolvedAt: string
  note: string
  error: string | null
}

export type AutomationQueueDaemonTick = {
  id: string
  startedAt: string
  finishedAt: string
  status: "completed" | "failed" | "skipped"
  category:
    | "ready-queued"
    | "idle-no-items"
    | "work-item-skipped"
    | "running-lock"
    | "selector-blocked"
    | "task-export-failed"
    | "target-surface-blocked"
    | "repair-preview-failed"
    | "repair-apply-failed"
    | "startup-check-blocked"
    | "login-or-captcha"
    | "publish-validation-failed"
    | "system-error"
    | "daemon-paused"
    | "tick-already-running"
    | "awaiting-flow-completion"
    | "flow-outcome-recovered"
    | "recovery-run-started"
    | "validation-rerun-started"
  reason?: string
  queueRun: AutomationQueueRunStartResult | null
  recoveryRun: AutomationRecoveryRun | null
  manualBudgetValidationRun?: AutomationManualStepBudgetTrialRequestResult | null
  flowOutcomes: AutomationQueueDaemonFlowOutcome[]
  error: string | null
}

export type AutomationQueueDaemonState = {
  status: AutomationQueueDaemonStatus
  input: AutomationQueueDaemonInput
  intervalSeconds: number
  maxConsecutiveFailures: number
  running: boolean
  consecutiveFailures: number
  lastStartedAt: string | null
  lastFinishedAt: string | null
  lastError: string | null
  lastQueueRunId: string | null
  lastRecoveryRunId: string | null
  nextRunAt: string | null
  trackedFlowJobIds: string[]
  resolvedFlowJobIds: string[]
  flowOutcomes: AutomationQueueDaemonFlowOutcome[]
  ticks: AutomationQueueDaemonTick[]
}

export type AutomationQueueDaemonHealthStatus = "healthy" | "warning" | "blocked"

export type AutomationQueueDaemonHealthIssue = {
  id: string
  level: "info" | "warning" | "block"
  message: string
}

export type AutomationQueueDaemonHealthAlert = {
  id: string
  level: "info" | "warning" | "block"
  message: string
  action: string
}

export type AutomationManualStepBudgetSource = "publish-outcome" | "repair-plan" | "failure-diagnosis"

export type AutomationManualStepBudgetItem = {
  workItemId: string
  title: string
  source: AutomationManualStepBudgetSource
  reason: string
  operatorAction: string
  releaseCondition: string
  updatedAt: string
}

export type AutomationManualStepBudgetRelease = {
  workItemId: string
  title: string
  source: AutomationManualStepBudgetSource
  reason: string
  operatorAction: string
  releaseCondition: string
  releasedAt: string
  releaseEventAt: string
  releaseType: "retry-after-fix" | "status-update"
  fromStatus: DianxiaomiProductWorkStatus
  toStatus: DianxiaomiProductWorkStatus
  note: string
}

export type AutomationManualStepBudgetProofStatus = "needs-proof" | "ready-for-default"

export type AutomationManualStepBudgetProofConfidence = "weak" | "estimated" | "measured"

export type AutomationManualStepBudgetProofAutomationMeasurement = {
  source: "automation-reports"
  browserClicks: number
  browserActions: number
  reportCount: number
  reportIds: string[]
  reportPaths: string[]
}

export type AutomationManualStepBudgetProofInput = {
  candidateKey: string
  source: AutomationManualStepBudgetSource
  reason: string
  replacementPlan: string
  baseline: {
    productCount: number
    operatorClicks: number
    operatorDecisions: number
  }
  trial: {
    productCount: number
    operatorClicks: number
    operatorDecisions: number
    status: "passed" | "failed"
  }
  evidence: string
  automationMeasurement?: AutomationManualStepBudgetProofAutomationMeasurement
  recordedBy?: string
}

export type AutomationManualStepBudgetProofRecord = AutomationManualStepBudgetProofInput & {
  id: string
  recordedAt: string
  status: AutomationManualStepBudgetProofStatus
  confidence: AutomationManualStepBudgetProofConfidence
  defaultEligible: boolean
  clickReductionPerProduct: number
  decisionReductionPerProduct: number
}

export type AutomationManualStepBudgetReplacementCandidate = {
  key: string
  source: AutomationManualStepBudgetSource
  reason: string
  activeCount: number
  releasedCount: number
  totalOccurrences: number
  sampleWorkItemIds: string[]
  sampleTitles: string[]
  latestAt: string
  operatorAction: string
  releaseCondition: string
  replacementPlan: string
  defaultEligible: boolean
  proofGate: {
    status: AutomationManualStepBudgetProofStatus
    confidence: AutomationManualStepBudgetProofConfidence
    requiredProof: string
    evidence: string
    proofRecordId: string | null
  }
}

export type AutomationManualStepBudgetTrialReadinessStatus = "ready" | "warning" | "blocked"

export type AutomationManualStepBudgetTrialReadinessCheck = {
  id: string
  label: string
  status: AutomationPreflightCheckStatus
  message: string
}

export type AutomationManualStepBudgetTrialProposal = {
  candidateKey: string
  source: AutomationManualStepBudgetSource
  reason: string
  replacementPlan: string
  proofRecordId: string
  proofConfidence: "measured"
  trialSize: number
  trialScope: string
  sampleWorkItemIds: string[]
  sampleTitles: string[]
  measuredReportCount: number
  measuredBrowserClicks: number
  measuredBrowserActions: number
  acceptanceCriteria: string[]
  rollbackCriteria: string[]
  readinessStatus: AutomationManualStepBudgetTrialReadinessStatus
  readinessChecks: AutomationManualStepBudgetTrialReadinessCheck[]
  executionReady: boolean
  rollbackAcknowledgementRequired: boolean
  note: string
}

export type AutomationManualStepBudgetTrialRequestInput = AutomationFullFlowStartInput & {
  candidateKey: string
  rollbackAcknowledged: boolean
  acceptedRollbackCriteria: string[]
  validationRerun?: {
    sourceTrialId: string
    route: "auto-retry" | "browser-recovery" | "profile-fix"
    reason: string
    requestedBy: "queue-daemon"
  }
}

export type AutomationManualStepBudgetTrialOutcomeStatus = "blocked" | "running" | "passed" | "failed"

export type AutomationManualStepBudgetTrialFlowOutcome = {
  flowJobId: string
  workItemId: string | null
  status: AutomationFullFlowJobStatus | "missing"
  finishedAt: string | null
  reportPaths: string[]
  failureReason: string | null
}

export type AutomationManualStepBudgetTrialOutcome = {
  status: AutomationManualStepBudgetTrialOutcomeStatus
  resolvedAt: string | null
  message: string
  completed: number
  failed: number
  running: number
  missing: number
  proofRecordId: string | null
  automationMeasurement?: AutomationManualStepBudgetProofAutomationMeasurement
  flowOutcomes: AutomationManualStepBudgetTrialFlowOutcome[]
}

export type AutomationManualStepBudgetTrialRequestResult = {
  id: string
  requestedAt: string
  updatedAt: string
  candidateKey: string
  validationRerun: {
    sourceTrialId: string
    route: "auto-retry" | "browser-recovery" | "profile-fix"
    reason: string
    requestedBy: "queue-daemon"
  } | null
  status: "blocked" | "started"
  message: string
  rollbackAcknowledged: boolean
  acceptedRollbackCriteria: string[]
  proposal: AutomationManualStepBudgetTrialProposal | null
  readinessStatus: AutomationManualStepBudgetTrialReadinessStatus
  readinessChecks: AutomationManualStepBudgetTrialReadinessCheck[]
  trialSize: number
  flowJobIds: string[]
  skippedItems: AutomationQueueRunStartResult["skippedItems"]
  outcome: AutomationManualStepBudgetTrialOutcome
}

export type AutomationManualStepBudgetValidationClosure = {
  status: "idle" | "running" | "passed" | "failed" | "blocked"
  message: string
  total: number
  running: number
  passed: number
  failed: number
  blocked: number
  latestTrialId: string | null
  latestCandidateKey: string | null
  latestStatus: AutomationManualStepBudgetTrialOutcomeStatus | null
  latestUpdatedAt: string | null
  latestMessage: string | null
  latestProofRecordId: string | null
  latestMeasurement: AutomationManualStepBudgetProofAutomationMeasurement | null
  failureTriage: {
    status: "none" | "running" | "recoverable" | "manual-budget" | "blocked"
    category: DianxiaomiWorkFailureCategory | "missing-flow" | "mixed" | null
    route: "none" | "auto-retry" | "browser-recovery" | "profile-fix" | "manual-budget" | "wait" | "blocked"
    reason: string | null
    nextAction: string
    recoverable: boolean
    countsAsManualBudget: boolean
    trialId: string | null
    candidateKey: string | null
    workItemIds: string[]
  }
  rerunPolicy: {
    status: "not-needed" | "running" | "ineligible" | "waiting-for-fix" | "ready" | "spent" | "blocked"
    route: "none" | "auto-retry" | "browser-recovery" | "profile-fix" | "manual-budget" | "wait" | "blocked"
    sourceTrialId: string | null
    retryTrialId: string | null
    candidateKey: string | null
    attemptsUsed: number
    maxAttempts: number
    prerequisiteStatus: "none" | "pending" | "met" | "blocked"
    prerequisiteCompletedAt: string | null
    reason: string
    nextAction: string
    workItemIds: string[]
  }
}

export type AutomationQueueDaemonAuditDecision =
  | "skipped"
  | "startup-blocked"
  | "recovery-started"
  | "validation-rerun-started"
  | "queue-started"
  | "awaiting-flow-completion"
  | "outcomes-recovered"
  | "idle"
  | "failed"

export type AutomationQueueDaemonAuditEntry = {
  tickId: string
  startedAt: string
  finishedAt: string
  status: AutomationQueueDaemonTick["status"]
  category: AutomationQueueDaemonTick["category"]
  decision: AutomationQueueDaemonAuditDecision
  subject: string
  reason: string
  nextAction: string
  workItemIds: string[]
  queueRunId: string | null
  recoveryRunId: string | null
  countsAsFailure: boolean
}

export type AutomationProfileLockAuditAction = "ignored-stale-lock" | "archived-stale-lock"

export type AutomationProfileLockAuditEntry = {
  id: string
  recordedAt: string
  action: AutomationProfileLockAuditAction
  profilePath: string
  fileName: string
  detail: string
  mtime: string | null
  ageMinutes: number | null
  staleThresholdMinutes: number
  nextAction: string
}

export type AutomationProfileLockArchiveReadinessItem = {
  fileName: string
  detail: string
  mtime: string | null
  ageMinutes: number | null
  staleThresholdMinutes: number
  archiveTarget: string
  ready: boolean
  reason: string
}

export type AutomationProfileLockArchiveReadiness = {
  checkedAt: string
  status: "ready" | "blocked" | "idle"
  profilePath: string | null
  profileExists: boolean
  archiveDirectory: string | null
  activeLocks: string[]
  staleLocks: string[]
  readyItems: AutomationProfileLockArchiveReadinessItem[]
  blockedItems: AutomationProfileLockArchiveReadinessItem[]
  message: string
  nextAction: string
}

export type AutomationProfileLockArchivedItem = AutomationProfileLockArchiveReadinessItem & {
  sourcePath: string
  archivedAt: string
}

export type AutomationProfileLockArchiveResult = {
  checkedAt: string
  status: "archived" | "blocked" | "idle"
  profilePath: string | null
  archiveDirectory: string | null
  archivedItems: AutomationProfileLockArchivedItem[]
  blockedItems: AutomationProfileLockArchiveReadinessItem[]
  readiness: AutomationProfileLockArchiveReadiness
  message: string
  nextAction: string
}

export type AutomationQueueDaemonRecommendationKind =
  | "continue-running"
  | "start-daemon"
  | "wait-for-products"
  | "wait-for-running-flow"
  | "run-calibration"
  | "resolve-login-or-captcha"
  | "regenerate-repair-plan"
  | "fix-browser-profile"
  | "review-failed-outcomes"
  | "inspect-blocker"

export type AutomationQueueDaemonRecommendation = {
  kind: AutomationQueueDaemonRecommendationKind
  level: "info" | "warning" | "block"
  title: string
  detail: string
  action: string
  source: "health" | "audit" | "recovery" | "queue"
  workItemIds: string[]
}

export type AutomationQueueDaemonHealth = {
  checkedAt: string
  status: AutomationQueueDaemonHealthStatus
  issues: AutomationQueueDaemonHealthIssue[]
  alerts: AutomationQueueDaemonHealthAlert[]
  recommendation: AutomationQueueDaemonRecommendation
  queue: {
    daemonStatus: AutomationQueueDaemonStatus
    running: boolean
    consecutiveFailures: number
    maxConsecutiveFailures: number
    nextRunAt: string | null
    lastError: string | null
    lastFailedCategory: AutomationQueueDaemonTick["category"] | null
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
    publishOutcomes: AutomationManualStepBudgetItem[]
    releases: AutomationManualStepBudgetRelease[]
    replacementQueue: AutomationManualStepBudgetReplacementCandidate[]
    trialProposals: AutomationManualStepBudgetTrialProposal[]
    proofs: AutomationManualStepBudgetProofRecord[]
    validationClosure: AutomationManualStepBudgetValidationClosure
  }
  profile: {
    path: string | null
    exists: boolean
    lockFiles: string[]
    staleLockFiles: string[]
    lockAudit: {
      recent: AutomationProfileLockAuditEntry[]
      ignored: number
      archived: number
    }
  }
  flows: {
    tracked: number
    unresolved: number
    recentFailures: number
  }
  audit: {
    recent: AutomationQueueDaemonAuditEntry[]
  }
  recovery: {
    history: number
    repeatedFailures: AutomationRecoveryFailureSummary[]
    paused: AutomationRecoveryPause[]
    releasedRetryBatch: AutomationRecoveryReleasedRetryBatchPolicy
    releasedRetryCandidates: AutomationRecoveryReleasedRetryCandidate[]
    releasedRetryOutcomes: AutomationRecoveryReleasedRetryOutcome[]
    releases: AutomationRecoveryRelease[]
  }
}

export type AutomationUnattendedStartupStatus = "ready" | "warning" | "blocked"

export type AutomationUnattendedStartupCheckItem = {
  id: string
  label: string
  status: AutomationPreflightCheckStatus
  message: string
  details?: string[]
}

export type AutomationUnattendedStartupCheck = {
  checkedAt: string
  status: AutomationUnattendedStartupStatus
  canStart: boolean
  recommendedAction: string
  checks: AutomationUnattendedStartupCheckItem[]
  health: AutomationQueueDaemonHealth
  normalizedInput: AutomationQueueDaemonInput
  runbook: string[]
}

export type AutomationMode = "dry-run" | "repair-preview" | "repair-apply" | "fill-draft" | "save-draft" | "submit-listing"

export type AutomationModeReadiness = {
  mode: AutomationMode
  ready: boolean
  reason: string
  targetFingerprint: string
  requiredMode?: AutomationMode
  latestJobId?: string | null
  runningJobId?: string | null
  selectorValidation?: SelectorConfigValidationResult
  selectorBlockers?: SelectorConfigValidationIssue[]
}

export type AutomationReadiness = {
  dryRun: AutomationModeReadiness
  repairPreview?: AutomationModeReadiness
  repairApply?: AutomationModeReadiness
  fillDraft: AutomationModeReadiness
  saveDraft: AutomationModeReadiness
  submitListing: AutomationModeReadiness
}

export type AutomationPreflightCheckStatus = "pass" | "warning" | "block"

export type AutomationPreflightCheck = {
  id: string
  label: string
  status: AutomationPreflightCheckStatus
  message: string
  details?: string[]
}

export type AutomationPreflightReport = {
  checkedAt: string
  targetFingerprint: string
  overallStatus: "ready" | "warning" | "blocked"
  readyModes: AutomationMode[]
  recommendedMode: AutomationMode | null
  checks: AutomationPreflightCheck[]
  readiness: AutomationReadiness
  selectorValidation: SelectorConfigValidationResult
  publishCheck: PublishCheckResult | null
  activeTask: Pick<PublishTask, "id" | "status" | "updatedAt"> | null
  latestJobs: {
    dryRun: AutomationDryRunJob | null
    repairPreview?: AutomationRepairPreviewJob | null
    repairApply?: AutomationRepairApplyJob | null
    fillDraft: AutomationFillDraftJob | null
    saveDraft: AutomationSaveDraftJob | null
    submitListing: AutomationSubmitListingJob | null
  }
  latestReport: AutomationExecutionReport | null
}

export type AutomationLaunchPreset = {
  id: string
  name: string
  input: AutomationDryRunStartInput
  createdAt: string
  updatedAt: string
}

export type AutomationLaunchPresetInput = {
  name: string
  input: AutomationDryRunStartInput
}

export type AutomationLaunchPresetUpdateInput = {
  name?: string
  input?: AutomationDryRunStartInput
}

export type AutomationLaunchPresetDeleteResult = {
  id: string
  deleted: boolean
}

export type AutomationTaskFileExportInput = {
  taskId: string
  outputPath?: string
}

export type AutomationTaskFileLaunchStatus = {
  status: "ready" | "needs-target-url" | "blocked"
  reason: string
  checkedAt: string
  taskFileExists: boolean
  taskFileReadable: boolean
  dianxiaomiUrlChecks: Array<{
    label: string
    url: string
    valid: boolean
    reason?: string
  }>
}

export type AutomationTaskFileExportResult = {
  exportId: string
  taskId: string
  taskStatus: PublishTask["status"]
  taskFile: string
  absolutePath: string
  exportedAt: string
  bytes: number
  sha256: string
  launchStatus: AutomationTaskFileLaunchStatus
}

export type AutomationTaskSnapshotDiffEntry = {
  id: string
  path: string
  label: string
  status: "unchanged" | "added" | "removed" | "changed"
  currentValue: unknown
  snapshotValue: unknown
  currentDisplay: string
  snapshotDisplay: string
}

export type AutomationTaskSnapshotDiffSummary = {
  totalCount: number
  changedCount: number
  addedCount: number
  removedCount: number
  unchangedCount: number
  stale: boolean
}

export type AutomationTaskSnapshotDiffResult = {
  checkedAt: string
  export: AutomationTaskFileExportResult
  currentTask: Pick<PublishTask, "id" | "status" | "updatedAt">
  snapshotTask: Pick<PublishTask, "id" | "status" | "updatedAt">
  entries: AutomationTaskSnapshotDiffEntry[]
  summary: AutomationTaskSnapshotDiffSummary
}

export type AutomationFillDraftStartInput = AutomationDryRunStartInput
export type AutomationFillDraftStartResult = AutomationDryRunStartResult
export type AutomationFillDraftJob = AutomationDryRunJob
export type AutomationFillDraftJobLog = AutomationDryRunJobLog

export type AutomationSaveDraftStartInput = AutomationDryRunStartInput
export type AutomationSaveDraftStartResult = AutomationDryRunStartResult
export type AutomationSaveDraftJob = AutomationDryRunJob
export type AutomationSaveDraftJobLog = AutomationDryRunJobLog

export type AutomationSubmitListingStartInput = AutomationDryRunStartInput
export type AutomationSubmitListingStartResult = AutomationDryRunStartResult
export type AutomationSubmitListingJob = AutomationDryRunJob
export type AutomationSubmitListingJobLog = AutomationDryRunJobLog

export type CsvImportResult = {
  importedProducts: number
  importedTasks: number
  skippedRows: number
  tasks: PublishTask[]
  warnings: string[]
}

export type ManualProductInput = {
  title: string
  category: string
  supplierPriceCny: number
  estimatedDomesticShippingCny: number
  estimatedWeightKg: number
  stock: number
  skuName?: string
  skus?: Array<{
    skuName: string
    costCny: number
    stock: number
    attributes?: Record<string, string>
  }>
  sourceUrl?: string
  attributes?: Record<string, string>
  images?: string[]
}

export type ProductUpdateInput = Partial<{
  title: string
  category: string
  supplierPriceCny: number
  estimatedDomesticShippingCny: number
  estimatedWeightKg: number
  stock: number
  skuName: string
  sourceUrl: string
  attributes: Record<string, string>
  images: string[]
  skus: Array<{
    skuId?: string
    skuName: string
    costCny: number
    stock: number
    attributes?: Record<string, string>
  }>
}>

export type DraftUpdateInput = Partial<{
  listingTitle: string
  sellingPoints: string[]
  description: string
  categoryPath: string[]
  attributes: Record<string, string>
  skuPricing: Array<{
    skuId: string
    skuName?: string
    salePriceUsd?: number
    stock?: number
    attributes?: Record<string, string>
    attributeSummary?: string
  }>
}>
