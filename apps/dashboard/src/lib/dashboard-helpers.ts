// Pure helpers, constants, and types extracted from App.tsx.
// No React / JSX dependencies — safe to import anywhere.

import {
  automationSourceBucketOptions,
  matchesAutomationItemScope,
  normalizeAutomationItemUrls,
  normalizeAutomationSourceBuckets
} from "@temu-ai-ops/shared"
import type {
  AutomationDryRunStartInput,
  AutomationFullFlowJob,
  AutomationQueueRunStartResult,
  AutomationTaskFileExportResult,
  AutomationSourceBucket,
  DianxiaomiListingRequirementRules,
  DianxiaomiProductWorkItem,
  ManualProductInput,
  PricingRules,
  PublishTask
} from "@temu-ai-ops/shared"

export const formatMoney = (value: number) => `$${value.toFixed(2)}`
export const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {}
export const taskFileLaunchClass = (item: AutomationTaskFileExportResult) =>
  item.launchStatus.status === "ready" ? "ready" : item.launchStatus.status === "needs-target-url" ? "warning" : "blocked"

export const statusLabel: Record<PublishTask["status"], string> = {
  queued: "待处理",
  planned: "已准备",
  executing: "执行中",
  reviewing: "待审核",
  approved: "已通过",
  rejected: "已驳回",
  completed: "已完成",
  failed: "异常"
}

export const reviewStatusLabel = {
  pending: "待审核",
  approved: "审核通过",
  rejected: "已驳回",
  changes_requested: "退回修改"
}

export const reviewDecisionLabel = {
  approve: "审核通过",
  reject: "驳回",
  request_changes: "退回修改"
}

export const csvExample = `title,category,supplierPriceCny,estimatedDomesticShippingCny,estimatedWeightKg,skuName,stock,attributes,sourceUrl
便携收纳包,旅行收纳,12.9,1.6,0.22,灰色 M,100,颜色:灰色;尺码:M,https://detail.1688.com/example
便携收纳包,旅行收纳,13.6,1.6,0.24,灰色 L,80,颜色:灰色;尺码:L,https://detail.1688.com/example`

export const defaultManualProduct: ManualProductInput = {
  title: "",
  category: "",
  supplierPriceCny: 0,
  estimatedDomesticShippingCny: 0,
  estimatedWeightKg: 0.2,
  stock: 0,
  skuName: "",
  sourceUrl: "",
  attributes: {},
  images: []
}

export const defaultDailyMediaAutomationTools = ["image-translation", "batch-resize"]
export const defaultQueueProductScopeBuckets: AutomationSourceBucket[] = ["pending-publish"]
export const queueProductScopeModes = ["ready-queue", "item-urls", "source-buckets"] as const
export type QueueProductScopeMode = typeof queueProductScopeModes[number]

export const defaultAutomationLaunchDraft = {
  url: "",
  taskFile: "",
  selectorConfig: "",
  profile: ".runtime/dianxiaomi-real-profile",
  screenshots: "",
  mediaAutomationMode: "unattended-apply",
  mediaAutomationTools: defaultDailyMediaAutomationTools.join("\n"),
  submitAfterSave: true,
  submitMaxAttempts: "3",
  headed: true
}

export type AutomationLaunchDraft = typeof defaultAutomationLaunchDraft

export type ProductEditDraft = {
  title: string
  category: string
  supplierPriceCny: number
  estimatedDomesticShippingCny: number
  estimatedWeightKg: number
  stock: number
  sourceUrl: string
  attributesText: string
  imagesText: string
  skusText: string
}

export type ListingEditDraft = {
  listingTitle: string
  sellingPointsText: string
  description: string
  categoryPathText: string
  attributesText: string
  skuPricingText: string
}

export const getTaskProgress = (task: PublishTask) => {
  const total = task.steps.length
  const completed = task.steps.filter((step) => step.status === "done").length
  return Math.max(20, Math.round((completed / Math.max(total, 1)) * 100))
}

