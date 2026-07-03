import {
  calculatePricing,
  createMockTask,
  defaultPricingRules,
  generateContentRisks,
  generateListingDraft,
  hashPricingRules,
  matchesAutomationItemScope,
  mockProducts,
  sanitizeMarketplaceEnglishText,
  type AutomationDryRunStartInput,
  type AutomationExecutionReport,
  type AutomationManualStepBudgetRelease,
  type AutomationTaskFileLaunchStatus,
  type AutomationTaskFileExportResult,
  type AutomationTaskSnapshotDiffEntry,
  type AutomationTaskSnapshotDiffResult,
  type BatchDraftRestoreResult,
  type CsvImportResult,
  type DianxiaomiCollectedProduct,
  type DianxiaomiCollectedProductImportResult,
  type DianxiaomiListingRequirementCheck,
  type DianxiaomiListingRequirementRules,
  type DianxiaomiPageContext,
  type DianxiaomiStoreMetrics,
  type DianxiaomiPublishOutcome,
  type DianxiaomiProductSuggestedEdit,
  type DianxiaomiProductRepairAction,
  type DianxiaomiProductRepairActionGate,
  type DianxiaomiProductRepairPlan,
  type DianxiaomiRepairPreviewExportResult,
  type DianxiaomiRepairPreviewFile,
  type DianxiaomiWorkFailureDiagnosis,
  type DianxiaomiProductWorkItem,
  type DianxiaomiProductWorkItemInput,
  type DianxiaomiProductWorkItemRetryAfterFixResult,
  type DianxiaomiProductWorkItemTaskResult,
  type DianxiaomiSelectorConfig,
  type DraftUpdateInput,
  type DraftVersion,
  type ListingDraft,
  type ManualProductInput,
  type PageDebugSnapshot,
  type PricingRules,
  type ProductCandidate,
  type ProductUpdateInput,
  type PublishTask,
  type PublishCheckResult,
  type ReviewDecision,
  type ReviewState,
  type SelectorConfigChangeRisk,
  type SelectorConfigGenerationResult,
  type SelectorConfigDiffEntry,
  type SelectorConfigDiffResult,
  type SelectorConfigRestoreInput,
  type SelectorConfigRestoreResult,
  type SelectorConfigSaveInput,
  type SelectorConfigSaveResult,
  type SelectorConfigStatus,
  type SelectorConfigValidationIssue,
  type SelectorConfigValidationResult,
  type SelectorConfigVersion,
  type SelectorConfigVersionDiffResult,
  type SelectorWorkbench,
  type SelectorWorkbenchItem,
  type SelectorDiagnosisReport
} from "@temu-ai-ops/shared"
// llm-content is imported via subpath (not the barrel): it uses Node-only globals
// (process.env / fetch) and must not leak into the browser dashboard's type graph.
import { enhanceListingDraftWithLlm } from "@temu-ai-ops/shared/llm-content"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CSV_IMPORT_TEMPLATE, excelBufferToCsv, parseProductsFromCsv } from "./csv-import"
import { loadPlannerState, savePlannerState } from "./storage"

export { CSV_IMPORT_TEMPLATE }

export class SelectorConfigChangeRiskError extends Error {
  statusCode = 409

  constructor(
    message: string,
    public diff: SelectorConfigDiffResult
  ) {
    super(message)
    this.name = "SelectorConfigChangeRiskError"
  }
}

type DianxiaomiCollectedProductInput =
  Omit<DianxiaomiCollectedProduct, "id" | "collectedAt" | "quality"> &
  Partial<Pick<DianxiaomiCollectedProduct, "id" | "collectedAt" | "quality">>

type WorkItemQualityInput = Pick<DianxiaomiProductWorkItemInput, "title" | "snapshot" | "rawTextSample"> & {
  // P1-3: optional category hint. When provided, the per-category override
  // in `rules.categoryRules` takes precedence over the global listingMetadata
  // defaults. Callers that don't know the category (e.g. preview-only flow)
  // simply omit it.
  category?: string
  categoryHint?: DianxiaomiProductWorkItemInput["categoryHint"]
}

// P0-A: fallback caps for non-Dianxiaomi sources. Dianxiaomi sources already
// get title-length and other rule-driven checks through the requirements
// pipeline, so these only apply when `task.product.source !== "dianxiaomi"`.
export const PUBLISH_CHECK_TITLE_MAX_LENGTH_FALLBACK = 250
export const PUBLISH_CHECK_STOCK_MAX = 99999

export const defaultDianxiaomiRequirementRules: DianxiaomiListingRequirementRules = {
  presetName: "temu-basic-listing-readiness",
  title: {
    required: true,
    minLength: 20,
    maxLength: 160
  },
  images: {
    required: true,
    minCount: 1
  },
  media: {
    required: false,
    requireImageTranslation: true,
    requireWhiteBackground: false,
    requireSizeNormalization: true,
    requireImageEditorReview: true,
    targetLanguage: "English",
    minWidthPx: 800,
    minHeightPx: 800,
    maxWidthPx: 3000,
    maxHeightPx: 3000,
    maxSizeMb: 5,
    dianxiaomiTools: ["image translation", "white background", "Xiaomi image editor", "batch resize"],
    // P1-12: Temu carousel/description images accept 0.5–2 width/height.
    minAspectRatio: 0.5,
    maxAspectRatio: 2,
    // P1-11: require an English-only / watermark-free confirmation. Soft by
    // default (recommended when unconfirmed) so it doesn't block the
    // unattended path until a real image-check signal exists.
    requireEnglishOnlyImages: true
  },
  sku: {
    required: true,
    minCount: 1
  },
  price: {
    required: true,
    minEditableFieldCount: 1
  },
  stock: {
    required: false,
    minEditableFieldCount: 1
  },
  attributes: {
    required: false,
    minCount: 1,
    recommendedKeys: ["color", "size", "material"]
  },
  compliance: {
    required: true,
    blockedTerms: ["brand", "logo", "patent", "copyright", "trademark"]
  },
  // P1-3: per-category requirement overrides. Categories not in this map
  // fall back to the global `listingMetadata` defaults. Names are lowercased
  // before lookup so case-sensitive operator input still matches.
  categoryRules: {
    clothing: { requireSizeChart: true, requiredAttributes: ["color", "size", "material"] },
    shoes: { requireSizeChart: true, requiredAttributes: ["color", "size"] },
    electronics: { requireManualDocument: true, requiredAttributes: ["material", "power"] },
    "home & garden": { requiredAttributes: ["color", "material"] },
    toys: { requiredAttributes: ["color", "material"] },
    sports: { requiredAttributes: ["color", "size"] }
  }
}

// P1-10: store-mode presets. The default above is semi-managed-friendly.
// These two derive from it and only override the fields that actually
// differ per store mode. `selectDianxiaomiRequirementPreset` picks one by
// hint so the queue can score local / full-managed items correctly.
export const temuLocalDianxiaomiRequirementRules: DianxiaomiListingRequirementRules = {
  ...defaultDianxiaomiRequirementRules,
  presetName: "temu-local-listing-readiness",
  title: {
    ...defaultDianxiaomiRequirementRules.title,
    // Temu local allows a 500-char title vs the 250 semi-managed cap.
    maxLength: 500
  }
}

export const temuFullManagedDianxiaomiRequirementRules: DianxiaomiListingRequirementRules = {
  ...defaultDianxiaomiRequirementRules,
  presetName: "temu-full-managed-listing-readiness",
  // Full-managed listings hand fulfillment to Temu, so seller-side stock is
  // not an editable field (the warehouse manages it). Stock stays
  // recommended only.
  stock: {
    ...defaultDianxiaomiRequirementRules.stock,
    required: false
  }
}

// P1-10: choose a requirement preset from page/profile/text hints. Defaults
// to the semi-managed preset; local and full-managed are opt-in by hint.
export const selectDianxiaomiRequirementPreset = (
  hints: { pageUrl?: string; pageProfile?: string; rawTextSample?: string; title?: string } = {}
): DianxiaomiListingRequirementRules => {
  const haystack = [hints.pageUrl, hints.pageProfile, hints.rawTextSample, hints.title]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  if (/temu\s*local|local listing|contribution sku|本地|本对本/.test(haystack)) {
    return temuLocalDianxiaomiRequirementRules
  }
  if (/full[\s-]*managed|全托管|全托|fully managed/.test(haystack)) {
    return temuFullManagedDianxiaomiRequirementRules
  }
  return dianxiaomiRequirementRules
}

type DianxiaomiRequirementRulesInput = Partial<{
  presetName: string
  title: Partial<DianxiaomiListingRequirementRules["title"]>
  images: Partial<DianxiaomiListingRequirementRules["images"]>
  media: Partial<DianxiaomiListingRequirementRules["media"]>
  sku: Partial<DianxiaomiListingRequirementRules["sku"]>
  price: Partial<DianxiaomiListingRequirementRules["price"]>
  stock: Partial<DianxiaomiListingRequirementRules["stock"]>
  attributes: Partial<DianxiaomiListingRequirementRules["attributes"]>
  compliance: Partial<DianxiaomiListingRequirementRules["compliance"]>
  categoryRules: Record<string, NonNullable<DianxiaomiListingRequirementRules["categoryRules"]>[string]>
}>

// P1-3: per-category override lookup. Categories not in the map fall back to
// an empty object (i.e. use the global listingMetadata defaults). Category
// names are lowercased so operator input like "Clothing" still matches the
// default "clothing" entry.
export const getDianxiaomiCategoryRule = (
  rules: DianxiaomiListingRequirementRules,
  category: string | undefined | null
): NonNullable<DianxiaomiListingRequirementRules["categoryRules"]>[string] => {
  if (!category) {
    return {} as any
  }
  const key = category.trim().toLowerCase()
  if (!key) {
    return {} as any
  }
  const overrides = rules.categoryRules ?? {}
  return (overrides[key] ?? {}) as any
}

const normalizeBoolean = (value: unknown, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback

const normalizeInteger = (value: unknown, fallback: number, minimum = 0) => {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? Math.max(minimum, Math.floor(numberValue)) : fallback
}

const normalizeStringList = (value: unknown, fallback: string[] = []) =>
  Array.from(new Set((Array.isArray(value) ? value : fallback)
    .map((item) => String(item).trim())
    .filter(Boolean)))

const normalizeDianxiaomiRequirementRules = (
  inputRules: DianxiaomiRequirementRulesInput | undefined
): DianxiaomiListingRequirementRules => {
  const input = inputRules ?? {}
  const titleMinLength = normalizeInteger(input.title?.minLength, defaultDianxiaomiRequirementRules.title.minLength)
  const titleMaxLength = Math.max(
    titleMinLength,
    normalizeInteger(input.title?.maxLength, defaultDianxiaomiRequirementRules.title.maxLength, 1)
  )

  return {
    presetName: input.presetName?.trim() || defaultDianxiaomiRequirementRules.presetName,
    title: {
      required: normalizeBoolean(input.title?.required, defaultDianxiaomiRequirementRules.title.required),
      minLength: titleMinLength,
      maxLength: titleMaxLength
    },
    images: {
      required: normalizeBoolean(input.images?.required, defaultDianxiaomiRequirementRules.images.required),
      minCount: normalizeInteger(input.images?.minCount, defaultDianxiaomiRequirementRules.images.minCount)
    },
    media: {
      required: normalizeBoolean(input.media?.required, defaultDianxiaomiRequirementRules.media.required),
      requireImageTranslation: normalizeBoolean(input.media?.requireImageTranslation, defaultDianxiaomiRequirementRules.media.requireImageTranslation),
      requireWhiteBackground: normalizeBoolean(input.media?.requireWhiteBackground, defaultDianxiaomiRequirementRules.media.requireWhiteBackground),
      requireSizeNormalization: normalizeBoolean(input.media?.requireSizeNormalization, defaultDianxiaomiRequirementRules.media.requireSizeNormalization),
      requireImageEditorReview: normalizeBoolean(input.media?.requireImageEditorReview, defaultDianxiaomiRequirementRules.media.requireImageEditorReview),
      targetLanguage: input.media?.targetLanguage?.trim() || defaultDianxiaomiRequirementRules.media.targetLanguage,
      minWidthPx: normalizeInteger(input.media?.minWidthPx, defaultDianxiaomiRequirementRules.media.minWidthPx),
      minHeightPx: normalizeInteger(input.media?.minHeightPx, defaultDianxiaomiRequirementRules.media.minHeightPx),
      maxWidthPx: normalizeInteger(input.media?.maxWidthPx, defaultDianxiaomiRequirementRules.media.maxWidthPx, 1),
      maxHeightPx: normalizeInteger(input.media?.maxHeightPx, defaultDianxiaomiRequirementRules.media.maxHeightPx, 1),
      maxSizeMb: Math.max(0, Number(input.media?.maxSizeMb ?? defaultDianxiaomiRequirementRules.media.maxSizeMb)),
      dianxiaomiTools: normalizeStringList(input.media?.dianxiaomiTools, defaultDianxiaomiRequirementRules.media.dianxiaomiTools),
      // P1-11 / P1-12: preserve image-check + aspect-ratio rule fields.
      minAspectRatio: Math.max(0, Number(input.media?.minAspectRatio ?? defaultDianxiaomiRequirementRules.media.minAspectRatio)),
      maxAspectRatio: Math.max(0, Number(input.media?.maxAspectRatio ?? defaultDianxiaomiRequirementRules.media.maxAspectRatio)),
      requireEnglishOnlyImages: normalizeBoolean(input.media?.requireEnglishOnlyImages, defaultDianxiaomiRequirementRules.media.requireEnglishOnlyImages ?? false)
    },
    sku: {
      required: normalizeBoolean(input.sku?.required, defaultDianxiaomiRequirementRules.sku.required),
      minCount: normalizeInteger(input.sku?.minCount, defaultDianxiaomiRequirementRules.sku.minCount)
    },
    price: {
      required: normalizeBoolean(input.price?.required, defaultDianxiaomiRequirementRules.price.required),
      minEditableFieldCount: normalizeInteger(input.price?.minEditableFieldCount, defaultDianxiaomiRequirementRules.price.minEditableFieldCount)
    },
    stock: {
      required: normalizeBoolean(input.stock?.required, defaultDianxiaomiRequirementRules.stock.required),
      minEditableFieldCount: normalizeInteger(input.stock?.minEditableFieldCount, defaultDianxiaomiRequirementRules.stock.minEditableFieldCount)
    },
    attributes: {
      required: normalizeBoolean(input.attributes?.required, defaultDianxiaomiRequirementRules.attributes.required),
      minCount: normalizeInteger(input.attributes?.minCount, defaultDianxiaomiRequirementRules.attributes.minCount),
      recommendedKeys: normalizeStringList(input.attributes?.recommendedKeys, defaultDianxiaomiRequirementRules.attributes.recommendedKeys)
    },
    compliance: {
      required: normalizeBoolean(input.compliance?.required, defaultDianxiaomiRequirementRules.compliance.required),
      blockedTerms: normalizeStringList(input.compliance?.blockedTerms, defaultDianxiaomiRequirementRules.compliance.blockedTerms)
    }
  }
}

const persistedState = loadPlannerState()
let pricingRules: PricingRules = persistedState?.pricingRules ?? defaultPricingRules
let dianxiaomiRequirementRules: DianxiaomiListingRequirementRules =
  normalizeDianxiaomiRequirementRules(persistedState?.dianxiaomiRequirementRules)

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)

const getRepoRoot = () => {
  const currentFile = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(currentFile), "../../..")
}

const getTaskExportHistoryPath = () => process.env.TASK_EXPORT_HISTORY_PATH ?? path.join(getRepoRoot(), ".runtime/automation-task-exports.json")

const readTaskExportHistory = (): AutomationTaskFileExportResult[] => {
  const historyPath = getTaskExportHistoryPath()
  if (!existsSync(historyPath)) {
    return []
  }

  try {
    const parsed = JSON.parse(readFileSync(historyPath, "utf8")) as AutomationTaskFileExportResult[]
    return Array.isArray(parsed) ? parsed.filter((item) => item.exportId && item.taskFile) : []
  } catch {
    return []
  }
}

const writeTaskExportHistory = (items: AutomationTaskFileExportResult[]) => {
  const historyPath = getTaskExportHistoryPath()
  mkdirSync(path.dirname(historyPath), {
    recursive: true
  })
  writeFileSync(historyPath, JSON.stringify(items.slice(0, 100), null, 2), "utf8")
}

const mergeAttributes = (...items: Array<Record<string, string> | undefined>) =>
  items.reduce<Record<string, string>>((merged, item) => ({
    ...merged,
    ...(item ?? {})
  }), {})

const buildAttributeSummary = (attributes: Record<string, string>) =>
  Object.entries(attributes)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" / ")

