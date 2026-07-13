import { useEffect, useRef, useState, type SetStateAction } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { automationSourceBucketOptions, normalizeAutomationItemUrls, normalizeAutomationSourceBuckets } from "@temu-ai-ops/shared"
import type { AutomationDryRunStartInput, AutomationFullFlowJob, AutomationManualStepBudgetTrialProposal, AutomationManualStepBudgetTrialRequestResult, AutomationPreflightReport, AutomationQueueDaemonHealth, AutomationQueueDaemonState, AutomationQueueRunStartResult, AutomationRecoveryRun, AutomationSourceBucket, AutomationTaskFileExportResult, AutomationTaskSnapshotDiffResult, AutomationUnattendedStartupCheck, DianxiaomiAccountScanLink, DianxiaomiImageCheckJob, DianxiaomiListingRequirementRules, DianxiaomiPageContext, DianxiaomiProductWorkItem, DianxiaomiSelectorConfig, DianxiaomiStoreMetrics, DraftUpdateInput, ManualProductInput, PricingRules, ProductUpdateInput, PublishCheckResult, PublishTask, SelectorCalibrationJob, SelectorConfigChangeRisk, SelectorConfigDiffResult, SelectorWorkbench } from "@temu-ai-ops/shared"
import {
  archiveStaleProfileLocks,
  createAutomationLaunchPreset,
  createManualProductTask,
  createTaskFromDianxiaomiCollectedProduct,
  createTaskFromDianxiaomiProductWorkItem,
  csvTemplateUrl,
  deleteAutomationLaunchPreset,
  exportAutomationTaskFile,
  fetchAutomationDryRunJobLog,
  fetchAutomationDryRunJobs,
  fetchAutomationFillDraftJobLog,
  fetchAutomationFillDraftJobs,
  fetchAutomationFullFlowJobs,
  fetchAutomationLaunchPresets,
  fetchAutomationQueueRuns,
  fetchAutomationRecoveryRuns,
  fetchAutomationSaveDraftJobLog,
  fetchAutomationSaveDraftJobs,
  fetchAutomationSubmitListingJobLog,
  fetchAutomationSubmitListingJobs,
  fetchAutomationTaskFileExportDiff,
  fetchAutomationTaskFileExports,
  fetchDianxiaomiAccountScanJobs,
  fetchDianxiaomiAccountScanJob,
  fetchDianxiaomiCollectedProducts,
  fetchDianxiaomiImageCheckJob,
  fetchDianxiaomiPageContext,
  fetchDianxiaomiImageCheckJobs,
  fetchDianxiaomiStoreMetrics,
  fetchDianxiaomiRequirementRules,
  fetchDianxiaomiProductWorkItems,
  importDianxiaomiAccountScanJobLinks,
  fetchAutomationPreflight,
  fetchAutomationQueueDaemon,
  fetchAutomationQueueDaemonHealth,
  fetchAutomationRepairApplyJob,
  fetchAutomationRepairApplyJobs,
  fetchAutomationRepairPreviewJobs,
  fetchAutomationReadiness,
  fetchAutomationReports,
  fetchActiveTask,
  fetchAutomationUnattendedStartupCheck,
  fetchProfileLockArchiveReadiness,
  fetchManualBudgetTrials,
  fetchPublishCheck,
  fetchPublishChecks,
  fetchPricingRules,
  fetchSelectorDiagnoses,
  fetchSelectorCalibrationJobLog,
  fetchSelectorCalibrationJobs,
  fetchSelectorConfig,
  fetchSelectorConfigVersions,
  fetchSelectorConfigValidation,
  fetchSelectorWorkbench,
  fetchTasks,
  generateSelectorConfig,
  importCsvProducts,
  importExcelProducts,
  planTask,
  syncActiveTask,
  startAutomationDryRun,
  startAutomationFillDraft,
  startAutomationFullFlow,
  startAutomationQueueRun,
  startAutomationRecoveryRun,
  startManualBudgetTrial,
  startNextManualBudgetValidationRun,
  startAutomationQueueDaemon,
  startAutomationSaveDraft,
  startAutomationSubmitListing,
  pauseAutomationQueueDaemon,
  retryDianxiaomiProductWorkItemAfterFix,
  startDianxiaomiAccountScan,
  startDianxiaomiWorkItemRepairApply,
  startDianxiaomiWorkItemRepairPreview,
  startDianxiaomiWorkItemImageCheck,
  startSelectorCalibration,
  tickAutomationQueueDaemon,
  restoreTaskDraftVersion,
  restoreSelectorConfigVersionWithInput,
  reviewTask,
  reviewTasks,
  restoreLatestAiDraftVersions,
  saveSelectorConfig,
  updatePricingRules,
  updateDianxiaomiRequirementRules,
  updateAutomationLaunchPreset,
  updateTaskDraft,
  updateTaskProduct
} from "./api"
import { useDashboardStore } from "./store"
import {
  AutomationPreflightCard,
  AutomationRunConfirmation,
  AppNavRail,
  DailyMetric,
  DailyWorkItemList,
  DianxiaomiAccountScanJobCard,
  DianxiaomiImageCheckJobCard,
  DianxiaomiAccountScanPool,
  DryRunJobCard,
  FillDraftJobCard,
  FullFlowJobCard,
  ImportResult,
  InfoBlock,
  QueueDaemonCard,
  QueueDaemonHealthCard,
  QueueRunCard,
  RepairApplyJobCard,
  RepairPreviewJobCard,
  RecoveryRunCard,
  SaveDraftJobCard,
  SelectorCalibrationJobCard,
  SelectorConfigDiffPreview,
  SelectorWorkbenchCard,
  SubmitListingJobCard,
  SummaryCard,
  TargetSurfaceSummary,
  TaskSnapshotDiffPreview,
  PodStudio,
  UnattendedStartupCheckCard
} from "./components"
import { buildSelectorConfigDiffPreview, cloneSelectorConfig, createSelectorConfigDraft, selectorDiffChangeCount } from "./lib/selector-config"
import {
  asRecord,
  automationDraftFromInput,
  buildQueueProductScopeInput,
  canRunBrowserRecovery,
  canRunFullyAutomaticRepair,
  createAutomationStartInput,
  createDianxiaomiRequirementRulesDraft,
  createListingEditDraft,
  createProductEditDraft,
  csvExample,
  defaultAutomationLaunchDraft,
  defaultDailyMediaAutomationTools,
  defaultQueueProductScopeBuckets,
  defaultManualProduct,
  formatAttributeText,
  formatLines,
  formatLogisticsTiersText,
  formatMoney,
  getErrorMessage,
  getTaskProgress,
  needsImageCheck,
  parseAttributeText,
  parseImagesText,
  parseLines,
  parseLogisticsTiersText,
  parseSkusText,
  queueProductScopeReady,
  queueProductScopeSummary,
  reviewDecisionLabel,
  reviewStatusLabel,
  statusLabel,
  taskFileLaunchClass,
  matchesSelectedQueueProductScope,
  type AutomationLaunchDraft,
  type DailyAlert,
  type ListingEditDraft,
  type ProductEditDraft,
  type QueueProductScopeMode
} from "./lib/dashboard-helpers"
import { useDailyDashboard } from "./lib/use-daily-dashboard"

type StoreScopeOption = {
  key: string
  storeId?: string
  storeName?: string
  label: string
  workItemCount: number
  readyCount: number
  collectedCount: number
  blockedCount: number
  needsRevisionCount: number
  editedCount: number
}

type StoreScopeMetrics = Pick<
  StoreScopeOption,
  "workItemCount" | "readyCount" | "collectedCount" | "blockedCount" | "needsRevisionCount" | "editedCount"
>

type BatchPrepareSummary = {
  checked: number
  repaired: number
  requeued: number
  recovered: number
  recoveryQueued: number
}

const ACTIVE_PAGE_CONTEXT_MAX_AGE_MS = 30_000
const CURRENT_STORE_SCAN_SOURCE_BUCKETS: AutomationSourceBucket[] = ["collection-box", "pending-publish"]
const ALL_STORES_SCOPE_KEY = "all"
const EMPTY_STORE_SCOPE_METRICS: StoreScopeMetrics = {
  workItemCount: 0,
  readyCount: 0,
  collectedCount: 0,
  blockedCount: 0,
  needsRevisionCount: 0,
  editedCount: 0
}

const normalizeStoreScopeValue = (value?: string | null) => value?.trim() || undefined

const createStoreScopeOptionKey = (storeId?: string, storeName?: string) =>
  storeId ? `id:${storeId}` : storeName ? `name:${storeName}` : null

const createStoreScopeNameKey = (storeName?: string) =>
  normalizeStoreScopeValue(storeName)?.toLowerCase() ?? null

const createStoreScopeDedupeKey = (storeId?: string, storeName?: string) =>
  createStoreScopeOptionKey(
    normalizeStoreScopeValue(storeId)?.toLowerCase(),
    createStoreScopeNameKey(storeName) ?? undefined
  )

const buildStoreScopeNameIndex = (
  entries: Array<{
    storeId?: string
    storeName?: string
  }>
) => {
  const nameIndex = new Map<string, Set<string>>()

  for (const entry of entries) {
    const normalizedStoreId = normalizeStoreScopeValue(entry.storeId)
    const nameKey = createStoreScopeNameKey(entry.storeName)
    if (!normalizedStoreId || !nameKey) {
      continue
    }

    const ids = nameIndex.get(nameKey) ?? new Set<string>()
    ids.add(normalizedStoreId)
    nameIndex.set(nameKey, ids)
  }

  return nameIndex
}

const resolveStoreScopeIdentity = (
  nameIndex: Map<string, Set<string>>,
  storeId?: string,
  storeName?: string
) => {
  const normalizedStoreId = normalizeStoreScopeValue(storeId)
  const normalizedStoreName = normalizeStoreScopeValue(storeName)
  if (normalizedStoreId) {
    return {
      key: createStoreScopeDedupeKey(normalizedStoreId, normalizedStoreName),
      storeId: normalizedStoreId,
      storeName: normalizedStoreName
    }
  }

  const nameKey = createStoreScopeNameKey(normalizedStoreName)
  if (!nameKey || !normalizedStoreName) {
    return null
  }

  const matchedStoreIds = nameIndex.get(nameKey)
  if (matchedStoreIds?.size === 1) {
    const [resolvedStoreId] = Array.from(matchedStoreIds)
    return {
      key: createStoreScopeDedupeKey(resolvedStoreId, normalizedStoreName),
      storeId: resolvedStoreId,
      storeName: normalizedStoreName
    }
  }

  return {
    key: createStoreScopeDedupeKey(undefined, normalizedStoreName),
    storeName: normalizedStoreName
  }
}

const createStoreScopeOption = (
  storeId?: string,
  storeName?: string,
  metrics: StoreScopeMetrics = EMPTY_STORE_SCOPE_METRICS
): StoreScopeOption | null => {
  const normalizedStoreId = normalizeStoreScopeValue(storeId)
  const normalizedStoreName = normalizeStoreScopeValue(storeName)
  const key = createStoreScopeOptionKey(normalizedStoreId, normalizedStoreName)
  if (!key) {
    return null
  }

  return {
    key,
    storeId: normalizedStoreId,
    storeName: normalizedStoreName,
    label: normalizedStoreName ?? normalizedStoreId ?? key,
    workItemCount: metrics.workItemCount,
    readyCount: metrics.readyCount,
    collectedCount: metrics.collectedCount,
    blockedCount: metrics.blockedCount,
    needsRevisionCount: metrics.needsRevisionCount,
    editedCount: metrics.editedCount
  }
}

const buildStoreScopeOptions = (
  entries: Array<{
    storeId?: string
    storeName?: string
  }>,
  metricsMap: Map<string, StoreScopeMetrics> = new Map()
) => {
  const nameIndex = buildStoreScopeNameIndex(entries)
  const optionMap = new Map<string, StoreScopeOption>()

  for (const entry of entries) {
    const identity = resolveStoreScopeIdentity(nameIndex, entry.storeId, entry.storeName)
    if (!identity?.key) {
      continue
    }

    const nextOption = createStoreScopeOption(
      identity.storeId,
      identity.storeName,
      metricsMap.get(identity.key) ?? EMPTY_STORE_SCOPE_METRICS
    )
    if (!nextOption) {
      continue
    }
    const existing = optionMap.get(identity.key)

    if (!existing || (!existing.storeId && identity.storeId)) {
      optionMap.set(identity.key, nextOption)
    }
  }

  return Array.from(optionMap.values())
    .sort((left, right) => left.label.localeCompare(right.label, "zh-CN"))
}

const buildStoreMetricsMap = (
  workItems: Array<{
    storeId?: string
    storeName?: string
    status?: string
  }>,
  collectedProducts: Array<{
    storeId?: string
    storeName?: string
  }> = []
) => {
  const nameIndex = buildStoreScopeNameIndex([...workItems, ...collectedProducts])
  const metricsMap = new Map<string, StoreScopeMetrics>()

  const ensureMetrics = (storeId?: string, storeName?: string) => {
    const identity = resolveStoreScopeIdentity(nameIndex, storeId, storeName)
    if (!identity?.key) {
      return null
    }

    const current = metricsMap.get(identity.key) ?? { ...EMPTY_STORE_SCOPE_METRICS }
    metricsMap.set(identity.key, current)
    return current
  }

  for (const item of workItems) {
    const current = ensureMetrics(item.storeId, item.storeName)
    if (!current) {
      continue
    }
    current.workItemCount += 1
    if (item.status === "ready-for-automation") {
      current.readyCount += 1
    } else if (item.status === "blocked") {
      current.blockedCount += 1
    } else if (item.status === "needs-revision") {
      current.needsRevisionCount += 1
    } else if (item.status === "edited") {
      current.editedCount += 1
    }
  }

  for (const item of collectedProducts) {
    const current = ensureMetrics(item.storeId, item.storeName)
    if (!current) {
      continue
    }
    current.collectedCount += 1
  }

  return metricsMap
}

const buildStoreMetricsMapFromSummary = (metricsList: DianxiaomiStoreMetrics[]) => {
  const nameIndex = buildStoreScopeNameIndex(metricsList)
  const metricsMap = new Map<string, StoreScopeMetrics>()

  for (const item of metricsList) {
    const identity = resolveStoreScopeIdentity(nameIndex, item.storeId, item.storeName)
    if (!identity?.key) {
      continue
    }

    const current = metricsMap.get(identity.key) ?? { ...EMPTY_STORE_SCOPE_METRICS }
    current.workItemCount += item.workItemCount
    current.readyCount += item.readyCount
    current.collectedCount += item.collectedCount
    current.blockedCount += item.blockedCount
    current.needsRevisionCount += item.needsRevisionCount
    current.editedCount += item.editedCount
    metricsMap.set(identity.key, current)
  }

  return metricsMap
}

const sumStoreScopeMetrics = (metricsMap: Map<string, StoreScopeMetrics>) => {
  const total = { ...EMPTY_STORE_SCOPE_METRICS }

  for (const metrics of metricsMap.values()) {
    total.workItemCount += metrics.workItemCount
    total.readyCount += metrics.readyCount
    total.collectedCount += metrics.collectedCount
    total.blockedCount += metrics.blockedCount
    total.needsRevisionCount += metrics.needsRevisionCount
    total.editedCount += metrics.editedCount
  }

  return total
}

const matchesStoreScopeOption = (
  option: Pick<StoreScopeOption, "storeId" | "storeName"> | null | undefined,
  item: { storeId?: string; storeName?: string } | null | undefined
) => {
  if (!option) {
    return false
  }

  const optionStoreId = normalizeStoreScopeValue(option.storeId)
  const optionStoreName = normalizeStoreScopeValue(option.storeName)
  const itemStoreId = normalizeStoreScopeValue(item?.storeId)
  const itemStoreName = normalizeStoreScopeValue(item?.storeName)

  if (optionStoreId) {
    if (itemStoreId) {
      return itemStoreId === optionStoreId
    }
    return Boolean(optionStoreName && itemStoreName && itemStoreName === optionStoreName)
  }

  if (optionStoreName) {
    return itemStoreName === optionStoreName
  }

  return false
}

const resolveDefaultReadyStoreScope = (
  options: StoreScopeOption[],
  items: Array<{ storeId?: string; storeName?: string; status?: string }>
) => items
  .filter((item) => item.status === "ready-for-automation")
  .map((item) => {
    const normalizedStoreId = normalizeStoreScopeValue(item.storeId)
    const normalizedStoreName = normalizeStoreScopeValue(item.storeName)
    if (!normalizedStoreId && !normalizedStoreName) {
      return null
    }
    return options.find((option) => matchesStoreScopeOption(option, item))
      ?? createStoreScopeOption(normalizedStoreId, normalizedStoreName)
  })
  .find((item): item is StoreScopeOption => Boolean(item))
  ?? options[0]
  ?? null

const resolveDefaultReadyStoreScopeFromMetrics = (
  options: StoreScopeOption[],
  metricsMap: Map<string, StoreScopeMetrics>
) => options.find((option) => {
  const dedupeKey = createStoreScopeDedupeKey(option.storeId, option.storeName)
  return dedupeKey ? (metricsMap.get(dedupeKey)?.readyCount ?? 0) > 0 : false
})
  ?? options[0]
  ?? null

const formatStoreScopeLabel = (option: Pick<StoreScopeOption, "label" | "storeId" | "readyCount" | "workItemCount">) =>
  `${option.label}${option.storeId ? ` (${option.storeId})` : ""} · ready ${option.readyCount} / items ${option.workItemCount}`

const formatStoreSyncTimestamp = (value?: string) => {
  if (!value) {
    return ""
  }

  const timestamp = new Date(value)
  if (!Number.isFinite(timestamp.getTime())) {
    return ""
  }

  return timestamp.toLocaleString("zh-CN", {
    hour12: false
  })
}