export const parseAttributeText = (value: string) =>
  value.split(/[;；\r\n]/).reduce<Record<string, string>>((attributes, pair) => {
    const [key, ...rest] = pair.split(/[:：]/)
    const normalizedKey = key?.trim()
    const normalizedValue = rest.join(":").trim()
    if (normalizedKey && normalizedValue) {
      attributes[normalizedKey] = normalizedValue
    }
    return attributes
  }, {})

export const formatAttributeText = (attributes: Record<string, string>) =>
  Object.entries(attributes).map(([key, value]) => `${key}:${value}`).join(";")

export const parseImagesText = (value: string) =>
  value.split(/[;；,\r\n]/).map((item) => item.trim()).filter(Boolean)

export const parseLines = (value: string) =>
  value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)

export const formatLines = (items: string[] | undefined) =>
  (items ?? []).join("\n")

export const parseSkusText = (value: string, fallback: { costCny: number; stock: number; attributes: Record<string, string> }) =>
  parseLines(value).map((line) => {
    const [skuName, costCny, stock, attributesText] = line.split(",")
    return {
      skuName: skuName?.trim() || "默认规格",
      costCny: Number(costCny || fallback.costCny),
      stock: Math.max(0, Math.floor(Number(stock || fallback.stock))),
      attributes: {
        ...fallback.attributes,
        ...parseAttributeText(attributesText ?? "")
      }
    }
  })

export const formatLogisticsTiersText = (tiers: PricingRules["logisticsRateTiers"]) =>
  (tiers ?? [])
    .map((tier) => `${tier.minWeightKg},${tier.maxWeightKg ?? ""},${tier.baseFeeUsd},${tier.usdPerKg}`)
    .join("\n")

export const parseLogisticsTiersText = (value: string): NonNullable<PricingRules["logisticsRateTiers"]> =>
  parseLines(value)
    .map((line) => {
      const [minWeightKg, maxWeightKg, baseFeeUsd, usdPerKg] = line.split(",").map((item) => item.trim())
      return {
        minWeightKg: Number(minWeightKg || 0),
        maxWeightKg: maxWeightKg ? Number(maxWeightKg) : undefined,
        baseFeeUsd: Number(baseFeeUsd || 0),
        usdPerKg: Number(usdPerKg || 0)
      }
    })
    .filter((tier) => Number.isFinite(tier.minWeightKg) && Number.isFinite(tier.baseFeeUsd) && Number.isFinite(tier.usdPerKg))

export const createDianxiaomiRequirementRulesDraft = (rules: DianxiaomiListingRequirementRules): DianxiaomiListingRequirementRules => ({
  ...rules,
  title: { ...rules.title },
  images: { ...rules.images },
  media: {
    ...rules.media,
    dianxiaomiTools: [...rules.media.dianxiaomiTools]
  },
  sku: { ...rules.sku },
  price: { ...rules.price },
  stock: { ...rules.stock },
  attributes: {
    ...rules.attributes,
    recommendedKeys: [...rules.attributes.recommendedKeys]
  },
  compliance: {
    ...rules.compliance,
    blockedTerms: [...rules.compliance.blockedTerms]
  }
})

export const createProductEditDraft = (task: PublishTask): ProductEditDraft => ({
  title: task.product.title,
  category: task.product.category,
  supplierPriceCny: task.product.supplierPriceCny,
  estimatedDomesticShippingCny: task.product.estimatedDomesticShippingCny,
  estimatedWeightKg: task.product.estimatedWeightKg,
  stock: task.product.skus.reduce((total, sku) => total + sku.stock, 0),
  sourceUrl: task.product.sourceUrl ?? "",
  attributesText: formatAttributeText(task.product.attributes),
  imagesText: task.product.images.join("\n"),
  skusText: task.product.skus
    .map((sku) => `${sku.name},${sku.costCny},${sku.stock},${formatAttributeText(sku.attributes)}`)
    .join("\n")
})