const createDraftVersion = (source: DraftVersion["source"], label: string, draft: ListingDraft): DraftVersion => ({
  id: `draft-${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  source,
  label,
  draft,
  createdAt: new Date().toISOString()
})

const appendDraftVersion = (versions: DraftVersion[] | undefined, version: DraftVersion) =>
  [version, ...(versions ?? [])].slice(0, 20)

const buildCollectedProductQuality = (input: Pick<DianxiaomiCollectedProductInput, "title" | "images" | "skus">) => {
  const skus = input.skus ?? []
  const checks = [
    {
      id: "title",
      ok: Boolean(input.title?.trim()),
      message: input.title?.trim() ? "title captured" : "title missing"
    },
    {
      id: "images",
      ok: (input.images ?? []).length > 0,
      message: (input.images ?? []).length > 0 ? `${input.images?.length ?? 0} images captured` : "images missing"
    },
    {
      id: "skus",
      ok: skus.length > 0,
      message: skus.length > 0 ? `${skus.length} sku rows captured` : "sku rows missing"
    },
    {
      id: "price",
      ok: skus.some((sku) => typeof sku.priceCny === "number" && sku.priceCny > 0),
      message: skus.some((sku) => typeof sku.priceCny === "number" && sku.priceCny > 0) ? "price captured" : "price missing"
    },
    {
      id: "stock",
      ok: skus.some((sku) => typeof sku.stock === "number"),
      message: skus.some((sku) => typeof sku.stock === "number") ? "stock captured" : "stock missing"
    }
  ]
  const score = Math.round((checks.filter((check) => check.ok).length / checks.length) * 100)

  return {
    status: score >= 80 ? "ready" as const : score >= 50 ? "partial" as const : "poor" as const,
    score,
    checks
  }
}

const requiredLevel = (required: boolean): DianxiaomiListingRequirementCheck["level"] =>
  required ? "required" : "recommended"

const buildDianxiaomiRequirementChecks = (
  input: WorkItemQualityInput,
  rules: DianxiaomiListingRequirementRules = dianxiaomiRequirementRules
): DianxiaomiListingRequirementCheck[] => {
  const title = input.title?.trim() ?? ""
  const snapshot = input.snapshot
  const text = `${title}\n${input.rawTextSample ?? ""}`
  const lowerText = text.toLowerCase()
  const mediaToolSignals = (snapshot.mediaToolSignals ?? [])
    .map((signal) => signal.trim().toLowerCase())
    .filter(Boolean)
  const hasMediaSignal = (patterns: string[]) =>
    patterns.some((pattern) => mediaToolSignals.some((signal) => signal.includes(pattern)))
  const imageStats = snapshot.imageStats
  const sizeStatsReady = Boolean(imageStats) && (imageStats?.unknownDimensionCount ?? 0) === 0
  const imageSizeTooSmall = Boolean(imageStats)
    && ((imageStats?.minWidthPx ?? 0) < rules.media.minWidthPx || (imageStats?.minHeightPx ?? 0) < rules.media.minHeightPx)
  const imageSizeTooLarge = Boolean(imageStats)
    && ((imageStats?.maxWidthPx ?? 0) > rules.media.maxWidthPx || (imageStats?.maxHeightPx ?? 0) > rules.media.maxHeightPx)
  // P1-12: aspect-ratio range check. Only applies when both the rule bounds
  // and the snapshot's per-image ratios are present.
  const aspectRulesReady = typeof rules.media.minAspectRatio === "number" && typeof rules.media.maxAspectRatio === "number"
  const aspectStatsReady = typeof imageStats?.minAspectRatio === "number" && typeof imageStats?.maxAspectRatio === "number"
  const aspectOutOfRange = aspectRulesReady && aspectStatsReady
    && ((imageStats!.minAspectRatio as number) < (rules.media.minAspectRatio as number)
      || (imageStats!.maxAspectRatio as number) > (rules.media.maxAspectRatio as number))
  // P1-11: english-only / watermark-free image check. Satisfied by an
  // explicit Dianxiaomi 图片检测 pass or an image-check media signal.
  const imageCheckIssues = Array.isArray((input.snapshot as { imageCheck?: { issues?: Array<{ category?: string; issue?: string; detail?: string }> } }).imageCheck?.issues)
    ? ((input.snapshot as { imageCheck?: { issues?: Array<{ category?: string; issue?: string; detail?: string }> } }).imageCheck?.issues ?? [])
        .filter((issue) => Boolean(issue?.category) && Boolean(issue?.issue))
    : []
  const imageCheckPassed = (input.snapshot as { imageCheck?: { passed?: boolean } }).imageCheck?.passed === true
    || hasMediaSignal(["image check", "图片检测", "检测通过"])
  const explicitImageCheckPassed = (input.snapshot as { imageCheck?: { passed?: boolean } }).imageCheck?.passed
  const imageCheckFailed = explicitImageCheckPassed === false || imageCheckIssues.length > 0
  const imageCheckSatisfied = imageCheckFailed ? false : imageCheckPassed
  const blockedTerms = rules.compliance.blockedTerms
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
  const matchedBlockedTerms = blockedTerms.filter((term) => lowerText.includes(term))
  const normalizedCategory = normalizeCategoryLabel(input.category)
  const hasCategorySelectionSignal = !isPlaceholderDianxiaomiCategory(normalizedCategory)
    || Boolean(input.categoryHint?.categoryId?.trim())
    || Boolean(input.categoryHint?.fullCid?.trim())

  return [
    {
      id: "category-selection",
      level: "required",
      ok: hasCategorySelectionSignal,
      message: hasCategorySelectionSignal
        ? normalizedCategory
          ? `category ready: ${normalizedCategory}`
          : "category can be restored from Dianxiaomi category hint"
        : "Temu category is still missing on this Dianxiaomi item",
      recommendation: hasCategorySelectionSignal
        ? "Restore or confirm the Temu category before unattended publish."
        : "Open the Dianxiaomi category picker and choose the correct Temu category before unattended publish."
    },
    {
      id: "title-present",
      level: requiredLevel(rules.title.required),
      ok: !rules.title.required || Boolean(title),
      message: title ? "title exists in Dianxiaomi item" : "title is missing",
      recommendation: title ? undefined : "Open the Dianxiaomi product edit page and add a product title before automation."
    },
    {
      id: "title-length",
      level: requiredLevel(rules.title.required),
      ok: !title || (title.length >= rules.title.minLength && title.length <= rules.title.maxLength),
      message: title ? `title length is ${title.length}` : "title cannot be measured",
      recommendation: `Rewrite the title to ${rules.title.minLength}-${rules.title.maxLength} characters before saving the draft.`
    },
    {
      id: "images-present",
      level: requiredLevel(rules.images.required),
      ok: snapshot.imageCount >= rules.images.minCount,
      message: snapshot.imageCount > 0 ? `${snapshot.imageCount} images detected` : "no visible product images detected",
      recommendation: `Keep or upload at least ${rules.images.minCount} product images in Dianxiaomi before attempting Temu listing.`
    },
    {
      id: "media-image-translation",
      level: requiredLevel(rules.media.required && rules.media.requireImageTranslation),
      ok: !rules.media.requireImageTranslation || hasMediaSignal(["translate", "translation", "翻译", "圖片翻譯", "图片翻译"]),
      message: hasMediaSignal(["translate", "translation", "翻译", "圖片翻譯", "图片翻译"])
        ? `Dianxiaomi image translation signal detected for ${rules.media.targetLanguage}`
        : "Dianxiaomi image translation action not confirmed",
      recommendation: `Use Dianxiaomi image translation for product images before Temu listing, target language: ${rules.media.targetLanguage}.`
    },
    {
      id: "media-size-normalization",
      level: requiredLevel(rules.media.required && rules.media.requireSizeNormalization),
      ok: !rules.media.requireSizeNormalization || (sizeStatsReady && !imageSizeTooSmall && !imageSizeTooLarge),
      message: imageStats
        ? `image dimensions ${imageStats.minWidthPx}x${imageStats.minHeightPx} to ${imageStats.maxWidthPx}x${imageStats.maxHeightPx}, unknown ${imageStats.unknownDimensionCount}`
        : "image dimensions not available",
      recommendation: `Use Dianxiaomi batch resize or image editor to normalize images to ${rules.media.minWidthPx}-${rules.media.maxWidthPx}px wide and ${rules.media.minHeightPx}-${rules.media.maxHeightPx}px high.`
    },
    // P1-12: aspect-ratio range. Recommended-level so missing ratio data
    // doesn't block; only an in-range failure flags. Skipped entirely when
    // the rule has no aspect bounds configured.
    ...(aspectRulesReady
      ? [{
          id: "media-aspect-ratio",
          level: "recommended" as const,
          ok: !aspectStatsReady || !aspectOutOfRange,
          message: aspectStatsReady
            ? `image aspect ratio ${imageStats!.minAspectRatio}–${imageStats!.maxAspectRatio} (allowed ${rules.media.minAspectRatio}–${rules.media.maxAspectRatio})`
            : "image aspect ratio not available",
          recommendation: `Keep listing images between ${rules.media.minAspectRatio} and ${rules.media.maxAspectRatio} width/height ratio (use Dianxiaomi batch resize).`
        }]
      : []),
    // P1-11: english-only / watermark-free image check. Recommended-level
    // so an unconfirmed image check doesn't block the unattended path until
    // a real Dianxiaomi 图片检测 signal exists; it surfaces as a warning the
    // operator can act on.
    ...(rules.media.requireEnglishOnlyImages
        ? [{
          id: "media-english-only-images",
          level: imageCheckFailed ? "required" as const : "recommended" as const,
          ok: imageCheckSatisfied,
          message: imageCheckSatisfied
            ? "Dianxiaomi image check passed (no non-English text / watermark)"
            : imageCheckIssues.length > 0
              ? `image check found issues: ${imageCheckIssues.slice(0, 4).map((issue) => `${issue.category} ${issue.issue}`).join(", ")}`
              : explicitImageCheckPassed === false
                ? "image check failed"
                : "image check not confirmed; listing images may contain non-English text or watermarks",
          recommendation: "Run Dianxiaomi 图片检测 (image check) and image translation so listing images are English-only and watermark-free."
        }]
      : []),
    {
      id: "media-white-background",
      level: requiredLevel(rules.media.required && rules.media.requireWhiteBackground),
      ok: !rules.media.requireWhiteBackground || hasMediaSignal(["white background", "白底", "白底图"]),
      message: hasMediaSignal(["white background", "白底", "白底图"]) ? "white background tool signal detected" : "white background action not confirmed",
      recommendation: "Use Dianxiaomi white background or image editor when the main image is not marketplace-ready."
    },
    {
      id: "media-editor-review",
      level: requiredLevel(rules.media.required && rules.media.requireImageEditorReview),
      ok: !rules.media.requireImageEditorReview || hasMediaSignal(["image editor", "美图", "小秘美图", "图片管理"]),
      message: hasMediaSignal(["image editor", "美图", "小秘美图", "图片管理"]) ? "Dianxiaomi image editor review signal detected" : "Dianxiaomi image editor review not confirmed",
      recommendation: `Review images with Dianxiaomi native tools: ${rules.media.dianxiaomiTools.join(", ")}.`
    },
    {
      id: "sku-present",
      level: requiredLevel(rules.sku.required),
      ok: snapshot.skuCount >= rules.sku.minCount,
      message: snapshot.skuCount > 0 ? `${snapshot.skuCount} SKU rows detected` : "no SKU rows detected",
      recommendation: `Confirm Dianxiaomi has generated at least ${rules.sku.minCount} SKU rows for this item.`
    },
    {
      id: "price-fields",
      level: requiredLevel(rules.price.required),
      ok: snapshot.priceFieldCount >= rules.price.minEditableFieldCount,
      message: snapshot.priceFieldCount > 0 ? `${snapshot.priceFieldCount} price fields detected` : "no editable price fields detected",
      recommendation: "Open the product listing/edit surface where SKU prices can be edited."
    },
    {
      id: "stock-fields",
      level: requiredLevel(rules.stock.required),
      ok: snapshot.stockFieldCount >= rules.stock.minEditableFieldCount,
      message: snapshot.stockFieldCount > 0 ? `${snapshot.stockFieldCount} stock fields detected` : "no editable stock fields detected",
      recommendation: "Open or expand the SKU area so inventory can be checked before saving."
    },
    {
      id: "attributes-present",
      level: requiredLevel(rules.attributes.required),
      ok: snapshot.attributeKeys.length >= rules.attributes.minCount,
      message: snapshot.attributeKeys.length > 0 ? `attributes detected: ${snapshot.attributeKeys.join(", ")}` : "no structured attributes detected",
      recommendation: `Complete at least ${rules.attributes.minCount} product attributes, preferably ${rules.attributes.recommendedKeys.join(", ") || "category-specific keys"}.`
    },
    {
      id: "compliance-risk-terms",
      level: requiredLevel(rules.compliance.required),
      ok: matchedBlockedTerms.length === 0,
      message: matchedBlockedTerms.length > 0 ? `blocked terms found: ${matchedBlockedTerms.join(", ")}` : "basic infringement keyword screen",
      recommendation: `Review restricted claims before automation: ${rules.compliance.blockedTerms.join(", ")}.`
    },
    // P1-3: per-category overrides. When the work item carries a category
    // hint and the rules have a matching entry, raise the bar on the
    // required metadata (size chart, manual document, video) and surface
    // required attribute keys.
    ...(function () {
      const override = getDianxiaomiCategoryRule(rules, (input as { category?: string }).category)
      if (!Object.keys(override).length) {
        return [] as DianxiaomiListingRequirementCheck[]
      }
      // The current snapshot shape doesn't always carry these optional
      // metadata fields; access them through a loose view so the category
      // checks degrade to "missing" when the collector hasn't supplied them.
      const snap = snapshot as {
        sizeChart?: { present?: boolean }
        manualDocument?: { present?: boolean }
        video?: { present?: boolean }
        attributeKeys?: string[]
      }
      const categoryKey = (input as { category?: string }).category?.trim().toLowerCase() ?? ""
      const checks: DianxiaomiListingRequirementCheck[] = []
      if (override.requireSizeChart === true) {
        checks.push({
          id: `category-${categoryKey}-size-chart-required`,
          level: "required",
          ok: Boolean(snap.sizeChart?.present),
          message: snap.sizeChart?.present
            ? `size chart asset present for ${categoryKey}`
            : `size chart asset missing for ${categoryKey}`,
          recommendation: `Category "${categoryKey}" requires a size chart. Upload one in the Dianxiaomi listing editor before unattended publish.`
        })
      }
      if (override.requireManualDocument === true) {
        checks.push({
          id: `category-${categoryKey}-manual-required`,
          level: "required",
          ok: Boolean(snap.manualDocument?.present),
          message: snap.manualDocument?.present
            ? `manual document present for ${categoryKey}`
            : `manual document missing for ${categoryKey}`,
          recommendation: `Category "${categoryKey}" requires a PDF manual. Upload it in the Dianxiaomi listing editor before unattended publish.`
        })
      }
      if (override.requireVideo === true) {
        checks.push({
          id: `category-${categoryKey}-video-required`,
          level: "required",
          ok: Boolean(snap.video?.present),
          message: snap.video?.present
            ? `video present for ${categoryKey}`
            : `video missing for ${categoryKey}`,
          recommendation: `Category "${categoryKey}" requires a product video. Upload it in the Dianxiaomi listing editor before unattended publish.`
        })
      }
      if (Array.isArray(override.requiredAttributes) && override.requiredAttributes.length > 0) {
        const present = new Set(snap.attributeKeys ?? [])
        const missing = override.requiredAttributes.filter((key) => !present.has(key))
        checks.push({
          id: `category-${categoryKey}-required-attributes`,
          level: "required",
          ok: missing.length === 0,
          message: missing.length === 0
            ? `all required attributes present for ${categoryKey}`
            : `missing required attributes for ${categoryKey}: ${missing.join(", ")}`,
          recommendation: `Category "${categoryKey}" requires these attributes: ${override.requiredAttributes.join(", ")}.`
        })
      }
      return checks
    })()
  ]
}

const summarizeDianxiaomiRequirementChecks = (checks: DianxiaomiListingRequirementCheck[]) => {
  const required = checks.filter((check) => check.level === "required")
  const recommended = checks.filter((check) => check.level === "recommended")

  return {
    requiredTotal: required.length,
    requiredPassed: required.filter((check) => check.ok).length,
    recommendedTotal: recommended.length,
    recommendedPassed: recommended.filter((check) => check.ok).length,
    ready: required.every((check) => check.ok)
  }
}

const buildDianxiaomiSuggestedEdits = (checks: DianxiaomiListingRequirementCheck[]): DianxiaomiProductSuggestedEdit[] =>
  checks
    .filter((check) => !check.ok)
    .map((check): DianxiaomiProductSuggestedEdit => {
      const field: DianxiaomiProductSuggestedEdit["field"] =
        check.id.includes("title") ? "title"
          : check.id.includes("image") ? "image"
            : check.id.includes("media") ? "image"
            : check.id.includes("sku") ? "sku"
              : check.id.includes("price") ? "price"
                : check.id.includes("stock") ? "stock"
                  : check.id.includes("attribute") ? "attribute"
                    : "compliance"

      return {
        id: `edit-${check.id}`,
        field,
        priority: check.level,
        reason: check.message,
        suggestedValue: check.recommendation
      }
    })

const buildDianxiaomiWorkRequirements = (
  input: WorkItemQualityInput,
  rules: DianxiaomiListingRequirementRules = dianxiaomiRequirementRules
) => {
  const checks = buildDianxiaomiRequirementChecks(input, rules)

  return {
    presetName: rules.presetName,
    checkedAt: new Date().toISOString(),
    checks,
    summary: summarizeDianxiaomiRequirementChecks(checks)
  }
}

const parseFailureMetadata = (message: string) => ({
  failureKind: message.match(/failureKind=([^;]+)/i)?.[1]?.trim().toLowerCase() ?? "",
  retryable: message.match(/retryable=([^;]+)/i)?.[1]?.trim().toLowerCase() ?? "",
  tool: message.match(/media-processing-plan:\s*([^;]+?)\s+failed/i)?.[1]?.trim()
    ?? message.match(/:\s*([^:;]+?)\s+failed(?:;|$)/i)?.[1]?.trim()
    ?? ""
})

const normalizeRepairTarget = (value: string) =>
  value
    .replace(/^[\s:："'“”‘’`[\]【】()（）<>《》]+|[\s:："'“”‘’`[\]【】()（）<>《》]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80)

const inferPublishValidationTargets = (message: string): Array<{
  field: DianxiaomiProductSuggestedEdit["field"]
  target: string
}> => {
  const normalized = message.toLowerCase()
  const targets: Array<{
    field: DianxiaomiProductSuggestedEdit["field"]
    target: string
  }> = []
  const addTarget = (field: DianxiaomiProductSuggestedEdit["field"], target: string) => {
    const normalizedTarget = normalizeRepairTarget(target)
    const key = `${field}:${normalizedTarget.toLowerCase()}`
    if (!normalizedTarget || targets.some((item) => `${item.field}:${item.target.toLowerCase()}` === key)) {
      return
    }
    targets.push({
      field,
      target: normalizedTarget
    })
  }
  const addIfIncludes = (field: DianxiaomiProductSuggestedEdit["field"], patterns: string[], label: string) => {
    if (patterns.some((pattern) => normalized.includes(pattern))) {
      addTarget(field, label)
    }
  }

  addIfIncludes("title", ["title", "标题", "商品名", "商品名称"], "商品标题")
  addIfIncludes("image", ["image", "picture", "photo", "main image", "图片", "主图", "白底图"], "商品图片")
  addIfIncludes("sku", ["sku", "variation", "规格", "变体"], "SKU/规格")
  addIfIncludes("price", ["price", "价格", "售价", "供货价"], "价格")
  addIfIncludes("stock", ["stock", "inventory", "库存"], "库存")

  const attributePatterns = [
    /(?:attribute|property|variation attribute)\s*[:：=]\s*([^;,\n]+)/gi,
    /(?:missing required attribute)\s*[:：=]?\s*([^;,\n]+)/gi,
    /(?:属性|规格属性|必填属性|缺少必填属性)\s*[:：=]?\s*([^;，,\n]+)/g
  ]
  for (const pattern of attributePatterns) {
    for (const match of message.matchAll(pattern)) {
      addTarget("attribute", match[1] ?? "商品属性")
    }
  }

  if (targets.length === 0 && /(attribute|property|属性|规格参数|参数)/i.test(message)) {
    addTarget("attribute", "商品属性")
  }

  return targets.slice(0, 8)
}

const repairPayloadForField = (
  field: DianxiaomiProductSuggestedEdit["field"],
  target?: string
): NonNullable<DianxiaomiProductRepairAction["payload"]> => {
  if (field === "title") {
    return {
      writer: "fill-single-field",
      selectorGroup: "fields",
      selectorKey: "title",
      fieldKind: "title",
      reasonCode: "publish-title"
    }
  }

  if (field === "price") {
    return {
      writer: "fill-single-field",
      selectorGroup: "fields",
      selectorKey: "price",
      fieldKind: "price",
      reasonCode: "publish-price"
    }
  }

  if (field === "stock") {
    return {
      writer: "fill-single-field",
      selectorGroup: "fields",
      selectorKey: "stock",
      fieldKind: "stock",
      reasonCode: "publish-stock"
    }
  }

  if (field === "sku") {
    return {
      writer: "fill-sku-pricing",
      selectorGroup: "skuRows",
      selectorKey: "skuRows",
      skuMode: "variation",
      reasonCode: "publish-sku"
    }
  }

  if (field === "image") {
    return {
      writer: "run-media-tool",
      selectorGroup: "mediaTools",
      selectorKey: "imageManagement",
      mediaTool: "imageManagement",
      reasonCode: "publish-image"
    }
  }

  if (field === "attribute") {
    return {
      writer: "fill-attributes",
      selectorGroup: "fields",
      selectorKey: "attribute",
      fieldKind: "attribute",
      attributeKey: target,
      reasonCode: "publish-attribute"
    }
  }

  return {
    writer: "manual",
    reasonCode: `publish-${field}`
  }
}

const summarizeRepairActions = (actions: DianxiaomiProductRepairAction[]) =>
  actions.slice(0, 3).map((action) => action.label).join("; ")

const getPublishValidationRepairMessage = (
  item: Pick<DianxiaomiProductWorkItem, "publishOutcome">,
  diagnosis: DianxiaomiWorkFailureDiagnosis
) => {
  const candidates = [
    item.publishOutcome?.failureReason,
    item.publishOutcome?.message,
    diagnosis.message
  ].filter((value): value is string => Boolean(value?.trim()))

  const targeted = candidates
    .filter((candidate) => inferPublishValidationTargets(candidate).length > 0)
    .sort((left, right) => left.length - right.length)

  return targeted[0] ?? candidates[0] ?? diagnosis.message
}

const buildFailureDiagnosisRepairActions = (
  item: Pick<DianxiaomiProductWorkItem, "collectedProductId" | "title" | "publishOutcome">,
  diagnosis: DianxiaomiWorkFailureDiagnosis
): {
  actions: DianxiaomiProductRepairAction[]
  blockers: string[]
} => {
  const metadata = parseFailureMetadata(diagnosis.message)
  const actions: DianxiaomiProductRepairAction[] = []
  const blockers: string[] = []
  const addAction = (action: DianxiaomiProductRepairAction) => actions.push(action)

  if (diagnosis.category === "task-file") {
    addAction({
      id: "repair-refresh-task-file",
      type: "refresh-task-file",
      label: "刷新店小秘任务快照",
      detail: "重新从当前店小秘商品页生成自动化任务文件，再进入队列重跑。",
      automation: "auto",
      required: true,
      payload: {
        writer: "refresh-task-file",
        reasonCode: "stale-task-file"
      }
    })
    return { actions, blockers }
  }

  if (diagnosis.category === "browser-profile") {
    addAction({
      id: "repair-clear-browser-profile",
      type: "clear-browser-profile",
      label: "释放浏览器配置占用",
      detail: "关闭占用同一自动化浏览器资料的窗口，或清理过期 profile lock 后重试。",
      automation: "assisted",
      required: true,
      payload: {
        writer: "clear-browser-profile",
        reasonCode: "browser-profile-lock"
      }
    })
    return { actions, blockers }
  }

  if (diagnosis.category === "media-processing") {
    if (metadata.failureKind === "storage-quota") {
      addAction({
        id: "repair-dianxiaomi-image-space",
        type: "review-image",
        label: "释放店小秘图片空间",
        detail: "店小秘返回图片空间不足。需要先删除无用图片、购买/扩容图片空间，或确认一条不生成新图片空间素材的图片替代路径后再重跑。",
        automation: "manual",
        required: true,
        field: "image",
        tool: metadata.tool || undefined,
        payload: {
          writer: "manual",
          reasonCode: "storage-quota"
        }
      })
    } else if (metadata.failureKind === "transient" || diagnosis.retryable) {
      addAction({
        id: "repair-retry-transient-media",
        type: "retry-transient",
        label: "重试临时图片工具失败",
        detail: metadata.tool
          ? `${metadata.tool} 返回临时失败，后续队列可重新打开同一工具执行。`
          : "店小秘图片工具返回临时失败，后续队列可重新执行图片处理。",
        automation: "auto",
        required: true,
        field: "image",
        tool: metadata.tool || undefined,
        payload: {
          writer: "run-media-tool",
          selectorGroup: "mediaTools",
          selectorKey: "batchResize",
          mediaTool: "batchResize",
          reasonCode: "transient-media"
        }
      })
    } else {
      addAction({
        id: "repair-review-media",
        type: "review-image",
        label: "检查图片规格或工具配置",
        detail: metadata.failureKind
          ? `图片处理失败类型：${metadata.failureKind}。需要先确认图片尺寸、格式、白底/翻译工具配置。`
          : "图片处理失败，需要先确认店小秘图片翻译、批量改尺寸、白底或图片编辑器能正常完成。",
        automation: "assisted",
        required: true,
        field: "image",
        tool: metadata.tool || undefined,
        payload: {
          writer: "run-media-tool",
          selectorGroup: "mediaTools",
          selectorKey: "imageManagement",
          mediaTool: "imageManagement",
          reasonCode: metadata.failureKind || "invalid-media"
        }
      })
    }
    return { actions, blockers }
  }

  if (diagnosis.category === "publish-validation") {
    const validationMessage = getPublishValidationRepairMessage(item, diagnosis)
    const targets = inferPublishValidationTargets(validationMessage)
    if (targets.length > 0) {
      targets.forEach((target, index) => {
        addAction({
          id: `repair-publish-${target.field}-${index + 1}`,
          type: target.field === "image" ? "review-image" : "fix-field",
          label: target.field === "attribute" ? `补齐属性：${target.target}` : `修复发布字段：${target.target}`,
          detail: validationMessage,
          automation: publishValidationAutomationForTarget(item, target.field, target.target),
          required: true,
          field: target.field,
          target: target.target,
          payload: withPublishValidationExpectedValue(
            item,
            target.field,
            target.target,
            repairPayloadForField(target.field, target.target)
          )
        })
      })
    } else {
      addAction({
        id: "repair-publish-required-fields",
        type: "fix-field",
        label: "补齐发布必填项",
        detail: validationMessage,
        automation: "assisted",
        required: true,
        field: "attribute",
        target: "商品属性",
        payload: repairPayloadForField("attribute", "商品属性")
      })
    }
    return { actions, blockers }
  }

  if (diagnosis.category === "login-or-captcha") {
    blockers.push("登录、验证码或风控需要人工处理，系统不会绕过。")
    addAction({
      id: "repair-manual-session",
      type: "manual-session",
      label: "人工完成登录/验证码",
      detail: diagnosis.nextAction,
      automation: "manual",
      required: true,
      payload: {
        writer: "manual",
        reasonCode: "manual-session"
      }
    })
    return { actions, blockers }
  }

  if (diagnosis.category === "real-page-calibration" || diagnosis.category === "selector-config") {
    blockers.push("页面校准或选择器配置未通过，不能自动写入商品。")
    addAction({
      id: `repair-${diagnosis.category}`,
      type: "recalibrate-selectors",
      label: "重新校准真实店小秘页面",
      detail: diagnosis.nextAction,
      automation: "manual",
      required: true,
      payload: {
        writer: "manual",
        reasonCode: diagnosis.category
      }
    })
    return { actions, blockers }
  }

  if (diagnosis.category === "target-surface") {
    blockers.push("目标页面不是可写的店小秘商品编辑页。")
    addAction({
      id: "repair-replace-target-url",
      type: "replace-target-url",
      label: "更换真实商品编辑页链接",
      detail: diagnosis.nextAction,
      automation: "manual",
      required: true,
      payload: {
        writer: "manual",
        reasonCode: "target-surface"
      }
    })
    return { actions, blockers }
  }

  blockers.push("失败原因未识别，需要先查看自动化日志。")
  addAction({
    id: "repair-inspect-logs",
    type: "inspect-logs",
    label: "查看失败日志",
    detail: diagnosis.nextAction,
    automation: "manual",
    required: true,
    payload: {
      writer: "manual",
      reasonCode: "unknown"
    }
  })
  return { actions, blockers }
}

const inferImageRepairTool = (detail: string | undefined | null): NonNullable<DianxiaomiProductRepairAction["payload"]>["mediaTool"] => {
  const normalized = (detail ?? "").toLowerCase()
  if (/(尺寸|比例|宽高|像素|size|ratio|aspect|resolution)/i.test(normalized)) {
    return "batchResize"
  }
  if (/(非英文|中文|language|english|translate|翻译)/i.test(normalized)) {
    return "imageTranslation"
  }
  if (/(水印|背景|white background|remove background)/i.test(normalized)) {
    return "whiteBackground"
  }
  return "imageManagement"
}

const getRepairActionPriority = (action: DianxiaomiProductRepairAction) => {
  const mediaTool = action.payload?.mediaTool
  if (mediaTool === "batchResize") {
    return 0
  }
  if (mediaTool === "imageManagement") {
    return 10
  }
  if (mediaTool === "imageTranslation") {
    return 20
  }
  if (mediaTool === "whiteBackground" || mediaTool === "imageEditor") {
    return 30
  }
  return 100
}

const isGenericSaveDraftValidationFailure = (
  failureDiagnosis: Pick<DianxiaomiProductWorkItem, "failureDiagnosis">["failureDiagnosis"] | null | undefined,
  publishOutcome: Pick<DianxiaomiProductWorkItem, "publishOutcome">["publishOutcome"] | null | undefined
) => {
  const haystack = [
    failureDiagnosis?.message,
    publishOutcome?.failureReason,
    publishOutcome?.message
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase()

  if (!haystack) {
    return false
  }

  return [
    "save-draft",
    "save draft",
    "产品信息中有错误",
    "product information",
    "请检查"
  ].some((pattern) => haystack.includes(pattern))
}

const buildDianxiaomiRepairPlan = (
  item: Pick<DianxiaomiProductWorkItem, "collectedProductId" | "title" | "suggestedEdits" | "requirements" | "failureDiagnosis" | "status" | "publishOutcome">
): DianxiaomiProductRepairPlan | null => {
  const actions: DianxiaomiProductRepairAction[] = []
  const blockers: string[] = []
  const requirementActions = item.suggestedEdits.filter((edit) => edit.priority === "required").flatMap((edit): DianxiaomiProductRepairAction[] => {
    if (edit.field !== "image") {
      return [{
        id: `repair-${edit.id}`,
        type: "fix-field",
        label: `修复${edit.field}字段`,
        detail: edit.suggestedValue || edit.reason,
        automation: "assisted",
        required: true,
        field: edit.field
      }]
    }

    const imageIssueMatches = Array.from((edit.reason || "").matchAll(/(轮播图|产品图|详情图|主图|sku图|颜色图|属性图)\s*(尺寸|比例|宽高|非英文|中文|水印|模糊|像素|大小|格式)/gi))
    if (imageIssueMatches.length === 0) {
      return [{
        id: `repair-${edit.id}`,
        type: "apply-media-tool",
        label: "处理商品图片",
        detail: edit.suggestedValue || edit.reason,
        automation: "auto",
        required: true,
        field: edit.field,
        payload: {
          writer: "run-media-tool",
          selectorGroup: "mediaTools",
          selectorKey: "imageManagement",
          mediaTool: "imageManagement",
          expectedValue: edit.reason,
          reasonCode: "requirement-image"
        }
      }]
    }

    return imageIssueMatches.map((match, index) => {
      const category = match[1]
      const issue = match[2]
      const detail = `${category} ${issue}`
      const mediaTool = inferImageRepairTool(detail)
      return {
        id: `repair-${edit.id}-${index + 1}`,
        type: "apply-media-tool",
        label: `处理图片问题：${detail}`,
        detail,
        automation: "auto",
        required: true,
        field: "image" as const,
        target: category,
        tool: mediaTool,
        payload: {
          writer: "run-media-tool",
          selectorGroup: "mediaTools",
          selectorKey: mediaTool,
          mediaTool,
          expectedValue: detail,
          reasonCode: "requirement-image-check"
        }
      }
    })
  })
  actions.push(...requirementActions.sort((left, right) => getRepairActionPriority(left) - getRepairActionPriority(right)))

  const hasAutomaticImageCheckRepair = requirementActions.some((action) =>
    action.automation === "auto"
    && action.type === "apply-media-tool"
    && action.payload?.writer === "run-media-tool"
    && action.payload?.reasonCode === "requirement-image-check"
  )
  const deferFailureDiagnosisUntilImageRepair = hasAutomaticImageCheckRepair
    && isGenericSaveDraftValidationFailure(item.failureDiagnosis, item.publishOutcome)

  if (item.failureDiagnosis && !deferFailureDiagnosisUntilImageRepair) {
    const diagnosisPlan = buildFailureDiagnosisRepairActions(item, item.failureDiagnosis)
    actions.push(...diagnosisPlan.actions)
    blockers.push(...diagnosisPlan.blockers)
  }

  if (actions.length === 0 && blockers.length === 0) {
    return null
  }

  const requiredActions = actions.filter((action) => action.required)
  const hasManualAction = actions.some((action) => action.automation === "manual")
  const hasAssistedAction = actions.some((action) => action.automation === "assisted")
  const canAutoRepair = actions.length > 0 && actions.every((action) => action.automation === "auto") && blockers.length === 0
  const canRetryAfterRepair = item.requirements.summary.ready
    && blockers.length === 0
    && Boolean(item.failureDiagnosis?.retryable || item.failureDiagnosis?.autoRetryRecommended || requiredActions.length === 0)
  const source: DianxiaomiProductRepairPlan["source"] = item.failureDiagnosis && requirementActions.length > 0
    ? "combined"
    : item.failureDiagnosis
      ? "failure-diagnosis"
      : "requirements"
  const status: DianxiaomiProductRepairPlan["status"] = blockers.length > 0
    ? "blocked"
    : canAutoRepair
      ? "auto-ready"
      : hasManualAction
        ? "manual"
        : hasAssistedAction
          ? "assisted"
          : "auto-ready"

  return {
    status,
    source,
    summary: summarizeRepairActions(actions) || blockers[0] || "等待修复计划",
    canAutoRepair,
    canRetryAfterRepair,
    blockers,
    actions,
    createdAt: new Date().toISOString()
  }
}

const getRepairPlanActionCounts = (repairPlan: DianxiaomiProductRepairPlan | null | undefined) =>
  (repairPlan?.actions ?? []).reduce((counts, action) => {
    counts[action.automation] += 1
    return counts
  }, {
    auto: 0,
    assisted: 0,
    manual: 0
  })

const getRepairActionGateLabel = (repairPlan: DianxiaomiProductRepairPlan) => {
  const counts = getRepairPlanActionCounts(repairPlan)
  const countText = `自动 ${counts.auto} / 辅助 ${counts.assisted} / 人工 ${counts.manual}`

  if (repairPlan.status === "auto-ready" && repairPlan.canAutoRepair) {
    return `可自动处理（${counts.auto} 项）`
  }

  if (repairPlan.status === "assisted") {
    return `需辅助处理（${countText}）`
  }

  if (repairPlan.status === "manual") {
    return `需人工处理（${countText}）`
  }

  if (repairPlan.status === "blocked") {
    return `已阻塞（${countText}）`
  }

  return countText
}

const buildDianxiaomiRepairActionGate = (
  item: Pick<DianxiaomiProductWorkItem, "status" | "repairPlan">
): DianxiaomiProductRepairActionGate => {
  if (!item.repairPlan || item.status === "ready-for-automation" || item.status === "edited") {
    return {
      status: "none",
      defaultActionAllowed: true,
      message: ""
    }
  }

  if (item.repairPlan.status === "auto-ready" && item.repairPlan.canAutoRepair) {
    return {
      status: "auto-ready",
      defaultActionAllowed: true,
      message: "改造计划可自动处理，默认无人值守动作允许继续。"
    }
  }

  const label = getRepairActionGateLabel(item.repairPlan)
  return {
    status: item.repairPlan.status,
    defaultActionAllowed: false,
    message: `${label}，默认无人值守动作已暂停。展开高级信息查看改造计划，处理后再进入故障恢复或重试。`
  }
}

const withDianxiaomiRepairActionGate = (item: DianxiaomiProductWorkItem): DianxiaomiProductWorkItem => ({
  ...item,
  repairActionGate: buildDianxiaomiRepairActionGate(item)
})

const isManualBudgetPublishOutcome = (item: Pick<DianxiaomiProductWorkItem, "publishOutcome">) =>
  item.publishOutcome?.status === "failed" && item.publishOutcome.route === "manual-budget"

const getManualBudgetReason = (item: Pick<DianxiaomiProductWorkItem, "publishOutcome" | "failureDiagnosis">) =>
  item.publishOutcome?.failureReason
    ?? item.failureDiagnosis?.message
    ?? item.publishOutcome?.message
    ?? "Dianxiaomi publish failed and no automatic route is currently allowed."

const getManualBudgetOperatorAction = (item: Pick<DianxiaomiProductWorkItem, "failureDiagnosis">) =>
  item.failureDiagnosis?.nextAction
    ?? "Inspect the latest submit-listing report, fix the Dianxiaomi listing issue, then retry only after the item passes checks."

const manualBudgetReleaseCondition = "Fix the issue, regenerate or update the work item so it is no longer manual-budget, then move it back to ready-for-automation through retry-after-fix or a new auto-ready repair plan."

const buildManualBudgetRelease = (
  current: DianxiaomiProductWorkItem,
  toStatus: DianxiaomiProductWorkItem["status"],
  note: string | undefined,
  releaseEventAt: string
): AutomationManualStepBudgetRelease | null => {
  if (current.status !== "blocked" || toStatus !== "ready-for-automation" || !isManualBudgetPublishOutcome(current)) {
    return null
  }

  return {
    workItemId: current.id,
    title: current.title || current.pageTitle || current.id,
    source: "publish-outcome",
    reason: `publish outcome manual-budget: ${getManualBudgetReason(current)}`,
    operatorAction: getManualBudgetOperatorAction(current),
    releaseCondition: manualBudgetReleaseCondition,
    releasedAt: new Date().toISOString(),
    releaseEventAt,
    releaseType: note?.startsWith("retry after fix released") ? "retry-after-fix" : "status-update",
    fromStatus: current.status,
    toStatus,
    note: note ?? ""
  }
}

const rebuildDianxiaomiProductWorkItem = (
  item: DianxiaomiProductWorkItem,
  rules: DianxiaomiListingRequirementRules = dianxiaomiRequirementRules
): DianxiaomiProductWorkItem => {
  const requirements = buildDianxiaomiWorkRequirements({
    ...item,
    category: item.categoryHint?.label,
    categoryHint: item.categoryHint
  }, rules)
  const suggestedEdits = buildDianxiaomiSuggestedEdits(requirements.checks)
  const updatedStatus = requirements.summary.ready ? "ready-for-automation" : "needs-revision"

  const rebuilt: DianxiaomiProductWorkItem = {
    ...item,
    updatedAt: new Date().toISOString(),
    requirements,
    suggestedEdits,
    status: updatedStatus,
    failureDiagnosis: null,
    manualBudgetReleases: item.manualBudgetReleases ?? []
  }
  const repairPlan = buildDianxiaomiRepairPlan(rebuilt)
  return withDianxiaomiRepairActionGate({
    ...rebuilt,
    repairPlan
  })
}

const refreshDianxiaomiWorkItemReadiness = (
  item: DianxiaomiProductWorkItem,
  rules: DianxiaomiListingRequirementRules = dianxiaomiRequirementRules
): DianxiaomiProductWorkItem => {
  const rebuilt = rebuildDianxiaomiProductWorkItem(item, rules)
  return {
    ...rebuilt,
    status: item.status === "blocked" || item.status === "edited"
      ? item.status
      : rebuilt.status,
    failureDiagnosis: item.status === "blocked" ? item.failureDiagnosis ?? rebuilt.failureDiagnosis ?? null : rebuilt.failureDiagnosis,
    publishOutcome: item.publishOutcome ?? rebuilt.publishOutcome ?? null,
    manualBudgetReleases: item.manualBudgetReleases ?? rebuilt.manualBudgetReleases ?? []
  }
}

// P1-6: dedupe key computed from the canonical page URL + the page
// title + a snapshot signature. Same product admitted twice yields the
// same key, so `saveDianxiaomiProductWorkItem` can dedupe and update
// the original work item instead of creating a new one.
export const computeDianxiaomiDedupeKey = (
  input: Pick<DianxiaomiProductWorkItemInput, "pageUrl" | "snapshot" | "title">
): string => {
  const url = normalizeDianxiaomiPageUrl(input.pageUrl)
  const titleToken = (input.title ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80)
  const imageToken = (input.snapshot?.attributeKeys ?? []).join(",").toLowerCase()
  const hash = createHash("sha1")
    .update(url)
    .update("|")
    .update(titleToken)
    .update("|")
    .update(imageToken)
  return `dxm-dedupe:${hash.digest("hex").slice(0, 16)}`
}

const normalizeDianxiaomiPageUrl = (pageUrl: string) => {
  try {
    const parsed = new URL(pageUrl)
    const preserveHash = ["data:", "about:", "file:"].includes(parsed.protocol)
    if (!preserveHash) {
      parsed.hash = ""
    }
    parsed.searchParams.sort()
    return parsed.toString().replace(/\/$/, "").toLowerCase()
  } catch {
    return pageUrl.trim().replace(/\/$/, "").toLowerCase()
  }
}

const allowDianxiaomiSmokeUrls = () => process.env.ALLOW_DIANXIAOMI_SMOKE_URLS === "true"

const dianxiaomiUrlBlockReason = (pageUrl: string) => {
  const trimmed = pageUrl.trim()
  const allowSmokeUrls = allowDianxiaomiSmokeUrls()
  if (!trimmed) {
    return "missing Dianxiaomi page URL"
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return "invalid Dianxiaomi page URL"
  }

  const normalized = trimmed.toLowerCase()
  if (parsed.protocol === "data:" || parsed.protocol === "about:" || parsed.protocol === "file:") {
    return allowSmokeUrls ? null : "local fixture URL is not allowed for real Dianxiaomi automation"
  }

  if (!allowSmokeUrls && /(?:smoke|fixture|example)/i.test(normalized)) {
    return "demo/smoke Dianxiaomi URL is not allowed for real automation"
  }

  const host = parsed.hostname.toLowerCase()
  if (!host.endsWith("dianxiaomi.com")) {
    return "URL host is not Dianxiaomi"
  }

  if (host === "help.dianxiaomi.com" || host.startsWith("help.")) {
    return "Dianxiaomi help-center URL is not a product listing edit page"
  }

  if (parsed.pathname === "/" && !parsed.search) {
    return "Dianxiaomi home URL is not a product listing edit page"
  }

  const normalizedPath = parsed.pathname.toLowerCase()
  const isKnownEditSurface =
    normalizedPath === "/web/poptemu/edit"
    || /\/(product|listing|goods|item)\/edit\b/i.test(parsed.pathname)
    || /\/web\/poptemu\/edit\b/i.test(parsed.pathname)

  if (!isKnownEditSurface) {
    return "Dianxiaomi URL does not look like a product listing edit page"
  }

  return null
}

export const validateDianxiaomiAutomationPageUrl = (pageUrl: string) => ({
  valid: !dianxiaomiUrlBlockReason(pageUrl),
  reason: dianxiaomiUrlBlockReason(pageUrl)
})

// P1-9: validate a BCP-47-ish locale token. Accepts "en", "en-US",
// "zh-Hans-CN" etc. Empty / invalid values fall back to "en".
const VALID_LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
export const normalizeDianxiaomiTargetLanguage = (input: string | undefined | null): string => {
  const trimmed = (input ?? "").trim()
  if (!trimmed) {
    return "en"
  }
  return VALID_LOCALE_PATTERN.test(trimmed) ? trimmed : "en"
}

const createProductSkus = (
  productId: string,
  input: {
    supplierPriceCny: number
    stock: number
    skuName?: string
    attributes?: Record<string, string>
    skus?: Array<{
      skuId?: string
      skuName: string
      costCny: number
      stock: number
      attributes?: Record<string, string>
    }>
  }
) => {
  const inputSkus = input.skus?.length
    ? input.skus
    : [{
        skuName: input.skuName?.trim() || "默认规格",
        costCny: input.supplierPriceCny,
        stock: input.stock,
        attributes: input.attributes
      }]

  return inputSkus.map((sku, index) => {
    const skuName = sku.skuName?.trim() || `规格 ${index + 1}`
    return {
      skuId: sku.skuId?.trim() || `${productId}-${slugify(skuName) || `sku-${index + 1}`}`,
      name: skuName,
      costCny: sku.costCny,
      stock: Math.max(0, Math.floor(sku.stock)),
      attributes: sku.attributes ?? input.attributes ?? {}
    }
  })
}

const buildTaskForProduct = (product: ProductCandidate, previousTask?: PublishTask): PublishTask => {
  const task = createMockTask(product)
  const pricing = calculatePricing(product, pricingRules)
  const generatedDraft = generateListingDraft(product)
  const pricedDraft = {
    ...generatedDraft,
    skuPricing: generatedDraft.skuPricing.map((sku) => ({
      ...sku,
      salePriceUsd: pricing.suggestedPriceUsd
    }))
  }
  const estimatedMarginRate = pricing.suggestedPriceUsd > 0
    ? Number(((pricing.suggestedPriceUsd - pricing.floorPriceUsd) / pricing.suggestedPriceUsd).toFixed(4))
    : 0
  const pricingRisks = [
    estimatedMarginRate < pricingRules.minimumMarginRate
      ? {
          id: "risk-low-margin",
          level: "high" as const,
          message: `预计毛利率 ${Math.round(estimatedMarginRate * 100)}% 低于阈值 ${Math.round(pricingRules.minimumMarginRate * 100)}%`
        }
      : null,
    pricing.suggestedPriceUsd < pricingRules.minimumSuggestedPriceUsd
      ? {
          id: "risk-low-price",
          level: "medium" as const,
          message: `建议售价 $${pricing.suggestedPriceUsd.toFixed(2)} 低于最低售价 $${pricingRules.minimumSuggestedPriceUsd.toFixed(2)}`
        }
      : null
  ].filter((risk): risk is NonNullable<typeof risk> => Boolean(risk))
  const versions = appendDraftVersion(
    previousTask?.draftVersions,
    createDraftVersion("ai", previousTask ? "AI 重新生成草稿" : "AI 初始草稿", pricedDraft)
  )

  return {
    ...task,
    pricing,
    risks: [...pricingRisks, ...generateContentRisks(product, pricedDraft), ...task.risks],
    draft: pricedDraft,
    draftVersions: versions,
    review: previousTask?.review?.status === "approved" ? previousTask.review : {
      status: "pending",
      note: "",
      reviewedAt: "",
      history: previousTask?.review?.history ?? []
    }
  }
}

/**
 * 在已建好的规则任务之上，用真实大模型覆写草稿文案（标题/卖点/描述）。
 *
 * - 未配置 LLM 或调用失败：原样返回传入 task（`enhanceListingDraftWithLlm` 保证不抛，
 *   并回退到规则草稿），无人值守主流程不受影响。
 * - LLM 成功：覆写文案字段，并**重跑内容风险判定**（标题变了要重判长度/敏感词），
 *   同时保留非内容类风险（定价等）。
 * - LLM 回退：追加一条 low 级 `risk-llm-fallback`，让操作者可见但不阻断流程。
 *
 * 只在**交互式单件重规划**入口 `planTaskForProduct`（POST /plan/:productId）调用。
 * 无人值守队列/恢复批跑走的两个店小秘建任务函数刻意保持同步+规则化 ——
 * 那是硬门控的自动化热路径，不能引入每件一次的网络依赖；且店小秘 work-item 的
 * description 是"按需求修复"的功能性指引，不是营销文案。`buildTaskForProduct`
 * 及其同步调用点全部不变。
 */
export const enhanceTaskDraftWithLlm = async (task: PublishTask): Promise<PublishTask> => {
  const { draft, usedLlm, fallbackReason } = await enhanceListingDraftWithLlm(task.product, task.draft)

  if (!usedLlm) {
    if (!fallbackReason) {
      // 未配置 LLM —— 与今天行为完全一致，不加任何风险。
      return task
    }
    return {
      ...task,
      risks: [
        ...task.risks.filter((risk) => risk.id !== "risk-llm-fallback"),
        {
          id: "risk-llm-fallback",
          level: "low" as const,
          message: `AI 文案生成回退到规则草稿：${fallbackReason}`
        }
      ]
    }
  }

  // 标题/卖点/描述来自模型，需重跑内容风险；非内容类风险（如定价）原样保留。
  const contentRiskIds = new Set([
    "risk-sensitive-keywords",
    "risk-missing-images",
    "risk-thin-attributes",
    "risk-title-too-long"
  ])
  const nonContentRisks = task.risks.filter(
    (risk) => !contentRiskIds.has(risk.id) && risk.id !== "risk-llm-fallback"
  )

  return {
    ...task,
    draft,
    risks: [...nonContentRisks, ...generateContentRisks(task.product, draft)],
    updatedAt: new Date().toISOString()
  }
}

const productStore = new Map<string, ProductCandidate>([
  ...mockProducts.map((product): [string, ProductCandidate] => [product.id, product]),
  ...(persistedState?.products ?? []).map((product): [string, ProductCandidate] => [product.id, product])
])

const seededTasks = Array.from(productStore.values()).map((product) => buildTaskForProduct(product))

const taskStore = new Map<string, PublishTask>([
  ...seededTasks.map((task): [string, PublishTask] => [task.id, task]),
  ...(persistedState?.tasks ?? []).map((task): [string, PublishTask] => [task.id, task])
])

let activeTaskId = persistedState?.activeTaskId ?? seededTasks[0]?.id ?? null
const debugSnapshots: PageDebugSnapshot[] = []
const dianxiaomiCollectedProducts: DianxiaomiCollectedProduct[] = (persistedState?.dianxiaomiCollectedProducts ?? []).slice(0, 50)
// Declared here (ahead of the work-item readiness rebuild below) because
// refreshDianxiaomiWorkItemReadiness runs during this top-level evaluation and
// reaches isPlaceholderDianxiaomiCategory, which reads this Set. Leaving it at
// its original position (further down the module) put it in the temporal dead
// zone and crashed server startup once persisted work items existed.
const DIANXIAOMI_PLACEHOLDER_CATEGORY_LABELS = new Set([
  "dianxiaomi account scan",
  "dianxiaomi collected",
  "dianxiaomi product requiring edits",
  "dianxiaomi product edit",
  "dianxiaomi product"
])
const dianxiaomiProductWorkItems = new Map<string, DianxiaomiProductWorkItem>(
  (persistedState?.dianxiaomiProductWorkItems ?? []).map((item): [string, DianxiaomiProductWorkItem] => {
    const normalized = refreshDianxiaomiWorkItemReadiness(withDianxiaomiRepairActionGate(item))
    return [normalized.id, normalized]
  })
)
const dianxiaomiProductWorkItemIdByPageUrl = new Map<string, string>(
  Array.from(dianxiaomiProductWorkItems.values()).map((item) => [normalizeDianxiaomiPageUrl(item.pageUrl), item.id])
)
let dianxiaomiPageContext: DianxiaomiPageContext | null = persistedState?.dianxiaomiPageContext ?? null
let lastSyncedReportId: string | null = null

export const persistPlannerState = () => {
  const persistedTaskIds = new Set(persistedState?.tasks.map((task) => task.id) ?? [])
  const persistedTaskList = Array.from(taskStore.values()).filter((task) =>
    task.product.source === "csv" || task.product.source === "manual" || task.product.source === "dianxiaomi" || persistedTaskIds.has(task.id)
  )
  const persistedProductIds = new Set(persistedTaskList.map((task) => task.product.id))

  savePlannerState({
    products: Array.from(productStore.values()).filter((product) =>
      product.source === "csv" || product.source === "manual" || product.source === "dianxiaomi" || persistedProductIds.has(product.id)
    ),
    tasks: persistedTaskList,
    dianxiaomiCollectedProducts,
    dianxiaomiProductWorkItems: Array.from(dianxiaomiProductWorkItems.values()),
    dianxiaomiPageContext,
    dianxiaomiRequirementRules,
    activeTaskId,
    pricingRules
  })
}

const DIANXIAOMI_TASK_META_ATTRIBUTE_KEYS = new Set([
  "dianxiaomiWorkItemId",
  "dianxiaomiPageUrl",
  "dianxiaomiRequirementPreset",
  "dianxiaomiCollectedProductId",
  "dianxiaomiCategoryId",
  "dianxiaomiFullCid",
  "dianxiaomiCategoryLabel",
  "dianxiaomiCategoryHintSource",
  "dianxiaomiCategoryMissing"
])

const DIANXIAOMI_DEFAULT_DECLARED_PRICE_USD = 999
const DIANXIAOMI_DEFAULT_STOCK = 20

const isSyntheticDianxiaomiDraftAttributeKey = (key: string) =>
  DIANXIAOMI_TASK_META_ATTRIBUTE_KEYS.has(key) || key.startsWith("dxm-")

const withoutDianxiaomiTaskMetaAttributes = (attributes: Record<string, string> | undefined) =>
  Object.fromEntries(
    Object.entries(attributes ?? {}).filter(([key]) => !isSyntheticDianxiaomiDraftAttributeKey(key))
  )

const getDianxiaomiCollectedProduct = (id: string | undefined) =>
  id ? dianxiaomiCollectedProducts.find((item) => item.id === id) ?? null : null

function normalizeCategoryLabel(value?: string | null) {
  return value?.trim() || undefined
}

function isPlaceholderDianxiaomiCategory(value?: string | null) {
  const normalized = normalizeCategoryLabel(value)?.toLowerCase()
  return !normalized || DIANXIAOMI_PLACEHOLDER_CATEGORY_LABELS.has(normalized)
}

function resolveDianxiaomiWorkItemCategoryLabel(workItem: DianxiaomiProductWorkItem) {
  const collected = getDianxiaomiCollectedProduct(workItem.collectedProductId)
  if (collected && !isPlaceholderDianxiaomiCategory(collected.category)) {
    return normalizeCategoryLabel(collected.category)
  }
  if (!isPlaceholderDianxiaomiCategory(workItem.categoryHint?.label)) {
    return normalizeCategoryLabel(workItem.categoryHint?.label)
  }
  return undefined
}

function hasResolvableDianxiaomiCategoryHint(workItem: Pick<DianxiaomiProductWorkItem, "categoryHint" | "collectedProductId">) {
  return Boolean(
    resolveDianxiaomiWorkItemCategoryLabel(workItem as DianxiaomiProductWorkItem)
    || workItem.categoryHint?.categoryId?.trim()
    || workItem.categoryHint?.fullCid?.trim()
  )
}

function buildDianxiaomiCategoryTaskAttributes(workItem: DianxiaomiProductWorkItem) {
  return {
  ...(workItem.categoryHint?.categoryId ? { dianxiaomiCategoryId: workItem.categoryHint.categoryId } : {}),
  ...(workItem.categoryHint?.fullCid ? { dianxiaomiFullCid: workItem.categoryHint.fullCid } : {}),
  ...(workItem.categoryHint?.label ? { dianxiaomiCategoryLabel: workItem.categoryHint.label } : {}),
  ...(workItem.categoryHint?.source ? { dianxiaomiCategoryHintSource: workItem.categoryHint.source } : {}),
  ...(hasResolvableDianxiaomiCategoryHint(workItem) ? {} : { dianxiaomiCategoryMissing: "true" })
  }
}

const normalizeCollectedAttributeLookupKey = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, "")

const collectedAttributeAliasGroups = [
  ["color", "颜色", "顏色"],
  ["size", "尺码", "尺寸", "規格", "规格"],
  ["material", "材质", "材料"],
  ["brand", "品牌"]
]

const lookupKeysForCollectedAttributeTarget = (target: string) => {
  const normalizedTarget = normalizeCollectedAttributeLookupKey(target)
  if (!normalizedTarget) {
    return new Set<string>()
  }

  const aliasGroup = collectedAttributeAliasGroups.find((group) =>
    group.some((item) => normalizeCollectedAttributeLookupKey(item) === normalizedTarget)
  )

  return new Set(
    aliasGroup
      ? aliasGroup.map(normalizeCollectedAttributeLookupKey)
      : [normalizedTarget]
  )
}

const getKnownCollectedAttributeValue = (
  item: Pick<DianxiaomiProductWorkItem, "collectedProductId">,
  target: string | undefined
) => {
  const collected = getDianxiaomiCollectedProduct(item.collectedProductId)
  if (!collected || !target?.trim()) {
    return null
  }

  const lookupKeys = lookupKeysForCollectedAttributeTarget(target)
  if (lookupKeys.size === 0) {
    return null
  }

  for (const [key, value] of Object.entries(withoutDianxiaomiTaskMetaAttributes(collected.attributes))) {
    if (lookupKeys.has(normalizeCollectedAttributeLookupKey(key)) && value.trim()) {
      return value.trim()
    }
  }

  return null
}

const publishValidationAutomationForTarget = (
  item: Pick<DianxiaomiProductWorkItem, "collectedProductId" | "title">,
  field: DianxiaomiProductSuggestedEdit["field"],
  target?: string
): DianxiaomiProductRepairAction["automation"] => {
  if (field === "image") {
    return "assisted"
  }

  return hasKnownCollectedRepairValue(item, field, target) ? "auto" : "assisted"
}

const withPublishValidationExpectedValue = (
  item: Pick<DianxiaomiProductWorkItem, "collectedProductId" | "title">,
  field: DianxiaomiProductSuggestedEdit["field"],
  target: string | undefined,
  payload: NonNullable<DianxiaomiProductRepairAction["payload"]>
) => {
  if (field !== "attribute") {
    return payload
  }

  const expectedValue = getKnownCollectedAttributeValue(item, target)
  return expectedValue
    ? {
        ...payload,
        expectedValue
      }
    : payload
}

const hasKnownCollectedRepairValue = (
  item: Pick<DianxiaomiProductWorkItem, "collectedProductId" | "title">,
  field: DianxiaomiProductSuggestedEdit["field"],
  target?: string
) => {
  const collected = getDianxiaomiCollectedProduct(item.collectedProductId)
  if (!collected) {
    return false
  }

  if (field === "attribute") {
    return Boolean(getKnownCollectedAttributeValue(item, target))
  }

  if (field === "title") {
    return Boolean((collected.title || item.title).trim())
  }

  if (field === "price") {
    return collected.skus.some((sku) => typeof sku.priceCny === "number" && sku.priceCny > 0)
  }

  if (field === "stock") {
    return collected.skus.some((sku) => typeof sku.stock === "number")
  }

  if (field === "sku") {
    return collected.skus.length > 0
      && collected.skus.some((sku) => (typeof sku.priceCny === "number" && sku.priceCny > 0) || typeof sku.stock === "number")
  }

  return false
}

const stepStatusFromReport = (reportStatus: AutomationExecutionReport["status"]) => reportStatus === "failed" ? "failed" : "done"

const taskStatusFromReport = (report: AutomationExecutionReport): PublishTask["status"] => {
  if (report.status === "failed") {
    return "failed"
  }

  if (report.steps.some((step) => step.id === "review-hold")) {
    return "reviewing"
  }

  if (report.status === "partial") {
    return "executing"
  }

  return "completed"
}

const syncTaskWithReport = (report: AutomationExecutionReport) => {
  const task = taskStore.get(report.taskId)
  if (!task) {
    return
  }

  const reportStepByTarget = new Map(report.steps.map((step) => [step.id, step]))
  const updatedSteps = task.steps.map((step) => {
    const matchedReportStep = reportStepByTarget.get(step.id)
      ?? reportStepByTarget.get(`fill-${step.targetField}`)

    if (!matchedReportStep) {
      return step
    }

    return {
      ...step,
      status: matchedReportStep.status === "skipped"
        ? step.status
        : stepStatusFromReport(matchedReportStep.status === "failed" ? "failed" : "completed")
    }
  })

  taskStore.set(task.id, {
    ...task,
    steps: updatedSteps,
    status: taskStatusFromReport(report),
    updatedAt: report.createdAt
  })
  persistPlannerState()
}

const syncTasksWithReports = () => {
  const reports = listAutomationReports(50)
  const latestReport = reports[0]

  if (!latestReport || latestReport.id === lastSyncedReportId) {
    return
  }

  reports.slice().reverse().forEach(syncTaskWithReport)
  lastSyncedReportId = latestReport.id
}

export const listTasks = () => {
  syncTasksWithReports()
  return Array.from(taskStore.values())
}

export const getTaskById = (taskId: string) => {
  syncTasksWithReports()
  return taskStore.get(taskId) ?? null
}

// P1-4: find an existing task for a Dianxiaomi work item WITHOUT creating one.
// Tasks store the originating work item id in
// `product.attributes.dianxiaomiWorkItemId`. Returns null when no task has
// been created yet (so the pricing-refresh pass stays read-only and never
// mutates / re-touches work items that have no task).
export const findTaskByDianxiaomiWorkItemId = (workItemId: string): PublishTask | null => {
  if (!workItemId) {
    return null
  }
  for (const task of taskStore.values()) {
    if (task.product.attributes.dianxiaomiWorkItemId === workItemId) {
      return task
    }
  }
  return null
}

export const getActiveTask = (options: { requireApproved?: boolean } = {}) => {
  const task = activeTaskId ? getTaskById(activeTaskId) : null
  if (!task) {
    return null
  }

  if (options.requireApproved && task.status !== "approved") {
    return null
  }

  if (options.requireApproved && !getPublishCheck(task.id)?.canPublish) {
    return null
  }

  return task
}

export const setActiveTask = (taskId: string) => {
  const task = getTaskById(taskId)
  if (!task) {
    return {
      task: null,
      error: "task not found"
    }
  }

  const publishCheck = getPublishCheck(taskId)
  if (!publishCheck?.canPublish) {
    return {
      task: null,
      error: publishCheck?.issues.map((issue) => issue.message).join(" / ") || "publish preflight failed"
    }
  }

  activeTaskId = taskId
  persistPlannerState()
  return {
    task,
    error: null
  }
}

export const exportTaskFile = (taskId: string, outputPath?: string): AutomationTaskFileExportResult | null => {
  const task = getTaskById(taskId)
  if (!task) {
    return null
  }

  const repoRoot = getRepoRoot()
  const exportedAt = new Date().toISOString()
  const defaultTaskFile = `.runtime/automation-tasks/${task.id}.json`
  const taskFile = outputPath?.trim() || defaultTaskFile
  const absolutePath = path.isAbsolute(taskFile) ? taskFile : path.join(repoRoot, taskFile)
  const payload = JSON.stringify(task, null, 2)
  const sha256 = createHash("sha256").update(payload).digest("hex")

  mkdirSync(path.dirname(absolutePath), {
    recursive: true
  })
  writeFileSync(absolutePath, payload, "utf8")

  const result: AutomationTaskFileExportResult = {
    exportId: `task-export-${exportedAt.replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`,
    taskId: task.id,
    taskStatus: task.status,
    taskFile: path.isAbsolute(taskFile) ? absolutePath : taskFile.replace(/\\/g, "/"),
    absolutePath,
    exportedAt,
    bytes: Buffer.byteLength(payload, "utf8"),
    sha256,
    launchStatus: getTaskFileLaunchStatus(absolutePath)
  }

  writeTaskExportHistory([result, ...readTaskExportHistory()])
  return result
}

export const listTaskFileExports = (limit = 20): AutomationTaskFileExportResult[] =>
  readTaskExportHistory()
    .sort((left, right) => right.exportedAt.localeCompare(left.exportedAt))
    .slice(0, limit)
    .map(withTaskFileLaunchStatus)

const normalizeTaskFilePath = (value: string) => path.normalize(value).replace(/\\/g, "/").toLowerCase()

const taskFilePathCandidates = (taskFile: string) => {
  const trimmed = taskFile.trim()
  if (!trimmed) {
    return new Set<string>()
  }

  const repoRoot = getRepoRoot()
  const absolutePath = path.isAbsolute(trimmed) ? trimmed : path.join(repoRoot, trimmed)
  const relativePath = path.relative(repoRoot, absolutePath)

  return new Set([
    trimmed,
    trimmed.replace(/\\/g, "/"),
    absolutePath,
    relativePath,
    relativePath.replace(/\\/g, "/")
  ].map(normalizeTaskFilePath))
}

const findTaskFileExportByTaskFile = (taskFile: string): AutomationTaskFileExportResult | null => {
  const candidates = taskFilePathCandidates(taskFile)
  if (candidates.size === 0) {
    return null
  }

  return readTaskExportHistory()
    .sort((left, right) => right.exportedAt.localeCompare(left.exportedAt))
    .find((item) =>
      candidates.has(normalizeTaskFilePath(item.taskFile))
        || candidates.has(normalizeTaskFilePath(item.absolutePath))
    ) ?? null
}

const readTaskFileForLaunchStatus = (taskFile: string): {
  taskFileExists: boolean
  taskFileReadable: boolean
  task: PublishTask | null
  error: string | null
} => {
  const taskFilePath = path.isAbsolute(taskFile) ? taskFile : path.join(getRepoRoot(), taskFile)
  if (!existsSync(taskFilePath)) {
    return {
      taskFileExists: false,
      taskFileReadable: false,
      task: null,
      error: `task file does not exist: ${taskFile}`
    }
  }

  try {
    return {
      taskFileExists: true,
      taskFileReadable: true,
      task: JSON.parse(readFileSync(taskFilePath, "utf8")) as PublishTask,
      error: null
    }
  } catch (error) {
    return {
      taskFileExists: true,
      taskFileReadable: false,
      task: null,
      error: `task file is not readable JSON: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

const getTaskFileLaunchStatus = (taskFile: string): AutomationTaskFileLaunchStatus => {
  const checkedAt = new Date().toISOString()
  const read = readTaskFileForLaunchStatus(taskFile)
  if (read.error) {
    return {
      status: "blocked",
      reason: read.error,
      checkedAt,
      taskFileExists: read.taskFileExists,
      taskFileReadable: read.taskFileReadable,
      dianxiaomiUrlChecks: []
    }
  }

  const task = read.task
  const sourceUrls = [
    task?.product.source === "dianxiaomi" && task.product.sourceUrl
      ? {
          label: "task product source URL",
          url: task.product.sourceUrl
        }
      : null,
    typeof task?.draft.attributes.dianxiaomiPageUrl === "string" && task.draft.attributes.dianxiaomiPageUrl.trim()
      ? {
          label: "task Dianxiaomi page URL",
          url: task.draft.attributes.dianxiaomiPageUrl
        }
      : null
  ].filter((item): item is { label: string; url: string } => Boolean(item))
  const seen = new Set<string>()
  const dianxiaomiUrlChecks = sourceUrls
    .filter((item) => {
      const key = `${item.label}:${item.url.trim().toLowerCase()}`
      if (seen.has(key)) {
        return false
      }

      seen.add(key)
      return true
    })
    .map((item) => {
      const validation = validateDianxiaomiAutomationPageUrl(item.url)
      return {
        ...item,
        valid: validation.valid,
        reason: validation.reason ?? undefined
      }
    })
  const blockedUrl = dianxiaomiUrlChecks.find((item) => !item.valid)
  if (blockedUrl) {
    return {
      status: "blocked",
      reason: `${blockedUrl.label} is not a real Dianxiaomi product edit URL: ${blockedUrl.reason}`,
      checkedAt,
      taskFileExists: read.taskFileExists,
      taskFileReadable: read.taskFileReadable,
      dianxiaomiUrlChecks
    }
  }

  if (dianxiaomiUrlChecks.length === 0) {
    return {
      status: "needs-target-url",
      reason: "task file has no Dianxiaomi page URL; provide a real target URL before launching",
      checkedAt,
      taskFileExists: read.taskFileExists,
      taskFileReadable: read.taskFileReadable,
      dianxiaomiUrlChecks
    }
  }

  return {
    status: "ready",
    reason: "task file has a valid Dianxiaomi product edit URL",
    checkedAt,
    taskFileExists: read.taskFileExists,
    taskFileReadable: read.taskFileReadable,
    dianxiaomiUrlChecks
  }
}

const withTaskFileLaunchStatus = (item: AutomationTaskFileExportResult): AutomationTaskFileExportResult => ({
  ...item,
  launchStatus: getTaskFileLaunchStatus(item.absolutePath || item.taskFile)
})

const formatDiffDisplay = (value: unknown): string => {
  if (value === undefined) {
    return "(missing)"
  }

  if (value === null) {
    return "(null)"
  }

  if (typeof value === "string") {
    return value || "(empty)"
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]"
    }

    if (value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
      return value.map(String).join(" | ")
    }
  }

  return JSON.stringify(value)
}

const normalizeDiffValue = (value: unknown) => JSON.stringify(value ?? null)

const createSnapshotDiffEntry = (
  pathName: string,
  label: string,
  currentValue: unknown,
  snapshotValue: unknown
): AutomationTaskSnapshotDiffEntry => {
  const currentMissing = currentValue === undefined
  const snapshotMissing = snapshotValue === undefined
  const status: AutomationTaskSnapshotDiffEntry["status"] =
    currentMissing && !snapshotMissing ? "removed"
      : !currentMissing && snapshotMissing ? "added"
        : normalizeDiffValue(currentValue) === normalizeDiffValue(snapshotValue) ? "unchanged"
          : "changed"

  return {
    id: pathName.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "root",
    path: pathName,
    label,
    status,
    currentValue,
    snapshotValue,
    currentDisplay: formatDiffDisplay(currentValue),
    snapshotDisplay: formatDiffDisplay(snapshotValue)
  }
}

const readExportedTaskSnapshot = (absolutePath: string): PublishTask | null => {
  if (!existsSync(absolutePath)) {
    return null
  }

  try {
    const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as PublishTask
    return parsed?.id ? parsed : null
  } catch {
    return null
  }
}

const objectKeys = (...items: Array<Record<string, unknown> | undefined>) =>
  Array.from(new Set(items.flatMap((item) => Object.keys(item ?? {})))).sort()

const TASK_FILE_STALE_IGNORED_PATHS = new Set([
  "task.status",
  "task.updatedAt"
])

export const getTaskFileExportDiff = (exportId: string): AutomationTaskSnapshotDiffResult | null => {
  const exportRecord = readTaskExportHistory().find((item) => item.exportId === exportId)
  if (!exportRecord) {
    return null
  }

  const snapshotTask = readExportedTaskSnapshot(exportRecord.absolutePath)
  if (!snapshotTask) {
    return null
  }

  const currentTask = getTaskById(exportRecord.taskId)
  if (!currentTask) {
    return null
  }

  const entries: AutomationTaskSnapshotDiffEntry[] = []
  const addEntry = (pathName: string, label: string, currentValue: unknown, snapshotValue: unknown) => {
    entries.push(createSnapshotDiffEntry(pathName, label, currentValue, snapshotValue))
  }

  addEntry("task.status", "Task status", currentTask.status, snapshotTask.status)
  addEntry("task.updatedAt", "Task updated at", currentTask.updatedAt, snapshotTask.updatedAt)
  addEntry("product.title", "Product title", currentTask.product.title, snapshotTask.product.title)
  addEntry("product.category", "Product category", currentTask.product.category, snapshotTask.product.category)
  addEntry("product.sourceUrl", "Product source URL", currentTask.product.sourceUrl, snapshotTask.product.sourceUrl)
  addEntry("product.supplierPriceCny", "Supplier price CNY", currentTask.product.supplierPriceCny, snapshotTask.product.supplierPriceCny)
  addEntry("product.estimatedDomesticShippingCny", "Domestic shipping CNY", currentTask.product.estimatedDomesticShippingCny, snapshotTask.product.estimatedDomesticShippingCny)
  addEntry("product.estimatedWeightKg", "Estimated weight kg", currentTask.product.estimatedWeightKg, snapshotTask.product.estimatedWeightKg)
  addEntry("product.images", "Product images", currentTask.product.images, snapshotTask.product.images)
  addEntry("pricing.suggestedPriceUsd", "Suggested price USD", currentTask.pricing.suggestedPriceUsd, snapshotTask.pricing.suggestedPriceUsd)
  addEntry("pricing.floorPriceUsd", "Floor price USD", currentTask.pricing.floorPriceUsd, snapshotTask.pricing.floorPriceUsd)
  addEntry("pricing.targetMarginRate", "Target margin rate", currentTask.pricing.targetMarginRate, snapshotTask.pricing.targetMarginRate)
  addEntry("pricing.estimatedLogisticsUsd", "Estimated logistics USD", currentTask.pricing.estimatedLogisticsUsd, snapshotTask.pricing.estimatedLogisticsUsd)
  addEntry("draft.listingTitle", "Listing title", currentTask.draft.listingTitle, snapshotTask.draft.listingTitle)
  addEntry("draft.sellingPoints", "Selling points", currentTask.draft.sellingPoints, snapshotTask.draft.sellingPoints)
  addEntry("draft.description", "Description", currentTask.draft.description, snapshotTask.draft.description)
  addEntry("draft.categoryPath", "Category path", currentTask.draft.categoryPath, snapshotTask.draft.categoryPath)

  objectKeys(currentTask.product.attributes, snapshotTask.product.attributes).forEach((key) => {
    addEntry(`product.attributes.${key}`, `Product attribute: ${key}`, currentTask.product.attributes[key], snapshotTask.product.attributes[key])
  })

  objectKeys(currentTask.draft.attributes, snapshotTask.draft.attributes).forEach((key) => {
    addEntry(`draft.attributes.${key}`, `Draft attribute: ${key}`, currentTask.draft.attributes[key], snapshotTask.draft.attributes[key])
  })

  const currentProductSkus = new Map(currentTask.product.skus.map((sku) => [sku.skuId, sku]))
  const snapshotProductSkus = new Map(snapshotTask.product.skus.map((sku) => [sku.skuId, sku]))
  Array.from(new Set([...currentProductSkus.keys(), ...snapshotProductSkus.keys()])).sort().forEach((skuId) => {
    const currentSku = currentProductSkus.get(skuId)
    const snapshotSku = snapshotProductSkus.get(skuId)
    addEntry(`product.skus.${skuId}.name`, `Product SKU ${skuId} name`, currentSku?.name, snapshotSku?.name)
    addEntry(`product.skus.${skuId}.costCny`, `Product SKU ${skuId} cost CNY`, currentSku?.costCny, snapshotSku?.costCny)
    addEntry(`product.skus.${skuId}.stock`, `Product SKU ${skuId} stock`, currentSku?.stock, snapshotSku?.stock)
    objectKeys(currentSku?.attributes, snapshotSku?.attributes).forEach((key) => {
      addEntry(`product.skus.${skuId}.attributes.${key}`, `Product SKU ${skuId} attribute: ${key}`, currentSku?.attributes[key], snapshotSku?.attributes[key])
    })
  })

  const currentDraftSkus = new Map(currentTask.draft.skuPricing.map((sku) => [sku.skuId, sku]))
  const snapshotDraftSkus = new Map(snapshotTask.draft.skuPricing.map((sku) => [sku.skuId, sku]))
  Array.from(new Set([...currentDraftSkus.keys(), ...snapshotDraftSkus.keys()])).sort().forEach((skuId) => {
    const currentSku = currentDraftSkus.get(skuId)
    const snapshotSku = snapshotDraftSkus.get(skuId)
    addEntry(`draft.skuPricing.${skuId}.skuName`, `Draft SKU ${skuId} name`, currentSku?.skuName, snapshotSku?.skuName)
    addEntry(`draft.skuPricing.${skuId}.salePriceUsd`, `Draft SKU ${skuId} sale price USD`, currentSku?.salePriceUsd, snapshotSku?.salePriceUsd)
    addEntry(`draft.skuPricing.${skuId}.stock`, `Draft SKU ${skuId} stock`, currentSku?.stock, snapshotSku?.stock)
    addEntry(`draft.skuPricing.${skuId}.attributeSummary`, `Draft SKU ${skuId} attribute summary`, currentSku?.attributeSummary, snapshotSku?.attributeSummary)
    objectKeys(currentSku?.attributes, snapshotSku?.attributes).forEach((key) => {
      addEntry(`draft.skuPricing.${skuId}.attributes.${key}`, `Draft SKU ${skuId} attribute: ${key}`, currentSku?.attributes[key], snapshotSku?.attributes[key])
    })
  })

  currentTask.risks.forEach((risk, index) => {
    addEntry(`risks.${risk.id || index}.level`, `Risk ${risk.id || index} level`, risk.level, snapshotTask.risks.find((item) => item.id === risk.id)?.level)
    addEntry(`risks.${risk.id || index}.message`, `Risk ${risk.id || index} message`, risk.message, snapshotTask.risks.find((item) => item.id === risk.id)?.message)
  })
  snapshotTask.risks
    .filter((risk) => !currentTask.risks.some((item) => item.id === risk.id))
    .forEach((risk, index) => {
      addEntry(`risks.removed.${risk.id || index}.level`, `Removed risk ${risk.id || index} level`, undefined, risk.level)
      addEntry(`risks.removed.${risk.id || index}.message`, `Removed risk ${risk.id || index} message`, undefined, risk.message)
    })

  const staleRelevantEntries = entries.filter((entry) =>
    entry.status !== "unchanged" && !TASK_FILE_STALE_IGNORED_PATHS.has(entry.path)
  )
  const summary = {
    totalCount: entries.length,
    changedCount: entries.filter((entry) => entry.status === "changed").length,
    addedCount: entries.filter((entry) => entry.status === "added").length,
    removedCount: entries.filter((entry) => entry.status === "removed").length,
    unchangedCount: entries.filter((entry) => entry.status === "unchanged").length,
    stale: staleRelevantEntries.length > 0
  }

  return {
    checkedAt: new Date().toISOString(),
    export: withTaskFileLaunchStatus(exportRecord),
    currentTask: {
      id: currentTask.id,
      status: currentTask.status,
      updatedAt: currentTask.updatedAt
    },
    snapshotTask: {
      id: snapshotTask.id,
      status: snapshotTask.status,
      updatedAt: snapshotTask.updatedAt
    },
    entries,
    summary
  }
}

export const getTaskFileExportDiffByTaskFile = (taskFile: string): AutomationTaskSnapshotDiffResult | null => {
  const exportRecord = findTaskFileExportByTaskFile(taskFile)
  return exportRecord ? getTaskFileExportDiff(exportRecord.exportId) : null
}

export const getTaskFileExportSnapshotStatus = (taskFile: string | undefined) => {
  const normalizedTaskFile = taskFile?.trim()
  if (!normalizedTaskFile) {
    return {
      tracked: false,
      ready: true,
      stale: false,
      export: null,
      diff: null,
      reason: "no task file provided",
      details: [] as string[]
    }
  }

  const exportRecord = findTaskFileExportByTaskFile(normalizedTaskFile)
  if (!exportRecord) {
    return {
      tracked: false,
      ready: true,
      stale: false,
      export: null,
      diff: null,
      reason: "task file is not tracked in export history",
      details: [] as string[]
    }
  }

  const diff = getTaskFileExportDiff(exportRecord.exportId)
  if (!diff) {
    return {
      tracked: true,
      ready: false,
      stale: true,
      export: exportRecord,
      diff: null,
      reason: "tracked task file snapshot cannot be verified; export the task file again",
      details: [
        `export: ${exportRecord.exportId}`,
        `task file: ${exportRecord.taskFile}`,
        `absolute path: ${exportRecord.absolutePath}`
      ]
    }
  }

  const changedEntries = diff.entries.filter((entry) =>
    entry.status !== "unchanged" && !TASK_FILE_STALE_IGNORED_PATHS.has(entry.path)
  )
  return {
    tracked: true,
    ready: !diff.summary.stale,
    stale: diff.summary.stale,
    export: diff.export,
    diff,
    reason: diff.summary.stale
      ? `task file snapshot is stale: ${changedEntries.length} changed fields`
      : "task file snapshot matches the current task",
    details: changedEntries.slice(0, 6).map((entry) =>
      `${entry.label}: snapshot ${entry.snapshotDisplay} -> current ${entry.currentDisplay}`
    )
  }
}

export const planTaskForProduct = async (productId: string) => {
  const product = productStore.get(productId)
  if (!product) {
    return null
  }

  const previousTask = taskStore.get(`task-${product.id}`)
  const task = await enhanceTaskDraftWithLlm({
    ...buildTaskForProduct(product, previousTask),
    updatedAt: new Date().toISOString()
  })

  taskStore.set(task.id, task)

  if (!activeTaskId || activeTaskId === task.id) {
    activeTaskId = task.id
  }

  persistPlannerState()
  return task
}

export const importCsvProducts = (csvText: string): CsvImportResult => {
  const { products, skippedRows, warnings } = parseProductsFromCsv(csvText)
  const importedTasks: PublishTask[] = []

  products.forEach((product) => {
    productStore.set(product.id, product)

    const task = {
      ...buildTaskForProduct(product, taskStore.get(`task-${product.id}`)),
      status: "planned" as const,
      updatedAt: new Date().toISOString()
    }

    taskStore.set(task.id, task)
    importedTasks.push(task)
  })

  if (importedTasks[0]) {
    activeTaskId = importedTasks[0].id
  }

  persistPlannerState()
  return {
    importedProducts: products.length,
    importedTasks: importedTasks.length,
    skippedRows,
    tasks: importedTasks,
    warnings
  }
}

export const importExcelProducts = async (buffer: Buffer): Promise<CsvImportResult> => {
  return importCsvProducts(await excelBufferToCsv(buffer))
}

export const createManualProductTask = (input: ManualProductInput) => {
  const productId = `manual-${slugify(input.title)}-${Date.now()}`
  const productSkus = createProductSkus(productId, input)
  const productAttributes = mergeAttributes(input.attributes, ...productSkus.map((sku) => sku.attributes))
  const product: ProductCandidate = {
    id: productId,
    source: "manual",
    sourceUrl: input.sourceUrl,
    title: input.title,
    category: input.category,
    supplierPriceCny: input.supplierPriceCny,
    estimatedDomesticShippingCny: input.estimatedDomesticShippingCny,
    estimatedWeightKg: input.estimatedWeightKg,
    images: input.images ?? [],
    attributes: productAttributes,
    skus: productSkus
  }
  const task = {
    ...buildTaskForProduct(product),
    status: "planned" as const,
    updatedAt: new Date().toISOString()
  }

  productStore.set(product.id, product)
  taskStore.set(task.id, task)
  activeTaskId = task.id
  persistPlannerState()
  return task
}

export const saveDianxiaomiCollectedProduct = (input: DianxiaomiCollectedProductInput) => {
  const normalizedId = input.id?.trim()
  const existingIndex = normalizedId
    ? dianxiaomiCollectedProducts.findIndex((item) => item.id === normalizedId)
    : -1
  const collectedProduct: DianxiaomiCollectedProduct = {
    ...input,
    id: normalizedId || `dxm-collected-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    collectedAt: input.collectedAt || new Date().toISOString(),
    quality: input.quality ?? buildCollectedProductQuality(input),
    title: input.title?.trim() || input.pageTitle || "Dianxiaomi collected product",
    category: input.category?.trim() || "Dianxiaomi collected",
    images: Array.from(new Set(input.images ?? [])).slice(0, 20),
    attributes: input.attributes ?? {},
    skus: (input.skus ?? []).slice(0, 100).map((sku, index) => ({
      skuName: sku.skuName?.trim() || `SKU ${index + 1}`,
      priceCny: sku.priceCny,
      stock: sku.stock,
      attributes: sku.attributes ?? {},
      rowText: sku.rowText ?? ""
    })),
    sourceBucket: input.sourceBucket,
    rawTextSample: input.rawTextSample?.slice(0, 2000) ?? "",
    notes: (input.notes ?? []).slice(0, 20)
  }

  if (existingIndex >= 0) {
    dianxiaomiCollectedProducts.splice(existingIndex, 1)
  }
  dianxiaomiCollectedProducts.unshift(collectedProduct)
  dianxiaomiCollectedProducts.splice(50)
  persistPlannerState()
  return collectedProduct
}

export const listDianxiaomiCollectedProducts = (limit = 20) =>
  dianxiaomiCollectedProducts
    .sort((left, right) => right.collectedAt.localeCompare(left.collectedAt))
    .slice(0, limit)

const normalizeDianxiaomiStoreMetricValue = (value?: string | null) => value?.trim() || undefined

const createDianxiaomiStoreMetricNameKey = (storeName?: string) =>
  normalizeDianxiaomiStoreMetricValue(storeName)?.toLowerCase() ?? null

const createDianxiaomiStoreMetricKey = (storeId?: string, storeName?: string) =>
  normalizeDianxiaomiStoreMetricValue(storeId)
    ? `id:${normalizeDianxiaomiStoreMetricValue(storeId)!.toLowerCase()}`
    : createDianxiaomiStoreMetricNameKey(storeName)
      ? `name:${createDianxiaomiStoreMetricNameKey(storeName)}`
      : null

const buildDianxiaomiStoreMetricNameIndex = (
  entries: Array<{
    storeId?: string
    storeName?: string
  }>
) => {
  const nameIndex = new Map<string, Set<string>>()

  for (const entry of entries) {
    const normalizedStoreId = normalizeDianxiaomiStoreMetricValue(entry.storeId)
    const nameKey = createDianxiaomiStoreMetricNameKey(entry.storeName)
    if (!normalizedStoreId || !nameKey) {
      continue
    }

    const ids = nameIndex.get(nameKey) ?? new Set<string>()
    ids.add(normalizedStoreId)
    nameIndex.set(nameKey, ids)
  }

  return nameIndex
}

const resolveDianxiaomiStoreMetricIdentity = (
  nameIndex: Map<string, Set<string>>,
  storeId?: string,
  storeName?: string
) => {
  const normalizedStoreId = normalizeDianxiaomiStoreMetricValue(storeId)
  const normalizedStoreName = normalizeDianxiaomiStoreMetricValue(storeName)
  if (normalizedStoreId) {
    return {
      key: createDianxiaomiStoreMetricKey(normalizedStoreId, normalizedStoreName),
      storeId: normalizedStoreId,
      storeName: normalizedStoreName
    }
  }

  const nameKey = createDianxiaomiStoreMetricNameKey(normalizedStoreName)
  if (!nameKey || !normalizedStoreName) {
    return null
  }

  const matchedStoreIds = nameIndex.get(nameKey)
  if (matchedStoreIds?.size === 1) {
    const [resolvedStoreId] = Array.from(matchedStoreIds)
    return {
      key: createDianxiaomiStoreMetricKey(resolvedStoreId, normalizedStoreName),
      storeId: resolvedStoreId,
      storeName: normalizedStoreName
    }
  }

  return {
    key: createDianxiaomiStoreMetricKey(undefined, normalizedStoreName),
    storeName: normalizedStoreName
  }
}

const createEmptyDianxiaomiStoreMetrics = (storeId?: string, storeName?: string): DianxiaomiStoreMetrics => ({
  storeId,
  storeName,
  workItemCount: 0,
  readyCount: 0,
  collectedCount: 0,
  blockedCount: 0,
  needsRevisionCount: 0,
  editedCount: 0
})

const ensureDianxiaomiStoreMetrics = (
  metricsMap: Map<string, DianxiaomiStoreMetrics>,
  nameIndex: Map<string, Set<string>>,
  storeId?: string,
  storeName?: string
) => {
  const identity = resolveDianxiaomiStoreMetricIdentity(nameIndex, storeId, storeName)
  if (!identity?.key) {
    return null
  }

  const current = metricsMap.get(identity.key) ?? createEmptyDianxiaomiStoreMetrics(identity.storeId, identity.storeName)
  if (!current.storeId && identity.storeId) {
    current.storeId = identity.storeId
  }
  if (!current.storeName && identity.storeName) {
    current.storeName = identity.storeName
  }
  metricsMap.set(identity.key, current)
  return current
}

export const saveDianxiaomiProductWorkItem = (input: DianxiaomiProductWorkItemInput): DianxiaomiProductWorkItem => {
  const now = new Date().toISOString()
  const normalizedPageUrl = normalizeDianxiaomiPageUrl(input.pageUrl)
  // P1-6: dedupe admission. If a caller supplied a dedupeKey, look it up
  // first. When a match exists, prefer its id (instead of the pageUrl id)
  // so we update the original work item rather than create a duplicate.
  const inputDedupeKey = computeDianxiaomiDedupeKey(input)
  const existingIdByDedupeKey = inputDedupeKey
    ? Array.from(dianxiaomiProductWorkItems.values()).find(
        (item) => item.dedupeKey && item.dedupeKey === inputDedupeKey && item.id
      )?.id
    : null
  const existingIdByPageUrl = dianxiaomiProductWorkItemIdByPageUrl.get(normalizedPageUrl)
  const id = existingIdByDedupeKey
    || existingIdByPageUrl
    || input.id?.trim()
    || `dxm-work-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const existing = dianxiaomiProductWorkItems.get(id)
  const normalizedInput = {
    ...input,
    collectedProductId: input.collectedProductId?.trim() || existing?.collectedProductId,
    title: input.title?.trim() || input.pageTitle || "Dianxiaomi product",
    sourceBucket: input.sourceBucket ?? existing?.sourceBucket,
    notes: input.notes ?? [],
    rawTextSample: input.rawTextSample ?? "",
    dedupeKey: inputDedupeKey ?? existing?.dedupeKey,
    snapshot: {
      hasTitle: input.snapshot?.hasTitle ?? Boolean(input.title?.trim()),
      imageCount: input.snapshot?.imageCount ?? 0,
      skuCount: input.snapshot?.skuCount ?? 0,
      priceFieldCount: input.snapshot?.priceFieldCount ?? 0,
      stockFieldCount: input.snapshot?.stockFieldCount ?? 0,
      attributeKeys: input.snapshot?.attributeKeys ?? [],
      imageStats: input.snapshot?.imageStats,
      imageCheck: input.snapshot?.imageCheck ?? existing?.snapshot.imageCheck,
      mediaToolSignals: input.snapshot?.mediaToolSignals ?? [],
      // P1-9: normalize the target language so the snapshot always
      // carries a valid BCP-47 token (defaulting to "en" when missing).
      targetLanguage: normalizeDianxiaomiTargetLanguage(input.snapshot?.targetLanguage ?? existing?.snapshot.targetLanguage)
    }
  }
  // P1-10: pick the store-mode requirement preset from page/profile/text hints
  // so local (500-char title) and full-managed (stock optional) items score
  // against the right rules instead of always using semi-managed defaults.
  const selectedPreset = selectDianxiaomiRequirementPreset({
    pageUrl: input.pageUrl,
    pageProfile: input.pageProfile,
    rawTextSample: normalizedInput.rawTextSample,
    title: normalizedInput.title
  })
  const requirements = buildDianxiaomiWorkRequirements({
    ...normalizedInput,
    category: normalizedInput.categoryHint?.label,
    categoryHint: normalizedInput.categoryHint
  }, selectedPreset)
  const suggestedEdits = input.suggestedEdits?.length
    ? input.suggestedEdits
    : buildDianxiaomiSuggestedEdits(requirements.checks)
  const urlBlockReason = dianxiaomiUrlBlockReason(input.pageUrl)
  const status = urlBlockReason
    ? "blocked"
    : input.status
      ?? (requirements.summary.ready ? "ready-for-automation" : "needs-revision")
  const workItemBase: DianxiaomiProductWorkItem = {
    ...normalizedInput,
    id,
    source: "dianxiaomi",
    queuedAt: input.queuedAt ?? existing?.queuedAt ?? now,
    updatedAt: now,
    sourceBucket: normalizedInput.sourceBucket,
    pageProfile: input.pageProfile ?? existing?.pageProfile,
    categoryHint: {
      label: normalizeCategoryLabel(input.categoryHint?.label ?? existing?.categoryHint?.label),
      categoryId: normalizeCategoryLabel(input.categoryHint?.categoryId ?? existing?.categoryHint?.categoryId),
      fullCid: normalizeCategoryLabel(input.categoryHint?.fullCid ?? existing?.categoryHint?.fullCid),
      source: input.categoryHint?.source ?? existing?.categoryHint?.source
    },
    requirements,
    suggestedEdits: urlBlockReason
      ? [
          ...suggestedEdits,
          {
            id: "edit-page-url-real-dianxiaomi",
            field: "compliance",
            priority: "required",
            reason: urlBlockReason,
            currentValue: input.pageUrl
          }
        ]
      : suggestedEdits,
    status,
    failureDiagnosis: status === "blocked"
      ? input.failureDiagnosis ?? existing?.failureDiagnosis ?? null
      : null,
    publishOutcome: input.publishOutcome ?? existing?.publishOutcome ?? null,
    manualBudgetReleases: input.manualBudgetReleases ?? existing?.manualBudgetReleases ?? []
  }
  const repairPlan = buildDianxiaomiRepairPlan(workItemBase)
  const workItem: DianxiaomiProductWorkItem = withDianxiaomiRepairActionGate({
    ...workItemBase,
    repairPlan
  })

  dianxiaomiProductWorkItems.set(workItem.id, workItem)
  dianxiaomiProductWorkItemIdByPageUrl.set(normalizedPageUrl, workItem.id)
  persistPlannerState()
  return workItem
}

const createProductFromDianxiaomiCollectedProduct = (
  collected: DianxiaomiCollectedProduct,
  overrides?: {
    sourceUrl?: string
    taskAttributes?: Record<string, string>
  }
): ProductCandidate => {
  const fallbackPrice = collected.skus.find((sku) => typeof sku.priceCny === "number")?.priceCny ?? 0
  const fallbackStock = collected.skus.reduce((total, sku) => total + Math.max(0, Math.floor(sku.stock ?? 0)), 0)
  const productId = `dxm-${slugify(collected.title)}-${Date.now()}`
  const baseAttributes = withoutDianxiaomiTaskMetaAttributes(collected.attributes)
  const productSkus = createProductSkus(productId, {
    supplierPriceCny: fallbackPrice,
    stock: fallbackStock,
    skuName: collected.skus[0]?.skuName,
    attributes: baseAttributes,
    skus: collected.skus.length > 0
      ? collected.skus.map((sku, index) => ({
          skuId: `${productId}-${slugify(sku.skuName) || `sku-${index + 1}`}`,
          skuName: sku.skuName,
          costCny: sku.priceCny ?? fallbackPrice,
          stock: sku.stock ?? 0,
          attributes: {
            ...baseAttributes,
            ...withoutDianxiaomiTaskMetaAttributes(sku.attributes)
          }
        }))
      : undefined
  })

  return {
    id: productId,
    source: "dianxiaomi",
    sourceUrl: overrides?.sourceUrl || collected.sourceUrl || collected.pageUrl,
    title: collected.title,
    category: collected.category,
    supplierPriceCny: fallbackPrice,
    estimatedDomesticShippingCny: 0,
    estimatedWeightKg: 0.2,
    images: collected.images,
    attributes: mergeAttributes(baseAttributes, ...productSkus.map((sku) => sku.attributes), overrides?.taskAttributes),
    skus: productSkus
  }
}

const normalizeDianxiaomiWorkScopeValue = (value?: string | null) => value?.trim() || undefined

const matchesDianxiaomiProductWorkStoreScope = (
  item: Pick<DianxiaomiProductWorkItem, "storeId" | "storeName">,
  input: Pick<AutomationDryRunStartInput, "storeId" | "storeName"> = {}
) => {
  const requestedStoreId = normalizeDianxiaomiWorkScopeValue(input.storeId)
  const requestedStoreName = normalizeDianxiaomiWorkScopeValue(input.storeName)
  if (!requestedStoreId && !requestedStoreName) {
    return true
  }

  const itemStoreId = normalizeDianxiaomiWorkScopeValue(item.storeId)
  const itemStoreName = normalizeDianxiaomiWorkScopeValue(item.storeName)
  if (requestedStoreId) {
    return itemStoreId === requestedStoreId
  }

  return itemStoreName === requestedStoreName
}

export const listDianxiaomiProductWorkItems = (
  limit = 20,
  input: Pick<AutomationDryRunStartInput, "storeId" | "storeName" | "itemUrls" | "sourceBuckets"> = {}
) =>
  Array.from(dianxiaomiProductWorkItems.values())
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .filter((item) =>
      matchesDianxiaomiProductWorkStoreScope(item, input)
      && matchesAutomationItemScope(item, input)
    )
    .slice(0, limit)

export const listDianxiaomiStoreMetrics = (): DianxiaomiStoreMetrics[] => {
  const metricsMap = new Map<string, DianxiaomiStoreMetrics>()
  const storeNameIndex = buildDianxiaomiStoreMetricNameIndex([
    ...Array.from(dianxiaomiProductWorkItems.values()).map((item) => ({
      storeId: item.storeId,
      storeName: item.storeName
    })),
    ...dianxiaomiCollectedProducts.map((item) => ({
      storeId: item.storeId,
      storeName: item.storeName
    })),
    ...(dianxiaomiPageContext?.availableStores ?? []),
    {
      storeId: dianxiaomiPageContext?.storeId,
      storeName: dianxiaomiPageContext?.storeName
    }
  ])

  for (const item of dianxiaomiProductWorkItems.values()) {
    const metrics = ensureDianxiaomiStoreMetrics(metricsMap, storeNameIndex, item.storeId, item.storeName)
    if (!metrics) {
      continue
    }

    metrics.workItemCount += 1
    if (item.status === "ready-for-automation") {
      metrics.readyCount += 1
    } else if (item.status === "blocked") {
      metrics.blockedCount += 1
    } else if (item.status === "needs-revision") {
      metrics.needsRevisionCount += 1
    } else if (item.status === "edited") {
      metrics.editedCount += 1
    }
  }

  for (const item of dianxiaomiCollectedProducts) {
    const metrics = ensureDianxiaomiStoreMetrics(metricsMap, storeNameIndex, item.storeId, item.storeName)
    if (!metrics) {
      continue
    }

    metrics.collectedCount += 1
  }

  for (const store of dianxiaomiPageContext?.availableStores ?? []) {
    ensureDianxiaomiStoreMetrics(metricsMap, storeNameIndex, store.storeId, store.storeName)
  }

  ensureDianxiaomiStoreMetrics(metricsMap, storeNameIndex, dianxiaomiPageContext?.storeId, dianxiaomiPageContext?.storeName)

  return Array.from(metricsMap.values())
    .sort((left, right) => (left.storeName ?? left.storeId ?? "").localeCompare(right.storeName ?? right.storeId ?? "", "zh-CN"))
}

export const getDianxiaomiPageContext = () => dianxiaomiPageContext

export const saveDianxiaomiPageContext = (input: Omit<DianxiaomiPageContext, "updatedAt"> & Partial<Pick<DianxiaomiPageContext, "updatedAt">>) => {
  const normalizedStoreId = input.storeId?.trim() || undefined
  const normalizedStoreName = input.storeName?.trim() || undefined
  const normalizedAvailableStoreEntries = (input.availableStores ?? [])
    .map((item) => ({
      storeId: item.storeId?.trim() || undefined,
      storeName: item.storeName?.trim() || ""
    }))
    .filter((item) => item.storeName)
  const availableStoreNameIndex = buildDianxiaomiStoreMetricNameIndex(normalizedAvailableStoreEntries)
  const normalizedAvailableStores = Array.from(
    normalizedAvailableStoreEntries.reduce((storeMap, item) => {
      const identity = resolveDianxiaomiStoreMetricIdentity(availableStoreNameIndex, item.storeId, item.storeName)
      if (!identity?.key || !identity.storeName) {
        return storeMap
      }

      const current = storeMap.get(identity.key)
      const nextStore = {
        storeId: identity.storeId,
        storeName: identity.storeName
      }
      if (!current || (!current.storeId && nextStore.storeId)) {
        storeMap.set(identity.key, nextStore)
      }
      return storeMap
    }, new Map<string, { storeId?: string; storeName: string }>())
      .values()
  )
  const normalizedSiteName = input.siteName?.trim() || undefined
  const normalizedPageUrl = input.pageUrl?.trim()

  if (!normalizedPageUrl) {
    throw new Error("dianxiaomi page context pageUrl is required")
  }

  dianxiaomiPageContext = {
    storeId: normalizedStoreId,
    storeName: normalizedStoreName,
    availableStores: normalizedAvailableStores,
    siteName: normalizedSiteName,
    pageUrl: normalizedPageUrl,
    pageTitle: input.pageTitle?.trim() || undefined,
    pageProfile: input.pageProfile?.trim() || undefined,
    updatedAt: input.updatedAt?.trim() || new Date().toISOString()
  }

  persistPlannerState()
  return dianxiaomiPageContext
}

export const getDianxiaomiProductWorkQueueSummary = () => {
  const items = Array.from(dianxiaomiProductWorkItems.values())
  return {
    total: items.length,
    ready: items.filter((item) => item.status === "ready-for-automation").length,
    blocked: items.filter((item) => item.status === "blocked").length,
    edited: items.filter((item) => item.status === "edited").length,
    needsRevision: items.filter((item) => item.status === "needs-revision").length
  }
}

export const getDianxiaomiProductWorkItem = (id: string) =>
  dianxiaomiProductWorkItems.get(id) ?? null

export const mergeDianxiaomiProductWorkItemSnapshot = (
  id: string,
  snapshotPatch: Partial<DianxiaomiProductWorkItem["snapshot"]>,
  note?: string
): DianxiaomiProductWorkItem | null => {
  const current = getDianxiaomiProductWorkItem(id)
  if (!current) {
    return null
  }

  const mergedSnapshot: DianxiaomiProductWorkItem["snapshot"] = {
    ...current.snapshot,
    hasTitle: snapshotPatch.hasTitle ?? current.snapshot.hasTitle,
    imageCount: snapshotPatch.imageCount ?? current.snapshot.imageCount,
    skuCount: snapshotPatch.skuCount ?? current.snapshot.skuCount,
    priceFieldCount: snapshotPatch.priceFieldCount ?? current.snapshot.priceFieldCount,
    stockFieldCount: snapshotPatch.stockFieldCount ?? current.snapshot.stockFieldCount,
    attributeKeys: snapshotPatch.attributeKeys ?? current.snapshot.attributeKeys,
    imageStats: snapshotPatch.imageStats ?? current.snapshot.imageStats,
    imageCheck: snapshotPatch.imageCheck ?? current.snapshot.imageCheck,
    mediaToolSignals: normalizeStringList([
      ...(current.snapshot.mediaToolSignals ?? []),
      ...(snapshotPatch.mediaToolSignals ?? [])
    ]),
    targetLanguage: normalizeDianxiaomiTargetLanguage(snapshotPatch.targetLanguage ?? current.snapshot.targetLanguage)
  }

  const selectedPreset = selectDianxiaomiRequirementPreset({
    pageUrl: current.pageUrl,
    pageProfile: current.pageProfile,
    rawTextSample: current.rawTextSample,
    title: current.title
  })
  const requirements = buildDianxiaomiWorkRequirements({
    ...current,
    snapshot: mergedSnapshot,
    category: current.categoryHint?.label,
    categoryHint: current.categoryHint
  }, selectedPreset)
  const suggestedEdits = buildDianxiaomiSuggestedEdits(requirements.checks)
  const urlBlockReason = dianxiaomiUrlBlockReason(current.pageUrl)
  const mergedStatus = urlBlockReason
    ? "blocked"
    : current.status === "blocked" || current.status === "edited"
      ? current.status
      : requirements.summary.ready ? "ready-for-automation" : "needs-revision"
  const updatedBase: DianxiaomiProductWorkItem = {
    ...current,
    status: mergedStatus,
    updatedAt: new Date().toISOString(),
    snapshot: mergedSnapshot,
    requirements,
    suggestedEdits: urlBlockReason
      ? [
          ...suggestedEdits,
          {
            id: "edit-page-url-real-dianxiaomi",
            field: "compliance",
            priority: "required",
            reason: urlBlockReason,
            currentValue: current.pageUrl
          }
        ]
      : suggestedEdits,
    notes: note ? [...current.notes, note] : current.notes
  }
  const repairPlan = buildDianxiaomiRepairPlan(updatedBase)
  const updated: DianxiaomiProductWorkItem = withDianxiaomiRepairActionGate({
    ...updatedBase,
    repairPlan
  })

  dianxiaomiProductWorkItems.set(id, updated)
  persistPlannerState()
  return updated
}

export const updateDianxiaomiProductWorkItemStatus = (
  id: string,
  status: DianxiaomiProductWorkItem["status"],
  note?: string,
  failureDiagnosis?: DianxiaomiWorkFailureDiagnosis | null,
  publishOutcome?: DianxiaomiPublishOutcome | null
): DianxiaomiProductWorkItem | null => {
  const current = getDianxiaomiProductWorkItem(id)
  if (!current) {
    return null
  }

  const updatedAt = new Date().toISOString()
  const manualBudgetRelease = buildManualBudgetRelease(current, status, note, updatedAt)
  const updatedBase: DianxiaomiProductWorkItem = {
    ...current,
    status,
    updatedAt,
    notes: note ? [...current.notes, note] : current.notes,
    failureDiagnosis: status === "blocked"
      ? failureDiagnosis ?? current.failureDiagnosis ?? null
      : null,
    publishOutcome: publishOutcome ?? current.publishOutcome ?? null,
    manualBudgetReleases: manualBudgetRelease
      ? [manualBudgetRelease, ...(current.manualBudgetReleases ?? [])].slice(0, 20)
      : current.manualBudgetReleases ?? []
  }
  const repairPlan = buildDianxiaomiRepairPlan(updatedBase)
  const updated: DianxiaomiProductWorkItem = withDianxiaomiRepairActionGate({
    ...updatedBase,
    repairPlan
  })
  dianxiaomiProductWorkItems.set(id, updated)
  persistPlannerState()
  return updated
}

const retryAfterFixAllowedCategories = new Set<DianxiaomiWorkFailureDiagnosis["category"]>([
  "media-processing",
  "publish-validation",
  "browser-profile",
  "task-file"
])

const getDianxiaomiRetryAfterFixBlockReason = (item: DianxiaomiProductWorkItem) => {
  if (item.status !== "blocked") {
    return "work item is not blocked"
  }

  const urlValidation = validateDianxiaomiAutomationPageUrl(item.pageUrl)
  if (!urlValidation.valid) {
    return urlValidation.reason ?? "work item URL is not a valid Dianxiaomi listing edit page"
  }

  if (!item.requirements.summary.ready) {
    return "work item still fails required listing checks"
  }

  if (!item.failureDiagnosis) {
    return "blocked work item has no structured failure diagnosis"
  }

  if (!item.failureDiagnosis.retryable && !item.failureDiagnosis.autoRetryRecommended) {
    return `${item.failureDiagnosis.category} is not marked retryable`
  }

  if (!retryAfterFixAllowedCategories.has(item.failureDiagnosis.category)) {
    return `${item.failureDiagnosis.category} must be resolved outside the product retry flow`
  }

  return null
}

export const getDianxiaomiProductWorkItemRetryAfterFixReadiness = (id: string) => {
  const item = getDianxiaomiProductWorkItem(id)
  if (!item) {
    return {
      item: null,
      ready: false,
      reason: "dianxiaomi product work item not found"
    }
  }

  const reason = getDianxiaomiRetryAfterFixBlockReason(item)
  return {
    item,
    ready: !reason,
    reason: reason ?? "work item can be retried after fix"
  }
}

export const requeueDianxiaomiProductWorkItemAfterFix = (id: string): DianxiaomiProductWorkItemRetryAfterFixResult | null => {
  const readiness = getDianxiaomiProductWorkItemRetryAfterFixReadiness(id)
  if (!readiness.item) {
    return null
  }

  if (!readiness.ready) {
    return {
      workItem: readiness.item,
      requeued: false,
      reason: readiness.reason
    }
  }

  const updated = updateDianxiaomiProductWorkItemStatus(
    id,
    "ready-for-automation",
    `retry after fix released: ${readiness.item.failureDiagnosis?.category ?? "unknown"}`
  )

  return {
    workItem: updated ?? readiness.item,
    requeued: Boolean(updated),
    reason: "work item moved back to ready-for-automation"
  }
}

const createPlaceholderProductFromWorkItem = (workItem: DianxiaomiProductWorkItem): ProductCandidate => {
  const productId = `dxm-work-${slugify(workItem.title)}-${Date.now()}`
  const categoryLabel = resolveDianxiaomiWorkItemCategoryLabel(workItem) || "Temu category pending selection"
  return {
    id: productId,
    source: "dianxiaomi",
    sourceUrl: workItem.pageUrl,
    title: workItem.title,
    category: categoryLabel,
    supplierPriceCny: 0,
    estimatedDomesticShippingCny: 0,
    estimatedWeightKg: 0.2,
    images: [],
    attributes: {
      ...Object.fromEntries(workItem.snapshot.attributeKeys.map((key) => [key, ""])),
      dianxiaomiWorkItemId: workItem.id,
      dianxiaomiPageUrl: workItem.pageUrl,
      dianxiaomiRequirementPreset: workItem.requirements.presetName,
      ...buildDianxiaomiCategoryTaskAttributes(workItem),
      ...(workItem.collectedProductId ? { dianxiaomiCollectedProductId: workItem.collectedProductId } : {})
    },
    skus: Array.from({ length: Math.max(1, workItem.snapshot.skuCount) }, (_item, index) => ({
      skuId: `${productId}-sku-${index + 1}`,
      name: workItem.snapshot.skuCount > 1 ? `Dianxiaomi SKU ${index + 1}` : "Dianxiaomi SKU",
      costCny: 0,
      stock: 0,
      attributes: {}
    }))
  }
}

const createProductFromWorkItem = (workItem: DianxiaomiProductWorkItem): ProductCandidate => {
  const taskAttributes = {
    dianxiaomiWorkItemId: workItem.id,
    dianxiaomiPageUrl: workItem.pageUrl,
    dianxiaomiRequirementPreset: workItem.requirements.presetName,
    ...buildDianxiaomiCategoryTaskAttributes(workItem),
    ...(workItem.collectedProductId ? { dianxiaomiCollectedProductId: workItem.collectedProductId } : {})
  }
  const collected = getDianxiaomiCollectedProduct(workItem.collectedProductId)
  if (!collected) {
    return createPlaceholderProductFromWorkItem(workItem)
  }

  return createProductFromDianxiaomiCollectedProduct(collected, {
    sourceUrl: workItem.pageUrl,
    taskAttributes
  })
}

const writeRepairPreviewFile = (
  workItem: DianxiaomiProductWorkItem,
  repairPlan: DianxiaomiProductRepairPlan
) => {
  const repoRoot = getRepoRoot()
  const exportedAt = new Date().toISOString()
  const repairPlanFile = `.runtime/repair-plans/${workItem.id}.json`
  const absoluteRepairPlanFile = path.join(repoRoot, repairPlanFile)
  const payload: DianxiaomiRepairPreviewFile = {
    workItemId: workItem.id,
    pageUrl: workItem.pageUrl,
    pageTitle: workItem.pageTitle,
    exportedAt,
    repairPlan
  }

  mkdirSync(path.dirname(absoluteRepairPlanFile), {
    recursive: true
  })
  writeFileSync(absoluteRepairPlanFile, JSON.stringify(payload, null, 2), "utf8")

  return {
    repairPlanFile,
    absoluteRepairPlanFile,
    exportedAt
  }
}

export const createTaskFromDianxiaomiProductWorkItem = (workItemId: string): DianxiaomiProductWorkItemTaskResult | null => {
  const workItem = getDianxiaomiProductWorkItem(workItemId)
  if (!workItem) {
    return null
  }

  const updatedTask = buildTaskFromDianxiaomiProductWorkItem(workItem)

  productStore.set(updatedTask.product.id, updatedTask.product)
  taskStore.set(updatedTask.id, updatedTask)
  activeTaskId = updatedTask.id
  dianxiaomiProductWorkItems.set(workItem.id, {
    ...workItem,
    status: workItem.requirements.summary.ready ? "ready-for-automation" : "needs-revision",
    updatedAt: updatedTask.updatedAt,
    failureDiagnosis: null,
    repairPlan: null
  })
  persistPlannerState()

  return {
    workItem: dianxiaomiProductWorkItems.get(workItem.id) ?? workItem,
    task: updatedTask
  }
}

const buildTaskFromDianxiaomiProductWorkItem = (workItem: DianxiaomiProductWorkItem): PublishTask => {
  const product = createProductFromWorkItem(workItem)
  const task = buildTaskForProduct(product)
  const categoryLabel = resolveDianxiaomiWorkItemCategoryLabel(workItem)
  const draftAttributes = {
    ...withoutDianxiaomiTaskMetaAttributes(product.attributes),
    dianxiaomiWorkItemId: workItem.id,
    dianxiaomiPageUrl: workItem.pageUrl,
    dianxiaomiRequirementPreset: workItem.requirements.presetName,
    ...buildDianxiaomiCategoryTaskAttributes(workItem),
    ...(workItem.collectedProductId ? { dianxiaomiCollectedProductId: workItem.collectedProductId } : {})
  }
  const productSkuById = new Map(product.skus.map((sku) => [sku.skuId, sku]))
  const updatedTask: PublishTask = {
    ...task,
    draft: {
      ...task.draft,
      description: sanitizeMarketplaceEnglishText([
        task.draft.description,
        "Dianxiaomi source item needs requirement-based edits before Temu listing.",
        ...workItem.suggestedEdits.slice(0, 6).map((edit) => `${edit.field}: ${edit.suggestedValue || edit.reason}`)
      ].filter(Boolean).join("\n\n")),
      categoryPath: categoryLabel ? ["Temu", categoryLabel] : [],
      attributes: draftAttributes,
      skuPricing: task.draft.skuPricing.map((sku, index) => {
        const productSku = productSkuById.get(sku.skuId) ?? product.skus[index]
        const skuAttributes = mergeAttributes(
          draftAttributes,
          withoutDianxiaomiTaskMetaAttributes(productSku?.attributes)
        )

        return {
          ...sku,
          salePriceUsd: DIANXIAOMI_DEFAULT_DECLARED_PRICE_USD,
          stock: DIANXIAOMI_DEFAULT_STOCK,
          attributes: skuAttributes,
          attributeSummary: buildAttributeSummary(skuAttributes)
        }
      })
    },
    risks: [
      ...(categoryLabel ? [] : [{
        id: "dxm-missing-category",
        level: "high" as const,
        message: "Dianxiaomi item has no usable Temu category yet; complete category selection before unattended publish."
      }]),
      ...workItem.requirements.checks
        .filter((check) => !check.ok)
        .map((check) => ({
          id: `dxm-${check.id}`,
          level: check.level === "required" ? "high" as const : "medium" as const,
          message: check.recommendation || check.message
        })),
      ...task.risks
    ],
    status: "planned",
    updatedAt: new Date().toISOString()
  }

  return updatedTask
}

export const exportDianxiaomiRepairPreview = (workItemId: string): DianxiaomiRepairPreviewExportResult | null => {
  const workItem = getDianxiaomiProductWorkItem(workItemId)
  if (!workItem?.repairPlan) {
    return null
  }

  const task = buildTaskFromDianxiaomiProductWorkItem(workItem)
  productStore.set(task.product.id, task.product)
  taskStore.set(task.id, task)
  activeTaskId = task.id
  persistPlannerState()

  const taskExport = exportTaskFile(task.id)
  if (!taskExport) {
    return null
  }

  const repairExport = writeRepairPreviewFile(workItem, workItem.repairPlan)
  return {
    workItem,
    task,
    taskFile: taskExport.taskFile,
    absoluteTaskFile: taskExport.absolutePath,
    repairPlanFile: repairExport.repairPlanFile,
    absoluteRepairPlanFile: repairExport.absoluteRepairPlanFile,
    exportedAt: repairExport.exportedAt
  }
}

export const createTaskFromDianxiaomiCollectedProduct = (collectedProductId: string): DianxiaomiCollectedProductImportResult | null => {
  const collected = getDianxiaomiCollectedProduct(collectedProductId)
  if (!collected) {
    return null
  }

  const product = createProductFromDianxiaomiCollectedProduct(collected)
  const task = {
    ...buildTaskForProduct(product),
    status: "planned" as const,
    updatedAt: new Date().toISOString()
  }

  productStore.set(product.id, product)
  taskStore.set(task.id, task)
  activeTaskId = task.id
  persistPlannerState()
  return {
    product: collected,
    task
  }
}

export const updateTaskProduct = (taskId: string, input: ProductUpdateInput) => {
  const currentTask = getTaskById(taskId)
  if (!currentTask) {
    return null
  }

  const currentProduct = currentTask.product
  const fallbackStock = currentProduct.skus.reduce((total, sku) => total + sku.stock, 0)
  const nextSupplierPrice = input.supplierPriceCny ?? currentProduct.supplierPriceCny
  const nextStock = input.stock ?? fallbackStock
  const skus = input.skus
    ? createProductSkus(currentProduct.id, {
        supplierPriceCny: nextSupplierPrice,
        stock: nextStock,
        skuName: input.skuName ?? currentProduct.skus[0]?.name,
        attributes: input.attributes ?? currentProduct.attributes,
        skus: input.skus
      })
    : currentProduct.skus.map((sku) => ({
        ...sku,
        attributes: input.attributes ? { ...input.attributes, ...sku.attributes } : sku.attributes
      }))
  const attributes = mergeAttributes(input.attributes ?? currentProduct.attributes, ...skus.map((sku) => sku.attributes))
  const product: ProductCandidate = {
    ...currentProduct,
    title: input.title ?? currentProduct.title,
    category: input.category ?? currentProduct.category,
    supplierPriceCny: nextSupplierPrice,
    estimatedDomesticShippingCny: input.estimatedDomesticShippingCny ?? currentProduct.estimatedDomesticShippingCny,
    estimatedWeightKg: input.estimatedWeightKg ?? currentProduct.estimatedWeightKg,
    sourceUrl: input.sourceUrl ?? currentProduct.sourceUrl,
    images: input.images ?? currentProduct.images,
    attributes,
    skus
  }
  const rebuiltTask = buildTaskForProduct(product, currentTask)
  const updatedTask: PublishTask = {
    ...rebuiltTask,
    id: currentTask.id,
    status: currentTask.status === "completed" || currentTask.status === "approved" ? "reviewing" : currentTask.status,
    updatedAt: new Date().toISOString()
  }

  productStore.set(product.id, product)
  taskStore.set(taskId, updatedTask)
  persistPlannerState()
  return updatedTask
}

export const updateTaskDraft = (taskId: string, input: DraftUpdateInput) => {
  const currentTask = getTaskById(taskId)
  if (!currentTask) {
    return null
  }

  const skuUpdates = new Map((input.skuPricing ?? []).map((sku) => [sku.skuId, sku]))
  const draft: ListingDraft = {
    ...currentTask.draft,
    listingTitle: input.listingTitle ?? currentTask.draft.listingTitle,
    sellingPoints: input.sellingPoints ?? currentTask.draft.sellingPoints,
    description: input.description ?? currentTask.draft.description,
    categoryPath: input.categoryPath ?? currentTask.draft.categoryPath,
    attributes: input.attributes ?? currentTask.draft.attributes,
    skuPricing: currentTask.draft.skuPricing.map((sku) => {
      const update = skuUpdates.get(sku.skuId)
      if (!update) {
        return sku
      }

      const attributes = update.attributes ?? sku.attributes
      return {
        ...sku,
        skuName: update.skuName ?? sku.skuName,
        salePriceUsd: update.salePriceUsd ?? sku.salePriceUsd,
        stock: update.stock ?? sku.stock,
        attributes,
        attributeSummary: update.attributeSummary ?? Object.entries(attributes).map(([key, value]) => `${key}: ${value}`).join(" / ")
      }
    })
  }
  const updatedTask: PublishTask = {
    ...currentTask,
    draft,
    draftVersions: appendDraftVersion(currentTask.draftVersions, createDraftVersion("manual", "人工编辑草稿", draft)),
    review: {
      status: "pending",
      note: "",
      reviewedAt: "",
      history: currentTask.review?.history ?? []
    },
    status: currentTask.status === "completed" || currentTask.status === "approved" ? "reviewing" : currentTask.status,
    updatedAt: new Date().toISOString()
  }

  taskStore.set(taskId, updatedTask)
  persistPlannerState()
  return updatedTask
}

export const restoreTaskDraftVersion = (taskId: string, versionId: string) => {
  const currentTask = getTaskById(taskId)
  if (!currentTask) {
    return null
  }

  const version = currentTask.draftVersions?.find((item) => item.id === versionId)
  if (!version) {
    return null
  }

  const updatedTask: PublishTask = {
    ...currentTask,
    draft: version.draft,
    draftVersions: appendDraftVersion(currentTask.draftVersions, createDraftVersion("restore", `恢复：${version.label}`, version.draft)),
    review: {
      status: "pending",
      note: "",
      reviewedAt: "",
      history: currentTask.review?.history ?? []
    },
    status: currentTask.status === "completed" || currentTask.status === "approved" ? "reviewing" : currentTask.status,
    updatedAt: new Date().toISOString()
  }

  taskStore.set(taskId, updatedTask)
  persistPlannerState()
  return updatedTask
}

export const restoreLatestAiDraftVersions = (taskIds: string[]): BatchDraftRestoreResult => {
  const restored: PublishTask[] = []
  const skipped: BatchDraftRestoreResult["skipped"] = []

  taskIds.forEach((taskId) => {
    const task = getTaskById(taskId)
    if (!task) {
      skipped.push({ taskId, reason: "task not found" })
      return
    }

    const version = task.draftVersions?.find((item) => item.source === "ai")
    if (!version) {
      skipped.push({ taskId, reason: "no ai draft version" })
      return
    }

    const restoredTask = restoreTaskDraftVersion(taskId, version.id)
    if (restoredTask) {
      restored.push(restoredTask)
    } else {
      skipped.push({ taskId, reason: "restore failed" })
    }
  })

  return {
    restored,
    skipped
  }
}

export const reviewTask = (taskId: string, decision: ReviewDecision, note = "") => {
  const currentTask = getTaskById(taskId)
  if (!currentTask) {
    return null
  }

  const createdAt = new Date().toISOString()
  const event = {
    decision,
    note,
    createdAt
  }
  const reviewStatus: ReviewState["status"] =
    decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "changes_requested"
  const status: PublishTask["status"] =
    decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "reviewing"
  const updatedTask: PublishTask = {
    ...currentTask,
    review: {
      status: reviewStatus,
      note,
      reviewedAt: createdAt,
      history: [event, ...(currentTask.review?.history ?? [])].slice(0, 50)
    },
    status,
    updatedAt: createdAt
  }

  taskStore.set(taskId, updatedTask)
  persistPlannerState()
  return updatedTask
}

export const reviewTasks = (taskIds: string[], decision: ReviewDecision, note = "") => {
  const updatedTasks: PublishTask[] = []

  taskIds.forEach((taskId) => {
    const task = reviewTask(taskId, decision, note)
    if (task) {
      updatedTasks.push(task)
    }
  })

  return updatedTasks
}

export const getPublishCheck = (taskId: string): PublishCheckResult | null => {
  const task = getTaskById(taskId)
  if (!task) {
    return null
  }
  const dianxiaomiWorkItem = task.product.source === "dianxiaomi"
    ? getDianxiaomiProductWorkItem(task.product.attributes.dianxiaomiWorkItemId ?? "")
    : null

  const baseIssues = [
    task.status !== "approved"
      ? {
          id: "not-approved",
          level: "high" as const,
          message: "任务尚未审核通过"
        }
      : null,
    task.product.source !== "dianxiaomi" && task.product.images.length === 0
      ? {
          id: "missing-images",
          level: "high" as const,
          message: "商品缺少图片链接"
        }
      : null,
    task.draft.listingTitle.trim().length === 0
      ? {
          id: "missing-title",
          level: "high" as const,
          message: "草稿标题为空"
        }
      : null,
    task.draft.sellingPoints.length === 0
      ? {
          id: "missing-selling-points",
          level: "medium" as const,
          message: "草稿卖点为空"
        }
      : null,
    task.draft.skuPricing.some((sku) => sku.salePriceUsd <= 0)
      ? {
          id: "invalid-price",
          level: "high" as const,
          message: "存在无效 SKU 售价"
        }
      : null,
    // P0-A: catch over-long titles for non-Dianxiaomi sources. Dianxiaomi
    // sources already get `title-length` from dianxiaomiRequirementIssues below.
    task.product.source !== "dianxiaomi"
      && task.draft.listingTitle.trim().length > PUBLISH_CHECK_TITLE_MAX_LENGTH_FALLBACK
      ? {
          id: "title-too-long",
          level: "high" as const,
          message: `草稿标题 ${task.draft.listingTitle.trim().length} 字符，超过非店小秘来源上限 ${PUBLISH_CHECK_TITLE_MAX_LENGTH_FALLBACK}`
        }
      : null,
    // P0-A: SKU stock sanity (negative or absurdly large). Catches the silent
    // case where fill-draft wrote a stock that the page silently truncated
    // or where the import pipeline produced a bad number.
    task.draft.skuPricing.some((sku) => sku.stock < 0 || sku.stock > PUBLISH_CHECK_STOCK_MAX)
      ? {
          id: "stock-out-of-range",
          level: "high" as const,
          message: `SKU 库存超出允许范围 [0, ${PUBLISH_CHECK_STOCK_MAX}]`
        }
      : null,
    // P0-A: price floor guard for non-Dianxiaomi sources. Uses the shared
    // defaultPricingRules.minimumSuggestedPriceUsd as the floor.
    task.product.source !== "dianxiaomi"
      && task.draft.skuPricing.some((sku) => sku.salePriceUsd < defaultPricingRules.minimumSuggestedPriceUsd)
      ? {
          id: "price-below-minimum",
          level: "high" as const,
          message: `SKU 售价低于最低售价 $${defaultPricingRules.minimumSuggestedPriceUsd.toFixed(2)}`
        }
      : null
  ].filter((issue): issue is NonNullable<typeof issue> => Boolean(issue))
  const dianxiaomiRequirementIssues = dianxiaomiWorkItem?.requirements.checks
    .filter((check) => !check.ok)
    .map((check) => ({
      id: `dxm-requirement-${check.id}`,
      level: check.level === "required" ? "high" as const : "medium" as const,
      message: check.recommendation || check.message
    })) ?? []
  const issues = [...baseIssues, ...dianxiaomiRequirementIssues]

  return {
    taskId,
    canPublish: issues.every((issue) => issue.level !== "high"),
    issues,
    checkedAt: new Date().toISOString()
  }
}

export const getPublishChecks = (taskIds: string[]) =>
  taskIds
    .map((taskId) => getPublishCheck(taskId))
    .filter((result): result is PublishCheckResult => Boolean(result))

// P1-4: re-derive the listing draft's pricing analysis when the operator
// changed pricing rules (rulesHash mismatch) or when the last computation
// is older than `maxAgeMs`. Returns true when a recompute actually ran.
// The caller is expected to persist the updated task afterwards.
const PRICING_RECOMPUTE_MAX_AGE_MS = 6 * 60 * 60 * 1000 // 6 hours

export const recomputeDraftPricingIfStale = (
  task: PublishTask,
  options: { maxAgeMs?: number; rules?: PricingRules } = {}
): { recomputed: boolean; reason: "rules-changed" | "stale" | "fresh" | "no-pricing" } => {
  const analysis = task.pricing
  if (!analysis) {
    return { recomputed: false, reason: "no-pricing" }
  }
  const rules = options.rules ?? getPricingRules()
  const currentHash = hashPricingRules(rules)
  // P1-4: re-price the draft in place, preserving any operator edits to
  // non-price draft fields (title, selling points, etc.). Only the SKU
  // salePriceUsd values are refreshed from the new suggested price.
  const reprice = (reason: "rules-changed" | "stale") => {
    const updated = calculatePricing(task.product, rules)
    task.pricing = updated
    task.draft = {
      ...task.draft,
      skuPricing: task.draft.skuPricing.map((sku) => ({
        ...sku,
        salePriceUsd: updated.suggestedPriceUsd
      }))
    }
    return { recomputed: true as const, reason }
  }
  if (analysis.rulesHash && analysis.rulesHash !== currentHash) {
    return reprice("rules-changed")
  }
  const maxAgeMs = options.maxAgeMs ?? PRICING_RECOMPUTE_MAX_AGE_MS
  if (analysis.computedAt) {
    const ageMs = Date.now() - new Date(analysis.computedAt).getTime()
    if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
      return reprice("stale")
    }
  }
  return { recomputed: false, reason: "fresh" }
}

export const getPricingRules = () => pricingRules

export const getDianxiaomiRequirementRules = () => dianxiaomiRequirementRules

export const updateDianxiaomiRequirementRules = (rules: DianxiaomiListingRequirementRules) => {
  dianxiaomiRequirementRules = normalizeDianxiaomiRequirementRules(rules)

  Array.from(dianxiaomiProductWorkItems.values()).forEach((item) => {
    dianxiaomiProductWorkItems.set(item.id, rebuildDianxiaomiProductWorkItem(item))
  })

  persistPlannerState()
  return dianxiaomiRequirementRules
}

export const updatePricingRules = (rules: PricingRules) => {
  pricingRules = rules

  Array.from(taskStore.values()).forEach((task) => {
    if (task.status === "planned" || task.status === "queued") {
      const updatedTask = {
        ...buildTaskForProduct(task.product, task),
        status: task.status,
        updatedAt: new Date().toISOString()
      }
      taskStore.set(task.id, updatedTask)
    }
  })

  persistPlannerState()
  return pricingRules
}

export const listDebugSnapshots = () => debugSnapshots

export const saveDebugSnapshot = (snapshot: PageDebugSnapshot) => {
  debugSnapshots.unshift(snapshot)

  if (debugSnapshots.length > 20) {
    debugSnapshots.length = 20
  }

  return snapshot
}

export const listAutomationReports = (limit = 20): AutomationExecutionReport[] => {
  const currentFile = fileURLToPath(import.meta.url)
  const repoRoot = path.resolve(path.dirname(currentFile), "../../..")
  const reportPaths = [
    ...listFilesRecursive(path.join(repoRoot, "output/playwright"), {
      fileNamePattern: /^dianxiaomi-(run|dry-run|repair-preview|error)-.*\.json$/
    }),
    ...listFilesRecursive(path.join(repoRoot, ".runtime/automation-artifacts"), {
      fileNamePattern: /^dianxiaomi-(run|dry-run|repair-preview|error)-.*\.json$/
    })
  ]

  return Array.from(new Set(reportPaths))
    .map((filePath) => JSON.parse(readFileSync(filePath, "utf8")) as AutomationExecutionReport)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit)
}

const DEFAULT_SELECTOR_DIAGNOSIS_CANDIDATE_LIMIT = 200

const listFilesRecursive = (
  directory: string,
  options: {
    limit?: number
    fileNamePattern?: RegExp
  } = {}
): string[] => {
  if (!existsSync(directory)) {
    return []
  }

  const results: string[] = []
  const entries = readdirSync(directory, {
    withFileTypes: true
  }).sort((left, right) => right.name.localeCompare(left.name))

  for (const entry of entries) {
    if (options.limit && results.length >= options.limit) {
      break
    }

    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(entryPath, {
        ...options,
        limit: options.limit ? options.limit - results.length : undefined
      }))
      continue
    }

    if (!options.fileNamePattern || options.fileNamePattern.test(entry.name)) {
      results.push(entryPath)
    }
  }

  return results
}

const listSelectorDiagnosisEntries = (limit = 10): Array<{ filePath: string; report: SelectorDiagnosisReport }> => {
  const currentFile = fileURLToPath(import.meta.url)
  const repoRoot = path.resolve(path.dirname(currentFile), "../../..")
  const configuredReportDirs = (process.env.SELECTOR_DIAGNOSIS_DIRS ?? "")
    .split(path.delimiter)
    .map((directory) => directory.trim())
    .filter(Boolean)
    .map((directory) => path.isAbsolute(directory) ? directory : path.join(repoRoot, directory))
  const reportDirs = configuredReportDirs.length > 0
    ? configuredReportDirs
    : [
      path.join(repoRoot, "output/playwright"),
      path.join(repoRoot, ".runtime/selector-calibration"),
      path.join(repoRoot, ".runtime/playwright")
    ]
  const candidateLimit = configuredReportDirs.length > 0
    ? undefined
    : Math.max(limit * 20, DEFAULT_SELECTOR_DIAGNOSIS_CANDIDATE_LIMIT)

  return reportDirs
    .flatMap((directory) => listFilesRecursive(directory, {
      fileNamePattern: /^dianxiaomi-diagnosis-.*\.json$/,
      limit: candidateLimit
    }))
    .map((filePath) => ({
      filePath,
      report: JSON.parse(readFileSync(filePath, "utf8")) as SelectorDiagnosisReport
    }))
    .sort((left, right) => right.report.createdAt.localeCompare(left.report.createdAt))
    .slice(0, limit)
}

export const listSelectorDiagnosisReports = (limit = 10): SelectorDiagnosisReport[] =>
  listSelectorDiagnosisEntries(limit).map((entry) => entry.report)

const latestSelectorDiagnosisEntry = () =>
  listSelectorDiagnosisEntries(1)[0]

const firstSelector = (report: SelectorDiagnosisReport, group: "fields" | "buttons", key: string) =>
  report[group][key]?.candidates[0]?.selectorHint

const SELECTOR_FIELD_KEYS = ["title", "description", "price", "stock", "attribute"]
const SELECTOR_BUTTON_KEYS = ["save", "submit"]
const SELECTOR_MEDIA_TOOL_KEYS = ["imageTranslation", "whiteBackground", "imageEditor", "batchResize", "imageManagement"]
const SELECTOR_MEDIA_TOOL_ACTION_KEYS = ["apply", "close"]
const REQUIRED_SELECTOR_FIELDS = ["title", "description", "price", "stock"]
const REQUIRED_SELECTOR_BUTTONS = ["save"]

const getSelectorConfigPath = () => {
  const currentFile = fileURLToPath(import.meta.url)
  const repoRoot = path.resolve(path.dirname(currentFile), "../../..")
  return path.join(repoRoot, ".runtime/dianxiaomi-selector-config.json")
}

const resolveSelectorConfigPath = (configPath: string | undefined) => {
  if (!configPath?.trim()) {
    return getSelectorConfigPath()
  }

  const currentFile = fileURLToPath(import.meta.url)
  const repoRoot = path.resolve(path.dirname(currentFile), "../../..")
  const normalizedPath = configPath.trim()
  return path.isAbsolute(normalizedPath) ? normalizedPath : path.join(repoRoot, normalizedPath)
}

const getSelectorConfigVersionDir = () =>
  path.join(path.dirname(getSelectorConfigPath()), "selector-config-versions")

const normalizeSelectorList = (selectors: string[] | undefined) =>
  Array.from(new Set((selectors ?? []).map((selector) => selector.trim()).filter(Boolean)))

const normalizeSelectorConfig = (config: DianxiaomiSelectorConfig): DianxiaomiSelectorConfig => {
  const rawConfig = config as Partial<DianxiaomiSelectorConfig>

  return {
    fields: Object.fromEntries(
      Object.entries(rawConfig.fields ?? {}).map(([key, selectors]) => [key, normalizeSelectorList(selectors)])
    ),
    buttons: Object.fromEntries(
      Object.entries(rawConfig.buttons ?? {}).map(([key, selectors]) => [key, normalizeSelectorList(selectors)])
    ),
    mediaTools: Object.fromEntries(
      Object.entries(rawConfig.mediaTools ?? {}).map(([key, selectors]) => [key, normalizeSelectorList(selectors)])
    ),
    mediaToolActions: Object.fromEntries(
      Object.entries(rawConfig.mediaToolActions ?? {}).map(([action, tools]) => [
        action,
        Object.fromEntries(
          Object.entries(tools ?? {}).map(([key, selectors]) => [key, normalizeSelectorList(selectors)])
        )
      ])
    ),
    skuRows: normalizeSelectorList(rawConfig.skuRows)
  }
}

const readSelectorConfig = (configPath = getSelectorConfigPath()) =>
  normalizeSelectorConfig(JSON.parse(readFileSync(configPath, "utf8")) as DianxiaomiSelectorConfig)

const createSelectorConfigVersion = (note: string): SelectorConfigVersion | null => {
  const configPath = getSelectorConfigPath()
  if (!existsSync(configPath)) {
    return null
  }

  const versionDir = getSelectorConfigVersionDir()
  const createdAt = new Date().toISOString()
  const id = `selector-config-${createdAt.replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`
  const backupPath = path.join(versionDir, `${id}.json`)
  const version: SelectorConfigVersion = {
    id,
    createdAt,
    configPath,
    backupPath,
    note,
    config: readSelectorConfig(configPath)
  }

  mkdirSync(versionDir, {
    recursive: true
  })
  writeFileSync(backupPath, JSON.stringify(version, null, 2), "utf8")
  return version
}

const readSelectorConfigVersion = (backupPath: string): SelectorConfigVersion | null => {
  try {
    const parsed = JSON.parse(readFileSync(backupPath, "utf8")) as Partial<SelectorConfigVersion>
    if (!parsed.id || !parsed.createdAt || !parsed.config) {
      return null
    }

    return {
      id: parsed.id,
      createdAt: parsed.createdAt,
      configPath: parsed.configPath ?? getSelectorConfigPath(),
      backupPath: parsed.backupPath ?? backupPath,
      note: parsed.note ?? "",
      config: normalizeSelectorConfig(parsed.config)
    }
  } catch {
    return null
  }
}

const writeSelectorConfig = (config: DianxiaomiSelectorConfig, note: string): SelectorConfigSaveResult => {
  const normalizedConfig = normalizeSelectorConfig(config)
  const configPath = getSelectorConfigPath()
  const version = createSelectorConfigVersion(note)

  mkdirSync(path.dirname(configPath), {
    recursive: true
  })
  writeFileSync(configPath, JSON.stringify(normalizedConfig, null, 2), "utf8")

  return {
    configPath,
    version,
    config: normalizedConfig
  }
}

const summarizeSelectorConfig = (config: DianxiaomiSelectorConfig | null) => ({
  fieldSelectorCount: Object.values(config?.fields ?? {}).reduce((total, selectors) => total + selectors.length, 0),
  buttonSelectorCount: Object.values(config?.buttons ?? {}).reduce((total, selectors) => total + selectors.length, 0),
  mediaToolSelectorCount: Object.values(config?.mediaTools ?? {}).reduce((total, selectors) => total + selectors.length, 0),
  mediaToolActionSelectorCount: Object.values(config?.mediaToolActions ?? {}).reduce(
    (total, tools) => total + Object.values(tools ?? {}).reduce((subtotal, selectors) => subtotal + selectors.length, 0),
    0
  ),
  skuRowSelectorCount: config?.skuRows.length ?? 0
})

// P1: selector entries that must not be made empty by a config change. Title /
// price / stock / save are hard requirements for filling a Dianxiaomi
// listing. Description is intentionally excluded — Dianxiaomi's real Temu
// edit page may use a module / image description preview with no direct
// text field, and `validateSelectorConfig` already treats that as a
// "preserved" warning rather than a hard error. Blocking a restore over an
// empty `fields.description` would force operators to keep a stub selector
// just to satisfy the safety gate.
const BLOCKING_CRITICAL_SELECTOR_FIELDS = ["title", "price"]
const BLOCKING_CRITICAL_SELECTOR_BUTTONS = ["save"]

const criticalSelectorEntry = (entry: SelectorConfigDiffEntry) =>
  (entry.group === "fields" && BLOCKING_CRITICAL_SELECTOR_FIELDS.includes(entry.key))
    || (entry.group === "buttons" && BLOCKING_CRITICAL_SELECTOR_BUTTONS.includes(entry.key))

const diffSelectorList = (
  group: SelectorConfigDiffEntry["group"],
  key: string,
  currentSelectors: string[],
  nextSelectors: string[]
): SelectorConfigDiffEntry => {
  const addedSelectors = nextSelectors.filter((selector) => !currentSelectors.includes(selector))
  const removedSelectors = currentSelectors.filter((selector) => !nextSelectors.includes(selector))
  const unchangedSelectors = nextSelectors.filter((selector) => currentSelectors.includes(selector))
  const status: SelectorConfigDiffEntry["status"] =
    addedSelectors.length === 0 && removedSelectors.length === 0 ? "unchanged"
      : currentSelectors.length === 0 && nextSelectors.length > 0 ? "added"
        : currentSelectors.length > 0 && nextSelectors.length === 0 ? "removed"
          : "changed"

  return {
    group,
    key,
    status,
    currentSelectors,
    nextSelectors,
    addedSelectors,
    removedSelectors,
    unchangedSelectors
  }
}

const buildSelectorConfigDiffEntries = (
  currentConfig: DianxiaomiSelectorConfig | null,
  nextConfig: DianxiaomiSelectorConfig
): SelectorConfigDiffEntry[] => {
  const current = normalizeSelectorConfig(currentConfig ?? {
    fields: {},
    buttons: {},
    mediaTools: {},
    skuRows: []
  })
  const next = normalizeSelectorConfig(nextConfig)
  const fieldKeys = Array.from(new Set([
    ...SELECTOR_FIELD_KEYS,
    ...Object.keys(current.fields),
    ...Object.keys(next.fields)
  ]))
  const buttonKeys = Array.from(new Set([
    ...SELECTOR_BUTTON_KEYS,
    ...Object.keys(current.buttons),
    ...Object.keys(next.buttons)
  ]))
  const mediaToolKeys = Array.from(new Set([
    ...SELECTOR_MEDIA_TOOL_KEYS,
    ...Object.keys(current.mediaTools ?? {}),
    ...Object.keys(next.mediaTools ?? {})
  ]))
  const mediaToolActionKeys = Array.from(new Set([
    ...Object.keys(current.mediaToolActions ?? {}),
    ...Object.keys(next.mediaToolActions ?? {})
  ])).flatMap((action) => Array.from(new Set([
    ...SELECTOR_MEDIA_TOOL_KEYS,
    ...Object.keys(current.mediaToolActions?.[action] ?? {}),
    ...Object.keys(next.mediaToolActions?.[action] ?? {})
  ])).map((tool) => ({
    key: `${action}.${tool}`,
    currentSelectors: current.mediaToolActions?.[action]?.[tool] ?? [],
    nextSelectors: next.mediaToolActions?.[action]?.[tool] ?? []
  })))

  return [
    ...fieldKeys.map((key) => diffSelectorList("fields", key, current.fields[key] ?? [], next.fields[key] ?? [])),
    ...buttonKeys.map((key) => diffSelectorList("buttons", key, current.buttons[key] ?? [], next.buttons[key] ?? [])),
    ...mediaToolKeys.map((key) => diffSelectorList("mediaTools", key, current.mediaTools?.[key] ?? [], next.mediaTools?.[key] ?? [])),
    ...mediaToolActionKeys.map((item) => diffSelectorList("mediaToolActions", item.key, item.currentSelectors, item.nextSelectors)),
    diffSelectorList("skuRows", "skuRows", current.skuRows, next.skuRows)
  ]
}

const buildSelectorConfigChangeRisks = (entries: SelectorConfigDiffEntry[]): SelectorConfigChangeRisk[] =>
  entries.flatMap<SelectorConfigChangeRisk>((entry) => {
    if (!criticalSelectorEntry(entry) || entry.status === "unchanged") {
      return []
    }

    if (entry.nextSelectors.length === 0) {
      return [{
        id: `selector-${entry.group}-${entry.key}-blocked-empty`,
        level: "block" as const,
        group: entry.group,
        key: entry.key,
        message: `critical selector would be empty: ${entry.group}.${entry.key}`,
        currentSelectors: entry.currentSelectors,
        nextSelectors: entry.nextSelectors,
        addedSelectors: entry.addedSelectors,
        removedSelectors: entry.removedSelectors
      }]
    }

    if (entry.removedSelectors.length > 0 || entry.addedSelectors.length > 0) {
      return [{
        id: `selector-${entry.group}-${entry.key}-confirm-change`,
        level: "confirm" as const,
        group: entry.group,
        key: entry.key,
        message: `critical selector will change: ${entry.group}.${entry.key}`,
        currentSelectors: entry.currentSelectors,
        nextSelectors: entry.nextSelectors,
        addedSelectors: entry.addedSelectors,
        removedSelectors: entry.removedSelectors
      }]
    }

    return []
  })

const summarizeSelectorConfigDiff = (entries: SelectorConfigDiffEntry[], risks: SelectorConfigChangeRisk[]) => ({
  totalCount: entries.length,
  changedCount: entries.filter((entry) => entry.status === "changed").length,
  addedCount: entries.filter((entry) => entry.status === "added").length,
  removedCount: entries.filter((entry) => entry.status === "removed").length,
  unchangedCount: entries.filter((entry) => entry.status === "unchanged").length,
  confirmRiskCount: risks.filter((risk) => risk.level === "confirm").length,
  blockRiskCount: risks.filter((risk) => risk.level === "block").length
})

const assertSelectorConfigChangeAllowed = (diff: SelectorConfigDiffResult, confirmed: boolean | undefined) => {
  if (diff.blocked) {
    throw new SelectorConfigChangeRiskError("selector config change is blocked because critical selectors would be empty", diff)
  }

  if (diff.requiresConfirmation && !confirmed) {
    throw new SelectorConfigChangeRiskError("selector config change requires confirmation", diff)
  }
}

export const getSelectorConfigDiff = (
  config: DianxiaomiSelectorConfig,
  selectorConfigPath?: string
): SelectorConfigDiffResult => {
  const status = getSelectorConfigStatus(selectorConfigPath)
  const entries = buildSelectorConfigDiffEntries(status.config, config)
  const risks = buildSelectorConfigChangeRisks(entries)

  return {
    checkedAt: new Date().toISOString(),
    configPath: status.configPath,
    currentExists: status.exists,
    entries,
    risks,
    requiresConfirmation: risks.some((risk) => risk.level === "confirm"),
    blocked: risks.some((risk) => risk.level === "block"),
    summary: summarizeSelectorConfigDiff(entries, risks)
  }
}

export const getSelectorConfigStatus = (selectorConfigPath?: string): SelectorConfigStatus => {
  const configPath = resolveSelectorConfigPath(selectorConfigPath)
  if (!existsSync(configPath)) {
    return {
      configPath,
      exists: false,
      config: null,
      error: null,
      summary: summarizeSelectorConfig(null)
    }
  }

  try {
    const config = readSelectorConfig(configPath)
    return {
      configPath,
      exists: true,
      config,
      error: null,
      summary: summarizeSelectorConfig(config)
    }
  } catch (error) {
    return {
      configPath,
      exists: true,
      config: null,
      error: error instanceof Error ? error.message : String(error),
      summary: summarizeSelectorConfig(null)
    }
  }
}

export const getSelectorConfigVersions = (limit = 20): SelectorConfigVersion[] => {
  const versionDir = getSelectorConfigVersionDir()
  if (!existsSync(versionDir)) {
    return []
  }

  return readdirSync(versionDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => readSelectorConfigVersion(path.join(versionDir, fileName)))
    .filter((version): version is SelectorConfigVersion => Boolean(version))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit)
}

export const saveSelectorConfig = (input: SelectorConfigSaveInput): SelectorConfigSaveResult => {
  const diff = getSelectorConfigDiff(input.config)
  assertSelectorConfigChangeAllowed(diff, input.confirmDangerousChanges)
  return writeSelectorConfig(input.config, input.note ?? "manual selector config save")
}

export const getSelectorConfigVersionDiff = (versionId: string): SelectorConfigVersionDiffResult | null => {
  const version = getSelectorConfigVersions(500).find((item) => item.id === versionId)
  if (!version) {
    return null
  }

  return {
    ...getSelectorConfigDiff(version.config),
    version
  }
}

export const restoreSelectorConfigVersion = (
  versionId: string,
  input: SelectorConfigRestoreInput = {}
): SelectorConfigRestoreResult | null => {
  const restoredVersion = getSelectorConfigVersions(500).find((version) => version.id === versionId)
  if (!restoredVersion) {
    return null
  }

  const diff = getSelectorConfigDiff(restoredVersion.config)
  assertSelectorConfigChangeAllowed(diff, input.confirmDangerousChanges)

  createSelectorConfigVersion(`before restore ${versionId}`)
  const configPath = getSelectorConfigPath()
  const config = normalizeSelectorConfig(restoredVersion.config)

  mkdirSync(path.dirname(configPath), {
    recursive: true
  })
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8")

  return {
    configPath,
    restoredVersion,
    config
  }
}

const hasSelector = (config: DianxiaomiSelectorConfig | null, group: "fields" | "buttons", key: string) =>
  (config?.[group][key] ?? []).length > 0

const buildSelectorWorkbenchItem = (
  config: DianxiaomiSelectorConfig | null,
  diagnosis: SelectorDiagnosisReport | undefined,
  group: "fields" | "buttons",
  key: string,
  required: boolean
): SelectorWorkbenchItem => {
  const configuredSelectors = config?.[group][key] ?? []
  const candidates = diagnosis?.[group][key]?.candidates ?? []
  const recommendedSelector = candidates[0]?.selectorHint ?? null
  const latestCandidateConfigured = recommendedSelector ? configuredSelectors.includes(recommendedSelector) : true
  const status: SelectorWorkbenchItem["status"] =
    configuredSelectors.length === 0 && required ? "missing-config"
      : !recommendedSelector && required ? "missing-candidate"
        : !latestCandidateConfigured ? "stale"
          : configuredSelectors.length > 0 || recommendedSelector ? "ready"
            : "optional"

  return {
    group,
    key,
    required,
    configuredSelectors,
    candidates,
    recommendedSelector,
    latestCandidateConfigured,
    status
  }
}

const selectorConfigFromDiagnosis = (diagnosis: SelectorDiagnosisReport): DianxiaomiSelectorConfig => ({
  fields: {
    title: [firstSelector(diagnosis, "fields", "title")].filter(Boolean) as string[],
    description: [firstSelector(diagnosis, "fields", "description")].filter(Boolean) as string[],
    price: [firstSelector(diagnosis, "fields", "price")].filter(Boolean) as string[],
    stock: [firstSelector(diagnosis, "fields", "stock")].filter(Boolean) as string[],
    attribute: [firstSelector(diagnosis, "fields", "attribute")].filter(Boolean) as string[]
  },
  buttons: {
    save: [firstSelector(diagnosis, "buttons", "save")].filter(Boolean) as string[],
    submit: [firstSelector(diagnosis, "buttons", "submit")].filter(Boolean) as string[]
  },
  mediaTools: {
    imageTranslation: [diagnosis.mediaTools?.imageTranslation?.candidates[0]?.selectorHint].filter(Boolean) as string[],
    whiteBackground: [diagnosis.mediaTools?.whiteBackground?.candidates[0]?.selectorHint].filter(Boolean) as string[],
    imageEditor: [diagnosis.mediaTools?.imageEditor?.candidates[0]?.selectorHint].filter(Boolean) as string[],
    batchResize: [diagnosis.mediaTools?.batchResize?.candidates[0]?.selectorHint].filter(Boolean) as string[],
    imageManagement: [diagnosis.mediaTools?.imageManagement?.candidates[0]?.selectorHint].filter(Boolean) as string[]
  },
  mediaToolActions: {
    apply: {
      imageTranslation: [diagnosis.mediaToolActions?.apply?.imageTranslation?.candidates[0]?.selectorHint].filter(Boolean) as string[],
      whiteBackground: [diagnosis.mediaToolActions?.apply?.whiteBackground?.candidates[0]?.selectorHint].filter(Boolean) as string[],
      imageEditor: [diagnosis.mediaToolActions?.apply?.imageEditor?.candidates[0]?.selectorHint].filter(Boolean) as string[],
      batchResize: [diagnosis.mediaToolActions?.apply?.batchResize?.candidates[0]?.selectorHint].filter(Boolean) as string[],
      imageManagement: [diagnosis.mediaToolActions?.apply?.imageManagement?.candidates[0]?.selectorHint].filter(Boolean) as string[]
    },
    close: {
      imageTranslation: [diagnosis.mediaToolActions?.close?.imageTranslation?.candidates[0]?.selectorHint].filter(Boolean) as string[],
      whiteBackground: [diagnosis.mediaToolActions?.close?.whiteBackground?.candidates[0]?.selectorHint].filter(Boolean) as string[],
      imageEditor: [diagnosis.mediaToolActions?.close?.imageEditor?.candidates[0]?.selectorHint].filter(Boolean) as string[],
      batchResize: [diagnosis.mediaToolActions?.close?.batchResize?.candidates[0]?.selectorHint].filter(Boolean) as string[],
      imageManagement: [diagnosis.mediaToolActions?.close?.imageManagement?.candidates[0]?.selectorHint].filter(Boolean) as string[]
    }
  },
  skuRows: diagnosis.skuRows.ok ? ["tr, [role='row'], [class*='sku' i], [class*='table-row' i], [class*='row' i]"] : []
})

const latestCandidateMatchesConfig = (
  config: DianxiaomiSelectorConfig | null,
  diagnosis: SelectorDiagnosisReport | undefined,
  group: "fields" | "buttons",
  key: string
) => {
  const latestCandidate = diagnosis ? firstSelector(diagnosis, group, key) : undefined
  if (!latestCandidate) {
    return true
  }

  return Boolean(config?.[group][key]?.includes(latestCandidate))
}

export const validateSelectorConfig = (selectorConfigPath?: string): SelectorConfigValidationResult => {
  const status = getSelectorConfigStatus(selectorConfigPath)
  const latestDiagnosis = latestSelectorDiagnosisEntry()?.report
  const issues: SelectorConfigValidationIssue[] = []

  if (!status.exists) {
    issues.push({
      id: "selector-config-missing",
      level: "error",
      message: "selector config file is missing"
    })
  }

  if (status.error) {
    issues.push({
      id: "selector-config-invalid",
      level: "error",
      message: `selector config cannot be parsed: ${status.error}`
    })
  }

  if (!latestDiagnosis) {
    issues.push({
      id: "selector-diagnosis-missing",
      level: "warning",
      message: "no selector diagnosis report found"
    })
  }

  if (latestDiagnosis?.targetSurface?.status === "failed" || latestDiagnosis?.targetSurface?.data?.canInspect === false) {
    issues.push({
      id: "selector-diagnosis-target-surface-blocked",
      level: "error",
      message: `latest selector diagnosis is not a recognized Dianxiaomi listing edit surface: ${String(latestDiagnosis.targetSurface?.data?.surfaceStatus ?? "unknown")}`
    })
  }

  for (const field of REQUIRED_SELECTOR_FIELDS) {
    if (!hasSelector(status.config, "fields", field)) {
      // P1: description can legitimately have no direct text selector when
      // Dianxiaomi renders it as a module/image preview. We only downgrade
      // "missing" to a "preserved" warning when there is POSITIVE evidence:
      // a diagnosis exists and recognized the description field (ok=true)
      // without a candidate selector. With no diagnosis, or an unrecognized
      // field, a missing required selector stays a hard error so genuinely
      // broken configs are still blocked.
      const diagnosisField = latestDiagnosis?.fields?.[field]
      const diagnosisFieldCandidates = diagnosisField?.candidates ?? []
      const diagnosisFieldReadiness = ((latestDiagnosis?.targetSurface?.data as Record<string, unknown> | undefined)?.fieldReadiness
        ?? {}) as Record<string, unknown>
      const descriptionRecognizedAsPreview = field === "description"
        && Boolean(latestDiagnosis)
        && diagnosisField?.ok === true
        && diagnosisFieldCandidates.length === 0
      // Positive evidence that this is a genuine, inspectable Dianxiaomi edit
      // surface (not a broken/empty page): a real-dianxiaomi surface with SKU
      // rows recognized. Used to safely downgrade a missing stock selector.
      const realInspectableSurfaceWithSkuRows = Boolean(latestDiagnosis)
        && latestDiagnosis?.targetSurface?.data?.surfaceStatus === "real-dianxiaomi"
        && latestDiagnosis?.targetSurface?.data?.canInspect !== false
        && latestDiagnosis?.skuRows?.ok === true
      // stock can legitimately have no selector in two cases, both requiring a
      // real inspectable surface with SKU rows so broken configs stay blocked:
      //   (a) stock lives in the SKU rows (readiness > 0) — filled per-row;
      //   (b) Temu 半托管 products have NO stock field on the edit page at all
      //       (platform/warehouse owns stock) — readiness is 0 and that is
      //       correct, so a missing stock selector must not hard-block them.
      const stockReadiness = Number(diagnosisFieldReadiness.stock ?? 0)
      const stockRecognizedViaSkuRows = field === "stock"
        && diagnosisFieldCandidates.length === 0
        && realInspectableSurfaceWithSkuRows
      if (descriptionRecognizedAsPreview) {
        issues.push({
          id: `field-${field}-preserved`,
          level: "warning",
          message: `field selector missing but the latest diagnosis recognized ${field} as a module/image preview; the field will be preserved`
        })
      } else if (stockRecognizedViaSkuRows) {
        issues.push({
          id: `field-${field}-preserved`,
          level: "warning",
          message: stockReadiness > 0
            ? `field selector missing but the latest diagnosis recognized ${field} via SKU rows; the field will be filled from per-row inputs`
            : `field selector missing and no ${field} field is present on the real Dianxiaomi edit surface (e.g. Temu 半托管, where the platform owns stock); ${field} is not required for this product`
        })
      } else {
        issues.push({
          id: `field-${field}-missing`,
          level: "error",
          message: `field selector missing: ${field}`
        })
      }
      continue
    }

    if (!latestCandidateMatchesConfig(status.config, latestDiagnosis, "fields", field)) {
      issues.push({
        id: `field-${field}-stale`,
        level: "warning",
        message: `field selector may be stale: ${field}`
      })
    }
  }

  for (const button of REQUIRED_SELECTOR_BUTTONS) {
    if (!hasSelector(status.config, "buttons", button)) {
      issues.push({
        id: `button-${button}-missing`,
        level: "error",
        message: `button selector missing: ${button}`
      })
      continue
    }

    if (!latestCandidateMatchesConfig(status.config, latestDiagnosis, "buttons", button)) {
      issues.push({
        id: `button-${button}-stale`,
        level: "warning",
        message: `button selector may be stale: ${button}`
      })
    }
  }

  if ((status.config?.skuRows.length ?? 0) === 0) {
    issues.push({
      id: "sku-row-selector-missing",
      level: "warning",
      message: "sku row selector missing"
    })
  }

  return {
    checkedAt: new Date().toISOString(),
    configPath: status.configPath,
    latestDiagnosisCreatedAt: latestDiagnosis?.createdAt ?? null,
    latestDiagnosisPageUrl: latestDiagnosis?.pageUrl ?? null,
    valid: issues.every((issue) => issue.level !== "error"),
    issues
  }
}

export const getSelectorWorkbench = (): SelectorWorkbench => {
  const diagnosisEntry = latestSelectorDiagnosisEntry()
  const diagnosis = diagnosisEntry?.report
  const config = getSelectorConfigStatus()
  const validation = validateSelectorConfig()
  const items = [
    ...SELECTOR_FIELD_KEYS.map((key) => buildSelectorWorkbenchItem(
      config.config,
      diagnosis,
      "fields",
      key,
      REQUIRED_SELECTOR_FIELDS.includes(key)
    )),
    ...SELECTOR_BUTTON_KEYS.map((key) => buildSelectorWorkbenchItem(
      config.config,
      diagnosis,
      "buttons",
      key,
      REQUIRED_SELECTOR_BUTTONS.includes(key)
    ))
  ]
  const mediaTools = SELECTOR_MEDIA_TOOL_KEYS.map((key) => {
    const configuredSelectors = config.config?.mediaTools?.[key] ?? []
    const candidates = diagnosis?.mediaTools?.[key]?.candidates ?? []
    const recommendedSelector = candidates[0]?.selectorHint ?? null
    const latestCandidateConfigured = recommendedSelector ? configuredSelectors.includes(recommendedSelector) : true
    const status: SelectorWorkbenchItem["status"] =
      configuredSelectors.length > 0 || recommendedSelector
        ? latestCandidateConfigured ? "ready" : "stale"
        : "optional"

    return {
      group: "mediaTools" as const,
      key,
      required: false,
      configuredSelectors,
      candidates,
      recommendedSelector,
      latestCandidateConfigured,
      status
    }
  })
  const mediaToolActions = SELECTOR_MEDIA_TOOL_ACTION_KEYS.flatMap((action) =>
    SELECTOR_MEDIA_TOOL_KEYS.map((toolKey) => {
      const key = `${action}.${toolKey}`
      const configuredSelectors = config.config?.mediaToolActions?.[action]?.[toolKey] ?? []
      const candidates = diagnosis?.mediaToolActions?.[action]?.[toolKey]?.candidates ?? []
      const recommendedSelector = candidates[0]?.selectorHint ?? null
      const latestCandidateConfigured = recommendedSelector ? configuredSelectors.includes(recommendedSelector) : true
      const status: SelectorWorkbenchItem["status"] =
        configuredSelectors.length > 0 || recommendedSelector
          ? latestCandidateConfigured ? "ready" : "stale"
          : "optional"

      return {
        group: "mediaToolActions" as const,
        key,
        required: false,
        configuredSelectors,
        candidates,
        recommendedSelector,
        latestCandidateConfigured,
        status
      }
    })
  )
  const requiredItems = items.filter((item) => item.required)
  const requiredReadyCount = requiredItems.filter((item) => item.status === "ready").length
  const staleCount = [...items, ...mediaTools, ...mediaToolActions].filter((item) => item.status === "stale").length
  const skuRowsConfigured = config.config?.skuRows ?? []
  const skuRowsStatus: SelectorWorkbenchItem["status"] =
    skuRowsConfigured.length > 0 ? "ready"
      : diagnosis?.skuRows.ok ? "missing-config"
        : "missing-candidate"

  return {
    checkedAt: new Date().toISOString(),
    diagnosis: diagnosisEntry ? {
      diagnosisPath: diagnosisEntry.filePath,
      pageUrl: diagnosisEntry.report.pageUrl,
      pageTitle: diagnosisEntry.report.pageTitle,
      createdAt: diagnosisEntry.report.createdAt,
      requiredOk: diagnosisEntry.report.requiredOk,
      summary: diagnosisEntry.report.summary,
      targetSurface: diagnosisEntry.report.targetSurface
    } : null,
    config,
    validation,
    items,
    skuRows: {
      required: false,
      configuredSelectors: skuRowsConfigured,
      diagnosisOk: diagnosis?.skuRows.ok ?? false,
      diagnosisCount: diagnosis?.skuRows.count ?? 0,
      samples: diagnosis?.skuRows.samples ?? [],
      status: skuRowsStatus
    },
    mediaTools,
    mediaToolActions,
    summary: {
      requiredReadyCount,
      requiredCount: requiredItems.length,
      missingRequiredCount: requiredItems.length - requiredReadyCount,
      staleCount,
      candidateCount: [...items, ...mediaTools, ...mediaToolActions].reduce((total, item) => total + item.candidates.length, 0),
      configuredSelectorCount: config.summary.fieldSelectorCount
        + config.summary.buttonSelectorCount
        + (config.summary.mediaToolSelectorCount ?? 0)
        + (config.summary.mediaToolActionSelectorCount ?? 0)
        + config.summary.skuRowSelectorCount
      ,
      mediaToolReadyCount: mediaTools.filter((item) => item.status === "ready").length,
      mediaToolCount: mediaTools.length,
      mediaToolActionReadyCount: mediaToolActions.filter((item) => item.status === "ready").length,
      mediaToolActionCount: mediaToolActions.length
    }
  }
}

export const generateSelectorConfigFromLatestDiagnosis = (): SelectorConfigGenerationResult | null => {
  const diagnosis = latestSelectorDiagnosisEntry()?.report
  if (!diagnosis) {
    return null
  }
  if (diagnosis.targetSurface?.status === "failed" || diagnosis.targetSurface?.data?.canInspect === false) {
    throw new Error(`latest selector diagnosis is not a recognized Dianxiaomi listing edit surface: ${String(diagnosis.targetSurface?.data?.surfaceStatus ?? "unknown")}`)
  }

  const config = selectorConfigFromDiagnosis(diagnosis)
  const saved = writeSelectorConfig(config, `generated from diagnosis ${diagnosis.createdAt}`)

  return {
    configPath: saved.configPath,
    sourceDiagnosisCreatedAt: diagnosis.createdAt,
    sourcePageUrl: diagnosis.pageUrl,
    config: saved.config,
    version: saved.version
  }
}