const normalizePageIdentity = (value?: string) =>
  value?.trim().replace(/^https?:\/\//i, "").toLowerCase() ?? ""

const summarizeImageCheckIssues = (
  items: Array<{
    snapshot: {
      imageCheck?: {
        issues?: Array<{
          category: string
          issue: string
        }>
      }
    }
  }>
) => {
  const counts = new Map<string, number>()

  for (const item of items) {
    for (const issue of item.snapshot.imageCheck?.issues ?? []) {
      const label = `${issue.category} ${issue.issue}`.trim()
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([label, count]) => `${label} x${count}`)
    .join(" / ")
}

const describeStoreQueueState = (option: StoreScopeOption) => {
  if (option.workItemCount === 0) {
    return option.collectedCount > 0
      ? `已导入待处理 ${option.collectedCount}`
      : "已识别店铺，暂无商品队列"
  }

  return `ready ${option.readyCount} / 商品 ${option.workItemCount} / blocked ${option.blockedCount}`
}

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

const resolveStoreScopeOptionFromContext = (
  context: DianxiaomiPageContext | null | undefined,
  options: StoreScopeOption[]
) => {
  const contextStoreId = normalizeStoreScopeValue(context?.storeId)
  const contextStoreName = normalizeStoreScopeValue(context?.storeName)
  if (!contextStoreId && !contextStoreName) {
    return null
  }

  if (contextStoreId) {
    const matchedById = options.find((option) => option.storeId === contextStoreId)
    if (matchedById) {
      return matchedById
    }
  }

  if (contextStoreName) {
    const matchedByName = options.find((option) => option.storeName === contextStoreName)
    if (matchedByName) {
      return matchedByName
    }
  }

  return null
}

export function App() {
  const { tasks, setTasks, activeTaskId, setActiveTaskId } = useDashboardStore()
  const [csvText, setCsvText] = useState(csvExample)
  const [selectedExcelFile, setSelectedExcelFile] = useState<File | null>(null)
  const [pricingDraft, setPricingDraft] = useState<PricingRules | null>(null)
  const [logisticsTiersText, setLogisticsTiersText] = useState("")
  const [dianxiaomiRequirementRulesDraft, setDianxiaomiRequirementRulesDraft] = useState<DianxiaomiListingRequirementRules | null>(null)
  const [dianxiaomiRecommendedKeysText, setDianxiaomiRecommendedKeysText] = useState("")
  const [dianxiaomiBlockedTermsText, setDianxiaomiBlockedTermsText] = useState("")
  const [dianxiaomiMediaToolsText, setDianxiaomiMediaToolsText] = useState("")
  const [manualProduct, setManualProduct] = useState<ManualProductInput>(defaultManualProduct)
  const [manualAttributesText, setManualAttributesText] = useState("")
  const [manualImagesText, setManualImagesText] = useState("")
  const [manualSkusText, setManualSkusText] = useState("默认规格,0,0,")
  const [productEditDraft, setProductEditDraft] = useState<ProductEditDraft | null>(null)
  const [listingEditDraft, setListingEditDraft] = useState<ListingEditDraft | null>(null)
  const [reviewNote, setReviewNote] = useState("")
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
  const [batchPublishChecks, setBatchPublishChecks] = useState<PublishCheckResult[]>([])
  const [batchRestoreMessage, setBatchRestoreMessage] = useState("")
  const [selectorConfigMessage, setSelectorConfigMessage] = useState("")
  const [selectorCalibrationMessage, setSelectorCalibrationMessage] = useState("")
  const [accountScanMessage, setAccountScanMessage] = useState("")
  const [storeScopeMessage, setStoreScopeMessage] = useState("")
  const [currentStoreImportJobId, setCurrentStoreImportJobId] = useState<string | null>(null)
  const [batchPreparePending, setBatchPreparePending] = useState(false)
  const [imageCheckMessage, setImageCheckMessage] = useState("")
  const [repairMessage, setRepairMessage] = useState("")
  const [selectedAccountScanLinkIds, setSelectedAccountScanLinkIds] = useState<string[]>([])
  const [accountScanStoreFilter, setAccountScanStoreFilter] = useState("all")
  const [accountScanBucketFilter, setAccountScanBucketFilter] = useState<"all" | AutomationSourceBucket>("all")
  const [selectorConfigDraft, setSelectorConfigDraft] = useState<DianxiaomiSelectorConfig | null>(null)
  const [automationLaunchDraft, setAutomationLaunchDraft] = useState<AutomationLaunchDraft>(defaultAutomationLaunchDraft)
  const [selectedAutomationPresetId, setSelectedAutomationPresetId] = useState("")
  const [automationPresetName, setAutomationPresetName] = useState("")
  const [automationPresetMessage, setAutomationPresetMessage] = useState("")
  const [automationTaskFileMessage, setAutomationTaskFileMessage] = useState("")
  const [selectedTaskFileExportId, setSelectedTaskFileExportId] = useState("")
  const [showBlockedTaskFiles, setShowBlockedTaskFiles] = useState(false)
  const [writeModeConfirmed, setWriteModeConfirmed] = useState(false)
  const [automationDryRunMessage, setAutomationDryRunMessage] = useState("")
  const [automationFillDraftMessage, setAutomationFillDraftMessage] = useState("")
  const [automationSaveDraftMessage, setAutomationSaveDraftMessage] = useState("")
  const [automationSubmitListingMessage, setAutomationSubmitListingMessage] = useState("")
  const [automationFullFlowMessage, setAutomationFullFlowMessage] = useState("")
  const [dailySaveDraftProofMessage, setDailySaveDraftProofMessage] = useState("")
  const [automationQueueRunMessage, setAutomationQueueRunMessage] = useState("")
  const [automationRecoveryRunMessage, setAutomationRecoveryRunMessage] = useState("")
  const [automationQueueDaemonMessage, setAutomationQueueDaemonMessage] = useState("")
  const [automationQueueDaemonInterval, setAutomationQueueDaemonInterval] = useState("60")
  const [automationQueueDaemonMaxFailures, setAutomationQueueDaemonMaxFailures] = useState("3")
  const [activeView, setActiveView] = useState<"daily" | "advanced" | "pod">("daily")
  const [advancedTab, setAdvancedTab] = useState<"work" | "intake" | "config" | "diagnostics">("work")
  const [showDailyDetails, setShowDailyDetails] = useState(false)
  const [selectedStoreScopeKey, setSelectedStoreScopeKey] = useState("auto")
  const [selectedQueueProductScopeMode, setSelectedQueueProductScopeMode] = useState<QueueProductScopeMode>("ready-queue")
  const [selectedItemUrlsText, setSelectedItemUrlsText] = useState("")
  const [selectedSourceBuckets, setSelectedSourceBuckets] = useState<AutomationSourceBucket[]>(defaultQueueProductScopeBuckets)
  const currentStoreAutoImportRef = useRef<{
    scanJobId: string
    storeId?: string
    storeName?: string
    storeScopeKey?: string
  } | null>(null)
  const automationStartInput = createAutomationStartInput(automationLaunchDraft)
  const selectedQueueProductScopeInput = buildQueueProductScopeInput(
    selectedQueueProductScopeMode,
    selectedItemUrlsText,
    selectedSourceBuckets
  )
  const selectedQueueProductScopeReady = queueProductScopeReady(
    selectedQueueProductScopeMode,
    selectedItemUrlsText,
    selectedSourceBuckets
  )
  const selectedQueueProductScopeSummary = queueProductScopeSummary(
    selectedQueueProductScopeMode,
    selectedItemUrlsText,
    selectedSourceBuckets
  )
  const automationReadinessKey = [
    automationStartInput.url ?? "",
    automationStartInput.taskFile ?? "",
    automationStartInput.selectorConfig ?? "",
    automationStartInput.profile ?? "",
    automationStartInput.mediaAutomationMode ?? "",
    automationStartInput.submitAfterSave ? "submit-after-save" : "no-submit-after-save",
    String(automationStartInput.submitMaxAttempts ?? ""),
    ...(automationStartInput.mediaAutomationTools ?? [])
  ]
  const automationStartSignature = automationReadinessKey.join("\n")

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["tasks"],
    queryFn: fetchTasks,
    refetchInterval: 10000
  })

  const { data: syncedTask, refetch: refetchSyncedTask } = useQuery({
    queryKey: ["active-task"],
    queryFn: fetchActiveTask,
    refetchInterval: 10000
  })

  const { data: automationReports = [], refetch: refetchAutomationReports } = useQuery({
    queryKey: ["automation-reports"],
    queryFn: fetchAutomationReports,
    refetchInterval: 10000
  })

  const { data: automationTaskFileExports = [], refetch: refetchAutomationTaskFileExports } = useQuery({
    queryKey: ["automation-task-file-exports"],
    queryFn: fetchAutomationTaskFileExports,
    refetchInterval: 15000
  })
  const visibleTaskFileExports = automationTaskFileExports
    .filter((item) => showBlockedTaskFiles || item.launchStatus.status !== "blocked")
    .slice(0, 6)
  const blockedTaskFileExportCount = automationTaskFileExports.filter((item) => item.launchStatus.status === "blocked").length

  const { data: allDianxiaomiCollectedProducts = [], refetch: refetchDianxiaomiCollectedProducts } = useQuery({
    queryKey: ["dianxiaomi-collected-products"],
    queryFn: fetchDianxiaomiCollectedProducts,
    refetchInterval: 10000
  })

  const { data: allDianxiaomiProductWorkItems = [], refetch: refetchAllDianxiaomiProductWorkItems } = useQuery({
    queryKey: ["dianxiaomi-product-work-items", "all"],
    queryFn: () => fetchDianxiaomiProductWorkItems({}, 1000),
    refetchInterval: 10000
  })

  const { data: dianxiaomiStoreMetricsSummary = [] } = useQuery({
    queryKey: ["dianxiaomi-store-metrics"],
    queryFn: fetchDianxiaomiStoreMetrics,
    refetchInterval: 5000
  })

  const { data: dianxiaomiPageContext } = useQuery({
    queryKey: ["dianxiaomi-page-context"],
    queryFn: fetchDianxiaomiPageContext,
    refetchInterval: 5000
  })
  const activeDianxiaomiPageContext = dianxiaomiPageContext?.updatedAt
    && Number.isFinite(new Date(dianxiaomiPageContext.updatedAt).getTime())
    && Date.now() - new Date(dianxiaomiPageContext.updatedAt).getTime() <= ACTIVE_PAGE_CONTEXT_MAX_AGE_MS
    ? dianxiaomiPageContext
    : null

  const storeMetrics = dianxiaomiStoreMetricsSummary.length > 0
    ? buildStoreMetricsMapFromSummary(dianxiaomiStoreMetricsSummary)
    : buildStoreMetricsMap(
      allDianxiaomiProductWorkItems,
      allDianxiaomiCollectedProducts
    )
  const storeScopeOptions = buildStoreScopeOptions([
    ...dianxiaomiStoreMetricsSummary.map((item) => ({
      storeId: item.storeId,
      storeName: item.storeName
    })),
    ...[...allDianxiaomiProductWorkItems, ...allDianxiaomiCollectedProducts].map((item) => {
      return {
        storeId: item.storeId,
        storeName: item.storeName
      }
    }),
    ...(dianxiaomiPageContext?.availableStores ?? []),
    {
      storeId: activeDianxiaomiPageContext?.storeId,
      storeName: activeDianxiaomiPageContext?.storeName
    }
  ], storeMetrics)
  const currentPageStoreScope = resolveStoreScopeOptionFromContext(activeDianxiaomiPageContext, storeScopeOptions)
  const currentPageStoreDisplayScope = resolveStoreScopeOptionFromContext(dianxiaomiPageContext, storeScopeOptions)
  const defaultReadyStoreScope = dianxiaomiStoreMetricsSummary.length > 0
    ? resolveDefaultReadyStoreScopeFromMetrics(storeScopeOptions, storeMetrics)
    : resolveDefaultReadyStoreScope(
      storeScopeOptions,
      allDianxiaomiProductWorkItems
    )
  const selectedStoreScopeForQuery = selectedStoreScopeKey === "auto"
    ? currentPageStoreScope ?? defaultReadyStoreScope
    : selectedStoreScopeKey === ALL_STORES_SCOPE_KEY
      ? null
      : storeScopeOptions.find((option) => option.key === selectedStoreScopeKey) ?? null
  const selectedStoreQueueInputForQuery = selectedStoreScopeForQuery
    ? {
        storeId: selectedStoreScopeForQuery.storeId,
        storeName: selectedStoreScopeForQuery.storeName
      }
    : {}
  const selectedQueueScopeInputForQuery = {
    ...selectedStoreQueueInputForQuery,
    ...selectedQueueProductScopeInput
  }
  const scopeFilterEnabled = selectedQueueProductScopeMode === "ready-queue" || selectedQueueProductScopeReady
  const {
    data: scopedDianxiaomiProductWorkItems = [],
    refetch: refetchScopedDianxiaomiProductWorkItems,
    isError: dianxiaomiProductWorkItemsError,
    error: dianxiaomiProductWorkItemsQueryError
  } = useQuery({
    queryKey: [
      "dianxiaomi-product-work-items",
      "scope",
      selectedStoreQueueInputForQuery.storeId ?? "",
      selectedStoreQueueInputForQuery.storeName ?? "",
      selectedQueueProductScopeMode,
      (selectedQueueProductScopeInput.itemUrls ?? []).join("|"),
      (selectedQueueProductScopeInput.sourceBuckets ?? []).join("|")
    ],
    queryFn: () => scopeFilterEnabled ? fetchDianxiaomiProductWorkItems(selectedQueueScopeInputForQuery, 1000) : Promise.resolve([]),
    enabled: scopeFilterEnabled,
    refetchInterval: 10000
  })
  const refetchDianxiaomiProductWorkItems = async () => {
    const [scopedResult] = await Promise.all([
      refetchScopedDianxiaomiProductWorkItems(),
      refetchAllDianxiaomiProductWorkItems()
    ])
    return scopedResult
  }

  const { data: dianxiaomiRequirementRules, refetch: refetchDianxiaomiRequirementRules } = useQuery({
    queryKey: ["dianxiaomi-requirement-rules"],
    queryFn: fetchDianxiaomiRequirementRules
  })

  const { data: selectedTaskFileExportDiff } = useQuery({
    queryKey: ["automation-task-file-export-diff", selectedTaskFileExportId],
    queryFn: () => fetchAutomationTaskFileExportDiff(selectedTaskFileExportId),
    enabled: Boolean(selectedTaskFileExportId),
    refetchInterval: selectedTaskFileExportId ? 15000 : false
  })

  const { data: automationLaunchPresets = [], refetch: refetchAutomationLaunchPresets } = useQuery({
    queryKey: ["automation-launch-presets"],
    queryFn: fetchAutomationLaunchPresets,
    refetchInterval: 15000
  })

  const { data: automationReadiness, refetch: refetchAutomationReadiness } = useQuery({
    queryKey: ["automation-readiness", ...automationReadinessKey],
    queryFn: () => fetchAutomationReadiness(automationStartInput),
    refetchInterval: 3000
  })

  const { data: automationPreflight, refetch: refetchAutomationPreflight } = useQuery({
    queryKey: ["automation-preflight", ...automationReadinessKey],
    queryFn: () => fetchAutomationPreflight(automationStartInput),
    refetchInterval: 3000
  })

  const { data: automationDryRunJobs = [], refetch: refetchAutomationDryRunJobs } = useQuery({
    queryKey: ["automation-dry-run-jobs"],
    queryFn: fetchAutomationDryRunJobs,
    refetchInterval: 3000
  })

  const { data: automationFullFlowJobs = [], refetch: refetchAutomationFullFlowJobs } = useQuery({
    queryKey: ["automation-full-flow-jobs"],
    queryFn: fetchAutomationFullFlowJobs,
    refetchInterval: 3000
  })

  const { data: automationQueueRuns = [], refetch: refetchAutomationQueueRuns, isError: automationQueueRunsError, error: automationQueueRunsQueryError } = useQuery({
    queryKey: ["automation-queue-runs"],
    queryFn: fetchAutomationQueueRuns,
    refetchInterval: 5000
  })

  const { data: automationRecoveryRuns = [], refetch: refetchAutomationRecoveryRuns } = useQuery({
    queryKey: ["automation-recovery-runs"],
    queryFn: fetchAutomationRecoveryRuns,
    refetchInterval: 5000
  })

  const { data: automationQueueDaemon, refetch: refetchAutomationQueueDaemon, isError: automationQueueDaemonError, error: automationQueueDaemonQueryError } = useQuery({
    queryKey: ["automation-queue-daemon"],
    queryFn: fetchAutomationQueueDaemon,
    refetchInterval: 3000
  })

  const { data: automationQueueDaemonHealth, refetch: refetchAutomationQueueDaemonHealth, isError: automationQueueDaemonHealthError, error: automationQueueDaemonHealthQueryError } = useQuery({
    queryKey: [
      "automation-queue-daemon-health",
      ...automationReadinessKey,
      selectedStoreScopeKey,
      selectedStoreQueueInputForQuery.storeId ?? "",
      selectedStoreQueueInputForQuery.storeName ?? "",
      selectedQueueProductScopeMode,
      (selectedQueueProductScopeInput.itemUrls ?? []).join("|"),
      (selectedQueueProductScopeInput.sourceBuckets ?? []).join("|")
    ],
    queryFn: () => fetchAutomationQueueDaemonHealth({
      ...automationStartInput,
      ...selectedQueueScopeInputForQuery
    }),
    refetchInterval: 3000
  })

  const { data: profileLockArchiveReadiness, refetch: refetchProfileLockArchiveReadiness } = useQuery({
    queryKey: ["profile-lock-archive-readiness", ...automationReadinessKey],
    queryFn: () => fetchProfileLockArchiveReadiness(automationStartInput),
    refetchInterval: 5000
  })

  const { data: manualBudgetTrials = [], refetch: refetchManualBudgetTrials } = useQuery<AutomationManualStepBudgetTrialRequestResult[]>({
    queryKey: ["manual-budget-trials"],
    queryFn: () => fetchManualBudgetTrials(20),
    refetchInterval: 5000
  })

  const { data: automationUnattendedStartupCheck, refetch: refetchAutomationUnattendedStartupCheck, isError: automationUnattendedStartupCheckError, error: automationUnattendedStartupCheckQueryError } = useQuery({
    queryKey: [
      "automation-unattended-startup-check",
      ...automationReadinessKey,
      selectedStoreScopeKey,
      selectedStoreQueueInputForQuery.storeId ?? "",
      selectedStoreQueueInputForQuery.storeName ?? "",
      selectedQueueProductScopeMode,
      (selectedQueueProductScopeInput.itemUrls ?? []).join("|"),
      (selectedQueueProductScopeInput.sourceBuckets ?? []).join("|")
    ],
    queryFn: () => fetchAutomationUnattendedStartupCheck({
      ...automationStartInput,
      ...selectedQueueScopeInputForQuery
    }),
    refetchInterval: 5000
  })

  const { data: automationFillDraftJobs = [], refetch: refetchAutomationFillDraftJobs } = useQuery({
    queryKey: ["automation-fill-draft-jobs"],
    queryFn: fetchAutomationFillDraftJobs,
    refetchInterval: 3000
  })

  const { data: automationRepairPreviewJobs = [], refetch: refetchAutomationRepairPreviewJobs } = useQuery({
    queryKey: ["automation-repair-preview-jobs"],
    queryFn: fetchAutomationRepairPreviewJobs,
    refetchInterval: 3000
  })

  const { data: automationRepairApplyJobs = [], refetch: refetchAutomationRepairApplyJobs } = useQuery({
    queryKey: ["automation-repair-apply-jobs"],
    queryFn: fetchAutomationRepairApplyJobs,
    refetchInterval: 3000
  })

  const { data: automationSaveDraftJobs = [], refetch: refetchAutomationSaveDraftJobs } = useQuery({
    queryKey: ["automation-save-draft-jobs"],
    queryFn: fetchAutomationSaveDraftJobs,
    refetchInterval: 3000
  })

  const { data: automationSubmitListingJobs = [], refetch: refetchAutomationSubmitListingJobs } = useQuery({
    queryKey: ["automation-submit-listing-jobs"],
    queryFn: fetchAutomationSubmitListingJobs,
    refetchInterval: 3000
  })

  const { data: selectorDiagnoses = [] } = useQuery({
    queryKey: ["selector-diagnoses"],
    queryFn: fetchSelectorDiagnoses,
    refetchInterval: 15000
  })

  const { data: selectorCalibrationJobs = [], refetch: refetchSelectorCalibrationJobs } = useQuery({
    queryKey: ["selector-calibration-jobs"],
    queryFn: fetchSelectorCalibrationJobs,
    refetchInterval: 3000
  })

  const { data: dianxiaomiAccountScanJobs = [], refetch: refetchDianxiaomiAccountScanJobs } = useQuery({
    queryKey: ["dianxiaomi-account-scan-jobs"],
    queryFn: fetchDianxiaomiAccountScanJobs,
    refetchInterval: 3000
  })

  const { data: dianxiaomiImageCheckJobs = [], refetch: refetchDianxiaomiImageCheckJobs } = useQuery({
    queryKey: ["dianxiaomi-image-check-jobs"],
    queryFn: fetchDianxiaomiImageCheckJobs,
    refetchInterval: 3000
  })

  const latestCompletedAccountScanJob = dianxiaomiAccountScanJobs.find((job) => job.status === "completed" && job.result) ?? null
  const latestCurrentPageStoreScanJob = dianxiaomiAccountScanJobs.find((job) => {
    if (job.status !== "completed" || !job.result || !currentPageStoreScope) {
      return false
    }

    return job.result.stores.some((store) => matchesStoreScopeOption(currentPageStoreScope, {
      storeId: store.shopId ?? undefined,
      storeName: store.storeName
    }))
  }) ?? null
  const existingWorkItemEditUrlSet = new Set(
    allDianxiaomiProductWorkItems.map((item) => item.pageUrl.trim().toLowerCase())
  )
  const currentPageStoreScanLinks = latestCurrentPageStoreScanJob?.result?.stores
    .filter((store) => matchesStoreScopeOption(currentPageStoreScope, {
      storeId: store.shopId ?? undefined,
      storeName: store.storeName
    }))
    .flatMap((store) => store.links) ?? []
  const currentPageStoreImportableLinks = currentPageStoreScanLinks.filter((link) => !existingWorkItemEditUrlSet.has(link.editUrl.trim().toLowerCase()))

  const { data: selectorConfig, refetch: refetchSelectorConfig } = useQuery({
    queryKey: ["selector-config"],
    queryFn: fetchSelectorConfig,
    refetchInterval: 15000
  })

  const { data: selectorConfigValidation, refetch: refetchSelectorConfigValidation } = useQuery({
    queryKey: ["selector-config-validation"],
    queryFn: fetchSelectorConfigValidation,
    refetchInterval: 15000
  })

  const { data: selectorWorkbench, refetch: refetchSelectorWorkbench } = useQuery({
    queryKey: ["selector-workbench"],
    queryFn: fetchSelectorWorkbench,
    refetchInterval: 5000
  })

  const { data: selectorConfigVersions = [], refetch: refetchSelectorConfigVersions } = useQuery({
    queryKey: ["selector-config-versions"],
    queryFn: fetchSelectorConfigVersions,
    refetchInterval: 15000
  })

  const { data: pricingRules, refetch: refetchPricingRules } = useQuery({
    queryKey: ["pricing-rules"],
    queryFn: fetchPricingRules
  })

  const selectorDraftSourceSignature = selectorWorkbench
    ? JSON.stringify({
      config: selectorWorkbench.config.config,
      diagnosisPath: selectorWorkbench.diagnosis?.diagnosisPath ?? null
    })
    : ""

  useEffect(() => {
    if (pricingRules) {
      setPricingDraft(pricingRules)
      setLogisticsTiersText(formatLogisticsTiersText(pricingRules.logisticsRateTiers ?? []))
    }
  }, [pricingRules])

  useEffect(() => {
    if (dianxiaomiRequirementRules) {
      setDianxiaomiRequirementRulesDraft(createDianxiaomiRequirementRulesDraft(dianxiaomiRequirementRules))
      setDianxiaomiRecommendedKeysText(formatLines(dianxiaomiRequirementRules.attributes.recommendedKeys))
      setDianxiaomiBlockedTermsText(formatLines(dianxiaomiRequirementRules.compliance.blockedTerms))
      setDianxiaomiMediaToolsText(formatLines(dianxiaomiRequirementRules.media.dianxiaomiTools))
    }
  }, [dianxiaomiRequirementRules])

  useEffect(() => {
    if (data) {
      setTasks(data)
      if (!activeTaskId) {
        setActiveTaskId(syncedTask?.id ?? data[0]?.id ?? "")
      }
    }
  }, [data, syncedTask, activeTaskId, setActiveTaskId, setTasks])

  useEffect(() => {
    if (selectorWorkbench) {
      setSelectorConfigDraft(createSelectorConfigDraft(selectorWorkbench))
    }
  }, [selectorDraftSourceSignature])

  useEffect(() => {
    setWriteModeConfirmed(false)
  }, [automationStartSignature])

  const runCurrentStoreScan = async () => {
    if (!activeDianxiaomiPageContext) {
      throw new Error("未识别店小秘页面店铺，请先打开对应店铺页面")
    }

    const result = await dianxiaomiAccountScanner.mutateAsync({
      headed: false,
      sourceBuckets: CURRENT_STORE_SCAN_SOURCE_BUCKETS,
      maxPages: 100,
      storeId: activeDianxiaomiPageContext.storeId,
      storeName: activeDianxiaomiPageContext.storeName
    })

    currentStoreAutoImportRef.current = {
      scanJobId: result.id,
      storeId: activeDianxiaomiPageContext.storeId,
      storeName: activeDianxiaomiPageContext.storeName,
      storeScopeKey: currentPageStoreScope?.key
    }
    setCurrentStoreImportJobId(result.id)
    setAccountScanMessage("正在扫描当前店铺并自动导入链接，适合批量采集商品。")
    return result
  }

  const importCurrentStoreLinksFromJob = async (jobId: string, override?: {
    storeId?: string
    storeName?: string
    storeScopeKey?: string
  }) => {
    const targetStoreId = override?.storeId ?? activeDianxiaomiPageContext?.storeId
    const targetStoreName = override?.storeName ?? activeDianxiaomiPageContext?.storeName
    if (!targetStoreId && !targetStoreName) {
      throw new Error("未识别店小秘页面店铺，无法导入该页面店铺链接")
    }

    return dianxiaomiAccountScanImporter.mutateAsync({
      jobId,
      storeId: targetStoreId,
      storeName: targetStoreName,
      sourceBuckets: CURRENT_STORE_SCAN_SOURCE_BUCKETS,
      storeScopeKey: override?.storeScopeKey ?? currentPageStoreScope?.key
    })
  }

  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? tasks[0]
  const selectedAutomationPreset = automationLaunchPresets.find((preset) => preset.id === selectedAutomationPresetId) ?? null
  const canStartFillDraft = (automationReadiness?.fillDraft.ready ?? false) && writeModeConfirmed
  const canStartSaveDraft = (automationReadiness?.saveDraft.ready ?? false) && writeModeConfirmed
  const canStartSubmitListing = (automationReadiness?.submitListing.ready ?? false) && writeModeConfirmed
  const automationGateItems = [
    {
      label: "Dry run",
      readiness: automationReadiness?.dryRun
    },
    {
      label: "Repair preview",
      readiness: automationReadiness?.repairPreview
    },
    {
      label: "Repair apply",
      readiness: automationReadiness?.repairApply
    },
    {
      label: "Fill draft",
      readiness: automationReadiness?.fillDraft
    },
    {
      label: "Save draft",
      readiness: automationReadiness?.saveDraft
    },
    {
      label: "Submit listing",
      readiness: automationReadiness?.submitListing
    }
  ]

  const { data: publishCheck } = useQuery({
    queryKey: ["publish-check", activeTask?.id],
    queryFn: () => fetchPublishCheck(activeTask!.id),
    enabled: Boolean(activeTask?.id),
    refetchInterval: 15000
  })

  useEffect(() => {
    if (activeTask) {
      setProductEditDraft(createProductEditDraft(activeTask))
      setListingEditDraft(createListingEditDraft(activeTask))
    }
  }, [activeTask?.id, activeTask?.updatedAt])

  const syncer = useMutation({
    mutationFn: syncActiveTask,
    onSuccess: async (task) => {
      setActiveTaskId(task.id)
      await refetchSyncedTask()
    }
  })

  const planner = useMutation({
    mutationFn: planTask,
    onSuccess: async () => {
      await refetch()
      await refetchSyncedTask()
    }
  })

  const csvImporter = useMutation({
    mutationFn: importCsvProducts,
    onSuccess: async (result) => {
      await refetch()
      await refetchSyncedTask()
      if (result.tasks[0]) {
        setActiveTaskId(result.tasks[0].id)
      }
    }
  })

  const excelImporter = useMutation({
    mutationFn: importExcelProducts,
    onSuccess: async (result) => {
      await refetch()
      await refetchSyncedTask()
      if (result.tasks[0]) {
        setActiveTaskId(result.tasks[0].id)
      }
    }
  })

  const pricingUpdater = useMutation({
    mutationFn: updatePricingRules,
    onSuccess: async () => {
      await refetchPricingRules()
      await refetch()
    }
  })

  const dianxiaomiRequirementRulesUpdater = useMutation({
    mutationFn: updateDianxiaomiRequirementRules,
    onSuccess: async () => {
      await refetchDianxiaomiRequirementRules()
      await refetchDianxiaomiProductWorkItems()
      await refetch()
    }
  })

  const manualCreator = useMutation({
    mutationFn: createManualProductTask,
    onSuccess: async (task) => {
      await refetch()
      await refetchSyncedTask()
      setActiveTaskId(task.id)
      setManualProduct(defaultManualProduct)
      setManualAttributesText("")
      setManualImagesText("")
      setManualSkusText("默认规格,0,0,")
    }
  })

  const dianxiaomiCollectedTaskCreator = useMutation({
    mutationFn: createTaskFromDianxiaomiCollectedProduct,
    onSuccess: async (result) => {
      setActiveTaskId(result.task.id)
      await refetch()
      await refetchSyncedTask()
      await refetchDianxiaomiCollectedProducts()
    }
  })

  const dianxiaomiWorkItemTaskCreator = useMutation({
    mutationFn: createTaskFromDianxiaomiProductWorkItem,
    onSuccess: async (result) => {
      setActiveTaskId(result.task.id)
      setAutomationLaunchDraft((current) => ({
        ...current,
        url: result.workItem.pageUrl || current.url
      }))
      await refetch()
      await refetchSyncedTask()
      await refetchDianxiaomiProductWorkItems()
    }
  })

  const dianxiaomiWorkItemRetryAfterFixer = useMutation({
    mutationFn: retryDianxiaomiProductWorkItemAfterFix,
    onSuccess: async () => {
      await refetchDianxiaomiProductWorkItems()
      await refetchAutomationQueueDaemonHealth()
      await refetchAutomationUnattendedStartupCheck()
    }
  })

  const productUpdater = useMutation({
    mutationFn: updateTaskProduct,
    onSuccess: async (task) => {
      setActiveTaskId(task.id)
      await refetch()
      await refetchSyncedTask()
    }
  })

  const draftUpdater = useMutation({
    mutationFn: updateTaskDraft,
    onSuccess: async (task) => {
      setActiveTaskId(task.id)
      await refetch()
      await refetchSyncedTask()
    }
  })

  const draftRestorer = useMutation({
    mutationFn: restoreTaskDraftVersion,
    onSuccess: async (task) => {
      setActiveTaskId(task.id)
      await refetch()
      await refetchSyncedTask()
    }
  })

  const reviewer = useMutation({
    mutationFn: reviewTask,
    onSuccess: async (task) => {
      setActiveTaskId(task.id)
      setReviewNote("")
      await refetch()
      await refetchSyncedTask()
    }
  })

  const batchReviewer = useMutation({
    mutationFn: reviewTasks,
    onSuccess: async (tasks) => {
      if (tasks[0]) {
        setActiveTaskId(tasks[0].id)
      }
      setSelectedTaskIds([])
      setReviewNote("")
      await refetch()
      await refetchSyncedTask()
    }
  })

  const batchPublishChecker = useMutation({
    mutationFn: fetchPublishChecks,
    onSuccess: (checks) => {
      setBatchPublishChecks(checks)
    }
  })

  const batchDraftRestorer = useMutation({
    mutationFn: restoreLatestAiDraftVersions,
    onSuccess: async (result) => {
      if (result.restored[0]) {
        setActiveTaskId(result.restored[0].id)
      }
      setBatchRestoreMessage(`已恢复 ${result.restored.length} 个任务，跳过 ${result.skipped.length} 个任务`)
      setSelectedTaskIds([])
      await refetch()
      await refetchSyncedTask()
    }
  })

  const automationPresetCreator = useMutation({
    mutationFn: createAutomationLaunchPreset,
    onSuccess: async (preset) => {
      setSelectedAutomationPresetId(preset.id)
      setAutomationPresetName(preset.name)
      setAutomationLaunchDraft(automationDraftFromInput(preset.input))
      setAutomationPresetMessage(`preset saved: ${preset.name}`)
      await refetchAutomationLaunchPresets()
    },
    onError: (error) => {
      setAutomationPresetMessage(getErrorMessage(error))
    }
  })

  const automationPresetUpdater = useMutation({
    mutationFn: updateAutomationLaunchPreset,
    onSuccess: async (preset) => {
      setSelectedAutomationPresetId(preset.id)
      setAutomationPresetName(preset.name)
      setAutomationLaunchDraft(automationDraftFromInput(preset.input))
      setAutomationPresetMessage(`preset updated: ${preset.name}`)
      await refetchAutomationLaunchPresets()
    },
    onError: (error) => {
      setAutomationPresetMessage(getErrorMessage(error))
    }
  })

  const automationPresetDeleter = useMutation({
    mutationFn: deleteAutomationLaunchPreset,
    onSuccess: async () => {
      setSelectedAutomationPresetId("")
      setAutomationPresetName("")
      setAutomationPresetMessage("preset deleted")
      await refetchAutomationLaunchPresets()
    },
    onError: (error) => {
      setAutomationPresetMessage(getErrorMessage(error))
    }
  })

  const automationTaskFileExporter = useMutation({
    mutationFn: exportAutomationTaskFile,
    onSuccess: async (result) => {
      setAutomationLaunchDraft((current) => ({
        ...current,
        taskFile: result.taskFile
      }))
      setAutomationTaskFileMessage(`task file refreshed: ${result.taskFile}`)
      setSelectedTaskFileExportId(result.exportId)
      await refetchAutomationTaskFileExports()
      await refetchAutomationReadiness()
      await refetchAutomationPreflight()
    },
    onError: (error) => {
      setAutomationTaskFileMessage(getErrorMessage(error))
    }
  })

  const automationDryRunner = useMutation({
    mutationFn: startAutomationDryRun,
    onSuccess: async (result) => {
      setAutomationDryRunMessage(`dry-run started: ${result.logPath}`)
      await refetchAutomationDryRunJobs()
      await refetchAutomationReports()
      await refetchAutomationReadiness()
      await refetchAutomationPreflight()
    },
    onError: async (error) => {
      setAutomationDryRunMessage(getErrorMessage(error))
      await refetchAutomationReadiness()
      await refetchAutomationPreflight()
    }
  })

  const automationFullFlowRunner = useMutation({
    mutationFn: startAutomationFullFlow,
    onSuccess: async (result) => {
      setAutomationFullFlowMessage(`full-flow started: ${result.artifactDir}`)
      await refetchAutomationFullFlowJobs()
      await refetchAutomationDryRunJobs()
      await refetchAutomationFillDraftJobs()
      await refetchAutomationSaveDraftJobs()
      await refetchAutomationSubmitListingJobs()
      await refetchAutomationReports()
      await refetchAutomationReadiness()
      await refetchAutomationPreflight()
    },
    onError: async (error) => {
      setAutomationFullFlowMessage(getErrorMessage(error))
      await refetchAutomationReadiness()
      await refetchAutomationPreflight()
    }
  })

  const dailySaveDraftProofRunner = useMutation({
    mutationFn: async ({ workItemId }: { workItemId: string }) => {
      const workItem = allDianxiaomiProductWorkItems.find((item) => item.id === workItemId)
      if (!workItem) {
        throw new Error("当前待验证商品不存在，请刷新队列后重试")
      }

      const taskResult = await createTaskFromDianxiaomiProductWorkItem(workItemId)
      const exported = await exportAutomationTaskFile({
        taskId: taskResult.task.id,
        input: {}
      })
      const flow = await startAutomationFullFlow({
        ...automationStartInput,
        url: workItem.pageUrl,
        taskFile: exported.taskFile,
        mediaAutomationMode: "unattended-apply",
        mediaAutomationTools: dailyMediaAutomationTools,
        submitAfterSave: false
      })

      return {
        workItem,
        exported,
        flow
      }
    },
    onMutate: ({ workItemId }) => {
      const workItem = allDianxiaomiProductWorkItems.find((item) => item.id === workItemId)
      setDailySaveDraftProofMessage(`正在准备保存草稿验证：${workItem?.title ?? workItemId}`)
    },
    onSuccess: async ({ workItem, exported, flow }) => {
      setSelectedTaskFileExportId(exported.exportId)
      setDailySaveDraftProofMessage(`已启动保存草稿验证：${workItem.title}`)
      setAutomationFullFlowMessage(`save-draft proof started: ${flow.artifactDir}`)
      await refetch()
      await refetchAutomationTaskFileExports()
      await refetchAutomationFullFlowJobs()
      await refetchAutomationDryRunJobs()
      await refetchAutomationFillDraftJobs()
      await refetchAutomationSaveDraftJobs()
      await refetchAutomationReports()
      await refetchDianxiaomiProductWorkItems()
    },
    onError: (error) => {
      setDailySaveDraftProofMessage(getErrorMessage(error))
    }
  })

  const automationQueueRunner = useMutation({
    mutationFn: startAutomationQueueRun,
    onSuccess: async (result) => {
      const retrySummary = result.autoRetryReleasedIds.length > 0
        ? `, released ${result.autoRetryReleasedIds.length} safe recovery item(s)`
        : ""
      setAutomationQueueRunMessage(`queue-run started ${result.queued} full-flow jobs, skipped ${result.skipped}${retrySummary}`)
      await refetchAutomationQueueRuns()
      await refetchAutomationFullFlowJobs()
      await refetchAutomationDryRunJobs()
      await refetchAutomationFillDraftJobs()
      await refetchAutomationSaveDraftJobs()
      await refetchAutomationSubmitListingJobs()
      await refetchAutomationReports()
      await refetchDianxiaomiProductWorkItems()
      await refetchAutomationReadiness()
      await refetchAutomationPreflight()
      await refetchAutomationQueueDaemon()
      await refetchAutomationQueueDaemonHealth()
      await refetchAutomationUnattendedStartupCheck()
    },
    onError: async (error) => {
      setAutomationQueueRunMessage(getErrorMessage(error))
      await refetchAutomationQueueRuns()
    }
  })

  const automationRecoveryRunner = useMutation({
    mutationFn: startAutomationRecoveryRun,
    onSuccess: async (result) => {
      setAutomationRecoveryRunMessage(`自动恢复已启动：发起 ${result.queued} 个，跳过 ${result.skipped} 个。`)
      await refetchAutomationRecoveryRuns()
      await refetchAutomationFullFlowJobs()
      await refetchAutomationDryRunJobs()
      await refetchAutomationFillDraftJobs()
      await refetchAutomationSaveDraftJobs()
      await refetchAutomationSubmitListingJobs()
      await refetchAutomationReports()
      await refetchDianxiaomiProductWorkItems()
      await refetchAutomationQueueDaemonHealth()
      await refetchAutomationUnattendedStartupCheck()
    },
    onError: async (error) => {
      setAutomationRecoveryRunMessage(getErrorMessage(error))
      await refetchAutomationRecoveryRuns()
    }
  })

  const manualBudgetTrialRunner = useMutation({
    mutationFn: startManualBudgetTrial,
    onSuccess: async (result) => {
      const flowSummary = result.flowJobIds.length > 0 ? `, flows ${result.flowJobIds.length}` : ""
      const skippedSummary = result.skippedItems.length > 0 ? `, skipped ${result.skippedItems.length}` : ""
      setAutomationQueueDaemonMessage(`manual-budget trial ${result.status}: ${result.message}${flowSummary}${skippedSummary}`)
      await refetchAutomationFullFlowJobs()
      await refetchAutomationDryRunJobs()
      await refetchAutomationFillDraftJobs()
      await refetchAutomationSaveDraftJobs()
      await refetchAutomationSubmitListingJobs()
      await refetchAutomationReports()
      await refetchDianxiaomiProductWorkItems()
      await refetchAutomationQueueDaemon()
      await refetchAutomationQueueDaemonHealth()
      await refetchManualBudgetTrials()
      await refetchAutomationUnattendedStartupCheck()
    },
    onError: async (error) => {
      setAutomationQueueDaemonMessage(getErrorMessage(error))
      await refetchManualBudgetTrials()
      await refetchAutomationQueueDaemonHealth()
      await refetchAutomationUnattendedStartupCheck()
    }
  })

  const manualBudgetValidationRunner = useMutation({
    mutationFn: startNextManualBudgetValidationRun,
    onSuccess: async (result) => {
      const flowSummary = result.flowJobIds.length > 0 ? `, flows ${result.flowJobIds.length}` : ""
      const skippedSummary = result.skippedItems.length > 0 ? `, skipped ${result.skippedItems.length}` : ""
      setAutomationQueueDaemonMessage(`manual-budget validation ${result.status}: ${result.message}${flowSummary}${skippedSummary}`)
      await refetchAutomationFullFlowJobs()
      await refetchAutomationDryRunJobs()
      await refetchAutomationFillDraftJobs()
      await refetchAutomationSaveDraftJobs()
      await refetchAutomationSubmitListingJobs()
      await refetchAutomationReports()
      await refetchDianxiaomiProductWorkItems()
      await refetchAutomationQueueDaemon()
      await refetchAutomationQueueDaemonHealth()
      await refetchManualBudgetTrials()
      await refetchAutomationUnattendedStartupCheck()
    },
    onError: async (error) => {
      setAutomationQueueDaemonMessage(getErrorMessage(error))
      await refetchManualBudgetTrials()
      await refetchAutomationQueueDaemonHealth()
      await refetchAutomationUnattendedStartupCheck()
    }
  })

  const profileLockArchiver = useMutation({
    mutationFn: archiveStaleProfileLocks,
    onSuccess: async (result) => {
      setAutomationQueueDaemonMessage(`profile lock archive ${result.status}: ${result.message}`)
      await refetchAutomationQueueDaemon()
      await refetchAutomationQueueDaemonHealth()
      await refetchProfileLockArchiveReadiness()
      await refetchAutomationUnattendedStartupCheck()
    },
    onError: async (error) => {
      setAutomationQueueDaemonMessage(getErrorMessage(error))
      await refetchAutomationQueueDaemonHealth()
      await refetchProfileLockArchiveReadiness()
      await refetchAutomationUnattendedStartupCheck()
    }
  })

  const automationQueueDaemonStarter = useMutation({
    mutationFn: startAutomationQueueDaemon,
    onSuccess: async (state) => {
      setAutomationQueueDaemonMessage(`queue daemon ${state.status.toLowerCase()}: interval ${state.intervalSeconds}s`)
      await refetchAutomationQueueDaemon()
      await refetchAutomationQueueDaemonHealth()
      await refetchAutomationUnattendedStartupCheck()
      await refetchAutomationQueueRuns()
      await refetchAutomationFullFlowJobs()
      await refetchDianxiaomiProductWorkItems()
    },
    onError: async (error) => {
      setAutomationQueueDaemonMessage(getErrorMessage(error))
      await refetchAutomationQueueDaemon()
      await refetchAutomationQueueDaemonHealth()
      await refetchAutomationUnattendedStartupCheck()
    }
  })

  const automationQueueDaemonPauser = useMutation({
    mutationFn: pauseAutomationQueueDaemon,
    onSuccess: async (state) => {
      setAutomationQueueDaemonMessage(`queue daemon ${state.status.toLowerCase()}`)
      await refetchAutomationQueueDaemon()
      await refetchAutomationQueueDaemonHealth()
      await refetchAutomationUnattendedStartupCheck()
    },
    onError: async (error) => {
      setAutomationQueueDaemonMessage(getErrorMessage(error))
      await refetchAutomationQueueDaemon()
      await refetchAutomationQueueDaemonHealth()
      await refetchAutomationUnattendedStartupCheck()
    }
  })

  const automationQueueDaemonTicker = useMutation({
    mutationFn: tickAutomationQueueDaemon,
    onSuccess: async (tick) => {
      setAutomationQueueDaemonMessage(`queue daemon tick ${tick.status}: ${tick.reason ?? tick.error ?? "done"}`)
      await refetchAutomationQueueDaemon()
      await refetchAutomationQueueDaemonHealth()
      await refetchAutomationUnattendedStartupCheck()
      await refetchAutomationQueueRuns()
      await refetchAutomationFullFlowJobs()
      await refetchDianxiaomiProductWorkItems()
    },
    onError: async (error) => {
      setAutomationQueueDaemonMessage(getErrorMessage(error))
      await refetchAutomationQueueDaemon()
      await refetchAutomationQueueDaemonHealth()
      await refetchAutomationUnattendedStartupCheck()
    }
  })

  const automationFillDraftRunner = useMutation({
    mutationFn: startAutomationFillDraft,
    onSuccess: async (result) => {
      setAutomationFillDraftMessage(`fill-draft started: ${result.logPath}`)
      await refetchAutomationFillDraftJobs()
      await refetchAutomationReports()
      await refetchAutomationReadiness()
      await refetchAutomationPreflight()
    },
    onError: async (error) => {
      setAutomationFillDraftMessage(getErrorMessage(error))
      await refetchAutomationReadiness()
      await refetchAutomationPreflight()
    }
  })

  const automationSaveDraftRunner = useMutation({
    mutationFn: startAutomationSaveDraft,
    onSuccess: async (result) => {
      setAutomationSaveDraftMessage(`save-draft started: ${result.logPath}`)
      await refetchAutomationSaveDraftJobs()
      await refetchAutomationReports()
      await refetchAutomationReadiness()
      await refetchAutomationPreflight()
    },
    onError: async (error) => {
      setAutomationSaveDraftMessage(getErrorMessage(error))
      await refetchAutomationReadiness()
      await refetchAutomationPreflight()
    }
  })

  const automationSubmitListingRunner = useMutation({
    mutationFn: startAutomationSubmitListing,
    onSuccess: async (result) => {
      setAutomationSubmitListingMessage(`submit-listing started: ${result.logPath}`)
      await refetchAutomationSubmitListingJobs()
      await refetchAutomationReports()
      await refetchAutomationReadiness()
      await refetchAutomationPreflight()
    },
    onError: async (error) => {
      setAutomationSubmitListingMessage(getErrorMessage(error))
      await refetchAutomationReadiness()
      await refetchAutomationPreflight()
    }
  })

  const selectorConfigSaver = useMutation({
    mutationFn: saveSelectorConfig,
    onSuccess: async (result) => {
      setSelectorConfigMessage(`selector config saved: ${result.configPath}`)
      setSelectorConfigDraft(cloneSelectorConfig(result.config))
      await refetchSelectorConfig()
      await refetchSelectorConfigValidation()
      await refetchSelectorWorkbench()
      await refetchSelectorConfigVersions()
      await refetchAutomationPreflight()
    },
    onError: (error) => {
      setSelectorConfigMessage(getErrorMessage(error))
    }
  })

  const selectorConfigRestorer = useMutation({
    mutationFn: restoreSelectorConfigVersionWithInput,
    onSuccess: async (result) => {
      setSelectorConfigMessage(`selector config restored: ${result.restoredVersion.id}`)
      setSelectorConfigDraft(cloneSelectorConfig(result.config))
      await refetchSelectorConfig()
      await refetchSelectorConfigValidation()
      await refetchSelectorWorkbench()
      await refetchSelectorConfigVersions()
      await refetchAutomationPreflight()
    },
    onError: (error) => {
      setSelectorConfigMessage(getErrorMessage(error))
    }
  })

  const selectorConfigGenerator = useMutation({
    mutationFn: generateSelectorConfig,
    onSuccess: async (result) => {
      setSelectorConfigMessage(`已生成选择器配置：${result.configPath}`)
      await refetchSelectorConfig()
      await refetchSelectorConfigValidation()
      await refetchSelectorWorkbench()
      await refetchSelectorConfigVersions()
      await refetchAutomationPreflight()
    }
  })

  const selectorCalibrationRunner = useMutation({
    mutationFn: startSelectorCalibration,
    onSuccess: async (result) => {
      setSelectorCalibrationMessage(`selector calibration started: ${result.artifactDir}`)
      await refetchSelectorCalibrationJobs()
      await refetchSelectorWorkbench()
    },
    onError: async (error) => {
      setSelectorCalibrationMessage(getErrorMessage(error))
      await refetchSelectorCalibrationJobs()
      await refetchSelectorWorkbench()
    }
  })

  const dianxiaomiAccountScanner = useMutation({
    mutationFn: startDianxiaomiAccountScan,
    onSuccess: async (result) => {
      setAccountScanMessage(`account scan started: ${result.artifactDir}`)
      setSelectedAccountScanLinkIds([])
      currentStoreAutoImportRef.current = null
      setCurrentStoreImportJobId(null)
      setAccountScanStoreFilter("all")
      setAccountScanBucketFilter("all")
      await refetchDianxiaomiAccountScanJobs()
    },
    onError: async (error) => {
      setAccountScanMessage(getErrorMessage(error))
      await refetchDianxiaomiAccountScanJobs()
    }
  })

  const dianxiaomiAccountScanImporter = useMutation({
    mutationFn: ({
      jobId,
      linkIds,
      storeScopeKey,
      storeId,
      storeName,
      sourceBuckets
    }: {
      jobId: string
      linkIds?: string[]
      storeScopeKey?: string
      storeId?: string
      storeName?: string
      sourceBuckets?: AutomationSourceBucket[]
    }) =>
      importDianxiaomiAccountScanJobLinks(jobId, {
        linkIds,
        storeId,
        storeName,
        sourceBuckets
      }),
    onSuccess: async (result, variables) => {
      setAccountScanMessage(`已导入?${result.importedCount} 个链接，ready ${result.readyCount}，待修订 ${result.needsRevisionCount}`)
      setSelectedAccountScanLinkIds([])
      if (variables.storeScopeKey) {
        setSelectedStoreScopeKey(variables.storeScopeKey)
      }
      currentStoreAutoImportRef.current = null
      setCurrentStoreImportJobId(null)
      await refetchDianxiaomiProductWorkItems()
      await refetchDianxiaomiAccountScanJobs()
    },
    onError: (error) => {
      currentStoreAutoImportRef.current = null
      setCurrentStoreImportJobId(null)
      setAccountScanMessage(getErrorMessage(error))
    }
  })

  useEffect(() => {
    if (!currentStoreImportJobId || dianxiaomiAccountScanImporter.isPending) {
      return
    }

    let cancelled = false
    const poll = async () => {
      try {
        const job = await fetchDianxiaomiAccountScanJob(currentStoreImportJobId)
        if (cancelled) {
          return
        }

        if (job.status === "running") {
          window.setTimeout(() => {
            void poll()
          }, 1500)
          return
        }

        if (job.status === "failed") {
          currentStoreAutoImportRef.current = null
          setCurrentStoreImportJobId(null)
          setAccountScanMessage(job.error ?? "店小秘页面店铺链接池扫描失败")
          await refetchDianxiaomiAccountScanJobs()
          return
        }

        const scope = currentStoreAutoImportRef.current
        await refetchDianxiaomiAccountScanJobs()
        await importCurrentStoreLinksFromJob(job.id, scope ?? undefined)
        await refetchDianxiaomiProductWorkItems()
        await runBatchPrepareForCurrentScope()
      } catch (error) {
        if (!cancelled) {
          currentStoreAutoImportRef.current = null
          setCurrentStoreImportJobId(null)
          setAccountScanMessage(getErrorMessage(error))
        }
      }
    }

    void poll()
    return () => {
      cancelled = true
    }
  }, [currentStoreImportJobId, dianxiaomiAccountScanImporter.isPending])

  const dianxiaomiImageChecker = useMutation({
    mutationFn: ({ workItemId }: { workItemId: string }) => startDianxiaomiWorkItemImageCheck(workItemId, {
      headed: automationStartInput.headed,
      profile: automationStartInput.profile,
      screenshots: automationStartInput.screenshots
    }),
    onSuccess: async (result) => {
      setImageCheckMessage(`图片检测已启动：${result.workItemId}`)
      await refetchDianxiaomiImageCheckJobs()
      await refetchDianxiaomiProductWorkItems()
    },
    onError: async (error) => {
      setImageCheckMessage(getErrorMessage(error))
      await refetchDianxiaomiImageCheckJobs()
    }
  })

  const runCurrentScopeImageCheck = async () => {
    const candidateItems = dianxiaomiProductWorkItems
      .filter((item) => item.status !== "blocked" || canRunFullyAutomaticRepair(item))
      .filter((item) => needsImageCheck(item))
      .slice(0, 3)

    if (candidateItems.length === 0) {
      setImageCheckMessage("当前范围没有需要补检的图片项。")
      return
    }

    setImageCheckMessage(`正在批量图片检测：${candidateItems.map((item) => item.title).join(" / ")}`)
    for (const item of candidateItems) {
      await dianxiaomiImageChecker.mutateAsync({ workItemId: item.id })
    }
    await refetchDianxiaomiProductWorkItems()
    await refetchDianxiaomiImageCheckJobs()
    setImageCheckMessage(`已启动 ${candidateItems.length} 个图片检测任务。`)
  }

  const waitForImageCheckJob = async (jobId: string) => {
    while (true) {
      const job = await fetchDianxiaomiImageCheckJob(jobId)
      if (job.status !== "running") {
        return job
      }
      await delay(1500)
    }
  }

  const waitForRepairApplyJob = async (jobId: string) => {
    while (true) {
      const job = await fetchAutomationRepairApplyJob(jobId)
      if (job.status !== "running") {
        return job
      }
      await delay(2000)
    }
  }

  const waitForLatestImageCheckCompletion = async (workItemId: string, startedAt: string) => {
    while (true) {
      const jobs = await fetchDianxiaomiImageCheckJobs()
      const job = jobs
        .filter((candidate) => candidate.workItemId === workItemId && candidate.startedAt.localeCompare(startedAt) >= 0)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]

      if (!job) {
        await delay(1500)
        continue
      }

      if (job.status !== "running") {
        return job
      }

      await delay(1500)
    }
  }

  const waitForRecoveryRun = async (runId: string) => {
    while (true) {
      const runs = await fetchAutomationRecoveryRuns()
      const run = runs.find((candidate) => candidate.id === runId)
      if (run && run.status !== "running") {
        return run
      }
      await delay(2500)
    }
  }

  const runBatchPrepareForCurrentScope = async () => {
    const candidates = dianxiaomiProductWorkItems
      .filter((item) => item.status !== "blocked" || canRunFullyAutomaticRepair(item))
      .filter((item) => needsImageCheck(item))
      .slice(0, 5)

    if (candidates.length === 0 && scopeBrowserRecoveryCandidateCount === 0) {
      setImageCheckMessage("当前范围没有需要批量准备或自动恢复的商品。")
      return
    }

    setBatchPreparePending(true)
    setRepairMessage("")
    setAutomationRecoveryRunMessage("")
    const summary: BatchPrepareSummary = {
      checked: 0,
      repaired: 0,
      requeued: 0,
      recovered: 0,
      recoveryQueued: 0
    }

    setImageCheckMessage(
      candidates.length > 0
        ? `正在批量准备 ${candidates.length} 个商品：先做图片检测，再按店小秘分类尝试自动修复，必要时继续自动恢复。`
        : `当前范围图片已处理，开始自动恢复 ${scopeBrowserRecoveryCandidateCount} 个阻塞商品。`
    )

    try {
      for (const item of candidates) {
        setImageCheckMessage(`正在图片检测：${item.title}`)
        const imageCheckStarted = await dianxiaomiImageChecker.mutateAsync({ workItemId: item.id })
        const finishedImageCheckJob = await waitForImageCheckJob(imageCheckStarted.id)
        summary.checked += 1

        if (finishedImageCheckJob.status !== "completed") {
          continue
        }

        const refreshedWorkItems = filterWorkItemsForCurrentScope((await refetchDianxiaomiProductWorkItems()).data ?? [])
        const refreshedItem = refreshedWorkItems.find((candidate) => candidate.id === item.id)
        const canAutoRepair = refreshedItem ? canRunFullyAutomaticRepair(refreshedItem) : false

        if (!refreshedItem || !canAutoRepair) {
          continue
        }

        setRepairMessage(`正在自动修复：${refreshedItem.title}`)
        const repairStarted = await dianxiaomiRepairApplyRunner.mutateAsync({ workItemId: refreshedItem.id })
        const finishedRepairJob = await waitForRepairApplyJob(repairStarted.id)
        if (finishedRepairJob.status !== "completed" || finishedRepairJob.reportStatus !== "completed") {
          continue
        }

        summary.repaired += 1
        await waitForLatestImageCheckCompletion(refreshedItem.id, finishedRepairJob.startedAt)
        const repairedWorkItems = filterWorkItemsForCurrentScope((await refetchDianxiaomiProductWorkItems()).data ?? [])
        const repairedItem = repairedWorkItems.find((candidate) => candidate.id === item.id)
        if (!repairedItem) {
          continue
        }

        const retryResult = await retryDianxiaomiProductWorkItemAfterFix(repairedItem.id)
        if (retryResult.requeued) {
          summary.requeued += 1
        }
        await refetchDianxiaomiProductWorkItems()
      }

      const scopedWorkItemsAfterPrepare = filterWorkItemsForCurrentScope((await refetchDianxiaomiProductWorkItems()).data ?? [])
      const refreshedRecoveryCandidateCount = scopedWorkItemsAfterPrepare.filter((item) => canRunBrowserRecovery(item)).length

      if (refreshedRecoveryCandidateCount > 0) {
        setAutomationRecoveryRunMessage(`正在自动恢复 ${refreshedRecoveryCandidateCount} 个阻塞商品。`)
        const recoveryRun = await automationRecoveryRunner.mutateAsync({
          ...defaultRecoveryRunInput,
          limit: Math.min(5, refreshedRecoveryCandidateCount)
        })
        summary.recoveryQueued = recoveryRun.queued
        const finishedRecoveryRun = await waitForRecoveryRun(recoveryRun.id)
        summary.recovered = finishedRecoveryRun.completed
      }

      await refetchDianxiaomiImageCheckJobs()
      await refetchAutomationRepairApplyJobs()
      await refetchAutomationRepairPreviewJobs()
      await refetchAutomationRecoveryRuns()
      await refetchAutomationFullFlowJobs()
      await refetchAutomationQueueDaemonHealth()
      await refetchAutomationUnattendedStartupCheck()
      if (summary.repaired > 0 || summary.requeued > 0) {
        setRepairMessage(`自动修复完成：${summary.repaired} 个，回到 ready ${summary.requeued} 个。`)
      } else {
        setRepairMessage("")
      }
      if (summary.recoveryQueued > 0) {
        setAutomationRecoveryRunMessage(`自动恢复完成：成功 ${summary.recovered} / 发起 ${summary.recoveryQueued}。`)
      } else {
        setAutomationRecoveryRunMessage("")
      }
      setImageCheckMessage(`批量准备完成：图片检测 ${summary.checked}，自动修复 ${summary.repaired}，回到 ready ${summary.requeued}，自动恢复 ${summary.recovered}/${summary.recoveryQueued}。`)
    } finally {
      setBatchPreparePending(false)
    }
  }

  const dianxiaomiRepairPreviewRunner = useMutation({
    mutationFn: ({ workItemId }: { workItemId: string }) => startDianxiaomiWorkItemRepairPreview(workItemId, {
      headed: automationStartInput.headed,
      profile: automationStartInput.profile,
      screenshots: automationStartInput.screenshots,
      selectorConfig: automationStartInput.selectorConfig,
      mediaAutomationMode: automationStartInput.mediaAutomationMode,
      mediaAutomationTools: automationStartInput.mediaAutomationTools
    }),
    onSuccess: async (result) => {
      setRepairMessage(`repair preview started: ${result.workItemId ?? result.id}`)
      await refetchAutomationRepairPreviewJobs()
      await refetchDianxiaomiProductWorkItems()
    },
    onError: async (error) => {
      setRepairMessage(getErrorMessage(error))
      await refetchAutomationRepairPreviewJobs()
    }
  })

  const dianxiaomiRepairApplyRunner = useMutation({
    mutationFn: ({ workItemId }: { workItemId: string }) => startDianxiaomiWorkItemRepairApply(workItemId, {
      headed: automationStartInput.headed,
      profile: automationStartInput.profile,
      screenshots: automationStartInput.screenshots,
      selectorConfig: automationStartInput.selectorConfig,
      mediaAutomationMode: automationStartInput.mediaAutomationMode ?? "unattended-apply",
      mediaAutomationTools: automationStartInput.mediaAutomationTools
    }),
    onSuccess: async (result) => {
      setRepairMessage(`自动修复已启动：${result.workItemId ?? result.id}`)
      await refetchAutomationRepairApplyJobs()
      await refetchAutomationRepairPreviewJobs()
      await refetchDianxiaomiProductWorkItems()
      await refetchAutomationReports()
    },
    onError: async (error) => {
      setRepairMessage(getErrorMessage(error))
      await refetchAutomationRepairApplyJobs()
    }
  })

  const setPricingField = (field: keyof PricingRules, value: string) => {
    setPricingDraft((current) => current ? { ...current, [field]: Number(value) } : current)
  }

  const setDianxiaomiRequirementPresetName = (value: string) => {
    setDianxiaomiRequirementRulesDraft((current) => current ? { ...current, presetName: value } : current)
  }

  const setDianxiaomiRequirementNumber = (
    group: "title" | "images" | "media" | "sku" | "price" | "stock" | "attributes",
    field: string,
    value: string
  ) => {
    setDianxiaomiRequirementRulesDraft((current) => current ? {
      ...current,
      [group]: {
        ...current[group],
        [field]: Number(value)
      }
    } : current)
  }

  const setDianxiaomiRequirementRequired = (
    group: "title" | "images" | "media" | "sku" | "price" | "stock" | "attributes" | "compliance",
    required: boolean
  ) => {
    setDianxiaomiRequirementRulesDraft((current) => current ? {
      ...current,
      [group]: {
        ...current[group],
        required
      }
    } : current)
  }

  const setDianxiaomiMediaBoolean = (
    field: "requireImageTranslation" | "requireWhiteBackground" | "requireSizeNormalization" | "requireImageEditorReview",
    value: boolean
  ) => {
    setDianxiaomiRequirementRulesDraft((current) => current ? {
      ...current,
      media: {
        ...current.media,
        [field]: value
      }
    } : current)
  }

  const setDianxiaomiMediaText = (
    field: "targetLanguage",
    value: string
  ) => {
    setDianxiaomiRequirementRulesDraft((current) => current ? {
      ...current,
      media: {
        ...current.media,
        [field]: value
      }
    } : current)
  }

  const setManualField = (field: keyof ManualProductInput, value: string) => {
    setManualProduct((current) => ({
      ...current,
      [field]: ["supplierPriceCny", "estimatedDomesticShippingCny", "estimatedWeightKg", "stock"].includes(field)
        ? Number(value)
        : value
    }))
  }

  const setProductEditField = (field: keyof ProductEditDraft, value: string) => {
    setProductEditDraft((current) => current ? {
      ...current,
      [field]: ["supplierPriceCny", "estimatedDomesticShippingCny", "estimatedWeightKg", "stock"].includes(field)
        ? Number(value)
        : value
    } : current)
  }

  const setListingEditField = (field: keyof ListingEditDraft, value: string) => {
    setListingEditDraft((current) => current ? { ...current, [field]: value } : current)
  }

  const buildManualProductPayload = (): ManualProductInput => {
    const productAttributes = parseAttributeText(manualAttributesText)
    const skus = parseSkusText(manualSkusText, {
      costCny: manualProduct.supplierPriceCny,
      stock: manualProduct.stock,
      attributes: productAttributes
    })

    return {
      ...manualProduct,
      attributes: productAttributes,
      images: parseImagesText(manualImagesText),
      skus: skus.length > 0 ? skus : undefined
    }
  }

  const buildProductUpdatePayload = (): ProductUpdateInput | null => {
    if (!productEditDraft) {
      return null
    }

    const attributes = parseAttributeText(productEditDraft.attributesText)
    return {
      title: productEditDraft.title,
      category: productEditDraft.category,
      supplierPriceCny: productEditDraft.supplierPriceCny,
      estimatedDomesticShippingCny: productEditDraft.estimatedDomesticShippingCny,
      estimatedWeightKg: productEditDraft.estimatedWeightKg,
      stock: productEditDraft.stock,
      sourceUrl: productEditDraft.sourceUrl,
      attributes,
      images: parseImagesText(productEditDraft.imagesText),
      skus: parseSkusText(productEditDraft.skusText, {
        costCny: productEditDraft.supplierPriceCny,
        stock: productEditDraft.stock,
        attributes
      })
    }
  }

  const buildDraftUpdatePayload = (): DraftUpdateInput | null => {
    if (!listingEditDraft) {
      return null
    }

    return {
      listingTitle: listingEditDraft.listingTitle,
      sellingPoints: parseLines(listingEditDraft.sellingPointsText),
      description: listingEditDraft.description,
      categoryPath: parseLines(listingEditDraft.categoryPathText),
      attributes: parseAttributeText(listingEditDraft.attributesText),
      skuPricing: parseLines(listingEditDraft.skuPricingText).map((line) => {
        const [skuId, skuName, salePriceUsd, stock, attributesText] = line.split(",")
        return {
          skuId: skuId.trim(),
          skuName: skuName?.trim(),
          salePriceUsd: Number(salePriceUsd),
          stock: Math.max(0, Math.floor(Number(stock))),
          attributes: parseAttributeText(attributesText ?? "")
        }
      }).filter((sku) => sku.skuId)
    }
  }

  const buildPricingPayload = () => pricingDraft
    ? { ...pricingDraft, logisticsRateTiers: parseLogisticsTiersText(logisticsTiersText) }
    : null

  const buildDianxiaomiRequirementRulesPayload = () => dianxiaomiRequirementRulesDraft
    ? {
        ...dianxiaomiRequirementRulesDraft,
        attributes: {
          ...dianxiaomiRequirementRulesDraft.attributes,
          recommendedKeys: parseLines(dianxiaomiRecommendedKeysText)
        },
        compliance: {
          ...dianxiaomiRequirementRulesDraft.compliance,
          blockedTerms: parseLines(dianxiaomiBlockedTermsText)
        },
        media: {
          ...dianxiaomiRequirementRulesDraft.media,
          dianxiaomiTools: parseLines(dianxiaomiMediaToolsText)
        }
      }
    : null

  const readyLabel = syncer.isPending
    ? "正在同步到店小秘..."
    : syncedTask?.id === activeTask?.id
      ? "已准备推送到店小秘"
      : "待同步到店小秘"

  const progress = activeTask ? getTaskProgress(activeTask) : 0
  const canSyncToStore = activeTask?.status === "approved" && publishCheck?.canPublish === true
  const selectedReviewableTaskIds = selectedTaskIds.filter((taskId) => tasks.some((task) => task.id === taskId && task.status !== "approved" && task.status !== "rejected"))
  const batchPublishableCount = batchPublishChecks.filter((check) => check.canPublish).length
  const batchBlockingCount = batchPublishChecks.length - batchPublishableCount
  const selectedStoreScope = selectedStoreScopeKey === "auto"
    ? currentPageStoreScope ?? defaultReadyStoreScope
    : selectedStoreScopeKey === ALL_STORES_SCOPE_KEY
      ? null
      : storeScopeOptions.find((option) => option.key === selectedStoreScopeKey) ?? null
  const allStoreScopeMetrics = sumStoreScopeMetrics(storeMetrics)
  const selectedStoreScopeMetrics: StoreScopeOption = selectedStoreScope ?? {
    key: ALL_STORES_SCOPE_KEY,
    label: "全部店铺",
    workItemCount: allStoreScopeMetrics.workItemCount,
    readyCount: allStoreScopeMetrics.readyCount,
    collectedCount: allStoreScopeMetrics.collectedCount,
    blockedCount: allStoreScopeMetrics.blockedCount,
    needsRevisionCount: allStoreScopeMetrics.needsRevisionCount,
    editedCount: allStoreScopeMetrics.editedCount
  }
  const filterByStoreScope = <T extends { storeId?: string; storeName?: string }>(items: T[]) => {
    if (!selectedStoreScope) {
      return items
    }

    return items.filter((item) => matchesStoreScopeOption(selectedStoreScope, item))
  }
  const filterWorkItemsForCurrentScope = (items: DianxiaomiProductWorkItem[]) => {
    const storeScopedItems = filterByStoreScope(items)
    return scopeFilterEnabled
      ? storeScopedItems.filter((item) =>
          matchesSelectedQueueProductScope(item, selectedQueueProductScopeMode, selectedItemUrlsText, selectedSourceBuckets)
        )
      : []
  }
  const storeScopedCollectedProducts = filterByStoreScope(allDianxiaomiCollectedProducts)
  const storeScopedProductWorkItems = filterByStoreScope(allDianxiaomiProductWorkItems)
  const dianxiaomiCollectedProducts = scopeFilterEnabled
    ? storeScopedCollectedProducts.filter((item) =>
        matchesSelectedQueueProductScope(item, selectedQueueProductScopeMode, selectedItemUrlsText, selectedSourceBuckets)
      )
    : []
  const dianxiaomiProductWorkItems = scopeFilterEnabled ? scopedDianxiaomiProductWorkItems : []
  const selectedStoreScopeSummary = selectedStoreScopeKey === ALL_STORES_SCOPE_KEY
    ? "全部店铺"
    : selectedStoreScope
    ? formatStoreScopeLabel(selectedStoreScope)
    : "全部店铺"
  const selectedStoreQueueInput = selectedStoreScope
    ? {
        storeId: selectedStoreScope.storeId,
        storeName: selectedStoreScope.storeName
      }
    : {}
  const selectedQueueScopeInput = {
    ...selectedStoreQueueInput,
    ...selectedQueueProductScopeInput
  }
  const selectedQueueScopeSummary = `${selectedStoreScopeSummary} / ${selectedQueueProductScopeSummary}`
  const calibrationCandidateWorkItem = dianxiaomiProductWorkItems.find((item) =>
    item.status === "ready-for-automation"
    && item.pageUrl.includes("/web/popTemu/edit")
  ) ?? storeScopedProductWorkItems.find((item) =>
    item.status === "ready-for-automation"
    && item.pageUrl.includes("/web/popTemu/edit")
  ) ?? allDianxiaomiProductWorkItems.find((item) =>
    item.status === "ready-for-automation"
    && item.pageUrl.includes("/web/popTemu/edit")
  ) ?? null
  const dailyCalibrationTargetUrl = automationStartInput.url?.trim() || calibrationCandidateWorkItem?.pageUrl || undefined
  const handleStoreScopeChange = (nextKey: string) => {
    setSelectedStoreScopeKey(nextKey)

    if (nextKey === "auto") {
      setStoreScopeMessage("当前运行范围将跟随当前识别到的店小秘页面店铺队列。")
      return
    }

    if (nextKey === ALL_STORES_SCOPE_KEY) {
      setStoreScopeMessage("当前运行范围已切换为全部店铺，不会跟随店小秘页面店铺切换。")
      return
    }

    const nextOption = storeScopeOptions.find((option) => option.key === nextKey)
    if (!nextOption) {
      return
    }

    setStoreScopeMessage(`当前运行范围已切换到 ${formatStoreScopeLabel(nextOption)}。仅影响本软件中的队列筛选和运行范围，不会切换店小秘页面店铺。`)
  }
  const selectedScopeUrlSet = normalizeAutomationItemUrls(selectedQueueProductScopeInput.itemUrls)
  const selectedScopeBucketSet = normalizeAutomationSourceBuckets(selectedQueueProductScopeInput.sourceBuckets)
  const matchesSelectedScopeValues = (actual: string[], expected: string[]) =>
    expected.length === 0 || expected.every((value) => actual.includes(value))
  const isQueueRunInSelectedStoreScope = (run: Pick<AutomationQueueRunStartResult, "storeId" | "storeName" | "itemUrls" | "sourceBuckets">) => {
    if (!selectedStoreScope) {
      return matchesSelectedScopeValues(normalizeAutomationItemUrls(run.itemUrls), selectedScopeUrlSet)
        && matchesSelectedScopeValues(normalizeAutomationSourceBuckets(run.sourceBuckets), selectedScopeBucketSet)
    }

    if (!matchesStoreScopeOption(selectedStoreScope, run)) {
      return false
    }

    return matchesSelectedScopeValues(normalizeAutomationItemUrls(run.itemUrls), selectedScopeUrlSet)
      && matchesSelectedScopeValues(normalizeAutomationSourceBuckets(run.sourceBuckets), selectedScopeBucketSet)
  }
  const isRecoveryRunInSelectedStoreScope = (run: Pick<AutomationRecoveryRun, "input">) => {
    if (!selectedStoreScope) {
      return matchesSelectedScopeValues(normalizeAutomationItemUrls(run.input.itemUrls), selectedScopeUrlSet)
        && matchesSelectedScopeValues(normalizeAutomationSourceBuckets(run.input.sourceBuckets), selectedScopeBucketSet)
    }

    if (!matchesStoreScopeOption(selectedStoreScope, run.input)) {
      return false
    }

    return matchesSelectedScopeValues(normalizeAutomationItemUrls(run.input.itemUrls), selectedScopeUrlSet)
      && matchesSelectedScopeValues(normalizeAutomationSourceBuckets(run.input.sourceBuckets), selectedScopeBucketSet)
  }
  const inScopeWorkItemIds = new Set(dianxiaomiProductWorkItems.map((item) => item.id))
  const inScopeWorkItemUrls = new Set(
    dianxiaomiProductWorkItems
      .map((item) => normalizePageIdentity(item.pageUrl))
      .filter(Boolean)
  )
  const selectedQueueScopeActive = Boolean(selectedStoreScope) || selectedScopeUrlSet.length > 0 || selectedScopeBucketSet.length > 0
  const automationQueueRunsInScope = automationQueueRuns.filter((run) => isQueueRunInSelectedStoreScope(run))
  const automationRecoveryRunsInScope = automationRecoveryRuns.filter((run) => isRecoveryRunInSelectedStoreScope(run))
  const queueRunFlowJobIdsInScope = new Set(automationQueueRunsInScope.flatMap((run) => run.flowJobIds))
  const recoveryFlowJobIdsInScope = new Set(
    automationRecoveryRunsInScope.flatMap((run) =>
      run.items
        .map((item) => item.fullFlowJobId)
        .filter((id): id is string => Boolean(id))
    )
  )
  const automationFullFlowJobsInScope = selectedQueueScopeActive
    ? automationFullFlowJobs.filter((job) =>
        (job.workItemId ? inScopeWorkItemIds.has(job.workItemId) : false)
        || (job.input.url ? inScopeWorkItemUrls.has(normalizePageIdentity(job.input.url)) : false)
        || queueRunFlowJobIdsInScope.has(job.id)
        || recoveryFlowJobIdsInScope.has(job.id)
      )
    : automationFullFlowJobs
  const latestQueueTick = automationQueueDaemon?.ticks.find((tick) => {
    if (!selectedQueueScopeActive) {
      return true
    }
    if (tick.queueRun) {
      return isQueueRunInSelectedStoreScope(tick.queueRun)
    }
    if (tick.recoveryRun) {
      return isRecoveryRunInSelectedStoreScope(tick.recoveryRun)
    }
    return false
  }) ?? null
  const latestFullFlowJob = automationFullFlowJobsInScope[0] ?? null
  let latestFullFlowSummary = "还没有 full-flow 运行记录。"
  if (latestFullFlowJob) {
    const fullFlowStatusLabel = latestFullFlowJob.status === "completed"
      ? "成功"
      : latestFullFlowJob.status === "failed"
        ? "失败"
        : "运行中"
    const fullFlowStageHint = latestFullFlowJob.stages.find((stage) => stage.status === "failed")?.name
      ?? [...latestFullFlowJob.stages].reverse().find((stage) => stage.status === "completed")?.name
      ?? null
    latestFullFlowSummary = `最近一次 full-flow ${fullFlowStatusLabel}`
      + (fullFlowStageHint ? `（${fullFlowStageHint}）` : "")
      + (latestFullFlowJob.error ? `: ${latestFullFlowJob.error}` : "")
  }
  const latestSaveDraftProofJob = automationFullFlowJobsInScope.find((job) =>
    job.input.submitAfterSave === false
    && !job.input.repairPlanFile
    && job.stages.some((stage) => stage.name === "save-draft")
  ) ?? null
  const latestSuccessfulSaveDraftReport = automationReports.find((report) =>
    report.status === "completed"
    && report.steps.some((step) => step.id === "save-draft" && step.status === "done")
  ) ?? null
  const latestImageCheckJobByWorkItemId = new Map<string, DianxiaomiImageCheckJob>()
  for (const job of dianxiaomiImageCheckJobs) {
    if (!job.workItemId || latestImageCheckJobByWorkItemId.has(job.workItemId)) {
      continue
    }
    latestImageCheckJobByWorkItemId.set(job.workItemId, job)
  }
  const latestRepairPreviewJobByWorkItemId = new Map<string, typeof automationRepairPreviewJobs[number]>()
  for (const job of automationRepairPreviewJobs) {
    if (!job.workItemId || latestRepairPreviewJobByWorkItemId.has(job.workItemId)) {
      continue
    }
    latestRepairPreviewJobByWorkItemId.set(job.workItemId, job)
  }
  const latestRepairApplyJobByWorkItemId = new Map<string, typeof automationRepairApplyJobs[number]>()
  for (const job of automationRepairApplyJobs) {
    if (!job.workItemId || latestRepairApplyJobByWorkItemId.has(job.workItemId)) {
      continue
    }
    latestRepairApplyJobByWorkItemId.set(job.workItemId, job)
  }
  const readyWorkItems = dianxiaomiProductWorkItems.filter((item) => item.status === "ready-for-automation")
  const blockedWorkItems = dianxiaomiProductWorkItems.filter((item) => item.status === "blocked")
  const dailySaveDraftCandidate = (
    latestSuccessfulSaveDraftReport
      ? dianxiaomiProductWorkItems.find((item) =>
          normalizePageIdentity(item.pageUrl) === normalizePageIdentity(latestSuccessfulSaveDraftReport.pageUrl)
        )
      : null
  ) ?? readyWorkItems.find((item) => item.pageUrl.includes("/web/popTemu/edit")) ?? readyWorkItems[0] ?? null
  const dailySaveDraftProofStages = (["dry-run", "fill-draft", "save-draft"] as const).map((name) => {
    const stage = latestSaveDraftProofJob?.stages.find((item) => item.name === name) ?? null
    const reportStep = latestSuccessfulSaveDraftReport?.steps.find((item) => item.id === name) ?? null
    const status = stage?.status ?? (
      latestSuccessfulSaveDraftReport
        ? reportStep?.status === "failed"
          ? "failed"
          : "completed"
        : "pending"
    )
    const tone = status === "completed"
      ? "good"
      : status === "failed"
        ? "bad"
        : status === "running"
          ? "warn"
          : "neutral"
    return {
      name,
      status,
      tone
    }
  })
  const latestSaveDraftProofStage = latestSaveDraftProofJob?.stages.find((stage) => stage.name === "save-draft") ?? null
  let latestSaveDraftProofSummary = "还没有保存草稿验证记录"
  if (latestSaveDraftProofJob) {
    if (latestSaveDraftProofJob.status === "completed") {
      latestSaveDraftProofSummary = "已保存草稿 " + new Date(latestSaveDraftProofJob.finishedAt ?? latestSaveDraftProofJob.startedAt).toLocaleString()
    } else if (latestSaveDraftProofJob.status === "failed") {
      latestSaveDraftProofSummary = "失败：" + (latestSaveDraftProofJob.error ?? latestSaveDraftProofStage?.error ?? "未知错误")
    } else {
      latestSaveDraftProofSummary = "运行中：" + (latestSaveDraftProofJob.workItemId ?? latestSaveDraftProofJob.id)
    }
  } else if (latestSuccessfulSaveDraftReport) {
    latestSaveDraftProofSummary = "已保存草稿 " + new Date(latestSuccessfulSaveDraftReport.createdAt).toLocaleString()
  }

  const dailySaveDraftCandidateSummary = dailySaveDraftCandidate
    ? dailySaveDraftCandidate.title + " / " + (dailySaveDraftCandidate.storeName ?? dailySaveDraftCandidate.storeId ?? "未识别店铺")
    : "当前范围没有 ready 商品"

  let dailySaveDraftProofStatusLabel = "待验证"
  if (latestSaveDraftProofJob) {
    if (latestSaveDraftProofJob.status === "completed") {
      dailySaveDraftProofStatusLabel = "已验证"
    } else if (latestSaveDraftProofJob.status === "failed") {
      dailySaveDraftProofStatusLabel = "验证失败"
    } else {
      dailySaveDraftProofStatusLabel = "验证中"
    }
  } else if (latestSuccessfulSaveDraftReport) {
    dailySaveDraftProofStatusLabel = "已有验证记录"
  }

  const dailySaveDraftProofRunning = dailySaveDraftProofRunner.isPending || latestSaveDraftProofJob?.status === "running"

  let selectedScopeConfigurationMessage: string | null = null
  if (!selectedQueueProductScopeReady) {
    selectedScopeConfigurationMessage = selectedQueueProductScopeMode === "item-urls"
      ? "请输入要处理的店小秘商品链接，一行一个。"
      : "请至少勾选一个来源页面。"
  }
  const scopeBrowserRecoveryCandidateCount = blockedWorkItems.filter((item) => canRunBrowserRecovery(item)).length
  const backendConnectionError = [
    dianxiaomiProductWorkItemsError ? dianxiaomiProductWorkItemsQueryError : null,
    automationQueueRunsError ? automationQueueRunsQueryError : null,
    automationQueueDaemonError ? automationQueueDaemonQueryError : null,
    automationQueueDaemonHealthError ? automationQueueDaemonHealthQueryError : null,
    automationUnattendedStartupCheckError ? automationUnattendedStartupCheckQueryError : null
  ].find(Boolean)
  const {
    directSafeRetryCandidateCount,
    releasedBrowserRecoveryCandidateCount,
    displayedBrowserRecoveryCandidateCount,
    pausedBrowserRecoveryCandidateCount,
    startupCalibrationCheck,
    startupBlockingChecks,
    startupWarningChecks,
    primaryStartupProblem,
    dailyBackendOffline,
    dailyBackendOfflineMessage,
    dailyTrialGate,
    dailyStartupCanStart,
    dailyCanStart,
    dailyAutomaticPass,
    dailyManualTriggers,
    dailyAutomaticPassTone,
    dailyManualTriggerTone,
    operatorAction,
    dailyModeLabel,
    dailyModeTone,
    dailyTrialTone,
    dailyTrialLabel,
    dailyActionTitle,
    dailyActionDetail,
    repeatedRecoveryAlert,
    validationTriageAlert,
    firstManualBudgetItem,
    publishFailureSummary,
    dailyAlerts
  } = useDailyDashboard({
    automationQueueRuns: automationQueueRunsInScope,
    automationFullFlowJobs: automationFullFlowJobsInScope,
    dianxiaomiProductWorkItems,
    automationQueueDaemon,
    automationQueueDaemonHealth,
    automationUnattendedStartupCheck,
    backendConnectionError
  })
  const dailyMediaAutomationTools = automationStartInput.mediaAutomationTools && automationStartInput.mediaAutomationTools.length > 0
    ? automationStartInput.mediaAutomationTools
    : defaultDailyMediaAutomationTools
  const defaultQueueDaemonInput = {
    ...automationStartInput,
    ...selectedQueueScopeInput,
    mediaAutomationMode: "unattended-apply" as const,
    mediaAutomationTools: dailyMediaAutomationTools,
    intervalSeconds: Number.parseInt(automationQueueDaemonInterval, 10) || 300,
    maxConsecutiveFailures: Number.parseInt(automationQueueDaemonMaxFailures, 10) || 3,
    limit: 1,
    submitAfterSave: true
  }
  const dailyTrialQueueRunInput = {
    ...automationStartInput,
    ...selectedQueueScopeInput,
    mediaAutomationMode: "unattended-apply" as const,
    mediaAutomationTools: dailyMediaAutomationTools,
    limit: 3,
    submitAfterSave: true
  }
  const defaultRecoveryRunInput = {
    ...automationStartInput,
    ...selectedQueueScopeInput,
    mediaAutomationMode: "unattended-apply" as const,
    mediaAutomationTools: dailyMediaAutomationTools,
    submitAfterSave: true,
    limit: 5
  }
  const dailySelectorCalibrationInput = {
    url: dailyCalibrationTargetUrl,
    headed: true,
    profile: automationStartInput.profile,
    screenshots: automationStartInput.screenshots,
    sampleMediaActions: true,
    mediaAutomationTools: dailyMediaAutomationTools
  }
  const requestManualBudgetTrial = (proposal: AutomationManualStepBudgetTrialProposal) => {
    void manualBudgetTrialRunner.mutateAsync({
      ...automationStartInput,
      ...selectedQueueScopeInput,
      candidateKey: proposal.candidateKey,
      rollbackAcknowledged: true,
      acceptedRollbackCriteria: proposal.rollbackCriteria,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: dailyMediaAutomationTools,
      submitAfterSave: true
    })
  }

  const requestNextManualBudgetValidation = () => {
    void manualBudgetValidationRunner.mutateAsync({
      ...automationStartInput,
      ...selectedQueueScopeInput,
      mediaAutomationMode: "unattended-apply",
      mediaAutomationTools: dailyMediaAutomationTools,
      submitAfterSave: true
    })
  }

  const toggleTaskSelection = (taskId: string) => {
    setSelectedTaskIds((current) =>
      current.includes(taskId)
        ? current.filter((item) => item !== taskId)
        : [...current, taskId]
    )
  }

  const toggleAccountScanLinkSelection = (linkId: string) => {
    setSelectedAccountScanLinkIds((current) =>
      current.includes(linkId)
        ? current.filter((item) => item !== linkId)
        : [...current, linkId]
    )
  }

  const toggleVisibleAccountScanLinks = (links: DianxiaomiAccountScanLink[]) => {
    const visibleIds = links.map((link) => link.id)
    setSelectedAccountScanLinkIds((current) => {
      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => current.includes(id))
      if (allSelected) {
        return current.filter((id) => !visibleIds.includes(id))
      }

      return Array.from(new Set([...current, ...visibleIds]))
    })
  }

  const needsRevisionWorkItems = dianxiaomiProductWorkItems.filter((item) => item.status === "needs-revision")
  const useStoreScopeSummaryCounts = selectedQueueProductScopeMode === "ready-queue"
  const scopeReadyCount = useStoreScopeSummaryCounts ? selectedStoreScopeMetrics.readyCount : readyWorkItems.length
  const scopeWorkItemCount = useStoreScopeSummaryCounts ? selectedStoreScopeMetrics.workItemCount : dianxiaomiProductWorkItems.length
  const scopeBlockedCount = useStoreScopeSummaryCounts ? selectedStoreScopeMetrics.blockedCount : blockedWorkItems.length
  const scopeNeedsRevisionCount = useStoreScopeSummaryCounts ? selectedStoreScopeMetrics.needsRevisionCount : needsRevisionWorkItems.length
  const imageCheckPendingWorkItems = dianxiaomiProductWorkItems.filter((item) => needsImageCheck(item))
  const imageCheckPendingCount = imageCheckPendingWorkItems.length
  const batchPrepareAvailableCount = Math.min(
    5,
    dianxiaomiProductWorkItems
      .filter((item) => item.status !== "blocked" || canRunFullyAutomaticRepair(item))
      .filter((item) => needsImageCheck(item))
      .length
  )
  const batchPrepareActionableCount = batchPrepareAvailableCount + scopeBrowserRecoveryCandidateCount
  const imageCheckIssueSummary = summarizeImageCheckIssues(imageCheckPendingWorkItems)
  const dailyTopAlerts = dailyAlerts.slice(0, 3)
  const dailyGuideSteps = [
    {
      title: "先在店小秘页内处理当前商品",
      detail: "右侧插件会显示当前页面状态、下一步和默认动作。图片问题优先按店小秘图片检测分类处理。"
    },
    {
      title: "这里默认只选店铺",
      detail: "日常直接跑运行店铺的 ready 队列。只有明确要限链接或来源页时，再展开更多范围。"
    },
    {
      title: "先批量准备，再试跑放量",
      detail: "先点一键批量准备，让系统按店小秘分类处理图片并自动恢复可修复阻塞项；再跑 3 个 ready 商品试跑，通过后启动无人值守。"
    }
  ]
  const dailyScopeHint = selectedQueueProductScopeMode === "ready-queue"
    ? "默认推荐：系统自动处理运行店铺的 ready 队列。"
    : selectedQueueProductScopeMode === "item-urls"
      ? "当前只处理你填入的商品链接。"
      : "当前只处理你勾选来源页的商品。"
  const currentPageStoreSyncTimestamp = formatStoreSyncTimestamp(dianxiaomiPageContext?.updatedAt)
  let currentPageStoreScopeLabel = "未识别店小秘当前页面店铺"
  if (currentPageStoreDisplayScope) {
    if (activeDianxiaomiPageContext) {
      currentPageStoreScopeLabel = formatStoreScopeLabel(currentPageStoreDisplayScope) + " · 已同步"
    } else if (currentPageStoreSyncTimestamp) {
      currentPageStoreScopeLabel = formatStoreScopeLabel(currentPageStoreDisplayScope) + " · 上次同步 " + currentPageStoreSyncTimestamp
    } else {
      currentPageStoreScopeLabel = formatStoreScopeLabel(currentPageStoreDisplayScope) + " · 等待重新同步"
    }
  } else if (currentPageStoreSyncTimestamp) {
    currentPageStoreScopeLabel = "未识别店小秘当前页面店铺 · 上次同步 " + currentPageStoreSyncTimestamp
  }
  let currentPageStorePoolLabel = "先打开店小秘页面店铺"
  if (activeDianxiaomiPageContext) {
    if (currentPageStoreScanLinks.length > 0) {
      currentPageStorePoolLabel = currentPageStoreImportableLinks.length > 0
        ? "已扫描 " + currentPageStoreScanLinks.length + " / 待导入 " + currentPageStoreImportableLinks.length
        : "已扫描 " + currentPageStoreScanLinks.length + " / 当前没有新的可导入链接"
    } else {
      currentPageStorePoolLabel = "店小秘页面店铺还没有扫描结果"
    }
  } else if (currentPageStoreDisplayScope) {
    currentPageStorePoolLabel = "店小秘页面上次停留在 " + formatStoreScopeLabel(currentPageStoreDisplayScope) + "，请重新打开该店铺页面继续同步链接池"
  }
  let dailyManualReviewSummary = "没有需要额外人工接手的发布结果。"
  if (publishFailureSummary?.firstManualBudgetItem) {
    dailyManualReviewSummary = publishFailureSummary.firstManualBudgetItem.title + ": " + publishFailureSummary.firstManualBudgetItem.operatorAction
  } else if (firstManualBudgetItem) {
    dailyManualReviewSummary = firstManualBudgetItem.title + ": " + firstManualBudgetItem.operatorAction
  }

  return (
    <div className="app-shell">
      <AppNavRail active={activeView} onChange={setActiveView} statusLabel={dailyModeLabel} statusTone={dailyModeTone} />
      <div className={"app-view view-" + activeView}>
      {activeView === "pod" ? (
        <PodStudio onBack={() => setActiveView("daily")} />
      ) : activeView === "daily" ? (
        <main className="daily-workspace">
          <section className={"daily-console " + dailyModeTone}>
            <div className="daily-console-head">
              <div>
                <p className="eyebrow">Daily Mode</p>
                <h1>常用首页</h1>
                <p>日常只走这一条路：在店小秘页里让插件处理图片和字段，这里先做小批量试跑，验收通过后再启动无人值守。</p>
              </div>
              <strong className={"daily-mode-badge " + dailyModeTone}>{dailyModeLabel}</strong>
            </div>

            <div className="daily-status-strip main-kpis">
              <DailyMetric label="已就绪" value={String(scopeReadyCount)} detail="ready 商品" tone={scopeReadyCount > 0 ? "good" : "neutral"} />
              <DailyMetric
                label="自动通过率"
                value={dailyAutomaticPass.rate === null ? "--" : String(Math.round(dailyAutomaticPass.rate * 100)) + "%"}
                detail={dailyAutomaticPass.finished > 0 ? String(dailyAutomaticPass.completed) + "/" + String(dailyAutomaticPass.finished) + " 已完成" : "等待新的全流程结果"}
                tone={dailyAutomaticPassTone}
              />
              <DailyMetric
                label="待修复"
                value={String(scopeNeedsRevisionCount + scopeBlockedCount)}
                detail={"待修订 " + String(scopeNeedsRevisionCount) + " / 阻塞 " + String(scopeBlockedCount)}
                tone={scopeNeedsRevisionCount + scopeBlockedCount > 0 ? "warn" : "neutral"}
              />
              <DailyMetric
                label="图片待检"
                value={String(imageCheckPendingCount)}
                detail={imageCheckIssueSummary || "已过检或未发现问题"}
                tone={imageCheckPendingCount > 0 ? "warn" : "good"}
              />
              <DailyMetric
                label="已识别店铺"
                value={String(storeScopeOptions.length)}
                detail={selectedStoreScope ? "运行：" + formatStoreScopeLabel(selectedStoreScope) + " / 页面：" + currentPageStoreScopeLabel : "页面：" + currentPageStoreScopeLabel}
                tone={storeScopeOptions.length > 0 ? "good" : "warn"}
              />
            </div>
          </section>

          <section className="daily-grid daily-home-grid">
            <article className="daily-panel">
              <div className="daily-panel-head">
                <strong>今天怎么做</strong>
                <span>按顺序处理</span>
              </div>
              <div className="daily-guide-list">
                {dailyGuideSteps.map((step, index) => (
                  <div key={step.title} className="daily-guide-step">
                    <strong>{index + 1}</strong>
                    <div>
                      <h3>{step.title}</h3>
                      <p>{step.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className={"daily-action-state " + dailyModeTone}>
                <strong>{dailyActionTitle}</strong>
                <p>{dailyActionDetail}</p>
              </div>
              <div className="daily-console-actions">
                <button
                  className="primary-button"
                  onClick={() => void automationQueueDaemonStarter.mutateAsync(defaultQueueDaemonInput)}
                  disabled={automationQueueDaemonStarter.isPending || !dailyCanStart || !selectedQueueProductScopeReady}
                >
                  {automationQueueDaemonStarter.isPending ? "启动中..." : automationQueueDaemon?.status === "ACTIVE" ? "运行中" : dailyTrialGate.status === "passed" ? "启动无人值守" : "先试跑再启动"}
                </button>
                <button
                  className="ghost-button"
                  onClick={() => void automationQueueDaemonPauser.mutateAsync()}
                  disabled={automationQueueDaemonPauser.isPending || automationQueueDaemon?.status !== "ACTIVE"}
                >
                  {automationQueueDaemonPauser.isPending ? "暂停中..." : "暂停"}
                </button>
                <button
                  className="ghost-button"
                  onClick={() => void automationQueueRunner.mutateAsync(dailyTrialQueueRunInput)}
                  disabled={automationQueueRunner.isPending || !dailyStartupCanStart || !selectedQueueProductScopeReady}
                >
                    {automationQueueRunner.isPending ? "试跑中..." : "开始试跑"}
                </button>
              </div>
              {automationQueueDaemonMessage ? <p className="daily-message">{automationQueueDaemonMessage}</p> : null}
              {automationQueueRunMessage ? <p className="daily-message">{automationQueueRunMessage}</p> : null}
            </article>

            <article className="daily-panel">
              <div className="daily-panel-head">
                <strong>当前范围</strong>
                <span>只处理当前选中的ready 商品</span>
              </div>
              <div className="daily-scope-bar daily-scope-bar-compact">
                <label className="daily-scope-control">
                  <span>店铺</span>
                  <select value={selectedStoreScopeKey} onChange={(event) => handleStoreScopeChange(event.target.value)}>
                    <option value="auto">自动选择当前店铺</option>
                    <option value={ALL_STORES_SCOPE_KEY}>全部店铺</option>
                    {storeScopeOptions.map((option) => (
                      <option key={option.key} value={option.key}>{formatStoreScopeLabel(option)}</option>
                    ))}
                  </select>
                </label>
                <div className="daily-scope-summary">
                  <strong>处理范围</strong>
                  <span>{selectedQueueScopeSummary}</span>
                  <span className="daily-scope-meta">ready {scopeReadyCount} / items {scopeWorkItemCount}</span>
                </div>
              </div>
              <p className="daily-message">{dailyScopeHint}</p>
              {storeScopeMessage ? <p className="daily-message">{storeScopeMessage}</p> : null}
              <div className="daily-mini-feed compact">
                <div>
                  <strong>当前页面</strong>
                  <span>{currentPageStorePoolLabel}</span>
                </div>
                <div>
                  <strong>当前店铺</strong>
                  <span>{currentPageStoreScopeLabel}</span>
                </div>
              </div>
              <div className="daily-store-overview">
                {storeScopeOptions.map((option) => {
                  const selected = selectedStoreScope?.key === option.key
                  const tone = option.readyCount > 0 ? "good" : option.workItemCount > 0 ? "warn" : "neutral"
                  return (
                    <div key={option.key} className={"daily-store-chip " + (selected ? "selected " : "") + tone}>
                      <strong>{option.label}</strong>
                      <span>{describeStoreQueueState(option)}</span>
                    </div>
                  )
                })}
              </div>
              <div className="daily-panel-actions">
                <button
                  className="primary-button small-button"
                  onClick={() => void runCurrentStoreScan()}
                  disabled={dianxiaomiAccountScanner.isPending || dianxiaomiAccountScanImporter.isPending || !activeDianxiaomiPageContext}
                >
                  {dianxiaomiAccountScanner.isPending || dianxiaomiAccountScanImporter.isPending
                    ? "扫描中..."
                    : "扫描并导入" + (currentPageStoreImportableLinks.length > 0 ? " " + String(currentPageStoreImportableLinks.length) : "")}
                </button>
                <button
                  className="ghost-button small-button"
                  onClick={() => void runBatchPrepareForCurrentScope()}
                  disabled={dianxiaomiAccountScanner.isPending || dianxiaomiAccountScanImporter.isPending || batchPreparePending || batchPrepareActionableCount === 0}
                >
                  {batchPreparePending ? "准备中..." : "批量准备"}
                </button>
              </div>
              {accountScanMessage ? <p className="daily-message">{accountScanMessage}</p> : null}
              <details className="daily-inline-details">
                <summary>调整范围</summary>
                <div className="daily-inline-detail-body">
                  <label className="daily-scope-control">
                    <span>选择方式</span>
                    <select
                      value={selectedQueueProductScopeMode}
                      onChange={(event) => setSelectedQueueProductScopeMode(event.target.value as QueueProductScopeMode)}
                    >
                      <option value="ready-queue">当前 ready 队列</option>
                      <option value="item-urls">指定商品链接</option>
                      <option value="source-buckets">按来源筛选</option>
                    </select>
                  </label>
                  {selectedQueueProductScopeMode === "item-urls" ? (
                    <label className="daily-scope-control daily-scope-textarea">
                      <span>商品链接</span>
                      <textarea
                        rows={4}
                        value={selectedItemUrlsText}
                        onChange={(event) => setSelectedItemUrlsText(event.target.value)}
                        placeholder="每行一个商品链接"
                      />
                    </label>
                  ) : null}
                  {selectedQueueProductScopeMode === "source-buckets" ? (
                    <div className="daily-scope-control daily-scope-checkboxes">
                      <span>来源范围</span>
                      <div className="daily-scope-choice-list">
                        {automationSourceBucketOptions.map((option) => {
                          const checked = selectedSourceBuckets.includes(option.value)
                          return (
                            <label key={option.value} className="daily-scope-checkbox">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(event) => setSelectedSourceBuckets((current) =>
                                  event.target.checked
                                    ? Array.from(new Set<AutomationSourceBucket>([...current, option.value]))
                                    : current.filter((item) => item !== option.value)
                                )}
                              />
                              <span>{option.label}</span>
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  ) : null}
                  {selectedScopeConfigurationMessage ? <p className="daily-message">{selectedScopeConfigurationMessage}</p> : null}
                </div>
              </details>
            </article>

            <article className="daily-panel">
              <div className="daily-panel-head">
                <strong>自动处理</strong>
                <span>{dailySaveDraftProofStatusLabel}</span>
              </div>
              <div className="daily-mini-feed compact">
                <div>
                  <strong>图片检查</strong>
                  <span>{imageCheckPendingCount > 0 ? "待检 " + String(imageCheckPendingCount) + " / " + (imageCheckIssueSummary || "有图片问题") : "当前已过检"}</span>
                </div>
                <div>
                  <strong>草稿验证</strong>
                  <span>{dailySaveDraftCandidateSummary}</span>
                </div>
              </div>
              <div className={"daily-trial-gate " + dailyTrialGate.status}>
                <strong>{dailyTrialGate.recovery.title}</strong>
                <span>{dailyTrialGate.message}</span>
              </div>
              <div className="daily-trial-summary">
                {dailyTrialGate.details.map((item) => (
                  <div key={item.label} className={"daily-trial-stat " + item.tone}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>
              <div className="daily-panel-actions">
                <button
                  className="primary-button small-button"
                  onClick={() => void runBatchPrepareForCurrentScope()}
                  disabled={batchPreparePending || dianxiaomiImageChecker.isPending || batchPrepareActionableCount === 0}
                >
                  {batchPreparePending ? "准备中..." : "一键批量准备"}
                </button>
                <button
                  className="ghost-button small-button"
                  onClick={() => {
                    if (!dailySaveDraftCandidate) {
                      return
                    }
                    void dailySaveDraftProofRunner.mutateAsync({ workItemId: dailySaveDraftCandidate.id })
                  }}
                  disabled={!dailySaveDraftCandidate || dailySaveDraftProofRunning || dailyBackendOffline}
                >
                  {dailySaveDraftProofRunning ? "验证中..." : "验证保存草稿"}
                </button>
                <button className="ghost-button small-button" onClick={() => setShowDailyDetails((current) => !current)}>
                  {showDailyDetails ? "收起明细" : "查看明细"}
                </button>
              </div>
              {imageCheckMessage ? <p className="daily-message">{imageCheckMessage}</p> : null}
              {repairMessage ? <p className="daily-message">{repairMessage}</p> : null}
              {automationRecoveryRunMessage ? <p className="daily-message">{automationRecoveryRunMessage}</p> : null}
              {dailySaveDraftProofMessage ? <p className="daily-message">{dailySaveDraftProofMessage}</p> : null}
            </article>

            <article className="daily-panel">
              <div className="daily-panel-head">
                <strong>需要处理</strong>
                <span>{dailyTopAlerts.length > 0 ? String(dailyTopAlerts.length) + " 条" : "当前可直接运行"}</span>
              </div>
              {dailyTopAlerts.length > 0 ? (
                <div className="daily-alert-list">
                  {dailyTopAlerts.map((alert) => (
                    <div key={alert.id} className={"daily-alert " + alert.tone}>
                      <strong>{alert.title}</strong>
                      <span>{alert.message}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="daily-alert empty">
                  <strong>当前没有额外阻塞</strong>
                  <span>继续让店小秘页内插件加队列，然后在这里试跑或启动无人值守。</span>
                </div>
              )}
              <div className="daily-mini-feed compact">
                <div>
                  <strong>人工接手</strong>
                  <span>{dailyManualReviewSummary}</span>
                </div>
                <div>
                  <strong>最近结果</strong>
                  <span>{latestFullFlowSummary}</span>
                </div>
              </div>
              <div className="daily-panel-actions">
                <button
                  className="primary-button small-button"
                  onClick={() => void selectorCalibrationRunner.mutateAsync(dailySelectorCalibrationInput)}
                  disabled={selectorCalibrationRunner.isPending || dailyBackendOffline}
                >
                  {selectorCalibrationRunner.isPending ? "校准中..." : "页面校准"}
                </button>
                <button
                  className="ghost-button small-button"
                  onClick={() => void runCurrentScopeImageCheck()}
                  disabled={imageCheckPendingCount === 0 || batchPreparePending || dianxiaomiImageChecker.isPending}
                >
                  {dianxiaomiImageChecker.isPending ? "检测中..." : "只跑图片检查"}
                </button>
              </div>
              {selectorCalibrationMessage ? <p className="daily-message">{selectorCalibrationMessage}</p> : null}
            </article>
          </section>
          {showDailyDetails ? (
            <section className="daily-grid daily-validation-grid">
              <article className="daily-panel">
                <div className="daily-panel-head">
                  <strong>启动验收</strong>
                  <span>{startupBlockingChecks.length} blocked / {startupWarningChecks.length} warning</span>
                </div>
                <div className="daily-check-list">
                  {startupCalibrationCheck ? (
                    <div className={"daily-check " + startupCalibrationCheck.status}>
                      <strong>真实店小秘页面校准</strong>
                      <span>{startupCalibrationCheck.message}</span>
                    </div>
                  ) : null}
                  {startupBlockingChecks
                    .filter((item) => item.id !== "real-dianxiaomi-calibration")
                    .slice(0, 4)
                    .map((item) => (
                      <div key={item.id} className={"daily-check " + item.status}>
                        <strong>{item.label}</strong>
                        <span>{item.message}</span>
                      </div>
                    ))}
                  {startupBlockingChecks.length === 0 && startupWarningChecks.length === 0 ? (
                    <div className="daily-check pass">
                      <strong>启动条件正常</strong>
                      <span>可以启动无人值守队列。</span>
                    </div>
                  ) : null}
                </div>
                <div className="daily-mode-actions compact">
                  <button
                    className="ghost-button small-button"
                    onClick={() => void selectorCalibrationRunner.mutateAsync({ headed: true })}
                    disabled={selectorCalibrationRunner.isPending}
                  >
                    {selectorCalibrationRunner.isPending ? "校准中..." : "打开页面校准"}
                  </button>
                  <button
                    className="ghost-button small-button"
                    onClick={() => void automationQueueDaemonTicker.mutateAsync()}
                    disabled={automationQueueDaemonTicker.isPending || automationQueueDaemon?.status !== "ACTIVE"}
                  >
                    {automationQueueDaemonTicker.isPending ? "运行中..." : "立即检查一次"}
                  </button>
                </div>
              </article>

              <article className="daily-panel">
                <div className="daily-panel-head">
                  <strong>小批量试跑</strong>
                  <span>{dailyTrialLabel}</span>
                </div>
                <p className={"daily-message daily-trial-gate " + dailyTrialGate.status}>{dailyTrialGate.message}</p>
                <div className="daily-trial-summary">
                  {dailyTrialGate.details.map((item) => (
                    <div key={item.label} className={"daily-trial-stat " + item.tone}>
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                    </div>
                  ))}
                </div>
                <div className={"daily-trial-recovery " + dailyTrialGate.recovery.tone}>
                  <div>
                    <strong>{dailyTrialGate.recovery.title}</strong>
                    <span>{dailyTrialGate.recovery.message}</span>
                  </div>
                  <div className="daily-trial-actions">
                    {dailyTrialGate.recovery.actions.map((action) => <span key={action}>{action}</span>)}
                  </div>
                </div>
                {dailyTrialGate.failures.length > 0 ? (
                  <div className="daily-trial-failures">
                    {dailyTrialGate.failures.map((failure) => <span key={failure}>{failure}</span>)}
                  </div>
                ) : null}
              </article>
            </section>
          ) : null}
        </main>
      ) : (
        <div className="advanced-shell">
          <div className="advanced-tabbar">
            <div className="advanced-tab-title">
              <p className="eyebrow">Advanced</p>
              <h1>高级区</h1>
            </div>
            <nav className="advanced-tabs">
              <button type="button" className={"advanced-tab " + (advancedTab === "work" ? "active" : "")} onClick={() => setAdvancedTab("work")}>商品处理</button>
              <button type="button" className={"advanced-tab " + (advancedTab === "intake" ? "active" : "")} onClick={() => setAdvancedTab("intake")}>录入采集</button>
              <button type="button" className={"advanced-tab " + (advancedTab === "config" ? "active" : "")} onClick={() => setAdvancedTab("config")}>规则配置</button>
              <button type="button" className={"advanced-tab " + (advancedTab === "diagnostics" ? "active" : "")} onClick={() => setAdvancedTab("diagnostics")}>修复诊断</button>
            </nav>
          </div>
          <p className="advanced-console-hint">高级区默认隐藏，新增人工步骤前必须有自动化替代计划和下线时间。</p>

          {advancedTab === "work" ? (
            <div className="advanced-layout">
              <aside className="sidebar">
        <div className="queue-panel">
          <div className="queue-head">
              <strong>商品任务</strong>
              <p>{isLoading ? "正在加载..." : String(tasks.length) + " 个商品任务"}</p>
          </div>
          <div className="review-actions">
            <button
              className="primary-button small-button"
              onClick={() => void batchReviewer.mutateAsync({ taskIds: selectedReviewableTaskIds, decision: "approve", note: reviewNote })}
              disabled={batchReviewer.isPending || selectedReviewableTaskIds.length === 0}
            >
              批量通过
            </button>
            <button
              className="ghost-button small-button"
              onClick={() => void batchReviewer.mutateAsync({ taskIds: selectedReviewableTaskIds, decision: "request_changes", note: reviewNote })}
              disabled={batchReviewer.isPending || selectedReviewableTaskIds.length === 0}
            >
              批量退回
            </button>
            <button
              className="ghost-button danger-button small-button"
              onClick={() => void batchReviewer.mutateAsync({ taskIds: selectedReviewableTaskIds, decision: "reject", note: reviewNote })}
              disabled={batchReviewer.isPending || selectedReviewableTaskIds.length === 0}
            >
              批量驳回
            </button>
          </div>
          <div className="review-actions">
            <button
              className="ghost-button small-button"
              onClick={() => void batchPublishChecker.mutateAsync(selectedTaskIds)}
              disabled={batchPublishChecker.isPending || selectedTaskIds.length === 0}
            >
              批量检查
            </button>
            <button
              className="ghost-button small-button"
              onClick={() => void batchDraftRestorer.mutateAsync(selectedTaskIds)}
              disabled={batchDraftRestorer.isPending || selectedTaskIds.length === 0}
            >
              批量恢复 AI 草稿
            </button>
          </div>
          {batchRestoreMessage ? (
            <div className="import-result">
              <p>{batchRestoreMessage}</p>
            </div>
          ) : null}
          {batchPublishChecks.length > 0 ? (
            <div className="import-result">
              <p>发布前检查：{batchPublishableCount} 个可发布，{batchBlockingCount} 个需处理</p>
              <div className="import-warnings">
                {batchPublishChecks.slice(0, 6).map((check) => {
                  const task = tasks.find((item) => item.id === check.taskId)
                  return (
                    <span key={check.taskId}>
                      {task?.product.title ?? check.taskId}: {check.canPublish ? "OK" : check.issues.map((issue) => issue.message).join(" / ")}
                    </span>
                  )
                })}
              </div>
            </div>
          ) : null}
          <div className="queue-list">
              {tasks.map((task) => (
                <button key={task.id} className={"queue-item " + (task.id === activeTask?.id ? "active" : "")} onClick={() => setActiveTaskId(task.id)}>
                <div className="queue-item-top">
                  <input
                    type="checkbox"
                    checked={selectedTaskIds.includes(task.id)}
                    onChange={() => toggleTaskSelection(task.id)}
                    onClick={(event) => event.stopPropagation()}
                  />
                  <strong>{task.product.title}</strong>
                </div>
                <span>{task.product.category}</span>
                <span>{statusLabel[task.status]}</span>
              </button>
            ))}
          </div>
        </div>
              </aside>
              <main className="workspace">
                {activeTask ? (
                  <>
            <section className="hero-panel">
              <div className="hero-copy">
                <p className="eyebrow">当前商品</p>
                <h2>{activeTask.product.title}</h2>
                <p className="subtle">来源 {activeTask.product.source} / 类目 {activeTask.product.category}</p>
                <p className="ready-note">{readyLabel}</p>
              </div>
              <div className="hero-actions">
                <button className="ghost-button" onClick={() => void planner.mutateAsync(activeTask.product.id)} disabled={planner.isPending}>
                  {planner.isPending ? "AI 处理中..." : "AI 重新生成方案"}
                </button>
                <button className="primary-button" onClick={() => void syncer.mutateAsync(activeTask.id)} disabled={syncer.isPending || !canSyncToStore}>
                  {syncer.isPending ? "同步中..." : canSyncToStore ? "一键同步到店小秘" : "等待审核通过"}
                </button>
              </div>
            </section>

            <section className="summary-grid">
              <SummaryCard label="建议售价" value={formatMoney(activeTask.pricing.suggestedPriceUsd)} detail="按当前核价规则计算" />
              <SummaryCard label="保本底价" value={formatMoney(activeTask.pricing.floorPriceUsd)} detail="采购、物流、平台费合计" />
              <SummaryCard label="任务状态" value={statusLabel[activeTask.status]} detail="由任务和自动化报告回填" />
              <SummaryCard label="执行进度" value={String(progress) + "%"} detail="根据任务步骤完成情况计算" />
            </section>

            <section className="main-grid">
              <article className="panel">
                <div className="panel-head"><h3>AI 上品方案</h3></div>
                <InfoBlock label="发布标题">{activeTask.draft.listingTitle}</InfoBlock>
                <InfoBlock label="核心卖点">
                  <div className="tag-list">{activeTask.draft.sellingPoints.map((point) => <span key={point} className="tag-chip">{point}</span>)}</div>
                </InfoBlock>
                <InfoBlock label="商品描述">{activeTask.draft.description}</InfoBlock>
                <InfoBlock label="SKU 定价">
                  <div className="sku-list">
                    {activeTask.draft.skuPricing.map((sku) => (
                      <div key={sku.skuId} className="sku-item">
                        <strong>{sku.skuName}</strong>
                        <span>{sku.attributeSummary}</span>
                        <span>{formatMoney(sku.salePriceUsd)} / 库存 {sku.stock}</span>
                      </div>
                    ))}
                  </div>
                </InfoBlock>
              </article>

              <article className="panel">
                <div className="panel-head"><h3>草稿编辑</h3></div>
                {listingEditDraft ? (
                  <>
                    <div className="pricing-form">
                      <label>发布标题<input value={listingEditDraft.listingTitle} onChange={(event) => setListingEditField("listingTitle", event.target.value)} /></label>
                      <label>核心卖点<textarea className="compact-textarea" value={listingEditDraft.sellingPointsText} onChange={(event) => setListingEditField("sellingPointsText", event.target.value)} /></label>
                      <label>商品描述<textarea className="compact-textarea tall-textarea" value={listingEditDraft.description} onChange={(event) => setListingEditField("description", event.target.value)} /></label>
                      <label>类目路径<textarea className="compact-textarea" value={listingEditDraft.categoryPathText} onChange={(event) => setListingEditField("categoryPathText", event.target.value)} /></label>
                      <label>草稿属性<textarea className="compact-textarea" value={listingEditDraft.attributesText} onChange={(event) => setListingEditField("attributesText", event.target.value)} /></label>
                      <label>SKU 售价<textarea className="compact-textarea tall-textarea" placeholder="skuId,SKU名,售价USD,库存,属性" value={listingEditDraft.skuPricingText} onChange={(event) => setListingEditField("skuPricingText", event.target.value)} /></label>
                    </div>
                    <button className="primary-button import-button" onClick={() => {
                      const input = buildDraftUpdatePayload()
                      if (input) void draftUpdater.mutateAsync({ taskId: activeTask.id, input })
                    }} disabled={draftUpdater.isPending || !listingEditDraft.listingTitle}>
                      {draftUpdater.isPending ? "保存中..." : "保存草稿内容"}
                    </button>
                    <div className="draft-history">
                      <strong>草稿版本</strong>
                      {(activeTask.draftVersions ?? []).length > 0 ? (
                        <div className="draft-version-list">
                          {(activeTask.draftVersions ?? []).slice(0, 8).map((version) => (
                            <div key={version.id} className="draft-version-item">
                              <div>
                                <span>{version.label}</span>
                                <small>{version.source} / {new Date(version.createdAt).toLocaleString()}</small>
                              </div>
                              <button
                                className="ghost-button small-button"
                                onClick={() => void draftRestorer.mutateAsync({ taskId: activeTask.id, versionId: version.id })}
                                disabled={draftRestorer.isPending}
                              >
                                恢复
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : <div className="empty-report">暂无草稿版本</div>}
                    </div>
                  </>
                ) : null}
              </article>
            </section>

            <section className="main-grid">
              <article className="panel">
                <div className="panel-head"><h3>商品编辑</h3></div>
                {productEditDraft ? (
                  <>
                    <div className="pricing-form two-col-form">
                      <label>商品标题<input value={productEditDraft.title} onChange={(event) => setProductEditField("title", event.target.value)} /></label>
                      <label>类目<input value={productEditDraft.category} onChange={(event) => setProductEditField("category", event.target.value)} /></label>
                      <label>成本价 CNY<input type="number" step="0.01" value={productEditDraft.supplierPriceCny} onChange={(event) => setProductEditField("supplierPriceCny", event.target.value)} /></label>
                      <label>国内运费 CNY<input type="number" step="0.01" value={productEditDraft.estimatedDomesticShippingCny} onChange={(event) => setProductEditField("estimatedDomesticShippingCny", event.target.value)} /></label>
                      <label>重量 kg<input type="number" step="0.01" value={productEditDraft.estimatedWeightKg} onChange={(event) => setProductEditField("estimatedWeightKg", event.target.value)} /></label>
                      <label>总库存<input type="number" step="1" value={productEditDraft.stock} onChange={(event) => setProductEditField("stock", event.target.value)} /></label>
                      <label className="wide-field">来源链接<input value={productEditDraft.sourceUrl} onChange={(event) => setProductEditField("sourceUrl", event.target.value)} /></label>
                      <label className="wide-field">商品属性<textarea className="compact-textarea" value={productEditDraft.attributesText} onChange={(event) => setProductEditField("attributesText", event.target.value)} /></label>
                      <label className="wide-field">图片链接<textarea className="compact-textarea" value={productEditDraft.imagesText} onChange={(event) => setProductEditField("imagesText", event.target.value)} /></label>
                      <label className="wide-field">SKU 列表<textarea className="compact-textarea tall-textarea" value={productEditDraft.skusText} onChange={(event) => setProductEditField("skusText", event.target.value)} /></label>
                    </div>
                    <button className="primary-button import-button" onClick={() => {
                      const input = buildProductUpdatePayload()
                      if (input) void productUpdater.mutateAsync({ taskId: activeTask.id, input })
                    }} disabled={productUpdater.isPending || !productEditDraft.title || !productEditDraft.category}>
                      {productUpdater.isPending ? "保存中..." : "保存并重建方案"}
                    </button>
                  </>
                ) : null}
              </article>

              <article className="panel">
                <div className="panel-head"><h3>审核工作台</h3></div>
                <div className="review-history">
                  <strong>发布前检查</strong>
                  {publishCheck ? (
                    <>
                      <div className={"review-state " + (publishCheck.canPublish ? "approved" : "rejected")}>
                        <strong>{publishCheck.canPublish ? "可以发布" : "存在问题"}</strong>
                        <span>{new Date(publishCheck.checkedAt).toLocaleString()}</span>
                      </div>
                      <div className="risk-list-simple">
                        {publishCheck.issues.length > 0
                          ? publishCheck.issues.map((issue) => (
                              <div key={issue.id} className={"risk-pill " + issue.level}>
                                {issue.message}
                              </div>
                            ))
                          : <div className="empty-report">暂无问题，可以提交上架。</div>}
                      </div>
                    </>
                  ) : (
                    <div className="empty-report">暂未生成发布前检查结果。</div>
                  )}
                </div>
                <div className="review-box">
                  <div className={"review-state " + (activeTask.review?.status ?? "pending")}>
                    <strong>{reviewStatusLabel[activeTask.review?.status ?? "pending"]}</strong>
                    <span>{activeTask.review?.note || "暂无审核备注"}</span>
                  </div>
                  <textarea
                    className="compact-textarea"
                    placeholder="填写审核备注、修改要求或驳回原因"
                    value={reviewNote}
                    onChange={(event) => setReviewNote(event.target.value)}
                  />
                  <div className="review-actions">
                    <button className="primary-button" onClick={() => void reviewer.mutateAsync({ taskId: activeTask.id, decision: "approve", note: reviewNote })} disabled={reviewer.isPending}>
                      审核通过
                    </button>
                    <button className="ghost-button" onClick={() => void reviewer.mutateAsync({ taskId: activeTask.id, decision: "request_changes", note: reviewNote })} disabled={reviewer.isPending}>
                      退回修改?                    </button>
                    <button className="ghost-button danger-button" onClick={() => void reviewer.mutateAsync({ taskId: activeTask.id, decision: "reject", note: reviewNote })} disabled={reviewer.isPending}>
                      驳回
                    </button>
                  </div>
                  <div className="review-history">
                    {(activeTask.review?.history ?? []).length > 0 ? activeTask.review?.history.map((event) => (
                        <div key={String(event.createdAt) + "-" + event.decision} className="review-history-item">
                        <strong>{reviewDecisionLabel[event.decision]}</strong>
                          <span>{event.note || "无备注"}</span>
                        <small>{new Date(event.createdAt).toLocaleString()}</small>
                      </div>
                    )) : <div className="empty-report">暂无审核记录</div>}
                  </div>
                </div>
              </article>

              <article className="panel">
                <div className="panel-head"><h3>执行步骤</h3></div>
                <div className="flow-list">
                  {activeTask.steps.map((step) => (
                    <div key={step.id} className={"flow-item step-" + step.status}>
                      <strong>{step.title}</strong>
                      <p>{step.instruction}</p>
                      <span>{step.status}</span>
                    </div>
                  ))}
                </div>
              </article>
            </section>

            <section className="bottom-grid">
              <article className="panel">
                <div className="panel-head"><h3>核价说明</h3></div>
                <div className="explain-list">{activeTask.pricing.rationale.map((item) => <div key={item} className="explain-item">{item}</div>)}</div>
              </article>
              <article className="panel">
                <div className="panel-head"><h3>风险提醒</h3></div>
                <div className="risk-list-simple">
                  {activeTask.risks.length > 0
                    ? activeTask.risks.map((risk) => <div key={risk.id} className={"risk-pill " + risk.level}>{risk.message}</div>)
                    : <div className="empty-report">暂无风险提醒</div>}
                </div>
              </article>
            </section>

            <section className="panel">
              <div className="panel-head split-head">
                <h3>最近自动化报告</h3>
                <span className="report-count">{automationReports.length} 条</span>
              </div>
              <div className="automation-launch-form">
                <label>
                  <span>Preset</span>
                  <select
                    value={selectedAutomationPresetId}
                    onChange={(event) => {
                      const preset = automationLaunchPresets.find((item) => item.id === event.target.value)
                      setSelectedAutomationPresetId(event.target.value)
                      if (preset) {
                        setAutomationPresetName(preset.name)
                        setAutomationLaunchDraft(automationDraftFromInput(preset.input))
                      }
                    }}
                  >
                    <option value="">new preset</option>
                    {automationLaunchPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Preset name</span>
                  <input
                    value={automationPresetName}
                    onChange={(event) => setAutomationPresetName(event.target.value)}
                    placeholder="Dianxiaomi draft flow"
                  />
                </label>
                <label>
                  <span>Target URL</span>
                  <input
                    value={automationLaunchDraft.url}
                    onChange={(event) => setAutomationLaunchDraft((current) => ({
                      ...current,
                      url: event.target.value
                    }))}
                    placeholder="default Dianxiaomi URL"
                  />
                </label>
                <label>
                  <span>Task file</span>
                  <input
                    value={automationLaunchDraft.taskFile}
                    onChange={(event) => setAutomationLaunchDraft((current) => ({
                      ...current,
                      taskFile: event.target.value
                    }))}
                    placeholder=".runtime/task.json"
                  />
                </label>
                <label>
                  <span>Selector config</span>
                  <input
                    value={automationLaunchDraft.selectorConfig}
                    onChange={(event) => setAutomationLaunchDraft((current) => ({
                      ...current,
                      selectorConfig: event.target.value
                    }))}
                    placeholder=".runtime/dianxiaomi-selector-config.json"
                  />
                </label>
                <label>
                  <span>Profile</span>
                  <input
                    value={automationLaunchDraft.profile}
                    onChange={(event) => setAutomationLaunchDraft((current) => ({
                      ...current,
                      profile: event.target.value
                    }))}
                    placeholder=".runtime/dianxiaomi-real-profile"
                  />
                </label>
                <label>
                  <span>Screenshots</span>
                  <input
                    value={automationLaunchDraft.screenshots}
                    onChange={(event) => setAutomationLaunchDraft((current) => ({
                      ...current,
                      screenshots: event.target.value
                    }))}
                    placeholder="output/playwright"
                  />
                </label>
                <label>
                  <span>Media automation</span>
                  <select
                    value={automationLaunchDraft.mediaAutomationMode}
                    onChange={(event) => setAutomationLaunchDraft((current) => ({
                      ...current,
                      mediaAutomationMode: event.target.value
                    }))}
                  >
                    <option value="plan-only">plan-only</option>
                    <option value="unattended-open">unattended-open</option>
                    <option value="unattended-apply">unattended-apply</option>
                  </select>
                </label>
                <label>
                  <span>Media tools</span>
                  <textarea
                    className="compact-textarea"
                    value={automationLaunchDraft.mediaAutomationTools}
                    onChange={(event) => setAutomationLaunchDraft((current) => ({
                      ...current,
                      mediaAutomationTools: event.target.value
                    }))}
                    placeholder="image-translation&#10;batch-resize&#10;white-background"
                  />
                </label>
                <label className="automation-toggle">
                  <input
                    type="checkbox"
                    checked={automationLaunchDraft.headed}
                    onChange={(event) => setAutomationLaunchDraft((current) => ({
                      ...current,
                      headed: event.target.checked
                    }))}
                  />
                  <span>Headed browser</span>
                </label>
                <label className="automation-toggle">
                  <input
                    type="checkbox"
                    checked={automationLaunchDraft.submitAfterSave}
                    onChange={(event) => setAutomationLaunchDraft((current) => ({
                      ...current,
                      submitAfterSave: event.target.checked
                    }))}
                  />
                  <span>Submit after save</span>
                </label>
                <label>
                  <span>Submit attempts</span>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={automationLaunchDraft.submitMaxAttempts}
                    onChange={(event) => setAutomationLaunchDraft((current) => ({
                      ...current,
                      submitMaxAttempts: event.target.value
                    }))}
                  />
                </label>
                <button
                  className="ghost-button small-button"
                  onClick={() => setAutomationLaunchDraft(defaultAutomationLaunchDraft)}
                >
                  reset params
                </button>
                <button
                  className="ghost-button small-button"
                  onClick={() => activeTask && void automationTaskFileExporter.mutateAsync({
                    taskId: activeTask.id,
                    input: {}
                  })}
                  disabled={!activeTask || automationTaskFileExporter.isPending}
                >
                  {automationTaskFileExporter.isPending ? "exporting task..." : "export active task"}
                </button>
                <button
                  className="ghost-button small-button"
                  onClick={() => {
                    setSelectedAutomationPresetId("")
                    setAutomationPresetName("")
                    setAutomationLaunchDraft(defaultAutomationLaunchDraft)
                  }}
                >
                  new preset
                </button>
                <button
                  className="primary-button small-button"
                  onClick={() => {
                    const name = automationPresetName.trim() || selectedAutomationPreset?.name || "Automation preset"
                    if (selectedAutomationPresetId) {
                      void automationPresetUpdater.mutateAsync({
                        id: selectedAutomationPresetId,
                        input: {
                          name,
                          input: automationStartInput
                        }
                      })
                    } else {
                      void automationPresetCreator.mutateAsync({
                        name,
                        input: automationStartInput
                      })
                    }
                  }}
                  disabled={automationPresetCreator.isPending || automationPresetUpdater.isPending}
                >
                  {selectedAutomationPresetId ? "update preset" : "save preset"}
                </button>
                <button
                  className="ghost-button danger-button small-button"
                  onClick={() => void automationPresetDeleter.mutateAsync(selectedAutomationPresetId)}
                  disabled={!selectedAutomationPresetId || automationPresetDeleter.isPending}
                >
                  delete preset
                </button>
              </div>
              {automationPresetMessage ? (
                <div className="import-result">
                  <p>{automationPresetMessage}</p>
                </div>
              ) : null}
              {automationTaskFileMessage ? (
                <div className="import-result">
                  <p>{automationTaskFileMessage}</p>
                </div>
              ) : null}
              {automationTaskFileExports.length > 0 ? (
                <div className="task-export-list">
                  <label className="task-export-filter">
                    <input
                      type="checkbox"
                      checked={showBlockedTaskFiles}
                      onChange={(event) => setShowBlockedTaskFiles(event.target.checked)}
                    />
                    <span>show blocked task files ({blockedTaskFileExportCount})</span>
                  </label>
                  {visibleTaskFileExports.map((item) => (
                    <div key={item.exportId} className={"task-export-item " + taskFileLaunchClass(item)}>
                      <div>
                        <div className="task-export-title">
                          <strong>{item.taskId}</strong>
                          <span className={"task-export-status " + taskFileLaunchClass(item)}>{item.launchStatus.status}</span>
                        </div>
                        <span>{item.taskFile}</span>
                        <small>{new Date(item.exportedAt).toLocaleString()} / {item.taskStatus} / {item.bytes} bytes / {item.sha256.slice(0, 12)}</small>
                        <small>{item.launchStatus.reason}</small>
                        {item.launchStatus.dianxiaomiUrlChecks.length > 0 ? (
                            <small>{item.launchStatus.dianxiaomiUrlChecks.map((check) => check.label + ": " + (check.valid ? "valid" : check.reason ?? "invalid")).join(" / ")}</small>
                        ) : null}
                      </div>
                      <div className="task-export-actions">
                        <button
                          className="ghost-button small-button"
                          onClick={() => {
                            setSelectedTaskFileExportId(item.exportId)
                          }}
                        >
                          compare
                        </button>
                        <button
                          className="ghost-button small-button"
                          onClick={() => void automationTaskFileExporter.mutateAsync({
                            taskId: item.taskId,
                            input: {
                              outputPath: item.taskFile
                            }
                          })}
                          disabled={automationTaskFileExporter.isPending}
                        >
                          refresh
                        </button>
                        <button
                          className="ghost-button small-button"
                          onClick={() => setAutomationLaunchDraft((current) => ({
                            ...current,
                            taskFile: item.taskFile
                          }))}
                          disabled={item.launchStatus.status === "blocked"}
                        >
                          load
                        </button>
                      </div>
                    </div>
                  ))}
                  {visibleTaskFileExports.length === 0 ? (
                    <div className="task-export-empty">No launchable task files. Export a current real Dianxiaomi task or enable blocked files for diagnosis.</div>
                  ) : null}
                </div>
              ) : null}
              {selectedTaskFileExportDiff ? (
                <TaskSnapshotDiffPreview
                  diff={selectedTaskFileExportDiff}
                  maxEntries={6}
                  isRepairing={automationTaskFileExporter.isPending}
                  onRepair={() => void automationTaskFileExporter.mutateAsync({
                    taskId: selectedTaskFileExportDiff.currentTask.id,
                    input: {
                      outputPath: selectedTaskFileExportDiff.export.taskFile
                    }
                  })}
                />
              ) : null}
              {automationPreflight ? (
                <AutomationRunConfirmation
                  report={automationPreflight}
                  writeModeConfirmed={writeModeConfirmed}
                  setWriteModeConfirmed={setWriteModeConfirmed}
                />
              ) : null}
              <button
                className="ghost-button small-button"
                onClick={() => void automationDryRunner.mutateAsync(automationStartInput)}
                disabled={automationDryRunner.isPending}
              >
                {automationDryRunner.isPending ? "starting dry-run..." : "Start dry-run"}
              </button>
              <button
                className="primary-button small-button"
                onClick={() => void automationFullFlowRunner.mutateAsync({
                  ...automationStartInput,
                  mediaAutomationMode: automationStartInput.mediaAutomationMode ?? "unattended-apply"
                })}
                disabled={automationFullFlowRunner.isPending}
              >
                {automationFullFlowRunner.isPending ? "starting full flow..." : "Start full flow"}
              </button>
              <button
                className="primary-button small-button"
                onClick={() => void automationQueueRunner.mutateAsync({
                  ...automationStartInput,
                  ...selectedQueueScopeInput,
                  mediaAutomationMode: automationStartInput.mediaAutomationMode ?? "unattended-apply",
                  limit: 1
                })}
                disabled={automationQueueRunner.isPending || !selectedQueueProductScopeReady}
              >
                {automationQueueRunner.isPending ? "starting queue..." : "Run ready queue"}
              </button>
              <div className="automation-launch-form">
                <label>
                  <span>Daemon interval seconds</span>
                  <input
                    type="number"
                    min="15"
                    max="86400"
                    value={automationQueueDaemonInterval}
                    onChange={(event) => setAutomationQueueDaemonInterval(event.target.value)}
                  />
                </label>
                <label>
                  <span>Max consecutive failures</span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={automationQueueDaemonMaxFailures}
                    onChange={(event) => setAutomationQueueDaemonMaxFailures(event.target.value)}
                  />
                </label>
                <button
                  className="primary-button small-button"
                  onClick={() => void automationQueueDaemonStarter.mutateAsync({
                    ...automationStartInput,
                    ...selectedQueueScopeInput,
                    mediaAutomationMode: automationStartInput.mediaAutomationMode ?? "unattended-apply",
                    intervalSeconds: Number.parseInt(automationQueueDaemonInterval, 10) || 300,
                    maxConsecutiveFailures: Number.parseInt(automationQueueDaemonMaxFailures, 10) || 3,
                    limit: 1
                  })}
                  disabled={automationQueueDaemonStarter.isPending || !selectedQueueProductScopeReady}
                >
                  {automationQueueDaemonStarter.isPending ? "starting daemon..." : "Start queue daemon"}
                </button>
                <button
                  className="ghost-button small-button"
                  onClick={() => void automationQueueDaemonPauser.mutateAsync()}
                  disabled={automationQueueDaemonPauser.isPending || automationQueueDaemon?.status !== "ACTIVE"}
                >
                  {automationQueueDaemonPauser.isPending ? "pausing daemon..." : "Pause daemon"}
                </button>
                <button
                  className="ghost-button small-button"
                  onClick={() => void automationQueueDaemonTicker.mutateAsync()}
                  disabled={automationQueueDaemonTicker.isPending || automationQueueDaemon?.status !== "ACTIVE"}
                >
                  {automationQueueDaemonTicker.isPending ? "running tick..." : "Run daemon tick"}
                </button>
              </div>
              <button
                className="ghost-button small-button"
                onClick={() => void automationFillDraftRunner.mutateAsync(automationStartInput)}
                disabled={automationFillDraftRunner.isPending || !canStartFillDraft}
              >
                {automationFillDraftRunner.isPending ? "starting fill draft..." : writeModeConfirmed ? "Start fill draft" : "Confirm to fill"}
              </button>
              <button
                className="ghost-button small-button"
                onClick={() => void automationSaveDraftRunner.mutateAsync(automationStartInput)}
                disabled={automationSaveDraftRunner.isPending || !canStartSaveDraft}
              >
                {automationSaveDraftRunner.isPending ? "starting save draft..." : writeModeConfirmed ? "Start save draft" : "Confirm to save"}
              </button>
              <button
                className="ghost-button small-button"
                onClick={() => void automationSubmitListingRunner.mutateAsync(automationStartInput)}
                disabled={automationSubmitListingRunner.isPending || !canStartSubmitListing}
              >
                {automationSubmitListingRunner.isPending ? "starting submit..." : writeModeConfirmed ? "Start submit listing" : "Confirm to submit"}
              </button>
              {automationReadiness ? (
                <div className="automation-gate-grid">
                  {automationGateItems.map((item) => (
                    <div key={item.label} className={"automation-gate " + (item.readiness?.ready ? "ready" : "blocked")}>
                      <strong>{item.label}</strong>
                      <span>{item.readiness?.ready ? "ready" : "blocked"}</span>
                      <p>{item.readiness?.reason ?? "readiness loading"}</p>
                      {item.readiness?.selectorValidation ? (
                        <div className="automation-gate-issues">
                          <span>{item.readiness.selectorValidation.valid ? "selectors valid" : "selectors blocked"}</span>
                          {item.readiness.selectorBlockers?.map((issue) => (
                            <p key={issue.id}>{issue.level}: {issue.message}</p>
                          ))}
                          {item.readiness.selectorValidation.issues
                            .filter((issue) => issue.level !== "error")
                            .slice(0, 2)
                            .map((issue) => (
                              <p key={issue.id}>{issue.level}: {issue.message}</p>
                            ))}
                        </div>
                      ) : null}
                      {item.readiness?.runningJobId ? <span>running {item.readiness.runningJobId}</span> : null}
                      {item.readiness?.targetFingerprint ? <code>{item.readiness.targetFingerprint.slice(0, 12)}</code> : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {automationPreflight ? <AutomationPreflightCard report={automationPreflight} /> : null}
              {automationUnattendedStartupCheck ? <UnattendedStartupCheckCard check={automationUnattendedStartupCheck} /> : null}
              {automationDryRunMessage ? (
                <div className="import-result">
                  <p>{automationDryRunMessage}</p>
                </div>
              ) : null}
              {automationFullFlowMessage ? (
                <div className="import-result">
                  <p>{automationFullFlowMessage}</p>
                </div>
              ) : null}
              {automationQueueRunMessage ? (
                <div className="import-result">
                  <p>{automationQueueRunMessage}</p>
                </div>
              ) : null}
              {automationQueueDaemonMessage ? (
                <div className="import-result">
                  <p>{automationQueueDaemonMessage}</p>
                </div>
              ) : null}
              {automationQueueDaemonHealth ? (
                <QueueDaemonHealthCard
                  health={automationQueueDaemonHealth}
                  profileLockArchiveReadiness={profileLockArchiveReadiness}
                  manualBudgetTrials={manualBudgetTrials}
                  manualBudgetTrialPending={manualBudgetTrialRunner.isPending || manualBudgetValidationRunner.isPending}
                  profileLockArchivePending={profileLockArchiver.isPending}
                  onStartManualBudgetTrial={requestManualBudgetTrial}
                  onStartNextManualBudgetValidation={requestNextManualBudgetValidation}
                  onArchiveStaleProfileLocks={() => void profileLockArchiver.mutateAsync({
                    ...automationStartInput,
                    ...selectedQueueScopeInput
                  })}
                />
              ) : null}
              {automationQueueDaemon ? <QueueDaemonCard state={automationQueueDaemon} /> : null}
              {automationFillDraftMessage ? (
                <div className="import-result">
                  <p>{automationFillDraftMessage}</p>
                </div>
              ) : null}
              {automationSaveDraftMessage ? (
                <div className="import-result">
                  <p>{automationSaveDraftMessage}</p>
                </div>
              ) : null}
              {automationSubmitListingMessage ? (
                <div className="import-result">
                  <p>{automationSubmitListingMessage}</p>
                </div>
              ) : null}
              {automationDryRunJobs.length > 0 ? (
                <div className="report-list">
                  {automationDryRunJobs.slice(0, 3).map((job) => <DryRunJobCard key={job.id} job={job} />)}
                </div>
              ) : null}
              {automationFullFlowJobsInScope.length > 0 ? (
                <div className="report-list">
                  {automationFullFlowJobsInScope.slice(0, 3).map((job) => <FullFlowJobCard key={job.id} job={job} />)}
                </div>
              ) : null}
              {automationQueueRunsInScope.length > 0 ? (
                <div className="report-list">
                  {automationQueueRunsInScope.slice(0, 3).map((run) => <QueueRunCard key={run.id} run={run} />)}
                </div>
              ) : null}
              {automationFillDraftJobs.length > 0 ? (
                <div className="report-list">
                  {automationFillDraftJobs.slice(0, 3).map((job) => <FillDraftJobCard key={job.id} job={job} />)}
                </div>
              ) : null}
              {automationRepairPreviewJobs.length > 0 ? (
                <div className="report-list">
                  {automationRepairPreviewJobs.slice(0, 3).map((job) => <RepairPreviewJobCard key={job.id} job={job} />)}
                </div>
              ) : null}
              {automationRepairApplyJobs.length > 0 ? (
                <div className="report-list">
                  {automationRepairApplyJobs.slice(0, 3).map((job) => <RepairApplyJobCard key={job.id} job={job} />)}
                </div>
              ) : null}
              {automationSaveDraftJobs.length > 0 ? (
                <div className="report-list">
                  {automationSaveDraftJobs.slice(0, 3).map((job) => <SaveDraftJobCard key={job.id} job={job} />)}
                </div>
              ) : null}
              {automationSubmitListingJobs.length > 0 ? (
                <div className="report-list">
                  {automationSubmitListingJobs.slice(0, 3).map((job) => <SubmitListingJobCard key={job.id} job={job} />)}
                </div>
              ) : null}
              <div className="report-list">
                {automationReports.length > 0 ? automationReports.slice(0, 6).map((report) => {
                  const failedSteps = report.steps.filter((step) => step.status === "failed")
                  const doneCount = report.steps.filter((step) => step.status === "done").length
                  const targetSurfaceStep = report.steps.find((step) => step.id === "target-surface")
                  return (
                    <div key={report.id} className={"automation-report " + report.status}>
                      <div className="report-main">
                        <strong>{report.taskTitle}</strong>
                        <span>{new Date(report.createdAt).toLocaleString()}</span>
                        <span>{report.platform} / {report.status} / done {doneCount}/{report.steps.length}</span>
                      </div>
                      <div className="report-detail">
                        <span>{report.pageTitle || report.pageUrl}</span>
                        <span>{report.screenshotPath}</span>
                        <TargetSurfaceSummary step={targetSurfaceStep} />
                        {failedSteps.length > 0 ? <div className="failed-steps">{failedSteps.map((step) => <span key={step.id}>{step.label}: {step.detail}</span>)}</div> : null}
                      </div>
                    </div>
                  )
                }) : <div className="empty-report">暂无自动化执行报告。</div>}
              </div>
            </section>
                  </>
                ) : (
          <section className="hero-panel">
            <div className="hero-copy">
              <h2>暂无商品任务</h2>
              <p className="subtle">导入或手动录入商品后会显示任务。</p>
            </div>
          </section>
                )}
              </main>
            </div>
          ) : advancedTab === "intake" ? (
            <div className="advanced-grid">
        <div className="queue-panel">
          <div className="queue-head">
            <strong>店小秘编辑队列</strong>
            <p>{scopeWorkItemCount} 个店小秘商品待按需求规则编辑，当前范围 {selectedQueueScopeSummary}。</p>
          </div>
          {imageCheckMessage ? (
            <div className="import-result">
              <p>{imageCheckMessage}</p>
            </div>
          ) : null}
          {repairMessage ? (
            <div className="import-result">
              <p>{repairMessage}</p>
            </div>
          ) : null}
          <div className="collected-product-list">
            {dianxiaomiProductWorkItems.length > 0 ? dianxiaomiProductWorkItems.slice(0, 6).map((item) => (
              <div key={item.id} className="collected-product-item">
                {(() => {
                  const latestImageCheckJob = latestImageCheckJobByWorkItemId.get(item.id) ?? null
                  const latestRepairPreviewJob = latestRepairPreviewJobByWorkItemId.get(item.id) ?? null
                  const latestRepairApplyJob = latestRepairApplyJobByWorkItemId.get(item.id) ?? null
                  const imageCheckIssues = item.snapshot.imageCheck?.issues ?? []
                  const repairActions = item.repairPlan?.actions ?? []
                  const autoRepairable = item.repairPlan?.status === "auto-ready"
                    && item.repairPlan.canAutoRepair
                    && repairActions.length > 0
                    && repairActions.every((action) => action.automation === "auto")
                  const repairRunning = latestRepairApplyJob?.status === "running" || latestRepairPreviewJob?.status === "running"
                  const repairToolSummary = repairActions
                    .filter((action) => action.payload?.writer === "run-media-tool")
                    .map((action) => action.payload?.mediaTool ?? action.tool ?? action.target ?? action.label)
                    .filter(Boolean)
                    .join(" / ")
                  return (
                    <>
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.pageProfile ?? "店小秘商品"} / {item.status} / {item.storeName ?? item.storeId ?? "未知店铺"}</span>
                  <small>{new Date(item.updatedAt).toLocaleString()} / 必检 {item.requirements.summary.requiredPassed}/{item.requirements.summary.requiredTotal} / SKU {item.snapshot.skuCount} / 图片 {item.snapshot.imageCount}</small>
                  {item.snapshot.imageCheck ? (
                    <small>
                      图片检查：{item.snapshot.imageCheck.passed ? "通过" : imageCheckIssues.length > 0 ? imageCheckIssues.map((issue) => issue.category + " " + issue.issue).join(" / ") : "失败"}
                    </small>
                  ) : null}
                  {latestImageCheckJob ? (
                    <small>
                      最近图片检查：{latestImageCheckJob.status}{latestImageCheckJob.result ? latestImageCheckJob.result.passed ? " / 通过" : " / " + latestImageCheckJob.result.summary.join(" / ") : ""}
                    </small>
                  ) : null}
                  {item.repairPlan ? (
                    <small>
                      修复计划：{item.repairPlan.status} / {item.repairPlan.summary}{repairToolSummary ? " / " + repairToolSummary : ""}
                    </small>
                  ) : null}
                  {latestRepairPreviewJob ? (
                    <small>
                      最近预修复：{latestRepairPreviewJob.status}{latestRepairPreviewJob.reportStatus ? " / " + latestRepairPreviewJob.reportStatus : ""}
                    </small>
                  ) : null}
                  {latestRepairApplyJob ? (
                    <small>
                      最近执行修复：{latestRepairApplyJob.status}{latestRepairApplyJob.reportStatus ? " / " + latestRepairApplyJob.reportStatus : ""}
                    </small>
                  ) : null}
                  {item.suggestedEdits.length > 0 ? (
                    <small>{item.suggestedEdits.slice(0, 3).map((edit) => edit.field + ": " + (edit.suggestedValue || edit.reason)).join(" / ")}</small>
                  ) : null}
                </div>
                <div className="task-export-actions">
                  <button
                    className="ghost-button small-button"
                    onClick={() => window.open(item.pageUrl, "_blank", "noopener,noreferrer")}
                  >
                    打开页面
                  </button>
                  <button
                    className="ghost-button small-button"
                    onClick={() => void dianxiaomiImageChecker.mutateAsync({ workItemId: item.id })}
                    disabled={dianxiaomiImageChecker.isPending || latestImageCheckJob?.status === "running"}
                  >
                    {latestImageCheckJob?.status === "running" ? "检查中..." : "图片检查"}
                  </button>
                  <button
                    className="ghost-button small-button"
                    onClick={() => void dianxiaomiRepairPreviewRunner.mutateAsync({ workItemId: item.id })}
                    disabled={!item.repairPlan || repairRunning || dianxiaomiRepairPreviewRunner.isPending}
                  >
                    {latestRepairPreviewJob?.status === "running" ? "预览中..." : "预修复"}
                  </button>
                  <button
                    className="primary-button small-button"
                    onClick={() => void dianxiaomiRepairApplyRunner.mutateAsync({ workItemId: item.id })}
                    disabled={!autoRepairable || repairRunning || dianxiaomiRepairApplyRunner.isPending}
                  >
                    {latestRepairApplyJob?.status === "running" ? "修复中..." : "执行自动修复"}
                  </button>
                  <button
                    className="ghost-button small-button"
                    onClick={() => void dianxiaomiWorkItemTaskCreator.mutateAsync(item.id)}
                    disabled={dianxiaomiWorkItemTaskCreator.isPending}
                  >
                    生成编辑任务
                  </button>
                </div>
                    </>
                  )
                })()}
              </div>
            )) : (
              <div className="empty-report">打开店小秘采集/商品编辑页，点击插件按钮即可加入这里。</div>
            )}
          </div>
        </div>
        <div className="queue-panel">
          <div className="queue-head">
            <strong>店小秘采集</strong>
            <p>{dianxiaomiCollectedProducts.length} 个来自浏览器插件的采集商品，当前范围 {selectedQueueScopeSummary}。</p>
          </div>
          <div className="collected-product-list">
            {dianxiaomiCollectedProducts.length > 0 ? dianxiaomiCollectedProducts.slice(0, 6).map((product) => (
              <div key={product.id} className="collected-product-item">
                <div>
                  <strong>{product.title}</strong>
                  <span>{product.category} / {product.storeName ?? product.storeId ?? "未知店铺"}</span>
                  <small>{new Date(product.collectedAt).toLocaleString()} / {product.quality.status} {product.quality.score}% / SKU {product.skus.length} / images {product.images.length}</small>
                  {product.quality.checks.some((check) => !check.ok) ? (
                    <small>{product.quality.checks.filter((check) => !check.ok).map((check) => check.message).join(" / ")}</small>
                  ) : null}
                </div>
                <button
                  className="ghost-button small-button"
                  onClick={() => void dianxiaomiCollectedTaskCreator.mutateAsync(product.id)}
                  disabled={dianxiaomiCollectedTaskCreator.isPending}
                >
                  生成任务
                </button>
              </div>
            )) : (
              <div className="empty-report">暂无店小秘采集商品，在插件面板点击“采集商品”。</div>
            )}
          </div>
        </div>
        <div className="queue-panel">
          <div className="queue-head">
            <strong>手动录入</strong>
            <p>临时录入一个商品，可填写多 SKU。</p>
          </div>
          <div className="pricing-form">
            <label>商品标题<input value={manualProduct.title} onChange={(event) => setManualField("title", event.target.value)} /></label>
            <label>类目<input value={manualProduct.category} onChange={(event) => setManualField("category", event.target.value)} /></label>
            <label>默认 SKU 名称<input value={manualProduct.skuName ?? ""} onChange={(event) => setManualField("skuName", event.target.value)} /></label>
            <label>成本价 CNY<input type="number" step="0.01" value={manualProduct.supplierPriceCny} onChange={(event) => setManualField("supplierPriceCny", event.target.value)} /></label>
            <label>国内运费 CNY<input type="number" step="0.01" value={manualProduct.estimatedDomesticShippingCny} onChange={(event) => setManualField("estimatedDomesticShippingCny", event.target.value)} /></label>
            <label>重量 kg<input type="number" step="0.01" value={manualProduct.estimatedWeightKg} onChange={(event) => setManualField("estimatedWeightKg", event.target.value)} /></label>
            <label>库存<input type="number" step="1" value={manualProduct.stock} onChange={(event) => setManualField("stock", event.target.value)} /></label>
            <label>来源链接<input value={manualProduct.sourceUrl ?? ""} onChange={(event) => setManualField("sourceUrl", event.target.value)} /></label>
            <label>商品属性<textarea className="compact-textarea" placeholder="颜色:灰色;材质:尼龙" value={manualAttributesText} onChange={(event) => setManualAttributesText(event.target.value)} /></label>
            <label>图片链接<textarea className="compact-textarea" placeholder="多个链接用换行、逗号或分号分隔" value={manualImagesText} onChange={(event) => setManualImagesText(event.target.value)} /></label>
            <label>SKU 列表<textarea className="compact-textarea" placeholder="SKU名,成本价,库存,属性。例如：灰色 M,12.9,100,颜色:灰色;尺码:M" value={manualSkusText} onChange={(event) => setManualSkusText(event.target.value)} /></label>
          </div>
          <button className="primary-button import-button" onClick={() => void manualCreator.mutateAsync(buildManualProductPayload())} disabled={manualCreator.isPending || !manualProduct.title || !manualProduct.category}>
            {manualCreator.isPending ? "创建中..." : "创建手动任务"}
          </button>
        </div>
        <div className="queue-panel">
          <div className="queue-head">
            <strong>CSV / Excel 导入</strong>
            <p>一行一个 SKU，同名商品会合并为一个任务。</p>
          </div>
          <a className="template-link" href={csvTemplateUrl}>下载 CSV 模板</a>
          <textarea className="csv-import-box" value={csvText} onChange={(event) => setCsvText(event.target.value)} />
          <button className="primary-button import-button" onClick={() => void csvImporter.mutateAsync(csvText)} disabled={csvImporter.isPending}>
            {csvImporter.isPending ? "导入中..." : "导入 CSV 商品"}
          </button>
          {csvImporter.data ? <ImportResult result={csvImporter.data} prefix="CSV" /> : null}
          <div className="excel-import-row">
            <input type="file" accept=".xlsx" onChange={(event) => setSelectedExcelFile(event.target.files?.[0] ?? null)} />
            <button className="ghost-button import-button" onClick={() => selectedExcelFile && void excelImporter.mutateAsync(selectedExcelFile)} disabled={!selectedExcelFile || excelImporter.isPending}>
              {excelImporter.isPending ? "上传中..." : "导入 Excel"}
            </button>
          </div>
          {excelImporter.data ? <ImportResult result={excelImporter.data} prefix="Excel" /> : null}
        </div>
            </div>
          ) : advancedTab === "config" ? (
            <div className="advanced-grid">
        {dianxiaomiRequirementRulesDraft ? (
          <div className="queue-panel">
            <div className="queue-head">
              <strong>店小秘上品规则</strong>
              <p>保存后会重新计算队列中的所有店小秘商品。</p>
            </div>
            <div className="pricing-form dianxiaomi-rules-form">
              <label>预设名称<input value={dianxiaomiRequirementRulesDraft.presetName} onChange={(event) => setDianxiaomiRequirementPresetName(event.target.value)} /></label>
              <label className="rule-toggle">Title required<input type="checkbox" checked={dianxiaomiRequirementRulesDraft.title.required} onChange={(event) => setDianxiaomiRequirementRequired("title", event.target.checked)} /></label>
              <label>Title min length<input type="number" step="1" value={dianxiaomiRequirementRulesDraft.title.minLength} onChange={(event) => setDianxiaomiRequirementNumber("title", "minLength", event.target.value)} /></label>
              <label>Title max length<input type="number" step="1" value={dianxiaomiRequirementRulesDraft.title.maxLength} onChange={(event) => setDianxiaomiRequirementNumber("title", "maxLength", event.target.value)} /></label>
              <label className="rule-toggle">Images required<input type="checkbox" checked={dianxiaomiRequirementRulesDraft.images.required} onChange={(event) => setDianxiaomiRequirementRequired("images", event.target.checked)} /></label>
              <label>Minimum images<input type="number" step="1" value={dianxiaomiRequirementRulesDraft.images.minCount} onChange={(event) => setDianxiaomiRequirementNumber("images", "minCount", event.target.value)} /></label>
              <label className="rule-toggle">Media rules required<input type="checkbox" checked={dianxiaomiRequirementRulesDraft.media.required} onChange={(event) => setDianxiaomiRequirementRequired("media", event.target.checked)} /></label>
              <label className="rule-toggle">Use image translation<input type="checkbox" checked={dianxiaomiRequirementRulesDraft.media.requireImageTranslation} onChange={(event) => setDianxiaomiMediaBoolean("requireImageTranslation", event.target.checked)} /></label>
              <label>Image translation language<input value={dianxiaomiRequirementRulesDraft.media.targetLanguage} onChange={(event) => setDianxiaomiMediaText("targetLanguage", event.target.value)} /></label>
              <label className="rule-toggle">Normalize image size<input type="checkbox" checked={dianxiaomiRequirementRulesDraft.media.requireSizeNormalization} onChange={(event) => setDianxiaomiMediaBoolean("requireSizeNormalization", event.target.checked)} /></label>
              <label>Minimum image width<input type="number" step="1" value={dianxiaomiRequirementRulesDraft.media.minWidthPx} onChange={(event) => setDianxiaomiRequirementNumber("media", "minWidthPx", event.target.value)} /></label>
              <label>Minimum image height<input type="number" step="1" value={dianxiaomiRequirementRulesDraft.media.minHeightPx} onChange={(event) => setDianxiaomiRequirementNumber("media", "minHeightPx", event.target.value)} /></label>
              <label>Maximum image width<input type="number" step="1" value={dianxiaomiRequirementRulesDraft.media.maxWidthPx} onChange={(event) => setDianxiaomiRequirementNumber("media", "maxWidthPx", event.target.value)} /></label>
              <label>Maximum image height<input type="number" step="1" value={dianxiaomiRequirementRulesDraft.media.maxHeightPx} onChange={(event) => setDianxiaomiRequirementNumber("media", "maxHeightPx", event.target.value)} /></label>
              <label>Maximum image size MB<input type="number" step="0.1" value={dianxiaomiRequirementRulesDraft.media.maxSizeMb} onChange={(event) => setDianxiaomiRequirementNumber("media", "maxSizeMb", event.target.value)} /></label>
              <label className="rule-toggle">Require white background<input type="checkbox" checked={dianxiaomiRequirementRulesDraft.media.requireWhiteBackground} onChange={(event) => setDianxiaomiMediaBoolean("requireWhiteBackground", event.target.checked)} /></label>
              <label className="rule-toggle">Image editor review<input type="checkbox" checked={dianxiaomiRequirementRulesDraft.media.requireImageEditorReview} onChange={(event) => setDianxiaomiMediaBoolean("requireImageEditorReview", event.target.checked)} /></label>
              <label>Dianxiaomi media tools<textarea className="compact-textarea" value={dianxiaomiMediaToolsText} onChange={(event) => setDianxiaomiMediaToolsText(event.target.value)} /></label>
              <label className="rule-toggle">SKU required<input type="checkbox" checked={dianxiaomiRequirementRulesDraft.sku.required} onChange={(event) => setDianxiaomiRequirementRequired("sku", event.target.checked)} /></label>
              <label>Minimum SKU rows<input type="number" step="1" value={dianxiaomiRequirementRulesDraft.sku.minCount} onChange={(event) => setDianxiaomiRequirementNumber("sku", "minCount", event.target.value)} /></label>
              <label className="rule-toggle">Price required<input type="checkbox" checked={dianxiaomiRequirementRulesDraft.price.required} onChange={(event) => setDianxiaomiRequirementRequired("price", event.target.checked)} /></label>
              <label>Minimum price fields<input type="number" step="1" value={dianxiaomiRequirementRulesDraft.price.minEditableFieldCount} onChange={(event) => setDianxiaomiRequirementNumber("price", "minEditableFieldCount", event.target.value)} /></label>
              <label className="rule-toggle">Stock required<input type="checkbox" checked={dianxiaomiRequirementRulesDraft.stock.required} onChange={(event) => setDianxiaomiRequirementRequired("stock", event.target.checked)} /></label>
              <label>Minimum stock fields<input type="number" step="1" value={dianxiaomiRequirementRulesDraft.stock.minEditableFieldCount} onChange={(event) => setDianxiaomiRequirementNumber("stock", "minEditableFieldCount", event.target.value)} /></label>
              <label className="rule-toggle">Attributes required<input type="checkbox" checked={dianxiaomiRequirementRulesDraft.attributes.required} onChange={(event) => setDianxiaomiRequirementRequired("attributes", event.target.checked)} /></label>
              <label>Minimum attributes<input type="number" step="1" value={dianxiaomiRequirementRulesDraft.attributes.minCount} onChange={(event) => setDianxiaomiRequirementNumber("attributes", "minCount", event.target.value)} /></label>
              <label>Recommended attribute keys<textarea className="compact-textarea" value={dianxiaomiRecommendedKeysText} onChange={(event) => setDianxiaomiRecommendedKeysText(event.target.value)} /></label>
              <label className="rule-toggle">Compliance required<input type="checkbox" checked={dianxiaomiRequirementRulesDraft.compliance.required} onChange={(event) => setDianxiaomiRequirementRequired("compliance", event.target.checked)} /></label>
              <label>Blocked compliance terms<textarea className="compact-textarea" value={dianxiaomiBlockedTermsText} onChange={(event) => setDianxiaomiBlockedTermsText(event.target.value)} /></label>
            </div>
            <button className="primary-button import-button" onClick={() => {
              const input = buildDianxiaomiRequirementRulesPayload()
              if (input) void dianxiaomiRequirementRulesUpdater.mutateAsync(input)
            }} disabled={dianxiaomiRequirementRulesUpdater.isPending || !dianxiaomiRequirementRulesDraft.presetName.trim()}>
              {dianxiaomiRequirementRulesUpdater.isPending ? "保存中..." : "保存上品规则"}
            </button>
          </div>
        ) : null}
        {pricingDraft ? (
          <div className="queue-panel">
            <div className="queue-head">
              <strong>核价规则</strong>
              <p>保存后会重新计算待执行任务的价格。</p>
            </div>
            <div className="pricing-form">
              <label>汇率 CNY/USD<input type="number" step="0.01" value={pricingDraft.exchangeRateCnyPerUsd} onChange={(event) => setPricingField("exchangeRateCnyPerUsd", event.target.value)} /></label>
              <label>物流 USD/kg<input type="number" step="0.01" value={pricingDraft.logisticsUsdPerKg} onChange={(event) => setPricingField("logisticsUsdPerKg", event.target.value)} /></label>
              <label>平台费 USD<input type="number" step="0.01" value={pricingDraft.platformFeeUsd} onChange={(event) => setPricingField("platformFeeUsd", event.target.value)} /></label>
              <label>目标毛利率<input type="number" step="0.01" value={pricingDraft.targetMarginRate} onChange={(event) => setPricingField("targetMarginRate", event.target.value)} /></label>
              <label>售价倍数<input type="number" step="0.01" value={pricingDraft.priceMultiplier} onChange={(event) => setPricingField("priceMultiplier", event.target.value)} /></label>
              <label>最低毛利率<input type="number" step="0.01" value={pricingDraft.minimumMarginRate} onChange={(event) => setPricingField("minimumMarginRate", event.target.value)} /></label>
              <label>最低建议售价 USD<input type="number" step="0.01" value={pricingDraft.minimumSuggestedPriceUsd} onChange={(event) => setPricingField("minimumSuggestedPriceUsd", event.target.value)} /></label>
              <label>物流分段<textarea className="compact-textarea" placeholder="最小重量,最大重量,基础费,每kg费用。例如：0,0.25,0.35,3.6" value={logisticsTiersText} onChange={(event) => setLogisticsTiersText(event.target.value)} /></label>
            </div>
            <button className="primary-button import-button" onClick={() => {
              const input = buildPricingPayload()
              if (input) void pricingUpdater.mutateAsync(input)
            }} disabled={pricingUpdater.isPending}>
              {pricingUpdater.isPending ? "保存中..." : "保存核价规则"}
            </button>
          </div>
        ) : null}
            </div>
          ) : (
            <div className="advanced-grid">
        <section className="panel advanced-recovery-panel">
          <div className="panel-head split-head">
            <div>
              <h3>故障恢复批跑</h3>
              <p className="subtle">这里只处理 auto-ready 且浏览器可执行的 blocked 商品，repair 工具仅用于故障恢复。</p>
            </div>
            <button
              className="primary-button small-button"
              onClick={() => void automationRecoveryRunner.mutateAsync(defaultRecoveryRunInput)}
              disabled={automationRecoveryRunner.isPending || displayedBrowserRecoveryCandidateCount === 0}
            >
                {automationRecoveryRunner.isPending ? "starting recovery..." : "Run recovery (" + String(displayedBrowserRecoveryCandidateCount) + ")"}
            </button>
          </div>
          <div className="daily-status-strip advanced-recovery-stats">
            <DailyMetric label="released retry" value={String(releasedBrowserRecoveryCandidateCount)} detail="one item per daemon tick" tone={releasedBrowserRecoveryCandidateCount > 0 ? "warn" : "neutral"} />
            <DailyMetric label="浏览器恢复" value={String(displayedBrowserRecoveryCandidateCount)} detail="repair-preview / repair-apply / full-flow" tone={displayedBrowserRecoveryCandidateCount > 0 ? "good" : "neutral"} />
            <DailyMetric label="暂停恢复" value={String(pausedBrowserRecoveryCandidateCount)} detail="重复失败预算保护" tone={pausedBrowserRecoveryCandidateCount > 0 ? "warn" : "neutral"} />
            <DailyMetric label="直接安全重试" value={String(directSafeRetryCandidateCount)} detail="无需字段或图片修复" tone={directSafeRetryCandidateCount > 0 ? "warn" : "neutral"} />
            <DailyMetric label="失败队列" value={String(scopeBlockedCount)} detail="不计入日常主路径 KPI" tone={scopeBlockedCount > 0 ? "warn" : "neutral"} />
            <DailyMetric label="恢复批次" value={String(automationRecoveryRunsInScope.length)} detail={automationRecoveryRunsInScope[0] ? automationRecoveryRunsInScope[0].status : "暂无恢复运行"} tone={automationRecoveryRunsInScope[0]?.status === "failed" ? "bad" : automationRecoveryRunsInScope[0]?.status === "completed" ? "good" : "neutral"} />
          </div>
          {automationRecoveryRunMessage ? (
            <div className="import-result">
              <p>{automationRecoveryRunMessage}</p>
            </div>
          ) : null}
          {automationRecoveryRunsInScope.length > 0 ? (
            <div className="report-list">
              {automationRecoveryRunsInScope.slice(0, 3).map((run) => <RecoveryRunCard key={run.id} run={run} />)}
            </div>
          ) : (
            <div className="empty-report">暂无恢复批跑记录。</div>
          )}
        </section>
            <section className="panel">
              <div className="panel-head split-head">
                <h3>店小秘选择器诊断</h3>
                <div className="review-actions">
                  <button
                    className="ghost-button small-button"
                    onClick={() => void dianxiaomiAccountScanner.mutateAsync({
                      headed: false,
                      sourceBuckets: ["collection-box", "pending-publish"],
                      maxPages: 20
                    })}
                    disabled={dianxiaomiAccountScanner.isPending}
                  >
                    {dianxiaomiAccountScanner.isPending ? "scanning..." : "扫描店铺与链接"}
                  </button>
                  <button
                    className="ghost-button small-button"
                    onClick={() => void selectorCalibrationRunner.mutateAsync({ headed: true })}
                    disabled={selectorCalibrationRunner.isPending}
                  >
                    {selectorCalibrationRunner.isPending ? "starting calibration..." : "启动页面校准"}
                  </button>
                  <button
                    className="ghost-button small-button"
                    onClick={() => void selectorConfigGenerator.mutateAsync()}
                    disabled={selectorConfigGenerator.isPending || selectorDiagnoses.length === 0}
                  >
                    生成选择器配置
                  </button>
                </div>
              </div>
              {selectorCalibrationMessage ? (
                <div className="import-result">
                  <p>{selectorCalibrationMessage}</p>
                </div>
              ) : null}
              {accountScanMessage ? (
                <div className="import-result">
                  <p>{accountScanMessage}</p>
                </div>
              ) : null}
              {selectorConfigMessage ? (
                <div className="import-result">
                  <p>{selectorConfigMessage}</p>
                </div>
              ) : null}
              {selectorConfig ? (
                <div className="import-result">
                  <p>{selectorConfig.exists ? "当前选择器配置已启用" : "当前没有选择器配置"}</p>
                  <div className="import-warnings">
                    <span>{selectorConfig.configPath}</span>
                    <span>字段 selector：{selectorConfig.summary.fieldSelectorCount}</span>
                    <span>按钮 selector：{selectorConfig.summary.buttonSelectorCount}</span>
                    <span>图片工具 selector：{selectorConfig.summary.mediaToolSelectorCount ?? 0}</span>
                    <span>SKU 行 selector：{selectorConfig.summary.skuRowSelectorCount}</span>
                  </div>
                </div>
              ) : null}
              {selectorWorkbench ? (
                <SelectorWorkbenchCard
                  workbench={selectorWorkbench}
                  draft={selectorConfigDraft}
                  setDraft={setSelectorConfigDraft}
                  versions={selectorConfigVersions}
                  onSave={(config, confirmDangerousChanges) => void selectorConfigSaver.mutateAsync({
                    config,
                    note: "dashboard manual selector config save",
                    confirmDangerousChanges
                  })}
                  onRestore={(id, confirmDangerousChanges) => void selectorConfigRestorer.mutateAsync({
                    id,
                    input: {
                      confirmDangerousChanges
                    }
                  })}
                  isSaving={selectorConfigSaver.isPending}
                  isRestoring={selectorConfigRestorer.isPending}
                />
              ) : null}
              {selectorCalibrationJobs.length > 0 ? (
                <div className="report-list">
                  {selectorCalibrationJobs.slice(0, 3).map((job) => <SelectorCalibrationJobCard key={job.id} job={job} />)}
                </div>
              ) : null}
              {dianxiaomiAccountScanJobs.length > 0 ? (
                <div className="report-list">
                  {dianxiaomiAccountScanJobs.slice(0, 3).map((job) => <DianxiaomiAccountScanJobCard key={job.id} job={job} />)}
                </div>
              ) : null}
              {dianxiaomiImageCheckJobs.length > 0 ? (
                <div className="report-list">
                  {dianxiaomiImageCheckJobs.slice(0, 3).map((job) => <DianxiaomiImageCheckJobCard key={job.id} job={job} />)}
                </div>
              ) : null}
              {latestCompletedAccountScanJob?.result ? (
                <>
                  <DianxiaomiAccountScanPool
                    job={latestCompletedAccountScanJob}
                    selectedLinkIds={selectedAccountScanLinkIds}
                    selectedStoreFilter={accountScanStoreFilter}
                    selectedBucketFilter={accountScanBucketFilter}
                    existingEditUrlSet={existingWorkItemEditUrlSet}
                    onToggleLink={toggleAccountScanLinkSelection}
                    onToggleVisible={toggleVisibleAccountScanLinks}
                    onStoreFilterChange={setAccountScanStoreFilter}
                    onBucketFilterChange={setAccountScanBucketFilter}
                  />
                  <div className="review-actions">
                    <button
                      className="primary-button small-button"
                      onClick={() => {
                        const storeScopeKey = accountScanStoreFilter === "all" ? undefined : accountScanStoreFilter
                        void dianxiaomiAccountScanImporter.mutateAsync({
                          jobId: latestCompletedAccountScanJob.id,
                          linkIds: selectedAccountScanLinkIds,
                          storeScopeKey
                        })
                      }}
                      disabled={dianxiaomiAccountScanImporter.isPending || selectedAccountScanLinkIds.length === 0}
                    >
                        {dianxiaomiAccountScanImporter.isPending ? "importing..." : "导入已选 " + String(selectedAccountScanLinkIds.length) + " 个到队列"}
                    </button>
                    <button
                      className="ghost-button small-button"
                      onClick={() => {
                        const selectedLinks = latestCompletedAccountScanJob.result?.stores
                          .flatMap((store) => store.links)
                          .filter((link) => selectedAccountScanLinkIds.includes(link.id)) ?? []
                        setSelectedQueueProductScopeMode("item-urls")
                        setSelectedItemUrlsText(selectedLinks.map((link) => link.editUrl).join("\n"))
                      }}
                      disabled={selectedAccountScanLinkIds.length === 0}
                    >
                      用已选链接作为运行范围
                    </button>
                  </div>
                </>
              ) : null}
              <div className="report-list">
                {selectorConfigValidation ? (
                  <div className={"automation-report " + (selectorConfigValidation.valid ? "completed" : "failed")}>
                    <div className="report-main">
                      <strong>{selectorConfigValidation.valid ? "selector config validation passed" : "selector config needs attention"}</strong>
                      <span>{new Date(selectorConfigValidation.checkedAt).toLocaleString()}</span>
                      <span>{selectorConfigValidation.issues.length} issues</span>
                    </div>
                    <div className="report-detail">
                      {selectorConfigValidation.latestDiagnosisCreatedAt ? (
                        <span>diagnosis {new Date(selectorConfigValidation.latestDiagnosisCreatedAt).toLocaleString()}</span>
                      ) : null}
                      {selectorConfigValidation.issues.length > 0
                        ? selectorConfigValidation.issues.map((issue) => <span key={issue.id}>{issue.level}: {issue.message}</span>)
                        : <span>no validation issues</span>}
                    </div>
                  </div>
                ) : null}
                {selectorDiagnoses.length > 0 ? selectorDiagnoses.slice(0, 5).map((diagnosis) => {
                  const missingFields = Object.entries(diagnosis.fields)
                    .filter(([, result]) => !result.ok)
                    .map(([kind]) => kind)
                  const missingButtons = Object.entries(diagnosis.buttons)
                    .filter(([, result]) => !result.ok)
                    .map(([kind]) => kind)
                  return (
                    <div key={String(diagnosis.createdAt) + "-" + diagnosis.pageUrl} className={"automation-report " + (diagnosis.requiredOk ? "completed" : "failed")}>
                      <div className="report-main">
                        <strong>{diagnosis.requiredOk ? "关键字段可识别" : "需要校准选择器"}</strong>
                        <span>{new Date(diagnosis.createdAt).toLocaleString()}</span>
              <span>fields {diagnosis.summary.fieldCount} / buttons {diagnosis.summary.buttonCount} / media tools {diagnosis.summary.mediaToolCount ?? 0} / sku rows {diagnosis.summary.skuRowCount}</span>
                      </div>
                      <div className="report-detail">
                        <span>{diagnosis.pageTitle || diagnosis.pageUrl}</span>
                        {missingFields.length > 0 ? <span>缺字段：{missingFields.join(", ")}</span> : <span>字段识别正常</span>}
                        {missingButtons.length > 0 ? <span>缺按钮：{missingButtons.join(", ")}</span> : <span>按钮识别正常</span>}
                      </div>
                    </div>
                  )
                }) : <div className="empty-report">暂无选择器诊断报告</div>}
              </div>
            </section>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  )
}