export const createListingEditDraft = (task: PublishTask): ListingEditDraft => ({
  listingTitle: task.draft.listingTitle,
  sellingPointsText: task.draft.sellingPoints.join("\n"),
  description: task.draft.description,
  categoryPathText: task.draft.categoryPath.join("\n"),
  attributesText: formatAttributeText(task.draft.attributes),
  skuPricingText: task.draft.skuPricing
    .map((sku) => `${sku.skuId},${sku.skuName},${sku.salePriceUsd},${sku.stock},${formatAttributeText(sku.attributes)}`)
    .join("\n")
})

export const createAutomationStartInput = (draft: AutomationLaunchDraft): AutomationDryRunStartInput => ({
  url: draft.url.trim() || undefined,
  taskFile: draft.taskFile.trim() || undefined,
  selectorConfig: draft.selectorConfig.trim() || undefined,
  profile: draft.profile.trim() || undefined,
  screenshots: draft.screenshots.trim() || undefined,
  mediaAutomationMode: draft.mediaAutomationMode === "unattended-open" || draft.mediaAutomationMode === "unattended-apply"
    ? draft.mediaAutomationMode
    : "plan-only",
  mediaAutomationTools: parseLines(draft.mediaAutomationTools),
  submitAfterSave: draft.submitAfterSave,
  submitMaxAttempts: Math.max(1, Math.min(10, Number.parseInt(draft.submitMaxAttempts, 10) || 3)),
  headed: draft.headed
})

export const automationDraftFromInput = (input: AutomationDryRunStartInput = {}): AutomationLaunchDraft => ({
  url: input.url ?? "",
  taskFile: input.taskFile ?? "",
  selectorConfig: input.selectorConfig ?? "",
  profile: input.profile ?? "",
  screenshots: input.screenshots ?? "",
  mediaAutomationMode: input.mediaAutomationMode ?? "unattended-apply",
  mediaAutomationTools: (input.mediaAutomationTools ?? []).join("\n"),
  submitAfterSave: input.submitAfterSave ?? defaultAutomationLaunchDraft.submitAfterSave,
  submitMaxAttempts: String(input.submitMaxAttempts ?? 3),
  headed: input.headed ?? true
})

export const buildQueueProductScopeInput = (
  mode: QueueProductScopeMode,
  itemUrlsText: string,
  sourceBuckets: AutomationSourceBucket[]
): Pick<AutomationDryRunStartInput, "itemUrls" | "sourceBuckets"> => {
  if (mode === "item-urls") {
    const itemUrls = normalizeAutomationItemUrls(parseLines(itemUrlsText))
    return itemUrls.length > 0 ? { itemUrls } : {}
  }

  if (mode === "source-buckets") {
    const normalizedSourceBuckets = normalizeAutomationSourceBuckets(sourceBuckets)
    return normalizedSourceBuckets.length > 0 ? { sourceBuckets: normalizedSourceBuckets } : {}
  }

  return {}
}

export const queueProductScopeReady = (
  mode: QueueProductScopeMode,
  itemUrlsText: string,
  sourceBuckets: AutomationSourceBucket[]
) => {
  if (mode === "item-urls") {
    return normalizeAutomationItemUrls(parseLines(itemUrlsText)).length > 0
  }

  if (mode === "source-buckets") {
    return normalizeAutomationSourceBuckets(sourceBuckets).length > 0
  }

  return true
}

export const queueProductScopeSummary = (
  mode: QueueProductScopeMode,
  itemUrlsText: string,
  sourceBuckets: AutomationSourceBucket[]
) => {
  if (mode === "item-urls") {
    const itemUrls = normalizeAutomationItemUrls(parseLines(itemUrlsText))
    return itemUrls.length > 0 ? `指定链接 ${itemUrls.length} 个` : "等待输入商品链接"
  }

  if (mode === "source-buckets") {
    const normalizedSourceBuckets = normalizeAutomationSourceBuckets(sourceBuckets)
    if (normalizedSourceBuckets.length === 0) {
      return "等待选择来源页面"
    }
    const labels = normalizedSourceBuckets.map((bucket) =>
      automationSourceBucketOptions.find((option) => option.value === bucket)?.label ?? bucket
    )
    return labels.join(" / ")
  }

  return "运行店铺 ready 队列"
}

export const matchesSelectedQueueProductScope = (
  item: {
    pageUrl?: string
    pageTitle?: string
    pageProfile?: string
    rawTextSample?: string
    notes?: string[]
  },
  mode: QueueProductScopeMode,
  itemUrlsText: string,
  sourceBuckets: AutomationSourceBucket[]
) => matchesAutomationItemScope(item, buildQueueProductScopeInput(mode, itemUrlsText, sourceBuckets))

export type DailyTrialGate = {
  status: "missing" | "running" | "failed" | "passed"
  message: string
  run: AutomationQueueRunStartResult | null
  details: Array<{
    label: string
    value: string
    tone: "good" | "warn" | "bad" | "neutral"
  }>
  failures: string[]
  recovery: {
    title: string
    message: string
    tone: "good" | "warn" | "bad" | "neutral"
    actions: string[]
  }
}

export type DailyAlert = {
  id: string
  title: string
  message: string
  tone: "good" | "warn" | "bad" | "neutral"
}

export const countBy = (values: string[]) =>
  values.reduce<Partial<Record<string, number>>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1
    return counts
  }, {})

export const formatCategoryCounts = (counts: Partial<Record<string, number>>) =>
  Object.entries(counts)
    .sort((left, right) => (right[1] ?? 0) - (left[1] ?? 0))
    .map(([category, count]) => `${category} ${count}`)
    .join(" / ")

export const isAutomaticMainPathJob = (
  job: AutomationFullFlowJob,
  queueRuns: AutomationQueueRunStartResult[],
  workItems: DianxiaomiProductWorkItem[]
) => {
  if (job.source !== "queue-run" || job.input.repairPlanFile) {
    return false
  }

  const owningQueueRun = queueRuns.find((run) => run.flowJobIds.includes(job.id))
  if (owningQueueRun?.autoRetryReleasedIds.includes(job.workItemId ?? "")) {
    return false
  }

  const workItem = workItems.find((item) => item.id === job.workItemId)
  const releaseBeforeJob = workItem?.manualBudgetReleases?.some((release) =>
    release.releaseEventAt.localeCompare(job.startedAt) <= 0
  ) ?? false
  return !releaseBeforeJob
}

export const getAutomaticPassRate = (
  jobs: AutomationFullFlowJob[],
  queueRuns: AutomationQueueRunStartResult[],
  workItems: DianxiaomiProductWorkItem[]
) => {
  const finishedJobs = jobs.filter((job) =>
    isAutomaticMainPathJob(job, queueRuns, workItems)
    && (job.status === "completed" || job.status === "failed")
  )
  const completedJobs = finishedJobs.filter((job) => job.status === "completed")
  return {
    finished: finishedJobs.length,
    completed: completedJobs.length,
    rate: finishedJobs.length > 0 ? completedJobs.length / finishedJobs.length : null
  }
}

export const getManualTriggerStats = (workItems: DianxiaomiProductWorkItem[]) => {
  const triggerCount = workItems.reduce((total, item) => {
    const automaticRepairPlan = item.repairPlan?.status === "auto-ready" && item.repairPlan.canAutoRepair
    const repairTriggers = automaticRepairPlan
      ? 0
      : item.repairPlan?.actions.filter((action) => action.automation !== "auto").length ?? 0
    const manualBudgetTrigger = item.publishOutcome?.status === "failed" && item.publishOutcome.route === "manual-budget" ? 1 : 0
    const failureTrigger = item.failureDiagnosis && !item.failureDiagnosis.autoRetryRecommended && !automaticRepairPlan ? 1 : 0
    return total + Math.max(repairTriggers, failureTrigger, manualBudgetTrigger)
  }, 0)
  const productCount = workItems.length
  return {
    triggerCount,
    productCount,
    average: productCount > 0 ? triggerCount / productCount : 0
  }
}

const BROWSER_RECOVERY_WRITERS = ["fill-single-field", "fill-attributes", "fill-sku-pricing", "run-media-tool"] as const

export const needsImageCheck = (item: Pick<DianxiaomiProductWorkItem, "snapshot">) =>
  !item.snapshot.imageCheck?.passed || (item.snapshot.imageCheck?.issues?.length ?? 0) > 0

export const canRunFullyAutomaticRepair = (item: Pick<DianxiaomiProductWorkItem, "repairPlan">) => {
  const repairPlan = item.repairPlan
  if (!repairPlan || repairPlan.actions.length === 0) {
    return false
  }

  const automaticActions = repairPlan.actions.filter((action) => action.automation === "auto")
  if (automaticActions.length === 0) {
    return false
  }

  return repairPlan.actions.every((action) =>
    action.automation === "auto"
    || (action.automation === "manual" && action.type === "inspect-logs")
  )
}

export const canRunBrowserRecovery = (item: Pick<DianxiaomiProductWorkItem, "status" | "repairPlan">) => {
  const repairPlan = item.repairPlan
  return item.status === "blocked"
    && repairPlan?.status === "auto-ready"
    && repairPlan.canAutoRepair
    && repairPlan.actions.length > 0
    && repairPlan.actions.some((action) =>
      action.automation === "auto"
      && BROWSER_RECOVERY_WRITERS.includes(action.payload?.writer as typeof BROWSER_RECOVERY_WRITERS[number])
    )
    && repairPlan.actions.every((action) =>
      action.automation === "auto"
      && (
        action.payload?.writer
          ? BROWSER_RECOVERY_WRITERS.includes(action.payload.writer as typeof BROWSER_RECOVERY_WRITERS[number])
          : action.required === false
      )
    )
}

export const getDailyTrialRecovery = (
  status: DailyTrialGate["status"],
  run: AutomationQueueRunStartResult | null,
  flowJobs: AutomationFullFlowJob[],
  workItems: DianxiaomiProductWorkItem[],
  runningCount: number,
  completedCount: number
): DailyTrialGate["recovery"] => {
  if (!run) {
    return {
      title: "下一步：先做生产校准和小批量试跑",
      message: "无人值守入口还没有验收记录。先用真实店小秘商品编辑页校准，再让系统处理 3 个 ready 商品。",
      tone: "warn",
      actions: ["打开真实店小秘商品编辑页", "点击生产校准", "确认有 ready 商品后点击小批量试跑"]
    }
  }

  if (run.queued === 0) {
    return {
      title: "下一步：让店小秘采集商品进入 ready 队列",
      message: "这次试跑没有拿到可处理商品，自动化没有真正开始。先确认店小秘采集来的商品已通过要求检查。",
      tone: "bad",
      actions: ["在店小秘完成商品采集", "同步/保存为 ready-for-automation", "再点小批量试跑"]
    }
  }

  if (status === "running") {
    return {
      title: "下一步：等待试跑完成",
      message: `系统正在验收 ${run.queued} 个商品，当前完成 ${completedCount} 个，还有 ${runningCount} 个未结束。`,
      tone: "warn",
      actions: ["保持店小秘登录状态", "不要手动占用同一个浏览器资料目录", "完成后系统会自动放开或继续拦截无人值守"]
    }
  }

  if (status === "passed") {
    return {
      title: "下一步：可以开始无人值守",
      message: "小批量试跑已通过，说明当前页面校准、图片处理、保存和发布链路可以放量运行。",
      tone: "good",
      actions: ["点击开始无人值守", "后续只处理 Temu 核价确认", "如果失败数增加，再查看系统建议"]
    }
  }

  const relatedWorkItemIds = new Set([
    ...flowJobs.map((job) => job.workItemId).filter((id): id is string => Boolean(id)),
    ...run.skippedItems.map((item) => item.workItemId)
  ])
  const relatedFailures = workItems
    .filter((item) => relatedWorkItemIds.has(item.id))
    .map((item) => item.failureDiagnosis)
    .filter((diagnosis): diagnosis is NonNullable<DianxiaomiProductWorkItem["failureDiagnosis"]> => Boolean(diagnosis))
  const categoryCounts = countBy(relatedFailures.map((diagnosis) => diagnosis.category))
  const autoRetryCount = relatedFailures.filter((diagnosis) => diagnosis.autoRetryRecommended).length
  const firstAction = relatedFailures.find((diagnosis) => !diagnosis.autoRetryRecommended)?.nextAction
    ?? relatedFailures[0]?.nextAction
  const categorySummary = formatCategoryCounts(categoryCounts)
  const hasCategory = (category: string) => (categoryCounts[category] ?? 0) > 0

  if (autoRetryCount > 0 && autoRetryCount === relatedFailures.length && run.skipped === 0) {
    return {
      title: "下一步：可自动重试",
      message: `${autoRetryCount} 个失败项被判断为安全自动重试。重新小批量试跑即可，长期无人值守仍等试跑通过后再启动。`,
      tone: "warn",
      actions: ["点击小批量试跑", "如果仍失败再查看失败商品", "不要直接跳过试跑闸门"]
    }
  }

  if (hasCategory("login-or-captcha")) {
    return {
      title: "下一步：先处理店小秘登录/验证码",
      message: categorySummary || "系统识别到登录或验证码拦截，这类问题不能无人绕过。",
      tone: "bad",
      actions: ["在自动化浏览器资料目录里完成登录/验证码", "保持店小秘编辑页可访问", "重新点小批量试跑"]
    }
  }

  if (hasCategory("real-page-calibration") || hasCategory("selector-config") || hasCategory("target-surface")) {
    return {
      title: "下一步：重新做真实页面校准",
      message: categorySummary || "系统识别到页面、选择器或商品编辑页不匹配，继续放量会扩大失败。",
      tone: "bad",
      actions: ["打开真实店小秘商品编辑页", "点击生产校准并保存选择器", "再点小批量试跑"]
    }
  }

  if (hasCategory("media-processing")) {
    return {
      title: "下一步：处理图片工具失败",
      message: categorySummary || "图片翻译、批量改尺寸、白底或编辑器链路没有稳定通过。",
      tone: "bad",
      actions: ["检查失败商品的图片规格和店小秘图片工具反馈", "必要时重新生产校准图片弹窗按钮", "修正后重新小批量试跑"]
    }
  }

  if (hasCategory("publish-validation")) {
    return {
      title: "下一步：补齐店小秘发布校验项",
      message: categorySummary || "店小秘发布时返回了必填项、属性或提交校验失败。",
      tone: "bad",
      actions: ["按失败商品提示补齐必填属性/SKU/价格/库存", "把商品重新置为 ready", "再点小批量试跑"]
    }
  }

  if (hasCategory("browser-profile")) {
    return {
      title: "下一步：释放自动化浏览器资料目录",
      message: categorySummary || "自动化浏览器资料目录被占用或存在锁文件。",
      tone: "bad",
      actions: ["关闭占用同一资料目录的浏览器", "确认没有残留锁文件", "重新小批量试跑"]
    }
  }

  if (firstAction) {
    return {
      title: "下一步：按失败商品建议处理后重跑",
      message: categorySummary || firstAction,
      tone: "bad",
      actions: [firstAction, "处理后重新点击小批量试跑", "通过后再启动无人值守"]
    }
  }

  return {
    title: "下一步：查看失败原因后重跑",
    message: "系统还没有拿到结构化失败分类。先看下方失败项或高级诊断，再重新小批量试跑。",
    tone: "bad",
    actions: ["打开高级诊断查看最近 full-flow 报告", "修复失败商品", "重新点击小批量试跑"]
  }
}

export const getDailyTrialGate = (
  queueRuns: AutomationQueueRunStartResult[],
  fullFlowJobs: AutomationFullFlowJob[],
  workItems: DianxiaomiProductWorkItem[]
): DailyTrialGate => {
  const run = queueRuns.find((item) => item.limit === 3)
  if (!run) {
    return {
      status: "missing",
      message: "先完成一次小批量试跑，默认处理 3 个 ready 商品，全部通过后再放开长期无人值守。",
      run: null,
      details: [
        { label: "queued", value: "0", tone: "neutral" },
        { label: "completed", value: "0/3", tone: "warn" },
        { label: "running", value: "0", tone: "neutral" },
        { label: "failed", value: "0", tone: "neutral" },
        { label: "skipped", value: "0", tone: "neutral" }
      ],
      failures: [],
      recovery: getDailyTrialRecovery("missing", null, [], workItems, 0, 0)
    }
  }

  const flowJobs = run.flowJobIds
    .map((id) => fullFlowJobs.find((job) => job.id === id))
    .filter((job): job is AutomationFullFlowJob => Boolean(job))
  const missingCount = run.flowJobIds.length - flowJobs.length
  const completedCount = flowJobs.filter((job) => job.status === "completed").length
  const failedCount = flowJobs.filter((job) => job.status === "failed").length
  const runningCount = flowJobs.filter((job) => job.status === "running").length + missingCount
  const details: DailyTrialGate["details"] = [
    { label: "queued", value: String(run.queued), tone: run.queued > 0 ? "good" : "bad" },
    { label: "completed", value: `${completedCount}/${run.flowJobIds.length}`, tone: completedCount === run.flowJobIds.length && run.flowJobIds.length > 0 ? "good" : "warn" },
    { label: "running", value: String(runningCount), tone: runningCount > 0 ? "warn" : "neutral" },
    { label: "failed", value: String(failedCount), tone: failedCount > 0 ? "bad" : "neutral" },
    { label: "skipped", value: String(run.skipped), tone: run.skipped > 0 ? "bad" : "neutral" }
  ]
  const failedFlowSummaries = flowJobs
    .filter((job) => job.status === "failed")
    .slice(0, 3)
    .map((job) => {
      const failedStage = job.stages.find((stage) => stage.status === "failed")
      const reason = failedStage?.error ?? job.error ?? "full-flow failed"
      return `${job.workItemId ?? job.id}: ${failedStage?.name ?? "full-flow"} - ${reason}`
    })
  const skippedSummaries = run.skippedItems
    .slice(0, 3)
    .map((item) => `${item.workItemId}: ${item.reason}`)
  const failures = [...failedFlowSummaries, ...skippedSummaries]

  if (run.queued === 0) {
    return {
      status: "failed",
      message: "最近一次小批量试跑没有启动任何商品。先确认店小秘采集商品已经进入 ready 队列。",
      run,
      details,
      failures,
      recovery: getDailyTrialRecovery("failed", run, flowJobs, workItems, runningCount, completedCount)
    }
  }

  if (run.skipped > 0 || failedCount > 0) {
    return {
      status: "failed",
      message: `最近一次小批量试跑未通过：queued ${run.queued} / skipped ${run.skipped} / failed ${failedCount}。先处理失败原因后重新试跑。`,
      run,
      details,
      failures,
      recovery: getDailyTrialRecovery("failed", run, flowJobs, workItems, runningCount, completedCount)
    }
  }

  if (runningCount > 0 || completedCount < run.flowJobIds.length) {
    return {
      status: "running",
      message: `小批量试跑仍在验收中：completed ${completedCount}/${run.flowJobIds.length}。`,
      run,
      details,
      failures,
      recovery: getDailyTrialRecovery("running", run, flowJobs, workItems, runningCount, completedCount)
    }
  }

  return {
    status: "passed",
    message: `最近一次小批量试跑已通过：${completedCount} 个商品完成并进入核价阶段。`,
    run,
    details,
    failures,
    recovery: getDailyTrialRecovery("passed", run, flowJobs, workItems, runningCount, completedCount)
  }
}
