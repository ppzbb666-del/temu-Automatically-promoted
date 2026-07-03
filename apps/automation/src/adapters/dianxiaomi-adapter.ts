import { extractDianxiaomiImageCheckIssues, parseDianxiaomiImageCheckSummary } from "@temu-ai-ops/shared"
import type { Locator, Page } from "playwright"
import path from "node:path"
import type { DianxiaomiProductRepairAction, DianxiaomiProductRepairPlan, ListingDraft, ListingSkuPricing } from "@temu-ai-ops/shared"
import {
  EDITABLE_SELECTOR,
  escapeRegExp,
  firstVisible,
  inspectManualLoginSurface,
  normalizeText,
  type RunnerOptions
} from "../common"
import { findByConfiguredSelectors, loadSelectorConfig, type DianxiaomiSelectorConfig } from "../selector-config"

// tsx runs with esbuild keepNames=true, which wraps named functions/consts in a
// `__name(fn, "name")` helper defined only at module top level. When Playwright
// serializes an evaluate callback whose body declares a named function/const, the
// injected `__name(...)` call reaches the browser without its helper and throws
// `ReferenceError: __name is not defined` — silently failing surface probes. Define
// a no-op `__name` in the page (current doc + every future navigation) so those
// callbacks resolve it. Idempotent; safe to call repeatedly.
const ESBUILD_NAME_HELPER_SOURCE =
  "globalThis.__name = globalThis.__name || function (target) { return target }"
const hardenPageForEsbuildEvaluate = async (page: Page) => {
  await page.addInitScript(ESBUILD_NAME_HELPER_SOURCE).catch(() => undefined)
  await page.evaluate(ESBUILD_NAME_HELPER_SOURCE).catch(() => undefined)
}

export type FieldKind = "title" | "description" | "price" | "stock" | "attribute"

export type StepStatus = "done" | "failed" | "skipped"

export type AutomationStepResult = {
  id: string
  label: string
  status: StepStatus
  detail: string
  data?: Record<string, unknown>
}

type ProbedProductImage = {
  url: string
  width: number
  height: number
  loaded: boolean
  aspectRatio: number | null
  loadState: "loaded" | "error" | "timeout"
}

type SkuImageCellState = {
  imageCount: number
  imageUrls: string[]
  imageMeta: Array<{
    src: string
    width: number
    height: number
    aspectRatio: number | null
  }>
}

const PRODUCT_IMAGE_PROBE_TIMEOUT_MS = 10_000

type SkuImageCellTarget = {
  cell: Locator
  rowIndex: number
  rowText: string
}

type FillSkuImageLinksOptions = {
  maxRows?: number
  screenshotDir?: string
  screenshotPrefix?: string
  mode?: "strict-color" | "square-preview-all-colors"
}

type DescriptionImageModuleState = {
  moduleCount: number
  modules: Array<{
    index: number
    src: string
    width: number
    height: number
    aspectRatio: number | null
  }>
}

type DescriptionImageModuleTarget = {
  item: Locator
  index: number
  image: {
    src: string
    width: number
    height: number
    aspectRatio: number | null
  } | null
}

type MediaToolDefinition = {
  id: string
  configKey: "imageTranslation" | "whiteBackground" | "imageEditor" | "batchResize" | "imageManagement"
  label: string
  keywords: string[]
}

type LocatorDescriptor = {
  tagName: string
  text: string
  role: string | null
  className: string
  href: string
}

type MediaToolCandidate = {
  id: string
  configKey: MediaToolDefinition["configKey"]
  label: string
  keywords: string[]
  selectorConfigured: boolean
  locator: Locator | null
  locatorDescriptor: LocatorDescriptor | null
}

type MediaToolSafetyStatus =
  | "manual-confirmation-required"
  | "ready-for-unattended-open"
  | "ready-for-unattended-apply"
  | "missing-tool"
  | "blocked-by-open-dialog"
  | "blocked-by-media-failure"
  | "opened"
  | "applied"
  | "open-failed"
  | "apply-failed"
  | "return-failed"

type FeedbackState = "success" | "failure" | "unknown"
type MediaSurfaceState = "matched" | "missing" | "mismatched"
type MediaFailureKind =
  | "transient"
  | "invalid-media"
  | "storage-quota"
  | "missing-input"
  | "unsupported"
  | "surface-mismatch"
  | "surface-missing"
  | "apply-control-missing"
  | "return-blocked"
  | "image-unchanged"
  | "unknown"

type MediaToolSafetyItem = {
  id: string
  configKey: MediaToolDefinition["configKey"]
  label: string
  available: boolean
  selectorConfigured: boolean
  status: MediaToolSafetyStatus
  reason: string
  requiresManualConfirmation: boolean
  wouldClick: boolean
  wouldApply: boolean
  clicked?: boolean
  applied?: boolean
  beforeUrl?: string
  afterUrl?: string
  beforeDialogCount?: number
  afterDialogCount?: number
  returnDialogCount?: number
  screenshotPath?: string | null
  beforeApplyScreenshotPath?: string | null
  afterApplyScreenshotPath?: string | null
  // P0-F: listing image signature probes captured before/after apply. Used
  // as hard evidence for instant-action tools and as soft evidence for
  // dialog-based tools.
  imageSignatureBefore?: string
  imageSignatureAfter?: string
  imageSignatureChanged?: boolean
  surfaceState?: MediaSurfaceState
  surfaceMatchedKeyword?: string | null
  surfaceText?: string
  applyButton?: LocatorDescriptor | null
  feedbackState?: FeedbackState
  feedbackMessage?: string
  feedbackSource?: string
  imageCheckIssues?: Array<{
    category: string
    issue: string
    detail?: string
  }>
  feedbackAttempts?: MediaApplyAttemptFeedback[]
  applyAttempts?: number
  maxApplyAttempts?: number
  failureKind?: MediaFailureKind
  retryable?: boolean
  error?: string | null
  preparation?: Record<string, unknown>
  selectAllChecked?: boolean | null
  locator: LocatorDescriptor | null
}

type PageSafetyState = {
  visibleDialogCount: number
  visibleImageCount: number
  blockingDialogs: LocatorDescriptor[]
}

type SubmitFeedback = {
  state: FeedbackState
  message: string
  source: string
}

type PageValidationIssue = {
  label: string
  text: string
  explain: string[]
  inputs: Array<{
    name: string
    placeholder: string
    value: string
    className: string
  }>
  selects: string[]
  rect: {
    left: number
    top: number
    width: number
    height: number
  }
}

type PageValidationSummary = {
  issueCount: number
  issues: PageValidationIssue[]
  warningTexts: string[]
  toastTexts: string[]
}

type MediaApplyFeedback = {
  state: FeedbackState
  message: string
  source: string
}

type MediaApplyAttemptFeedback = MediaApplyFeedback & {
  attempt: number
  failureKind?: MediaFailureKind
  retryable?: boolean
}

type MediaSurfaceInspection = {
  state: MediaSurfaceState
  matchedKeyword: string | null
  text: string
}

type ImageCheckIssue = {
  category: string
  issue: string
  detail?: string
}

type ImageCheckCategorySummary = {
  label: string
  count: number
}

type ImageCheckSelectionCandidate = {
  label: string
  dimensions: string | null
  imageType: string | null
  src?: string | null
}

type ImageCheckCategoryApplyResult = {
  category: string
  count: number
  selectedCount: number
  changed: boolean
  candidates: ImageCheckSelectionCandidate[]
  batchTool?: MediaToolDefinition["id"] | null
  batchToolApplied?: boolean
  batchToolReason?: string | null
}

type ImageCheckApplySummary = {
  applied: boolean
  changed: boolean
  status: "applied" | "no-op" | "failed"
  reason: string
  categories: ImageCheckCategoryApplyResult[]
  issues: ImageCheckIssue[]
  directReplacement?: {
    applied: boolean
    reason: string
    imageUrls: string[]
    writerResult?: AutomationStepResult | null
  } | null
  deferredVerification?: {
    required: boolean
    categoryLabels: string[]
    verified?: boolean
    remainingCategories?: Array<{ label: string; count: number }>
    surfacedIssues?: ImageCheckIssue[]
    reason?: string
  } | null
}

type SubmitAttemptResult = SubmitFeedback & {
  attempt: number
  clickedSubmit: boolean
  clickedSubmitMenuAction: boolean
  clickedConfirm: boolean
  feedbackChanged: boolean
  submitMenuActionText?: string | null
}

type MediaProcessingSafetyPlan = {
  safeMode: "plan-only" | "unattended-open" | "unattended-apply"
  wouldClick: boolean
  wouldApply: boolean
  guardStatus: "manual-ready" | "blocked" | "no-tools"
  manualConfirmationRequired: boolean
  pageState: PageSafetyState
  tools: MediaToolSafetyItem[]
}

type TargetSurfaceStatus = "real-dianxiaomi" | "fixture" | "missing-fields" | "login-or-captcha" | "unknown"

type TargetSurfaceInspection = {
  pageUrl: string
  pageTitle: string
  host: string
  isDianxiaomiHost: boolean
  isDataFixture: boolean
  loginOrCaptchaDetected: boolean
  surfaceStatus: TargetSurfaceStatus
  canWrite: boolean
  canInspect: boolean
  reasons: string[]
  fieldReadiness: {
    title: number
    description: number
    skuRows: number
    price: number
    stock: number
    saveButton: number
    submitButton: number
    mediaTools: number
    editableFields: number
  }
}

const isRealDianxiaomiEditTargetUrl = (value: string | null | undefined) => {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    const parsed = new URL(trimmed)
    const host = parsed.hostname.toLowerCase()
    if (!/(^|\.)dianxiaomi\.(com|cn)$/i.test(host) || /^help\./i.test(host)) {
      return false
    }

    const pathname = parsed.pathname.toLowerCase()
    return pathname === "/web/poptemu/edit" || /\/(product|listing|goods|item)\/edit\b/i.test(parsed.pathname)
  } catch {
    return false
  }
}

const parseTargetPageUrl = (value: string | null | undefined) => {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }

  try {
    return new URL(trimmed)
  } catch {
    return null
  }
}

const getDianxiaomiEditPageKey = (value: string | null | undefined) => {
  const parts = parseTargetPageUrl(value)
  if (!parts || !/(^|\.)dianxiaomi\.(com|cn)$/i.test(parts.hostname) || /^help\./i.test(parts.hostname)) {
    return null
  }

  const pathname = parts.pathname.toLowerCase()
  if (pathname !== "/web/poptemu/edit") {
    return null
  }

  const itemId = parts.searchParams.get("id")?.trim()
  return itemId
    ? `${parts.hostname.toLowerCase()}${pathname}?id=${itemId}`
    : `${parts.hostname.toLowerCase()}${pathname}`
}

const isSameDianxiaomiEditPage = (left: string | null | undefined, right: string | null | undefined) => {
  const leftKey = getDianxiaomiEditPageKey(left)
  const rightKey = getDianxiaomiEditPageKey(right)

  if (leftKey && rightKey) {
    return leftKey === rightKey
  }

  return (left ?? "").trim() === (right ?? "").trim()
}

const stepResult = (
  id: string,
  label: string,
  status: StepStatus,
  detail: string,
  data?: Record<string, unknown>
): AutomationStepResult => ({
  id,
  label,
  status,
  detail,
  data
})

const COMMON_FIELD_KEYWORDS: Record<FieldKind, string[]> = {
  title: ["商品标题", "产品标题", "标题", "product title", "title", "name"],
  description: ["商品描述", "产品描述", "详情描述", "描述", "description", "details"],
  price: ["申报价", "售价", "销售价", "价格", "price", "sale price", "retail price"],
  stock: ["库存", "数量", "可售库存", "stock", "quantity", "available"],
  attribute: ["属性", "规格", "变体", "attribute", "variation", "specification"]
}

const DIANXIAOMI_FIELD_KEYWORDS: Record<FieldKind, string[]> = {
  title: ["商品标题", "产品标题", "刊登标题", "平台标题", "标题", "title"],
  description: ["商品描述", "产品描述", "刊登描述", "详情描述", "描述", "description"],
  price: ["申报价", "建议售价", "刊登价", "销售价", "售价", "价格", "price"],
  stock: ["库存", "刊登库存", "可售库存", "数量", "stock", "quantity"],
  attribute: ["产品属性", "商品属性", "平台属性", "规格", "变种", "变体", "attribute"]
}

const ATTRIBUTE_ALIASES: Record<string, string[]> = {
  color: ["颜色", "色", "color"],
  size: ["尺码", "尺寸", "规格", "size"],
  material: ["材质", "material"],
  power: ["功率", "供电", "电源", "power"],
  usage: ["用途", "使用场景", "usage"]
}

const SKU_IMAGE_TARGET_RATIO = 3 / 4
const SKU_IMAGE_STRICT_RATIO_MIN = 0.735
const SKU_IMAGE_STRICT_RATIO_MAX = 0.755
const SKU_IMAGE_RATIO_MIN = 0.68
const SKU_IMAGE_RATIO_MAX = 0.8
const SKU_IMAGE_MIN_WIDTH_PX = 1340
const SKU_IMAGE_MIN_HEIGHT_PX = 1785
const SKU_IMAGE_MIN_COUNT = 3
const SKU_IMAGE_FALLBACK_RATIO_MIN = 0.65
const SKU_IMAGE_FALLBACK_RATIO_MAX = 0.85
const SKU_IMAGE_FALLBACK_MIN_WIDTH_PX = 1200
const SKU_IMAGE_FALLBACK_MIN_HEIGHT_PX = 1600
const SECTION_SQUARE_RATIO_MIN = 0.95
const SECTION_SQUARE_RATIO_MAX = 1.05
const SKU_IMAGE_DIALOG_KEYWORDS = [
  "从网络地址(url)选择图片",
  "图片url地址",
  "网络地址(url)",
  "网络地址",
  "url地址"
]
const SKU_IMAGE_DIALOG_FAILURE_KEYWORDS = [
  "错误",
  "失败",
  "无效",
  "不能为空",
  "请填写",
  "请检查",
  "格式不正确",
  "图片地址"
]
const SKU_IMAGE_CHOOSE_BUTTON_TEXT = "\u9009\u62e9\u56fe\u7247"
const SKU_IMAGE_NETWORK_MENU_TEXT = "\u7f51\u7edc\u56fe\u7247"
const SKU_IMAGE_NETWORK_ADDRESS_TEXT = "\u7f51\u7edc\u5730\u5740"
const SKU_IMAGE_ADD_BUTTON_TEXT = "\u6dfb\u52a0"
const SKU_IMAGE_CONFIRM_TEXT = "\u786e\u5b9a"
const SKU_IMAGE_CONFIRM_ALT_TEXT = "\u786e\u8ba4"
const SKU_IMAGE_DELETE_TEXT = "\u5220\u9664"
const DESCRIPTION_IMAGE_RATIO_MIN = SKU_IMAGE_STRICT_RATIO_MIN
const DESCRIPTION_IMAGE_RATIO_MAX = SKU_IMAGE_STRICT_RATIO_MAX
const DESCRIPTION_EDIT_TRIGGER_KEYWORDS = ["\u7f16\u8f91\u63cf\u8ff0", "\u63cf\u8ff0\u7f16\u8f91", "edit description"]
const DESCRIPTION_MODAL_KEYWORDS = ["Temu\u4ea7\u54c1\u63cf\u8ff0", "\u4ea7\u54c1\u63cf\u8ff0", "Temu product description"]
const DESCRIPTION_MODAL_SAVE_KEYWORDS = ["\u4fdd\u5b58", "\u786e\u5b9a", "save", "confirm"]
const DESCRIPTION_DELETE_KEYWORDS = ["\u5220\u9664", "delete", "remove"]

export const getFieldKeywords = (kind: FieldKind) => [
  ...(kind === "title" ? ["\u5546\u54c1\u6807\u9898", "\u4ea7\u54c1\u6807\u9898", "\u82f1\u6587\u6807\u9898", "\u520a\u767b\u6807\u9898", "\u5e73\u53f0\u6807\u9898", "\u6807\u9898"] : []),
  ...(kind === "description" ? ["\u5546\u54c1\u63cf\u8ff0", "\u4ea7\u54c1\u63cf\u8ff0", "\u520a\u767b\u63cf\u8ff0", "\u8be6\u60c5\u63cf\u8ff0", "\u63cf\u8ff0"] : []),
  ...(kind === "price" ? ["\u7533\u62a5\u4ef7", "\u5efa\u8bae\u552e\u4ef7", "\u520a\u767b\u4ef7", "\u9500\u552e\u4ef7", "\u552e\u4ef7", "\u4ef7\u683c"] : []),
  ...(kind === "stock" ? ["\u5e93\u5b58", "\u520a\u767b\u5e93\u5b58", "\u53ef\u552e\u5e93\u5b58", "\u6570\u91cf"] : []),
  ...(kind === "attribute" ? ["\u4ea7\u54c1\u5c5e\u6027", "\u5546\u54c1\u5c5e\u6027", "\u5e73\u53f0\u5c5e\u6027", "\u5c5e\u6027", "\u89c4\u683c", "\u53d8\u79cd", "\u53d8\u4f53"] : []),
  ...DIANXIAOMI_FIELD_KEYWORDS[kind],
  ...COMMON_FIELD_KEYWORDS[kind]
]

const INTERNAL_DIANXIAOMI_ATTRIBUTE_KEYS = new Set([
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

const isInternalDianxiaomiAttributeKey = (key: string) =>
  INTERNAL_DIANXIAOMI_ATTRIBUTE_KEYS.has(key) || key.startsWith("dxm-")

type CategoryPreparationState = {
  missingCategory: boolean
  categoryLabel: string | null
  categoryButtonVisible: boolean
}

type NormalizeCategorySelectionOptions = {
  stepId?: string
  stepLabel?: string
}

const CATEGORY_MISSING_TEXT = "未选择分类"
const CATEGORY_RECOVERY_MODAL_KEYWORDS = ["选择类目", "选择分类", "category"]
const CATEGORY_RECOVERY_CONFIRM_TEXTS = ["选择", "确定", "确认"]
const CATEGORY_RECOVERY_CLOSE_TEXTS = ["关闭", "取消", "返回", "close", "cancel"]
const CATEGORY_HIDDEN_LEAF_PATTERN = /^(?:其他|其它)[（(](.+?)[）)]$/
const KNOWN_CATEGORY_RECOVERY_PATHS: Record<string, string[]> = {
  "女装长裤": ["服装、鞋靴和珠宝饰品", "女士时尚", "女装", "女装长裤"],
  "其他（女装长裤）": ["服装、鞋靴和珠宝饰品", "女士时尚", "女装", "女装长裤"],
  "其他(女装长裤)": ["服装、鞋靴和珠宝饰品", "女士时尚", "女装", "女装长裤"]
}

const inspectCategoryPreparationState = async (page: Page): Promise<CategoryPreparationState> => {
  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""))
  const categoryButton = await findInteractiveByKeywords(page, ["选择分类", "分类", "category"])
  const categoryLabel = normalizeText(await page.locator("body").locator(`text=${CATEGORY_MISSING_TEXT}`).first().textContent().catch(() => ""))
  return {
    missingCategory: bodyText.includes(CATEGORY_MISSING_TEXT) || categoryLabel.includes(CATEGORY_MISSING_TEXT),
    categoryLabel: categoryLabel || null,
    categoryButtonVisible: Boolean(categoryButton)
  }
}

const categoryRecoveryKey = (segments: string[]) =>
  segments.map((segment) => cleanVisibleText(segment)).filter(Boolean).join(">")

const isRecoverableCategorySegment = (value: string | null | undefined) => {
  const text = cleanVisibleText(value)
  return Boolean(text && !/^\?+$/.test(text))
}

const dedupeCategoryPaths = (paths: string[][]) => {
  const seen = new Set<string>()
  const deduped: string[][] = []

  for (const path of paths) {
    const cleaned = path
      .map((segment) => cleanVisibleText(segment))
      .filter((segment) => isRecoverableCategorySegment(segment))
    if (cleaned.length <= 0) {
      continue
    }

    const key = categoryRecoveryKey(cleaned)
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    deduped.push(cleaned)
  }

  return deduped
}

const stripTemuCategoryPrefix = (segments: string[]) => {
  const cleaned = segments
    .map((segment) => cleanVisibleText(segment))
    .filter((segment) => isRecoverableCategorySegment(segment))
  if (cleaned[0]?.toLowerCase() === "temu") {
    return cleaned.slice(1)
  }

  return cleaned
}

const parseCategoryPathText = (value: string | null | undefined) => {
  const cleaned = cleanVisibleText(value)
  if (!cleaned || (!cleaned.includes("/") && !cleaned.includes(">"))) {
    return null
  }

  let candidate = cleaned
  const searchPrefixMatch = candidate.match(/(?:搜索|search)\s+(.+)$/i)
  if (searchPrefixMatch?.[1]) {
    candidate = searchPrefixMatch[1]
  }
  candidate = candidate.replace(/\s+(?:关闭|取消|返回|选择类目|选择分类|close|cancel)\s*$/i, "").trim()

  const segments = candidate
    .split(/\s*(?:\/|>)\s*/)
    .map((segment) => cleanVisibleText(segment))
    .filter((segment) => isRecoverableCategorySegment(segment))

  return segments.length > 0 ? segments : null
}

const toPublicCategoryPath = (segments: string[] | null) => {
  if (!segments || segments.length <= 0) {
    return null
  }

  const cleaned = stripTemuCategoryPrefix(segments)
  if (cleaned.length <= 0) {
    return null
  }

  const last = cleaned[cleaned.length - 1] ?? ""
  return CATEGORY_HIDDEN_LEAF_PATTERN.test(last)
    ? cleaned.slice(0, -1)
    : cleaned
}

const categoryRecoveryHintsFromLabel = (value: string | null | undefined) => {
  const cleaned = cleanVisibleText(value)
  if (!isRecoverableCategorySegment(cleaned)) {
    return [] as string[][]
  }

  const candidates: string[][] = []
  const direct = KNOWN_CATEGORY_RECOVERY_PATHS[cleaned]
  if (direct) {
    candidates.push(direct)
  }

  const hiddenLeaf = cleaned.match(CATEGORY_HIDDEN_LEAF_PATTERN)?.[1]?.trim()
  if (hiddenLeaf) {
    const publicPath = KNOWN_CATEGORY_RECOVERY_PATHS[hiddenLeaf]
    if (publicPath) {
      candidates.push(publicPath)
    }
  }

  return candidates
}

const toNonEmptyText = (value: unknown) => {
  if (typeof value === "string") {
    const cleaned = value.trim()
    return cleaned || null
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value)
  }

  return null
}

const parseSlashDelimitedIdList = (value: unknown) => {
  const text = toNonEmptyText(value)
  if (!text) {
    return [] as string[]
  }

  return Array.from(new Set(
    text
      .split(/[\/,]/)
      .map((segment) => segment.trim())
      .filter((segment) => /^\d+$/.test(segment))
  ))
}

const fetchDianxiaomiProductCategorySnapshot = async (page: Page) => {
  const productId = (() => {
    try {
      return toNonEmptyText(new URL(page.url()).searchParams.get("id"))
    } catch {
      return null
    }
  })()

  if (!productId) {
    return {
      productId: null,
      shopId: null,
      categoryId: null,
      categoryIds: [] as string[],
      fullCid: null,
      nodePath: null,
      categoryName: null,
      sourceCategoryId: null,
      status: null,
      error: "missing-product-id"
    }
  }

  try {
    const response = await page.context().request.get(
      `https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${productId}`
    )
    const payload = await response.json().catch(() => null) as {
      data?: {
        product?: Record<string, unknown>
      }
    } | null
    const product =
      payload?.data?.product && typeof payload.data.product === "object"
        ? payload.data.product
        : null

    return {
      productId,
      shopId: toNonEmptyText(product?.shopId),
      categoryId: toNonEmptyText(product?.categoryId),
      categoryIds: parseSlashDelimitedIdList(product?.categoryIds),
      fullCid: toNonEmptyText(product?.fullCid),
      nodePath: toNonEmptyText(product?.nodePath),
      categoryName: toNonEmptyText(product?.categoryName),
      sourceCategoryId: toNonEmptyText(product?.sourceCategoryId),
      status: response.status(),
      error: response.ok() ? null : `edit-json-http-${response.status()}`
    }
  } catch (error) {
    return {
      productId,
      shopId: null,
      categoryId: null,
      categoryIds: [] as string[],
      fullCid: null,
      nodePath: null,
      categoryName: null,
      sourceCategoryId: null,
      status: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

// Read existing product image URLs from Dianxiaomi's edit.json. Legacy "page
// reference" work items carry no images, but the listing's edit.json exposes
// them: mainProductSkuSpecReqsList groups them by color variant (each color's
// previewImgUrls is a "|"-joined URL list), and materialImgUrl is a fallback.
// Returns a flat, deduped URL list — fillSkuImageLinks handles 3:4 conversion
// (via weserv) and reuse-to-3, so a flat list is enough to clear the save gate.
const fetchProductImagesFromEditJson = async (page: Page): Promise<string[]> => {
  const productId = (() => {
    try {
      return toNonEmptyText(new URL(page.url()).searchParams.get("id"))
    } catch {
      return null
    }
  })()
  if (!productId) {
    return []
  }

  try {
    const response = await page.context().request.get(
      `https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${productId}`
    )
    if (!response.ok()) {
      return []
    }
    const payload = await response.json().catch(() => null) as {
      data?: { product?: Record<string, unknown> }
    } | null
    const product = payload?.data?.product
    if (!product || typeof product !== "object") {
      return []
    }

    const urls: string[] = []
    const pushPipeJoined = (value: unknown) => {
      const text = toNonEmptyText(value)
      if (!text) {
        return
      }
      for (const part of text.split("|")) {
        const url = part.trim()
        if (/^https?:\/\//i.test(url)) {
          urls.push(url)
        }
      }
    }

    const specList = product.mainProductSkuSpecReqsList ?? product.mainProductSkuSpecReqs
    if (Array.isArray(specList)) {
      for (const spec of specList) {
        pushPipeJoined((spec as Record<string, unknown>)?.previewImgUrls)
      }
    }
    pushPipeJoined(product.materialImgUrl)
    pushPipeJoined(product.mainImage)
    pushPipeJoined(product.extraImages)

    return Array.from(new Set(urls))
  } catch {
    return []
  }
}

const collectCategoryRecoveryPathsFromApi = async (page: Page, draft: ListingDraft) => {
  const draftAttributes = draft.attributes ?? {}
  const draftCategoryId = toNonEmptyText(draftAttributes.dianxiaomiCategoryId)
  const draftFullCid = toNonEmptyText(draftAttributes.dianxiaomiFullCid)
  const snapshot = await fetchDianxiaomiProductCategorySnapshot(page)
  const lookups: Array<Record<string, unknown>> = []
  const candidatePaths: string[][] = []

  const snapshotPublicPath = toPublicCategoryPath(parseCategoryPathText(snapshot.nodePath))
  if (snapshotPublicPath && snapshotPublicPath.length > 0) {
    candidatePaths.push(snapshotPublicPath)
    lookups.push({
      source: "edit-json-node-path",
      categoryId: snapshot.categoryId,
      nodePath: snapshot.nodePath,
      publicPath: snapshotPublicPath
    })
  }

  const candidateCategoryIds = Array.from(new Set([
    draftCategoryId,
    snapshot.categoryId,
    ...snapshot.categoryIds
  ].filter((value): value is string => Boolean(value && /^\d+$/.test(value)))))

  if (snapshot.shopId) {
    for (const categoryId of candidateCategoryIds) {
      try {
        const response = await page.context().request.post(
          "https://www.dianxiaomi.com/api/popTemuCategory/getByCategoryId.json",
          {
            form: {
              categoryId,
              shopId: snapshot.shopId
            }
          }
        )
        const payload = await response.json().catch(() => null) as {
          data?: Record<string, unknown>
        } | null
        const data =
          payload?.data && typeof payload.data === "object"
            ? payload.data
            : null
        const nodePath = toNonEmptyText(data?.nodePath)
        const publicPath = toPublicCategoryPath(parseCategoryPathText(nodePath))
        if (publicPath && publicPath.length > 0) {
          candidatePaths.push(publicPath)
        }

        lookups.push({
          source: "get-by-category-id",
          requestedCategoryId: categoryId,
          status: response.status(),
          resolvedCategoryId: toNonEmptyText(data?.catId),
          nodePath,
          publicPath,
          isHidden: data?.isHidden ?? null,
          hiddenType: data?.hiddenType ?? null
        })
      } catch (error) {
        lookups.push({
          source: "get-by-category-id",
          requestedCategoryId: categoryId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  } else if (candidateCategoryIds.length > 0) {
    lookups.push({
      source: "get-by-category-id",
      requestedCategoryIds: candidateCategoryIds,
      error: "missing-shop-id"
    })
  }

  return {
    draftCategoryId,
    draftFullCid,
    snapshot,
    lookups,
    candidatePaths: dedupeCategoryPaths(candidatePaths)
  }
}

const waitForCategoryRecoveryModal = async (page: Page, minimumVisibleDialogs: number, timeoutMs = 8_000) => {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const dialogs = await visibleAntModalLocators(page)
    if (dialogs.length > minimumVisibleDialogs) {
      return dialogs[dialogs.length - 1] ?? null
    }

    const latest = dialogs[dialogs.length - 1] ?? null
    if (latest) {
      const text = cleanVisibleText(await latest.innerText().catch(() => ""))
      if (CATEGORY_RECOVERY_MODAL_KEYWORDS.some((keyword) => text.includes(keyword))) {
        return latest
      }
    }

    await page.waitForTimeout(250)
  }

  return (await visibleAntModalLocators(page)).at(-1) ?? null
}

const waitForCategoryRecoveryColumn = async (modal: Locator, columnIndex: number, timeoutMs = 6_000) => {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const columns = modal.locator(".categories-box")
    if (await columns.count().catch(() => 0) > columnIndex) {
      const column = columns.nth(columnIndex)
      if (await column.isVisible().catch(() => false)) {
        return column
      }
    }

    await modal.page().waitForTimeout(250)
  }

  return null
}

const ensureCategoryRecoveryTreeVisible = async (page: Page, modal: Locator) => {
  const columns = modal.locator(".categories-box")
  const beforeCount = await columns.count().catch(() => 0)
  if (beforeCount > 0) {
    return {
      visibleColumnCount: beforeCount,
      searchValueBefore: null,
      clearedSearchInput: false
    }
  }

  const searchInput = await firstVisible([
    modal.locator("input[name='searchCategory']"),
    modal.locator(".ant-modal-body input.ant-input")
  ])
  const searchValueBefore = searchInput
    ? cleanVisibleText(await searchInput.inputValue().catch(() => ""))
    : ""

  if (searchInput && searchValueBefore) {
    await searchInput.fill("").catch(async () => {
      await searchInput.click().catch(() => undefined)
      await searchInput.press("Control+A").catch(() => undefined)
      await searchInput.press("Backspace").catch(() => undefined)
    })
    await page.waitForTimeout(700)
  }

  return {
    visibleColumnCount: await columns.count().catch(() => 0),
    searchValueBefore: searchValueBefore || null,
    clearedSearchInput: Boolean(searchInput && searchValueBefore)
  }
}

const findExactCategoryItemInColumn = async (column: Locator, label: string) => {
  const items = column.locator(".categories-item-name")
  const count = Math.min(await items.count().catch(() => 0), 160)
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index)
    const text = cleanVisibleText(await item.innerText().catch(() => ""))
    if (text === label) {
      return item
    }
  }

  return null
}

const clickExactCategoryItemInColumnWithScroll = async (page: Page, column: Locator, label: string, maxSteps = 24) => {
  let previousTop = -1

  for (let step = 0; step < maxSteps; step += 1) {
    const item = await findExactCategoryItemInColumn(column, label)
    if (item) {
      await clickAfterDianxiaomiIdle(page, item, 2).catch(async () => {
        await item.click({
          timeout: 5_000,
          force: true
        })
      })
      return {
        clicked: true,
        step
      }
    }

    const scrollState = await column.evaluate((node) => {
      const element = node as HTMLElement
      const beforeTop = element.scrollTop
      const maxTop = Math.max(0, element.scrollHeight - element.clientHeight)
      const nextTop = Math.min(maxTop, beforeTop + Math.max(180, Math.floor(element.clientHeight * 0.85)))
      element.scrollTop = nextTop
      return {
        beforeTop,
        afterTop: element.scrollTop
      }
    }).catch(() => null)

    if (!scrollState || scrollState.afterTop === previousTop || scrollState.afterTop === scrollState.beforeTop) {
      break
    }

    previousTop = scrollState.afterTop
    await page.waitForTimeout(300)
  }

  return {
    clicked: false,
    step: maxSteps
  }
}

const clickCategoryRecoveryPath = async (page: Page, modal: Locator, pathSegments: string[]) => {
  const attempts: Array<{
    columnIndex: number
    label: string
    clicked: boolean
    step: number
  }> = []

  for (let index = 0; index < pathSegments.length; index += 1) {
    const label = cleanVisibleText(pathSegments[index])
    const column = await waitForCategoryRecoveryColumn(modal, index)
    if (!column) {
      return {
        clicked: false,
        failedLabel: label,
        attempts
      }
    }

    const result = await clickExactCategoryItemInColumnWithScroll(page, column, label)
    attempts.push({
      columnIndex: index,
      label,
      clicked: result.clicked,
      step: result.step
    })

    if (!result.clicked) {
      return {
        clicked: false,
        failedLabel: label,
        attempts
      }
    }

    await page.waitForTimeout(index === pathSegments.length - 1 ? 600 : 900)
  }

  return {
    clicked: true,
    failedLabel: null,
    attempts
  }
}

const clickCategoryRecoveryConfirmButton = async (page: Page, modal: Locator) => {
  const buttons = modal.locator(".ant-modal-footer button")
  const count = Math.min(await buttons.count().catch(() => 0), 12)

  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index)
    const text = cleanVisibleText(await button.innerText().catch(() => ""))
    if (!CATEGORY_RECOVERY_CONFIRM_TEXTS.includes(text)) {
      continue
    }

    await clickAfterDianxiaomiIdle(page, button, 2).catch(async () => {
      await button.click({
        timeout: 5_000,
        force: true
      })
    })
    return text
  }

  return null
}

const closeCategoryRecoveryModal = async (page: Page, modal: Locator, visibleDialogCountBeforeOpen: number) => {
  const closeAction = await firstVisible([
    modal.locator(".ant-modal-close"),
    modal.locator("[aria-label*='close' i]"),
    modal.locator("[title*='close' i]")
  ]) ?? await findInteractiveInRootByKeywords(modal, CATEGORY_RECOVERY_CLOSE_TEXTS)

  if (!closeAction) {
    return false
  }

  await clickAfterDianxiaomiIdle(page, closeAction, 1).catch(async () => {
    await closeAction.click({
      timeout: 5_000,
      force: true
    }).catch(() => undefined)
  })

  return waitForVisibleAntModalCountAtMost(page, visibleDialogCountBeforeOpen, 5_000)
}

const waitForCategoryPreparationStateRecovery = async (page: Page, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let state = await inspectCategoryPreparationState(page)

  while (Date.now() - startedAt < timeoutMs) {
    if (!state.missingCategory) {
      return state
    }

    await waitForDianxiaomiLoadingOverlayToClear(page)
    await page.waitForTimeout(300)
    state = await inspectCategoryPreparationState(page)
  }

  return state
}

const collectCategoryRecoveryPaths = async (page: Page, modal: Locator, draft: ListingDraft) => {
  const draftAttributes = draft.attributes ?? {}
  const searchResultPaths = await modal.locator(".search-result-item").evaluateAll((nodes) =>
    nodes
      .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 8)
  ).catch(() => [] as string[])
  const modalText = cleanVisibleText(await modal.innerText().catch(() => ""))

  const apiRecovery = await collectCategoryRecoveryPathsFromApi(page, draft)

  return {
    apiRecovery,
    candidatePaths: dedupeCategoryPaths([
      ...apiRecovery.candidatePaths,
      ...searchResultPaths
        .map((value) => toPublicCategoryPath(parseCategoryPathText(value)))
        .filter((value): value is string[] => Array.isArray(value) && value.length > 0),
      ...[modalText]
        .map((value) => toPublicCategoryPath(parseCategoryPathText(value)))
        .filter((value): value is string[] => Array.isArray(value) && value.length > 0),
      ...[draft.categoryPath]
        .map((value) => toPublicCategoryPath(value))
        .filter((value): value is string[] => Array.isArray(value) && value.length > 0),
      ...categoryRecoveryHintsFromLabel(draftAttributes.dianxiaomiCategoryLabel),
      ...categoryRecoveryHintsFromLabel(draft.categoryPath[draft.categoryPath.length - 1])
    ])
  }
}

export const normalizeCategorySelection = async (
  page: Page,
  draft: ListingDraft,
  options: NormalizeCategorySelectionOptions = {}
) => {
  const stepId = options.stepId ?? "normalize-category-selection"
  const stepLabel = options.stepLabel ?? "Normalize category selection"
  const draftAttributes = draft.attributes ?? {}
  const categoryId = draftAttributes.dianxiaomiCategoryId?.trim() || ""
  const fullCid = draftAttributes.dianxiaomiFullCid?.trim() || ""
  const categoryLabel = draftAttributes.dianxiaomiCategoryLabel?.trim() || ""
  const categoryHintSource = draftAttributes.dianxiaomiCategoryHintSource?.trim() || ""
  const categoryMissingFlag = draftAttributes.dianxiaomiCategoryMissing?.trim() === "true"
  const state = await inspectCategoryPreparationState(page)

  if (!state.missingCategory) {
    return stepResult(
      stepId,
      stepLabel,
      "skipped",
      "Dianxiaomi category is already selected",
      {
        state,
        categoryId: categoryId || null,
        fullCid: fullCid || null,
        categoryLabel: categoryLabel || null
      }
    )
  }

  if (!state.categoryButtonVisible) {
    return stepResult(
      stepId,
      stepLabel,
      "failed",
      "Dianxiaomi category is missing on the page and the category picker is not visible.",
      {
        state,
        categoryId: categoryId || null,
        fullCid: fullCid || null,
        categoryLabel: categoryLabel || null,
        categoryHintSource: categoryHintSource || null,
        autoRestoreReady: false,
        categoryButtonVisible: false
      }
    )
  }

  const categoryButton = await findInteractiveByKeywords(page, ["选择分类", "分类", "category"])
  if (!categoryButton) {
    return stepResult(
      stepId,
      stepLabel,
      "failed",
      "Dianxiaomi category is missing on the page and the category picker could not be located.",
      {
        state,
        categoryId: categoryId || null,
        fullCid: fullCid || null,
        categoryLabel: categoryLabel || null,
        categoryHintSource: categoryHintSource || null,
        autoRestoreReady: false,
        categoryButtonVisible: true
      }
    )
  }

  const visibleDialogCountBeforeOpen = (await visibleAntModalLocators(page)).length
  await clickAfterDianxiaomiIdle(page, categoryButton, 2).catch(async () => {
    await categoryButton.click({
      timeout: 5_000,
      force: true
    })
  })
  await page.waitForTimeout(800)

  const modal = await waitForCategoryRecoveryModal(page, visibleDialogCountBeforeOpen)
  if (!modal) {
    return stepResult(
      stepId,
      stepLabel,
      "failed",
      "Clicked the category picker but the category selection modal did not appear.",
      {
        state,
        categoryId: categoryId || null,
        fullCid: fullCid || null,
        categoryLabel: categoryLabel || null,
        categoryHintSource: categoryHintSource || null,
        autoRestoreReady: false
      }
    )
  }

  const { candidatePaths, apiRecovery } = await collectCategoryRecoveryPaths(page, modal, draft)
  if (candidatePaths.length <= 0) {
    await closeCategoryRecoveryModal(page, modal, visibleDialogCountBeforeOpen).catch(() => false)
    return stepResult(
      stepId,
      stepLabel,
      "failed",
      categoryMissingFlag
        ? "Dianxiaomi category is missing and no recoverable public category path was detected."
        : "Dianxiaomi category is missing and the category modal did not expose a recoverable public category path.",
      {
        state,
        categoryId: categoryId || null,
        fullCid: fullCid || null,
        categoryLabel: categoryLabel || null,
        categoryHintSource: categoryHintSource || null,
        autoRestoreReady: false,
        candidatePaths,
        apiRecovery
      }
    )
  }

  const treePreparation = await ensureCategoryRecoveryTreeVisible(page, modal)
  let selectedPath: string[] | null = null
  let pathAttempts: Array<{
    columnIndex: number
    label: string
    clicked: boolean
    step: number
  }> = []
  let failedLabel: string | null = null

  for (const candidatePath of candidatePaths) {
    const result = await clickCategoryRecoveryPath(page, modal, candidatePath)
    pathAttempts = result.attempts
    if (!result.clicked) {
      failedLabel = result.failedLabel
      continue
    }

    selectedPath = candidatePath
    failedLabel = null
    break
  }

  if (!selectedPath) {
    await closeCategoryRecoveryModal(page, modal, visibleDialogCountBeforeOpen).catch(() => false)
    return stepResult(
      stepId,
      stepLabel,
      "failed",
      failedLabel
        ? `Detected a public category recovery path but could not click "${failedLabel}" in the category tree.`
        : "Detected a public category recovery path but could not click it in the category tree.",
      {
        state,
        categoryId: categoryId || null,
        fullCid: fullCid || null,
        categoryLabel: categoryLabel || null,
        categoryHintSource: categoryHintSource || null,
        autoRestoreReady: true,
        candidatePaths,
        apiRecovery,
        treePreparation,
        pathAttempts,
        failedLabel
      }
    )
  }

  const confirmText = await clickCategoryRecoveryConfirmButton(page, modal)
  if (!confirmText) {
    await closeCategoryRecoveryModal(page, modal, visibleDialogCountBeforeOpen).catch(() => false)
    return stepResult(
      stepId,
      stepLabel,
      "failed",
      "The public category path was selected, but the modal confirm button was not found.",
      {
        state,
        categoryId: categoryId || null,
        fullCid: fullCid || null,
        categoryLabel: categoryLabel || null,
        categoryHintSource: categoryHintSource || null,
        autoRestoreReady: true,
        candidatePaths,
        apiRecovery,
        treePreparation,
        selectedPath,
        pathAttempts
      }
    )
  }

  await waitForVisibleAntModalCountAtMost(page, visibleDialogCountBeforeOpen, 8_000).catch(() => false)
  const recoveredState = await waitForCategoryPreparationStateRecovery(page)
  if (!recoveredState.missingCategory) {
    return stepResult(
      stepId,
      stepLabel,
      "done",
      `Restored Dianxiaomi category selection via public category path: ${selectedPath.join(" > ")}`,
      {
        previousState: state,
        recoveredState,
        categoryId: categoryId || null,
        fullCid: fullCid || null,
        categoryLabel: categoryLabel || null,
        categoryHintSource: categoryHintSource || null,
        autoRestoreReady: true,
        candidatePaths,
        apiRecovery,
        treePreparation,
        selectedPath,
        confirmText,
        pathAttempts
      }
    )
  }

  return stepResult(
    stepId,
    stepLabel,
    "failed",
    "Clicked a public category recovery path, but Dianxiaomi still shows the page as missing category.",
    {
      previousState: state,
      recoveredState,
      categoryId: categoryId || null,
      fullCid: fullCid || null,
      categoryLabel: categoryLabel || null,
      categoryHintSource: categoryHintSource || null,
      autoRestoreReady: true,
      candidatePaths,
      apiRecovery,
      treePreparation,
      selectedPath,
      confirmText,
      pathAttempts
    }
  )
}

const DIANXIAOMI_MEDIA_TOOLS: MediaToolDefinition[] = [
  {
    id: "image-translation",
    configKey: "imageTranslation",
    label: "Image translation",
    keywords: ["图片翻译", "翻译图片", "image translation", "translate image", "translate"]
  },
  {
    id: "white-background",
    configKey: "whiteBackground",
    label: "White background",
    keywords: ["图片白底", "白底图", "白底", "white background", "remove background"]
  },
  {
    id: "image-editor",
    configKey: "imageEditor",
    label: "Xiaomi image editor",
    keywords: ["小秘美图", "美图", "图片编辑", "编辑图片", "批量编辑", "image editor", "edit image"]
  },
  {
    id: "batch-resize",
    configKey: "batchResize",
    label: "Batch resize",
    keywords: ["批量改图片尺寸", "批量改大小", "改大小", "图片大小", "图片尺寸", "resize", "batch resize"]
  },
  {
    id: "image-management",
    configKey: "imageManagement",
    label: "Image management",
    keywords: ["图片检测", "检测图片", "图片管理", "图片空间", "image management", "image space"]
  }
]

const IMAGE_OPTIONS_TRIGGER_KEYWORDS = ["编辑图片", "crop编辑图片", "批量", "图片操作"]
const IMAGE_OPTIONS_MENU_KEYWORDS: Partial<Record<MediaToolDefinition["id"], string[]>> = {
  "image-translation": ["图片翻译", "翻译图片"],
  "image-editor": ["批量编辑", "编辑图片"],
  "batch-resize": ["批量改图片尺寸", "批量改大小", "改图片尺寸"]
}
const BATCH_RESIZE_TARGET_SIDE_PX = 1785
const BATCH_RESIZE_COMPLETION_TIMEOUT_MS = 90_000
const BATCH_RESIZE_PROGRESS_KEYWORDS = [
  "处理中",
  "上传中",
  "生成中",
  "请稍候",
  "请等待",
  "progress",
  "processing",
  "uploading",
  "generating"
]

// P0-D: tools whose entry click triggers an in-page effect rather than a
// closeable dialog. The apply path for these is `applyInstantMediaAction` —
// it skips dialog/apply-button detection and only waits for an in-page
// success keyword + an image signature change.
const INSTANT_ACTION_TOOL_IDS = new Set<MediaToolDefinition["id"]>([
  "image-translation",
  "image-management"
])

const MEDIA_INSTANT_SUCCESS_KEYWORDS = [
  "翻译完成",
  "翻译成功",
  "已翻译",
  "检测完成",
  "检测通过",
  "图片检测完成",
  "已处理",
  "处理完成",
  "已应用",
  "应用成功",
  "完成",
  "success",
  "successful",
  "completed",
  "done",
  "applied"
]

const MEDIA_INSTANT_FAILURE_KEYWORDS = [
  "翻译失败",
  "检测失败",
  "处理失败",
  "图片不合规",
  "无法识别",
  "不支持的图片",
  "请重试",
  "失败",
  "错误",
  "异常",
  "failed",
  "failure",
  "error",
  "invalid",
  "unsupported"
]

const IMAGE_CHECK_CATEGORY_LABELS = [
  "轮播图",
  "产品图",
  "详情图",
  "主图",
  "sku图",
  "颜色图",
  "属性图",
  "carouse",
  "carousel",
  "product image",
  "detail image",
  "main image",
  "sku image",
  "color image"
]

const IMAGE_CHECK_ISSUE_LABELS = [
  "尺寸",
  "比例",
  "宽高",
  "非英文",
  "中文",
  "水印",
  "模糊",
  "像素",
  "大小",
  "格式",
  "size",
  "ratio",
  "aspect",
  "watermark",
  "english",
  "language",
  "resolution",
  "format"
]

const IMAGE_CHECK_SAVE_KEYWORDS = [
  "保存",
  "应用",
  "确认",
  "save",
  "apply",
  "confirm"
]

const IMAGE_CHECK_CLOSE_KEYWORDS = [
  "关闭",
  "取消",
  "返回",
  "close",
  "cancel",
  "return"
]

const IMAGE_CHECK_MAX_VISIBLE_CANDIDATES = 80

const IMAGE_CHECK_CATEGORY_PRIORITY = [
  "图片包含文字、水印",
  "产品图尺寸不合规",
  "描述图尺寸不合规",
  "图片过大",
  "图片链接失效"
] as const

const IMAGE_CHECK_CATEGORY_RULES: Array<{
  issuePattern: RegExp
  categoryPattern: RegExp
}> = [
  {
    issuePattern: /(非英文|非英语|中文|文字|水印|language|english|watermark)/i,
    categoryPattern: /图片包含文字|水印/i
  },
  {
    issuePattern: /(尺寸|比例|宽高|像素|size|ratio|aspect|resolution)/i,
    categoryPattern: /(产品图|素材图).*(尺寸|不合规)|尺寸不合规/i
  },
  {
    issuePattern: /(过大|大小|too large|oversize)/i,
    categoryPattern: /图片过大/i
  },
  {
    issuePattern: /(失效|链接|link|invalid)/i,
    categoryPattern: /图片链接失效/i
  }
]

const BLOCKING_DIALOG_SELECTOR = [
  "[role='dialog']",
  "[aria-modal='true']",
  ".modal",
  ".ant-modal",
  ".el-dialog",
  "[class*='modal']",
  "[class*='dialog']"
].join(", ")

const MEDIA_APPLY_KEYWORDS: Record<MediaToolDefinition["id"], string[]> = {
  "image-translation": [
    "一键翻译",
    "快速翻译",
    "开始翻译",
    "提交翻译",
    "apply translation",
    "start translation",
    "translate now",
    "translate",
    "confirm",
    "apply",
    "save"
  ],
  "white-background": [
    "apply white background",
    "make white background",
    "remove background",
    "confirm",
    "apply",
    "save"
  ],
  "image-editor": [
    "\u786e\u5b9a",
    "\u786e\u8ba4",
    "\u4fdd\u5b58",
    "\u5e94\u7528",
    "\u5b8c\u6210",
    "apply edit",
    "save image",
    "finish editing",
    "complete",
    "confirm",
    "apply",
    "save"
  ],
  "batch-resize": [
    "生成JPG图片",
    "生成PNG图片",
    "生成图片",
    "批量改图片尺寸",
    "apply resize",
    "resize now",
    "batch resize",
    "confirm",
    "apply",
    "save"
  ],
  "image-management": [
    "apply selection",
    "confirm selection",
    "use selected",
    "confirm",
    "apply",
    "save"
  ]
}

const MEDIA_CLOSE_KEYWORDS = [
  "\u5173\u95ed",
  "\u53d6\u6d88",
  "\u8fd4\u56de",
  "\u5b8c\u6210",
  "close",
  "done",
  "finish",
  "completed",
  "back",
  "return",
  "cancel"
]

const IMAGE_TRANSLATION_DIRECT_MENU_KEYWORDS = [
  "\u4e2d\u6587\u2192\u82f1\u6587",
  "\u4e2d\u6587 \u2192 \u82f1\u6587",
  "\u4e2d\u6587->\u82f1\u6587",
  "\u4e2d\u6587 -> \u82f1\u6587",
  "\u4e2d\u6587\u5230\u82f1\u6587",
  "\u4e2d\u6587 \u5230 \u82f1\u6587",
  "\u4e2d\u8bd1\u82f1",
  "chinese\u2192english",
  "chinese \u2192 english",
  "chinese -> english"
]

const IMAGE_TRANSLATION_MENU_TRIGGER_KEYWORDS = [
  "\u4e00\u952e\u7ffb\u8bd1",
  "\u5feb\u901f\u7ffb\u8bd1",
  "\u7ffb\u8bd1",
  "translate",
  "translation"
]

const IMAGE_TRANSLATION_ALIBABA_ENGINE_MENU_KEYWORDS = [
  "\u963f\u91cc\u7ffb\u8bd1",
  "\u963f\u91cc",
  "alibaba"
]

const IMAGE_TRANSLATION_SOURCE_LANGUAGE_KEYWORDS = [
  "\u4e2d\u6587",
  "\u7b80\u4f53\u4e2d\u6587",
  "chinese",
  "chinese (simplified)"
]

const IMAGE_TRANSLATION_TARGET_LANGUAGE_KEYWORDS = [
  "\u82f1\u6587",
  "\u82f1\u8bed",
  "english"
]

const IMAGE_TRANSLATION_RESULT_DIALOG_HINTS = [
  "\u56fe\u7247\u7ffb\u8bd1",
  "\u7ffb\u8bd1\u5b8c\u6210",
  "\u624b\u52a8\u8c03\u6574",
  "\u4fdd\u7559\u539f\u56fe",
  "\u5f3a\u5236\u8bc6\u522b",
  "\u72b6\u6001",
  "\u8be6\u60c5",
  "\u5df2\u7ffb\u8bd1\u6210\u529f",
  "\u7ffb\u8bd1\u5931\u8d25"
]

const IMAGE_TRANSLATION_RESULT_CONFIRM_KEYWORDS = [
  "\u786e\u8ba4",
  "\u786e\u5b9a",
  "\u5b8c\u6210",
  "\u4f7f\u7528",
  "\u5e94\u7528",
  "\u4fdd\u5b58",
  "\u77e5\u9053\u4e86",
  "\u6211\u77e5\u9053\u4e86",
  "\u7ee7\u7eed",
  "confirm",
  "apply",
  "save",
  "done"
]

const IMAGE_TRANSLATION_DIALOG_HINT_KEYWORDS = [
  ...IMAGE_TRANSLATION_RESULT_DIALOG_HINTS,
  "\u5feb\u901f\u7ffb\u8bd1",
  "\u4e00\u952e\u7ffb\u8bd1",
  "\u81ea\u5b9a\u4e49\u7ffb\u8bd1",
  "\u9ad8\u7ea7\u7ffb\u8bd1",
  "\u6e90\u8bed\u8a00",
  "\u76ee\u6807\u8bed\u8a00",
  "\u963f\u91cc\u7ffb\u8bd1"
]

const IMAGE_CHECK_DIALOG_HINT_KEYWORDS = [
  "\u56fe\u7247\u68c0\u6d4b",
  "\u56fe\u7247\u5305\u542b\u6587\u5b57",
  "\u6c34\u5370",
  "\u4ea7\u54c1\u56fe\u5c3a\u5bf8\u4e0d\u5408\u89c4",
  "\u63cf\u8ff0\u56fe\u5c3a\u5bf8\u4e0d\u5408\u89c4",
  "\u56fe\u7247\u8fc7\u5927",
  "\u56fe\u7247\u94fe\u63a5\u5931\u6548",
  "\u6279\u91cf\u64cd\u4f5c"
]

const IMAGE_TRANSLATION_RESULT_READY_KEYWORDS = [
  "\u624b\u52a8\u8c03\u6574",
  "\u4fdd\u7559\u539f\u56fe",
  "\u5f3a\u5236\u8bc6\u522b",
  "\u8bd1\u56fe",
  "\u4e2d\u6587-\u82f1\u6587",
  "\u4e2d\u6587-\u82f1\u8bed",
  "\u82f1\u6587-\u4e2d\u6587",
  "\u82f1\u8bed-\u4e2d\u6587"
]

const IMAGE_TRANSLATION_RESULT_PATTERN = /(?:\u5df2)?\u7ffb\u8bd1\u6210\u529f\s*(\d+)\s*\u5f20(?:\u56fe\u7247|\u56fe)[\uff0c, ]*\u7ffb\u8bd1\u5931\u8d25\s*(\d+)\s*\u5f20(?:\u56fe\u7247|\u56fe)/i
const IMAGE_TRANSLATION_STATUS_PATTERN = /\u72b6\u6001[:\uff1a]?\s*([^\s\uff0c,.\u3002]+)/i
const IMAGE_TRANSLATION_IN_PROGRESS_STATUS_KEYWORDS = [
  "\u8fdb\u884c\u4e2d",
  "\u5904\u7406\u4e2d",
  "\u7ffb\u8bd1\u4e2d",
  "\u6392\u961f\u4e2d",
  "\u7b49\u5f85\u4e2d"
]
const IMAGE_TRANSLATION_SUCCESS_STATUS_KEYWORDS = [
  "\u5b8c\u6210",
  "\u5df2\u5b8c\u6210",
  "\u6210\u529f",
  "done",
  "finished",
  "completed",
  "success"
]
const IMAGE_TRANSLATION_COMPLETION_TIMEOUT_MS = 300_000

const SAVE_BUTTON_KEYWORDS = [
  "\u4fdd\u5b58\u8349\u7a3f",
  "\u4fdd\u5b58",
  "\u6682\u5b58",
  "save draft",
  "save",
  "娣囨繂鐡ㄩ懡澶岊焾",
  "娣囨繂鐡?",
  "閺嗗倸鐡?"
]

const SUBMIT_BUTTON_KEYWORDS = [
  "\u53d1\u5e03",
  "\u63d0\u4ea4",
  "\u7acb\u5373\u520a\u767b",
  "\u520a\u767b",
  "submit",
  "publish",
  "閸欐垵绔?",
  "閹绘劒姘?",
  "缁斿宓嗛崚濠勬"
]

const LOGIN_OR_CAPTCHA_KEYWORDS = [
  "\u767b\u5f55",
  "\u8bf7\u767b\u5f55",
  "\u9a8c\u8bc1\u7801",
  "\u4eba\u673a\u9a8c\u8bc1",
  "login",
  "sign in",
  "captcha",
  "verify"
]

const PUBLISH_SURFACE_HINTS = [
  "\u6807\u9898",
  "\u4ef7\u683c",
  "\u552e\u4ef7",
  "\u5e93\u5b58",
  "\u5546\u54c1",
  "\u520a\u767b",
  "title",
  "price",
  "stock",
  "sku",
  "product",
  "publish"
]

const countVisible = async (locator: Locator, maxCount = 80) => {
  const count = Math.min(await locator.count().catch(() => 0), maxCount)
  let visibleCount = 0

  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) {
      visibleCount += 1
    }
  }

  return visibleCount
}

const safeArtifactName = (value: string) => value.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()
const cleanVisibleText = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()
const DEFAULT_ORIGIN_COUNTRY = "\u4e2d\u56fd\u5927\u9646"
const DEFAULT_ORIGIN_PROVINCE = "\u6d59\u6c5f\u7701"
const SELECT_PLACEHOLDER_TEXT = "\u8bf7\u9009\u62e9"
const SITE_WAREHOUSE_LABEL_TEXT = "\u9009\u62e9\u4ed3\u5e93"
const SITE_WAREHOUSE_REQUIRED_TEXT = "\u8bf7\u9009\u62e9\u7ad9\u70b9\u4ed3\u5e93"
const SITE_WAREHOUSE_SYNC_KEYWORDS = ["\u540c\u6b65"]
const VARIANT_INFO_SECTION_HINT_TEXT = "\u53d8\u79cd\u4fe1\u606f"
const VARIANT_INFO_SKU_CLASSIFICATION_TEXT = "SKU\u5206\u7c7b"
const VARIANT_INFO_PACKING_LIST_TEXT = "\u5305\u88c5\u6e05\u5355"
const VARIANT_ATTRIBUTE_SECTION_HINT_TEXT = "\u53d8\u79cd\u5c5e\u6027"
const VARIANT_ATTRIBUTE_REFERENCE_TEMPLATE_HINT_TEXT = "\u5f15\u7528\u6a21\u677f"
const VARIANT_ATTRIBUTE_REFERENCE_TEMPLATE_PLACEHOLDER_TEXT = `---${SELECT_PLACEHOLDER_TEXT}${VARIANT_ATTRIBUTE_REFERENCE_TEMPLATE_HINT_TEXT}---`
const VARIANT_ATTRIBUTE_FOCUS_LABEL_TEXT = "\u91cd\u70b9\u5c55\u793a\u90e8\u4f4d"
const VARIANT_ATTRIBUTE_REMAP_LABEL_TEXT = "\u91cd\u65b0\u5bf9\u5e94\u53d8\u79cd"
const SHIPMENT_PROMISE_LABEL_TEXT = "\u627f\u8bfa\u53d1\u8d27\u65f6\u6548"
const SHIPMENT_PROMISE_REQUIRED_TEXT = "\u8bf7\u9009\u62e9\u627f\u8bfa\u53d1\u8d27\u65f6\u6548"
const SHIPMENT_PROMISE_OPTION_TEXTS = [
  "1\u4e2a\u5de5\u4f5c\u65e5\u5185\u53d1\u8d27",
  "2\u4e2a\u5de5\u4f5c\u65e5\u5185\u53d1\u8d27",
  "7\u4e2a\u5de5\u4f5c\u65e5\u5185\u53d1\u8d27",
  "9\u4e2a\u5de5\u4f5c\u65e5\u5185\u53d1\u8d27"
]
const FREIGHT_TEMPLATE_LABEL_TEXT = "\u8fd0\u8d39\u6a21\u677f"
const FREIGHT_TEMPLATE_REQUIRED_TEXT = "\u8bf7\u9009\u62e9\u8fd0\u8d39\u6a21\u677f"
const SHIPMENT_SYNC_KEYWORDS = ["\u540c\u6b65"]
const REPAIR_DECLARED_PRICE_FALLBACK = "9.99"
const REPAIR_SKU_LENGTH_FALLBACK = "35"
const REPAIR_SKU_WIDTH_FALLBACK = "25"
const REPAIR_SKU_HEIGHT_FALLBACK = "1"
const REPAIR_SKU_WEIGHT_G_FALLBACK = "180"
const COLOR_SKC_MAX_GROUPS = 20
const COLOR_SKC_RECALC_TIMEOUT_MS = 15_000
const COLOR_SKC_OPTION_WAIT_TIMEOUT_MS = 8_000
const COLOR_SKC_OPTION_HYDRATE_TIMEOUT_MS = 30_000
const COLOR_SKC_OPTION_REVEAL_TIMEOUT_MS = 10_000
const VARIANT_REMAP_ROW_WAIT_TIMEOUT_MS = 12_000
const COLOR_SKC_SECTION_SELECTOR = ".skuAttrItem_1001"
const COLOR_SKC_ROW_SELECTOR = ".batch-table-wrap.color-table tbody tr"
const COLOR_SKC_OPTION_SELECTORS = [
  "label.d-checkbox.mr-8",
  ".sku-option label.d-checkbox",
  "label.d-checkbox",
  ".checkbox-group-with-search label",
  ".options-module label",
  ".theme-value-edit",
  ".theme-value-text",
  ".options-module .theme-value-edit",
  ".options-module .theme-value-text"
]
const COLOR_SKC_REMAP_KEYWORDS = ["重新对应变种", "重新对应"]
const VARIANT_REMAP_SURFACE_HINT_KEYWORDS = ["重新对应变种", "变种属性", "变种信息"]
const VARIANT_REMAP_MODAL_HINT_KEYWORDS = [
  "重新对应变种",
  "1688 变种主题",
  "对应Temu半托管变种主题",
  "分类对应",
  "产品信息"
]
const VARIANT_REMAP_PROGRESS_KEYWORDS = ["下一步", "继续"]
const VARIANT_REMAP_FILL_KEYWORDS = ["一键填充"]
const VARIANT_REMAP_CONFIRM_KEYWORDS = ["确定", "确认", "完成", "保存", "应用", "提交"]
const VARIANT_REMAP_NEGATIVE_KEYWORDS = ["返回", "取消", "关闭"]
const VARIANT_REMAP_CUSTOM_NAME_HINT_TEXT = "自定义名称"
const SIZE_CHART_TEMPLATE_SUFFIX = "\u5e97\u5c0f\u79d8\u6a21\u677f"

const readVisibleText = async (locator: Locator | null) =>
  locator ? cleanVisibleText(await locator.innerText().catch(() => "")) : ""

const SKU_ROW_FIELD_SELECTOR = [
  'input[name*="variationSku" i]:not([type="search"])',
  'input[name*="skuAttrCode" i]:not([type="search"])',
  'input[name*="price" i]:not([type="search"])',
  'input[name*="stock" i]:not([type="search"])',
  'input[placeholder*="\u4ef7\u683c" i]:not([type="search"])',
  'input[placeholder*="\u5e93\u5b58" i]:not([type="search"])',
  'input[placeholder*="\u8d27\u53f7" i]:not([type="search"])',
  'input[placeholder*="\u4e0d\u80fd\u5305\u542b\u4e2d\u6587" i]:not([type="search"])',
  'input[aria-label*="\u4ef7\u683c" i]:not([type="search"])',
  'input[aria-label*="\u5e93\u5b58" i]:not([type="search"])',
  'input[aria-label*="\u8d27\u53f7" i]:not([type="search"])'
].join(", ")

const visibleAntModalLocators = async (page: Page) => {
  const modals = page.locator(".ant-modal:visible")
  const modalCount = Math.min(await modals.count().catch(() => 0), 12)
  const visibleModals: Locator[] = []

  for (let index = 0; index < modalCount; index += 1) {
    const modal = modals.nth(index)
    if (await modal.isVisible().catch(() => false)) {
      visibleModals.push(modal)
    }
  }

  return visibleModals
}

const visibleAntModalWrapLocators = async (page: Page) => {
  const wraps = page.locator(".ant-modal-wrap:visible")
  const wrapCount = Math.min(await wraps.count().catch(() => 0), 12)
  const visibleWraps: Locator[] = []

  for (let index = 0; index < wrapCount; index += 1) {
    const wrap = wraps.nth(index)
    if (await wrap.isVisible().catch(() => false)) {
      visibleWraps.push(wrap)
    }
  }

  return visibleWraps
}

const visibleModalCandidates = async (page: Page) => {
  const seen = new Set<string>()
  const dialogs: Locator[] = []

  for (const dialog of [
    ...await visibleAntModalLocators(page),
    ...await visibleAntModalWrapLocators(page),
    ...await visibleDialogLocators(page)
  ]) {
    const key = await locatorIdentityKey(dialog)
    if (!key || seen.has(key)) {
      continue
    }
    seen.add(key)
    dialogs.push(dialog)
  }

  return dialogs
}

const waitForVisibleModalCandidateCountAtMost = async (page: Page, maximumVisibleDialogs: number, timeoutMs = 8_000) => {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if ((await visibleModalCandidates(page)).length <= maximumVisibleDialogs) {
      return true
    }

    await page.waitForTimeout(250)
  }

  return (await visibleModalCandidates(page)).length <= maximumVisibleDialogs
}

const locatorIdentityKey = async (locator: Locator) =>
  locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const className = typeof (element as HTMLElement).className === "string"
      ? (element as HTMLElement).className
      : ""
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80)
    return [
      element.tagName.toLowerCase(),
      className.slice(0, 120),
      `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`,
      text
    ].join("|")
  }).catch(() => "")

const isLikelyFloatingPanel = async (locator: Locator) =>
  locator.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      return false
    }

    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const zIndex = Number.parseInt(style.zIndex || "0", 10)
    const className = typeof element.className === "string" ? element.className : ""
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim()
    const hasInteractiveDescendant = Boolean(element.querySelector(
      "button, [role='button'], input, select, textarea, .ant-btn, .ant-select, .ant-dropdown-menu-item"
    ))
    const looksFloating = ["fixed", "absolute", "sticky"].includes(style.position) || zIndex >= 100
    const looksPanelClass = /(dialog|modal|popup|layer|drawer|overlay|result|preview|translate|editor)/i.test(className)
    const withinViewportBounds =
      rect.width >= 180
      && rect.height >= 80
      && rect.width <= window.innerWidth * 0.98
      && rect.height <= window.innerHeight * 0.95
    const nearViewport = rect.top < window.innerHeight && rect.left < window.innerWidth

    return looksFloating
      && looksPanelClass
      && withinViewportBounds
      && nearViewport
      && hasInteractiveDescendant
      && text.length > 0
  }).catch(() => false)

const collectLikelyFloatingPanels = async (page: Page, maxCount = 40) => {
  const roots = page.locator("body > div, body > section, body > aside")
  const count = Math.min(await roots.count().catch(() => 0), maxCount)
  const panels: Locator[] = []

  for (let index = 0; index < count; index += 1) {
    const item = roots.nth(index)
    if (!await item.isVisible().catch(() => false)) {
      continue
    }

    if (await isLikelyFloatingPanel(item)) {
      panels.push(item)
    }
  }

  return panels
}

const isLikelyDialogContainer = async (locator: Locator) =>
  locator.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      return false
    }

    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const className = typeof element.className === "string" ? element.className : ""
    const role = element.getAttribute("role") ?? ""
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim()
    const interactiveCount = element.querySelectorAll(
      "button, [role='button'], input, select, textarea, .ant-btn, .ant-select, .ant-dropdown-menu-item"
    ).length
    const hasCloseControl = Boolean(element.querySelector(
      ".ant-modal-close, .el-dialog__headerbtn, .modal-close, [class*='close'], [id*='close' i], [aria-label*='close' i], [title*='close' i]"
    ))
    const hasDialogSemantics =
      role === "dialog"
      || element.getAttribute("aria-modal") === "true"
      || /(dialog|modal|popup|drawer|translate|preview|editor|crop)/i.test(className)
    const mentionsMediaFlow = /(图片翻译|选择全部|一键翻译|快速翻译|批量改图片尺寸|批量编辑|开始翻译|确认翻译|image translation|white background|image editor|review and save image edits|save image|batch resize|image management|normalize image dimensions|file sizes|apply resize|use selected)/i.test(text)
    const minimumHeight = hasDialogSemantics && (hasCloseControl || mentionsMediaFlow) ? 80 : 140
    const withinBounds =
      rect.width >= 260
      && rect.height >= minimumHeight
      && rect.width <= window.innerWidth
      && rect.height <= window.innerHeight

    return withinBounds
      && hasDialogSemantics
      && interactiveCount >= 2
      && (hasCloseControl || mentionsMediaFlow)
      && style.display !== "none"
      && style.visibility !== "hidden"
  }).catch(() => false)

const waitForVisibleAntModalCountAtMost = async (page: Page, maximumVisibleDialogs: number, timeoutMs = 8_000) => {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if ((await visibleAntModalLocators(page)).length <= maximumVisibleDialogs) {
      return true
    }

    await page.waitForTimeout(250)
  }

  return (await visibleAntModalLocators(page)).length <= maximumVisibleDialogs
}

const selectAntOption = async (
  page: Page,
  select: Locator,
  desiredTexts: string[],
  searchText = desiredTexts[0] ?? ""
) => {
  await select.scrollIntoViewIfNeeded()
  await select.click()
  await page.waitForTimeout(250)

  const searchInput = select.locator("input.ant-select-selection-search-input").first()
  const canTypeSearch = searchText
    && await searchInput.count().catch(() => 0) > 0
    && await searchInput.isEditable().catch(() => false)

  if (canTypeSearch) {
    await searchInput.fill(searchText)
    await page.waitForTimeout(350)
  }

  const currentValue = cleanVisibleText(await select.innerText().catch(() => ""))
  if (currentValue && desiredTexts.some((text) => currentValue === text || currentValue.includes(text))) {
    await page.keyboard.press("Escape").catch(() => {})
    return currentValue
  }

  const options = page.locator(".ant-select-dropdown:visible .ant-select-item-option-content")
  const optionCount = Math.min(await options.count().catch(() => 0), 120)
  for (let index = 0; index < optionCount; index += 1) {
    const option = options.nth(index)
    const optionText = cleanVisibleText(await option.innerText().catch(() => ""))
    if (!optionText) {
      continue
    }

    const matched = desiredTexts.some((text) => optionText === text || optionText.includes(text))
    if (!matched) {
      continue
    }

    await option.click()
    await page.waitForTimeout(250)
    return optionText
  }

  await page.keyboard.press("Escape").catch(() => {})
  return null
}

const findSiteWarehouseContainer = async (page: Page) => {
  const locator = page.locator([
    ".flex-y-center.whitespace-nowrap.mb-12",
    ".sku-data-table",
    ".ant-form-item",
    "tr",
    "div"
  ].join(", ")).filter({
    hasText: new RegExp(`${SITE_WAREHOUSE_LABEL_TEXT}|${SITE_WAREHOUSE_REQUIRED_TEXT}`, "i")
  })

  const count = Math.min(await locator.count().catch(() => 0), 60)
  let best: {
    item: Locator
    score: number
  } | null = null

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index)
    if (!await item.isVisible().catch(() => false)) {
      continue
    }

    const text = cleanVisibleText(await item.innerText().catch(() => ""))
    if (!text.includes(SITE_WAREHOUSE_LABEL_TEXT)) {
      continue
    }

    const selectCount = await countVisible(item.locator(".ant-select"), 10)
    if (selectCount <= 0) {
      continue
    }

    const syncCount = await countVisible(item.locator("button, a, [role='button'], .link, span").filter({
      hasText: new RegExp(SITE_WAREHOUSE_SYNC_KEYWORDS.map(escapeRegExp).join("|"), "i")
    }), 10)
    const box = await item.boundingBox().catch(() => null)
    const areaPenalty = box ? Math.round((box.width * box.height) / 1000) : 10_000
    const score = text.length + areaPenalty + (selectCount * 200) - (syncCount * 120)

    if (!best || score < best.score) {
      best = {
        item,
        score
      }
    }
  }

  return best?.item ?? null
}

const findVariantInfoContainer = async (page: Page) => {
  const locator = page.locator([
    ".sku-data-table",
    ".skuWarehouse",
    ".commonCard",
    ".commonCardCon",
    ".ant-form-item",
    "div"
  ].join(", ")).filter({
    hasText: new RegExp([
      VARIANT_INFO_SECTION_HINT_TEXT,
      SITE_WAREHOUSE_LABEL_TEXT,
      VARIANT_INFO_SKU_CLASSIFICATION_TEXT,
      VARIANT_INFO_PACKING_LIST_TEXT
    ].map(escapeRegExp).join("|"), "i")
  })

  const count = Math.min(await locator.count().catch(() => 0), 80)
  let best: {
    item: Locator
    score: number
  } | null = null

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index)
    if (!await item.isVisible().catch(() => false)) {
      continue
    }

    const text = cleanVisibleText(await item.innerText().catch(() => ""))
    const hasWarehouse = text.includes(SITE_WAREHOUSE_LABEL_TEXT)
    const hasSkuClassification = text.includes(VARIANT_INFO_SKU_CLASSIFICATION_TEXT)
    const hasPackingList = text.includes(VARIANT_INFO_PACKING_LIST_TEXT)
    if (!hasWarehouse && !hasSkuClassification && !hasPackingList) {
      continue
    }

    const className = await item.evaluate((element) =>
      typeof (element as HTMLElement).className === "string"
        ? (element as HTMLElement).className
        : ""
    ).catch(() => "")
    const selectCount = await countVisible(item.locator(".ant-select"), 10)
    const tableCount = await countVisible(item.locator("table, .myj-table, [class*='table' i]"), 10)
    const fieldCount = await countVisible(item.locator(SKU_ROW_FIELD_SELECTOR), 20)
    const box = await item.boundingBox().catch(() => null)
    const areaPenalty = box ? Math.round((box.width * box.height) / 1000) : 10_000
    const score =
      text.length
      + areaPenalty
      - (hasWarehouse ? 320 : 0)
      - (hasSkuClassification ? 260 : 0)
      - (hasPackingList ? 260 : 0)
      - (/sku-data-table|skuWarehouse/i.test(className) ? 520 : 0)
      - (selectCount > 0 ? 120 : 0)
      - (tableCount > 0 ? 80 : 0)
      - (fieldCount * 160)

    if (!best || score < best.score) {
      best = {
        item,
        score
      }
    }
  }

  return best?.item ?? null
}

const readVisibleAntSelectOptions = async (page: Page) => {
  const options = page.locator(".ant-select-dropdown:visible .ant-select-item-option")
  const count = Math.min(await options.count().catch(() => 0), 120)
  const collected: string[] = []

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index)
    if (!await option.isVisible().catch(() => false)) {
      continue
    }

    const text = cleanVisibleText(await option.innerText().catch(() => ""))
    if (text) {
      collected.push(text)
    }
  }

  return collected
}

const collectAntSelectTexts = async (root: Page | Locator) =>
  root.locator(".ant-select").evaluateAll((nodes) =>
    nodes
      .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 12)
  ).catch(() => [] as string[])

const chooseFirstUsableAntSelectOption = async (
  page: Page,
  select: Locator
) => {
  await select.scrollIntoViewIfNeeded().catch(() => undefined)
  await clickAfterDianxiaomiIdle(page, select, 2)
  await page.waitForTimeout(350)

  const optionNodes = page.locator(".ant-select-dropdown:visible .ant-select-item-option")
  const optionCount = Math.min(await optionNodes.count().catch(() => 0), 120)
  const optionTexts: string[] = []

  for (let index = 0; index < optionCount; index += 1) {
    const option = optionNodes.nth(index)
    if (!await option.isVisible().catch(() => false)) {
      continue
    }

    const optionText = cleanVisibleText(await option.innerText().catch(() => ""))
    if (!optionText) {
      continue
    }
    optionTexts.push(optionText)

    const normalized = optionText.toLowerCase()
    if (
      normalized.includes(SELECT_PLACEHOLDER_TEXT.toLowerCase())
      || normalized.includes("\u65e0\u6570\u636e")
      || normalized.includes("\u6682\u65e0")
      || normalized.includes("\u672a\u914d\u7f6e")
      || normalized.includes("\u8bf7\u5148")
    ) {
      continue
    }

    await clickAfterDianxiaomiIdle(page, option, 2)
    await page.waitForTimeout(350)
    return {
      selectedText: optionText,
      optionTexts
    }
  }

  await page.keyboard.press("Escape").catch(() => {})
  return {
    selectedText: null,
    optionTexts
  }
}

const normalizeSiteWarehouse = async (page: Page) => {
  const container = await findSiteWarehouseContainer(page)
  if (!container) {
    return stepResult(
      "normalize-site-warehouse",
      "Normalize site warehouse",
      "skipped",
      "Site warehouse controls are not visible"
    )
  }

  const warehouseSelect = await firstVisible([
    container.locator(".ant-select").filter({ hasText: new RegExp(SELECT_PLACEHOLDER_TEXT, "i") }),
    container.locator(".ant-select")
  ])
  if (!warehouseSelect) {
    return stepResult(
      "normalize-site-warehouse",
      "Normalize site warehouse",
      "skipped",
      "Site warehouse select is not visible"
    )
  }

  const beforeText = await readVisibleText(warehouseSelect)
  const alreadySelected = beforeText && !beforeText.includes(SELECT_PLACEHOLDER_TEXT)
  if (alreadySelected) {
    return stepResult(
      "normalize-site-warehouse",
      "Normalize site warehouse",
      "skipped",
      `Site warehouse is already set: ${beforeText}`,
      {
        beforeText,
        afterText: beforeText
      }
    )
  }

  const syncButton = await findInteractiveInRootByKeywords(container, SITE_WAREHOUSE_SYNC_KEYWORDS)
  let syncClicked = false
  if (syncButton && await syncButton.isVisible().catch(() => false)) {
    await clickAfterDianxiaomiIdle(page, syncButton, 2).catch(() => undefined)
    syncClicked = true
    await page.waitForTimeout(1_200)
  }

  const selection = await chooseFirstUsableAntSelectOption(page, warehouseSelect)
  const afterText = await readVisibleText(warehouseSelect)
  const success = Boolean(selection.selectedText || (afterText && !afterText.includes(SELECT_PLACEHOLDER_TEXT)))

  return stepResult(
    "normalize-site-warehouse",
    "Normalize site warehouse",
    success ? "done" : "failed",
    success
      ? `Site warehouse set to ${selection.selectedText ?? afterText}`
      : "Could not select a site warehouse option",
    {
      beforeText,
      afterText,
      syncClicked,
      optionTexts: selection.optionTexts
    }
  )
}

const findShipmentFieldContainer = async (
  page: Page,
  labelText: string,
  options: {
    requireSelect?: boolean
    penalizeTexts?: string[]
  } = {}
) => {
  const locator = page.locator([
    ".shipment-wrapper .ant-form-item",
    ".shipment-wrapper .ant-row.ant-form-item-row",
    ".shipment-wrapper div",
    ".ant-form-item",
    ".ant-row.ant-form-item-row",
    "div"
  ].join(", ")).filter({
    hasText: new RegExp(escapeRegExp(labelText), "i")
  })

  const count = Math.min(await locator.count().catch(() => 0), 80)
  let best: {
    item: Locator
    score: number
  } | null = null

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index)
    if (!await item.isVisible().catch(() => false)) {
      continue
    }

    const text = cleanVisibleText(await item.innerText().catch(() => ""))
    if (!text.includes(labelText)) {
      continue
    }

    const selectCount = await countVisible(item.locator(".ant-select"), 10)
    if (options.requireSelect && selectCount <= 0) {
      continue
    }

    const className = await item.evaluate((element) =>
      typeof (element as HTMLElement).className === "string"
        ? (element as HTMLElement).className
        : ""
    ).catch(() => "")
    const box = await item.boundingBox().catch(() => null)
    const areaPenalty = box ? Math.round((box.width * box.height) / 1000) : 10_000
    const labelPenalty = (options.penalizeTexts ?? []).reduce((penalty, keyword) =>
      text.includes(keyword) ? penalty + 160 : penalty
    , 0)
    const score =
      text.length
      + areaPenalty
      + (options.requireSelect ? Math.abs(selectCount - 1) * 180 : selectCount * 120)
      + (/ant-form-item/i.test(className) ? -120 : 80)
      + labelPenalty

    if (!best || score < best.score) {
      best = {
        item,
        score
      }
    }
  }

  return best?.item ?? null
}

const readChoiceLikeState = async (locator: Locator | null) =>
  locator?.evaluate((element) => {
    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()
    const candidates = [
      element,
      element.closest("label"),
      element.closest("[role='radio']"),
      element.closest("[role='button']"),
      element.closest("[class*='radio' i]"),
      element.closest("[class*='option' i]"),
      element.closest("[class*='tag' i]")
    ].filter(Boolean) as HTMLElement[]
    const className = candidates
      .map((item) => typeof item.className === "string" ? item.className : "")
      .filter(Boolean)
      .join(" ")
      .trim()
    const firstAttr = (name: string) =>
      candidates
        .map((item) => item.getAttribute(name))
        .find((value) => Boolean(value)) ?? ""

    return {
      text: clean(element.textContent),
      className,
      role: firstAttr("role"),
      ariaChecked: firstAttr("aria-checked"),
      ariaSelected: firstAttr("aria-selected"),
      ariaDisabled: firstAttr("aria-disabled"),
      dataChecked: firstAttr("data-checked"),
      dataSelected: firstAttr("data-selected")
    }
  }).catch(() => null) ?? null

const choiceLooksSelected = (state: Awaited<ReturnType<typeof readChoiceLikeState>>) => {
  if (!state) {
    return false
  }

  return state.ariaChecked === "true"
    || state.ariaSelected === "true"
    || state.dataChecked === "true"
    || state.dataSelected === "true"
    || /(checked|selected|active|current|chosen|ant-radio-wrapper-checked|ant-segmented-item-selected)/i.test(state.className)
}

const choiceLooksDisabled = (state: Awaited<ReturnType<typeof readChoiceLikeState>>) => {
  if (!state) {
    return false
  }

  return state.ariaDisabled === "true"
    || /(disabled|forbidden)/i.test(state.className)
}

const normalizeShipmentPromise = async (page: Page) => {
  const promiseRows = page.locator(".shipment-wrapper .ant-form-item").filter({
    hasText: new RegExp(escapeRegExp(SHIPMENT_PROMISE_LABEL_TEXT), "i")
  })
  const promiseRowCount = Math.min(await promiseRows.count().catch(() => 0), 20)
  let row: Locator | null = null

  for (let index = 0; index < promiseRowCount; index += 1) {
    const candidate = promiseRows.nth(index)
    if (!await candidate.isVisible().catch(() => false)) {
      continue
    }

    const radioCount = await countVisible(candidate.locator("label.ant-radio-wrapper"), 10)
    if (radioCount <= 0) {
      continue
    }

    row = candidate
    break
  }
  if (!row) {
    return stepResult(
      "normalize-shipment-promise",
      "Normalize shipment promise",
      "skipped",
      "Shipment promise controls are not visible"
    )
  }

  const radioLocator = row.locator("label.ant-radio-wrapper")
  const radioCount = Math.min(await radioLocator.count().catch(() => 0), 40)
  const optionCandidates: Array<{
    optionText: string
    locator: Locator
    text: string
    checked: boolean
  }> = []

  for (let index = 0; index < radioCount; index += 1) {
    const item = radioLocator.nth(index)
    if (!await item.isVisible().catch(() => false)) {
      continue
    }

    const text = cleanVisibleText(await item.innerText().catch(() => ""))
    const optionText = SHIPMENT_PROMISE_OPTION_TEXTS.find((option) => text === option || text.includes(option))
    if (!optionText) {
      continue
    }

    const checked = await item.locator("input[type='radio']").first()
      .evaluate((element) => (element as HTMLInputElement).checked)
      .catch(() => false)
    optionCandidates.push({
      optionText,
      locator: item,
      text,
      checked
    })
  }

  const candidateTexts = optionCandidates.map((candidate) => candidate.text)
  const selectedCandidate = optionCandidates.find((candidate) => candidate.checked)
  if (selectedCandidate) {
    return stepResult(
      "normalize-shipment-promise",
      "Normalize shipment promise",
      "skipped",
      `Shipment promise is already set: ${selectedCandidate.optionText}`,
      {
        selectedText: selectedCandidate.optionText,
        candidateTexts
      }
    )
  }

  const target = SHIPMENT_PROMISE_OPTION_TEXTS
    .map((optionText) => optionCandidates.find((candidate) => candidate.optionText === optionText) ?? null)
    .find(Boolean) ?? null

  if (!target) {
    return stepResult(
      "normalize-shipment-promise",
      "Normalize shipment promise",
      "failed",
      "Could not find a usable shipment promise option",
      {
        candidateTexts
      }
    )
  }

  await target.locator.scrollIntoViewIfNeeded().catch(() => undefined)
  await clickAfterDianxiaomiIdle(page, target.locator, 2)
  await page.waitForTimeout(450)

  const verifiedSelected = await target.locator.locator("input[type='radio']").first()
    .evaluate((element) => (element as HTMLInputElement).checked)
    .catch(() => false)
  return stepResult(
    "normalize-shipment-promise",
    "Normalize shipment promise",
    "done",
    verifiedSelected
      ? `Shipment promise set to ${target.optionText}`
      : `Clicked shipment promise option ${target.optionText}`,
    {
      selectedText: target.optionText,
      verifiedSelected,
      candidateTexts
    }
  )
}

const normalizeFreightTemplate = async (page: Page) => {
  const row = await findShipmentFieldContainer(page, FREIGHT_TEMPLATE_LABEL_TEXT, {
    requireSelect: true,
    penalizeTexts: [SHIPMENT_PROMISE_LABEL_TEXT]
  })
  if (!row) {
    return stepResult(
      "normalize-freight-template",
      "Normalize freight template",
      "skipped",
      "Freight template controls are not visible"
    )
  }

  const templateSelect = await firstVisible([
    row.locator(".ant-select").filter({ hasText: new RegExp(SELECT_PLACEHOLDER_TEXT, "i") }),
    row.locator(".ant-select")
  ])
  if (!templateSelect) {
    return stepResult(
      "normalize-freight-template",
      "Normalize freight template",
      "skipped",
      "Freight template select is not visible"
    )
  }

  const beforeText = await readVisibleText(templateSelect)
  const alreadySelected = beforeText && !beforeText.includes(SELECT_PLACEHOLDER_TEXT)
  if (alreadySelected) {
    return stepResult(
      "normalize-freight-template",
      "Normalize freight template",
      "skipped",
      `Freight template is already set: ${beforeText}`,
      {
        beforeText,
        afterText: beforeText
      }
    )
  }

  const syncButton = await findInteractiveInRootByKeywords(row, SHIPMENT_SYNC_KEYWORDS)
  let syncClicked = false
  if (syncButton && await syncButton.isVisible().catch(() => false)) {
    await clickAfterDianxiaomiIdle(page, syncButton, 2).catch(() => undefined)
    syncClicked = true
    await page.waitForTimeout(1_000)
  }

  const selection = await chooseFirstUsableAntSelectOption(page, templateSelect)
  const afterText = await readVisibleText(templateSelect)
  const success = Boolean(selection.selectedText || (afterText && !afterText.includes(SELECT_PLACEHOLDER_TEXT)))

  return stepResult(
    "normalize-freight-template",
    "Normalize freight template",
    success ? "done" : "failed",
    success
      ? `Freight template set to ${selection.selectedText ?? afterText}`
      : "Could not select a freight template option",
    {
      beforeText,
      afterText,
      syncClicked,
      optionTexts: selection.optionTexts
    }
  )
}

const findVariantAttributeSection = async (page: Page) => {
  const locator = page.locator([
    ".product-add-layout [class*='form-card' i]",
    ".product-add-layout [class*='skuAttr' i]",
    ".product-add-layout .ant-card",
    ".product-add-layout .ant-form",
    ".product-add-layout div"
  ].join(", ")).filter({
    hasText: new RegExp([
      VARIANT_ATTRIBUTE_SECTION_HINT_TEXT,
      VARIANT_ATTRIBUTE_FOCUS_LABEL_TEXT,
      VARIANT_ATTRIBUTE_REMAP_LABEL_TEXT,
      VARIANT_ATTRIBUTE_REFERENCE_TEMPLATE_HINT_TEXT
    ].map(escapeRegExp).join("|"), "i")
  })

  const count = Math.min(await locator.count().catch(() => 0), 120)
  let best: {
    item: Locator
    score: number
  } | null = null

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index)
    if (!await item.isVisible().catch(() => false)) {
      continue
    }

    const text = cleanVisibleText(await item.innerText().catch(() => ""))
    if (!text) {
      continue
    }

    const selectTexts = await collectAntSelectTexts(item)
    const hasSection = text.includes(VARIANT_ATTRIBUTE_SECTION_HINT_TEXT)
    const hasFocus = text.includes(VARIANT_ATTRIBUTE_FOCUS_LABEL_TEXT)
    const hasRemap = text.includes(VARIANT_ATTRIBUTE_REMAP_LABEL_TEXT)
    const hasTemplate = selectTexts.some((value) =>
      value.includes(VARIANT_ATTRIBUTE_REFERENCE_TEMPLATE_HINT_TEXT)
      || value.includes(VARIANT_ATTRIBUTE_REFERENCE_TEMPLATE_PLACEHOLDER_TEXT)
    )
    if (!hasFocus && !hasRemap && !hasTemplate) {
      continue
    }

    const box = await item.boundingBox().catch(() => null)
    const areaPenalty = box ? Math.round((box.width * box.height) / 1_500) : 10_000
    const score =
      (hasSection ? 340 : 0)
      + (hasFocus ? 320 : 0)
      + (hasRemap ? 300 : 0)
      + (hasTemplate ? 260 : 0)
      + (Math.min(selectTexts.length, 4) * 70)
      - areaPenalty
      - Math.round(text.length / 12)

    if (!best || score > best.score) {
      best = {
        item,
        score
      }
    }
  }

  return best?.item ?? null
}

const findVariantAttributeFocusContainer = async (section: Locator) => {
  const locator = section.locator([
    ".ant-form-item",
    ".ant-row.ant-form-item-row",
    "div"
  ].join(", ")).filter({
    hasText: new RegExp(escapeRegExp(VARIANT_ATTRIBUTE_FOCUS_LABEL_TEXT), "i")
  })

  const count = Math.min(await locator.count().catch(() => 0), 40)
  let best: {
    item: Locator
    score: number
  } | null = null

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index)
    if (!await item.isVisible().catch(() => false)) {
      continue
    }

    const text = cleanVisibleText(await item.innerText().catch(() => ""))
    if (!text.includes(VARIANT_ATTRIBUTE_FOCUS_LABEL_TEXT)) {
      continue
    }

    const selectTexts = await collectAntSelectTexts(item)
    if (selectTexts.length <= 0) {
      continue
    }

    const className = await item.evaluate((element) =>
      typeof (element as HTMLElement).className === "string"
        ? (element as HTMLElement).className
        : ""
    ).catch(() => "")
    const box = await item.boundingBox().catch(() => null)
    const areaPenalty = box ? Math.round((box.width * box.height) / 1_000) : 10_000
    const score =
      300
      + (selectTexts.length * 90)
      + (/ant-form-item/i.test(className) ? 160 : 0)
      - areaPenalty
      - text.length

    if (!best || score > best.score) {
      best = {
        item,
        score
      }
    }
  }

  return best?.item ?? null
}

const normalizeVariantAttributes = async (page: Page) => {
  const beforeRows = await findSkuRows(page)
  const section = await findVariantAttributeSection(page)
  if (!section) {
    return stepResult(
      "normalize-variant-attributes",
      "Normalize variant attributes",
      "skipped",
      "Variant attribute controls are not visible on the current Dianxiaomi page",
      {
        beforeRows: beforeRows.length
      }
    )
  }

  const sectionText = normalizeFeedbackText(await section.innerText().catch(() => ""))
  const templateSelect = await firstVisible([
    section.locator(".ant-select").filter({
      hasText: new RegExp(escapeRegExp(VARIANT_ATTRIBUTE_REFERENCE_TEMPLATE_PLACEHOLDER_TEXT), "i")
    }),
    section.locator(".ant-select").filter({
      hasText: new RegExp(escapeRegExp(VARIANT_ATTRIBUTE_REFERENCE_TEMPLATE_HINT_TEXT), "i")
    })
  ])
  const templateBeforeText = await readVisibleText(templateSelect)
  const templateAlreadySelected = Boolean(
    templateBeforeText
    && !templateBeforeText.includes(SELECT_PLACEHOLDER_TEXT)
    && !templateBeforeText.includes(VARIANT_ATTRIBUTE_REFERENCE_TEMPLATE_PLACEHOLDER_TEXT)
  )
  let templateSelection = {
    visible: Boolean(templateSelect),
    beforeText: templateBeforeText,
    afterText: templateBeforeText,
    optionTexts: [] as string[],
    selectedText: null as string | null,
    status: "skipped" as StepStatus,
    detail: templateSelect
      ? templateAlreadySelected
        ? `Reference template is already set: ${templateBeforeText}`
        : "Reference template select is waiting for selection"
      : "Reference template select is not visible"
  }
  if (templateSelect && !templateAlreadySelected) {
    const selection = await chooseFirstUsableAntSelectOption(page, templateSelect)
    const afterText = await readVisibleText(templateSelect)
    const noUsableOptions = selection.optionTexts.length <= 0
    const success = Boolean(selection.selectedText || (afterText && !afterText.includes(SELECT_PLACEHOLDER_TEXT)))
    templateSelection = {
      visible: true,
      beforeText: templateBeforeText,
      afterText,
      optionTexts: selection.optionTexts,
      selectedText: selection.selectedText,
      status: success ? "done" : noUsableOptions ? "skipped" : "failed",
      detail: success
        ? `Reference template set to ${selection.selectedText ?? afterText}`
        : noUsableOptions
          ? "Reference template select has no usable options on the current Dianxiaomi page"
        : "Could not select a usable reference template option"
    }
    if (success) {
      await page.waitForTimeout(700)
    }
  }

  const focusContainer = await findVariantAttributeFocusContainer(section)
  const focusSelect = focusContainer
    ? await firstVisible([
      focusContainer.locator(".ant-select").filter({ hasText: new RegExp(SELECT_PLACEHOLDER_TEXT, "i") }),
      focusContainer.locator(".ant-select")
    ])
    : null
  const focusBeforeText = await readVisibleText(focusSelect)
  const focusAlreadySelected = Boolean(focusBeforeText && !focusBeforeText.includes(SELECT_PLACEHOLDER_TEXT))
  let focusSelection = {
    visible: Boolean(focusSelect),
    beforeText: focusBeforeText,
    afterText: focusBeforeText,
    optionTexts: [] as string[],
    selectedText: null as string | null,
    status: "skipped" as StepStatus,
    detail: focusSelect
      ? focusAlreadySelected
        ? `Focus display field is already set: ${focusBeforeText}`
        : "Focus display field is waiting for selection"
      : "Focus display field is not visible"
  }
  if (focusSelect && !focusAlreadySelected) {
    const selection = await chooseFirstUsableAntSelectOption(page, focusSelect)
    const afterText = await readVisibleText(focusSelect)
    const noUsableOptions = selection.optionTexts.length <= 0
    const success = Boolean(selection.selectedText || (afterText && !afterText.includes(SELECT_PLACEHOLDER_TEXT)))
    focusSelection = {
      visible: true,
      beforeText: focusBeforeText,
      afterText,
      optionTexts: selection.optionTexts,
      selectedText: selection.selectedText,
      status: success ? "done" : noUsableOptions ? "skipped" : "failed",
      detail: success
        ? `Focus display field set to ${selection.selectedText ?? afterText}`
        : noUsableOptions
          ? "Focus display field has no usable options on the current Dianxiaomi page"
        : "Could not select a usable focus display option"
    }
  }

  const afterRows = await waitForVariantRowsReady(page, beforeRows.length, 6_000).catch(() => beforeRows)
  const failedSelections = [templateSelection, focusSelection].filter((item) => item.status === "failed")
  const appliedSelections = [templateSelection, focusSelection].filter((item) => item.status === "done")
  const visibleSelections = [templateSelection, focusSelection].filter((item) => item.visible)
  const rowsMaterialized = afterRows.length > beforeRows.length
  const detail = rowsMaterialized
    ? `Variant attributes normalized and variant rows materialized (${beforeRows.length} -> ${afterRows.length})`
    : failedSelections.length > 0
      ? failedSelections.map((item) => item.detail).join("; ")
    : appliedSelections.length > 0
      ? `Variant attributes normalized: ${appliedSelections.map((item) => item.detail).join("; ")}`
      : visibleSelections.length > 0
        ? "Variant attribute selects are already set"
        : "Variant attribute selects are not visible on the current Dianxiaomi page"

  return stepResult(
    "normalize-variant-attributes",
    "Normalize variant attributes",
    failedSelections.length > 0 ? "failed" : rowsMaterialized || appliedSelections.length > 0 ? "done" : "skipped",
    detail,
    {
      beforeRows: beforeRows.length,
      afterRows: afterRows.length,
      sectionText,
      templateSelection,
      focusSelection
    }
  )
}

export const findFieldByKeyword = async (page: Page, keywords: string[]) => {
  const uniqueKeywords = Array.from(new Set(keywords))
  const selectorLocators = uniqueKeywords.flatMap((keyword) => [
    page.getByLabel(keyword, { exact: false }),
    page.getByPlaceholder(keyword, { exact: false }),
    page.locator(`input:not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit']):not([type='file'])[name*="${keyword}" i], textarea[name*="${keyword}" i]`),
    page.locator(`input:not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit']):not([type='file'])[aria-label*="${keyword}" i], textarea[aria-label*="${keyword}" i]`)
  ])

  const directMatch = await firstVisibleTextWritable(selectorLocators)
  if (directMatch) {
    return directMatch
  }

  const labelNodes = page.locator("label, span, div, p, strong").filter({
    hasText: new RegExp(uniqueKeywords.map(escapeRegExp).join("|"), "i")
  })

  const labelCount = Math.min(await labelNodes.count(), 40)
  for (let index = 0; index < labelCount; index += 1) {
    const node = labelNodes.nth(index)
    const containers = [
      node.locator("xpath=ancestor-or-self::label[1]"),
      node.locator("xpath=ancestor::*[contains(translate(@class,'FORMFIELDITEMROW','formfielditemrow'),'form')][1]"),
      node.locator("xpath=ancestor::*[contains(translate(@class,'FORMFIELDITEMROW','formfielditemrow'),'field')][1]"),
      node.locator("xpath=..")
    ]

    for (const container of containers) {
      const field = await firstVisibleTextWritable([container.locator(EDITABLE_SELECTOR)])
      if (field) {
        return field
      }
    }
  }

  return null
}

const findField = async (page: Page, kind: FieldKind, config?: DianxiaomiSelectorConfig) => {
  const configured = await findByConfiguredSelectors(page, config?.fields?.[kind])
  if (configured) {
    return configured
  }

  return findFieldByKeyword(page, getFieldKeywords(kind))
}

const fillTextField = async (field: Locator, value: string) => {
  await field.scrollIntoViewIfNeeded()
  const tagName = await field.evaluate((element) => element.tagName.toLowerCase())
  const isContentEditable = await field.evaluate((element) => element.getAttribute("contenteditable") === "true")
  const inputType = tagName === "input"
    ? await field.evaluate((element) => (element as HTMLInputElement).type || "").catch(() => "")
    : ""

  if (isContentEditable) {
    await field.click()
    await field.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
    await field.type(value)
    return
  }

  if (tagName === "input" || tagName === "textarea") {
    if (["checkbox", "radio", "button", "submit", "file"].includes(inputType.toLowerCase())) {
      throw new Error(`unsupported text fill target: input[type=${inputType || "unknown"}]`)
    }
    await field.fill(value)
    return
  }

  await field.click()
  await field.type(value)
}

const isTextWritableField = async (field: Locator | null) => {
  if (!field || !await field.isVisible().catch(() => false)) {
    return false
  }

  const fieldMeta = await field.evaluate((element) => {
    const tagName = element.tagName.toLowerCase()
    const contentEditable = element.getAttribute("contenteditable") === "true"
    const inputType = tagName === "input" ? ((element as HTMLInputElement).type || "").toLowerCase() : ""
    return {
      tagName,
      contentEditable,
      inputType
    }
  }).catch(() => null as { tagName: string; contentEditable: boolean; inputType: string } | null)

  if (!fieldMeta) {
    return false
  }

  if (fieldMeta.contentEditable || fieldMeta.tagName === "textarea") {
    return true
  }

  if (fieldMeta.tagName !== "input") {
    return false
  }

  return !["checkbox", "radio", "button", "submit", "file"].includes(fieldMeta.inputType)
}

const firstVisibleTextWritable = async (locators: Locator[]) => {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0)

    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index)
      if (await isTextWritableField(item)) {
        return item
      }
    }
  }

  return null
}

const normalizeMaterialComposition = async (page: Page) => {
  const compositionItems = page.locator(".attr-form-item").filter({
    hasText: "\u6210\u5206"
  })
  const compositionCount = Math.min(await compositionItems.count().catch(() => 0), 4)
  let normalizedGroups = 0
  let removedRows = 0
  let updatedPercentInputs = 0
  const blockedGroups: string[] = []

  for (let index = 0; index < compositionCount; index += 1) {
    const item = compositionItems.nth(index)
    const selectTexts = await item.locator(".ant-select").evaluateAll((nodes) =>
      nodes.map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
    ).catch(() => [] as string[])
    const blankSelectCount = selectTexts.filter((text) => text.includes(SELECT_PLACEHOLDER_TEXT)).length

    if (blankSelectCount === 0) {
      continue
    }

    const percentInputs = item.locator("input.ant-input.input-number")
    if (await percentInputs.count().catch(() => 0) === 0) {
      blockedGroups.push(`composition-${index + 1}-missing-percent-input`)
      continue
    }

    await fillTextField(percentInputs.first(), "100")
    updatedPercentInputs += 1

    const removeButtons = item.locator(".icon_remove")
    let removedForGroup = 0
    while (removedForGroup < blankSelectCount && await removeButtons.count().catch(() => 0) > 0) {
      await removeButtons.last().click()
      removedForGroup += 1
      await page.waitForTimeout(250)
    }

    if (removedForGroup < blankSelectCount) {
      blockedGroups.push(`composition-${index + 1}-remove-shortfall-${removedForGroup}/${blankSelectCount}`)
      continue
    }

    normalizedGroups += 1
    removedRows += removedForGroup
  }

  if (blockedGroups.length > 0) {
    return stepResult(
      "normalize-material-composition",
      "Normalize material composition",
      "failed",
      "Could not fully normalize blank material composition rows",
      {
        compositionCount,
        normalizedGroups,
        removedRows,
        updatedPercentInputs,
        blockedGroups
      }
    )
  }

  if (normalizedGroups === 0) {
    return stepResult(
      "normalize-material-composition",
      "Normalize material composition",
      "skipped",
      "No blank material composition rows required normalization",
      {
        compositionCount
      }
    )
  }

  return stepResult(
    "normalize-material-composition",
    "Normalize material composition",
    "done",
    `Normalized ${normalizedGroups} material composition group(s)`,
    {
      compositionCount,
      normalizedGroups,
      removedRows,
      updatedPercentInputs
    }
  )
}

const normalizeOriginProvince = async (page: Page) => {
  const originSelects = page.locator(".productOrigin .ant-select")
  const selectCount = await originSelects.count().catch(() => 0)
  if (selectCount < 2) {
    return stepResult(
      "normalize-origin-province",
      "Normalize origin province",
      "skipped",
      "Origin country/province controls are not visible"
    )
  }

  const countrySelect = originSelects.nth(0)
  const provinceSelect = originSelects.nth(1)
  const countryText = await readVisibleText(countrySelect)
  const provinceText = await readVisibleText(provinceSelect)
  const provinceMissing = !provinceText || provinceText.includes(SELECT_PLACEHOLDER_TEXT)

  if (!countryText.includes(DEFAULT_ORIGIN_COUNTRY) || !provinceMissing) {
    return stepResult(
      "normalize-origin-province",
      "Normalize origin province",
      "skipped",
      provinceMissing
        ? `Origin country does not require default province handling: ${countryText || "unknown"}`
        : `Origin province is already set: ${provinceText}`,
      {
        countryText,
        provinceText
      }
    )
  }

  const selectedProvince = await selectAntOption(page, provinceSelect, [DEFAULT_ORIGIN_PROVINCE])
  if (!selectedProvince) {
    return stepResult(
      "normalize-origin-province",
      "Normalize origin province",
      "failed",
      `Could not select the default origin province: ${DEFAULT_ORIGIN_PROVINCE}`,
      {
        countryText,
        provinceText
      }
    )
  }

  return stepResult(
    "normalize-origin-province",
    "Normalize origin province",
    "done",
    `Origin province set to ${selectedProvince}`,
    {
      countryText,
      provinceText: selectedProvince
    }
  )
}

type SizeChartMetricState = {
  totalMetricInputs: number
  filledMetricInputs: number
  sampleValues: string[]
}

type SizeChartManualFillResult = {
  applied: boolean
  reason: string
  category: string
  filledInputs: number
  templateNameApplied?: string | null
  rows: Array<{
    sizeLabel: string
    values: string[]
  }>
}

const BRA_SIZE_CHART_CUP_HEIGHT_DEFAULTS: Record<string, string> = {
  AA: "8",
  A: "10",
  B: "13",
  C: "15",
  D: "18",
  E: "20",
  F: "23",
  G: "25",
  H: "28",
  I: "30"
}

const WOMENS_BOTTOM_SIZE_CHART_DEFAULTS: Record<string, [string, string, string, string]> = {
  XS: ["62", "96", "98", "67"],
  S: ["66", "100", "100", "68"],
  M: ["70", "104", "102", "69"],
  L: ["74", "108", "104", "70"],
  XL: ["78", "112", "106", "71"],
  XXL: ["82", "116", "108", "72"],
  "ONE-SIZE": ["68", "104", "100", "68"],
  "ONE SIZE": ["68", "104", "100", "68"],
  "ONE-SIZE PETITE": ["64", "100", "94", "64"],
  "ONE SIZE PETITE": ["64", "100", "94", "64"],
  "PETITE XXS": ["58", "88", "92", "63"],
  "PETITE XS": ["60", "92", "94", "64"],
  "PETITE S": ["64", "96", "96", "65"],
  "PETITE M": ["68", "100", "98", "66"],
  "PETITE L": ["72", "104", "100", "67"],
  "ASIAN XS": ["60", "92", "96", "66"],
  "ASIAN S": ["64", "96", "98", "67"],
  "ASIAN M": ["68", "100", "100", "68"],
  "ASIAN L": ["72", "104", "102", "69"],
  "ASIAN XL": ["76", "108", "104", "70"],
  "ASIAN XXL": ["80", "112", "106", "71"],
  "TALL XXS": ["60", "92", "100", "71"],
  "TALL XS": ["62", "96", "102", "72"],
  "TALL S": ["66", "100", "104", "73"],
  "TALL M": ["70", "104", "106", "74"],
  "TALL L": ["74", "108", "108", "75"],
  "TALL XL": ["78", "112", "110", "76"],
  "TALL XXL": ["82", "116", "112", "77"],
  "25": ["64", "96", "99", "68"],
  "26": ["66", "98", "100", "68"],
  "27": ["68", "100", "101", "69"],
  "28": ["70", "102", "102", "69"],
  "29": ["72", "104", "103", "70"],
  "30": ["74", "106", "104", "70"]
}

const WOMENS_BOTTOM_SIZE_CHART_FALLBACK = ["68", "100", "100", "68"] as const

// 女上装 (women's tops) size charts expose two required metrics: 胸围全围 (full
// bust) and 衣长 (garment length), in cm. Values below follow a conventional
// finished-garment progression so a listing whose category offers no reusable
// template can still clear the "请完善尺码表" save gate.
const WOMENS_TOP_SIZE_CHART_DEFAULTS: Record<string, [string, string]> = {
  XXS: ["84", "58"],
  XS: ["88", "60"],
  S: ["92", "62"],
  M: ["96", "64"],
  L: ["100", "66"],
  XL: ["104", "68"],
  XXL: ["108", "70"],
  "ONE-SIZE": ["96", "64"],
  "ONE SIZE": ["96", "64"],
  "ASIAN XS": ["86", "58"],
  "ASIAN S": ["90", "60"],
  "ASIAN M": ["94", "62"],
  "ASIAN L": ["98", "64"],
  "ASIAN XL": ["102", "66"],
  "ASIAN XXL": ["106", "68"]
}

const WOMENS_TOP_SIZE_CHART_FALLBACK = ["96", "64"] as const

const normalizeSizeLabelKey = (value: string) =>
  normalizeFeedbackText(value)
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()

const buildSizeChartTemplateName = (sizeCategoryText: string, rows: Array<{ sizeLabel: string }>) => {
  const category = normalizeFeedbackText(sizeCategoryText).replace(/\s+/g, "")
  const firstSize = rows[0]?.sizeLabel?.replace(/\s+/g, "") ?? ""
  return `${category || "size"}-${firstSize || "auto"}-auto`.slice(0, 30)
}

const inspectSizeChartMetricState = async (modal: Locator): Promise<SizeChartMetricState> => {
  const metrics = await modal.locator("input").evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const input = node as HTMLInputElement
        return {
          type: input.type,
          value: input.value.trim(),
          placeholder: (input.getAttribute("placeholder") ?? "").trim()
        }
      })
      .filter((item) =>
        item.type !== "search"
        && item.type !== "checkbox"
        && item.type !== "hidden"
        && (item.placeholder.includes("\u8bf7\u8f93\u5165") || item.value.length > 0)
      )
  ).catch(() => [] as Array<{ type: string; value: string; placeholder: string }>)

  const filledValues = metrics.map((item) => item.value).filter(Boolean)
  return {
    totalMetricInputs: metrics.length,
    filledMetricInputs: filledValues.length,
    sampleValues: filledValues.slice(0, 6)
  }
}

const deriveBraSizeChartFallbackValues = (sizeLabel: string) => {
  const normalized = normalizeFeedbackText(sizeLabel)
    .replace(/\s+/g, "")
    .replace(/[^0-9a-z]/gi, "")
    .toUpperCase()
  const matched = normalized.match(/(\d{2,3})([A-Z]{1,3})$/)
  if (!matched) {
    return null
  }

  const underbust = matched[1]
  const cupCode = matched[2]
  const cupHeight = BRA_SIZE_CHART_CUP_HEIGHT_DEFAULTS[cupCode]
    ?? BRA_SIZE_CHART_CUP_HEIGHT_DEFAULTS[cupCode.slice(-1)]
    ?? BRA_SIZE_CHART_CUP_HEIGHT_DEFAULTS.C

  return [underbust, cupHeight]
}

const applyManualSizeChartFallback = async (modal: Locator, sizeCategoryText: string): Promise<SizeChartManualFillResult> => {
  const category = normalizeFeedbackText(sizeCategoryText)
  const isWomensBottomCategory =
    category.includes("\u5973\u4e0b\u88c5")
    || category.includes("\u4e0b\u88c5")
    || category.includes("\u88e4\u5b50")
    || category.toLowerCase().includes("pants")

  if (isWomensBottomCategory) {
    const rows = modal.locator("table tr")
    const rowCount = Math.min(await rows.count().catch(() => 0), 16)
    let filledInputs = 0
    const filledRows: Array<{
      sizeLabel: string
      values: string[]
    }> = []

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row = rows.nth(rowIndex)
      if (!await row.isVisible().catch(() => false)) {
        continue
      }

      const cells = row.locator("td")
      if (await cells.count().catch(() => 0) < 2) {
        continue
      }

      const sizeLabel = normalizeFeedbackText(await cells.first().innerText().catch(() => ""))
      if (!sizeLabel) {
        continue
      }

      const fallbackValues = WOMENS_BOTTOM_SIZE_CHART_DEFAULTS[normalizeSizeLabelKey(sizeLabel)]
        ?? [...WOMENS_BOTTOM_SIZE_CHART_FALLBACK]
      const inputCandidates = row.locator("input")
      const inputCount = Math.min(await inputCandidates.count().catch(() => 0), 8)
      const editableInputs: Locator[] = []
      for (let inputIndex = 0; inputIndex < inputCount; inputIndex += 1) {
        const input = inputCandidates.nth(inputIndex)
        if (!await input.isVisible().catch(() => false)) {
          continue
        }

        const inputType = await input.evaluate((element) => (element as HTMLInputElement).type || "").catch(() => "")
        if (["checkbox", "radio", "search", "hidden", "button", "submit", "file"].includes(inputType.toLowerCase())) {
          continue
        }

        editableInputs.push(input)
      }

      if (editableInputs.length === 0) {
        continue
      }

      const appliedValues: string[] = []
      for (let inputIndex = 0; inputIndex < Math.min(editableInputs.length, fallbackValues.length); inputIndex += 1) {
        const input = editableInputs[inputIndex]
        const currentValue = await readFieldValue(input).catch(() => "")
        if (currentValue.trim()) {
          appliedValues.push(currentValue.trim())
          continue
        }

        const nextValue = fallbackValues[inputIndex] ?? fallbackValues.at(-1) ?? ""
        if (!nextValue) {
          continue
        }

        await fillTextField(input, nextValue)
        const actualValue = await readFieldValue(input).catch(() => "")
        if (actualValue.trim()) {
          filledInputs += 1
          appliedValues.push(actualValue.trim())
        }
      }

      if (appliedValues.length > 0) {
        filledRows.push({
          sizeLabel,
          values: appliedValues
        })
      }
    }

    return {
      applied: filledInputs > 0,
      reason: filledInputs > 0
        ? `Filled ${filledInputs} blank metric inputs from women-bottom defaults`
        : "No compatible blank metric inputs were filled",
      category,
      filledInputs,
      templateNameApplied: null,
      rows: filledRows
    }
  }

  const isWomensTopCategory =
    category.includes("女上装")
    || category.includes("上装")
    || category.includes("上衣")
    || category.includes("针织")
    || category.includes("T恤")
    || category.toLowerCase().includes("top")

  if (isWomensTopCategory) {
    const rows = modal.locator("table tr")
    const rowCount = Math.min(await rows.count().catch(() => 0), 16)
    let filledInputs = 0
    const filledRows: Array<{
      sizeLabel: string
      values: string[]
    }> = []

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row = rows.nth(rowIndex)
      if (!await row.isVisible().catch(() => false)) {
        continue
      }

      const cells = row.locator("td")
      if (await cells.count().catch(() => 0) < 2) {
        continue
      }

      const sizeLabel = normalizeFeedbackText(await cells.first().innerText().catch(() => ""))
      if (!sizeLabel) {
        continue
      }

      const fallbackValues = WOMENS_TOP_SIZE_CHART_DEFAULTS[normalizeSizeLabelKey(sizeLabel)]
        ?? [...WOMENS_TOP_SIZE_CHART_FALLBACK]
      const inputCandidates = row.locator("input")
      const inputCount = Math.min(await inputCandidates.count().catch(() => 0), 8)
      const editableInputs: Locator[] = []
      for (let inputIndex = 0; inputIndex < inputCount; inputIndex += 1) {
        const input = inputCandidates.nth(inputIndex)
        if (!await input.isVisible().catch(() => false)) {
          continue
        }

        const inputType = await input.evaluate((element) => (element as HTMLInputElement).type || "").catch(() => "")
        if (["checkbox", "radio", "search", "hidden", "button", "submit", "file"].includes(inputType.toLowerCase())) {
          continue
        }

        editableInputs.push(input)
      }

      if (editableInputs.length === 0) {
        continue
      }

      const appliedValues: string[] = []
      for (let inputIndex = 0; inputIndex < Math.min(editableInputs.length, fallbackValues.length); inputIndex += 1) {
        const input = editableInputs[inputIndex]
        const currentValue = await readFieldValue(input).catch(() => "")
        if (currentValue.trim()) {
          appliedValues.push(currentValue.trim())
          continue
        }

        const nextValue = fallbackValues[inputIndex] ?? fallbackValues.at(-1) ?? ""
        if (!nextValue) {
          continue
        }

        await fillTextField(input, nextValue)
        const actualValue = await readFieldValue(input).catch(() => "")
        if (actualValue.trim()) {
          filledInputs += 1
          appliedValues.push(actualValue.trim())
        }
      }

      if (appliedValues.length > 0) {
        filledRows.push({
          sizeLabel,
          values: appliedValues
        })
      }
    }

    return {
      applied: filledInputs > 0,
      reason: filledInputs > 0
        ? `Filled ${filledInputs} blank metric inputs from women-top defaults`
        : "No compatible blank metric inputs were filled",
      category,
      filledInputs,
      templateNameApplied: null,
      rows: filledRows
    }
  }

  if (!category.includes("文胸")) {
    return {
      applied: false,
      reason: `Manual size chart fallback is not configured for category ${category || "unknown"}`,
      category,
      filledInputs: 0,
      templateNameApplied: null,
      rows: []
    }
  }

  const rows = modal.locator("table tr")
  const rowCount = Math.min(await rows.count().catch(() => 0), 12)
  let filledInputs = 0
  const filledRows: Array<{
    sizeLabel: string
    values: string[]
  }> = []

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = rows.nth(rowIndex)
    if (!await row.isVisible().catch(() => false)) {
      continue
    }

    const cells = row.locator("td")
    if (await cells.count().catch(() => 0) < 2) {
      continue
    }

    const sizeLabel = normalizeFeedbackText(await cells.first().innerText().catch(() => ""))
    if (!sizeLabel) {
      continue
    }

    const fallbackValues = deriveBraSizeChartFallbackValues(sizeLabel)
    if (!fallbackValues) {
      continue
    }

    const inputCandidates = row.locator("input")
    const inputCount = Math.min(await inputCandidates.count().catch(() => 0), 6)
    const editableInputs: Locator[] = []
    for (let inputIndex = 0; inputIndex < inputCount; inputIndex += 1) {
      const input = inputCandidates.nth(inputIndex)
      if (!await input.isVisible().catch(() => false)) {
        continue
      }

      const inputType = await input.evaluate((element) => (element as HTMLInputElement).type || "").catch(() => "")
      if (["checkbox", "radio", "search", "hidden", "button", "submit", "file"].includes(inputType.toLowerCase())) {
        continue
      }

      editableInputs.push(input)
    }

    if (editableInputs.length === 0) {
      continue
    }

    const appliedValues: string[] = []
    for (let inputIndex = 0; inputIndex < Math.min(editableInputs.length, fallbackValues.length); inputIndex += 1) {
      const input = editableInputs[inputIndex]
      const currentValue = await readFieldValue(input).catch(() => "")
      if (currentValue.trim()) {
        appliedValues.push(currentValue.trim())
        continue
      }

      const nextValue = fallbackValues[inputIndex] ?? fallbackValues.at(-1) ?? ""
      if (!nextValue) {
        continue
      }

      await fillTextField(input, nextValue)
      const actualValue = await readFieldValue(input).catch(() => "")
      if (actualValue.trim()) {
        filledInputs += 1
        appliedValues.push(actualValue.trim())
      }
    }

    if (appliedValues.length > 0) {
      filledRows.push({
        sizeLabel,
        values: appliedValues
      })
    }
  }

  return {
    applied: filledInputs > 0,
    reason: filledInputs > 0
      ? `Filled ${filledInputs} blank metric inputs from bra-size defaults`
      : "No compatible blank metric inputs were filled",
    category,
    filledInputs,
    templateNameApplied: null,
    rows: filledRows
  }
}

const buildSizeChartTemplateHints = (
  triggerText: string,
  templateName: string,
  sizeCategoryText: string
) => {
  const rawHints = [
    triggerText,
    templateName,
    sizeCategoryText,
    `${triggerText}${SIZE_CHART_TEMPLATE_SUFFIX}`,
    `${templateName}${SIZE_CHART_TEMPLATE_SUFFIX}`,
    `${sizeCategoryText}${SIZE_CHART_TEMPLATE_SUFFIX}`,
    "\u8fde\u8863\u88d9",
    "\u5973\u8fde\u8863\u88d9",
    "\u88d9",
    SIZE_CHART_TEMPLATE_SUFFIX
  ]

  return Array.from(new Set(rawHints
    .map((value) => value.trim())
    .filter((value) =>
      value.length > 0
      && !value.includes(SELECT_PLACEHOLDER_TEXT)
      && value !== "\u6dfb\u52a0\u5c3a\u7801\u8868"
      && value !== "\u65b0\u589e\u5c3a\u7801\u8868"
      && value !== "\u5c3a\u7801\u8868"
      && value !== "\u5c3a\u7801\u88682"
    )))
}

const findSizeChartModal = async (page: Page) => {
  const dialogs = await visibleAntModalLocators(page)
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index]
    const text = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
    if (text.includes("\u5c3a\u7801\u8868")) {
      return {
        dialog,
        text
      }
    }
  }

  return null
}

const normalizeSizeChart = async (page: Page) => {
  const openDialogCount = (await visibleAntModalLocators(page)).length
  const existingModal = await findSizeChartModal(page)
  const baselineDialogCount = existingModal ? Math.max(0, openDialogCount - 1) : openDialogCount
  let openedByTrigger = false
  let triggerText = ""
  let modalRecord = existingModal

  if (!modalRecord) {
    const trigger = await firstVisible([
      page.locator(".skuAttrSizeChart .link"),
      page.locator(".ant-form-item").filter({ hasText: /\u5c3a\u7801\u8868/ }).locator(".link"),
      page.getByText("\u6dfb\u52a0\u5c3a\u7801\u8868", { exact: false }),
      page.getByText("\u65b0\u589e\u5c3a\u7801\u8868", { exact: false })
    ])

    if (!trigger) {
      return stepResult(
        "normalize-size-chart",
        "Normalize size chart",
        "skipped",
        "No size chart trigger is visible on the current Dianxiaomi page"
      )
    }

    triggerText = await readVisibleText(trigger)
    await trigger.scrollIntoViewIfNeeded()
    await trigger.click()
    openedByTrigger = true
    await page.waitForTimeout(800)
    modalRecord = await findSizeChartModal(page)
  }

  if (!modalRecord) {
    return stepResult(
      "normalize-size-chart",
      "Normalize size chart",
      "failed",
      "Clicked the size chart trigger but no size chart modal became visible",
      {
        openedByTrigger,
        triggerText
      }
    )
  }

  const modal = modalRecord.dialog
  const closeModalSafely = async () => {
    const closeButton = await firstVisible([
      modal.locator(".ant-modal-close"),
      modal.locator("[aria-label*='close' i]"),
      modal.locator("[title*='close' i]")
    ]) ?? await findInteractiveInRootByKeywords(modal, [
      "\u5173\u95ed",
      "\u53d6\u6d88",
      "\u77e5\u9053\u4e86",
      "\u786e\u5b9a",
      "\u786e\u8ba4",
      "close",
      "cancel",
      "ok"
    ])

    if (!closeButton) {
      return false
    }

    await clickAfterDianxiaomiIdle(page, closeButton, 1)
    return waitForVisibleAntModalCountAtMost(page, baselineDialogCount)
  }

  const templateNameField = modal.locator("input[placeholder*='\u6a21\u677f\u540d\u79f0']").first()
  let templateName = await templateNameField.inputValue().catch(() => "")
  const sizeCategoryText = await readVisibleText(modal.locator(".ant-select").first())
  const metricStateBefore = await inspectSizeChartMetricState(modal)
  const templateHints = buildSizeChartTemplateHints(triggerText, templateName, sizeCategoryText)
  let selectedTemplate: string | null = null
  let syncedTemplate = false

  if (metricStateBefore.filledMetricInputs === 0) {
    const selects = modal.locator(".ant-select")
    if (await selects.count().catch(() => 0) >= 2) {
      selectedTemplate = await selectAntOption(page, selects.nth(1), templateHints)
      if (selectedTemplate) {
        const syncButton = await findInteractiveInRootByKeywords(modal, ["\u540c\u6b65", "sync"])
        if (syncButton && await syncButton.isVisible().catch(() => false)) {
          await syncButton.click()
          syncedTemplate = true
          await page.waitForTimeout(800)
        }
      }
    }
  }

  const metricStateAfterTemplate = await inspectSizeChartMetricState(modal)
  const manualFillResult = metricStateAfterTemplate.filledMetricInputs === 0 && !selectedTemplate
    ? await applyManualSizeChartFallback(modal, sizeCategoryText)
    : null
  if (
    manualFillResult?.applied
    && !templateName.trim()
    && await templateNameField.isVisible().catch(() => false)
  ) {
    const generatedTemplateName = buildSizeChartTemplateName(sizeCategoryText, manualFillResult.rows)
    if (generatedTemplateName) {
      await fillTextField(templateNameField, generatedTemplateName)
      templateName = await templateNameField.inputValue().catch(() => generatedTemplateName)
      manualFillResult.templateNameApplied = templateName.trim() || generatedTemplateName
    }
  }
  const metricStateAfterFallback = manualFillResult?.applied
    ? await inspectSizeChartMetricState(modal)
    : metricStateAfterTemplate
  if (metricStateAfterFallback.filledMetricInputs === 0 && !selectedTemplate) {
    const closed = await closeModalSafely().catch(() => false)
    return stepResult(
      "normalize-size-chart",
      "Normalize size chart",
      closed ? "skipped" : "failed",
      closed
        ? "Size chart modal was closed because no reusable template could be selected"
        : "Size chart modal is open but has no filled metric values and no reusable template could be selected",
      {
        openedByTrigger,
        triggerText,
        templateName,
        sizeCategoryText,
        templateHints,
        metricStateBefore,
        metricStateAfterTemplate,
        metricStateAfterFallback,
        manualFillResult
      }
    )
  }

  const confirmButton = await findInteractiveInRootByKeywords(modal, ["\u786e\u5b9a", "\u786e\u8ba4", "ok", "confirm"])
  if (!confirmButton) {
    const closed = await closeModalSafely().catch(() => false)
    return stepResult(
      "normalize-size-chart",
      "Normalize size chart",
      closed ? "skipped" : "failed",
      closed
        ? "Size chart modal was closed because no visible confirm button was found"
        : "Size chart modal does not expose a visible confirm button",
      {
        openedByTrigger,
        triggerText,
        templateName,
        sizeCategoryText,
        templateHints,
        selectedTemplate,
        syncedTemplate,
        metricStateBefore,
        metricStateAfterTemplate,
        metricStateAfterFallback,
        manualFillResult
      }
    )
  }

  await clickAfterDianxiaomiIdle(page, confirmButton, 1)
  const closed = await waitForVisibleAntModalCountAtMost(page, baselineDialogCount)
  if (!closed) {
    await closeModalSafely().catch(() => {})
    const latestModal = await findSizeChartModal(page)
    return stepResult(
      "normalize-size-chart",
      "Normalize size chart",
      "skipped",
      "Size chart modal was closed after confirmation fallback",
      {
        openedByTrigger,
        triggerText,
        templateName,
        sizeCategoryText,
        templateHints,
        selectedTemplate,
        syncedTemplate,
        metricStateBefore,
        metricStateAfterTemplate,
        metricStateAfterFallback,
        manualFillResult,
        latestDialogText: latestModal?.text ?? null
      }
    )
  }

  return stepResult(
    "normalize-size-chart",
    "Normalize size chart",
    "done",
    selectedTemplate
      ? `Applied size chart template ${selectedTemplate} and confirmed the modal`
      : manualFillResult?.applied
        ? `Confirmed the size chart modal after ${manualFillResult.reason.toLowerCase()}`
        : "Confirmed the existing size chart modal",
    {
      openedByTrigger,
      triggerText,
      templateName,
      sizeCategoryText,
      templateHints,
      selectedTemplate,
      syncedTemplate,
      metricStateBefore,
      metricStateAfterTemplate,
      metricStateAfterFallback,
      manualFillResult
    }
  )
}

export const fillSingleField = async (page: Page, kind: FieldKind, value: string, config?: DianxiaomiSelectorConfig) => {
  if ((kind as FieldKind) === "title") {
    return fillTitleFields(page, value, config)
  }

  const field = await findField(page, kind, config)
  if (!field) {
    console.warn(`未找到字段：${kind}`)
    return stepResult(`fill-${kind}`, `填写 ${kind}`, "failed", `未找到字段：${kind}`)
  }

  await fillTextField(field, value)
  console.log(`已填写字段：${kind}`)

  // P0-E: write-then-read hard verification for the title field only. This is
  // the most failure-prone single-line write on a Dianxiaomi edit page, and
  // a silent "fill returned but DOM was not updated" was the most common
  // path to a bad product going downstream.
  if (kind === "title") {
    const actualValue = await readFieldValue(field).catch(() => "")
    const expected = value.trim()
    if (expected.length > 0 && !titleValuesMatch(actualValue, expected)) {
      return stepResult(
        "write-verify-failed-title",
        "填写 title (验证失败)",
        "failed",
        `Title was filled but the DOM value does not match the expected text (expected length=${expected.length}, actual length=${actualValue.length})`,
        {
          expectedLength: expected.length,
          actualLength: actualValue.length,
          actualPreview: actualValue.slice(0, 80)
        }
      )
    }
  }

  return stepResult(`fill-${kind}`, `填写 ${kind}`, "done", `已填写字段：${kind}`)
}

// P0-E: read a Playwright Locator's value (input / textarea) or innerText
// (contenteditable) and return a trimmed, comparable string. Returns empty
// string on any error so the caller can treat "could not read" as a non-match.
const readFieldValue = async (field: Locator): Promise<string> => {
  const tag = await field.evaluate((element) => element.tagName.toLowerCase()).catch(() => "")
  if (tag === "input" || tag === "textarea") {
    return (await field.inputValue().catch(() => "")).trim()
  }
  return (await field.innerText().catch(() => "")).trim()
}

// P0-E: lenient match for the post-fill title. Tolerates trim differences
// and a small char-level drift (Dianxiaomi editors sometimes silently strip
// a few ASCII noise characters), but still catches an obviously wrong value.
const titleValuesMatch = (actual: string, expected: string): boolean => {
  if (!actual || !expected) {
    return false
  }
  if (actual === expected) {
    return true
  }
  const minLen = Math.min(actual.length, expected.length)
  if (minLen < expected.length * 0.5) {
    return false
  }
  let matched = 0
  for (let index = 0; index < minLen; index += 1) {
    if (actual[index] === expected[index]) {
      matched += 1
    }
  }
  return matched / expected.length >= 0.9
}

const CJK_TEXT_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/

const TITLE_FIELD_KEYWORD_GROUPS = [
  ["\u4ea7\u54c1\u6807\u9898"],
  ["\u5546\u54c1\u6807\u9898"],
  ["\u82f1\u6587\u6807\u9898"],
  ["\u520a\u767b\u6807\u9898"],
  ["\u5e73\u53f0\u6807\u9898"],
  ["product title"],
  ["english title"],
  ["listing title"],
  ["title"]
]

const findTitleFieldByFormItemLabel = async (page: Page, label: string) => {
  const formItems = page.locator(".ant-form-item").filter({
    has: page.locator(".ant-form-item-label").filter({
      hasText: new RegExp(escapeRegExp(label), "i")
    })
  })
  const count = Math.min(await formItems.count().catch(() => 0), 4)
  for (let index = 0; index < count; index += 1) {
    const item = formItems.nth(index)
    const field = await firstVisible([
      item.locator("input:not([type='hidden']):not([disabled]), textarea:not([disabled]), [contenteditable='true']")
    ])
    if (field && await isWritableField(field)) {
      return field
    }
  }

  return null
}

const locatorFingerprint = async (locator: Locator) => {
  const box = await locator.boundingBox().catch(() => null)
  if (box) {
    return `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}`
  }

  return locator.evaluate((element) => {
    const tag = element.tagName.toLowerCase()
    const id = element.getAttribute("id") ?? ""
    const name = element.getAttribute("name") ?? ""
    const placeholder = element.getAttribute("placeholder") ?? ""
    return `${tag}:${id}:${name}:${placeholder}`
  }).catch(() => "")
}

const findTitleFields = async (page: Page, config?: DianxiaomiSelectorConfig) => {
  const fields: Locator[] = []
  const seen = new Set<string>()
  const addField = async (field: Locator | null) => {
    if (!field || !await field.isVisible().catch(() => false) || !await isWritableField(field)) {
      return
    }
    const key = await locatorFingerprint(field)
    if (!key || seen.has(key)) {
      return
    }
    seen.add(key)
    fields.push(field)
  }

  await addField(await findByConfiguredSelectors(page, config?.fields?.title))
  await addField(await findTitleFieldByFormItemLabel(page, "\u82f1\u6587\u6807\u9898"))
  await addField(await findTitleFieldByFormItemLabel(page, "\u4ea7\u54c1\u6807\u9898"))
  await addField(await findTitleFieldByFormItemLabel(page, "\u5546\u54c1\u6807\u9898"))
  for (const keywords of TITLE_FIELD_KEYWORD_GROUPS) {
    await addField(await findFieldByKeyword(page, keywords))
  }
  const broadTitleCandidates = page.locator("input.ant-input.ant-input-sm[maxlength='250']")
  const broadCount = Math.min(await broadTitleCandidates.count().catch(() => 0), 8)
  for (let index = 0; index < broadCount; index += 1) {
    await addField(broadTitleCandidates.nth(index))
  }

  return fields
}

const fillTitleFields = async (page: Page, value: string, config?: DianxiaomiSelectorConfig) => {
  const fields = await findTitleFields(page, config)
  if (fields.length === 0) {
    console.warn("鏈壘鍒板瓧娈碉細title")
    return stepResult("fill-title", "濉啓 title", "failed", "鏈壘鍒板瓧娈碉細title")
  }

  const expected = value.trim()
  const previews: string[] = []
  let mismatchCount = 0
  for (const field of fields) {
    await fillTextField(field, value)
    const actualValue = await readFieldValue(field).catch(() => "")
    previews.push(actualValue.slice(0, 80))
    if (expected.length > 0 && !titleValuesMatch(actualValue, expected)) {
      mismatchCount += 1
    }
  }

  if (mismatchCount > 0) {
    return stepResult(
      "write-verify-failed-title",
      "濉啓 title (楠岃瘉澶辫触)",
      "failed",
      `Title was filled but ${mismatchCount}/${fields.length} DOM value(s) did not match the expected text`,
      {
        expectedLength: expected.length,
        filledTitleFields: fields.length,
        mismatchCount,
        actualPreviews: previews
      }
    )
  }

  console.log(`宸插～鍐欏瓧娈碉細title (${fields.length})`)
  return stepResult(
    "fill-title",
    "濉啓 title",
    "done",
    `宸插～鍐欏瓧娈碉細title (${fields.length})`,
    {
      filledTitleFields: fields.length,
      actualPreviews: previews
    }
  )
}

const fillEnglishTitleField = async (page: Page, value: string, config?: DianxiaomiSelectorConfig) => {
  const field = await findTitleFieldByFormItemLabel(page, "\u82f1\u6587\u6807\u9898")
    ?? await findFieldByKeyword(page, ["english title"])

  if (!field) {
    return fillSingleField(page, "title", value, config)
  }

  await fillTextField(field, value)
  const actualValue = await readFieldValue(field).catch(() => "")
  const expected = value.trim()
  if (expected.length > 0 && !titleValuesMatch(actualValue, expected)) {
    return stepResult(
      "write-verify-failed-english-title",
      "Fill english title (verification failed)",
      "failed",
      "English title was filled but the DOM value does not match the expected text",
      {
        expectedLength: expected.length,
        actualLength: actualValue.length,
        actualPreview: actualValue.slice(0, 80)
      }
    )
  }

  return stepResult(
    "fill-english-title",
    "Fill english title",
    "done",
    "English title field was updated from the task draft",
    {
      actualPreview: actualValue.slice(0, 80)
    }
  )
}

const isWritableField = async (field: Locator | null) => {
  if (!field) {
    return false
  }

  return field.evaluate((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return !element.readOnly && !element.disabled
    }
    if (element instanceof HTMLSelectElement) {
      return !element.disabled
    }
    return element.getAttribute("contenteditable") === "true"
  }).catch(() => false)
}

export const findSkuRows = async (page: Page, config?: DianxiaomiSelectorConfig) => {
  const variantInfoContainer = await findVariantInfoContainer(page)
  const rows: Array<{ row: Locator; text: string }> = []
  const seen = new Set<string>()
  const collectRowsFromRoot = async (rowRoot: Page | Locator) => {
    const configuredRow = config?.skuRows?.length
      ? rowRoot.locator(config.skuRows.join(", ")).filter({
          has: rowRoot.locator(SKU_ROW_FIELD_SELECTOR)
        })
      : null
    const rowCandidates = rowRoot.locator("tr, [role='row'], [class*='sku' i], [class*='table-row' i]").filter({
      has: rowRoot.locator(SKU_ROW_FIELD_SELECTOR)
    })
    const candidates = configuredRow && await configuredRow.count() > 0 ? configuredRow : rowCandidates
    const count = Math.min(await candidates.count().catch(() => 0), 80)

    for (let index = 0; index < count; index += 1) {
      const row = candidates.nth(index)
      if (!await row.isVisible().catch(() => false)) {
        continue
      }

      const text = normalizeText(await row.innerText().catch(() => ""))
      const inputs = await countVisible(row.locator(SKU_ROW_FIELD_SELECTOR), 12)
      if (inputs <= 0) {
        continue
      }

      const key = await locatorIdentityKey(row)
      if (key && seen.has(key)) {
        continue
      }
      if (key) {
        seen.add(key)
      }

      rows.push({
        row,
        text
      })
    }
  }

  if (variantInfoContainer) {
    await collectRowsFromRoot(variantInfoContainer)
  }

  if (rows.length === 0) {
    await collectRowsFromRoot(page)
  }

  return rows
}

const scoreSkuRow = (rowText: string, sku: ListingSkuPricing) => {
  const tokens = [sku.skuName, sku.attributeSummary, ...Object.values(sku.attributes)]
    .map(normalizeText)
    .filter(Boolean)

  return tokens.reduce((score, token) => score + (rowText.includes(token) ? Math.max(token.length, 1) : 0), 0)
}

const getRowField = async (row: Locator, kind: "price" | "stock", _fallbackIndex: number) => {
  const keywords = getFieldKeywords(kind)
  const byHint = row.locator(
    keywords
      .flatMap((keyword) => [
        `input[placeholder*="${keyword}" i]`,
        `input[aria-label*="${keyword}" i]`,
        `input[name*="${keyword}" i]`,
        `textarea[placeholder*="${keyword}" i]`,
        `textarea[aria-label*="${keyword}" i]`,
        `textarea[name*="${keyword}" i]`
      ])
      .join(", ")
  )

  const hinted = await firstVisible([byHint])
  if (hinted && await isWritableField(hinted)) {
    return hinted
  }

  return null
}

const SKU_IDENTIFIER_SELECTOR = [
  'input[name*="variationSku" i]',
  'input[name*="skuAttrCode" i]',
  'input[class*="skuAttrCode" i]',
  'input[placeholder*="\u4e0d\u80fd\u5305\u542b\u4e2d\u6587" i]',
  'input[aria-label*="\u8d27\u53f7" i]',
  'input[placeholder*="\u8d27\u53f7" i]'
].join(", ")

const getRowSkuIdentifierField = async (row: Locator) => {
  const field = await firstVisible([row.locator(SKU_IDENTIFIER_SELECTOR)])
  if (field && await isWritableField(field)) {
    return field
  }
  return null
}

const fillVisibleSkuIdentifierFields = async (page: Page, skus: ListingSkuPricing[]) => {
  const fields = page.locator(SKU_IDENTIFIER_SELECTOR)
  const count = Math.min(await fields.count().catch(() => 0), 160)
  const usedCodes = new Set<string>()
  let filledSkuCodes = 0
  let skuCodeVerified = 0
  const skuCodeSamples: string[] = []

  for (let index = 0; index < count; index += 1) {
    const field = fields.nth(index)
    if (!await field.isVisible().catch(() => false) || !await isWritableField(field)) {
      continue
    }

    const currentSkuCode = await readFieldValue(field).catch(() => "")
    if (currentSkuCode.trim() && !CJK_TEXT_PATTERN.test(currentSkuCode)) {
      usedCodes.add(currentSkuCode.trim().toUpperCase())
      skuCodeSamples.push(currentSkuCode.slice(0, 40))
      continue
    }

    const sku = skus[index] ?? skus[skus.length - 1]
    if (!sku) {
      continue
    }
    const nextSkuCode = skuIdentifierCode(sku, index, usedCodes)
    await fillTextField(field, nextSkuCode)
    filledSkuCodes += 1
    const actualSkuCode = await readFieldValue(field).catch(() => "")
    if (actualSkuCode === nextSkuCode) {
      skuCodeVerified += 1
    }
    skuCodeSamples.push(actualSkuCode.slice(0, 40))
  }

  return {
    visibleSkuCodeFields: count,
    filledSkuCodes,
    skuCodeVerified,
    skuCodeSamples: skuCodeSamples.slice(0, 12)
  }
}

const chooseDominantVisibleInputValue = async (
  page: Page,
  fieldName: string,
  fallback: string
) => {
  const fields = page.locator(`input[name="${fieldName}"]`)
  const count = Math.min(await fields.count().catch(() => 0), 240)
  const valueStats = new Map<string, { count: number; firstIndex: number }>()

  for (let index = 0; index < count; index += 1) {
    const field = fields.nth(index)
    if (!await field.isVisible().catch(() => false) || !await isWritableField(field)) {
      continue
    }

    const currentValue = await readFieldValue(field).catch(() => "")
    if (!currentValue.trim()) {
      continue
    }

    const existing = valueStats.get(currentValue)
    if (existing) {
      existing.count += 1
    } else {
      valueStats.set(currentValue, {
        count: 1,
        firstIndex: index
      })
    }
  }

  const winner = [...valueStats.entries()]
    .sort((left, right) => {
      const countDelta = right[1].count - left[1].count
      return countDelta !== 0 ? countDelta : left[1].firstIndex - right[1].firstIndex
    })[0]?.[0]

  return winner?.trim() || fallback
}

const fillVisibleNamedInputBlanks = async (
  page: Page,
  fieldName: string,
  fallbackValue: string
) => {
  const fields = page.locator(`input[name="${fieldName}"]`)
  const count = Math.min(await fields.count().catch(() => 0), 240)
  const appliedValue = await chooseDominantVisibleInputValue(page, fieldName, fallbackValue)
  let visibleFields = 0
  let blankFields = 0
  let filledFields = 0
  let verifiedFields = 0
  const sampleValues: string[] = []

  for (let index = 0; index < count; index += 1) {
    const field = fields.nth(index)
    if (!await field.isVisible().catch(() => false) || !await isWritableField(field)) {
      continue
    }

    visibleFields += 1
    const currentValue = await readFieldValue(field).catch(() => "")
    if (currentValue.trim()) {
      sampleValues.push(currentValue.slice(0, 32))
      continue
    }

    blankFields += 1
    await fillTextField(field, appliedValue)
    const actualValue = await readFieldValue(field).catch(() => "")
    sampleValues.push(actualValue.slice(0, 32))
    if (actualValue.trim()) {
      filledFields += 1
      if (actualValue === appliedValue) {
        verifiedFields += 1
      }
    }
  }

  return {
    fieldName,
    visibleFields,
    blankFields,
    filledFields,
    verifiedFields,
    appliedValue,
    sampleValues: sampleValues.slice(0, 12)
  }
}

const fillVisibleSkuLogisticsFields = async (page: Page) => {
  const fieldPlans = [
    {
      fieldName: "price",
      label: "declared price",
      fallbackValue: REPAIR_DECLARED_PRICE_FALLBACK
    },
    {
      fieldName: "skuLength",
      label: "sku length",
      fallbackValue: REPAIR_SKU_LENGTH_FALLBACK
    },
    {
      fieldName: "skuWidth",
      label: "sku width",
      fallbackValue: REPAIR_SKU_WIDTH_FALLBACK
    },
    {
      fieldName: "skuHeight",
      label: "sku height",
      fallbackValue: REPAIR_SKU_HEIGHT_FALLBACK
    },
    {
      fieldName: "weight",
      label: "sku weight",
      fallbackValue: REPAIR_SKU_WEIGHT_G_FALLBACK
    }
  ] as const

  const summaries = []
  for (const plan of fieldPlans) {
    summaries.push({
      label: plan.label,
      ...await fillVisibleNamedInputBlanks(page, plan.fieldName, plan.fallbackValue)
    })
  }

  const visibleFieldGroups = summaries.filter((item) => item.visibleFields > 0).length
  const filledBlankGroups = summaries.filter((item) => item.filledFields > 0).length
  const remainingBlankGroups = summaries.filter((item) => item.blankFields > item.filledFields).length
  const totalBlanks = summaries.reduce((total, item) => total + item.blankFields, 0)
  const totalFilled = summaries.reduce((total, item) => total + item.filledFields, 0)

  return stepResult(
    "fill-sku-logistics-fields",
    "Fill SKU logistics fields",
    remainingBlankGroups > 0
      ? "failed"
      : visibleFieldGroups > 0
        ? "done"
        : "skipped",
    remainingBlankGroups > 0
      ? `Filled ${totalFilled}/${totalBlanks} blank SKU logistics field(s)`
      : visibleFieldGroups > 0
        ? totalBlanks > 0
          ? `Filled ${totalFilled} blank SKU logistics field(s)`
          : "Visible SKU logistics fields were already complete"
        : "No visible SKU logistics field was detected before page save",
    {
      visibleFieldGroups,
      filledBlankGroups,
      remainingBlankGroups,
      totalBlanks,
      totalFilled,
      fields: summaries
    }
  )
}

const collectColorSkcGroupState = async (page: Page, includeVariantRows = false) => {
  const rows = page.locator(COLOR_SKC_ROW_SELECTOR)
  const count = Math.min(await rows.count().catch(() => 0), 160)
  const groups: Array<{
    index: number
    label: string
  }> = []

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index)
    if (!await row.isVisible().catch(() => false)) {
      continue
    }

    const label = cleanVisibleText(
      await row.locator("td[data-column-index='0']").first().innerText().catch(async () =>
        row.locator("td").first().innerText().catch(() => "")
      )
    )
    if (!label) {
      continue
    }

    groups.push({
      index: groups.length,
      label
    })
  }

  return {
    groupCount: groups.length,
    groups,
    variantRowCount: includeVariantRows ? (await findSkuRows(page)).length : 0
  }
}

const findVisibleSelectedColorOptionLabelByTableOrder = async (
  colorSection: Locator,
  rowIndex: number,
  normalizedTarget = ""
) => {
  if (rowIndex < 0) {
    return null
  }

  const labels = colorSection.locator("label.d-checkbox.mr-8")
  const optionIndex = await labels.evaluateAll((nodes, input) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase()
    const matchesTarget = (value: string) =>
      Boolean(input.target)
      && (value === input.target || value.endsWith(input.target) || value.includes(input.target))
    const visibleOptions = nodes
      .map((node, index) => {
        const element = node as HTMLElement
        const style = window.getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        const textNode = element.querySelector(".theme-value-text, .theme-value-edit")
        return {
          index,
          text: normalize(element.innerText || element.textContent),
          title: normalize(textNode?.getAttribute("title") ?? textNode?.textContent ?? ""),
          visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
        }
      })
      .filter((item) => item.visible && (item.text || item.title))

    return visibleOptions.find((item) => matchesTarget(item.text) || matchesTarget(item.title))?.index
      ?? visibleOptions[input.rowIndex]?.index
      ?? -1
  }, {
    rowIndex,
    target: normalizedTarget
  }).catch(() => -1)

  return optionIndex >= 0 ? labels.nth(optionIndex) : null
}

const findVisibleColorOptionLabelInRoot = async (
  root: Page | Locator,
  selector: string,
  normalizedTarget: string,
  visibleOnly: boolean
) => {
  const options = root.locator(selector)
  const optionIndex = await options.evaluateAll((nodes, target) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase()
    const visibleOptions = nodes
      .map((node, index) => {
        const element = node as HTMLElement
        const style = window.getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        const title = normalize(element.getAttribute("title"))
        return {
          index,
          text: normalize(element.innerText || element.textContent || element.getAttribute("title")),
          title,
          visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
        }
      })
      .filter((item) => target.visibleOnly ? item.visible : true)

    return visibleOptions.find((item) => item.text === target.label || item.title === target.label)?.index
      ?? visibleOptions.find((item) => item.text.endsWith(target.label) || item.title.endsWith(target.label))?.index
      ?? visibleOptions.find((item) => item.text.includes(target.label) || item.title.includes(target.label))?.index
      ?? -1
  }, {
    label: normalizedTarget,
    visibleOnly
  }).catch(() => -1)

  return optionIndex >= 0 ? options.nth(optionIndex) : null
}

const findVisibleColorOptionLabel = async (
  page: Page,
  colorSection: Locator,
  labelText: string
) => {
  const normalizedTarget = normalizeText(labelText)

  for (const visibleOnly of [true, false]) {
    for (const root of [colorSection, page] as const) {
      for (const selector of COLOR_SKC_OPTION_SELECTORS) {
        const match = await findVisibleColorOptionLabelInRoot(root, selector, normalizedTarget, visibleOnly)
        if (match) {
          return match
        }
      }
    }
  }

  return null
}

const findColorOptionToggleTarget = async (
  page: Page,
  colorSection: Locator,
  labelText: string,
  rowIndex = -1
) => {
  const normalizedTarget = normalizeText(labelText)
  const orderedMatch = await findVisibleSelectedColorOptionLabelByTableOrder(colorSection, rowIndex, normalizedTarget)
  if (orderedMatch) {
    return orderedMatch
  }

  return findVisibleColorOptionLabel(page, colorSection, labelText)
}

const waitForVisibleColorOptionLabel = async (
  page: Page,
  colorSection: Locator,
  labelText: string,
  rowIndex = -1,
  timeoutMs = COLOR_SKC_OPTION_WAIT_TIMEOUT_MS
) => {
  const startedAt = Date.now()
  let match = await findColorOptionToggleTarget(page, colorSection, labelText, rowIndex)
  while (!match && Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(300)
    match = await findColorOptionToggleTarget(page, colorSection, labelText, rowIndex)
  }

  return match
}

const revealColorOptionTargets = async (
  page: Page,
  colorSection: Locator,
  targetLabels: string[],
  timeoutMs = COLOR_SKC_OPTION_REVEAL_TIMEOUT_MS
) => {
  const normalizedTargets = targetLabels.map((label) => normalizeText(label)).filter(Boolean)
  if (normalizedTargets.length === 0) {
    return false
  }

  const startedAt = Date.now()
  const firstColorRow = page.locator(COLOR_SKC_ROW_SELECTOR).first()

  while (Date.now() - startedAt < timeoutMs) {
    for (const labelText of targetLabels) {
      if (await findVisibleColorOptionLabel(page, colorSection, labelText)) {
        return true
      }
    }

    await colorSection.scrollIntoViewIfNeeded().catch(() => undefined)
    await firstColorRow.scrollIntoViewIfNeeded().catch(() => undefined)
    await page.evaluate(({ sectionSelector, rowSelector, targets }) => {
      const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase()
      const section = document.querySelector(sectionSelector)
      if (!(section instanceof HTMLElement)) {
        return false
      }

      const matchText = (text: string) => targets.some((target) => text === target || text.endsWith(target) || text.includes(target))
      const visibleElement = (node: Element | null): node is HTMLElement => {
        if (!(node instanceof HTMLElement)) {
          return false
        }

        const style = window.getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
      }

      const sectionNodes = Array.from(section.querySelectorAll("*"))
      const matchedNode = sectionNodes.find((node) => visibleElement(node) && matchText(normalize(node.innerText || node.textContent)))
      if (matchedNode instanceof HTMLElement) {
        matchedNode.scrollIntoView({
          block: "center",
          inline: "nearest"
        })
        return true
      }

      const scrollContainers = Array.from(section.querySelectorAll([
        ".checkbox-group-with-search__content",
        ".checkbox-group-with-search",
        ".options-module"
      ].join(", ")))
      for (const container of scrollContainers) {
        if (!(container instanceof HTMLElement)) {
          continue
        }

        const nextOffset = Math.max(Math.floor(container.clientHeight * 0.85), 240)
        if (container.scrollHeight > container.clientHeight + 20) {
          container.scrollTop = Math.min(container.scrollTop + nextOffset, container.scrollHeight)
        }
      }

      const firstRow = document.querySelector(rowSelector)
      if (firstRow instanceof HTMLElement) {
        firstRow.scrollIntoView({
          block: "center",
          inline: "nearest"
        })
      }

      window.scrollBy(0, 260)
      return false
    }, {
      sectionSelector: COLOR_SKC_SECTION_SELECTOR,
      rowSelector: COLOR_SKC_ROW_SELECTOR,
      targets: normalizedTargets
    }).catch(() => false)
    await page.waitForTimeout(350)
  }

  for (const labelText of targetLabels) {
    if (await findVisibleColorOptionLabel(page, colorSection, labelText)) {
      return true
    }
  }

  return false
}

const collectColorOptionSelectorState = async (
  root: Page | Locator,
  selector: string,
  targetLabels: string[]
) => {
  const options = root.locator(selector)
  return options.evaluateAll((nodes, input) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase()
    const labels = input.labels.map(normalize)
    const visibleOptions = nodes
      .map((node) => {
        const element = node as HTMLElement
        const style = window.getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return {
          text: normalize(element.innerText || element.textContent),
          visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
        }
      })

    const allTexts = visibleOptions
      .map((item) => item.text)
      .filter(Boolean)
    const uniqueTexts = Array.from(new Set(allTexts))
    const visibleMatches = uniqueTexts.filter((text) => labels.some((label) => text === label || text.endsWith(label) || text.includes(label)))

    return {
      selector: input.selector,
      totalCount: nodes.length,
      visibleCount: visibleOptions.filter((item) => item.visible).length,
      sampleTexts: uniqueTexts.slice(0, 12),
      tailTexts: uniqueTexts.slice(-12),
      matchingTexts: visibleMatches
    }
  }, {
    selector,
    labels: targetLabels
  }).catch(() => ({
    selector,
    totalCount: 0,
    visibleCount: 0,
    sampleTexts: [] as string[],
    tailTexts: [] as string[],
    matchingTexts: [] as string[]
  }))
}

const collectColorOptionDebugSnapshot = async (
  page: Page,
  colorSection: Locator,
  targetLabels: string[]
) => {
  const selectors = COLOR_SKC_OPTION_SELECTORS
  const sectionVisible = await colorSection.isVisible().catch(() => false)

  return {
    sectionVisible,
    colorSection: await Promise.all(selectors.map((selector) => collectColorOptionSelectorState(colorSection, selector, targetLabels))),
    page: await Promise.all(selectors.map((selector) => collectColorOptionSelectorState(page, selector, targetLabels)))
  }
}

const colorOptionSnapshotHasAnyControls = (
  snapshot: Awaited<ReturnType<typeof collectColorOptionDebugSnapshot>> | null
) => Boolean(snapshot && [...snapshot.colorSection, ...snapshot.page].some((item) => item.totalCount > 0))

const waitForColorOptionControlsSnapshot = async (
  page: Page,
  colorSection: Locator,
  targetLabels: string[],
  timeoutMs = COLOR_SKC_OPTION_HYDRATE_TIMEOUT_MS
) => {
  const startedAt = Date.now()
  let snapshot = await collectColorOptionDebugSnapshot(page, colorSection, targetLabels)
  if (colorOptionSnapshotHasAnyControls(snapshot)) {
    return snapshot
  }

  console.log(`Waiting for color SKC option controls to hydrate (${targetLabels.slice(0, 3).join(", ")})`)
  while (Date.now() - startedAt < timeoutMs) {
    await colorSection.scrollIntoViewIfNeeded().catch(() => undefined)
    await page.waitForTimeout(500)
    snapshot = await collectColorOptionDebugSnapshot(page, colorSection, targetLabels)
    if (colorOptionSnapshotHasAnyControls(snapshot)) {
      return snapshot
    }
  }

  return snapshot
}

const findLooseActionInRootByKeywords = async (root: Page | Locator, keywords: string[]) => {
  for (const keyword of keywords) {
    const pattern = new RegExp(escapeRegExp(keyword), "i")
    const match = await firstVisible([
      root.getByRole("button", { name: pattern }),
      root.getByRole("link", { name: pattern }),
      root.getByRole("menuitem", { name: pattern }),
      root.locator("button, a, [role='button'], [role='link'], [role='menuitem'], span.link, .link").filter({
        hasText: pattern
      })
    ])

    if (match) {
      return match
    }
  }

  return null
}

const clickColorSkcRemapTrigger = async (
  page: Page,
  colorSection: Locator,
  reason: string
) => {
  const roots: Array<Page | Locator> = [
    colorSection.locator("xpath=ancestor::*[contains(@class,'skuAttrModule') or contains(@class,'form-card')][1]"),
    colorSection,
    page
  ]

  for (const root of roots) {
    const trigger = await findLooseActionInRootByKeywords(root, COLOR_SKC_REMAP_KEYWORDS)
    if (!trigger || !await trigger.isVisible().catch(() => false)) {
      continue
    }

    const triggerText = cleanVisibleText(
      await trigger.innerText().catch(async () =>
        trigger.getAttribute("title").catch(() => "")
      )
    )
    console.log(`color-skc trim: clicking remap trigger because ${reason}${triggerText ? ` (${triggerText})` : ""}`)
    await clickAfterDianxiaomiIdle(page, trigger, 2).catch(async () => {
      await trigger.click({
        force: true
      }).catch(() => undefined)
    })
    await page.waitForTimeout(1_200)
    return {
      attempted: true,
      clicked: true,
      reason,
      text: triggerText
    }
  }

  console.log(`color-skc trim: remap trigger missing (${reason})`)
  return {
    attempted: true,
    clicked: false,
    reason,
    text: ""
  }
}

const isMissingVariantSaveFailure = (message: string) => {
  const normalized = normalizeFeedbackText(message)
  return normalized.includes("请至少选择一个变种")
    || (normalized.includes("至少选择") && normalized.includes("变种"))
}

const findVariantRemapSurface = async (page: Page) => {
  const roots = [
    page.locator(".ant-modal-wrap.full-modal__dxm:visible").last(),
    page.locator(".ant-modal.product-ref-modal:visible").last(),
    page.locator(".ant-modal-wrap:visible").filter({
      hasText: new RegExp(VARIANT_REMAP_MODAL_HINT_KEYWORDS.map(escapeRegExp).join("|"), "i")
    }).last(),
    page.locator(".ant-modal:visible").filter({
      hasText: new RegExp(VARIANT_REMAP_MODAL_HINT_KEYWORDS.map(escapeRegExp).join("|"), "i")
    }).last()
  ]

  for (const candidate of roots) {
    const count = await candidate.count().catch(() => 0)
    if (count <= 0) {
      continue
    }

    const locator = candidate.first()
    if (await locator.isVisible().catch(() => false)) {
      return locator
    }
  }

  return null
}

export const waitForVariantRemapSurface = async (page: Page, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs
  let surface = await findVariantRemapSurface(page)
  while (!surface && Date.now() < deadline) {
    await page.waitForTimeout(250)
    surface = await findVariantRemapSurface(page)
  }
  return surface
}

const readVariantRemapSurfaceText = async (surface: Locator | null) =>
  normalizeFeedbackText(await surface?.innerText().catch(() => "") ?? "")

const chooseVariantRemapAction = async (
  page: Page,
  surface: Locator,
  keywords: string[],
  negativeKeywords: string[] = []
) => {
  const direct = await findInteractiveInRootByKeywords(surface, keywords)
  if (direct && await direct.isVisible().catch(() => false)) {
    return direct
  }

  const actions = surface.locator("button, [role='button'], input[type='button'], input[type='submit'], a")
  const count = Math.min(await actions.count().catch(() => 0), 30)
  for (let index = count - 1; index >= 0; index -= 1) {
    const action = actions.nth(index)
    if (!await action.isVisible().catch(() => false)) {
      continue
    }

    const text = cleanVisibleText(await action.innerText().catch(async () => await action.getAttribute("value").catch(() => "")))
    if (!text) {
      continue
    }
    if (negativeKeywords.some((keyword) => text.includes(keyword))) {
      continue
    }
    if (keywords.some((keyword) => text.includes(keyword))) {
      return action
    }
  }

  const fallback = await findLastVisibleActionInRoot(surface, 30)
  if (!fallback) {
    return null
  }

  const fallbackText = cleanVisibleText(await fallback.innerText().catch(async () => await fallback.getAttribute("value").catch(() => "")))
  if (!fallbackText || negativeKeywords.some((keyword) => fallbackText.includes(keyword))) {
    return null
  }
  return fallback
}

const waitForVariantRowsReady = async (
  page: Page,
  beforeRowCount: number,
  timeoutMs = VARIANT_REMAP_ROW_WAIT_TIMEOUT_MS
) => {
  const deadline = Date.now() + timeoutMs
  let rows = await findSkuRows(page)
  while (Date.now() < deadline) {
    const bodyText = normalizeFeedbackText(await page.locator("body").innerText().catch(() => ""))
    if (rows.length > beforeRowCount || (rows.length > 0 && bodyText.includes("变种信息"))) {
      return rows
    }
    await page.waitForTimeout(400)
    rows = await findSkuRows(page)
  }
  return rows
}

const collectVariantRemapStageTwoTabs = async (surface: Locator) => {
  const tabs = surface.locator("[role='tab'], .ant-tabs-tab, .ant-radio-wrapper, li, button, a, span, div")
  const count = Math.min(await tabs.count().catch(() => 0), 80)
  const results: Array<{ locator: Locator; text: string }> = []
  const seen = new Set<string>()

  for (let index = 0; index < count; index += 1) {
    const tab = tabs.nth(index)
    if (!await tab.isVisible().catch(() => false)) {
      continue
    }

    const text = cleanVisibleText(await tab.innerText().catch(() => ""))
    if (!text || text.length > 12) {
      continue
    }
    if (!["颜色", "尺码", "图片"].includes(text)) {
      continue
    }
    if (seen.has(text)) {
      continue
    }

    seen.add(text)
    results.push({
      locator: tab,
      text
    })
  }

  return results
}

const activateVariantRemapStageTwoTab = async (
  page: Page,
  surface: Locator,
  tabText: string
) => {
  const tabs = await collectVariantRemapStageTwoTabs(surface)
  const target = tabs.find((item) => item.text === tabText)
  if (!target) {
    return false
  }

  const beforeText = await readVariantRemapSurfaceText(surface)
  await clickAfterDianxiaomiIdle(page, target.locator, 2).catch(async () => {
    await target.locator.click({ force: true }).catch(() => undefined)
  })
  await page.waitForTimeout(700)

  const afterText = await readVariantRemapSurfaceText(surface)
  return afterText !== beforeText || afterText.includes(tabText)
}

const fillVariantRemapStageTwoTabs = async (
  page: Page,
  surface: Locator
) => {
  const tabs = await collectVariantRemapStageTwoTabs(surface)
  console.log(`variant-remap: stage-two tabs=${tabs.map((tab) => tab.text).join(",") || "none"}`)
  const filledTabs: Array<{
    tab: string
    fillClicked: boolean
    rowCount: number
    placeholderRowsBefore: number
    placeholderRowsAfter: number
    rowSelections: Array<{
      sourceText: string
      beforeText: string
      afterText: string
      selectedText: string | null
      targetText: string | null
      matchedBy: string
      optionTexts: string[]
      customNameBefore: string
      customNameAfter: string
    }>
  }> = []

  for (const tab of tabs) {
    console.log(`variant-remap: tab start ${tab.text}`)
    await activateVariantRemapStageTwoTab(page, surface, tab.text)
    const fillAction = await chooseVariantRemapAction(page, surface, VARIANT_REMAP_FILL_KEYWORDS, VARIANT_REMAP_NEGATIVE_KEYWORDS)
    let fillClicked = false
    if (fillAction) {
      await clickAfterDianxiaomiIdle(page, fillAction, 2).catch(async () => {
        await fillAction.click({ force: true }).catch(() => undefined)
      })
      fillClicked = true
      await page.waitForTimeout(1_200)
    }

    const collectRows = async () => {
      const rows = surface.locator("tbody tr, .ant-table-row, [class*='table-row' i], tr")
      const count = Math.min(await rows.count().catch(() => 0), 80)
      const collected: Array<{
        rowKey: string
        rowIndex: number
        row: Locator
        select: Locator
        sourceText: string
        selectedText: string
        customInput: Locator | null
        customNameText: string
      }> = []

      for (let index = 0; index < count; index += 1) {
        const row = rows.nth(index)
        if (!await row.isVisible().catch(() => false)) {
          continue
        }

        const select = await firstVisible([row.locator(".ant-select")])
        if (!select) {
          continue
        }

        const cells = row.locator("td")
        const cellCount = Math.min(await cells.count().catch(() => 0), 8)
        const cellTexts: string[] = []
        for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
          cellTexts.push(cleanVisibleText(await cells.nth(cellIndex).innerText().catch(() => "")))
        }
        const sourceText = cleanVisibleText(
          cellTexts[1]
          ?? cellTexts.find((text, cellIndex) =>
            cellIndex > 0
            && Boolean(text)
            && !text.includes("移除")
            && !text.includes("请选择")
          )
          ?? ""
        )
        const customInput = await firstVisible([
          row.locator(`input[placeholder*='${VARIANT_REMAP_CUSTOM_NAME_HINT_TEXT}' i]`),
          row.locator("input:not(.ant-select-selection-search-input):not([type='hidden'])")
        ])
        const customNameText = customInput
          ? cleanVisibleText(await customInput.inputValue().catch(() => ""))
          : ""
        const rowKey = normalizeText(sourceText) || `row-${index}`

        collected.push({
          rowKey,
          rowIndex: index,
          row,
          select,
          sourceText,
          selectedText: await readRemapSelectText(select),
          customInput,
          customNameText
        })
      }

      return collected
    }

    const buildDesiredTexts = (sourceText: string) => {
      const raw = cleanVisibleText(sourceText)
      const values = new Set<string>()
      const push = (value: string) => {
        const text = cleanVisibleText(value)
        if (text) {
          values.add(text)
        }
      }

      push(raw)
      push(raw.replace(/[【\[].*?[】\]]/g, " "))
      push(raw.replace(/[（(].*?[）)]/g, " "))

      if (tab.text === "颜色") {
        push(raw.replace(/颜色/g, ""))
        push(raw.replace(/色/g, ""))
      }

      const sizeToken = raw.match(/\b(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|ONE SIZE|ONE-SIZE|FREE SIZE|FREE-SIZE)\b/i)?.[0]
      if (sizeToken) {
        push(sizeToken.toUpperCase())
      }

      return [...values]
    }

    const normalizeMatchText = (value: string) =>
      normalizeText(value)
        .replace(/[【】\[\]（）()]/g, " ")
        .replace(/[\/,，、|:：-]/g, " ")
        .replace(/\s+/g, " ")
        .trim()

    const normalizeColorMatchText = (value: string) =>
      normalizeMatchText(value)
        .replace(/颜色/g, "")
        .replace(/色/g, "")
        .replace(/\s+/g, "")

    const collapseRepeatedSelectedText = (value: string) => {
      const text = cleanVisibleText(value)
      if (!text) {
        return ""
      }

      const parts = text.split(/\s+/).filter(Boolean)
      if (parts.length >= 2 && parts.every((part) => part === parts[0])) {
        return parts[0]
      }

      return text
    }

    const extractSizeToken = (value: string) =>
      cleanVisibleText(value)
        .match(/\b(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|3XL|ONE SIZE|ONE-SIZE|FREE SIZE|FREE-SIZE|FREE\(ONE SIZE\))\b/i)?.[0]
        ?.toUpperCase()
        ?? ""

    const readRemapSelectText = async (select: Locator) => {
      const display = await firstVisible([
        select.locator(".ant-select-selection-item"),
        select.locator(".ant-select-selection-overflow-item .ant-select-selection-item"),
        select.locator(".ant-select-selection-placeholder")
      ])
      if (display) {
        const text = cleanVisibleText(await display.innerText().catch(() => ""))
        if (text) {
          return collapseRepeatedSelectedText(text)
        }
      }

      return collapseRepeatedSelectedText(await readVisibleText(select))
    }

    const normalizeOptionKey = (value: string) => {
      const collapsed = collapseRepeatedSelectedText(value)
      return normalizeMatchText(collapsed) || normalizeText(collapsed)
    }

    const isUsableOptionText = (value: string) => {
      const normalized = normalizeText(value)
      return Boolean(
        normalized
        && !normalized.includes(normalizeText(SELECT_PLACEHOLDER_TEXT))
        && !normalized.includes("暂无")
        && !normalized.includes("无数据")
        && !normalized.includes("未配置")
        && !normalized.includes("请先")
      )
    }

    const isDisabledAntOption = async (option: Locator) => {
      const ariaDisabled = await option.getAttribute("aria-disabled").catch(() => null)
      const className = await option.getAttribute("class").catch(() => "")
      return ariaDisabled === "true" || /disabled/i.test(className ?? "")
    }

    const clickRemapControl = async (locator: Locator) => {
      await locator.scrollIntoViewIfNeeded().catch(() => undefined)
      try {
        await locator.click({
          timeout: 2_500
        })
        return true
      } catch {
        try {
          await locator.click({
            timeout: 2_500,
            force: true
          })
          return true
        } catch {
          return false
        }
      }
    }

    const readSelectOptions = async (
      select: Locator
    ) => {
      await clickRemapControl(select)
      await page.waitForTimeout(350)

      const optionNodes = page.locator(".ant-select-dropdown:visible .ant-select-item-option")
      const optionCount = Math.min(await optionNodes.count().catch(() => 0), 120)
      const optionTexts: string[] = []
      const usableOptionTexts: string[] = []

      for (let optionIndex = 0; optionIndex < optionCount; optionIndex += 1) {
        const option = optionNodes.nth(optionIndex)
        if (!await option.isVisible().catch(() => false)) {
          continue
        }

        const optionText = cleanVisibleText(await option.innerText().catch(() => ""))
        if (!optionText) {
          continue
        }

        optionTexts.push(optionText)
        if (isUsableOptionText(optionText) && !await isDisabledAntOption(option)) {
          usableOptionTexts.push(optionText)
        }
      }

      await page.keyboard.press("Escape").catch(() => undefined)
      await page.waitForTimeout(120)

      return {
        optionTexts,
        usableOptionTexts
      }
    }

    const scoreCandidate = (
      sourceText: string,
      candidateText: string,
      currentSelectedText: string,
      preferredIndex: number,
      candidateOrder: number
    ) => {
      const desiredTexts = buildDesiredTexts(sourceText)
      const candidateNormalized = normalizeMatchText(candidateText)
      const candidateColor = normalizeColorMatchText(candidateText)
      const candidateSizeToken = extractSizeToken(candidateText)

      let bestScore = Number.NEGATIVE_INFINITY
      let matchedBy = "none"

      const updateBest = (score: number, reason: string) => {
        if (score > bestScore) {
          bestScore = score
          matchedBy = reason
        }
      }

      for (const desiredText of desiredTexts) {
        const normalizedDesired = normalizeMatchText(desiredText)
        if (!normalizedDesired || !candidateNormalized) {
          continue
        }

        if (candidateNormalized === normalizedDesired) {
          updateBest(1_400, "desired")
          continue
        }
        if (candidateNormalized.includes(normalizedDesired) || normalizedDesired.includes(candidateNormalized)) {
          updateBest(1_240 - Math.abs(candidateNormalized.length - normalizedDesired.length) * 6, "desired-partial")
        }
      }

      if (tab.text === "颜色") {
        const sourceColor = normalizeColorMatchText(sourceText)
        if (sourceColor && candidateColor) {
          if (candidateColor === sourceColor) {
            updateBest(1_120, "exact-color")
          } else if (candidateColor.includes(sourceColor) || sourceColor.includes(candidateColor)) {
            updateBest(980 - Math.abs(candidateColor.length - sourceColor.length) * 10, "fuzzy-color")
          } else {
            const sourceChars = [...new Set(sourceColor.split(""))]
            const optionChars = new Set(candidateColor.split(""))
            const sharedCount = sourceChars.filter((char) => optionChars.has(char)).length
            if (sharedCount > 0) {
              let score = sharedCount * 115
              if (sourceColor[0] === candidateColor[0]) {
                score += 90
              }
              if (sourceColor.at(-1) === candidateColor.at(-1)) {
                score += 40
              }
              updateBest(score, "fuzzy-color")
            }
          }
        }
      }

      const sourceSizeToken = extractSizeToken(sourceText)
      if (sourceSizeToken && candidateSizeToken) {
        if (candidateSizeToken === sourceSizeToken) {
          updateBest(1_060, "size-token")
        } else if (candidateText.toUpperCase().includes(sourceSizeToken) || sourceSizeToken.includes(candidateSizeToken)) {
          updateBest(920, "size-token-partial")
        }
      }

      const currentSelectionKey = normalizeOptionKey(currentSelectedText)
      const candidateKey = normalizeOptionKey(candidateText)
      if (currentSelectionKey && candidateKey && currentSelectionKey === candidateKey) {
        updateBest(150, "keep-current")
      }

      updateBest(Math.max(0, 80 - Math.abs(candidateOrder - preferredIndex) * 12), "row-order")

      return {
        score: bestScore,
        matchedBy
      }
    }

    const rowsBeforeManualSelection = await collectRows()
    console.log(`variant-remap: tab ${tab.text} visible rows=${rowsBeforeManualSelection.length}`)
    const rowOptionSnapshots = new Map<string, {
      optionTexts: string[]
      usableOptionTexts: string[]
    }>()
    for (const row of rowsBeforeManualSelection) {
      rowOptionSnapshots.set(row.rowKey, await readSelectOptions(row.select))
    }
    console.log(`variant-remap: tab ${tab.text} option snapshots collected=${rowOptionSnapshots.size}`)

    for (const row of rowsBeforeManualSelection) {
      if (row.customInput && !row.customNameText && row.sourceText) {
        await row.customInput.fill(row.sourceText).catch(() => undefined)
        await page.waitForTimeout(150)
      }
    }

    const currentSelectionPool = rowsBeforeManualSelection
      .map((row) => cleanVisibleText(row.selectedText))
      .filter(isUsableOptionText)

    const assignmentPlans = new Map<string, {
      targetText: string | null
      matchedBy: string
      score: number
      optionTexts: string[]
    }>()
    const assignedKeys = new Set<string>()

    for (const row of rowsBeforeManualSelection) {
      const snapshot = rowOptionSnapshots.get(row.rowKey) ?? {
        optionTexts: [] as string[],
        usableOptionTexts: [] as string[]
      }
      const candidateMap = new Map<string, {
        text: string
        order: number
      }>()

      let order = 0
      for (const optionText of snapshot.usableOptionTexts) {
        const key = normalizeOptionKey(optionText)
        if (!key || candidateMap.has(key)) {
          continue
        }
        candidateMap.set(key, {
          text: optionText,
          order
        })
        order += 1
      }

      for (const optionText of currentSelectionPool) {
        const key = normalizeOptionKey(optionText)
        if (!key || candidateMap.has(key)) {
          continue
        }
        candidateMap.set(key, {
          text: optionText,
          order
        })
        order += 1
      }

      const rankedCandidates = [...candidateMap.entries()]
        .map(([key, candidate]) => {
          const scored = scoreCandidate(
            row.sourceText,
            candidate.text,
            row.selectedText,
            row.rowIndex,
            candidate.order
          )

          return {
            key,
            text: candidate.text,
            order: candidate.order,
            score: scored.score,
            matchedBy: scored.matchedBy
          }
        })
        .sort((left, right) =>
          right.score - left.score
          || left.order - right.order
        )

      const chosenCandidate = rankedCandidates.find((candidate) => !assignedKeys.has(candidate.key))
        ?? rankedCandidates[0]
        ?? null

      if (chosenCandidate?.key) {
        assignedKeys.add(chosenCandidate.key)
      }

      assignmentPlans.set(row.rowKey, {
        targetText: chosenCandidate?.text ?? (cleanVisibleText(row.selectedText) || null),
        matchedBy: chosenCandidate?.matchedBy ?? "none",
        score: chosenCandidate?.score ?? Number.NEGATIVE_INFINITY,
        optionTexts: snapshot.optionTexts
      })
    }

    const optionMatchesTarget = (optionText: string, targetText: string) => {
      const optionKey = normalizeOptionKey(optionText)
      const targetKey = normalizeOptionKey(targetText)
      if (optionKey && targetKey && optionKey === targetKey) {
        return true
      }

      const normalizedOption = normalizeMatchText(optionText)
      const normalizedTarget = normalizeMatchText(targetText)
      if (
        normalizedOption
        && normalizedTarget
        && normalizedOption.includes(normalizedTarget)
      ) {
        return true
      }

      if (tab.text === "颜色") {
        const optionColor = normalizeColorMatchText(optionText)
        const targetColor = normalizeColorMatchText(targetText)
        if (
          optionColor
          && targetColor
          && (
            optionColor === targetColor
            || optionColor.includes(targetColor)
          )
        ) {
          return true
        }
      }

      const optionSizeToken = extractSizeToken(optionText)
      const targetSizeToken = extractSizeToken(targetText)
      return Boolean(
        optionSizeToken
        && targetSizeToken
        && (
          optionSizeToken === targetSizeToken
          || optionText.toUpperCase().includes(targetSizeToken)
        )
      )
    }

    const scoreOptionAgainstTarget = (optionText: string, targetText: string) => {
      const optionKey = normalizeOptionKey(optionText)
      const targetKey = normalizeOptionKey(targetText)
      const normalizedOption = normalizeMatchText(optionText)
      const normalizedTarget = normalizeMatchText(targetText)
      let bestScore = Number.NEGATIVE_INFINITY
      let matchedBy = "none"

      const updateBest = (score: number, reason: string) => {
        if (score > bestScore) {
          bestScore = score
          matchedBy = reason
        }
      }

      if (optionKey && targetKey && optionKey === targetKey) {
        updateBest(3_200, "exact-key")
      }

      if (normalizedOption && normalizedTarget && normalizedOption === normalizedTarget) {
        updateBest(3_100, "exact-normalized")
      } else if (normalizedOption && normalizedTarget && normalizedOption.includes(normalizedTarget)) {
        updateBest(2_250 - Math.abs(normalizedOption.length - normalizedTarget.length) * 10, "contains-target")
      }

      if (tab.text === "棰滆壊") {
        const optionColor = normalizeColorMatchText(optionText)
        const targetColor = normalizeColorMatchText(targetText)
        if (optionColor && targetColor && optionColor === targetColor) {
          updateBest(3_000, "exact-color")
        } else if (optionColor && targetColor && optionColor.includes(targetColor)) {
          updateBest(2_050 - Math.abs(optionColor.length - targetColor.length) * 18, "contains-color")
        }
      }

      const optionSizeToken = extractSizeToken(optionText)
      const targetSizeToken = extractSizeToken(targetText)
      if (optionSizeToken && targetSizeToken && optionSizeToken === targetSizeToken) {
        updateBest(2_900, "size-token")
      } else if (optionSizeToken && targetSizeToken && optionText.toUpperCase().includes(targetSizeToken)) {
        updateBest(2_300, "size-token-partial")
      }

      return {
        score: bestScore,
        matchedBy
      }
    }

    const isStrictTargetMatch = (optionText: string, targetText: string) => {
      const match = scoreOptionAgainstTarget(optionText, targetText)
      return (
        match.matchedBy === "exact-key"
        || match.matchedBy === "exact-normalized"
        || match.matchedBy === "exact-color"
        || match.matchedBy === "size-token"
      )
    }

    const selectionSatisfiesPlan = (
      selectedText: string,
      targetText: string | null | undefined
    ) => Boolean(targetText && isStrictTargetMatch(selectedText, targetText))

    const attemptSelectTargetText = async (
      rowState: {
        rowIndex: number
        row: Locator
        select: Locator
        sourceText: string
        selectedText: string
        customInput: Locator | null
        customNameText: string
      },
      targetText: string
    ) => {
      await clickRemapControl(rowState.select)
      await page.waitForTimeout(350)

      const optionNodes = page.locator(".ant-select-dropdown:visible .ant-select-item-option")
      const optionCount = Math.min(await optionNodes.count().catch(() => 0), 120)
      const optionTexts: string[] = []
      const usableOptions: Array<{ locator: Locator; text: string }> = []

      for (let optionIndex = 0; optionIndex < optionCount; optionIndex += 1) {
        const option = optionNodes.nth(optionIndex)
        if (!await option.isVisible().catch(() => false)) {
          continue
        }

        const optionText = cleanVisibleText(await option.innerText().catch(() => ""))
        if (!optionText) {
          continue
        }

        optionTexts.push(optionText)
        if (isUsableOptionText(optionText) && !await isDisabledAntOption(option)) {
          usableOptions.push({
            locator: option,
            text: optionText
          })
        }
      }

      const matchedOption = usableOptions
        .map((option, optionOrder) => ({
          ...option,
          optionOrder,
          match: scoreOptionAgainstTarget(option.text, targetText)
        }))
        .filter((option) => option.match.score > Number.NEGATIVE_INFINITY)
        .sort((left, right) =>
          right.match.score - left.match.score
          || left.optionOrder - right.optionOrder
        )[0] ?? null
      if (!matchedOption) {
        await page.keyboard.press("Escape").catch(() => undefined)
        return {
          selected: false,
          selectedText: null as string | null,
          afterText: await readRemapSelectText(rowState.select),
          optionTexts,
          usableOptionTexts: usableOptions.map((option) => option.text)
        }
      }

      const optionClicked = await clickRemapControl(matchedOption.locator)
      if (!optionClicked) {
        await page.keyboard.press("Escape").catch(() => undefined)
        return {
          selected: false,
          selectedText: null as string | null,
          afterText: await readRemapSelectText(rowState.select),
          optionTexts,
          usableOptionTexts: usableOptions.map((option) => option.text)
        }
      }
      await page.waitForTimeout(350)
      return {
        selected: true,
        selectedText: matchedOption.text,
        afterText: await readRemapSelectText(rowState.select),
        optionTexts,
        usableOptionTexts: usableOptions.map((option) => option.text)
      }
    }

    const pickTemporaryOptionTexts = (
      usableOptionTexts: string[],
      currentSelectionKeys: Set<string>,
      plannedTargetKeys: Set<string>,
      currentSelectedText: string,
      targetText: string
    ) => {
      const currentKey = normalizeOptionKey(currentSelectedText)
      const targetKey = normalizeOptionKey(targetText)
      const seen = new Set<string>()
      const ordered: string[] = []
      const pushMatches = (predicate: (key: string, optionText: string) => boolean) => {
        for (const optionText of usableOptionTexts) {
          const key = normalizeOptionKey(optionText)
          if (!key || seen.has(key) || !predicate(key, optionText)) {
            continue
          }
          seen.add(key)
          ordered.push(optionText)
        }
      }

      pushMatches((key) =>
        key !== currentKey
        && key !== targetKey
        && !plannedTargetKeys.has(key)
        && !currentSelectionKeys.has(key)
      )
      pushMatches((key) =>
        key !== currentKey
        && key !== targetKey
        && !plannedTargetKeys.has(key)
      )
      pushMatches((key) => key !== currentKey && key !== targetKey)

      return ordered
    }

    const rowSelections: Array<{
      sourceText: string
      beforeText: string
      afterText: string
      selectedText: string | null
      targetText: string | null
      matchedBy: string
      optionTexts: string[]
      customNameBefore: string
      customNameAfter: string
    }> = []

    const selectionAttempts = new Map<string, {
      selected: boolean
      selectedText: string | null
      afterText: string
      optionTexts: string[]
      usableOptionTexts: string[]
    }>()
    const pendingRows = new Set(
      rowsBeforeManualSelection
        .filter((row) => {
          const targetText = assignmentPlans.get(row.rowKey)?.targetText
          return Boolean(targetText && !selectionSatisfiesPlan(row.selectedText, targetText))
        })
        .map((row) => row.rowKey)
    )

    let rowsAfterManualSelection = await collectRows()
    let liveRowsByKey = new Map(rowsAfterManualSelection.map((row) => [row.rowKey, row]))
    const currentOwnerByKey = new Map<string, number>()
    const targetRowByKey = new Map<string, string>()
    for (const row of rowsBeforeManualSelection) {
      const targetKey = normalizeOptionKey(assignmentPlans.get(row.rowKey)?.targetText ?? "")
      if (targetKey) {
        targetRowByKey.set(targetKey, row.rowKey)
      }
    }

    const rebuildCurrentOwners = async () => {
      currentOwnerByKey.clear()
      rowsAfterManualSelection = await collectRows()
      for (const liveRow of rowsAfterManualSelection) {
        const currentKey = normalizeOptionKey(liveRow.selectedText)
        if (currentKey) {
          currentOwnerByKey.set(currentKey, liveRow.rowIndex)
        }
        const plan = assignmentPlans.get(liveRow.rowKey)
        if (
          plan?.targetText
          && selectionSatisfiesPlan(liveRow.selectedText, plan.targetText)
        ) {
          pendingRows.delete(liveRow.rowKey)
        }
      }
      liveRowsByKey = new Map(rowsAfterManualSelection.map((row) => [row.rowKey, row]))
    }

    const refreshLiveRows = async () => {
      rowsAfterManualSelection = await collectRows()
      liveRowsByKey = new Map(rowsAfterManualSelection.map((row) => [row.rowKey, row]))
      await rebuildCurrentOwners()
    }

    const moveRowToText = async (rowKey: string, targetText: string) => {
      const liveRow = liveRowsByKey.get(rowKey) ?? null
      if (!liveRow) {
        return {
          success: false,
          freedKey: "",
          attempt: null as null | {
            selected: boolean
            selectedText: string | null
            afterText: string
            optionTexts: string[]
            usableOptionTexts: string[]
          }
        }
      }

      const beforeKey = normalizeOptionKey(liveRow.selectedText)
      let latestAttempt: {
        selected: boolean
        selectedText: string | null
        afterText: string
        optionTexts: string[]
        usableOptionTexts: string[]
      } | null = null
      let afterRow: typeof liveRow | null = null
      let success = false

      for (let moveAttempt = 1; moveAttempt <= 2; moveAttempt += 1) {
        const activeRow = liveRowsByKey.get(rowKey) ?? liveRow
        console.log(`variant-remap: tab ${tab.text} move row=${rowKey} current=${activeRow.selectedText || "(empty)"} target=${targetText} try=${moveAttempt}`)
        latestAttempt = await attemptSelectTargetText(activeRow, targetText)
        selectionAttempts.set(rowKey, latestAttempt)
        await waitForDianxiaomiLoadingOverlayToClear(page, 3_000).catch(() => false)
        await page.waitForTimeout(250)
        await refreshLiveRows()
        afterRow = liveRowsByKey.get(rowKey) ?? null
        success = Boolean(afterRow && selectionSatisfiesPlan(afterRow.selectedText, targetText))
        console.log(`variant-remap: tab ${tab.text} move row=${rowKey} success=${success} after=${afterRow?.selectedText ?? latestAttempt.afterText} try=${moveAttempt}`)
        if (success) {
          break
        }

        const afterKey = normalizeOptionKey(afterRow?.selectedText ?? latestAttempt.afterText)
        if (moveAttempt >= 2 || (afterKey && afterKey !== beforeKey)) {
          break
        }

        await page.waitForTimeout(400)
      }

      if (success) {
        pendingRows.delete(rowKey)
      }

      return {
        success,
        freedKey: success ? beforeKey : "",
        attempt: latestAttempt
      }
    }

    await refreshLiveRows()
    let guard = 0
    while (pendingRows.size > 0 && guard < Math.max(8, rowsBeforeManualSelection.length * 4)) {
      guard += 1
      console.log(`variant-remap: tab ${tab.text} resolve pass=${guard} pending=${pendingRows.size}`)
      let progressed = false

      const freeStarters = [...pendingRows].filter((rowIndex) => {
        const plan = assignmentPlans.get(rowIndex)
        const targetKey = normalizeOptionKey(plan?.targetText ?? "")
        if (!targetKey) {
          return false
        }
        const owner = currentOwnerByKey.get(targetKey)
        const liveRow = liveRowsByKey.get(rowIndex) ?? null
        return owner === undefined || owner === liveRow?.rowIndex
      })

      if (freeStarters.length > 0) {
        for (const starterIndex of freeStarters) {
          let nextRowIndex: string | undefined = starterIndex
          let starterProgressed = false
          while (nextRowIndex !== undefined) {
            const plan = assignmentPlans.get(nextRowIndex)
            if (!plan?.targetText || !pendingRows.has(nextRowIndex)) {
              break
            }

            const move = await moveRowToText(nextRowIndex, plan.targetText)
            if (!move.success) {
              break
            }

            progressed = true
            starterProgressed = true
            nextRowIndex = move.freedKey ? targetRowByKey.get(move.freedKey) : undefined
            if (nextRowIndex !== undefined && !pendingRows.has(nextRowIndex)) {
              break
            }
          }
          if (starterProgressed) {
            break
          }
        }
      }

      if (!progressed) {
        const pivotCandidates = [...pendingRows]

        for (const pivotIndex of pivotCandidates) {
          const pivotRow = liveRowsByKey.get(pivotIndex) ?? null
          const pivotPlan = assignmentPlans.get(pivotIndex)
          if (!pivotRow || !pivotPlan?.targetText) {
            continue
          }

          const latestAttempt = selectionAttempts.get(pivotIndex) ?? null
          const currentSelectionKeys = new Set(
            rowsAfterManualSelection
              .map((row) => normalizeOptionKey(row.selectedText))
              .filter(Boolean)
          )
          const plannedTargetKeys = new Set(
            [...assignmentPlans.values()]
              .map((plan) => normalizeOptionKey(plan.targetText ?? ""))
              .filter(Boolean)
          )
          const latestOptions =
            latestAttempt && latestAttempt.usableOptionTexts.length > 0
              ? latestAttempt.usableOptionTexts
              : (await readSelectOptions(pivotRow.select)).usableOptionTexts
          const temporaryOptionTexts = pickTemporaryOptionTexts(
            latestOptions,
            currentSelectionKeys,
            plannedTargetKeys,
            pivotRow.selectedText,
            pivotPlan.targetText
          )

          if (temporaryOptionTexts.length <= 0) {
            console.log(`variant-remap: tab ${tab.text} no temporary option for pivot=${pivotIndex}`)
            continue
          }

          const pivotCurrentKey = normalizeOptionKey(pivotRow.selectedText)
          let tempMove:
            | {
              success: boolean
              freedKey: string
              attempt: null | {
                selected: boolean
                selectedText: string | null
                afterText: string
                optionTexts: string[]
                usableOptionTexts: string[]
              }
            }
            | null = null
          let temporaryOptionText: string | null = null

          for (const candidateTemporaryOptionText of temporaryOptionTexts.slice(0, 8)) {
            const candidateMove = await moveRowToText(pivotIndex, candidateTemporaryOptionText)
            if (!candidateMove.success) {
              console.log(`variant-remap: tab ${tab.text} temporary move failed pivot=${pivotIndex} option=${candidateTemporaryOptionText}`)
              continue
            }
            tempMove = candidateMove
            temporaryOptionText = candidateTemporaryOptionText
            break
          }

          if (!tempMove?.success) {
            continue
          }

          progressed = true
          console.log(`variant-remap: tab ${tab.text} temporary move succeeded pivot=${pivotIndex} option=${temporaryOptionText}`)
          let freedKey = pivotCurrentKey
          while (freedKey) {
            const consumerRowIndex = targetRowByKey.get(freedKey)
            if (consumerRowIndex === undefined || consumerRowIndex === pivotIndex || !pendingRows.has(consumerRowIndex)) {
              break
            }

            const consumerPlan = assignmentPlans.get(consumerRowIndex)
            if (!consumerPlan?.targetText) {
              break
            }

            const move = await moveRowToText(consumerRowIndex, consumerPlan.targetText)
            if (!move.success) {
              freedKey = ""
              break
            }

            freedKey = move.freedKey
          }

          const pivotFinalize = await moveRowToText(pivotIndex, pivotPlan.targetText)
          if (!pivotFinalize.success) {
            console.log(`variant-remap: tab ${tab.text} pivot finalize failed pivot=${pivotIndex} target=${pivotPlan.targetText}`)
          }

          break
        }
      }

      if (pendingRows.size <= 0) {
        break
      }

      if (!progressed) {
        break
      }
    }

    rowsAfterManualSelection = await collectRows()
    console.log(`variant-remap: tab ${tab.text} rows after reconcile=${rowsAfterManualSelection.length} pending=${pendingRows.size}`)
    const rowsAfterByKey = new Map(rowsAfterManualSelection.map((row) => [row.rowKey, row]))
    for (const row of rowsBeforeManualSelection) {
      const plan = assignmentPlans.get(row.rowKey)
      const finalRow = rowsAfterByKey.get(row.rowKey)
      const latestAttempt = selectionAttempts.get(row.rowKey)
      rowSelections.push({
        sourceText: row.sourceText,
        beforeText: row.selectedText,
        afterText: finalRow?.selectedText ?? latestAttempt?.afterText ?? row.selectedText,
        selectedText: finalRow?.selectedText ?? latestAttempt?.selectedText ?? (row.selectedText || null),
        targetText: plan?.targetText ?? null,
        matchedBy: plan?.matchedBy ?? "none",
        optionTexts: latestAttempt?.optionTexts ?? plan?.optionTexts ?? [],
        customNameBefore: row.customNameText,
        customNameAfter: finalRow?.customInput
          ? cleanVisibleText(await finalRow.customInput.inputValue().catch(() => ""))
          : row.customNameText
      })
    }

    filledTabs.push({
      tab: tab.text,
      fillClicked,
      rowCount: rowsAfterManualSelection.length,
      placeholderRowsBefore: rowsBeforeManualSelection.filter((row) => !row.selectedText || row.selectedText.includes(SELECT_PLACEHOLDER_TEXT)).length,
      placeholderRowsAfter: rowsAfterManualSelection.filter((row) => !row.selectedText || row.selectedText.includes(SELECT_PLACEHOLDER_TEXT)).length,
      rowSelections
    })
  }

  return filledTabs
}

const confirmVariantRemapFollowupDialogs = async (
  page: Page,
  baselineVisibleDialogs: number
) => {
  const handledTexts: string[] = []
  for (let round = 0; round < 3; round += 1) {
    const dialogs = await visibleModalCandidates(page)
    const followup = dialogs.at(-1) ?? null
    if (!followup) {
      break
    }

    const text = normalizeFeedbackText(await followup.innerText().catch(() => ""))
    if (!text) {
      break
    }
    if (text.includes("清空") && (text.includes("对应关系") || text.includes("自定义名称"))) {
      const actionNodes = followup.locator("button, [role='button'], input[type='button'], input[type='submit'], a")
      const actionCount = Math.min(await actionNodes.count().catch(() => 0), 12)
      let confirmDangerButton: Locator | null = null
      for (let index = actionCount - 1; index >= 0; index -= 1) {
        const action = actionNodes.nth(index)
        if (!await action.isVisible().catch(() => false)) {
          continue
        }

        const actionText = compactActionText(
          await action.innerText().catch(async () => await action.getAttribute("value").catch(() => ""))
        )
        if (!actionText) {
          continue
        }

        if (["确定", "确认", "继续", "ok", "confirm"].some((keyword) => actionText === keyword || actionText.includes(keyword))) {
          confirmDangerButton = action
          break
        }
      }
      confirmDangerButton ??= await findInteractiveInRootByKeywords(followup, ["确定", "确认", "继续", "ok", "confirm"])
      if (confirmDangerButton) {
        await clickAfterDianxiaomiIdle(page, confirmDangerButton, 1).catch(async () => {
          await confirmDangerButton.click({ force: true }).catch(() => undefined)
        })
        handledTexts.push(`confirm-danger:${text}`)
        await page.waitForTimeout(800)
        continue
      }
      handledTexts.push(`danger-unhandled:${text}`)
      break
    }
    if (!text.includes("返回上一步") && !text.includes("信息将会清空") && !text.includes("确认")) {
      if (dialogs.length <= baselineVisibleDialogs) {
        break
      }
      break
    }

    const confirmButton = await findInteractiveInRootByKeywords(followup, VARIANT_REMAP_CONFIRM_KEYWORDS)
    if (!confirmButton) {
      handledTexts.push(text)
      break
    }

    await clickAfterDianxiaomiIdle(page, confirmButton, 1).catch(async () => {
      await confirmButton.click({ force: true }).catch(() => undefined)
    })
    handledTexts.push(text)
    await page.waitForTimeout(1_000)
    await waitForVisibleModalCandidateCountAtMost(page, Math.max(0, baselineVisibleDialogs), 4_000).catch(() => false)
  }

  return handledTexts
}

export const normalizeVariantRemap = async (
  page: Page,
  reason: string
) => {
  console.log(`variant-remap: normalize start reason=${reason}`)
  const beforeRows = await findSkuRows(page)
  const bodyText = normalizeFeedbackText(await page.locator("body").innerText().catch(() => ""))
  const colorSection = page.locator(COLOR_SKC_SECTION_SELECTOR).first()
  const colorSectionVisible = await colorSection.isVisible().catch(() => false)
  const surfaceSignalsPresent = VARIANT_REMAP_SURFACE_HINT_KEYWORDS.some((keyword) => bodyText.includes(keyword))

  if (beforeRows.length > 0) {
    console.log(`variant-remap: skip rows already visible=${beforeRows.length}`)
    return stepResult(
      "normalize-variant-remap",
      "Normalize variant remap",
      "skipped",
      `Variant rows are already visible (${beforeRows.length})`,
      {
        reason,
        beforeRows: beforeRows.length
      }
    )
  }

  if (!colorSectionVisible && !surfaceSignalsPresent) {
    console.log("variant-remap: skip because no visible trigger signals")
    return stepResult(
      "normalize-variant-remap",
      "Normalize variant remap",
      "skipped",
      "Variant remap controls are not visible on the current Dianxiaomi page",
      {
        reason,
        beforeRows: beforeRows.length,
        colorSectionVisible,
        surfaceSignalsPresent
      }
    )
  }

  const openDialogsBefore = (await visibleModalCandidates(page)).length
  let remapAction = {
    attempted: false,
    clicked: false,
    reason,
    text: ""
  }
  if (colorSectionVisible) {
    remapAction = await clickColorSkcRemapTrigger(page, colorSection, reason)
  } else {
    const pageTrigger = await findLooseActionInRootByKeywords(page, COLOR_SKC_REMAP_KEYWORDS)
    if (pageTrigger && await pageTrigger.isVisible().catch(() => false)) {
      const triggerText = cleanVisibleText(await pageTrigger.innerText().catch(() => ""))
      await clickAfterDianxiaomiIdle(page, pageTrigger, 2).catch(async () => {
        await pageTrigger.click({ force: true }).catch(() => undefined)
      })
      await page.waitForTimeout(1_200)
      remapAction = {
        attempted: true,
        clicked: true,
        reason,
        text: triggerText
      }
    }
  }

  if (!remapAction.clicked) {
    console.log("variant-remap: trigger click failed")
    return stepResult(
      "normalize-variant-remap",
      "Normalize variant remap",
      "failed",
      "Variant remap trigger is visible in validation signals but could not be clicked",
      {
        reason,
        beforeRows: beforeRows.length,
        remapAction,
        openDialogsBefore
      }
    )
  }

  const surface = await waitForVariantRemapSurface(page)
  if (!surface) {
    console.log("variant-remap: surface did not appear after trigger")
    const rowsWithoutModal = await waitForVariantRowsReady(page, beforeRows.length, 4_000)
    if (rowsWithoutModal.length > beforeRows.length) {
      return stepResult(
        "normalize-variant-remap",
        "Normalize variant remap",
        "done",
        `Variant rows materialized after remap trigger (${beforeRows.length} -> ${rowsWithoutModal.length})`,
        {
          reason,
          beforeRows: beforeRows.length,
          afterRows: rowsWithoutModal.length,
          remapAction,
          openedModal: false
        }
      )
    }

    return stepResult(
      "normalize-variant-remap",
      "Normalize variant remap",
      "failed",
      "Clicked variant remap trigger but the remap surface did not appear",
      {
        reason,
        beforeRows: beforeRows.length,
        afterRows: rowsWithoutModal.length,
        remapAction,
        openedModal: false
      }
    )
  }

  const surfaceTextBefore = await readVariantRemapSurfaceText(surface)
  console.log("variant-remap: surface opened")
  const actionsClicked: string[] = []
  const progressAction = await chooseVariantRemapAction(page, surface, VARIANT_REMAP_PROGRESS_KEYWORDS, VARIANT_REMAP_NEGATIVE_KEYWORDS)
  if (progressAction) {
    const actionText = cleanVisibleText(await progressAction.innerText().catch(async () => await progressAction.getAttribute("value").catch(() => "")))
    await clickAfterDianxiaomiIdle(page, progressAction, 2).catch(async () => {
      await progressAction.click({ force: true }).catch(() => undefined)
    })
    actionsClicked.push(actionText || "next")
    await page.waitForTimeout(1_000)
    console.log(`variant-remap: progressed to stage two via ${actionText || "next"}`)
  }

  let activeSurface = await waitForVariantRemapSurface(page, 3_000)
  if (!activeSurface) {
    console.log("variant-remap: surface closed after progress click")
    const rowsAfterProgress = await waitForVariantRowsReady(page, beforeRows.length, 6_000)
    return stepResult(
      "normalize-variant-remap",
      "Normalize variant remap",
      rowsAfterProgress.length > beforeRows.length ? "done" : "failed",
      rowsAfterProgress.length > beforeRows.length
        ? `Variant rows materialized after remap flow (${beforeRows.length} -> ${rowsAfterProgress.length})`
        : "Variant remap surface closed but variant rows are still missing",
      {
        reason,
        beforeRows: beforeRows.length,
        afterRows: rowsAfterProgress.length,
        remapAction,
        openedModal: true,
        surfaceTextBefore,
        actionsClicked
      }
    )
  }

  const filledTabs = await fillVariantRemapStageTwoTabs(page, activeSurface)
  console.log(`variant-remap: filled tabs count=${filledTabs.length}`)
  actionsClicked.push(...filledTabs.filter((item) => item.fillClicked).map((item) => `fill:${item.tab}`))
  const unresolvedSelections = filledTabs
    .flatMap((tab) => tab.rowSelections.map((row) => ({
      tab: tab.tab,
      sourceText: row.sourceText,
      selectedText: row.selectedText,
      targetText: row.targetText
    })))
    .filter((row) => !variantSelectionMatchesTarget(row.selectedText, row.targetText))

  const confirmAction = await chooseVariantRemapAction(page, activeSurface, VARIANT_REMAP_CONFIRM_KEYWORDS, VARIANT_REMAP_NEGATIVE_KEYWORDS)
  if (confirmAction) {
    const actionText = cleanVisibleText(await confirmAction.innerText().catch(async () => await confirmAction.getAttribute("value").catch(() => "")))
    await clickAfterDianxiaomiIdle(page, confirmAction, 2).catch(async () => {
      await confirmAction.click({ force: true }).catch(() => undefined)
    })
    actionsClicked.push(actionText || "confirm")
    await page.waitForTimeout(1_200)
    console.log(`variant-remap: confirm clicked via ${actionText || "confirm"}`)
  }

  const followupDialogs = await confirmVariantRemapFollowupDialogs(page, openDialogsBefore)
  await waitForVisibleModalCandidateCountAtMost(page, openDialogsBefore, 6_000).catch(() => false)
  const rowsAfter = await waitForVariantRowsReady(page, beforeRows.length)
  const finalSurface = await findVariantRemapSurface(page)
  const finalSurfaceText = await readVariantRemapSurfaceText(finalSurface)
  const categoryRecoveryState = await inspectCategoryPreparationState(page)
  console.log(`variant-remap: finalize rowsAfter=${rowsAfter.length} modalStillVisible=${Boolean(finalSurface)}`)
  const feedbackTexts = (await collectFeedbackTexts(page))
    .map((item) => ({
      source: item.source,
      text: item.source === "body"
        ? focusBodyFeedbackText(item.text, "变种", item.source)
        : item.text
    }))
    .filter((item, index, values) =>
      Boolean(item.text)
      && /(变种|属性|尺码表|重点展示|请选择|清空)/.test(item.text)
      && values.findIndex((candidate) => candidate.source === item.source && candidate.text === item.text) === index
    )
    .slice(0, 12)

  return stepResult(
    "normalize-variant-remap",
    "Normalize variant remap",
    rowsAfter.length > beforeRows.length
      ? "done"
      : unresolvedSelections.length === 0
        ? "done"
        : "failed",
    rowsAfter.length > beforeRows.length
      ? `Variant rows materialized after remap flow (${beforeRows.length} -> ${rowsAfter.length})`
      : unresolvedSelections.length === 0
        ? "Variant remap selections were fully reconciled, but variant rows are still not visible on the page"
        : "Variant remap flow completed but variant rows are still missing",
    {
      reason,
      beforeRows: beforeRows.length,
      afterRows: rowsAfter.length,
      remapAction,
      openedModal: true,
      surfaceTextBefore,
      surfaceTextAfter: finalSurfaceText,
      actionsClicked,
      filledTabs,
      unresolvedSelections,
      followupDialogs,
      modalStillVisible: Boolean(finalSurface),
      categoryRecoveryState,
      feedbackTexts
    }
  )
}

const waitForColorSkcReduction = async (
  page: Page,
  beforeState: Awaited<ReturnType<typeof collectColorSkcGroupState>>,
  labelText: string,
  timeoutMs = COLOR_SKC_RECALC_TIMEOUT_MS
) => {
  const deadline = Date.now() + timeoutMs
  let afterState = beforeState
  let removedFromTable = false

  while (Date.now() < deadline) {
    await page.waitForTimeout(300)
    afterState = await collectColorSkcGroupState(page)
    removedFromTable = !afterState.groups.some((group) => normalizeText(group.label) === normalizeText(labelText))
    if (afterState.groupCount < beforeState.groupCount || removedFromTable) {
      return {
        reduced: true,
        removedFromTable,
        afterState
      }
    }
  }

  afterState = await collectColorSkcGroupState(page)
  removedFromTable = !afterState.groups.some((group) => normalizeText(group.label) === normalizeText(labelText))
  return {
    reduced: afterState.groupCount < beforeState.groupCount || removedFromTable,
    removedFromTable,
    afterState
  }
}

const refreshCurrentDianxiaomiEditPage = async (
  page: Page,
  reason: string
) => {
  const targetUrl = page.url()
  if (!isRealDianxiaomiEditTargetUrl(targetUrl)) {
    return false
  }

  console.log(`Refreshing current Dianxiaomi edit page before color SKC trim because ${reason}: ${targetUrl}`)
  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded"
  }).catch((error) => {
    console.warn(`Refresh before color SKC trim failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  await waitForPublishPage(page, loadSelectorConfig(".runtime/dianxiaomi-selector-config.json"), {
    waitForManualNavigation: false,
    targetUrl,
    allowSameTargetRefresh: false
  })
  await page.waitForTimeout(1_500)
  return true
}

const setColorOptionChecked = async (
  page: Page,
  option: Locator,
  checked: boolean
) => {
  const checkbox = option.locator("input[type='checkbox']").first()
  const hasCheckbox = await checkbox.count().catch(() => 0) > 0
  await option.scrollIntoViewIfNeeded().catch(() => undefined)
  const before = hasCheckbox ? await checkbox.isChecked().catch(() => null as boolean | null) : null

  if (!checked) {
    let clicked = false
    await clickAfterDianxiaomiIdle(page, option, 2).then(() => {
      clicked = true
    }).catch(async () => {
      clicked = await option.click({
        force: true
      }).then(() => true).catch(() => false)
    })
    await page.waitForTimeout(250)
    const after = hasCheckbox ? await checkbox.isChecked().catch(() => before) : null
    return {
      found: true,
      before,
      after,
      changed: before === null ? clicked : before !== after,
      clicked
    }
  }

  if (!hasCheckbox) {
    return {
      found: false,
      before: null,
      after: null,
      changed: false,
      clicked: false
    }
  }

  if (before !== null && before !== checked) {
    await checkbox.setChecked(checked, {
      force: true
    }).catch(async () => {
      const updated = await checkbox.evaluate((node, nextChecked) => {
        if (!(node instanceof HTMLInputElement)) {
          return false
        }

        node.checked = nextChecked
        node.dispatchEvent(new Event("input", {
          bubbles: true
        }))
        node.dispatchEvent(new Event("change", {
          bubbles: true
        }))
        return true
      }, checked).catch(() => false)

      if (!updated) {
        await clickAfterDianxiaomiIdle(page, option, 2)
      }
    })
    await page.waitForTimeout(250)
  }

  const after = await checkbox.isChecked().catch(() => before)
  return {
    found: true,
    before,
    after,
    changed: before !== after,
    clicked: before !== after
  }
}

const setColorOptionCheckedByTextFallback = async (
  page: Page,
  labelText: string,
  checked: boolean
) => {
  const colorSection = page.locator(COLOR_SKC_SECTION_SELECTOR).first()
  const labelPattern = new RegExp(escapeRegExp(labelText), "i")
  const selectors = Array.from(new Set([
    ...COLOR_SKC_OPTION_SELECTORS,
    "label",
    ".theme-value-edit",
    ".theme-value-text"
  ]))

  for (const root of [colorSection, page] as const) {
    for (const selector of selectors) {
      const candidate = await firstVisible([
        root.locator(selector).filter({
          hasText: labelPattern
        })
      ])
      if (!candidate) {
        continue
      }

      const candidateText = cleanVisibleText(await candidate.innerText().catch(() => ""))
      const normalizedCandidate = normalizeText(candidateText)
      const normalizedTarget = normalizeText(labelText)
      if (
        normalizedCandidate !== normalizedTarget
        && !normalizedCandidate.endsWith(normalizedTarget)
        && !normalizedCandidate.includes(normalizedTarget)
      ) {
        continue
      }

      return setColorOptionChecked(page, candidate, checked)
    }
  }

  return {
    found: false,
    before: null,
    after: null,
    changed: false,
    clicked: false
  }
}

const trimColorSkcGroupsToLimit = async (
  page: Page,
  maxGroups = COLOR_SKC_MAX_GROUPS,
  refreshAttemptsRemaining = 1
) => {
  const before = await collectColorSkcGroupState(page, true)
  if (before.groupCount === 0) {
    return stepResult(
      "trim-color-skc-groups",
      "Trim color SKC groups",
      "skipped",
      "No color SKC table is visible on the current Dianxiaomi page"
    )
  }

  if (before.groupCount <= maxGroups) {
    return stepResult(
      "trim-color-skc-groups",
      "Trim color SKC groups",
      "skipped",
      `Color SKC groups already within limit (${before.groupCount}/${maxGroups})`,
      {
        limit: maxGroups,
        before
      }
    )
  }

  const colorSection = page.locator(COLOR_SKC_SECTION_SELECTOR).first()
  if (!await colorSection.isVisible().catch(() => false)) {
    return stepResult(
      "trim-color-skc-groups",
      "Trim color SKC groups",
      "failed",
      `Color SKC groups exceed the limit (${before.groupCount}/${maxGroups}) but the color selector is not visible`,
      {
        limit: maxGroups,
        before
      }
    )
  }

  const keepLabels = before.groups.slice(0, maxGroups).map((group) => group.label)
  const plannedRemoveLabels = before.groups.slice(maxGroups).map((group) => group.label)
  const removedLabels: string[] = []
  const missingLabels: string[] = []
  const failedLabels: string[] = []
  const labelActions: Array<Record<string, unknown>> = []
  let optionDebugSnapshot: Awaited<ReturnType<typeof collectColorOptionDebugSnapshot>> | null = null
  let remapAction: {
    attempted: boolean
    clicked: boolean
    reason: string
    text: string
  } | null = null

  await colorSection.scrollIntoViewIfNeeded().catch(() => undefined)
  await page.waitForTimeout(300)
  await revealColorOptionTargets(page, colorSection, plannedRemoveLabels)

  optionDebugSnapshot = await waitForColorOptionControlsSnapshot(page, colorSection, plannedRemoveLabels)
  if (!colorOptionSnapshotHasAnyControls(optionDebugSnapshot) && refreshAttemptsRemaining > 0) {
    const refreshed = await refreshCurrentDianxiaomiEditPage(page, "color option controls are missing")
    if (refreshed) {
      return trimColorSkcGroupsToLimit(page, maxGroups, refreshAttemptsRemaining - 1)
    }
  }

  for (const labelText of plannedRemoveLabels) {
    const currentState = await collectColorSkcGroupState(page)
    if (currentState.groupCount <= maxGroups) {
      break
    }

    const stillPresent = currentState.groups.some((group) => normalizeText(group.label) === normalizeText(labelText))
    if (!stillPresent) {
      continue
    }

    const labelAction: Record<string, unknown> = {
      labelText,
      beforeGroupCount: currentState.groupCount
    }
    const currentRowIndex = currentState.groups.findIndex((group) => normalizeText(group.label) === normalizeText(labelText))
    labelAction.currentRowIndex = currentRowIndex
    let optionLabel = await waitForVisibleColorOptionLabel(page, colorSection, labelText, currentRowIndex)
    if (!optionLabel) {
      await revealColorOptionTargets(page, colorSection, [labelText])
      optionDebugSnapshot = await waitForColorOptionControlsSnapshot(page, colorSection, plannedRemoveLabels, 8_000)
      optionLabel = await waitForVisibleColorOptionLabel(page, colorSection, labelText, currentRowIndex, 1_500)
      labelAction.optionRecoveredAfterReveal = Boolean(optionLabel)
    }

    let toggleMethod = optionLabel ? "visible-option" : "text-fallback"
    let toggle = optionLabel
      ? await setColorOptionChecked(page, optionLabel, false)
      : await setColorOptionCheckedByTextFallback(page, labelText, false)

    if ((!toggle.found || toggle.clicked === false) && optionLabel) {
      toggleMethod = "text-fallback-after-visible-option"
      toggle = await setColorOptionCheckedByTextFallback(page, labelText, false)
    }

    if (!toggle.found || toggle.clicked === false) {
      missingLabels.push(labelText)
      labelActions.push({
        ...labelAction,
        toggleMethod,
        toggle,
        status: "missing"
      })
      console.log(`color-skc trim ${labelText}: toggle target missing`)
      continue
    }

    const reduction = await waitForColorSkcReduction(page, currentState, labelText)
    labelActions.push({
      ...labelAction,
      toggleMethod,
      toggle,
      removedFromTable: reduction.removedFromTable,
      afterGroupCount: reduction.afterState.groupCount,
      status: reduction.reduced ? "removed" : "not-removed"
    })
    console.log(
      `color-skc trim ${labelText}: method=${toggleMethod} before=${currentState.groupCount} after=${reduction.afterState.groupCount} removed=${reduction.reduced}`
    )

    if (reduction.reduced) {
      removedLabels.push(labelText)
    } else {
      failedLabels.push(labelText)
    }
  }

  const after = await collectColorSkcGroupState(page, true)
  const succeeded = after.groupCount <= maxGroups
  return stepResult(
    "trim-color-skc-groups",
    "Trim color SKC groups",
    succeeded ? "done" : "failed",
    succeeded
      ? `Trimmed color SKC groups from ${before.groupCount} to ${after.groupCount}; removed ${removedLabels.length}`
      : `Color SKC groups still exceed the limit after trimming (${after.groupCount}/${maxGroups})`,
    {
      limit: maxGroups,
      before,
      after,
      keepLabels,
      plannedRemoveLabels,
      removedLabels,
      missingLabels,
      failedLabels,
      optionDebugSnapshot,
      remapAction,
      labelActions
    }
  )
}

const prepareDraftPageWriteSurface = async (
  page: Page,
  draft: ListingDraft,
  config: DianxiaomiSelectorConfig
) => {
  const correctionSteps: AutomationStepResult[] = []

  const dialogsBeforeSavePrep = await getPageSafetyState(page)
  if (dialogsBeforeSavePrep.visibleDialogCount > 0) {
    const dismissed = await closeMediaSurfaceStackToBaseline(page, 0, config)
    const dialogsAfterDismiss = await getPageSafetyState(page)
    correctionSteps.push(stepResult(
      "dismiss-residual-dialogs",
      "Dismiss residual dialogs",
      dismissed ? "done" : "failed",
      dismissed
        ? `Closed ${dialogsBeforeSavePrep.visibleDialogCount} blocking dialog(s) before page save`
        : `Blocking dialogs remained before page save (${dialogsAfterDismiss.visibleDialogCount})`,
      {
        before: dialogsBeforeSavePrep,
        after: dialogsAfterDismiss
      }
    ))
  } else {
    correctionSteps.push(stepResult(
      "dismiss-residual-dialogs",
      "Dismiss residual dialogs",
      "skipped",
      "No blocking dialog detected before page save"
    ))
  }

  // In the real Dianxiaomi repair flow the color table often renders before the
  // checkbox controls hydrate. Avoid refreshing here so a later save-failure
  // recovery can operate on the settled failure state instead of resetting it.
  correctionSteps.push(await normalizeCategorySelection(page, draft))
  correctionSteps.push(await trimColorSkcGroupsToLimit(page, COLOR_SKC_MAX_GROUPS, 0))
  correctionSteps.push(await normalizeVariantRemap(page, "prepare draft write surface"))
  correctionSteps.push(await normalizeCategorySelection(page, draft, {
    stepId: "normalize-category-selection-post-remap",
    stepLabel: "Normalize category selection after variant remap"
  }))
  correctionSteps.push(await normalizeSizeChart(page))
  correctionSteps.push(await normalizeVariantAttributes(page))
  correctionSteps.push(await normalizeSiteWarehouse(page))
  correctionSteps.push(await normalizeShipmentPromise(page))
  correctionSteps.push(await normalizeFreightTemplate(page))

  const englishTitle = draft.listingTitle.trim()
  if (englishTitle) {
    correctionSteps.push(await fillEnglishTitleField(page, englishTitle, config))
  } else {
    correctionSteps.push(stepResult(
      "fill-english-title",
      "Fill english title",
      "skipped",
      "Task draft has no listing title for the English title field"
    ))
  }

  correctionSteps.push(await normalizeOriginProvince(page))

  if (draft.skuPricing.length > 0) {
    const skuIdentifierSummary = await fillVisibleSkuIdentifierFields(page, draft.skuPricing)
    correctionSteps.push(stepResult(
      "fill-sku-identifiers",
      "Fill SKU identifiers",
      skuIdentifierSummary.visibleSkuCodeFields > 0 ? "done" : "skipped",
      skuIdentifierSummary.visibleSkuCodeFields > 0
        ? `Checked ${skuIdentifierSummary.visibleSkuCodeFields} visible SKU identifier field(s); filled ${skuIdentifierSummary.filledSkuCodes}`
        : "No visible SKU identifier field was detected before page save",
      skuIdentifierSummary
    ))
  } else {
    correctionSteps.push(stepResult(
      "fill-sku-identifiers",
      "Fill SKU identifiers",
      "skipped",
      "Task draft has no SKU pricing data for SKU identifier correction"
    ))
  }

  correctionSteps.push(await fillVisibleSkuLogisticsFields(page))

  const failedCount = correctionSteps.filter((step) => step.status === "failed").length
  const doneCount = correctionSteps.filter((step) => step.status === "done").length
  return stepResult(
    "prepare-draft-write-surface",
    "Prepare draft write surface",
    failedCount > 0 ? "failed" : doneCount > 0 ? "done" : "skipped",
    failedCount > 0
      ? `Prepared page save with ${doneCount} correction(s), ${failedCount} failed`
      : doneCount > 0
        ? `Prepared page save with ${doneCount} correction(s)`
        : "No page-save correction was needed before saving media changes",
    {
      corrections: correctionSteps
    }
  )
}

const prepareRepairMediaPageSave = async (
  page: Page,
  draft: ListingDraft,
  config: DianxiaomiSelectorConfig
) => {
  const prepared = await prepareDraftPageWriteSurface(page, draft, config)
  return stepResult(
    "repair-media-page-save-prep",
    "Prepare media repair page save",
    prepared.status,
    prepared.detail,
    prepared.data
  )
}

const skuIdentifierCode = (sku: ListingSkuPricing, index: number, usedCodes: Set<string>) => {
  const source = [
    sku.skuId,
    sku.skuName,
    sku.attributeSummary,
    ...Object.values(sku.attributes)
  ].join(" ")
  const ascii = source.replace(/[^a-z0-9]/gi, "").toUpperCase()
  const stem = ascii && !/^\d+$/.test(ascii) ? ascii.slice(0, 18) : "SKU"
  let code = `${stem}${String(index + 1).padStart(3, "0")}`.slice(0, 28)
  let suffix = 1
  while (usedCodes.has(code)) {
    const uniqueSuffix = String(suffix).padStart(2, "0")
    code = `${stem.slice(0, Math.max(1, 28 - uniqueSuffix.length))}${uniqueSuffix}`
    suffix += 1
  }
  usedCodes.add(code)
  return code
}

// P0-F: Temu rejects apparel listings whose SKUs under one SKC (color) carry
// different prices ("服装类目skc下价格需要保持一致"). Source data can carry an
// outlier price on one size (e.g. a scraped 999 on 黑色/S while every other size
// is 13.32). Group SKUs by their color attribute and coerce each group to a
// single price: the modal (most common) value, breaking ties toward the lowest
// so an outlier can never inflate the group. SKUs with no detectable color are
// left untouched (each is its own SKC).
const skuColorKey = (sku: ListingSkuPricing): string | null => {
  for (const [key, value] of Object.entries(sku.attributes)) {
    const normalizedKey = key.replace(/\s+/g, "").toLowerCase()
    if (ATTRIBUTE_ALIASES.color.some((alias) => normalizedKey.includes(alias.toLowerCase()))) {
      const text = value.trim()
      if (text) {
        return text
      }
    }
  }
  return null
}

export const normalizeSkcPricing = (skus: ListingSkuPricing[]): ListingSkuPricing[] => {
  const groups = new Map<string, number[]>()
  for (const sku of skus) {
    const color = skuColorKey(sku)
    if (!color) {
      continue
    }
    const prices = groups.get(color) ?? []
    prices.push(sku.salePriceUsd)
    groups.set(color, prices)
  }

  const groupPrice = new Map<string, number>()
  for (const [color, prices] of groups) {
    const counts = new Map<number, number>()
    for (const price of prices) {
      counts.set(price, (counts.get(price) ?? 0) + 1)
    }
    let bestPrice = prices[0]!
    let bestCount = -1
    for (const [price, count] of counts) {
      // Most common wins; ties break toward the lower price (never inflate).
      if (count > bestCount || (count === bestCount && price < bestPrice)) {
        bestPrice = price
        bestCount = count
      }
    }
    groupPrice.set(color, bestPrice)
  }

  return skus.map((sku) => {
    const color = skuColorKey(sku)
    if (!color) {
      return sku
    }
    const unified = groupPrice.get(color)
    if (unified === undefined || unified === sku.salePriceUsd) {
      return sku
    }
    return { ...sku, salePriceUsd: unified }
  })
}

// P0-F2: page-reference Dianxiaomi work items carry synthesized placeholder
// SKUs ("Dianxiaomi SKU"/"Dianxiaomi SKU N", attributes = internal task
// metadata only, salePriceUsd = the planner's DIANXIAOMI_DEFAULT_DECLARED_PRICE
// sentinel of 999). Writing that fabricated price onto a real listing lands on
// the first SKU row and breaks Temu's "服装类目skc下价格需要保持一致" rule —
// the page's own per-variation prices are authoritative for these items.
const isPlaceholderDianxiaomiSkuPricing = (sku: ListingSkuPricing): boolean =>
  sku.skuName.trim().startsWith("Dianxiaomi SKU")
  && Object.keys(sku.attributes).every((key) => isInternalDianxiaomiAttributeKey(key))

export const fillSkuPricing = async (page: Page, skus: ListingSkuPricing[], config?: DianxiaomiSelectorConfig) => {
  skus = normalizeSkcPricing(skus)
  const rows = await findSkuRows(page, config)
  const usedRows = new Set<number>()
  let filledPrices = 0
  let filledStocks = 0
  let skippedPlaceholderPrices = 0
  let fallbackPriceStatus: StepStatus | null = null
  let fallbackStockStatus: StepStatus | null = null
  // P0-E: track the first SKU price field we successfully wrote so we can
  // re-read its DOM value as hard evidence. Picked lazily on first fill so
  // we only verify the field we actually wrote.
  let firstPriceField: Locator | null = null
  let firstPriceExpected = ""

  for (const [skuIndex, sku] of skus.entries()) {
    let selectedIndex = -1
    let bestScore = -1

    rows.forEach((row, rowIndex) => {
      if (usedRows.has(rowIndex)) {
        return
      }

      const score = scoreSkuRow(row.text, sku)
      if (score > bestScore) {
        selectedIndex = rowIndex
        bestScore = score
      }
    })

    if (selectedIndex < 0 && rows[skuIndex]) {
      selectedIndex = skuIndex
    }

    const selectedRow = rows[selectedIndex]
    if (!selectedRow) {
      continue
    }

    usedRows.add(selectedIndex)
    const priceField = await getRowField(selectedRow.row, "price", 0)
    const stockField = await getRowField(selectedRow.row, "stock", 1)

    if (priceField) {
      if (isPlaceholderDianxiaomiSkuPricing(sku)) {
        skippedPlaceholderPrices += 1
      } else {
        await fillTextField(priceField, sku.salePriceUsd.toFixed(2))
        filledPrices += 1
        if (!firstPriceField) {
          firstPriceField = priceField
          firstPriceExpected = sku.salePriceUsd.toFixed(2)
        }
      }
    }

    if (stockField) {
      await fillTextField(stockField, String(sku.stock))
      filledStocks += 1
    }
  }

  if (filledPrices === 0 && skus[0] && !isPlaceholderDianxiaomiSkuPricing(skus[0])) {
    const fallback = await findField(page, "price", config)
    if (fallback) {
      await fillTextField(fallback, skus[0].salePriceUsd.toFixed(2))
      filledPrices += 1
      firstPriceField = fallback
      firstPriceExpected = skus[0].salePriceUsd.toFixed(2)
    } else {
      const fallbackResult = await fillSingleField(page, "price", skus[0].salePriceUsd.toFixed(2), config)
      fallbackPriceStatus = fallbackResult.status
      if (fallbackResult.status === "done") {
        filledPrices += 1
      }
    }
  }

  if (filledStocks === 0 && skus[0]) {
    const fallbackResult = await fillSingleField(page, "stock", String(skus[0].stock), config)
    fallbackStockStatus = fallbackResult.status
    if (fallbackResult.status === "done") {
      filledStocks += 1
    }
  }

  const skuIdentifierSummary = await fillVisibleSkuIdentifierFields(page, skus)

  // P0-E: re-read the first SKU price field after write. A non-match is
  // recorded in the step data but does not flip status to "failed" — the
  // existing step is still a partial success if some fields were filled.
  let firstPriceVerified = true
  let firstPriceActual = ""
  if (firstPriceField && firstPriceExpected) {
    firstPriceActual = await readFieldValue(firstPriceField).catch(() => "")
    firstPriceVerified = firstPriceActual === firstPriceExpected
  }

  const placeholderNote = skippedPlaceholderPrices > 0
    ? `（占位 SKU 跳过写价 ${skippedPlaceholderPrices} 项，保留页面现有申报价）`
    : ""
  console.log(`SKU 填写完成：价格 ${filledPrices} 项，库存 ${filledStocks} 项${placeholderNote}`)
  return stepResult(
    "fill-sku-pricing",
    "填写 SKU 价格和库存",
    filledPrices > 0 || filledStocks > 0
      ? "done"
      : skippedPlaceholderPrices > 0 ? "skipped" : "failed",
    `SKU 填写完成：价格 ${filledPrices} 项，库存 ${filledStocks} 项${placeholderNote}`,
    {
      skuCount: skus.length,
      detectedRows: rows.length,
      filledPrices,
      filledStocks,
      skippedPlaceholderPrices,
      ...skuIdentifierSummary,
      fallbackPriceStatus,
      fallbackStockStatus,
      firstPriceVerified,
      firstPriceExpected,
      firstPriceActual: firstPriceActual.slice(0, 40)
    }
  )
}

// P0-F2: Temu rejects apparel listings whose SKUs under one SKC (color) carry
// different declared prices ("服装类目skc下价格需要保持一致"). Historical fill
// runs stamped the planner's 999 placeholder onto the first SKU row of
// page-reference listings, so the SAVED page itself is inconsistent even after
// the placeholder write is stopped. This step reads the saved per-variation
// prices from edit.json, computes each color group's target price (mode, ties
// toward the lowest so an outlier can never inflate the group), and rewrites
// outlier rows on the page so the next save persists a consistent price set.
export type SkcVariationPricing = {
  color: string | null
  size: string | null
  supplierPriceCents: number | null
}

export const computeSkcPriceRepairs = (variations: SkcVariationPricing[]) => {
  const groups = new Map<string, number[]>()
  for (const variation of variations) {
    if (!variation.color || variation.supplierPriceCents === null) {
      continue
    }
    const prices = groups.get(variation.color) ?? []
    prices.push(variation.supplierPriceCents)
    groups.set(variation.color, prices)
  }

  const targets = new Map<string, number>()
  for (const [color, prices] of groups) {
    const counts = new Map<number, number>()
    for (const price of prices) {
      counts.set(price, (counts.get(price) ?? 0) + 1)
    }
    let bestPrice = prices[0]!
    let bestCount = -1
    for (const [price, count] of counts) {
      if (count > bestCount || (count === bestCount && price < bestPrice)) {
        bestPrice = price
        bestCount = count
      }
    }
    targets.set(color, bestPrice)
  }

  return variations
    .filter((variation) =>
      variation.color
      && variation.supplierPriceCents !== null
      && targets.get(variation.color) !== variation.supplierPriceCents
    )
    .map((variation) => ({
      color: variation.color!,
      size: variation.size,
      fromCents: variation.supplierPriceCents!,
      toCents: targets.get(variation.color!)!
    }))
}

const fetchDianxiaomiVariationPricingFromEditJson = async (page: Page): Promise<SkcVariationPricing[]> => {
  const productId = (() => {
    try {
      return toNonEmptyText(new URL(page.url()).searchParams.get("id"))
    } catch {
      return null
    }
  })()
  if (!productId) {
    return []
  }

  try {
    const response = await page.context().request.get(
      `https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${productId}`
    )
    if (!response.ok()) {
      return []
    }
    const payload = await response.json().catch(() => null) as {
      data?: { product?: { variations?: Array<Record<string, unknown>> } }
    } | null
    const variations = payload?.data?.product?.variations
    if (!Array.isArray(variations)) {
      return []
    }

    return variations.map((variation) => {
      const attrMap = variation?.attrMap && typeof variation.attrMap === "object"
        ? variation.attrMap as Record<string, unknown>
        : {}
      let color: string | null = null
      let size: string | null = null
      for (const [key, value] of Object.entries(attrMap)) {
        const text = typeof value === "string" ? value.trim() : ""
        if (!text) {
          continue
        }
        const normalizedKey = key.replace(/\s+/g, "").toLowerCase()
        if (!color && ATTRIBUTE_ALIASES.color.some((alias) => normalizedKey.includes(alias.toLowerCase()))) {
          color = text
        } else if (!size && ATTRIBUTE_ALIASES.size.some((alias) => normalizedKey.includes(alias.toLowerCase()))) {
          size = text
        }
      }
      const rawPrice = Number(variation?.supplierPrice)
      return {
        color,
        size,
        supplierPriceCents: Number.isFinite(rawPrice) && rawPrice > 0 ? Math.round(rawPrice) : null
      }
    })
  } catch {
    return []
  }
}

export const normalizeSkcPagePricing = async (page: Page, config?: DianxiaomiSelectorConfig) => {
  const variations = await fetchDianxiaomiVariationPricingFromEditJson(page)
  if (variations.length === 0) {
    return stepResult(
      "normalize-skc-pricing",
      "Normalize SKC pricing",
      "skipped",
      "No variation pricing is available from edit.json on this page; existing prices left untouched"
    )
  }

  const repairs = computeSkcPriceRepairs(variations)
  if (repairs.length === 0) {
    return stepResult(
      "normalize-skc-pricing",
      "Normalize SKC pricing",
      "skipped",
      `SKC prices are already consistent across ${variations.length} variation(s)`,
      { variationCount: variations.length }
    )
  }

  const rows = await findSkuRows(page, config)
  const usedRowIndexes = new Set<number>()
  const repairResults: Array<Record<string, unknown>> = []
  let repaired = 0

  for (const repair of repairs) {
    const targetValue = (repair.toCents / 100).toFixed(2)
    const sizePattern = repair.size
      ? new RegExp(`(^|[\\s/-])${escapeRegExp(repair.size)}($|[\\s/-])`, "i")
      : null
    let outcome: Record<string, unknown> = { ...repair, fixed: false, reason: "no matching SKU row with the outlier price" }

    for (const [index, row] of rows.entries()) {
      if (usedRowIndexes.has(index)) {
        continue
      }
      if (!row.text.includes(repair.color)) {
        continue
      }
      if (sizePattern && !sizePattern.test(row.text)) {
        continue
      }
      const priceField = await getRowField(row.row, "price", 0)
      if (!priceField) {
        continue
      }
      const currentValue = (await readFieldValue(priceField).catch(() => "")).trim()
      const currentCents = Math.round(Number.parseFloat(currentValue) * 100)
      if (!Number.isFinite(currentCents) || currentCents !== repair.fromCents) {
        continue
      }
      await fillTextField(priceField, targetValue)
      const verifiedValue = (await readFieldValue(priceField).catch(() => "")).trim()
      const verified = verifiedValue === targetValue
      usedRowIndexes.add(index)
      if (verified) {
        repaired += 1
      }
      outcome = { ...repair, fixed: verified, previousValue: currentValue, writtenValue: verifiedValue }
      break
    }

    repairResults.push(outcome)
  }

  const allRepaired = repaired === repairs.length
  console.log(`normalize-skc-pricing: repaired ${repaired}/${repairs.length} SKC price outlier(s)`)
  return stepResult(
    "normalize-skc-pricing",
    "Normalize SKC pricing",
    allRepaired ? "done" : "failed",
    allRepaired
      ? `Rewrote ${repaired} SKC price outlier(s) so every color group carries one declared price`
      : `Only ${repaired}/${repairs.length} SKC price outlier(s) could be repaired on the page`,
    { variationCount: variations.length, repairs: repairResults }
  )
}

export const fillAttributes = async (page: Page, draft: ListingDraft, config?: DianxiaomiSelectorConfig) => {
  let successCount = 0
  const missedKeys: string[] = []
  const writableEntries = Object.entries(draft.attributes).filter(([key]) => !isInternalDianxiaomiAttributeKey(key))

  for (const [key, value] of writableEntries) {
    const keywords = ATTRIBUTE_ALIASES[key] ?? [key]
    const field = await findByConfiguredSelectors(page, config?.fields?.attribute) ?? await findFieldByKeyword(page, keywords)

    if (!field) {
      console.warn(`未找到属性字段：${key}`)
      missedKeys.push(key)
      continue
    }

    await fillTextField(field, value)
    successCount += 1
  }

  console.log(`属性填写完成：${successCount}/${writableEntries.length}`)
  return stepResult(
    "fill-attributes",
    "填写属性",
    successCount > 0 || writableEntries.length === 0 ? "done" : "failed",
    `属性填写完成：${successCount}/${writableEntries.length}`,
    {
      successCount,
      totalCount: writableEntries.length,
      missedKeys
    }
  )
}

const visibleFlag = async (locator: Locator | null) =>
  locator && await locator.isVisible().catch(() => false) ? 1 : 0

const presentFlag = async (locator: Locator | null) =>
  locator && await locator.count().catch(() => 0) > 0 ? 1 : 0

const getCurrentHost = (pageUrl: string) => {
  try {
    return new URL(pageUrl).hostname.toLowerCase()
  } catch {
    return ""
  }
}

const isDianxiaomiHost = (host: string) => /(^|\.)dianxiaomi\.(com|cn)$/i.test(host)

export const inspectDianxiaomiTargetSurface = async (
  page: Page,
  config: DianxiaomiSelectorConfig = {}
) => {
  await hardenPageForEsbuildEvaluate(page)
  const pageUrl = page.url()
  const pageTitle = await page.title().catch(() => "")
  const host = getCurrentHost(pageUrl)
  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""))
  const manualLoginSurface = await inspectManualLoginSurface(page).catch(() => ({
    shouldWaitForManualLogin: false,
    reason: "manual login surface inspection unavailable",
    currentUrl: pageUrl
  }))
  const titleField = await findField(page, "title", config)
  const descriptionField = await findField(page, "description", config)
  const rows = await findSkuRows(page, config)
  const priceField = rows.length > 0 ? null : await findField(page, "price", config)
  const stockField = rows.length > 0 ? null : await findField(page, "stock", config)
  const saveButton = await findInteractiveByKeywords(page, SAVE_BUTTON_KEYWORDS, config.buttons?.save)
  const submitButton = await findInteractiveByKeywords(page, SUBMIT_BUTTON_KEYWORDS, config.buttons?.submit)
  const mediaToolCount = (await collectMediaToolCandidates(page, config)).filter((tool) => tool.locator).length
  const fieldReadiness: TargetSurfaceInspection["fieldReadiness"] = {
    title: await presentFlag(titleField),
    description: await presentFlag(descriptionField),
    skuRows: rows.length,
    price: await presentFlag(priceField),
    stock: await presentFlag(stockField),
    saveButton: await presentFlag(saveButton),
    submitButton: await presentFlag(submitButton),
    mediaTools: mediaToolCount,
    editableFields: await countVisible(page.locator(EDITABLE_SELECTOR), 200)
  }
  const hostMatchesDianxiaomi = isDianxiaomiHost(host)
  const dataFixture = pageUrl.startsWith("data:") && pageTitle.includes("Dianxiaomi Dry Run Fixture")
  const hasTitleOrDescription = fieldReadiness.title > 0 || fieldReadiness.description > 0
  const hasPricingSurface = fieldReadiness.skuRows > 0 || (fieldReadiness.price > 0 && fieldReadiness.stock > 0)
  const hasActionOrMediaSignal = fieldReadiness.saveButton > 0 || fieldReadiness.submitButton > 0 || fieldReadiness.mediaTools > 0
  const hasEnoughEditableFields = fieldReadiness.editableFields >= 3
  const hasEditableListingShell = hasTitleOrDescription && hasActionOrMediaSignal && hasEnoughEditableFields
  const formReady = hasEditableListingShell && (hasPricingSurface || hostMatchesDianxiaomi)
  const rawLoginKeywordDetected = LOGIN_OR_CAPTCHA_KEYWORDS.some((keyword) =>
    bodyText.includes(keyword.toLowerCase()) || pageTitle.toLowerCase().includes(keyword.toLowerCase())
  )
  const loginOrCaptchaDetected = manualLoginSurface.shouldWaitForManualLogin && !formReady
  const canInspect = !loginOrCaptchaDetected && formReady && (hostMatchesDianxiaomi || dataFixture)
  const canWrite = canInspect
  const reasons = [
    hostMatchesDianxiaomi ? "host is Dianxiaomi" : `host is not Dianxiaomi: ${host || "none"}`,
    dataFixture ? "local dry-run fixture detected" : "not the local dry-run fixture",
    formReady ? "listing edit surface signals are present" : "listing edit surface signals are incomplete",
    loginOrCaptchaDetected
      ? `login or captcha surface detected: ${manualLoginSurface.reason}`
      : rawLoginKeywordDetected
        ? `login text ignored because edit surface is present: ${manualLoginSurface.reason}`
        : "no login/captcha surface detected"
  ]
  const surfaceStatus: TargetSurfaceStatus = loginOrCaptchaDetected
    ? "login-or-captcha"
    : dataFixture && formReady
      ? "fixture"
      : hostMatchesDianxiaomi && formReady
        ? "real-dianxiaomi"
        : hostMatchesDianxiaomi || pageUrl.startsWith("data:")
          ? "missing-fields"
          : "unknown"
  const inspection: TargetSurfaceInspection = {
    pageUrl,
    pageTitle,
    host,
    isDianxiaomiHost: hostMatchesDianxiaomi,
    isDataFixture: dataFixture,
    loginOrCaptchaDetected,
    surfaceStatus,
    canWrite,
    canInspect,
    reasons,
    fieldReadiness
  }

  return stepResult(
    "target-surface",
    "Target surface",
    canInspect ? "done" : "failed",
    canInspect
      ? `Current page is recognized as ${surfaceStatus}; automation may inspect and write.`
      : `Current page is not a safe Dianxiaomi listing edit surface: ${surfaceStatus}.`,
    inspection as unknown as Record<string, unknown>
  )
}

export const targetSurfaceCanWrite = (step: AutomationStepResult) =>
  step.id === "target-surface" && (step.data as TargetSurfaceInspection | undefined)?.canWrite === true

export const targetSurfaceCanInspect = (step: AutomationStepResult) =>
  step.id === "target-surface" && (step.data as TargetSurfaceInspection | undefined)?.canInspect === true

export const hasPublishSurface = async (page: Page, config = loadSelectorConfig(".runtime/dianxiaomi-selector-config.json")) => {
  const targetSurface = await inspectDianxiaomiTargetSurface(page, config)
  return targetSurfaceCanInspect(targetSurface)
}

export const waitForPublishPage = async (
  page: Page,
  config: DianxiaomiSelectorConfig = loadSelectorConfig(".runtime/dianxiaomi-selector-config.json"),
  options: { waitForManualNavigation?: boolean; targetUrl?: string; allowSameTargetRefresh?: boolean } = {}
) => {
  const timeoutMs = options.waitForManualNavigation === false ? 60_000 : 10 * 60 * 1000
  const deadline = Date.now() + timeoutMs
  let prompted = false
  let autoNavigationAttempts = 0
  let autoRefreshMatchingTargetAttempts = 0

  await hardenPageForEsbuildEvaluate(page)

  while (Date.now() < deadline) {
    if (await hasPublishSurface(page, config)) {
      return
    }

    const targetUrl = options.targetUrl?.trim()
    const currentUrl = page.url()
    const currentHost = getCurrentHost(currentUrl)
    const canAutoReturnToTarget = isRealDianxiaomiEditTargetUrl(targetUrl)
      && (isDianxiaomiHost(currentHost) || currentUrl === "about:blank")
      && !isSameDianxiaomiEditPage(currentUrl, targetUrl)
      && autoNavigationAttempts < 3
    const canRefreshMatchingTarget = isRealDianxiaomiEditTargetUrl(targetUrl)
      && options.allowSameTargetRefresh !== false
      && isSameDianxiaomiEditPage(currentUrl, targetUrl)
      && isDianxiaomiHost(currentHost)
      && autoRefreshMatchingTargetAttempts < 3

    if (canAutoReturnToTarget) {
      autoNavigationAttempts += 1
      console.log(`当前不是目标商品编辑页，正在自动跳转回目标页面：${targetUrl}`)
      await page.goto(targetUrl!, {
        waitUntil: "domcontentloaded"
      }).catch((error) => {
        console.warn(`自动跳转目标商品页失败（第 ${autoNavigationAttempts} 次）：${error instanceof Error ? error.message : String(error)}`)
      })
      await page.waitForTimeout(1000)
      continue
    }

    if (canRefreshMatchingTarget) {
      autoRefreshMatchingTargetAttempts += 1
      console.log(`Target edit URL is loaded but the listing form is still missing; refreshing ${autoRefreshMatchingTargetAttempts}/3: ${targetUrl}`)
      await page.goto(targetUrl!, {
        waitUntil: "domcontentloaded"
      }).catch((error) => {
        console.warn(`Refresh of target edit page failed on attempt ${autoRefreshMatchingTargetAttempts}: ${error instanceof Error ? error.message : String(error)}`)
      })
      await page.waitForTimeout(1500)
      continue
    }

    if (options.waitForManualNavigation !== false && !prompted) {
      console.log("当前还不是店小秘产品编辑/刊登表单。请在打开的浏览器中进入对应商品的编辑或刊登页，脚本会自动继续。")
      prompted = true
    }

    await page.waitForTimeout(1000)
  }

  console.warn(`店小秘编辑表单等待超时：${Math.round(timeoutMs / 1000)}s`)
}

export const clickByKeywords = async (page: Page, keywords: string[], selectors?: string[]) => {
  const configured = await findByConfiguredSelectors(page, selectors)
  if (configured) {
    await configured.click()
    return true
  }

  for (const keyword of keywords) {
    const button = page.getByRole("button", {
      name: new RegExp(escapeRegExp(keyword), "i")
    })

    if (await button.first().isVisible().catch(() => false)) {
      await button.first().click()
      return true
    }
  }

  return false
}

const readInteractiveText = async (locator: Locator) =>
  cleanVisibleText(
    await locator.innerText().catch(async () => await locator.getAttribute("value").catch(() => ""))
  )

const isLocatorInsideVisibleDialog = async (locator: Locator) =>
  locator.evaluate((element, selector) => {
    const container = element.closest(selector)
    if (!(container instanceof HTMLElement)) {
      return false
    }

    const style = window.getComputedStyle(container)
    const rect = container.getBoundingClientRect()
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
  }, BLOCKING_DIALOG_SELECTOR).catch(() => false)

const findPreferredButtonByKeywords = async (
  page: Page,
  keywords: string[],
  options: {
    exactTexts?: string[]
    excludeKeywords?: string[]
    excludeInsideDialogs?: boolean
    selectors?: string[]
  } = {}
) => {
  const exactTexts = options.exactTexts ?? keywords
  const excludeKeywords = options.excludeKeywords ?? []
  const isExcluded = (text: string) => excludeKeywords.some((keyword) => text.includes(keyword))
  const matchesExact = (text: string) => exactTexts.some((keyword) => text === keyword)
  const matchesKeyword = (text: string) => keywords.some((keyword) => text.includes(keyword))

  const configured = await findByConfiguredSelectors(page, options.selectors)
  if (configured) {
    const configuredText = await readInteractiveText(configured)
    if (
      configuredText
      && !isExcluded(configuredText)
      && (!options.excludeInsideDialogs || !await isLocatorInsideVisibleDialog(configured))
      && (matchesExact(configuredText) || matchesKeyword(configuredText))
    ) {
      return configured
    }
  }

  for (const keyword of exactTexts) {
    const exactButton = page.getByRole("button", {
      name: new RegExp(`^\\s*${escapeRegExp(keyword)}\\s*$`, "i")
    })
    const candidate = exactButton.first()
    if (
      await candidate.isVisible().catch(() => false)
      && (!options.excludeInsideDialogs || !await isLocatorInsideVisibleDialog(candidate))
    ) {
      return candidate
    }
  }

  const actions = page.locator("button, [role='button'], input[type='button'], input[type='submit']")
  const count = Math.min(await actions.count().catch(() => 0), 60)
  let bestPartial: {
    locator: Locator
    score: number
  } | null = null

  for (let index = 0; index < count; index += 1) {
    const action = actions.nth(index)
    if (!await action.isVisible().catch(() => false)) {
      continue
    }

    if (options.excludeInsideDialogs && await isLocatorInsideVisibleDialog(action)) {
      continue
    }

    const text = await readInteractiveText(action)
    if (!text || isExcluded(text) || !matchesKeyword(text)) {
      continue
    }

    if (matchesExact(text)) {
      return action
    }

    const score = text.length + (text.includes("并") ? 120 : 0)
    if (!bestPartial || score < bestPartial.score) {
      bestPartial = {
        locator: action,
        score
      }
    }
  }

  return bestPartial?.locator ?? null
}

const findSaveDraftButton = async (page: Page, selectors?: string[]) =>
  findPreferredButtonByKeywords(
    page,
    ["保存草稿", "保存", "暂存", "save draft", "save"],
    {
      exactTexts: ["保存草稿", "保存", "暂存", "save draft", "save"],
      excludeKeywords: ["待发布", "移入", "发布"],
      excludeInsideDialogs: true,
      selectors
    }
  )

const findButtonByKeywords = async (page: Page, keywords: string[], selectors?: string[]) => {
  const configured = await findByConfiguredSelectors(page, selectors)
  if (configured) {
    return configured
  }

  for (const keyword of keywords) {
    const button = page.getByRole("button", {
      name: new RegExp(escapeRegExp(keyword), "i")
    })

    if (await button.first().isVisible().catch(() => false)) {
      return button.first()
    }
  }

  return null
}

const isLikelyCompactInteractive = async (locator: Locator) => locator.evaluate((element) => {
  const tagName = element.tagName.toLowerCase()
  const role = element.getAttribute("role") ?? ""
  const className = typeof element.className === "string" ? element.className : ""
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim()
  const tabIndex = element.getAttribute("tabindex")
  const hasUsableTabIndex = tabIndex !== null && tabIndex !== "-1"
  const hasInteractiveRole = ["button", "link", "menuitem"].includes(role)
  const isIntrinsicControl = ["button", "a", "input"].includes(tagName)

  if (isIntrinsicControl || hasInteractiveRole) {
    return text.length <= 160
  }

  const looksClickable = element.hasAttribute("onclick")
    || hasUsableTabIndex
    || getComputedStyle(element).cursor === "pointer"
    || /\b(btn|button|tool|action|operate|menu|media|image|upload|translate|resize|editor|manage)\b/i.test(className)

  return looksClickable && text.length > 0 && text.length <= 100
}).catch(() => false)

const firstCompactInteractiveVisible = async (locators: Locator[]) => {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0)

    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index)
      if (await item.isVisible().catch(() => false) && await isLikelyCompactInteractive(item)) {
        return item
      }
    }
  }

  return null
}

const findInteractiveByKeywords = async (page: Page, keywords: string[], selectors?: string[]) => {
  const configured = await findByConfiguredSelectors(page, selectors)
  if (configured) {
    return configured
  }

  for (const keyword of keywords) {
    const pattern = new RegExp(escapeRegExp(keyword), "i")
    const valueSelector = [
      `input[type='button'][value*="${keyword}" i]`,
      `input[type='submit'][value*="${keyword}" i]`,
      `[aria-label*="${keyword}" i]`,
      `[title*="${keyword}" i]`
    ].join(", ")
    const match = await firstCompactInteractiveVisible([
      page.getByRole("button", { name: pattern }),
      page.getByRole("link", { name: pattern }),
      page.getByRole("menuitem", { name: pattern }),
      page.locator("button, a, [role='button'], [role='menuitem'], input[type='button']").filter({ hasText: pattern }),
      page.locator(valueSelector),
      page.locator("[onclick], [tabindex]:not([tabindex='-1']), [class*='btn' i], [class*='button' i], [class*='link' i], [class*='tool' i], [class*='action' i], [class*='operate' i], [class*='menu' i]").filter({ hasText: pattern })
    ])

    if (match) {
      return match
    }
  }

  return null
}

const waitForDianxiaomiLoadingOverlayToClear = async (page: Page, timeoutMs = 20_000) =>
  page.waitForFunction(() => {
    const isVisible = (element: Element) => {
      if (!(element instanceof HTMLElement)) {
        return false
      }
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
    }

    return Array.from(document.querySelectorAll("#dPageLoading, .d-page-loading")).every((element) => !isVisible(element))
  }, undefined, {
    timeout: timeoutMs
  }).then(() => true).catch(() => false)

const clickAfterDianxiaomiIdle = async (page: Page, locator: Locator, attempts = 3) => {
  let lastError: unknown = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await waitForDianxiaomiLoadingOverlayToClear(page)
    try {
      await locator.scrollIntoViewIfNeeded({
        timeout: 5_000
      })
      await locator.click({
        timeout: 5_000
      })
      return true
    } catch (error) {
      lastError = error
      await page.waitForTimeout(750)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Dianxiaomi click failed"))
}

const dismissStartupModalIfPresent = async (page: Page) => {
  const dialogs = await visibleAntModalLocators(page)
  const dialog = dialogs[dialogs.length - 1] ?? null
  if (!dialog) {
    return stepResult("dismiss-startup-modal", "Dismiss startup modal", "skipped", "No blocking startup modal detected")
  }

  const closeButton = await firstVisible([
    dialog.locator(".ant-modal-close"),
    dialog.locator("[aria-label*='close' i]"),
    dialog.locator("[title*='close' i]")
  ]) ?? await findInteractiveInRootByKeywords(dialog, [
    "\u5173\u95ed",
    "\u53d6\u6d88",
    "\u6211\u77e5\u9053\u4e86",
    "\u77e5\u9053\u4e86",
    "\u7ee7\u7eed\u7f16\u8f91",
    "\u786e\u5b9a",
    "\u786e\u8ba4",
    "close",
    "cancel",
    "continue",
    "ok"
  ])

  if (!closeButton) {
    return stepResult("dismiss-startup-modal", "Dismiss startup modal", "skipped", "A startup modal is visible but no safe close control was detected")
  }

  const beforeCount = dialogs.length
  await clickAfterDianxiaomiIdle(page, closeButton, 1)
  const dismissed = await waitForVisibleAntModalCountAtMost(page, Math.max(0, beforeCount - 1), 5_000)
  return stepResult(
    "dismiss-startup-modal",
    "Dismiss startup modal",
    dismissed ? "done" : "failed",
    dismissed ? "Closed the blocking startup modal" : "Tried to close the startup modal but it remained visible"
  )
}

const findVisibleMenuItemByKeywords = async (page: Page, keywords: string[]) => {
  for (const keyword of keywords) {
    const pattern = new RegExp(escapeRegExp(keyword), "i")
    const attributeSelector = [
      `[title*="${keyword}" i]`,
      `[aria-label*="${keyword}" i]`
    ].join(", ")
    const match = await firstCompactInteractiveVisible([
      page.locator(".ant-dropdown:visible [role='menuitem'], .ant-dropdown-menu:visible [role='menuitem']").filter({ hasText: pattern }),
      page.locator(".ant-dropdown:visible .ant-dropdown-menu-item, .ant-dropdown-menu:visible .ant-dropdown-menu-item").filter({ hasText: pattern }),
      page.getByRole("menuitem", { name: pattern }),
      page.locator([
        "body > div:visible button",
        "body > div:visible a",
        "body > div:visible [role='button']",
        "body > div:visible [role='menuitem']",
        "body > div:visible li",
        "body > div:visible span",
        "body > div:visible div"
      ].join(", ")).filter({ hasText: pattern }),
      page.locator(attributeSelector),
      page.locator("button, a, [role='button'], [role='menuitem']").filter({ hasText: pattern })
    ])

    if (match) {
      return match
    }
  }

  return null
}

const clickVisibleMenuItemByKeywords = async (page: Page, keywords: string[], attempts = 2) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const match = await findVisibleMenuItemByKeywords(page, keywords)
    if (!match) {
      return false
    }

    try {
      await clickAfterDianxiaomiIdle(page, match, 1)
      await page.waitForTimeout(300)
      return true
    } catch {
      const forced = await forceDomClick(match)
      if (forced) {
        await page.waitForTimeout(300)
        return true
      }
      await page.waitForTimeout(250)
    }
  }

  return false
}

const buildSkuImageRowText = (cellText: string, previousText: string) => {
  const normalizedCellText = cleanVisibleText(cellText)
    .replace(/选择图片/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (normalizedCellText) {
    return normalizedCellText
  }

  return cleanVisibleText(previousText)
}

const probeProductImages = async (page: Page, imageUrls: string[]): Promise<ProbedProductImage[]> => {
  const uniqueUrls = Array.from(new Set(imageUrls.map((item) => item.trim()).filter(Boolean)))
  if (uniqueUrls.length === 0) {
    return []
  }

  const probed = await page.evaluate(async (payload) => {
    const urls = payload.urls
    const timeoutMs = payload.timeoutMs
    return Promise.all(urls.map((url) =>
      new Promise<ProbedProductImage>((resolve) => {
        const img = new Image()
        let settled = false
        const cleanupAndResolve = (loadState: "loaded" | "error" | "timeout") => {
          if (settled) {
            return
          }
          settled = true
          window.clearTimeout(timer)
          img.onload = null
          img.onerror = null
          if (loadState === "loaded") {
            resolve({
              url,
              width: img.naturalWidth || 0,
              height: img.naturalHeight || 0,
              loaded: true,
              aspectRatio: img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null,
              loadState
            })
            return
          }
          resolve({
            url,
            width: 0,
            height: 0,
            loaded: false,
            aspectRatio: null,
            loadState
          })
        }
        const timer = window.setTimeout(() => {
          cleanupAndResolve("timeout")
        }, timeoutMs)
        img.referrerPolicy = "no-referrer"
        img.onload = () => {
          cleanupAndResolve("loaded")
        }
        img.onerror = () => {
          cleanupAndResolve("error")
        }
        img.src = url
      })
    ))
  }, {
    urls: uniqueUrls,
    timeoutMs: PRODUCT_IMAGE_PROBE_TIMEOUT_MS
  })

  return probed
}

const skuImageDistanceFromTarget = (image: ProbedProductImage) =>
  image.aspectRatio === null
    ? Number.POSITIVE_INFINITY
    : Math.abs(image.aspectRatio - SKU_IMAGE_TARGET_RATIO)

const unwrapWeservSkuSourceUrl = (value: string) => {
  let current = value.trim()

  for (let depth = 0; depth < 3; depth += 1) {
    let parsed: URL
    try {
      parsed = new URL(current)
    } catch {
      return current
    }

    if (parsed.hostname.toLowerCase() !== "images.weserv.nl") {
      return current
    }

    const source = parsed.searchParams.get("url")?.trim()
    if (!source) {
      return current
    }

    current = /^https?:\/\//i.test(source)
      ? source
      : `https://${source.replace(/^\/+/, "")}`
  }

  return current
}

const canonicalizeSkuImageBaseUrl = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsed = new URL(unwrapWeservSkuSourceUrl(trimmed))
    if (!/^https?:$/i.test(parsed.protocol)) {
      return null
    }

    parsed.searchParams.delete("sku3x4")
    parsed.hash = ""
    return parsed.toString()
  } catch {
    return null
  }
}

const buildStrictSkuNetworkUrls = (image: Pick<ProbedProductImage, "url">) => {
  const baseUrl = canonicalizeSkuImageBaseUrl(image.url)
  if (!baseUrl) {
    return []
  }

  const sku3x4Variants = ["1", "2", "3"].map((variant) => {
    const parsed = new URL(baseUrl)
    parsed.searchParams.set("sku3x4", variant)
    return parsed.toString()
  })

  const weservContainVariants = ["FFFFFF", "ffffff"].map((background) => {
    const parsed = new URL("https://images.weserv.nl/")
    parsed.searchParams.set("url", baseUrl.replace(/^https?:\/\//i, ""))
    parsed.searchParams.set("w", String(SKU_IMAGE_MIN_WIDTH_PX))
    parsed.searchParams.set("h", String(SKU_IMAGE_MIN_HEIGHT_PX))
    parsed.searchParams.set("fit", "contain")
    parsed.searchParams.set("bg", background)
    parsed.searchParams.set("output", "jpg")
    return parsed.toString()
  })

  return Array.from(new Set([
    ...sku3x4Variants,
    ...weservContainVariants
  ]))
}

const isStrictSkuImageCandidate = (image: ProbedProductImage) =>
  image.loaded
  && image.aspectRatio !== null
  && image.aspectRatio >= SKU_IMAGE_STRICT_RATIO_MIN
  && image.aspectRatio <= SKU_IMAGE_STRICT_RATIO_MAX
  && image.width >= SKU_IMAGE_MIN_WIDTH_PX
  && image.height >= SKU_IMAGE_MIN_HEIGHT_PX

const fillSkuImageUrlCount = (urls: string[], minimumCount: number) => {
  const normalized = urls.map((item) => item.trim()).filter(Boolean)
  if (normalized.length === 0) {
    return []
  }

  const filled = normalized.slice(0, minimumCount)
  let duplicateIndex = 0

  while (filled.length < minimumCount) {
    filled.push(normalized[duplicateIndex % normalized.length] ?? normalized[normalized.length - 1]!)
    duplicateIndex += 1
  }

  return filled
}

const selectSkuImageCandidates = (images: ProbedProductImage[]) => {
  const strict = images
    .filter(isStrictSkuImageCandidate)
    .sort((left, right) =>
      skuImageDistanceFromTarget(left) - skuImageDistanceFromTarget(right)
      || right.height - left.height
      || right.width - left.width
    )

  const preferred = images
    .filter((image) =>
      image.loaded
      && image.aspectRatio !== null
      && image.aspectRatio >= SKU_IMAGE_RATIO_MIN
      && image.aspectRatio <= SKU_IMAGE_RATIO_MAX
      && image.width >= SKU_IMAGE_MIN_WIDTH_PX
      && image.height >= SKU_IMAGE_MIN_HEIGHT_PX
    )
    .sort((left, right) =>
      skuImageDistanceFromTarget(left) - skuImageDistanceFromTarget(right)
      || right.height - left.height
      || right.width - left.width
    )

  const fallback = preferred.length >= SKU_IMAGE_MIN_COUNT
    ? preferred
    : images
      .filter((image) =>
        image.loaded
        && image.aspectRatio !== null
        && image.aspectRatio >= SKU_IMAGE_FALLBACK_RATIO_MIN
        && image.aspectRatio <= SKU_IMAGE_FALLBACK_RATIO_MAX
        && image.width >= SKU_IMAGE_FALLBACK_MIN_WIDTH_PX
        && image.height >= SKU_IMAGE_FALLBACK_MIN_HEIGHT_PX
      )
      .sort((left, right) =>
        skuImageDistanceFromTarget(left) - skuImageDistanceFromTarget(right)
        || right.height - left.height
        || right.width - left.width
      )

  return {
    strict,
    preferred,
    selected: (
      strict.length > 0
        ? strict
        : preferred.length >= SKU_IMAGE_MIN_COUNT
          ? preferred
          : fallback
    ).slice(0, Math.max(SKU_IMAGE_MIN_COUNT, 10))
  }
}

const selectSquareImageCandidates = (images: ProbedProductImage[]) =>
  images
    .filter((image) =>
      image.loaded
      && image.aspectRatio !== null
      && image.aspectRatio >= SECTION_SQUARE_RATIO_MIN
      && image.aspectRatio <= SECTION_SQUARE_RATIO_MAX
    )
    .sort((left, right) => right.width * right.height - left.width * left.height)

const isSquareAspectRatio = (aspectRatio: number | null) =>
  aspectRatio !== null
  && aspectRatio >= SECTION_SQUARE_RATIO_MIN
  && aspectRatio <= SECTION_SQUARE_RATIO_MAX

const collectMaterialImageCandidateUrls = async (page: Page): Promise<string[]> =>
  page.locator(".material-img-module img").evaluateAll((nodes) =>
    Array.from(new Set(
      nodes
        .map((node) => {
          const image = node as HTMLImageElement
          return image.currentSrc || image.src || ""
        })
        .map((value) => value.trim())
        .filter((value) => /^https?:\/\//i.test(value))
    ))
  ).catch(() => [] as string[])

const buildSquarePreviewReplacementUrls = async (page: Page, imageUrls: string[]) => {
  const materialImageUrls = await collectMaterialImageCandidateUrls(page)
  const candidateUrls = Array.from(new Set([
    ...materialImageUrls,
    ...imageUrls.map((item) => item.trim()).filter(Boolean)
  ]))
  const probedCandidates = await probeProductImages(page, candidateUrls)
  const squareCandidates = selectSquareImageCandidates(probedCandidates)
  return {
    materialImageUrls,
    probedCandidates,
    squareCandidates,
    replacementUrls: fillSkuImageUrlCount(squareCandidates.map((item) => item.url), Math.max(SKU_IMAGE_MIN_COUNT, 3))
  }
}

const findSkuImageCells = async (page: Page, maxRows = 40) => {
  const cells = page.locator("td.color-table-cell[data-column-index='2']")
  const count = Math.min(await cells.count().catch(() => 0), Math.max(1, maxRows))
  const targets: SkuImageCellTarget[] = []

  for (let index = 0; index < count; index += 1) {
    const cell = cells.nth(index)
    if (!await cell.isVisible().catch(() => false)) {
      continue
    }

    const rowIndexAttr = await cell.getAttribute("data-row-index").catch(() => null)
    const rowIndex = rowIndexAttr && Number.isFinite(Number(rowIndexAttr)) ? Number(rowIndexAttr) : targets.length
    const row = cell.locator("xpath=ancestor::tr[1]")
    const rowText = buildSkuImageRowText(
      await cell.innerText().catch(() => ""),
      await row.innerText().catch(() => "")
    )
    targets.push({
      cell,
      rowIndex,
      rowText
    })
  }

  return targets
}

const captureSkuRepairScreenshot = async (
  page: Page,
  screenshotDir: string | undefined,
  prefix: string,
  rowIndex: number
) => {
  if (!screenshotDir) {
    return null
  }

  const screenshotPath = path.join(
    screenshotDir,
    `${safeArtifactName(prefix)}-row-${rowIndex}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`
  )
  await page.screenshot({
    path: screenshotPath,
    fullPage: true
  }).catch(() => undefined)
  return screenshotPath
}

const readSkuImageCellState = async (cell: Locator): Promise<SkuImageCellState> => {
  const imageMeta = await cell.locator("img").evaluateAll((nodes) =>
    nodes.map((node) => {
      const img = node as HTMLImageElement
      const width = img.naturalWidth || 0
      const height = img.naturalHeight || 0
      return {
        src: img.getAttribute("src") ?? "",
        width,
        height,
        aspectRatio: width > 0 && height > 0 ? width / height : null
      }
    })
  ).catch(() => [] as SkuImageCellState["imageMeta"])

  return {
    imageCount: imageMeta.length,
    imageUrls: imageMeta.map((item) => item.src).filter(Boolean),
    imageMeta
  }
}

const clearSkuImageCell = async (page: Page, cell: Locator, maxRemovals = 20) => {
  let removed = 0

  for (let attempt = 0; attempt < maxRemovals; attempt += 1) {
    const beforeCount = await cell.locator("img").count().catch(() => 0)
    const deleteButton = await firstVisible([
      cell.locator(".icon_delete"),
      cell.locator("[class*='delete' i]"),
      cell.locator("[class*='remove' i]")
    ])
    if (!deleteButton) {
      break
    }

    await clickAfterDianxiaomiIdle(page, deleteButton, 2)
    removed += 1

    const confirmDialog = (await visibleAntModalLocators(page)).at(-1) ?? null
    if (confirmDialog) {
      const confirmButton = await findInteractiveInRootByKeywords(confirmDialog, [
        "确定",
        "确认",
        "删除",
        "ok",
        "confirm"
      ])
      if (confirmButton) {
        await clickAfterDianxiaomiIdle(page, confirmButton, 1)
      }
    }

    await page.waitForTimeout(350)
    if (beforeCount > 0) {
      await page.waitForFunction(
        ({ selector, before }) => {
          const element = document.querySelector(selector)
          if (!element) {
            return true
          }
          return element.querySelectorAll("img").length < before
        },
        {
          selector: `[data-row-index="${await cell.getAttribute("data-row-index").catch(() => "")}"][data-column-index="2"]`,
          before: beforeCount
        },
        {
          timeout: 2_000
        }
      ).catch(() => {})
    }
  }

  const state = await readSkuImageCellState(cell)
  return {
    removed,
    remaining: state.imageCount,
    state
  }
}

const openSkuImageNetworkDialog = async (page: Page, cell: Locator) => {
  const chooseButton = await firstVisible([
    cell.getByRole("button", { name: /选择图片/i }),
    cell.locator("button").filter({ hasText: /选择图片/ }),
    cell.locator("[role='button']").filter({ hasText: /选择图片/ })
  ])
  if (!chooseButton) {
    return {
      opened: false,
      reason: "选择图片 button not found",
      dialog: null as Locator | null
    }
  }

  await clickAfterDianxiaomiIdle(page, chooseButton, 2)
  await page.waitForTimeout(300)

  const networkClicked = await clickVisibleMenuItemByKeywords(page, ["网络图片", "网络地址"], 3)
  if (!networkClicked) {
    return {
      opened: false,
      reason: "网络图片 menu item not found",
      dialog: null as Locator | null
    }
  }

  await page.waitForTimeout(500)
  const dialogs = await visibleAntModalLocators(page)
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index]
    const text = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
    if (keywordMatch(text, SKU_IMAGE_DIALOG_KEYWORDS)) {
      return {
        opened: true,
        reason: "ok",
        dialog
      }
    }
  }

  return {
    opened: false,
    reason: "network image dialog did not appear",
    dialog: null as Locator | null
  }
}

const submitSkuImageUrls = async (page: Page, dialog: Locator, urls: string[]) => {
  const input = await firstVisible([
    dialog.locator("textarea"),
    dialog.locator("input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit']):not([type='file'])")
  ])
  if (!input) {
    return {
      added: false,
      reason: "network image dialog input missing",
      feedback: null as SubmitFeedback | null
    }
  }

  const beforeDialogCount = (await visibleAntModalLocators(page)).length
  await fillTextField(input, urls.join("\n"))
  const addButton = await findInteractiveInRootByKeywords(dialog, ["添加", "确定", "确认", "add", "confirm"])
  if (!addButton) {
    return {
      added: false,
      reason: "network image dialog add button missing",
      feedback: null as SubmitFeedback | null
    }
  }

  const previousFeedback = await readSubmitFeedback(page)
  await clickAfterDianxiaomiIdle(page, addButton, 2)

  const feedback = await waitForSubmitFeedback(page, 8_000, previousFeedback, 1_500)
  const dialogClosed = await waitForVisibleAntModalCountAtMost(page, Math.max(0, beforeDialogCount - 1), 8_000)
  if (feedback.state === "failure" && keywordMatch(feedback.message, SKU_IMAGE_DIALOG_FAILURE_KEYWORDS)) {
    return {
      added: false,
      reason: feedback.message || "network image add failed",
      feedback
    }
  }

  if (!dialogClosed) {
    const dialogText = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
    if (keywordMatch(dialogText, SKU_IMAGE_DIALOG_FAILURE_KEYWORDS)) {
      return {
        added: false,
        reason: dialogText,
        feedback
      }
    }
  }

  return {
    added: dialogClosed,
    reason: dialogClosed ? "ok" : "network image dialog remained open",
    feedback
  }
}

const clearSkuImageCellStable = async (page: Page, cell: Locator, maxRemovals = 20) => {
  let removed = 0

  for (let attempt = 0; attempt < maxRemovals; attempt += 1) {
    const beforeCount = await cell.locator("img").count().catch(() => 0)
    if (beforeCount === 0) {
      break
    }

    const deleteButton = await firstVisible([
      cell.locator(".icon_delete"),
      cell.locator("[class*='delete' i]"),
      cell.locator("[class*='remove' i]")
    ])
    if (!deleteButton) {
      break
    }

    try {
      await clickAfterDianxiaomiIdle(page, deleteButton, 2)
    } catch {
      const forced = await forceDomClick(deleteButton)
      if (!forced) {
        break
      }
    }
    removed += 1
    await page.waitForTimeout(300)

    const afterCount = await cell.locator("img").count().catch(() => beforeCount)
    if (afterCount >= beforeCount) {
      await page.waitForTimeout(500)
    }
  }

  const state = await readSkuImageCellState(cell)
  return {
    removed,
    remaining: state.imageCount,
    state
  }
}

const findSkuChooseButton = async (cell: Locator) =>
  firstVisible([
    cell.getByRole("button", { name: /閫夋嫨鍥剧墖/i }),
    cell.locator("button").filter({ hasText: /閫夋嫨鍥剧墖/ }),
    cell.locator("[role='button']").filter({ hasText: /閫夋嫨鍥剧墖/ }),
    cell.locator(".ant-btn").filter({ hasText: /閫夋嫨鍥剧墖/ }),
    cell.locator("button"),
    cell.locator("[role='button']"),
    cell.locator(".ant-btn")
  ])

const openSkuChooseMenuStable = async (page: Page, cell: Locator) => {
  const chooseButton = await findSkuChooseButton(cell)
  if (!chooseButton) {
    return {
      opened: false,
      reason: "sku image choose button not found",
      menuCount: 0
    }
  }

  await cell.evaluate((element) => {
    if (element instanceof HTMLElement) {
      element.scrollIntoView({
        block: "center"
      })
    }
  }).catch(() => {})

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await clickAfterDianxiaomiIdle(page, chooseButton, 2)
    } catch {
      const forced = await forceDomClick(chooseButton)
      if (!forced) {
        return {
          opened: false,
          reason: "sku image choose button click failed",
          menuCount: 0
        }
      }
    }

    await page.waitForTimeout(400 + attempt * 250)
    const menuItems = page.locator(".ant-dropdown:visible .ant-dropdown-menu-item, .ant-dropdown-menu:visible .ant-dropdown-menu-item, [role='menu']:visible [role='menuitem']")
    const menuCount = await menuItems.count().catch(() => 0)
    if (menuCount > 0) {
      return {
        opened: true,
        reason: "ok",
        menuCount
      }
    }
  }

  return {
    opened: false,
    reason: "sku image choose menu did not appear",
    menuCount: 0
  }
}

const applySkuImagesToAllColors = async (page: Page, cell: Locator) => {
  const menu = await openSkuChooseMenuStable(page, cell)
  if (!menu.opened) {
    return {
      applied: false,
      reason: menu.reason,
      menu
    }
  }

  const menuItems = page.locator(".ant-dropdown:visible .ant-dropdown-menu-item, .ant-dropdown-menu:visible .ant-dropdown-menu-item, [role='menu']:visible [role='menuitem']")
  const menuCount = Math.min(await menuItems.count().catch(() => 0), 12)
  let applyAllItem: Locator | null = null

  const explicitItem = page.locator(".ant-dropdown:visible [data-menu-id='quoteAllColor'], .ant-dropdown-menu:visible [data-menu-id='quoteAllColor'], [role='menu']:visible [data-menu-id='quoteAllColor']").first()
  if (await explicitItem.isVisible().catch(() => false)) {
    applyAllItem = explicitItem
  }

  if (!applyAllItem) {
    for (let index = 0; index < menuCount; index += 1) {
      const item = menuItems.nth(index)
      if (!await item.isVisible().catch(() => false)) {
        continue
      }

      const text = cleanVisibleText(await item.innerText().catch(() => ""))
      if (
        text.includes("\u6240\u6709\u989c\u8272")
        || text.includes("\u5168\u90e8\u989c\u8272")
        || /apply.*all.*color/i.test(text)
      ) {
        applyAllItem = item
        break
      }
    }
  }

  if (!applyAllItem && menuCount >= 5) {
    applyAllItem = menuItems.nth(4)
  }

  if (!applyAllItem) {
    return {
      applied: false,
      reason: "apply-to-all-colors menu item not found",
      menu
    }
  }

  try {
    await clickAfterDianxiaomiIdle(page, applyAllItem, 2)
  } catch {
    const forced = await forceDomClick(applyAllItem)
    if (!forced) {
      return {
        applied: false,
        reason: "apply-to-all-colors menu item click failed",
        menu
      }
    }
  }

  await page.waitForTimeout(600)
  const confirmButton = await firstVisible([
    page.locator(".ant-modal:visible .ant-btn-primary"),
    page.locator(".ant-modal:visible button").filter({ hasText: /\u786e\u5b9a|\u786e\u8ba4|\u5e94\u7528|apply|confirm/i }).first()
  ])
  if (confirmButton) {
    try {
      await clickAfterDianxiaomiIdle(page, confirmButton, 1)
    } catch {
      await forceDomClick(confirmButton)
    }
    await page.waitForTimeout(1_000)
  }

  return {
    applied: true,
    reason: "ok",
    menu
  }
}

const openSkuImageNetworkDialogStable = async (page: Page, cell: Locator) => {
  const chooseButton = await findSkuChooseButton(cell)
  if (!chooseButton) {
    return {
      opened: false,
      reason: "sku image choose button not found",
      dialog: null as Locator | null
    }
  }

  await cell.evaluate((element) => {
    if (element instanceof HTMLElement) {
      element.scrollIntoView({
        block: "center"
      })
    }
  }).catch(() => {})

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await clickAfterDianxiaomiIdle(page, chooseButton, 2)
    } catch {
      const forced = await forceDomClick(chooseButton)
      if (!forced) {
        return {
          opened: false,
          reason: "sku image choose button click failed",
          dialog: null as Locator | null
        }
      }
    }
    await page.waitForTimeout(400 + attempt * 200)

    const networkClicked = await clickVisibleMenuItemByKeywords(page, ["缃戠粶鍥剧墖", "缃戠粶鍦板潃", "url"], 3)
    if (!networkClicked) {
      continue
    }

    await page.waitForTimeout(500)
    const dialogs = await visibleAntModalLocators(page)
    for (let index = dialogs.length - 1; index >= 0; index -= 1) {
      const dialog = dialogs[index]
      if (await dialog.locator("textarea").count().catch(() => 0) > 0) {
        return {
          opened: true,
          reason: "ok",
          dialog
        }
      }

      const text = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
      if (keywordMatch(text, SKU_IMAGE_DIALOG_KEYWORDS) || text.toLowerCase().includes("url")) {
        return {
          opened: true,
          reason: "ok",
          dialog
        }
      }
    }
  }

  try {
    await clickAfterDianxiaomiIdle(page, chooseButton, 2)
  } catch {
    const forced = await forceDomClick(chooseButton)
    if (!forced) {
      return {
        opened: false,
        reason: "sku image choose button click failed",
        dialog: null as Locator | null
      }
    }
  }
  await page.waitForTimeout(300)

  const menuItems = page.locator(".ant-dropdown:visible .ant-dropdown-menu-item, .ant-dropdown-menu:visible .ant-dropdown-menu-item, [role='menu']:visible [role='menuitem']")
  const menuCount = Math.min(await menuItems.count().catch(() => 0), 12)
  let networkItem: Locator | null = null

  for (let index = 0; index < menuCount; index += 1) {
    const item = menuItems.nth(index)
    if (!await item.isVisible().catch(() => false)) {
      continue
    }

    const text = cleanVisibleText(await item.innerText().catch(() => ""))
    if (text.includes("网络") || text.toLowerCase().includes("url")) {
      networkItem = item
      break
    }
  }

  if (!networkItem && menuCount >= 3) {
    networkItem = menuItems.nth(2)
  }

  if (!networkItem) {
    return {
      opened: false,
      reason: "network image menu item not found",
      dialog: null as Locator | null
    }
  }

  try {
    await clickAfterDianxiaomiIdle(page, networkItem, 2)
  } catch {
    const forced = await forceDomClick(networkItem)
    if (!forced) {
      return {
        opened: false,
        reason: "network image menu item click failed",
        dialog: null as Locator | null
      }
    }
  }
  await page.waitForTimeout(500)

  const dialogs = await visibleAntModalLocators(page)
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index]
    if (await dialog.locator("textarea").count().catch(() => 0) > 0) {
      return {
        opened: true,
        reason: "ok",
        dialog
      }
    }

    const text = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
    if (keywordMatch(text, SKU_IMAGE_DIALOG_KEYWORDS) || text.toLowerCase().includes("url")) {
      return {
        opened: true,
        reason: "ok",
        dialog
      }
    }
  }

  return {
    opened: false,
    reason: "network image dialog did not appear",
    dialog: null as Locator | null
  }
}

const submitSkuImageUrlsStable = async (page: Page, dialog: Locator, urls: string[]) => {
  const input = await firstVisible([
    dialog.locator("textarea"),
    dialog.locator("input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit']):not([type='file'])")
  ])
  if (!input) {
    return {
      added: false,
      reason: "network image dialog input missing",
      feedback: null as SubmitFeedback | null
    }
  }

  const beforeDialogCount = (await visibleAntModalLocators(page)).length
  await fillTextField(input, urls.join("\n"))

  const buttons = dialog.locator("button, .ant-btn, [role='button']")
  const buttonCount = Math.min(await buttons.count().catch(() => 0), 12)
  let addButton: Locator | null = null
  for (let index = 0; index < buttonCount; index += 1) {
    const button = buttons.nth(index)
    if (!await button.isVisible().catch(() => false)) {
      continue
    }

    const text = cleanVisibleText(await button.innerText().catch(() => ""))
    const className = await button.getAttribute("class").catch(() => "")
    if (
      text.includes(SKU_IMAGE_ADD_BUTTON_TEXT)
      || text.includes(SKU_IMAGE_CONFIRM_TEXT)
      || text.includes(SKU_IMAGE_CONFIRM_ALT_TEXT)
      || /\bprimary\b/i.test(className ?? "")
    ) {
      addButton = button
      break
    }
  }

  if (!addButton && buttonCount > 0) {
    addButton = buttons.nth(buttonCount - 1)
  }

  if (!addButton) {
    return {
      added: false,
      reason: "network image dialog add button missing",
      feedback: null as SubmitFeedback | null
    }
  }

  const previousFeedback = await readSubmitFeedback(page)
  await clickAfterDianxiaomiIdle(page, addButton, 2)
  const feedback = await waitForSubmitFeedback(page, 8_000, previousFeedback, 1_500)
  const dialogClosed = await waitForVisibleAntModalCountAtMost(page, Math.max(0, beforeDialogCount - 1), 8_000)

  if (feedback.state === "failure" && keywordMatch(feedback.message, SKU_IMAGE_DIALOG_FAILURE_KEYWORDS)) {
    return {
      added: false,
      reason: feedback.message || "network image add failed",
      feedback
    }
  }

  return {
    added: dialogClosed,
    reason: dialogClosed ? "ok" : "network image dialog remained open",
    feedback
  }
}

const waitForSkuImageCellState = async (
  page: Page,
  cell: Locator,
  predicate: (state: SkuImageCellState) => boolean,
  timeoutMs = 8_000
) => {
  const startedAt = Date.now()
  let state = await readSkuImageCellState(cell)
  while (!predicate(state) && Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(400)
    state = await readSkuImageCellState(cell)
  }
  return state
}

const isStrictSkuImageCellState = (state: SkuImageCellState) =>
  state.imageCount >= 1
  && state.imageMeta.length > 0
  && state.imageMeta.every((image) =>
    image.aspectRatio !== null
    && image.aspectRatio >= SKU_IMAGE_STRICT_RATIO_MIN
    && image.aspectRatio <= SKU_IMAGE_STRICT_RATIO_MAX
    && image.width >= SKU_IMAGE_MIN_WIDTH_PX
    && image.height >= SKU_IMAGE_MIN_HEIGHT_PX
  )

const isSquareSkuImageCellState = (state: SkuImageCellState) =>
  state.imageCount >= 1
  && state.imageMeta.length > 0
  && state.imageMeta.every((image) => isSquareAspectRatio(image.aspectRatio))

const fillSquarePreviewImageLinks = async (page: Page, imageUrls: string[], options: FillSkuImageLinksOptions = {}) => {
  const {
    materialImageUrls,
    probedCandidates,
    squareCandidates,
    replacementUrls
  } = await buildSquarePreviewReplacementUrls(page, imageUrls)

  if (replacementUrls.length === 0) {
    return stepResult(
      "fill-sku-image-links",
      "Fill SKU image links",
      "failed",
      "Could not find a compliant square preview image candidate for Dianxiaomi color preview replacement",
      {
        mode: "square-preview-all-colors",
        totalImages: imageUrls.length,
        materialImageUrls,
        probedCandidates,
        squareCandidateCount: squareCandidates.length
      }
    )
  }

  const skuCells = await findSkuImageCells(page, options.maxRows)
  if (skuCells.length === 0) {
    return stepResult(
      "fill-sku-image-links",
      "Fill SKU image links",
      "failed",
      "SKU image cells were not found on the current Dianxiaomi page",
      {
        mode: "square-preview-all-colors",
        totalImages: imageUrls.length,
        materialImageUrls,
        probedCandidates,
        replacementUrls
      }
    )
  }

  const target = skuCells[0]!
  const sampleTargets = skuCells.slice(0, Math.min(skuCells.length, 4))
  const beforeSampleStates = await Promise.all(sampleTargets.map(async (sample) => ({
    rowIndex: sample.rowIndex,
    rowText: sample.rowText,
    state: await readSkuImageCellState(sample.cell)
  })))

  const beforeScreenshotPath = await captureSkuRepairScreenshot(
    page,
    options.screenshotDir,
    `${options.screenshotPrefix ?? "fill-sku-image-links"}-square-before`,
    target.rowIndex
  )
  const opened = await openSkuImageNetworkDialogStable(page, target.cell)
  if (!opened.opened || !opened.dialog) {
    return stepResult(
      "fill-sku-image-links",
      "Fill SKU image links",
      "failed",
      `Could not open Dianxiaomi network image dialog for square preview replacement: ${opened.reason}`,
      {
        mode: "square-preview-all-colors",
        targetRowIndex: target.rowIndex,
        targetRowText: target.rowText,
        replacementUrls,
        beforeScreenshotPath,
        beforeSampleStates
      }
    )
  }

  const cleared = await clearSkuImageCellStable(page, target.cell)
  const afterClearScreenshotPath = await captureSkuRepairScreenshot(
    page,
    options.screenshotDir,
    `${options.screenshotPrefix ?? "fill-sku-image-links"}-square-after-clear`,
    target.rowIndex
  )
  const submitted = await submitSkuImageUrlsStable(page, opened.dialog, replacementUrls)
  const afterSubmitScreenshotPath = await captureSkuRepairScreenshot(
    page,
    options.screenshotDir,
    `${options.screenshotPrefix ?? "fill-sku-image-links"}-square-after-submit`,
    target.rowIndex
  )

  const applyAll = submitted.added
    ? await applySkuImagesToAllColors(page, target.cell)
    : {
        applied: false,
        reason: `network image submit failed: ${submitted.reason}`
      }
  const afterApplyAllScreenshotPath = await captureSkuRepairScreenshot(
    page,
    options.screenshotDir,
    `${options.screenshotPrefix ?? "fill-sku-image-links"}-square-after-apply-all`,
    target.rowIndex
  )

  const afterTargetState = await waitForSkuImageCellState(page, target.cell, isSquareSkuImageCellState, 10_000)
  const sampleResults: Array<Record<string, unknown>> = []
  let verifiedSampleCount = 0

  for (const sample of sampleTargets) {
    const state = await waitForSkuImageCellState(page, sample.cell, isSquareSkuImageCellState, 6_000)
    const square = isSquareSkuImageCellState(state)
    if (square) {
      verifiedSampleCount += 1
    }
    sampleResults.push({
      rowIndex: sample.rowIndex,
      rowText: sample.rowText,
      square,
      state
    })
  }

  const success =
    submitted.added
    && applyAll.applied
    && isSquareSkuImageCellState(afterTargetState)
    && verifiedSampleCount === sampleTargets.length

  return stepResult(
    "fill-sku-image-links",
    "Fill SKU image links",
    success ? "done" : "failed",
    success
      ? `Applied square preview image replacement to all colors and verified ${verifiedSampleCount} sample row(s)`
      : `Square preview replacement did not stabilize across sampled color rows (${verifiedSampleCount}/${sampleTargets.length} verified)`,
    {
      mode: "square-preview-all-colors",
      totalImages: imageUrls.length,
      materialImageUrls,
      probedCandidates,
      squareCandidates,
      replacementUrls,
      requestedMaxRows: options.maxRows ?? null,
      skuCellCount: skuCells.length,
      targetRowIndex: target.rowIndex,
      targetRowText: target.rowText,
      beforeSampleStates,
      cleared,
      submitted,
      applyAll,
      afterTargetState,
      verifiedSampleCount,
      sampleTargetCount: sampleTargets.length,
      sampleResults,
      beforeScreenshotPath,
      afterClearScreenshotPath,
      afterSubmitScreenshotPath,
      afterApplyAllScreenshotPath
    }
  )
}

export const fillSkuImageLinks = async (page: Page, imageUrls: string[], options: FillSkuImageLinksOptions = {}) => {
  if (options.mode === "square-preview-all-colors") {
    return fillSquarePreviewImageLinks(page, imageUrls, options)
  }

  const probedImages = await probeProductImages(page, imageUrls)
  const { strict, preferred, selected } = selectSkuImageCandidates(probedImages)
  const squareCandidates = selectSquareImageCandidates(probedImages)
  const strictVariantCandidateUrls = Array.from(new Set([
    ...strict.flatMap((item) => buildStrictSkuNetworkUrls(item)),
    ...selected.flatMap((item) => buildStrictSkuNetworkUrls(item)),
    ...squareCandidates.flatMap((item) => buildStrictSkuNetworkUrls(item))
  ]))
  const probedStrictVariantCandidates = strictVariantCandidateUrls.length > 0
    ? await probeProductImages(page, strictVariantCandidateUrls)
    : []
  const strictVariantUrls = probedStrictVariantCandidates
    .filter(isStrictSkuImageCandidate)
    .sort((left, right) =>
      skuImageDistanceFromTarget(left) - skuImageDistanceFromTarget(right)
      || right.height - left.height
      || right.width - left.width
    )
    .map((item) => item.url)
  const replacementCandidateUrls = strictVariantUrls.length > 0
    ? strictVariantUrls
    : selected.map((item) => item.url)

  if (replacementCandidateUrls.length === 0) {
    return stepResult(
      "fill-sku-image-links",
      "Fill SKU image links",
      "failed",
      "Could not find enough strict 3:4 SKU image candidates from task product images",
      {
        totalImages: imageUrls.length,
        probedImages,
        strictCandidateCount: strict.length,
        strictVariantCandidateUrls,
        probedStrictVariantCandidates,
        strictVariantUrls,
        preferredCount: preferred.length,
        selectedCount: selected.length,
        squareCandidateCount: squareCandidates.length
      }
    )
  }

  const skuCells = await findSkuImageCells(page, options.maxRows)
  if (skuCells.length === 0) {
    return stepResult(
      "fill-sku-image-links",
      "Fill SKU image links",
      "failed",
      "SKU image cells were not found on the current Dianxiaomi page",
      {
        totalImages: imageUrls.length,
        probedImages,
        selectedCandidates: selected
      }
    )
  }

  const urlsForReplacement = fillSkuImageUrlCount(replacementCandidateUrls, Math.max(SKU_IMAGE_MIN_COUNT, 3))
  const target = skuCells[0]!
  const sampleTargets = skuCells.slice(0, Math.min(skuCells.length, 4))
  const beforeSampleStates = await Promise.all(sampleTargets.map(async (sample) => ({
    rowIndex: sample.rowIndex,
    rowText: sample.rowText,
    state: await readSkuImageCellState(sample.cell)
  })))

  const beforeScreenshotPath = await captureSkuRepairScreenshot(
    page,
    options.screenshotDir,
    `${options.screenshotPrefix ?? "fill-sku-image-links"}-strict-before`,
    target.rowIndex
  )
  const opened = await openSkuImageNetworkDialogStable(page, target.cell)

  if (!opened.opened || !opened.dialog) {
    return stepResult(
      "fill-sku-image-links",
      "Fill SKU image links",
      "failed",
      `Could not open Dianxiaomi network image dialog for strict SKU replacement: ${opened.reason}`,
      {
        mode: "strict-color",
        totalImages: imageUrls.length,
        probedImages,
        probedStrictVariantCandidates,
        strictVariantCandidateUrls,
        strictVariantUrls,
        replacementCandidateUrls,
        urlsForReplacement,
        targetRowIndex: target.rowIndex,
        targetRowText: target.rowText,
        beforeSampleStates,
        beforeScreenshotPath
      }
    )
  }

  const cleared = await clearSkuImageCellStable(page, target.cell)
  const afterClearScreenshotPath = await captureSkuRepairScreenshot(
    page,
    options.screenshotDir,
    `${options.screenshotPrefix ?? "fill-sku-image-links"}-strict-after-clear`,
    target.rowIndex
  )
  const dialogOpenScreenshotPath = await captureSkuRepairScreenshot(
    page,
    options.screenshotDir,
    `${options.screenshotPrefix ?? "fill-sku-image-links"}-strict-dialog-open`,
    target.rowIndex
  )
  const submitted = await submitSkuImageUrlsStable(page, opened.dialog, urlsForReplacement)
  const afterSubmitScreenshotPath = await captureSkuRepairScreenshot(
    page,
    options.screenshotDir,
    `${options.screenshotPrefix ?? "fill-sku-image-links"}-strict-after-submit`,
    target.rowIndex
  )

  const applyAll = submitted.added
    ? await applySkuImagesToAllColors(page, target.cell)
    : {
        applied: false,
        reason: `network image submit failed: ${submitted.reason}`
      }
  const afterApplyAllScreenshotPath = await captureSkuRepairScreenshot(
    page,
    options.screenshotDir,
    `${options.screenshotPrefix ?? "fill-sku-image-links"}-strict-after-apply-all`,
    target.rowIndex
  )

  const afterTargetState = await waitForSkuImageCellState(page, target.cell, isStrictSkuImageCellState, 12_000)
  const sampleResults: Array<Record<string, unknown>> = []
  let verifiedSampleCount = 0

  for (const sample of sampleTargets) {
    const state = await waitForSkuImageCellState(page, sample.cell, isStrictSkuImageCellState, 8_000)
    const strictOk = isStrictSkuImageCellState(state)
    if (strictOk) {
      verifiedSampleCount += 1
    }
    sampleResults.push({
      rowIndex: sample.rowIndex,
      rowText: sample.rowText,
      strictOk,
      state
    })
  }

  const success =
    submitted.added
    && applyAll.applied
    && isStrictSkuImageCellState(afterTargetState)
    && verifiedSampleCount === sampleTargets.length

  return stepResult(
    "fill-sku-image-links",
    "Fill SKU image links",
    success ? "done" : "failed",
    success
      ? `Applied strict SKU image replacement to all colors and verified ${verifiedSampleCount} sample row(s)`
      : `Strict SKU replacement did not stabilize across sampled color rows (${verifiedSampleCount}/${sampleTargets.length} verified)`,
    {
      mode: "strict-color",
      totalImages: imageUrls.length,
      probedImages,
      probedStrictVariantCandidates,
      selectedCandidates: selected,
      strictCandidateCount: strict.length,
      strictVariantCandidateUrls,
      strictVariantUrls,
      replacementCandidateUrls,
      preferredCandidateCount: preferred.length,
      squareCandidateCount: squareCandidates.length,
      requestedMaxRows: options.maxRows ?? null,
      skuCellCount: skuCells.length,
      urlsForReplacement,
      targetRowIndex: target.rowIndex,
      targetRowText: target.rowText,
      beforeSampleStates,
      cleared,
      submitted,
      applyAll,
      afterTargetState,
      verifiedSampleCount,
      sampleTargetCount: sampleTargets.length,
      sampleResults,
      beforeScreenshotPath,
      afterClearScreenshotPath,
      dialogOpenScreenshotPath,
      afterSubmitScreenshotPath,
      afterApplyAllScreenshotPath
    }
  )
}

const forceDomClick = async (locator: Locator) =>
  locator.evaluate((element) => {
    if (element instanceof HTMLElement) {
      element.click()
      return true
    }

    return false
  }).catch(() => false)

const openDescriptionEditorModal = async (page: Page) => {
  const beforeCount = (await visibleAntModalLocators(page)).length
  const directTrigger = page.locator("#wirelessDescBox button, #baiduStatisticsSmtNewEditorEditClickNum button").first()
  const hasDirectTrigger = await directTrigger.count().catch(() => 0) > 0
  const trigger = hasDirectTrigger
    ? directTrigger
    : await findInteractiveByKeywords(page, DESCRIPTION_EDIT_TRIGGER_KEYWORDS)

  if (!trigger) {
    return {
      opened: false,
      reason: "description edit trigger not found",
      dialog: null as Locator | null
    }
  }

  if (hasDirectTrigger) {
    await page.locator("#wirelessDescBox").evaluate((element) => {
      if (element instanceof HTMLElement) {
        element.scrollIntoView({
          block: "center"
        })
      }
    }).catch(() => {})
    await page.waitForTimeout(400)
  }

  try {
    await clickAfterDianxiaomiIdle(page, trigger, 2)
  } catch {
    const forced = await forceDomClick(trigger)
    if (!forced) {
      return {
        opened: false,
        reason: "description edit trigger click failed",
        dialog: null as Locator | null
      }
    }
  }

  await page.waitForTimeout(800)
  const opened = await page.waitForFunction(
    (previousCount) => document.querySelectorAll(".ant-modal").length > previousCount,
    beforeCount,
    { timeout: 8_000 }
  ).then(() => true).catch(() => false)

  if (!opened) {
    return {
      opened: false,
      reason: "description editor modal did not appear",
      dialog: null as Locator | null
    }
  }

  const dialogs = await visibleAntModalLocators(page)
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index]
    const text = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
    if (keywordMatch(text, DESCRIPTION_MODAL_KEYWORDS)) {
      return {
        opened: true,
        reason: "ok",
        dialog
      }
    }
  }

  return {
    opened: false,
    reason: "description editor modal not recognized",
    dialog: null as Locator | null
  }
}

const readDescriptionImageModuleState = async (root: Locator): Promise<DescriptionImageModuleState> => {
  const modules = await root.locator(".smt-desc-content[data-idx]").evaluateAll((nodes) =>
    nodes.map((node) => {
      const element = node as HTMLElement
      const index = Number.parseInt(element.dataset.idx ?? "-1", 10)
      const image = element.querySelector("img") as HTMLImageElement | null
      const width = image?.naturalWidth || 0
      const height = image?.naturalHeight || 0
      return {
        index: Number.isFinite(index) ? index : -1,
        src: image?.getAttribute("src") ?? "",
        width,
        height,
        aspectRatio: width > 0 && height > 0 ? width / height : null
      }
    })
  ).catch(() => [] as DescriptionImageModuleState["modules"])

  return {
    moduleCount: modules.length,
    modules
  }
}

const collectDescriptionImageModuleTargets = async (dialog: Locator): Promise<DescriptionImageModuleTarget[]> => {
  const items = dialog.locator(".using-modules-content .using-item.sortable-item")
  const itemCount = Math.min(await items.count().catch(() => 0), 40)
  const targets: DescriptionImageModuleTarget[] = []

  for (let index = 0; index < itemCount; index += 1) {
    const item = items.nth(index)
    if (!await item.isVisible().catch(() => false)) {
      continue
    }

    const dataIndex = await item.getAttribute("data-idx").catch(() => null)
    const parsedIndex = dataIndex && Number.isFinite(Number(dataIndex)) ? Number(dataIndex) : index
    const contentImage = dialog.locator(`.smt-desc-content[data-idx="${parsedIndex}"] img`).first()
    const image = await contentImage.evaluate((node) => {
      const img = node as HTMLImageElement
      const width = img.naturalWidth || 0
      const height = img.naturalHeight || 0
      return {
        src: img.getAttribute("src") ?? "",
        width,
        height,
        aspectRatio: width > 0 && height > 0 ? width / height : null
      }
    }).catch(() => null as DescriptionImageModuleTarget["image"])

    targets.push({
      item,
      index: parsedIndex,
      image
    })
  }

  return targets
}

const deleteDescriptionImageModule = async (page: Page, target: DescriptionImageModuleTarget) => {
  const targetImageSrc = target.image?.src ?? ""
  const descriptionImageCountBefore = await page.locator(".ant-modal.smt-new-editor .smt-desc-content[data-idx] img").count().catch(() => 0)

  await target.item.hover().catch(() => {})
  await page.waitForTimeout(300)

  let clickedViaHoverDelete = await target.item.evaluate((element) => {
    const deleteControl = element.querySelector(".icon_delete, [title='删除'], [title*='删除'], [class*='delete'], [class*='remove']")
    if (!(deleteControl instanceof HTMLElement)) {
      return false
    }

    deleteControl.click()
    return true
  }).catch(() => false)

  if (!clickedViaHoverDelete) {
    const fallbackDeleteButton = await firstVisible([
      target.item.locator(".icon_delete"),
      target.item.locator("[title*='删除']"),
      target.item.locator("[class*='delete' i]"),
      target.item.locator("[class*='remove' i]")
    ]) ?? await findInteractiveInRootByKeywords(target.item, DESCRIPTION_DELETE_KEYWORDS)

    if (!fallbackDeleteButton) {
      return {
        deleted: false,
        reason: "description module delete button missing"
      }
    }

    try {
      await clickAfterDianxiaomiIdle(page, fallbackDeleteButton, 2)
      clickedViaHoverDelete = true
    } catch {
      const forcedFallbackDelete = await forceDomClick(fallbackDeleteButton)
      if (!forcedFallbackDelete) {
        return {
          deleted: false,
          reason: "description module delete click failed"
        }
      }
      clickedViaHoverDelete = true
    }
  }

  if (!clickedViaHoverDelete) {
    return {
      deleted: false,
      reason: "description module delete click failed"
    }
  }

  await page.waitForTimeout(500)
  const descriptionImageRemoved = await page.waitForFunction(
    ({ src, before }) => {
      const images = Array.from(document.querySelectorAll(".ant-modal.smt-new-editor .smt-desc-content[data-idx] img"))
      const stillHasTarget = src
        ? images.some((node) => (node as HTMLImageElement).getAttribute("src") === src)
        : false
      return src
        ? !stillHasTarget
        : images.length < before
    },
    {
      src: targetImageSrc,
      before: descriptionImageCountBefore
    },
    { timeout: 5_000 }
  ).then(() => true).catch(() => false)

  return {
    deleted: descriptionImageRemoved,
    reason: descriptionImageRemoved ? "ok" : "description module image remained after delete"
  }
}

const saveDescriptionEditorModal = async (page: Page, dialog: Locator) => {
  const beforeCount = (await visibleAntModalLocators(page)).length
  const saveButton = await findInteractiveInRootByKeywords(dialog, DESCRIPTION_MODAL_SAVE_KEYWORDS)
  if (!saveButton) {
    return {
      saved: false,
      reason: "description modal save button not found"
    }
  }

  try {
    await clickAfterDianxiaomiIdle(page, saveButton, 2)
  } catch {
    const forced = await forceDomClick(saveButton)
    if (!forced) {
      return {
        saved: false,
        reason: "description modal save click failed"
      }
    }
  }

  await page.waitForTimeout(800)
  const closed = await waitForVisibleAntModalCountAtMost(page, Math.max(0, beforeCount - 1), 10_000)
  return {
    saved: closed,
    reason: closed ? "ok" : "description modal remained open after save"
  }
}

export const normalizeDescriptionImageModules = async (page: Page, imageUrls: string[]) => {
  const probedImages = await probeProductImages(page, imageUrls)
  const { selected } = selectSkuImageCandidates(probedImages)
  const opened = await openDescriptionEditorModal(page)

  if (!opened.opened || !opened.dialog) {
    return stepResult(
      "normalize-description-image-modules",
      "Normalize description image modules",
      "failed",
      opened.reason,
      {
        totalImages: imageUrls.length,
        probedImages,
        selectedCandidates: selected
      }
    )
  }

  const dialog = opened.dialog
  const beforeState = await readDescriptionImageModuleState(dialog)
  const targets = await collectDescriptionImageModuleTargets(dialog)
  const removable = targets.filter((target) => {
    const image = target.image
    if (!image || !image.src) {
      return false
    }

    if (image.aspectRatio === null) {
      return false
    }

    const ratioInvalid = image.aspectRatio < DESCRIPTION_IMAGE_RATIO_MIN || image.aspectRatio > DESCRIPTION_IMAGE_RATIO_MAX
    return ratioInvalid
  })

  const deletionResults: Array<Record<string, unknown>> = []
  for (const target of removable.sort((left, right) => right.index - left.index)) {
    const result = await deleteDescriptionImageModule(page, target)
    deletionResults.push({
      index: target.index,
      image: target.image,
      ...result
    })
  }

  const afterDeleteState = await readDescriptionImageModuleState(dialog)
  const saveResult = await saveDescriptionEditorModal(page, dialog)
  const pageDescriptionState = await page.locator(".wirelessDescContentBox, #wirelessDescContentBox, [class*='wirelessDescContentBox']").first().evaluate((root) => {
    const element = root as HTMLElement | null
    if (!element) {
      return {
        exists: false,
        imageCount: 0,
        images: []
      }
    }

    const images = Array.from(element.querySelectorAll("img")).map((node) => {
      const img = node as HTMLImageElement
      const width = img.naturalWidth || 0
      const height = img.naturalHeight || 0
      return {
        src: img.getAttribute("src") ?? "",
        width,
        height,
        aspectRatio: width > 0 && height > 0 ? width / height : null
      }
    })

    return {
      exists: true,
      imageCount: images.length,
      images
    }
  }).catch(() => ({
    exists: false,
    imageCount: 0,
    images: []
  }))

  const failedDeletes = deletionResults.filter((item) => item.deleted !== true).length
  const deletedCount = deletionResults.filter((item) => item.deleted === true).length
  const remainingInvalid = (pageDescriptionState.images as Array<{ aspectRatio: number | null }>).filter((image) =>
    image.aspectRatio !== null
    && (image.aspectRatio < DESCRIPTION_IMAGE_RATIO_MIN || image.aspectRatio > DESCRIPTION_IMAGE_RATIO_MAX)
  ).length

  const status: StepStatus =
    failedDeletes > 0 || !saveResult.saved
      ? "failed"
      : deletedCount > 0 || removable.length === 0
        ? "done"
        : "skipped"

  return stepResult(
    "normalize-description-image-modules",
    "Normalize description image modules",
    status,
    failedDeletes > 0
      ? `Failed to delete ${failedDeletes} invalid description image module(s)`
      : !saveResult.saved
        ? "Description image module changes were not saved"
        : deletedCount > 0
          ? `Removed ${deletedCount} invalid description image module(s)`
          : "No invalid description image modules detected",
    {
      totalImages: imageUrls.length,
      probedImages,
      selectedCandidates: selected,
      beforeState,
      removableCount: removable.length,
      deletionResults,
      afterDeleteState,
      saveResult,
      pageDescriptionState,
      remainingInvalid
    }
  )
}

const openImageTranslationMenuIfPresent = async (page: Page, root: Locator | null, primaryAction?: Locator | null) => {
  if (await findVisibleMenuItemByKeywords(page, IMAGE_TRANSLATION_DIRECT_MENU_KEYWORDS)) {
    return true
  }

  // The primary button may already have opened a first-level engine menu.
  // Prefer drilling into that visible menu before toggling the trigger again.
  const openedEngineMenu = await clickVisibleMenuItemByKeywords(page, IMAGE_TRANSLATION_ALIBABA_ENGINE_MENU_KEYWORDS, 1)
  if (openedEngineMenu && await findVisibleMenuItemByKeywords(page, IMAGE_TRANSLATION_DIRECT_MENU_KEYWORDS)) {
    return true
  }

  const trigger = primaryAction
    ?? (root
      ? await findInteractiveInRootByKeywords(root, IMAGE_TRANSLATION_MENU_TRIGGER_KEYWORDS)
      : null)
    ?? await findInteractiveByKeywords(page, IMAGE_TRANSLATION_MENU_TRIGGER_KEYWORDS)

  if (!trigger) {
    return false
  }

  await clickAfterDianxiaomiIdle(page, trigger, 1)
  await page.waitForTimeout(400)
  await clickVisibleMenuItemByKeywords(page, IMAGE_TRANSLATION_ALIBABA_ENGINE_MENU_KEYWORDS, 1)
  return Boolean(await findVisibleMenuItemByKeywords(page, IMAGE_TRANSLATION_DIRECT_MENU_KEYWORDS))
}

const completeImageTranslationFinalActionIfPresent = async (page: Page, primaryAction?: Locator | null) => {
  await page.waitForTimeout(400)
  const latestDialog = await getLatestImageTranslationDialog(page)
  if (latestDialog) {
    await ensureCheckboxNearText(latestDialog, "\u9009\u62e9\u5168\u90e8", true)
    await ensureCheckboxNearText(latestDialog, "\u5feb\u901f\u7ffb\u8bd1", false)
  }

  await openImageTranslationMenuIfPresent(page, latestDialog, primaryAction)

  const clickedDirectLanguageAction = await clickVisibleMenuItemByKeywords(page, IMAGE_TRANSLATION_DIRECT_MENU_KEYWORDS, 3)
  if (!clickedDirectLanguageAction) {
    return false
  }
  await page.waitForTimeout(500)

  const followupStartedAt = Date.now()
  while (Date.now() - followupStartedAt < 4_000) {
    const followupDialog = await getLatestImageTranslationDialog(page)
    if (!followupDialog) {
      return true
    }

    const followupText = normalizeFeedbackText(await followupDialog.innerText().catch(() => ""))
    const requiresLanguageSelection = keywordMatch(followupText, [
      "\u81ea\u5b9a\u4e49\u7ffb\u8bd1",
      "\u9ad8\u7ea7\u7ffb\u8bd1",
      "\u6e90\u8bed\u8a00",
      "\u76ee\u6807\u8bed\u8a00"
    ])

    if (!requiresLanguageSelection) {
      await page.waitForTimeout(250)
      continue
    }

    const selects = followupDialog.locator(".ant-select:visible")
    const sourceSelect = await selects.count().catch(() => 0) > 0 ? selects.nth(0) : null
    const targetSelect = await selects.count().catch(() => 0) > 1 ? selects.nth(1) : null

    if (sourceSelect) {
      await selectAntOption(page, sourceSelect, IMAGE_TRANSLATION_SOURCE_LANGUAGE_KEYWORDS, IMAGE_TRANSLATION_SOURCE_LANGUAGE_KEYWORDS[0])
    }

    if (targetSelect) {
      await selectAntOption(page, targetSelect, IMAGE_TRANSLATION_TARGET_LANGUAGE_KEYWORDS, IMAGE_TRANSLATION_TARGET_LANGUAGE_KEYWORDS[0])
    }

    const confirmTranslateButton = await findInteractiveInRootByKeywords(followupDialog, [
      "\u786e\u5b9a\u7ffb\u8bd1",
      "\u5f00\u59cb\u7ffb\u8bd1",
      "\u63d0\u4ea4\u7ffb\u8bd1",
      "\u7ffb\u8bd1",
      "translate",
      "start translation",
      "confirm translation"
    ])
    if (confirmTranslateButton) {
      await clickAfterDianxiaomiIdle(page, confirmTranslateButton, 1)
      await page.waitForTimeout(400)
    }

    return true
  }

  return true
}

const finalizeImageTranslationResultIfPresent = async (page: Page) => {
  let handled = false

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const dialogs = await visibleModalCandidates(page)
    if (dialogs.length === 0) {
      return handled
    }

    const dialogSnapshots: Array<{
      dialog: Locator
      text: string
      looksLikeImageCheckDialog: boolean
      looksLikeTranslationDialog: boolean
    }> = []
    for (const dialog of dialogs) {
      const text = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
      const looksLikeImageCheckDialog = Boolean(keywordMatch(text, IMAGE_CHECK_DIALOG_HINT_KEYWORDS))
      dialogSnapshots.push({
        dialog,
        text,
        looksLikeImageCheckDialog,
        looksLikeTranslationDialog: !looksLikeImageCheckDialog
          && Boolean(keywordMatch(text, IMAGE_TRANSLATION_DIALOG_HINT_KEYWORDS))
      })
    }

    let acted = false
    for (let index = dialogSnapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = dialogSnapshots[index]
      const overlayAboveTranslation = index === dialogSnapshots.length - 1
        && !snapshot.looksLikeImageCheckDialog
        && !snapshot.looksLikeTranslationDialog
        && dialogSnapshots.slice(0, index).some((item) => item.looksLikeTranslationDialog)

      if (!snapshot.looksLikeTranslationDialog && !overlayAboveTranslation) {
        continue
      }

      const action = await findImageTranslationResultAction(snapshot.dialog)

      if (!action) {
        continue
      }

      const beforeCount = dialogs.length
      await clickAfterDianxiaomiIdle(page, action, 1)
      await page.waitForTimeout(500)
      await waitForVisibleModalCandidateCountAtMost(page, Math.max(0, beforeCount - 1), 5_000)
      handled = true
      acted = true
      break
    }

    if (!acted) {
      return handled
    }
  }

  return handled
}

const findImageOptionsTrigger = async (page: Page) =>
  await firstCompactInteractiveVisible([
    page.locator(".img-module .img-options-action-btn.ant-dropdown-trigger"),
    page.locator(".img-module [class*='dropdown-trigger' i]").filter({ hasText: /编辑图片|批量|crop/i }),
    page.locator(".img-options-action-btn").filter({ hasText: /编辑图片|批量|crop/i })
  ])
  ?? await findInteractiveByKeywords(page, IMAGE_OPTIONS_TRIGGER_KEYWORDS)

const findImageOptionsMenuAction = async (
  page: Page,
  keywords: string[]
) => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await waitForDianxiaomiLoadingOverlayToClear(page)
    const existing = await findVisibleMenuItemByKeywords(page, keywords)
    if (existing) {
      return existing
    }

    const trigger = await findImageOptionsTrigger(page).catch(() => null)
    if (!trigger) {
      await page.waitForTimeout(500)
      continue
    }

    try {
      await clickAfterDianxiaomiIdle(page, trigger, 1)
      await page.waitForTimeout(400)
      const menuAction = await findVisibleMenuItemByKeywords(page, keywords)
      if (menuAction) {
        return menuAction
      }
    } catch {
      await page.waitForTimeout(750)
    }
  }

  return null
}

const describeLocator = async (locator: Locator | null): Promise<LocatorDescriptor | null> => {
  if (!locator) {
    return null
  }

  return locator.evaluate((element) => ({
    tagName: element.tagName.toLowerCase(),
    text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    role: element.getAttribute("role"),
    className: typeof element.className === "string" ? element.className.slice(0, 120) : "",
    href: element instanceof HTMLAnchorElement ? element.href : ""
  })).catch(() => null)
}

const collectMediaToolCandidates = async (
  page: Page,
  config: DianxiaomiSelectorConfig = {}
): Promise<MediaToolCandidate[]> => {
  const candidates: MediaToolCandidate[] = []

  for (const tool of DIANXIAOMI_MEDIA_TOOLS) {
    const configuredSelectors = config.mediaTools?.[tool.configKey] ?? []
    const imageMenuKeywords = IMAGE_OPTIONS_MENU_KEYWORDS[tool.id]
    const locator = imageMenuKeywords
      ? await findImageOptionsMenuAction(page, imageMenuKeywords)
        ?? await findInteractiveByKeywords(page, tool.keywords, configuredSelectors)
      : await findInteractiveByKeywords(page, tool.keywords, configuredSelectors)
    const locatorDescriptor = await describeLocator(locator)
    candidates.push({
      ...tool,
      selectorConfigured: configuredSelectors.length > 0,
      locator,
      locatorDescriptor
    })
  }

  return candidates
}

const getPageSafetyState = async (page: Page): Promise<PageSafetyState> => {
  const dialogs = await visibleDialogLocators(page)
  const blockingDialogs: LocatorDescriptor[] = []

  for (const dialog of dialogs) {
    const descriptor = await describeLocator(dialog)
    if (descriptor) {
      blockingDialogs.push(descriptor)
    }
  }

  return {
    visibleDialogCount: blockingDialogs.length,
    visibleImageCount: await countVisible(page.locator("img"), 120),
    blockingDialogs
  }
}

const collectVisibleLocators = async (locator: Locator, maxCount = 20) => {
  const count = Math.min(await locator.count().catch(() => 0), maxCount)
  const visibleLocators: Locator[] = []

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index)
    if (await item.isVisible().catch(() => false)) {
      visibleLocators.push(item)
    }
  }

  return visibleLocators
}

const visibleDialogLocators = async (page: Page) => {
  const selectors = [
    ".ant-modal:visible",
    ".el-dialog:visible",
    "[role='dialog']:visible",
    "[aria-modal='true']:visible",
    ".modal:visible",
    "[class*='dialog' i]:visible",
    "[class*='popup' i]:visible",
    "[class*='layer' i]:visible",
    "[class*='drawer' i]:visible",
    "[class*='overlay' i]:visible"
  ]
  const seen = new Set<string>()
  const dialogs: Locator[] = []

  for (const selector of selectors) {
    for (const item of await collectVisibleLocators(page.locator(selector))) {
      if (!await isLikelyDialogContainer(item)) {
        continue
      }
      const key = await locatorIdentityKey(item)
      if (!key || seen.has(key)) {
        continue
      }
      seen.add(key)
      dialogs.push(item)
    }
  }

  for (const item of await collectLikelyFloatingPanels(page)) {
    if (!await isLikelyDialogContainer(item)) {
      continue
    }
    const key = await locatorIdentityKey(item)
    if (!key || seen.has(key)) {
      continue
    }
    seen.add(key)
    dialogs.push(item)
  }

  return dialogs
}

const waitForVisibleDialogCountAtMost = async (page: Page, maximumVisibleDialogs: number, timeoutMs = 8_000) => {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if ((await visibleDialogLocators(page)).length <= maximumVisibleDialogs) {
      return true
    }

    await page.waitForTimeout(250)
  }

  return (await visibleDialogLocators(page)).length <= maximumVisibleDialogs
}

const getLatestMediaSurface = async (page: Page) => {
  const dialogs = await visibleDialogLocators(page)
  return dialogs[dialogs.length - 1] ?? page.locator("body")
}

const getLatestMediaDialog = async (page: Page) => {
  const dialogs = await visibleDialogLocators(page)
  return dialogs[dialogs.length - 1] ?? null
}

const getLatestImageTranslationDialog = async (page: Page) => {
  const dialogs = await visibleDialogLocators(page)

  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index]
    const text = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
    if (
      !keywordMatch(text, IMAGE_CHECK_DIALOG_HINT_KEYWORDS)
      && keywordMatch(text, IMAGE_TRANSLATION_DIALOG_HINT_KEYWORDS)
    ) {
      return dialog
    }
  }

  return null
}

const getTopmostOverlayAboveImageTranslation = async (page: Page) => {
  const dialogs = await visibleModalCandidates(page)
  if (dialogs.length < 2) {
    return null
  }

  const snapshots: Array<{
    dialog: Locator
    text: string
    looksLikeImageCheckDialog: boolean
    looksLikeTranslationDialog: boolean
  }> = []

  for (const dialog of dialogs) {
    const text = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
    const looksLikeImageCheckDialog = Boolean(keywordMatch(text, IMAGE_CHECK_DIALOG_HINT_KEYWORDS))
    snapshots.push({
      dialog,
      text,
      looksLikeImageCheckDialog,
      looksLikeTranslationDialog: !looksLikeImageCheckDialog
        && Boolean(keywordMatch(text, IMAGE_TRANSLATION_DIALOG_HINT_KEYWORDS))
    })
  }

  const top = snapshots[snapshots.length - 1] ?? null
  if (!top || top.looksLikeImageCheckDialog || top.looksLikeTranslationDialog) {
    return null
  }

  return snapshots.slice(0, -1).some((item) => item.looksLikeTranslationDialog)
    ? top
    : null
}

const findInteractiveInRootByKeywords = async (root: Page | Locator, keywords: string[]) => {
  for (const keyword of keywords) {
    const pattern = new RegExp(escapeRegExp(keyword), "i")
    const valueSelector = [
      `input[type='button'][value*="${keyword}" i]`,
      `input[type='submit'][value*="${keyword}" i]`,
      `[aria-label*="${keyword}" i]`,
      `[title*="${keyword}" i]`
    ].join(", ")
    const match = await firstVisible([
      root.getByRole("button", { name: pattern }),
      root.getByRole("link", { name: pattern }),
      root.getByRole("menuitem", { name: pattern }),
      root.locator("button, a, span.link, [role='button'], [role='link'], [role='menuitem']").filter({ hasText: pattern }),
      root.locator(valueSelector)
    ])

    if (match) {
      return match
    }
  }

  return null
}

const findLastVisibleActionInRoot = async (root: Locator, maxCount = 20) => {
  const actions = root.locator("button, [role='button'], input[type='button'], input[type='submit']")
  const count = Math.min(await actions.count().catch(() => 0), maxCount)

  for (let index = count - 1; index >= 0; index -= 1) {
    const action = actions.nth(index)
    if (!await action.isVisible().catch(() => false)) {
      continue
    }

    const text = cleanVisibleText(await action.innerText().catch(async () => await action.getAttribute("value").catch(() => "")))
    if (!text) {
      continue
    }

    return action
  }

  return null
}

const IMAGE_TRANSLATION_RESULT_NON_FINAL_ACTION_KEYWORDS = [
  "译图",
  "原图",
  "选择全部",
  "快速翻译",
  "保留原图",
  "强制识别"
]

const findImageTranslationResultAction = async (root: Locator, maxCount = 24) => {
  const directConfirm = await findInteractiveInRootByKeywords(root, IMAGE_TRANSLATION_RESULT_CONFIRM_KEYWORDS)
  if (directConfirm) {
    return directConfirm
  }

  const directClose = await firstVisible([
    root.locator("[aria-label*='close' i]"),
    root.locator("[title*='close' i]"),
    root.locator(".ant-modal-close, .el-dialog__headerbtn, .modal-close, [class*='close' i]")
  ])
  if (directClose) {
    return directClose
  }

  const actions = root.locator("button, [role='button'], input[type='button'], input[type='submit'], a[role='button']")
  const count = Math.min(await actions.count().catch(() => 0), maxCount)
  for (let index = count - 1; index >= 0; index -= 1) {
    const action = actions.nth(index)
    if (!await action.isVisible().catch(() => false)) {
      continue
    }

    const text = cleanVisibleText(
      await action.innerText().catch(async () => await action.getAttribute("value").catch(() => ""))
    )
    if (!text) {
      continue
    }

    if (keywordMatch(text, IMAGE_TRANSLATION_RESULT_NON_FINAL_ACTION_KEYWORDS)) {
      continue
    }

    return action
  }

  return findInteractiveInRootByKeywords(root, MEDIA_CLOSE_KEYWORDS)
}

type DianxiaomiSubmitClickResult = {
  clickedButton: boolean
  clickedMenuAction: boolean
  menuActionText: string | null
  menuVisibleAfterButton: boolean
}

const SUBMIT_MENU_ACTION_KEYWORDS = [
  "\u4fdd\u5b58\u5e76\u53d1\u5e03",
  "\u7acb\u5373\u53d1\u5e03",
  "\u786e\u8ba4\u53d1\u5e03",
  "\u53d1\u5e03",
  "\u63d0\u4ea4",
  "\u520a\u767b",
  "\u7acb\u5373\u520a\u767b",
  "publish",
  "submit"
]

const readLocatorCompactText = async (locator: Locator | null) =>
  locator ? cleanVisibleText(await locator.innerText().catch(() => "")) : ""

const visibleSubmitMenuRoots = async (page: Page) => {
  const roots = page.locator([
    ".ant-dropdown:visible",
    ".ant-dropdown-menu:visible",
    ".el-dropdown-menu:visible",
    "[role='menu']:visible"
  ].join(", "))
  const rootCount = Math.min(await roots.count().catch(() => 0), 8)
  const visibleRoots: Locator[] = []

  for (let index = 0; index < rootCount; index += 1) {
    const root = roots.nth(index)
    if (await root.isVisible().catch(() => false)) {
      visibleRoots.push(root)
    }
  }

  return visibleRoots
}

const findSubmitMenuAction = async (page: Page) => {
  const deadline = Date.now() + 2_500

  while (Date.now() < deadline) {
    const roots = await visibleSubmitMenuRoots(page)
    for (const root of roots) {
      const keywordMatchAction = await findInteractiveInRootByKeywords(root, SUBMIT_MENU_ACTION_KEYWORDS)
      if (keywordMatchAction && await keywordMatchAction.isVisible().catch(() => false)) {
        return keywordMatchAction
      }

      const fallbackItems = root.locator("[role='menuitem'], .ant-dropdown-menu-item, .el-dropdown-menu__item, li, button, a").filter({
        hasText: /\S/
      })
      const fallbackCount = Math.min(await fallbackItems.count().catch(() => 0), 10)
      for (let index = 0; index < fallbackCount; index += 1) {
        const item = fallbackItems.nth(index)
        if (await item.isVisible().catch(() => false)) {
          return item
        }
      }
    }

    await page.waitForTimeout(200)
  }

  return null
}

const clickDianxiaomiSubmitAction = async (
  page: Page,
  config: DianxiaomiSelectorConfig
): Promise<DianxiaomiSubmitClickResult> => {
  const result: DianxiaomiSubmitClickResult = {
    clickedButton: false,
    clickedMenuAction: false,
    menuActionText: null,
    menuVisibleAfterButton: false
  }

  const configured = await findByConfiguredSelectors(page, config.buttons?.submit)
  const submitButton = configured ?? await findButtonByKeywords(page, ["\u53d1\u5e03", "\u63d0\u4ea4", "\u7acb\u5373\u520a\u767b", "submit", "publish"], config.buttons?.submit)
  if (!submitButton) {
    return result
  }

  await submitButton.click()
  result.clickedButton = true
  await page.waitForTimeout(350)

  const menuAction = await findSubmitMenuAction(page)
  result.menuVisibleAfterButton = (await visibleSubmitMenuRoots(page)).length > 0
  if (menuAction) {
    result.menuActionText = await readLocatorCompactText(menuAction)
    await menuAction.click()
    result.clickedMenuAction = true
    await page.waitForTimeout(500)
  }

  return result
}

const clickDianxiaomiSubmitMenuActionIfPresent = async (page: Page) => {
  const menuAction = await findSubmitMenuAction(page)
  const menuVisibleAfterButton = (await visibleSubmitMenuRoots(page)).length > 0
  if (!menuAction) {
    return {
      clickedMenuAction: false,
      menuActionText: null,
      menuVisibleAfterButton
    }
  }

  const menuActionText = await readLocatorCompactText(menuAction)
  await menuAction.click()
  await page.waitForTimeout(500)
  return {
    clickedMenuAction: true,
    menuActionText,
    menuVisibleAfterButton
  }
}

const SUBMIT_SUCCESS_KEYWORDS = [
  "发布成功",
  "提交成功",
  "刊登成功",
  "已提交",
  "已发布",
  "提交至平台",
  "审核中",
  "待审核",
  "核价",
  "success",
  "submitted",
  "published",
  "under review"
]

const SUBMIT_FAILURE_KEYWORDS = [
  "发布失败",
  "提交失败",
  "刊登失败",
  "失败",
  "错误",
  "异常",
  "请完善",
  "不能为空",
  "必填",
  "不符合",
  "校验",
  "重复",
  "超时",
  "error",
  "failed",
  "invalid",
  "required"
]

SUBMIT_SUCCESS_KEYWORDS.push(
  "\u53d1\u5e03\u6210\u529f",
  "\u63d0\u4ea4\u6210\u529f",
  "\u520a\u767b\u6210\u529f",
  "\u5df2\u63d0\u4ea4",
  "\u5df2\u53d1\u5e03",
  "\u63d0\u4ea4\u81f3\u5e73\u53f0",
  "\u5ba1\u6838\u4e2d",
  "\u5f85\u5ba1\u6838",
  "\u5f85\u6838\u4ef7",
  "\u6838\u4ef7",
  "\u4e0a\u67b6\u5ba1\u6838"
)

SUBMIT_FAILURE_KEYWORDS.push(
  "\u53d1\u5e03\u5931\u8d25",
  "\u63d0\u4ea4\u5931\u8d25",
  "\u520a\u767b\u5931\u8d25",
  "\u5931\u8d25",
  "\u9519\u8bef",
  "\u5f02\u5e38",
  "\u8bf7\u5b8c\u5584",
  "\u4e0d\u80fd\u4e3a\u7a7a",
  "\u5fc5\u586b",
  "\u4e0d\u7b26\u5408",
  "\u6821\u9a8c",
  "\u91cd\u590d",
  "\u8d85\u65f6",
  "\u8bf7\u9009\u62e9",
  "\u8bf7\u586b\u5199"
)

const WEAK_BODY_SUBMIT_FAILURE_KEYWORDS = new Set([
  "required",
  "\u8bf7\u5b8c\u5584",
  "\u4e0d\u80fd\u4e3a\u7a7a",
  "\u5fc5\u586b",
  "\u8bf7\u9009\u62e9",
  "\u8bf7\u586b\u5199"
].map((keyword) => keyword.toLowerCase()))

const SUBMIT_CONFIRM_KEYWORDS = [
  "确定",
  "确认",
  "继续",
  "发布",
  "提交",
  "立即发布",
  "立即提交",
  "ok",
  "confirm",
  "continue",
  "publish",
  "submit"
]

// P0-C: save-draft feedback keywords. Sourced from Dianxiaomi's typical toast
// / inline confirmation after clicking 保存草稿. Intentionally narrower than
// submit because the success surface is more local (no "submitted" / "under
// review" noise).
const SAVE_DRAFT_SUCCESS_KEYWORDS = [
  "保存成功",
  "已存为草稿",
  "草稿已保存",
  "已保存",
  "保存为草稿",
  "\u7f16\u8f91\u6210\u529f",
  "\u4ea7\u54c1\u7f16\u8f91\u6210\u529f",
  "\u60a8\u7684\u4ea7\u54c1\u7f16\u8f91\u6210\u529f",
  "draft saved",
  "saved as draft",
  "saved successfully",
  "save success"
]

const SAVE_DRAFT_FAILURE_KEYWORDS = [
  "保存失败",
  "草稿保存失败",
  "保存出错",
  "保存异常",
  "閿欒",
  "璇峰畬鍠?",
  "涓嶈兘涓虹┖",
  "蹇呭～",
  "璇烽€夋嫨",
  "璇峰～鍐?",
  "save failed",
  "draft save failed",
  "save error",
  "error",
  "required",
  "please select",
  "please fill"
]

SAVE_DRAFT_FAILURE_KEYWORDS.push(
  "\u9519\u8bef",
  "\u8bf7\u5b8c\u5584",
  "\u4e0d\u80fd\u4e3a\u7a7a",
  "\u5fc5\u586b",
  "\u8bf7\u9009\u62e9",
  "\u8bf7\u586b\u5199"
)

const WEAK_BODY_SAVE_DRAFT_FAILURE_KEYWORDS = new Set([
  "required",
  "please select",
  "please fill",
  "\u8bf7\u5b8c\u5584",
  "\u4e0d\u80fd\u4e3a\u7a7a",
  "\u5fc5\u586b",
  "\u8bf7\u9009\u62e9",
  "\u8bf7\u586b\u5199"
].map((keyword) => keyword.toLowerCase()))

const MEDIA_APPLY_SUCCESS_KEYWORDS = [
  "\u5904\u7406\u6210\u529f",
  "\u5e94\u7528\u6210\u529f",
  "\u4fdd\u5b58\u6210\u529f",
  "\u7ffb\u8bd1\u6210\u529f",
  "\u751f\u6210\u6210\u529f",
  "\u5df2\u751f\u6210",
  "\u6539\u56fe\u6210\u529f",
  "\u5df2\u5e94\u7528",
  "\u5df2\u4fdd\u5b58",
  "\u5df2\u5b8c\u6210",
  "\u5b8c\u6210",
  "success",
  "successful",
  "completed",
  "complete",
  "applied",
  "saved",
  "done"
]

const MEDIA_APPLY_FAILURE_KEYWORDS = [
  "\u5904\u7406\u5931\u8d25",
  "\u5e94\u7528\u5931\u8d25",
  "\u4fdd\u5b58\u5931\u8d25",
  "\u7ffb\u8bd1\u5931\u8d25",
  "\u6682\u4e0d\u53ef\u7528",
  "\u6682\u65f6\u4e0d\u53ef\u7528",
  "\u6682\u65e0\u53ef\u7528",
  "\u5931\u8d25",
  "\u9519\u8bef",
  "\u5f02\u5e38",
  "\u7f3a\u5c11",
  "\u65e0\u6548",
  "\u4e0d\u652f\u6301",
  "\u4e0d\u7b26\u5408",
  "\u8d85\u65f6",
  "\u751f\u6210\u5931\u8d25",
  "\u5c3a\u5bf8\u4e0d\u80fd",
  "\u4e0d\u80fd\u5c0f\u4e8e",
  "\u4e0d\u80fd\u5927\u4e8e",
  "\u592a\u5c0f",
  "\u592a\u5927",
  "\u56fe\u7247\u4e0d\u5408\u89c4",
  "\u5fc5\u586b",
  "failed",
  "failure",
  "error",
  "missing",
  "invalid",
  "unsupported",
  "timeout",
  "too large",
  "too small",
  "required"
]

const MEDIA_TRANSIENT_FAILURE_KEYWORDS = [
  "\u7a0d\u540e",
  "\u91cd\u8bd5",
  "\u7f51\u7edc",
  "\u7e41\u5fd9",
  "\u8bf7\u7a0d\u540e",
  "try again",
  "retry",
  "temporary",
  "temporarily",
  "busy",
  "network",
  "rate limit",
  "too many requests",
  "service unavailable"
]

const MEDIA_TRANSIENT_MAX_APPLY_ATTEMPTS = 3

const MEDIA_INVALID_FAILURE_KEYWORDS = [
  "\u65e0\u6548",
  "\u4e0d\u7b26\u5408",
  "\u4e0d\u5408\u89c4",
  "invalid",
  "too large",
  "too small"
]

const MEDIA_STORAGE_QUOTA_FAILURE_KEYWORDS = [
  "\u56fe\u7247\u7a7a\u95f4\u4e0d\u8db3",
  "\u7a7a\u95f4\u4e0d\u8db3",
  "\u6682\u65e0\u53ef\u7528\u56fe\u7247\u6570",
  "\u6682\u65e0\u53ef\u7528\u56fe\u7247\u7ffb\u8bd1\u6570",
  "\u6682\u65e0\u53ef\u7528\u6b21\u6570",
  "\u56fe\u7247\u7ffb\u8bd1\u529f\u80fd\u6682\u4e0d\u53ef\u7528",
  "\u7ffb\u8bd1\u529f\u80fd\u6682\u4e0d\u53ef\u7528",
  "\u56fe\u7247\u7ffb\u8bd1\u6682\u4e0d\u53ef\u7528",
  "\u6682\u4e0d\u53ef\u4f7f\u7528",
  "\u524d\u5f80\u5145\u503c",
  "\u8d2d\u4e70\u7a7a\u95f4",
  "image space",
  "storage quota",
  "temporarily unavailable",
  "translation unavailable",
  "quota exceeded",
  "insufficient storage"
]

const MEDIA_MISSING_INPUT_FAILURE_KEYWORDS = [
  "\u7f3a\u5c11",
  "\u5fc5\u586b",
  "missing",
  "required",
  "empty"
]

const MEDIA_UNSUPPORTED_FAILURE_KEYWORDS = [
  "\u4e0d\u652f\u6301",
  "unsupported",
  "not supported"
]

const IMAGE_TRANSLATION_QUOTA_PATTERN = /\u53ef\u7528\u56fe\u7247\u7ffb\u8bd1\u6570(?:\u91cf)?[:：]?\s*(\d+(?:\.\d+)?)/i

const extractImageTranslationQuotaCount = (text: string) => {
  const normalized = normalizeFeedbackText(text)
  const matched = normalized.match(IMAGE_TRANSLATION_QUOTA_PATTERN)
  if (!matched) {
    return null
  }

  const parsed = Number(matched[1])
  return Number.isFinite(parsed) ? parsed : null
}

const classifyMediaFailure = (message: string, fallback: MediaFailureKind = "unknown"): {
  failureKind: MediaFailureKind
  retryable: boolean
} => {
  const normalized = message.toLowerCase()
  const includesAny = (patterns: string[]) => patterns.some((pattern) => normalized.includes(pattern.toLowerCase()))

  if (includesAny(MEDIA_TRANSIENT_FAILURE_KEYWORDS)) {
    return {
      failureKind: "transient",
      retryable: true
    }
  }

  if (includesAny(MEDIA_INVALID_FAILURE_KEYWORDS)) {
    return {
      failureKind: "invalid-media",
      retryable: false
    }
  }

  if (includesAny(MEDIA_STORAGE_QUOTA_FAILURE_KEYWORDS)) {
    return {
      failureKind: "storage-quota",
      retryable: false
    }
  }

  if (includesAny(MEDIA_MISSING_INPUT_FAILURE_KEYWORDS)) {
    return {
      failureKind: "missing-input",
      retryable: false
    }
  }

  if (includesAny(MEDIA_UNSUPPORTED_FAILURE_KEYWORDS)) {
    return {
      failureKind: "unsupported",
      retryable: false
    }
  }

  return {
    failureKind: fallback,
    retryable: fallback === "unknown"
  }
}

const SUBMIT_FEEDBACK_SELECTORS = [
  "#submitStatus",
  "[id*='submitstatus' i]",
  "[id*='publishstatus' i]",
  "[role='alert']",
  "[aria-live]",
  ".ant-message",
  ".ant-notification",
  ".ant-alert",
  ".ant-form-item-explain-error",
  ".ant-form-item-extra",
  ".el-message",
  ".el-notification",
  ".el-form-item__error",
  ".toast",
  ".message",
  ".notification",
  ".notice",
  ".error",
  ".success",
  "[class*='toast' i]",
  "[class*='message' i]",
  "[class*='notification' i]",
  "[class*='notice' i]",
  "[class*='error' i]",
  "[class*='success' i]",
  "[class*='invalid' i]"
]

const normalizeFeedbackText = (value: string) =>
  value.replace(/\s+/g, " ").trim().slice(0, 500)

const variantSelectionMatchesTarget = (selectedText: string | null | undefined, targetText: string | null | undefined) => {
  if (!selectedText || !targetText) {
    return false
  }

  const normalizedSelected = normalizeText(selectedText)
  const normalizedTarget = normalizeText(targetText)
  if (normalizedSelected && normalizedTarget && normalizedSelected === normalizedTarget) {
    return true
  }

  const compactSelected = cleanVisibleText(selectedText).replace(/\s+/g, "")
  const compactTarget = cleanVisibleText(targetText).replace(/\s+/g, "")
  return Boolean(compactSelected && compactTarget && compactSelected === compactTarget)
}

const compactActionText = (value: string | null | undefined) =>
  cleanVisibleText(value).replace(/\s+/g, "")

const isColorSkcLimitSaveFailure = (message: string) => {
  const normalized = normalizeFeedbackText(message)
  return /20\s*个\s*颜色\s*skc/i.test(normalized)
    || (normalized.includes("颜色skc") && normalized.includes("20"))
    || (normalized.toLowerCase().includes("color skc") && normalized.includes("20"))
}

const isSiteWarehouseSaveFailure = (message: string) => {
  const normalized = normalizeFeedbackText(message)
  return normalized.includes(SITE_WAREHOUSE_REQUIRED_TEXT)
    || (normalized.includes(SITE_WAREHOUSE_LABEL_TEXT) && normalized.includes(SELECT_PLACEHOLDER_TEXT))
}

const isShipmentPromiseSaveFailure = (message: string) => {
  const normalized = normalizeFeedbackText(message)
  return normalized.includes(SHIPMENT_PROMISE_REQUIRED_TEXT)
    || normalized.includes(SHIPMENT_PROMISE_LABEL_TEXT)
}

const isFreightTemplateSaveFailure = (message: string) => {
  const normalized = normalizeFeedbackText(message)
  return normalized.includes(FREIGHT_TEMPLATE_REQUIRED_TEXT)
    || (normalized.includes(FREIGHT_TEMPLATE_LABEL_TEXT) && normalized.includes(SELECT_PLACEHOLDER_TEXT))
}

const keywordMatch = (text: string, keywords: string[]) => {
  const normalized = text.toLowerCase()
  return keywords.find((keyword) => normalized.includes(keyword.toLowerCase())) ?? null
}

const parseImageTranslationFeedback = (text: string) => {
  const normalized = normalizeFeedbackText(text)
  const resultMatch = normalized.match(IMAGE_TRANSLATION_RESULT_PATTERN)
  const statusMatch = normalized.match(IMAGE_TRANSLATION_STATUS_PATTERN)
  const successCount = resultMatch ? Number(resultMatch[1]) : null
  const failureCount = resultMatch ? Number(resultMatch[2]) : null
  const statusText = statusMatch?.[1] ?? ""
  const inProgress = statusText.includes("\u8fdb\u884c\u4e2d") || normalized.includes("\u8fdb\u884c\u4e2d")
  const mentionsTranslationSummary = successCount !== null || failureCount !== null || normalized.includes("\u7ffb\u8bd1\u6210\u529f") || normalized.includes("\u7ffb\u8bd1\u5931\u8d25")

  return {
    normalized,
    successCount,
    failureCount,
    statusText,
    inProgress,
    mentionsTranslationSummary
  }
}

const interpretImageTranslationFeedback = (texts: Array<{ source: string; text: string }>): MediaApplyFeedback | null => {
  for (const item of texts) {
    const parsed = parseImageTranslationFeedback(item.text)
    if (!parsed.mentionsTranslationSummary) {
      continue
    }

    if (parsed.successCount !== null && parsed.failureCount !== null) {
      if (parsed.inProgress) {
        return {
          state: "unknown",
          message: parsed.normalized,
          source: item.source
        }
      }

      if (parsed.failureCount === 0 && parsed.successCount >= 0) {
        return {
          state: "success",
          message: parsed.normalized,
          source: item.source
        }
      }

      return {
        state: "failure",
        message: parsed.normalized,
        source: item.source
      }
    }

    if (parsed.inProgress) {
      return {
        state: "unknown",
        message: parsed.normalized,
        source: item.source
      }
    }
  }

  return null
}

const interpretImageTranslationOverlayFeedback = async (page: Page): Promise<MediaApplyFeedback | null> => {
  const overlay = await getTopmostOverlayAboveImageTranslation(page)
  if (!overlay) {
    return null
  }

  const matchedFailureKeyword = keywordMatch(overlay.text, MEDIA_APPLY_FAILURE_KEYWORDS)
  const classifiedFailure = classifyMediaFailure(overlay.text, "unknown")
  if (matchedFailureKeyword || classifiedFailure.failureKind !== "unknown") {
    return {
      state: "failure",
      message: overlay.text,
      source: "translation-result-overlay"
    }
  }

  const overlayAction = await findInteractiveInRootByKeywords(overlay.dialog, IMAGE_TRANSLATION_RESULT_CONFIRM_KEYWORDS)
    ?? await findLastVisibleActionInRoot(overlay.dialog)
    ?? await findInteractiveInRootByKeywords(overlay.dialog, MEDIA_CLOSE_KEYWORDS)
  if (!overlayAction) {
    return null
  }

  return {
    state: "success",
    message: overlay.text || "image translation result confirmation is ready",
    source: "translation-result-overlay"
  }
}

const focusBodyFeedbackText = (text: string, matchedKeyword: string, source: string) => {
  if (source !== "body") {
    return text
  }

  const normalized = normalizeFeedbackText(text)
  const keywordIndex = normalized.toLowerCase().indexOf(matchedKeyword.toLowerCase())
  if (keywordIndex < 0) {
    return normalized
  }

  const boundaryChars = ".!?;。！？；"
  const searchStart = Math.max(0, keywordIndex - 80)
  let start = -1
  for (let index = keywordIndex - 1; index >= searchStart; index -= 1) {
    if (boundaryChars.includes(normalized[index])) {
      start = index + 1
      break
    }
  }

  if (start < 0) {
    start = Math.max(0, keywordIndex - 20)
  }

  const searchEnd = Math.min(normalized.length, keywordIndex + 180)
  let end = searchEnd
  for (let index = keywordIndex; index < searchEnd; index += 1) {
    if (boundaryChars.includes(normalized[index])) {
      end = index + 1
      break
    }
  }

  return normalizeFeedbackText(normalized.slice(start, end)) || normalized
}

const collectFeedbackTexts = async (page: Page) => {
  const texts: Array<{ source: string; text: string }> = []

  for (const selector of SUBMIT_FEEDBACK_SELECTORS) {
    const locator = page.locator(selector)
    const count = Math.min(await locator.count().catch(() => 0), 12)
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index)
      if (!await item.isVisible().catch(() => false)) {
        continue
      }

      const text = normalizeFeedbackText(await item.innerText().catch(() => ""))
      if (!text || text === "×") {
        continue
      }

      const className = await item.evaluate((element) => element.getAttribute("class") ?? "").catch(() => "")
      const normalizedClassName = className.toLowerCase()
      const genericSuccessSelector = selector === ".success" || selector === "[class*='success' i]"
      if (
        genericSuccessSelector
        && (
          normalizedClassName.includes("ant-form-item-has-success")
          || normalizedClassName.includes("ant-select-status-success")
          || (
            normalizedClassName.includes("success")
            && !/(message|toast|notification|notice|alert|status|result)/i.test(className)
          )
        )
      ) {
        continue
      }

      texts.push({
        source: selector,
        text
      })
    }
  }

  const bodyText = normalizeFeedbackText(await page.locator("body").innerText().catch(() => ""))
  if (bodyText) {
    texts.push({
      source: "body",
      text: bodyText
    })
  }

  return texts
}

const readSubmitFeedback = async (page: Page): Promise<SubmitFeedback> => {
  const latestModal = (await visibleAntModalLocators(page)).at(-1) ?? null
  if (latestModal) {
    const modalText = normalizeFeedbackText(await latestModal.innerText().catch(() => ""))
    const modalFailureKeyword = keywordMatch(modalText, SUBMIT_FAILURE_KEYWORDS)
    if (modalFailureKeyword) {
      return {
        state: "failure",
        message: modalText,
        source: "ant-modal"
      }
    }

    const modalSuccessKeyword = keywordMatch(modalText, SUBMIT_SUCCESS_KEYWORDS)
    if (modalSuccessKeyword) {
      return {
        state: "success",
        message: modalText,
        source: "ant-modal"
      }
    }
  }

  const texts = await collectFeedbackTexts(page)

  for (const item of texts) {
    const matchedKeyword = keywordMatch(item.text, SUBMIT_FAILURE_KEYWORDS)
    if (matchedKeyword) {
      if (item.source === "body" && WEAK_BODY_SUBMIT_FAILURE_KEYWORDS.has(matchedKeyword.toLowerCase())) {
        continue
      }

      return {
        state: "failure",
        message: focusBodyFeedbackText(item.text, matchedKeyword, item.source),
        source: item.source
      }
    }
  }

  for (const item of texts) {
    const matchedKeyword = keywordMatch(item.text, SUBMIT_SUCCESS_KEYWORDS)
    if (matchedKeyword) {
      return {
        state: "success",
        message: focusBodyFeedbackText(item.text, matchedKeyword, item.source),
        source: item.source
      }
    }
  }

  return {
    state: "unknown",
    message: texts[0]?.text ?? "",
    source: texts[0]?.source ?? "none"
  }
}

const sameSubmitFeedback = (left: SubmitFeedback, right: SubmitFeedback | null | undefined) =>
  Boolean(right)
  && left.state === right?.state
  && left.source === right?.source
  && left.message === right?.message

// P0-C: page-body feedback reader for save-draft. Reuses the same selector
// set as submit (toast / alert / message classes) but matches against
// save-draft-specific keywords so the two feedback surfaces don't false-
// trigger each other.
const readSaveDraftFeedback = async (page: Page): Promise<SubmitFeedback> => {
  const latestModal = (await visibleAntModalLocators(page)).at(-1) ?? null
  if (latestModal) {
    const modalText = normalizeFeedbackText(await latestModal.innerText().catch(() => ""))
    const modalFailureKeyword = keywordMatch(modalText, SAVE_DRAFT_FAILURE_KEYWORDS)
    if (modalFailureKeyword) {
      return {
        state: "failure",
        message: modalText,
        source: "ant-modal"
      }
    }

    const modalSuccessKeyword = keywordMatch(modalText, SAVE_DRAFT_SUCCESS_KEYWORDS)
    if (modalSuccessKeyword) {
      return {
        state: "success",
        message: modalText,
        source: "ant-modal"
      }
    }
  }

  const texts = await collectFeedbackTexts(page)

  for (const item of texts) {
    const matchedKeyword = keywordMatch(item.text, SAVE_DRAFT_FAILURE_KEYWORDS)
    if (matchedKeyword) {
      if (item.source === "body" && WEAK_BODY_SAVE_DRAFT_FAILURE_KEYWORDS.has(matchedKeyword.toLowerCase())) {
        continue
      }

      return {
        state: "failure",
        message: focusBodyFeedbackText(item.text, matchedKeyword, item.source),
        source: item.source
      }
    }
  }

  for (const item of texts) {
    const matchedKeyword = keywordMatch(item.text, SAVE_DRAFT_SUCCESS_KEYWORDS)
    if (matchedKeyword) {
      return {
        state: "success",
        message: focusBodyFeedbackText(item.text, matchedKeyword, item.source),
        source: item.source
      }
    }
  }

  return {
    state: "unknown",
    message: texts[0]?.text ?? "",
    source: texts[0]?.source ?? "none"
  }
}

const sameSaveDraftFeedback = (left: SubmitFeedback, right: SubmitFeedback | null | undefined) =>
  Boolean(right)
  && left.state === right?.state
  && left.source === right?.source
  && left.message === right?.message

const waitForSaveDraftFeedback = async (
  page: Page,
  timeoutMs = 8_000,
  previousFeedback?: SubmitFeedback | null,
  duplicateFailureGraceMs = 2_500
): Promise<SubmitFeedback> => {
  const startedAt = Date.now()
  let latest: SubmitFeedback = {
    state: "unknown",
    message: "",
    source: "none"
  }

  while (Date.now() - startedAt < timeoutMs) {
    latest = await readSaveDraftFeedback(page)
    if (latest.state !== "unknown") {
      if (!sameSaveDraftFeedback(latest, previousFeedback) || Date.now() - startedAt >= duplicateFailureGraceMs) {
        return latest
      }
    }

    await page.waitForTimeout(500)
  }

  return latest
}

// P0-D: feedback reader for instant-action tools (image-translation,
// image-management). Operates on the page body only — no dialog root — and
// matches against MEDIA_INSTANT_*_KEYWORDS so the surface is scoped to
// instant actions and won't false-trigger on submit / save-draft keywords.
const COLLECT_PAGE_VALIDATION_SUMMARY_SCRIPT = `(() => {
  const normalize = (value) => (value ?? "").replace(/\\s+/g, " ").trim()
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false
    }

    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
  }

  const rectOf = (element) => {
    const rect = element.getBoundingClientRect()
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  }

  const issues = Array.from(document.querySelectorAll(".ant-form-item-has-error, .el-form-item.is-error"))
    .filter(isVisible)
    .slice(0, 200)
    .map((item) => ({
      label: normalize(item.querySelector(".ant-form-item-label, .el-form-item__label")?.textContent),
      text: normalize(item.textContent).slice(0, 400),
      explain: Array.from(item.querySelectorAll(".ant-form-item-explain-error, .el-form-item__error"))
        .filter(isVisible)
        .map((node) => normalize(node.textContent))
        .filter(Boolean)
        .slice(0, 8),
      inputs: Array.from(item.querySelectorAll("input, textarea"))
        .filter(isVisible)
        .slice(0, 10)
        .map((node) => ({
          name: normalize(node.getAttribute("name")),
          placeholder: normalize(node.getAttribute("placeholder")),
          value: normalize(node.value),
          className: normalize(node.getAttribute("class"))
        })),
      selects: Array.from(item.querySelectorAll(".ant-select"))
        .filter(isVisible)
        .slice(0, 6)
        .map((node) => normalize(node.textContent))
        .filter(Boolean),
      rect: rectOf(item)
    }))

  const warningTexts = Array.from(document.querySelectorAll("body *"))
    .filter(isVisible)
    .map((node) => normalize(node.textContent))
    .filter((text) =>
      Boolean(text)
      && text.length <= 160
      && (
        text.includes("请选择")
        || text.includes("请填写")
        || text.includes("不能包含中文")
        || text.includes("含有中文")
        || text.includes("错误")
        || text.includes("请检查")
        || text.includes("必填")
      )
    )
    .slice(0, 120)

  const toastTexts = Array.from(document.querySelectorAll(".ant-message, .ant-notification, [class*='message' i], [class*='notification' i]"))
    .filter(isVisible)
    .map((node) => normalize(node.textContent))
    .filter(Boolean)
    .slice(0, 20)

  return {
    issueCount: issues.length,
    issues,
    warningTexts,
    toastTexts
  }
})()`

const collectPageValidationSummary = async (page: Page): Promise<PageValidationSummary> =>
  page.evaluate(COLLECT_PAGE_VALIDATION_SUMMARY_SCRIPT) as Promise<PageValidationSummary>

const SAVE_SUCCESS_MODAL_HINT_KEYWORDS = [
  "\u6d88\u606f\u63d0\u793a",
  "\u4ea7\u54c1\u7f16\u8f91\u6210\u529f",
  "\u60a8\u7684\u4ea7\u54c1\u7f16\u8f91\u6210\u529f",
  "\u521b\u5efa\u65b0\u4ea7\u54c1",
  "\u7ee7\u7eed\u7f16\u8f91",
  "message",
  "success",
  "continue editing"
]

const dismissSaveSuccessModalIfPresent = async (page: Page) => {
  const dialogs = await visibleModalCandidates(page)
  let dialog: Locator | null = null
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const candidate = dialogs[index]
    const text = normalizeFeedbackText(await candidate.innerText().catch(() => ""))
    if (
      keywordMatch(text, [...SAVE_DRAFT_SUCCESS_KEYWORDS, ...SUBMIT_SUCCESS_KEYWORDS])
      || keywordMatch(text, SAVE_SUCCESS_MODAL_HINT_KEYWORDS)
    ) {
      dialog = candidate
      break
    }
  }
  if (!dialog) {
    return {
      matched: false,
      dismissed: false,
      dialogText: ""
    }
  }

  const dialogText = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
  if (
    !keywordMatch(dialogText, [...SAVE_DRAFT_SUCCESS_KEYWORDS, ...SUBMIT_SUCCESS_KEYWORDS])
    && !keywordMatch(dialogText, SAVE_SUCCESS_MODAL_HINT_KEYWORDS)
  ) {
    return {
      matched: false,
      dismissed: false,
      dialogText
    }
  }

  const dismissalAction = await findInteractiveInRootByKeywords(dialog, [
    "\u7ee7\u7eed\u7f16\u8f91",
    "\u786e\u5b9a",
    "\u786e\u8ba4",
    "continue",
    "ok",
    "confirm"
  ]) ?? await firstVisible([
    dialog.locator("[aria-label*='close' i]"),
    dialog.locator("[title*='close' i]"),
    dialog.locator(".ant-modal-close, .el-dialog__headerbtn, .modal-close, [class*='close' i]")
  ]) ?? await findLastVisibleActionInRoot(dialog)
  if (!dismissalAction) {
    return {
      matched: true,
      dismissed: false,
      dialogText
    }
  }

  const baselineDialogCount = Math.max(0, dialogs.length - 1)
  await clickAfterDianxiaomiIdle(page, dismissalAction, 1)
  return {
    matched: true,
    dismissed: await waitForVisibleModalCandidateCountAtMost(page, baselineDialogCount, 5_000),
    dialogText
  }
}

const readInstantActionFeedback = async (page: Page): Promise<SubmitFeedback> => {
  const texts = await collectFeedbackTexts(page)

  for (const item of texts) {
    const matchedKeyword = keywordMatch(item.text, MEDIA_INSTANT_FAILURE_KEYWORDS)
    if (matchedKeyword) {
      return {
        state: "failure",
        message: focusBodyFeedbackText(item.text, matchedKeyword, item.source),
        source: item.source
      }
    }
  }

  for (const item of texts) {
    const matchedKeyword = keywordMatch(item.text, MEDIA_INSTANT_SUCCESS_KEYWORDS)
    if (matchedKeyword) {
      return {
        state: "success",
        message: focusBodyFeedbackText(item.text, matchedKeyword, item.source),
        source: item.source
      }
    }
  }

  return {
    state: "unknown",
    message: texts[0]?.text ?? "",
    source: texts[0]?.source ?? "none"
  }
}

const uniqueImageCheckIssues = (issues: ImageCheckIssue[]) => {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.category.toLowerCase()}::${issue.issue.toLowerCase()}::${(issue.detail ?? "").toLowerCase()}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

const extractImageCheckIssues = (message: string): ImageCheckIssue[] =>
  extractDianxiaomiImageCheckIssues(normalizeFeedbackText(message))

const extractPositiveImageCheckSummaryIssues = (message: string): ImageCheckIssue[] =>
  parseDianxiaomiImageCheckSummary(normalizeFeedbackText(message))

const isSameImageCheckIssue = (left: ImageCheckIssue, right: ImageCheckIssue) =>
  cleanVisibleText(left.category).toLowerCase() === cleanVisibleText(right.category).toLowerCase()
  && cleanVisibleText(left.issue).toLowerCase() === cleanVisibleText(right.issue).toLowerCase()

const filterRequestedImageCheckIssuesBySummary = (
  requestedIssues: ImageCheckIssue[],
  surfacedIssues: ImageCheckIssue[]
) => {
  if (requestedIssues.length === 0 || surfacedIssues.length === 0) {
    return [] as ImageCheckIssue[]
  }

  return uniqueImageCheckIssues(
    requestedIssues.filter((requestedIssue) =>
      surfacedIssues.some((surfacedIssue) => isSameImageCheckIssue(requestedIssue, surfacedIssue))
    )
  )
}

const waitForInstantActionFeedback = async (
  page: Page,
  timeoutMs = 8_000
): Promise<SubmitFeedback> => {
  const startedAt = Date.now()
  let latest: SubmitFeedback = {
    state: "unknown",
    message: "",
    source: "none"
  }

  while (Date.now() - startedAt < timeoutMs) {
    latest = await readInstantActionFeedback(page)
    if (latest.state !== "unknown") {
      return latest
    }

    await page.waitForTimeout(500)
  }

  return latest
}

// P0-F: probe the listing's visible <img> elements to produce a small
// signature. Two probes return equal iff nothing in the listing image DOM
// changed. Used as hard evidence for instant-action tools and as soft
// evidence (recorded, not enforced) for dialog-based tools.
const LISTING_IMAGE_SELECTOR = [
  "img[class*='product' i]",
  "img[class*='main' i]",
  "img[class*='sku' i]",
  "img[class*='variant' i]",
  "img[class*='gallery' i]",
  "img[class*='detail' i]"
].join(", ")

const collectImageSignature = async (page: Page): Promise<string> => {
  const signature: string[] = []
  try {
    const images = page.locator(LISTING_IMAGE_SELECTOR)
    const count = Math.min(await images.count().catch(() => 0), 80)
    for (let index = 0; index < count; index += 1) {
      const image = images.nth(index)
      if (!await image.isVisible().catch(() => false)) {
        continue
      }
      const src = await image.getAttribute("src").catch(() => "")
      const naturalWidth = await image.evaluate((element) => (element as HTMLImageElement).naturalWidth).catch(() => 0)
      const naturalHeight = await image.evaluate((element) => (element as HTMLImageElement).naturalHeight).catch(() => 0)
      if (!src && naturalWidth === 0 && naturalHeight === 0) {
        continue
      }
      signature.push(`${src}|${naturalWidth}x${naturalHeight}`)
    }
  } catch {
    // best-effort probe; an empty signature is still usable for comparison
  }
  return signature.join(";")
}

const readMediaApplyFeedback = async (
  page: Page,
  root: Locator | null,
  toolId?: MediaToolDefinition["id"]
): Promise<MediaApplyFeedback> => {
  const texts = [
    ...(root
      ? [{
          source: "media-surface",
          text: normalizeFeedbackText(await root.innerText().catch(() => ""))
        }].filter((item) => item.text)
      : []),
    ...await collectFeedbackTexts(page)
  ]

  if (toolId === "image-translation") {
    const overlayFeedback = await interpretImageTranslationOverlayFeedback(page)
    if (overlayFeedback) {
      return overlayFeedback
    }

    const translationFeedback = interpretImageTranslationFeedback(texts)
    if (translationFeedback) {
      return translationFeedback
    }
  }

  for (const item of texts) {
    const matchedFailureKeyword = keywordMatch(item.text, MEDIA_APPLY_FAILURE_KEYWORDS)
    if (matchedFailureKeyword) {
      if (
        toolId === "image-translation"
        && matchedFailureKeyword === "\u7ffb\u8bd1\u5931\u8d25"
        && parseImageTranslationFeedback(item.text).failureCount === 0
      ) {
        continue
      }

      return {
        state: "failure",
        message: item.text,
        source: item.source
      }
    }
  }

  for (const item of texts) {
    if (keywordMatch(item.text, MEDIA_APPLY_SUCCESS_KEYWORDS)) {
      return {
        state: "success",
        message: item.text,
        source: item.source
      }
    }
  }

  return {
    state: "unknown",
    message: texts[0]?.text ?? "",
    source: texts[0]?.source ?? "none"
  }
}

const sameMediaApplyFeedback = (left: MediaApplyFeedback, right: MediaApplyFeedback | null | undefined) =>
  Boolean(right)
  && left.state === right?.state
  && left.source === right?.source
  && left.message === right?.message

const waitForMediaApplyFeedback = async (
  page: Page,
  root: Locator | null,
  timeoutMs = 8_000,
  toolId?: MediaToolDefinition["id"],
  previousFeedback?: MediaApplyFeedback | null,
  duplicateFeedbackGraceMs = 2_500
): Promise<MediaApplyFeedback> => {
  const startedAt = Date.now()
  let latest: MediaApplyFeedback = {
    state: "unknown",
    message: "",
    source: "none"
  }

  while (Date.now() - startedAt < timeoutMs) {
    latest = await readMediaApplyFeedback(page, root, toolId)
    if (latest.state !== "unknown") {
      if (!sameMediaApplyFeedback(latest, previousFeedback) || Date.now() - startedAt >= duplicateFeedbackGraceMs) {
        return latest
      }
    }

    await page.waitForTimeout(500)
  }

  return latest
}

const waitForImageTranslationSubmissionSignal = async (
  page: Page,
  root: Locator | null,
  previousQuota: number | null,
  timeoutMs = 8_000
): Promise<MediaApplyFeedback | null> => {
  if (!root || previousQuota === null) {
    return null
  }

  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const text = normalizeFeedbackText(await root.innerText().catch(() => ""))
    const nextQuota = extractImageTranslationQuotaCount(text)
    if (nextQuota !== null && nextQuota < previousQuota) {
      return {
        state: "success",
        message: `image translation quota decreased: ${previousQuota} -> ${nextQuota}`,
        source: "media-quota"
      }
    }

    await page.waitForTimeout(500)
  }

  return null
}

const shouldWaitForImageTranslationResultDialog = (feedback: MediaApplyFeedback) => {
  if (feedback.state === "failure") {
    return false
  }

  const message = normalizeFeedbackText(feedback.message || "")
  const parsed = parseImageTranslationFeedback(message)
  if (parsed.inProgress) {
    return true
  }

  if (feedback.source === "translation-result-overlay" || feedback.source === "translation-result-dialog") {
    return true
  }

  return Boolean(keywordMatch(message, IMAGE_TRANSLATION_RESULT_DIALOG_HINTS))
    || Boolean(keywordMatch(message, IMAGE_TRANSLATION_RESULT_READY_KEYWORDS))
}

const waitForImageTranslationResultDialog = async (
  page: Page,
  timeoutMs = IMAGE_TRANSLATION_COMPLETION_TIMEOUT_MS
): Promise<MediaApplyFeedback | null> => {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const dialog = await getLatestImageTranslationDialog(page)
    if (dialog) {
      const text = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
      const parsed = parseImageTranslationFeedback(text)

      if (
        (parsed.successCount !== null && parsed.failureCount !== null && !parsed.inProgress)
        || keywordMatch(text, IMAGE_TRANSLATION_RESULT_READY_KEYWORDS)
      ) {
        if (parsed.failureCount !== null && parsed.failureCount > 0) {
          return {
            state: "failure",
            message: text,
            source: "translation-result-dialog"
          }
        }

        return {
          state: "success",
          message: text,
          source: "translation-result-dialog"
        }
      }

      if (
        keywordMatch(text, IMAGE_TRANSLATION_RESULT_DIALOG_HINTS)
        && await findImageTranslationResultAction(dialog)
      ) {
        return {
          state: "success",
          message: text,
          source: "translation-result-dialog"
        }
      }
    }

    const overlay = await getTopmostOverlayAboveImageTranslation(page)
    if (overlay) {
      const matchedFailureKeyword = keywordMatch(overlay.text, MEDIA_APPLY_FAILURE_KEYWORDS)
      if (matchedFailureKeyword) {
        return {
          state: "failure",
          message: overlay.text,
          source: "translation-result-overlay"
        }
      }

      const overlayAction = await findInteractiveInRootByKeywords(overlay.dialog, IMAGE_TRANSLATION_RESULT_CONFIRM_KEYWORDS)
        ?? await findImageTranslationResultAction(overlay.dialog)
        ?? await findInteractiveInRootByKeywords(overlay.dialog, MEDIA_CLOSE_KEYWORDS)
      if (overlayAction) {
        return {
          state: "success",
          message: overlay.text || "image translation result confirmation is ready",
          source: "translation-result-overlay"
        }
      }
    }

    await page.waitForTimeout(1000)
  }

  return null
}

const waitForSubmitFeedback = async (
  page: Page,
  timeoutMs = 12_000,
  previousFeedback?: SubmitFeedback | null,
  duplicateFailureGraceMs = 2_500,
  duplicateSuccessGraceMs = 2_500
): Promise<SubmitFeedback> => {
  const startedAt = Date.now()
  let latest: SubmitFeedback = {
    state: "unknown",
    message: "",
    source: "none"
  }

  while (Date.now() - startedAt < timeoutMs) {
    latest = await readSubmitFeedback(page)
    if (latest.state !== "unknown") {
      if (!sameSubmitFeedback(latest, previousFeedback)) {
        return latest
      }

      if (latest.state === "failure" && Date.now() - startedAt >= duplicateFailureGraceMs) {
        return latest
      }

      if (latest.state === "success" && Date.now() - startedAt >= duplicateSuccessGraceMs) {
        return {
          state: "unknown",
          message: latest.message,
          source: latest.source
        }
      }
    }

    await page.waitForTimeout(500)
  }
  return latest
}

const clickSubmitConfirmIfPresent = async (page: Page) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const dialogs = await visibleDialogLocators(page)
    const root = dialogs[dialogs.length - 1]
    if (!root) {
      return false
    }

    const button = await findInteractiveInRootByKeywords(root, SUBMIT_CONFIRM_KEYWORDS)
    if (button && await button.isVisible().catch(() => false)) {
      await button.click()
      return true
    }

    await page.waitForTimeout(500)
  }

  return false
}

const runSubmitAttempt = async (
  page: Page,
  config: DianxiaomiSelectorConfig,
  attempt: number,
  editPageTarget?: { productId: string; editUrl: string } | null
): Promise<SubmitAttemptResult> => {
  // Observed live: a submit click (or a stray confirm click) can navigate off
  // the edit page entirely (product list / ERP home) — later attempts then
  // search a page that has no submit button. Steer back to the edit page
  // before doing anything else.
  if (editPageTarget && dianxiaomiProductIdFromUrl(page.url()) !== editPageTarget.productId) {
    console.log(`submit attempt ${attempt}: page drifted to ${page.url()}; navigating back to the edit page`)
    await page.goto(editPageTarget.editUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined)
    await page.waitForTimeout(2_500)
  }

  // The 运营公告 notice modal (and any leftover success dialog) overlays a
  // freshly loaded edit page and intercepts pointer events — the submit click
  // then times out ("locator resolved ... attempting click action"). Clear
  // blocking dialogs before reading feedback and clicking, mirroring the
  // save-draft attempt path.
  await dismissStartupModalIfPresent(page)
  await dismissSaveSuccessModalIfPresent(page)
  const dialogsBeforeClick = await getPageSafetyState(page)
  if (dialogsBeforeClick.visibleDialogCount > 0) {
    await closeMediaSurfaceStackToBaseline(page, 0, config)
    await dismissSaveSuccessModalIfPresent(page)
  }

  const previousFeedback = await readSubmitFeedback(page)
  // Observed live: the 发布 click can throw a Playwright timeout when a
  // confirm/result dialog (vcDialogTitle5) opens mid-click and intercepts the
  // retry — yet the submission still went out (dxmOfflineState flipped to
  // publishing). Don't crash the stage on that timeout; fall through to the
  // confirm click + feedback read, and let the edit.json publish verdict
  // decide the truth.
  let submitClick: Awaited<ReturnType<typeof clickDianxiaomiSubmitAction>>
  try {
    submitClick = await clickDianxiaomiSubmitAction(page, config)
  } catch (error) {
    console.warn(`submit click threw (treating as ambiguous, verifying via feedback/edit.json): ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
    submitClick = {
      clickedButton: true,
      clickedMenuAction: false,
      menuActionText: null,
      menuVisibleAfterButton: false
    }
  }

  if (!submitClick.clickedButton) {
    return {
      attempt,
      clickedSubmit: false,
      clickedSubmitMenuAction: false,
      clickedConfirm: false,
      feedbackChanged: false,
      state: "failure",
      message: "未找到店小秘发布/提交按钮",
      source: "submit-button",
      submitMenuActionText: null
    }
  }

  await page.waitForTimeout(800)
  const clickedConfirm = await clickSubmitConfirmIfPresent(page)
  const feedback = await waitForSubmitFeedback(page, 12_000, previousFeedback)

  return {
    attempt,
    clickedSubmit: submitClick.clickedButton,
    clickedSubmitMenuAction: submitClick.clickedMenuAction,
    clickedConfirm,
    feedbackChanged: feedback.state !== "unknown" && !sameSubmitFeedback(feedback, previousFeedback),
    submitMenuActionText: submitClick.menuActionText,
    ...feedback
  }
}

// P0-F3: the Dianxiaomi acceptance dialog after a submission reads「产品已提交
// 发布，请在「发布中」、「发布失败」或「在线产品」中查看！」— it enumerates tab
// NAMES, so the failure-keyword matcher misreads it as a failure, and trusting
// it as success is equally wrong (the store accepting a submission says nothing
// about Temu's publish verdict; see the publishFail-with-toast incident). Treat
// it as "submission accepted", then read the REAL verdict from edit.json
// (dxmOfflineState / errMsg).
const SUBMIT_ACCEPTED_TOAST_PATTERN = /已提交发布/
const PUBLISH_FAIL_STATE = "publishFail"
// States that prove the submission entered Temu's publish pipeline. A product
// sitting at waitPublish has merely been saved/queued locally — observed live:
// a 发布 click that failed to register left the item at offline/waitPublish
// for 40+ minutes, while a real submission moves it to publishing within
// seconds (then publishSuccess/publishFail).
const PUBLISH_PIPELINE_STATES = new Set(["publishing", "publishSuccess", PUBLISH_FAIL_STATE])
const PUBLISH_STATE_POLL_INTERVAL_MS = 5_000
const PUBLISH_STATE_POLL_TIMEOUT_MS = 90_000

type DianxiaomiPublishStateSnapshot = {
  available: boolean
  dxmState: string | null
  dxmOfflineState: string | null
  errMsg: string | null
}

const dianxiaomiProductIdFromUrl = (value: string): string | null => {
  try {
    return toNonEmptyText(new URL(value).searchParams.get("id"))
  } catch {
    return null
  }
}

const readDianxiaomiPublishState = async (page: Page, productIdOverride?: string | null): Promise<DianxiaomiPublishStateSnapshot> => {
  const unavailable: DianxiaomiPublishStateSnapshot = {
    available: false,
    dxmState: null,
    dxmOfflineState: null,
    errMsg: null
  }
  // A successful submit navigates away from the edit page (page.url() loses
  // the id param), so callers capture the product id up front and pass it in.
  const productId = productIdOverride ?? dianxiaomiProductIdFromUrl(page.url())
  if (!productId) {
    return unavailable
  }

  try {
    const response = await page.context().request.get(
      `https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${productId}`
    )
    if (!response.ok()) {
      return unavailable
    }
    const payload = await response.json().catch(() => null) as {
      data?: { product?: Record<string, unknown> }
    } | null
    const product = payload?.data?.product
    if (!product || typeof product !== "object") {
      return unavailable
    }
    return {
      available: true,
      dxmState: toNonEmptyText(product.dxmState),
      dxmOfflineState: toNonEmptyText(product.dxmOfflineState),
      errMsg: toNonEmptyText(product.errMsg)
    }
  } catch {
    return unavailable
  }
}

type DianxiaomiPublishOutcome = {
  verdict: "publish-fail" | "no-fail-detected" | "unverifiable"
  baseline: DianxiaomiPublishStateSnapshot
  final: DianxiaomiPublishStateSnapshot
  observedChange: boolean
  polls: number
}

const sameDianxiaomiPublishState = (left: DianxiaomiPublishStateSnapshot, right: DianxiaomiPublishStateSnapshot) =>
  left.dxmState === right.dxmState
  && left.dxmOfflineState === right.dxmOfflineState
  && left.errMsg === right.errMsg

// Short poll for ANY publish-state transition away from the pre-submit
// baseline. Observed live: clicking 发布+确认 navigates to the product list
// (no toast readable, submit button gone) while the product moves
// draft → offline/waitPublish — the state change is the only reliable
// evidence the submission registered.
const waitForDianxiaomiPublishStateChange = async (
  page: Page,
  productId: string | null,
  baseline: DianxiaomiPublishStateSnapshot,
  timeoutMs: number
): Promise<{ changed: boolean; current: DianxiaomiPublishStateSnapshot }> => {
  const startedAt = Date.now()
  let current: DianxiaomiPublishStateSnapshot = {
    available: false,
    dxmState: null,
    dxmOfflineState: null,
    errMsg: null
  }
  if (!baseline.available) {
    return { changed: false, current }
  }
  while (Date.now() - startedAt < timeoutMs) {
    current = await readDianxiaomiPublishState(page, productId)
    if (current.available && !sameDianxiaomiPublishState(current, baseline)) {
      return { changed: true, current }
    }
    await page.waitForTimeout(2_500)
  }
  return { changed: false, current }
}

const waitForDianxiaomiPublishOutcome = async (
  page: Page,
  baseline: DianxiaomiPublishStateSnapshot,
  productId: string | null,
  timeoutMs = PUBLISH_STATE_POLL_TIMEOUT_MS
): Promise<DianxiaomiPublishOutcome> => {
  const startedAt = Date.now()
  let final: DianxiaomiPublishStateSnapshot = {
    available: false,
    dxmState: null,
    dxmOfflineState: null,
    errMsg: null
  }
  let observedChange = false
  let polls = 0

  while (Date.now() - startedAt < timeoutMs) {
    const current = await readDianxiaomiPublishState(page, productId)
    polls += 1
    if (current.available) {
      if (
        baseline.available
        && (
          current.dxmOfflineState !== baseline.dxmOfflineState
          || current.errMsg !== baseline.errMsg
          || current.dxmState !== baseline.dxmState
        )
      ) {
        observedChange = true
      }
      final = current
      // Fresh failure = publishFail that differs from the pre-submit baseline,
      // OR one we watched the state transition into (observed live:
      // publishFail → publishing → publishFail with an identical errMsg).
      const freshFailure = current.dxmOfflineState === PUBLISH_FAIL_STATE
        && (
          observedChange
          || !baseline.available
          || baseline.dxmOfflineState !== PUBLISH_FAIL_STATE
          || current.errMsg !== baseline.errMsg
        )
      if (freshFailure || current.dxmState === "online" || current.dxmOfflineState === "publishSuccess") {
        break
      }
    }
    await page.waitForTimeout(PUBLISH_STATE_POLL_INTERVAL_MS)
  }

  if (!final.available) {
    return { verdict: "unverifiable", baseline, final, observedChange, polls }
  }
  // Conservative: any publishFail at the end of the window is a failure, even
  // when it matches a stale baseline — a false "blocked" beats a false success
  // that leaves the item sitting silently in the 发布失败 tab. And "no fail"
  // alone is not success evidence: an item stuck at waitPublish for the whole
  // window never entered Temu's pipeline, so the submission cannot be called
  // verified.
  const verdict: DianxiaomiPublishOutcome["verdict"] = final.dxmOfflineState === PUBLISH_FAIL_STATE
    ? "publish-fail"
    : (
      observedChange
      || final.dxmState === "online"
      || PUBLISH_PIPELINE_STATES.has(final.dxmOfflineState ?? "")
    )
      ? "no-fail-detected"
      : "unverifiable"
  return {
    verdict,
    baseline,
    final,
    observedChange,
    polls
  }
}

const submitListingWithVerification = async (
  page: Page,
  config: DianxiaomiSelectorConfig,
  options: RunnerOptions
) => {
  const attempts: SubmitAttemptResult[] = []
  const maxAttempts = Math.max(1, Math.min(10, options.submitMaxAttempts))
  // Capture the product id BEFORE clicking: a successful submit navigates to
  // the product list page, so page.url() loses the ?id= afterwards.
  const productId = dianxiaomiProductIdFromUrl(page.url())
    ?? dianxiaomiProductIdFromUrl(options.targetUrl ?? "")
  const editPageTarget = productId
    ? { productId, editUrl: `https://www.dianxiaomi.com/web/popTemu/edit?id=${productId}` }
    : null
  const baselinePublishState = await readDianxiaomiPublishState(page, productId)

  const resolveAcceptedSubmission = async (acceptMessage: string) => {
    const dismissal = await dismissSaveSuccessModalIfPresent(page)
    const publishOutcome = await waitForDianxiaomiPublishOutcome(page, baselinePublishState, productId)
    console.log(`submit-listing publish verdict: ${publishOutcome.verdict} (state=${publishOutcome.final.dxmOfflineState ?? publishOutcome.final.dxmState ?? "unknown"})`)

    if (publishOutcome.verdict === "publish-fail") {
      return stepResult(
        "submit-listing",
        "Submit listing",
        "failed",
        `Dianxiaomi accepted the submission but Temu publish failed: ${publishOutcome.final.errMsg ?? PUBLISH_FAIL_STATE}`,
        {
          attempts,
          maxAttempts,
          success: false,
          verified: true,
          submissionAccepted: true,
          publishOutcome,
          dismissedSuccessModal: dismissal.dismissed,
          matchedSuccessModal: dismissal.matched,
          successModalText: dismissal.dialogText || null
        }
      )
    }

    if (publishOutcome.verdict === "unverifiable") {
      return stepResult(
        "submit-listing",
        "Submit listing",
        "failed",
        `Dianxiaomi appeared to accept the submission but the publish state never entered Temu's pipeline (stuck at ${publishOutcome.final.dxmOfflineState ?? publishOutcome.final.dxmState ?? "unknown"}); treating the submission as not registered`,
        {
          attempts,
          maxAttempts,
          success: false,
          verified: false,
          submissionAccepted: true,
          publishOutcome,
          dismissedSuccessModal: dismissal.dismissed,
          matchedSuccessModal: dismissal.matched,
          successModalText: dismissal.dialogText || null
        }
      )
    }

    return stepResult(
      "submit-listing",
      "Submit listing",
      "done",
      `Dianxiaomi submit succeeded: ${acceptMessage || "success"} (publish state: ${publishOutcome.final.dxmOfflineState ?? publishOutcome.final.dxmState ?? "unknown"})`,
      {
        attempts,
        maxAttempts,
        success: true,
        verified: true,
        submissionAccepted: true,
        publishOutcome,
        dismissedSuccessModal: dismissal.dismissed,
        matchedSuccessModal: dismissal.matched,
        successModalText: dismissal.dialogText || null
      }
    )
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runSubmitAttempt(page, config, attempt, editPageTarget)
    attempts.push(result)
    console.log(`submit-listing attempt ${attempt}/${maxAttempts}: ${result.state} ${result.message}`)

    let submissionAccepted = (result.state === "success" && result.feedbackChanged)
      || SUBMIT_ACCEPTED_TOAST_PATTERN.test(result.message ?? "")

    // Ambiguous click: 发布 (+确认) was clicked but no readable feedback
    // appeared. Observed live: the click navigates to the product list, the
    // toast is missed, and the edit page (with its submit button) is gone —
    // yet the submission DID register (dxmState flipped draft → offline).
    // Ask edit.json whether the publish state moved off the baseline before
    // declaring the attempt dead; retrying blindly just burns attempts on a
    // page that no longer has a submit button.
    if (!submissionAccepted && result.clickedSubmit && result.state !== "failure") {
      const transition = await waitForDianxiaomiPublishStateChange(page, productId, baselinePublishState, 20_000)
      if (transition.changed) {
        console.log(`submit-listing attempt ${attempt}: no page feedback, but edit.json state moved ${baselinePublishState.dxmOfflineState ?? baselinePublishState.dxmState} -> ${transition.current.dxmOfflineState ?? transition.current.dxmState}; treating the submission as registered`)
        submissionAccepted = true
      }
    }

    if (submissionAccepted) {
      return resolveAcceptedSubmission(result.message ?? "")
    }

    await page.waitForTimeout(1500)
  }

  // Safety net: even when every attempt read as dead (e.g. a spurious failure
  // keyword on attempt 1, then "no submit button" after navigation), the click
  // may still have registered. One last edit.json check before declaring
  // failure.
  if (baselinePublishState.available) {
    const finalState = await readDianxiaomiPublishState(page, productId)
    if (finalState.available && !sameDianxiaomiPublishState(finalState, baselinePublishState)) {
      console.log(`submit-listing: attempts exhausted but edit.json state moved ${baselinePublishState.dxmOfflineState ?? baselinePublishState.dxmState} -> ${finalState.dxmOfflineState ?? finalState.dxmState}; treating the submission as registered`)
      return resolveAcceptedSubmission("publish state changed after submit clicks")
    }
  }

  const lastAttempt = attempts[attempts.length - 1]
  const lastFailureReason = lastAttempt?.state === "failure"
    ? lastAttempt.message
    : "no verified success message detected"
  return stepResult(
    "submit-listing",
    "Submit listing",
    "failed",
    `Dianxiaomi submit did not succeed: ${lastFailureReason}`,
    {
      attempts,
      maxAttempts,
      success: false,
      verified: false,
      failureReason: lastFailureReason
    }
  )
}

// P0-C: save-draft verification. Mirrors `submitListingWithVerification` but
// is tuned for the save-draft feedback surface (no confirm dialog, no multi-
// second review queue, single click target). maxAttempts defaults lower (2)
// because the save action is idempotent and a single retry is usually enough.
type SaveDraftAttemptResult = {
  attempt: number
  clickedSave: boolean
  feedbackChanged: boolean
} & SubmitFeedback

const runSaveDraftAttempt = async (
  page: Page,
  config: DianxiaomiSelectorConfig,
  attempt: number
): Promise<SaveDraftAttemptResult> => {
  const previousFeedback = await readSaveDraftFeedback(page)
  await dismissSaveSuccessModalIfPresent(page)
  const dialogsBeforeClick = await getPageSafetyState(page)
  if (dialogsBeforeClick.visibleDialogCount > 0) {
    await closeMediaSurfaceStackToBaseline(page, 0, config)
    await dismissSaveSuccessModalIfPresent(page)
  }

  let saveButton = await findSaveDraftButton(page, config.buttons?.save)
  if (!saveButton) {
    return {
      attempt,
      clickedSave: false,
      feedbackChanged: false,
      state: "failure",
      message: "未找到店小秘保存草稿按钮",
      source: "save-button"
    }
  }

  const clickSaveButtonStable = async (button: Locator, retries: number) => {
    await button.scrollIntoViewIfNeeded().catch(() => undefined)
    await page.evaluate(() => {
      window.scrollBy(0, -240)
    }).catch(() => undefined)
    try {
      await clickAfterDianxiaomiIdle(page, button, retries)
      return true
    } catch {
      return forceDomClick(button)
    }
  }

  try {
    const clicked = await clickSaveButtonStable(saveButton, 2)
    if (!clicked) {
      throw new Error("save button click failed")
    }
  } catch {
    await dismissSaveSuccessModalIfPresent(page)
    await closeMediaSurfaceStackToBaseline(page, 0, config)
    saveButton = await findSaveDraftButton(page, config.buttons?.save)
    if (!saveButton) {
      return {
        attempt,
        clickedSave: false,
        feedbackChanged: false,
        state: "failure",
        message: "save draft stayed blocked by a Dianxiaomi dialog",
        source: "save-button"
      }
    }

    const clicked = await clickSaveButtonStable(saveButton, 1)
    if (!clicked) {
      return {
        attempt,
        clickedSave: false,
        feedbackChanged: false,
        state: "failure",
        message: "save draft click failed after retry",
        source: "save-button"
      }
    }
  }

  await page.waitForTimeout(600)
  const feedback = await waitForSaveDraftFeedback(page, 6_000, previousFeedback)

  return {
    attempt,
    clickedSave: true,
    feedbackChanged: feedback.state !== "unknown" && !sameSaveDraftFeedback(feedback, previousFeedback),
    ...feedback
  }
}

const saveDraftWithVerification = async (
  page: Page,
  config: DianxiaomiSelectorConfig,
  maxAttempts = 2
) => {
  const attempts: SaveDraftAttemptResult[] = []
  const recoverySteps: Array<{
    attempt: number
    trigger: string
    result: AutomationStepResult
  }> = []
  const boundedMax = Math.max(1, Math.min(5, maxAttempts))

  for (let attempt = 1; attempt <= boundedMax; attempt += 1) {
    const result = await runSaveDraftAttempt(page, config, attempt)
    attempts.push(result)
    console.log(`save-draft attempt ${attempt}/${boundedMax}: ${result.state} ${result.message}`)

    if (result.state === "success" && result.feedbackChanged) {
      const dismissal = await dismissSaveSuccessModalIfPresent(page)
      return stepResult(
        "save-draft",
        "保存草稿",
        "done",
        `Dianxiaomi save-draft succeeded: ${result.message || "success"}`,
        {
          attempts,
          maxAttempts: boundedMax,
          success: true,
          verified: true,
          dismissedSuccessModal: dismissal.dismissed,
          matchedSuccessModal: dismissal.matched,
          successModalText: dismissal.dialogText || null
        }
      )
    }

    if (attempt < boundedMax && result.state === "failure" && isColorSkcLimitSaveFailure(result.message)) {
      const trimResult = await trimColorSkcGroupsToLimit(page, COLOR_SKC_MAX_GROUPS, 0)
      recoverySteps.push({
        attempt,
        trigger: "color-skc-limit",
        result: trimResult
      })
      console.log(`save-draft recovery after attempt ${attempt}: ${trimResult.status} ${trimResult.detail}`)
      await page.waitForTimeout(1_200)
      continue
    }

    if (attempt < boundedMax && result.state === "failure" && isMissingVariantSaveFailure(result.message)) {
      const remapResult = await normalizeVariantRemap(page, "save failure: missing variant selection")
      recoverySteps.push({
        attempt,
        trigger: "missing-variant-selection",
        result: remapResult
      })
      console.log(`save-draft recovery after attempt ${attempt}: ${remapResult.status} ${remapResult.detail}`)
      const variantAttributeResult = await normalizeVariantAttributes(page)
      recoverySteps.push({
        attempt,
        trigger: "missing-variant-attributes",
        result: variantAttributeResult
      })
      console.log(`save-draft recovery after attempt ${attempt}: ${variantAttributeResult.status} ${variantAttributeResult.detail}`)
      await page.waitForTimeout(1_200)
      continue
    }

    if (attempt < boundedMax && result.state === "failure" && isSiteWarehouseSaveFailure(result.message)) {
      const warehouseResult = await normalizeSiteWarehouse(page)
      recoverySteps.push({
        attempt,
        trigger: "site-warehouse",
        result: warehouseResult
      })
      console.log(`save-draft recovery after attempt ${attempt}: ${warehouseResult.status} ${warehouseResult.detail}`)
      await page.waitForTimeout(1_200)
      continue
    }

    if (attempt < boundedMax && result.state === "failure" && isShipmentPromiseSaveFailure(result.message)) {
      const shipmentPromiseResult = await normalizeShipmentPromise(page)
      recoverySteps.push({
        attempt,
        trigger: "shipment-promise",
        result: shipmentPromiseResult
      })
      console.log(`save-draft recovery after attempt ${attempt}: ${shipmentPromiseResult.status} ${shipmentPromiseResult.detail}`)
      await page.waitForTimeout(1_200)
      continue
    }

    if (attempt < boundedMax && result.state === "failure" && isFreightTemplateSaveFailure(result.message)) {
      const freightTemplateResult = await normalizeFreightTemplate(page)
      recoverySteps.push({
        attempt,
        trigger: "freight-template",
        result: freightTemplateResult
      })
      console.log(`save-draft recovery after attempt ${attempt}: ${freightTemplateResult.status} ${freightTemplateResult.detail}`)
      await page.waitForTimeout(1_200)
      continue
    }

    await page.waitForTimeout(800)
  }

  const lastAttempt = attempts[attempts.length - 1]
  const lastFailureReason = lastAttempt?.state === "failure"
    ? lastAttempt.message
    : lastAttempt?.state === "unknown"
      ? "no save-draft success feedback detected (button click landed but Dianxiaomi did not confirm)"
      : "no verified success message detected"
  const validationSummary = await collectPageValidationSummary(page)
  const validationIssuePreview = validationSummary.issues
    .slice(0, 3)
    .map((issue) => issue.explain.find(Boolean) || issue.label || issue.text)
    .filter(Boolean)
  const validationSuffix = validationIssuePreview.length > 0
    ? ` Remaining page issues: ${validationIssuePreview.join("; ")}`
    : ""
  return stepResult(
    "save-draft",
    "保存草稿",
    "failed",
    `Dianxiaomi save-draft did not succeed: ${lastFailureReason}${validationSuffix}`,
    {
      attempts,
      maxAttempts: boundedMax,
      recoverySteps,
      success: false,
      verified: false,
      failureReason: lastFailureReason,
      validationSummary
    }
  )
}

const findByConfiguredSelectorsInRoot = async (root: Locator, selectors: string[] | undefined): Promise<Locator | null> => {
  if (!selectors?.length) {
    return null
  }

  return firstVisible(selectors.map((selector) => root.locator(selector)))
}

const getConfiguredMediaActionSelectors = (
  config: DianxiaomiSelectorConfig,
  action: "apply" | "close",
  tool: Pick<MediaToolDefinition, "configKey">
) => config.mediaToolActions?.[action]?.[tool.configKey]

const findMediaApplyButtonForTool = async (
  page: Page,
  config: DianxiaomiSelectorConfig,
  tool: Pick<MediaToolDefinition, "id" | "configKey">
) => {
  const dialog = await getLatestMediaDialog(page)
  if (!dialog) {
    return null
  }

  return await findByConfiguredSelectorsInRoot(dialog, getConfiguredMediaActionSelectors(config, "apply", tool))
    ?? await findInteractiveInRootByKeywords(dialog, MEDIA_APPLY_KEYWORDS[tool.id])
}

const ensureCheckboxNearText = async (
  root: Locator,
  labelText: string,
  checked: boolean
) => {
  const labelPattern = new RegExp(escapeRegExp(labelText), "i")
  const label = root.locator("label, .ant-checkbox-wrapper").filter({ hasText: labelPattern }).first()
  const checkbox = label.locator("input[type='checkbox']").first()
  const hasCheckbox = await checkbox.count().catch(() => 0) > 0
  if (!hasCheckbox) {
    return null
  }

  const current = await checkbox.isChecked().catch(() => false)
  if (current !== checked) {
    await label.click()
    await root.page().waitForTimeout(200)
  }

  return await checkbox.isChecked().catch(() => current)
}

const prepareBatchResizeDialog = async (
  page: Page,
  tool: MediaToolSafetyItem,
  targetSidePx = BATCH_RESIZE_TARGET_SIDE_PX
) => {
  const dialog = await getLatestMediaDialog(page)
  if (!dialog) {
    tool.preparation = {
      prepared: false,
      reason: "batch resize dialog missing"
    }
    return false
  }

  const dialogText = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
  /*
  const isBatchResizeDialog = keywordMatch(dialogText, [
    "批量改图片尺寸",
    "改图片尺寸",
    "批量改大小",
    "生成JPG图片",
    "生成PNG图片",
    "图片小边",
    "变化至"
    "batch resize",
    "apply resize",
    "normalize image dimensions",
    "file sizes"
  ])
  */
  const isBatchResizeDialog = keywordMatch(dialogText, [
    "\u6279\u91cf\u6539\u56fe\u7247\u5c3a\u5bf8",
    "\u6539\u56fe\u7247\u5c3a\u5bf8",
    "\u6279\u91cf\u6539\u5927\u5c0f",
    "\u751f\u6210JPG\u56fe\u7247",
    "\u751f\u6210PNG\u56fe\u7247",
    "\u56fe\u7247\u5c0f\u8fb9",
    "\u7b49\u6bd4\u4f8b",
    "\u7b49\u6bd4\u4f8b\u8c03\u6574",
    "batch resize",
    "apply resize",
    "normalize image dimensions",
    "file sizes"
  ])
  if (!isBatchResizeDialog) {
    tool.preparation = {
      prepared: false,
      reason: "latest media dialog is not batch resize",
      dialogText
    }
    return false
  }

  const selects = dialog.locator(".ant-select:visible")
  const selectCount = await selects.count().catch(() => 0)
  const firstSelect = selectCount > 0 ? selects.nth(0) : null
  const secondSelect = selectCount > 1 ? selects.nth(1) : null
  const firstSelectText = await readVisibleText(firstSelect)
  const secondSelectText = await readVisibleText(secondSelect)
  const selectedResizeMode = !firstSelect
    ? null
    : firstSelectText.includes("等比例")
      ? firstSelectText
      : await selectAntOption(page, firstSelect, ["等比例调整", "等比例"], "等比例")
  const selectedResizeSide = !secondSelect
    ? null
    : secondSelectText.includes("图片小边") || secondSelectText.includes("小边")
      ? secondSelectText
      : await selectAntOption(page, secondSelect, ["图片小边", "小边"], "图片小边")

  const valueInput = await firstVisible([
    dialog.locator("input[name='valueW']"),
    dialog.locator("input[type='text']").filter({ hasText: /\S/ }),
    dialog.locator("input.ant-input")
  ])

  if (!valueInput) {
    tool.preparation = {
      prepared: false,
      reason: "batch resize value input missing",
      selectedResizeMode,
      selectedResizeSide
    }
    return false
  }

  await fillTextField(valueInput, String(targetSidePx))
  const selectAllChecked = await ensureCheckboxNearText(dialog, "选择全部", true)
  const actualValue = await valueInput.inputValue().catch(() => "")
  tool.preparation = {
    prepared: actualValue === String(targetSidePx),
    targetSidePx,
    selectedResizeMode,
    selectedResizeSide,
    selectAllChecked,
    actualValue
  }

  return actualValue === String(targetSidePx)
}

const getImageCheckDialog = async (page: Page) => {
  const imageCheckSignals = ".img-test, .img-test-items, .img-test-details-list, label.image-checkbox, .single-image"
  const directRoots = [
    page.locator(".img-test:visible"),
    page.locator(".ant-modal:visible").filter({ has: page.locator(imageCheckSignals) }),
    page.locator(".ant-modal-wrap:visible").filter({ has: page.locator(imageCheckSignals) })
  ]

  for (const root of directRoots) {
    const count = await root.count().catch(() => 0)
    for (let index = count - 1; index >= 0; index -= 1) {
      const locator = root.nth(index)
      if (await locator.isVisible().catch(() => false)) {
        return locator
      }
    }
  }

  const dialogs = await visibleDialogLocators(page)

  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index]
    const signalCount = await dialog.locator(imageCheckSignals).count().catch(() => 0)
    if (signalCount > 0) {
      return dialog
    }
    const text = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
    if (text.includes("图片检测") || text.includes("图片包含文字") || text.includes("尺寸不合规")) {
      return dialog
    }
  }

  return null
}

const waitForImageCheckDialog = async (page: Page, timeoutMs = 8_000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const dialog = await getImageCheckDialog(page)
    if (dialog) {
      return dialog
    }
    await page.waitForTimeout(300)
  }

  return getImageCheckDialog(page)
}

const requireFreshImageCheckDialog = async (page: Page, fallback: Locator | null) => {
  const fresh = await getImageCheckDialog(page)
  return fresh ?? fallback
}

const parseImageCheckCategorySummary = (label: string): ImageCheckCategorySummary => {
  const normalized = cleanVisibleText(label)
  const countMatch = normalized.match(/(\d+)\s*$/)
  return {
    label: countMatch ? normalized.slice(0, countMatch.index).trim() : normalized,
    count: countMatch ? Number.parseInt(countMatch[1] ?? "0", 10) : 0
  }
}

const collectImageCheckCategoryItems = async (dialog: Locator) => {
  const items = dialog.locator(".img-test-items li")
  const count = Math.min(await items.count().catch(() => 0), 12)
  const categories: Array<{ locator: Locator; label: string; count: number }> = []

  for (let index = 0; index < count; index += 1) {
    const locator = items.nth(index)
    if (!await locator.isVisible().catch(() => false)) {
      continue
    }
    const text = cleanVisibleText(await locator.innerText().catch(() => ""))
    if (!text) {
      continue
    }
    const parsed = parseImageCheckCategorySummary(text)
    categories.push({
      locator,
      label: parsed.label,
      count: parsed.count
    })
  }

  return categories
}

const classifyIssueToImageCheckCategory = (
  issue: ImageCheckIssue,
  categories: Array<{ label: string; count: number }>
) => {
  const issueText = `${issue.category} ${issue.issue} ${issue.detail ?? ""}`
  const matchedRule = IMAGE_CHECK_CATEGORY_RULES.find((rule) => rule.issuePattern.test(issueText))
  if (matchedRule) {
    const matchedCategory = categories.find((category) => matchedRule.categoryPattern.test(category.label))
    if (matchedCategory) {
      return matchedCategory.label
    }
  }

  return categories
    .sort((left, right) => {
      const leftPriority = IMAGE_CHECK_CATEGORY_PRIORITY.indexOf(left.label as typeof IMAGE_CHECK_CATEGORY_PRIORITY[number])
      const rightPriority = IMAGE_CHECK_CATEGORY_PRIORITY.indexOf(right.label as typeof IMAGE_CHECK_CATEGORY_PRIORITY[number])
      const leftOrder = leftPriority >= 0 ? leftPriority : Number.MAX_SAFE_INTEGER
      const rightOrder = rightPriority >= 0 ? rightPriority : Number.MAX_SAFE_INTEGER
      return leftOrder - rightOrder
    })[0]?.label ?? null
}

const clickImageCheckCategory = async (
  page: Page,
  dialog: Locator,
  categoryLabel: string
) => {
  const categories = await collectImageCheckCategoryItems(dialog)
  const target = categories.find((item) => item.label === categoryLabel)
  if (!target) {
    return false
  }

  await clickAfterDianxiaomiIdle(page, target.locator, 1)
  await page.waitForTimeout(500)
  return true
}

const collectImageCheckSelectionCandidates = async (dialog: Locator): Promise<ImageCheckSelectionCandidate[]> => {
  const cards = dialog.locator(".img-test-details-list .single-image, .img-test-details-list label.image-checkbox")
  const count = Math.min(await cards.count().catch(() => 0), IMAGE_CHECK_MAX_VISIBLE_CANDIDATES)
  const candidates: ImageCheckSelectionCandidate[] = []
  const seen = new Set<string>()

  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index)
    if (!await card.isVisible().catch(() => false)) {
      continue
    }
    const text = cleanVisibleText(await card.innerText().catch(() => ""))
    if (!text) {
      continue
    }
    const dimensionMatch = text.match(/(\d+\s*[xX]\s*\d+)/)
    const imageType = cleanVisibleText(await card.locator(".img-tag").first().innerText().catch(() => ""))
    const src = await card.locator("img").first().getAttribute("src").catch(() => null)
    const candidate = {
      label: text.slice(0, 120),
      dimensions: dimensionMatch?.[1] ?? null,
      imageType: imageType || null,
      src: src?.trim() || null
    }
    const key = [
      candidate.label.toLowerCase(),
      (candidate.dimensions ?? "").toLowerCase(),
      (candidate.imageType ?? "").toLowerCase(),
      (candidate.src ?? "").toLowerCase()
    ].join("::")
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    candidates.push(candidate)
  }

  return candidates
}

const selectImageCheckCandidates = async (page: Page, dialog: Locator) => {
  const candidateLabels = dialog.locator(".img-test-details-list label.image-checkbox")
  const count = Math.min(await candidateLabels.count().catch(() => 0), IMAGE_CHECK_MAX_VISIBLE_CANDIDATES)
  let selectedCount = 0

  // Real Dianxiaomi size-check categories can expose 25+ replacement cards.
  // Prefer the dialog's built-in select-all control so we do not silently miss
  // the last card when the list grows beyond the historical 24-item sample.
  await ensureCheckboxNearText(dialog, "选择全部", true)

  for (let index = 0; index < count; index += 1) {
    const label = candidateLabels.nth(index)
    if (!await label.isVisible().catch(() => false)) {
      continue
    }
    const checkbox = label.locator("input[type='checkbox']").first()
    const current = await checkbox.isChecked().catch(() => false)
    if (current) {
      selectedCount += 1
      continue
    }
    await checkbox.check({ force: true }).catch(async () => {
      await label.click({ force: true }).catch(() => undefined)
    })
    await page.waitForTimeout(120)
    if (await checkbox.isChecked().catch(() => false)) {
      selectedCount += 1
    }
  }

  return selectedCount
}

const inferImageCheckBatchTool = (issues: ImageCheckIssue[]) => {
  const combined = issues
    .map((issue) => `${issue.category} ${issue.issue} ${issue.detail ?? ""}`)
    .join(" ")
    .toLowerCase()
  const normalizedIssues = new Set(
    issues
      .map((issue) => cleanVisibleText(issue.issue).toLowerCase())
      .filter(Boolean)
  )

  if (
    normalizedIssues.has("\u975e\u82f1\u6587")
    || normalizedIssues.has("\u6c34\u5370")
    || /(?:\u975e\u82f1\u6587|\u975e\u82f1\u8bed|\u4e2d\u6587|\u6587\u5b57|\u6c34\u5370|language|english|translate|translation|watermark)/i.test(combined)
  ) {
    return "image-translation" as const
  }
  if (
    normalizedIssues.has("\u5c3a\u5bf8")
    || normalizedIssues.has("\u6bd4\u4f8b")
    || normalizedIssues.has("\u5bbd\u9ad8")
    || normalizedIssues.has("\u50cf\u7d20")
    || normalizedIssues.has("\u5927\u5c0f")
    || normalizedIssues.has("\u683c\u5f0f")
    || /(?:\u5c3a\u5bf8|\u6bd4\u4f8b|\u5bbd\u9ad8|\u50cf\u7d20|\u5927\u5c0f|\u8fc7\u5927|\u683c\u5f0f|size|ratio|aspect|resolution|format|oversize|too large)/i.test(combined)
  ) {
    return "batch-resize" as const
  }

  return null
}

const saveImageCheckDialog = async (
  page: Page,
  dialog: Locator
) => {
  const liveDialog = await requireFreshImageCheckDialog(page, dialog)
  if (!liveDialog) {
    return {
      saved: false,
      feedback: null as MediaApplyFeedback | null
    }
  }
  const saveButton = await findInteractiveInRootByKeywords(liveDialog, IMAGE_CHECK_SAVE_KEYWORDS)
  if (!saveButton) {
    return {
      saved: false,
      feedback: null as MediaApplyFeedback | null
    }
  }

  const beforeDialogCount = (await visibleDialogLocators(page)).length
  await clickAfterDianxiaomiIdle(page, saveButton, 1)

  const startedAt = Date.now()
  let latestFeedback: MediaApplyFeedback | null = null
  while (Date.now() - startedAt < 12_000) {
    const currentDialog = await getImageCheckDialog(page)
    if (!currentDialog) {
      return {
        saved: true,
        feedback: latestFeedback ?? {
          state: "success",
          message: "image check dialog closed after save",
          source: "dialog-close"
        }
      }
    }

    const feedbackTexts = (await collectFeedbackTexts(page)).filter((item) =>
      item.source !== "body"
      && item.source !== "media-surface"
    )

    for (const item of feedbackTexts) {
      const matchedFailureKeyword = keywordMatch(item.text, MEDIA_APPLY_FAILURE_KEYWORDS)
      if (matchedFailureKeyword) {
        return {
          saved: false,
          feedback: {
            state: "failure",
            message: item.text,
            source: item.source
          }
        }
      }
    }

    for (const item of feedbackTexts) {
      if (keywordMatch(item.text, MEDIA_APPLY_SUCCESS_KEYWORDS)) {
        latestFeedback = {
          state: "success",
          message: item.text,
          source: item.source
        }
        break
      }
    }

    if (
      latestFeedback?.state === "success"
      && await waitForVisibleDialogCountAtMost(page, Math.max(0, beforeDialogCount - 1), 2_000)
    ) {
      return {
        saved: true,
        feedback: latestFeedback
      }
    }

    await page.waitForTimeout(400)
  }

  if (!await getImageCheckDialog(page)) {
    return {
      saved: true,
      feedback: latestFeedback ?? {
        state: "success",
        message: "image check dialog closed after save",
        source: "dialog-close"
      }
    }
  }

  await closeImageCheckDialogIfPresent(page)
  return {
    saved: false,
    feedback: latestFeedback
  }
}

const closeImageCheckDialogIfPresent = async (page: Page) => {
  const closeTopmostBlockingOverlayIfPresent = async (targetDialog: Locator) => {
    const candidates = await visibleModalCandidates(page)
    if (candidates.length < 2) {
      return false
    }

    const targetKey = await locatorIdentityKey(targetDialog)
    const topmost = candidates[candidates.length - 1] ?? null
    if (!topmost) {
      return false
    }

    const topmostKey = await locatorIdentityKey(topmost)
    if (!targetKey || !topmostKey || topmostKey === targetKey) {
      return false
    }

    const overlayAction = await findInteractiveInRootByKeywords(topmost, [
      ...IMAGE_CHECK_CLOSE_KEYWORDS,
      "\u6211\u77e5\u9053\u4e86",
      "\u77e5\u9053\u4e86",
      "\u786e\u5b9a",
      "\u786e\u8ba4",
      "ok",
      "confirm"
    ]) ?? await findLastVisibleActionInRoot(topmost)
    if (!overlayAction) {
      return false
    }

    const beforeCount = candidates.length
    await clickAfterDianxiaomiIdle(page, overlayAction, 1)
    await waitForVisibleModalCandidateCountAtMost(page, Math.max(0, beforeCount - 1), 5_000)
    return true
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dialog = await getImageCheckDialog(page)
    if (!dialog) {
      return true
    }

    if (await closeTopmostBlockingOverlayIfPresent(dialog)) {
      await page.waitForTimeout(250)
      continue
    }

    const closeButton = await findInteractiveInRootByKeywords(dialog, IMAGE_CHECK_CLOSE_KEYWORDS)
      ?? await findLastVisibleActionInRoot(dialog)
    if (!closeButton) {
      return false
    }

    const beforeDialogCount = (await visibleDialogLocators(page)).length
    await clickAfterDianxiaomiIdle(page, closeButton, 1)
    const closed = await waitForVisibleDialogCountAtMost(page, Math.max(0, beforeDialogCount - 1), 5_000)
    if (closed) {
      return true
    }
  }

  return !(await getImageCheckDialog(page))
}

const runImageCheckBatchTool = async (
  page: Page,
  dialog: Locator,
  toolId: "image-translation" | "batch-resize"
): Promise<{
  applied: boolean
  reason: string
}> => {
  const baselineVisibleDialogs = (await visibleDialogLocators(page)).length
  const batchTrigger = await findInteractiveInRootByKeywords(dialog, ["\u6279\u91cf\u64cd\u4f5c", "batch"])
  if (!batchTrigger) {
    return {
      applied: false,
      reason: "image check batch action trigger missing"
    }
  }

  await clickAfterDianxiaomiIdle(page, batchTrigger, 1)
  await page.waitForTimeout(400)

  const menuClicked = await clickVisibleMenuItemByKeywords(
    page,
    toolId === "image-translation"
      ? ["\u56fe\u7247\u7ffb\u8bd1", "\u7ffb\u8bd1\u56fe\u7247", "image translation", "translate image"]
      : ["\u6279\u91cf\u6539\u56fe\u7247\u5c3a\u5bf8", "\u6279\u91cf\u6539\u5927\u5c0f", "\u6539\u56fe\u7247\u5c3a\u5bf8", "batch resize", "resize"]
  )
  if (!menuClicked) {
    return {
      applied: false,
      reason: `image check batch action menu item missing for ${toolId}`
    }
  }

  await page.waitForTimeout(1_000)
  const mediaSurface = await getLatestMediaDialog(page)
  if (!mediaSurface) {
    return {
      applied: false,
      reason: `${toolId} dialog did not open from image check batch action`
    }
  }

  if (toolId === "batch-resize") {
    const probeTool: MediaToolSafetyItem = {
      id: "batch-resize",
      configKey: "batchResize",
      label: "Batch resize",
      available: true,
      selectorConfigured: false,
      status: "ready-for-unattended-apply",
      reason: "",
      requiresManualConfirmation: false,
      wouldClick: true,
      wouldApply: true,
      clicked: true,
      applied: false,
      locator: null
    }
    const prepared = await prepareBatchResizeDialog(page, probeTool)
    if (!prepared) {
      return {
        applied: false,
        reason: "batch resize preparation failed inside image check"
      }
    }
    const applyButton = await findInteractiveInRootByKeywords(mediaSurface, [
      "\u751f\u6210JPG\u56fe\u7247",
      "\u751f\u6210PNG\u56fe\u7247",
      "\u751f\u6210\u56fe\u7247",
      "\u786e\u8ba4",
      "\u786e\u5b9a",
      "confirm",
      "apply"
    ])
    if (!applyButton) {
      return {
        applied: false,
        reason: "batch resize apply button missing inside image check"
      }
    }
    const beforeUrl = page.url()
    await clickAfterDianxiaomiIdle(page, applyButton, 1)
    let feedback = await waitForBatchResizeCompletion(
      page,
      mediaSurface,
      BATCH_RESIZE_TARGET_SIDE_PX,
      BATCH_RESIZE_COMPLETION_TIMEOUT_MS,
      null
    )
    if (feedback.state === "unknown") {
      const returnToEditorFeedback = await waitForBatchResizeReturnToEditor(
        page,
        baselineVisibleDialogs,
        beforeUrl
      )
      if (returnToEditorFeedback) {
        feedback = returnToEditorFeedback
      }
    }
    if (feedback.state !== "success") {
      return {
        applied: false,
        reason: feedback.message || "batch resize did not report success inside image check"
      }
    }
    await closeMediaSurfaceStackToBaseline(page, baselineVisibleDialogs, {})
    return {
      applied: true,
      reason: feedback.message || "batch resize completed inside image check"
    }
  }

  await ensureCheckboxNearText(mediaSurface, "\u9009\u62e9\u5168\u90e8", true)
  await ensureCheckboxNearText(mediaSurface, "\u5feb\u901f\u7ffb\u8bd1", false)
  const applyButton = await findInteractiveInRootByKeywords(mediaSurface, [
    "\u4e00\u952e\u7ffb\u8bd1",
    "\u5feb\u901f\u7ffb\u8bd1",
    "translate",
    "start translation",
    "confirm"
  ])
  if (!applyButton) {
    return {
      applied: false,
      reason: "image translation apply button missing inside image check"
    }
  }
  const quotaBefore = extractImageTranslationQuotaCount(await mediaSurface.innerText().catch(() => ""))
  await clickAfterDianxiaomiIdle(page, applyButton, 1)
  await completeImageTranslationFinalActionIfPresent(page, applyButton)
  let feedback = await waitForMediaApplyFeedback(page, mediaSurface, 90_000, "image-translation", null)
  if (feedback.state === "unknown") {
    const quotaFeedback = await waitForImageTranslationSubmissionSignal(page, mediaSurface, quotaBefore, 8_000)
    if (quotaFeedback) {
      feedback = quotaFeedback
    }
  }
  if (shouldWaitForImageTranslationResultDialog(feedback)) {
    const resultDialogFeedback = await waitForImageTranslationResultDialog(page, 180_000)
    if (resultDialogFeedback) {
      feedback = resultDialogFeedback
    }
  }
  if (feedback.state !== "success") {
    return {
      applied: false,
      reason: feedback.message || "image translation did not report success inside image check"
    }
  }

  await finalizeImageTranslationResultIfPresent(page)
  await closeMediaSurfaceStackToBaseline(page, baselineVisibleDialogs, {})
  await page.waitForTimeout(500)
  return {
    applied: true,
    reason: feedback.message || "image translation completed inside image check"
  }
}

const reopenImageCheckDialog = async (
  page: Page,
  config: DianxiaomiSelectorConfig,
  targetUrl?: string
) => {
  if (await getImageCheckDialog(page)) {
    return true
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dismissSaveSuccessModalIfPresent(page)
    if (targetUrl) {
      await waitForPublishPage(page, config, {
        waitForManualNavigation: false,
        targetUrl
      })
    } else {
      await waitForImageCheckPageToSettle(page, 5_000)
    }
    const candidates = await collectMediaToolCandidates(page, config)
    const imageManagement = candidates.find((item) => item.id === "image-management")
    if (!imageManagement?.locator) {
      await page.waitForTimeout(500)
      continue
    }

    try {
      await clickAfterDianxiaomiIdle(page, imageManagement.locator, 1)
    } catch {
      await page.waitForTimeout(500)
      continue
    }

    if (await waitForImageCheckDialog(page, 5_000)) {
      return true
    }
  }

  return false
}

const waitForImageCheckDialogRecovery = async (page: Page, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const dialog = await getImageCheckDialog(page)
    if (dialog) {
      return dialog
    }
    await page.waitForTimeout(500)
  }

  return getImageCheckDialog(page)
}

const waitForImageCheckDialogStableRecovery = async (
  page: Page,
  priorDialog: Locator | null,
  timeoutMs = 15_000
) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const latestDialog = await getImageCheckDialog(page)
    if (latestDialog) {
      return latestDialog
    }

    if (priorDialog) {
      const priorStillVisible = await priorDialog.isVisible().catch(() => false)
      if (priorStillVisible) {
        return priorDialog
      }
    }

    await page.waitForTimeout(300)
  }

  return getImageCheckDialog(page) ?? priorDialog
}

const waitForImageCheckPageToSettle = async (page: Page, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const overlayVisible = await page.locator([
      ".ant-spin-spinning:visible",
      ".ant-spin-container-loading:visible",
      ".loading:visible",
      ".spinner:visible",
      "[class*='loading' i]:visible",
      "[class*='spinner' i]:visible"
    ].join(", ")).count().catch(() => 0)

    if (overlayVisible === 0) {
      return true
    }

    await page.waitForTimeout(500)
  }

  return true
}

const verifyImageCheckCategoriesResolvedAfterSave = async (
  page: Page,
  config: DianxiaomiSelectorConfig,
  categoryLabels: string[],
  options: {
    targetUrl?: string
  } = {}
) => {
  const requested = Array.from(new Set(categoryLabels.map((label) => cleanVisibleText(label)).filter(Boolean)))
  if (requested.length === 0) {
    return {
      verified: true,
      remainingCategories: [] as Array<{ label: string; count: number }>,
      surfacedIssues: [] as ImageCheckIssue[]
    }
  }

  await dismissSaveSuccessModalIfPresent(page)
  const targetUrl = options.targetUrl?.trim() || page.url()
  await waitForPublishPage(page, config, {
    waitForManualNavigation: false,
    targetUrl
  })
  await waitForImageCheckPageToSettle(page, 8_000)
  const reopened = await reopenImageCheckDialog(page, config, targetUrl)
  if (!reopened) {
    return {
      verified: false,
      remainingCategories: requested.map((label) => ({ label, count: -1 })),
      surfacedIssues: [] as ImageCheckIssue[]
    }
  }

  const dialog = await waitForImageCheckDialog(page, 8_000)
  if (!dialog) {
    return {
      verified: false,
      remainingCategories: requested.map((label) => ({ label, count: -1 })),
      surfacedIssues: [] as ImageCheckIssue[]
    }
  }

  const categories = await collectImageCheckCategoryItems(dialog)
  const remainingCategories = requested
    .map((label) => ({
      label,
      count: categories.find((item) => item.label === label)?.count ?? 0
    }))
    .filter((item) => item.count > 0)
  const surfaceText = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
  const surfacedIssues = uniqueImageCheckIssues(extractImageCheckIssues(surfaceText))

  await closeImageCheckDialogIfPresent(page)
  return {
    verified: remainingCategories.length === 0,
    remainingCategories,
    surfacedIssues
  }
}

const applyImageCheckSelections = async (
  page: Page,
  config: DianxiaomiSelectorConfig,
  issues: ImageCheckIssue[]
): Promise<ImageCheckApplySummary> => {
  const dialog = await getImageCheckDialog(page)
  if (!dialog) {
    return {
      applied: false,
      changed: false,
      status: "failed",
      reason: "image check dialog missing",
      categories: [],
      issues,
      deferredVerification: null
    }
  }

  const categories = await collectImageCheckCategoryItems(dialog)
  const targetLabels = uniqueImageCheckIssues(issues)
    .map((issue) => classifyIssueToImageCheckCategory(issue, categories))
    .filter((label): label is string => Boolean(label))
  const dedupedTargetLabels = Array.from(new Set(targetLabels))
  const results: ImageCheckCategoryApplyResult[] = []
  let changed = false
  const deferredVerificationCategories: string[] = []

  for (const categoryLabel of dedupedTargetLabels) {
    const liveDialog = await requireFreshImageCheckDialog(page, dialog)
    if (!liveDialog) {
      return {
        applied: false,
        changed,
        status: "failed",
        reason: "image check dialog disappeared before category selection",
        categories: results,
        issues,
        deferredVerification: null
      }
    }
    const liveCategories = await collectImageCheckCategoryItems(liveDialog)
    const category = liveCategories.find((item) => item.label === categoryLabel)
    if (!category || category.count <= 0) {
      continue
    }

    const clicked = await clickImageCheckCategory(page, liveDialog, categoryLabel)
    if (!clicked) {
      continue
    }
    await page.waitForTimeout(300)
    const categoryDialog = await requireFreshImageCheckDialog(page, liveDialog)
    if (!categoryDialog) {
      return {
        applied: false,
        changed,
        status: "failed",
        reason: "image check dialog disappeared before candidate selection",
        categories: results,
        issues,
        deferredVerification: null
      }
    }
    const candidates = await collectImageCheckSelectionCandidates(categoryDialog)
    const selectedCount = await selectImageCheckCandidates(page, categoryDialog)
    const matchingIssues = uniqueImageCheckIssues(issues).filter((issue) =>
      classifyIssueToImageCheckCategory(issue, liveCategories) === categoryLabel
    )
    const batchTool = inferImageCheckBatchTool(matchingIssues)
    const requiresPostSaveVerification = batchTool === "batch-resize" && selectedCount > 0
    const batchResult = selectedCount <= 0
      ? {
          applied: false,
          reason: batchTool
            ? `no issue images were selected before running ${batchTool}`
            : "no issue images were selected"
        }
      : batchTool
        ? await runImageCheckBatchTool(page, categoryDialog, batchTool)
        : {
            applied: false,
            reason: "no official Dianxiaomi batch repair tool matched the detected image-check issue"
          }
    const categoryChanged = batchResult.applied
    results.push({
      category: categoryLabel,
      count: category.count,
      selectedCount,
      changed: categoryChanged,
      candidates,
      batchTool,
      batchToolApplied: batchResult.applied,
      batchToolReason: batchResult.reason
    })

    if (requiresPostSaveVerification && categoryChanged) {
      deferredVerificationCategories.push(categoryLabel)
    }

    if (selectedCount > 0 && batchTool && !batchResult.applied) {
      await closeImageCheckDialogIfPresent(page)
      return {
        applied: false,
        changed,
        status: "failed",
        reason: `${categoryLabel} official image-check repair failed: ${batchResult.reason}`,
        categories: results,
        issues,
        deferredVerification: null
      }
    }

    if (categoryChanged) {
      changed = true
    }

    if (batchResult.applied) {
      let recoveredDialog = await waitForImageCheckDialogStableRecovery(page, categoryDialog, 8_000)
      if (!recoveredDialog) {
        const reopened = await reopenImageCheckDialog(page, config)
        recoveredDialog = reopened ? await waitForImageCheckDialog(page, 8_000) : null
      }

      if (!recoveredDialog) {
        return {
          applied: false,
          changed,
          status: "failed",
          reason: `${categoryLabel} repair completed but image check did not return to a saveable dialog`,
          categories: results,
          issues
        }
      }
    }

    await waitForImageCheckPageToSettle(page, 3_000)
  }

  if (results.length === 0) {
    await closeImageCheckDialogIfPresent(page)
    return {
      applied: false,
      changed: false,
      status: "no-op",
      reason: "image check categories were not matched to actionable candidates",
      categories: [],
      issues,
      deferredVerification: null
    }
  }

  const latestDialog = await requireFreshImageCheckDialog(page, dialog)
  if (!latestDialog) {
    return {
      applied: false,
      changed,
      status: "failed",
      reason: "image check dialog disappeared before save",
      categories: results,
      issues,
      deferredVerification: null
    }
  }
  const saveResult = await saveImageCheckDialog(page, latestDialog)
  if (!saveResult.saved) {
    await closeImageCheckDialogIfPresent(page)
    return {
      applied: false,
      changed,
      status: "failed",
      reason: saveResult.feedback?.message || "image check save did not succeed",
      categories: results,
      issues,
      deferredVerification: null
    }
  }

  return {
    applied: true,
    changed,
    status: changed ? "applied" : "no-op",
    reason: changed
      ? `image check saved ${results.filter((item) => item.changed).length} official categorized repair(s)`
      : "image check saved without any official categorized repair",
    categories: results,
    issues,
    deferredVerification: deferredVerificationCategories.length > 0
      ? {
          required: true,
          categoryLabels: deferredVerificationCategories
        }
      : null
  }
}

const waitForBatchResizeCompletion = async (
  page: Page,
  root: Locator | null,
  targetSidePx = BATCH_RESIZE_TARGET_SIDE_PX,
  timeoutMs = BATCH_RESIZE_COMPLETION_TIMEOUT_MS,
  previousFeedback?: MediaApplyFeedback | null,
  duplicateFeedbackGraceMs = 2_500
): Promise<MediaApplyFeedback> => {
  const startedAt = Date.now()
  const targetPattern = new RegExp(`${targetSidePx}\\s*[xX×]\\s*${targetSidePx}`)
  let latest: MediaApplyFeedback = {
    state: "unknown",
    message: "",
    source: "none"
  }

  while (Date.now() - startedAt < timeoutMs) {
    latest = await readMediaApplyFeedback(page, root)
    if (latest.state !== "unknown") {
      const feedbackText = normalizeFeedbackText(latest.message)
      if (
        latest.state === "success"
        && keywordMatch(feedbackText, BATCH_RESIZE_PROGRESS_KEYWORDS)
      ) {
        latest = {
          state: "unknown",
          message: latest.message,
          source: latest.source
        }
      } else if (!sameMediaApplyFeedback(latest, previousFeedback) || Date.now() - startedAt >= duplicateFeedbackGraceMs) {
        return latest
      }
    }

    if (root && !await root.isVisible().catch(() => false)) {
      return {
        state: "unknown",
        message: "batch resize dialog closed before a stable success toast appeared",
        source: "dialog-close"
      }
    }

    const surfaceText = root ? normalizeFeedbackText(await root.innerText().catch(() => "")) : ""
    const dialogs = await visibleDialogLocators(page)
    const latestDialogText = dialogs.length > 0
      ? normalizeFeedbackText(await dialogs[dialogs.length - 1].innerText().catch(() => ""))
      : ""
    if (
      targetPattern.test(surfaceText)
      && !keywordMatch(surfaceText, BATCH_RESIZE_PROGRESS_KEYWORDS)
      && (
        latestDialogText.length === 0
        || !keywordMatch(latestDialogText, BATCH_RESIZE_PROGRESS_KEYWORDS)
        || Boolean(await getImageCheckDialog(page))
      )
    ) {
      return {
        state: "success",
        message: `batch resize generated images at ${targetSidePx} X ${targetSidePx}`,
        source: "media-surface"
      }
    }

    await page.waitForTimeout(750)
  }

  return latest
}

// Real Dianxiaomi sometimes closes the batch-resize dialog and returns to the
// listing editor without emitting a stable success toast. Treat that as a
// success only when the dialog stack returns to baseline on the same page and
// no failure feedback appears during the recovery window.
const waitForBatchResizeReturnToEditor = async (
  page: Page,
  baselineVisibleDialogs: number,
  beforeUrl: string | null | undefined,
  timeoutMs = 8_000
): Promise<MediaApplyFeedback | null> => {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const visibleDialogs = (await visibleDialogLocators(page)).length
    if (visibleDialogs <= baselineVisibleDialogs) {
      const feedback = await readMediaApplyFeedback(page, null, "batch-resize")
      if (feedback.state === "failure") {
        return feedback
      }

      if (isSameDianxiaomiEditPage(beforeUrl, page.url())) {
        return {
          state: "success",
          message: "batch resize dialog closed and returned to the listing editor",
          source: "dialog-close"
        }
      }
    }

    await page.waitForTimeout(250)
  }

  return null
}

const inspectMediaSurface = async (
  page: Page,
  tool: Pick<MediaToolDefinition, "keywords" | "label">
): Promise<MediaSurfaceInspection> => {
  const dialog = await getLatestMediaDialog(page)
  if (!dialog) {
    return {
      state: "missing",
      matchedKeyword: null,
      text: normalizeFeedbackText(await page.locator("body").innerText().catch(() => ""))
    }
  }

  const text = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
  const matchedKeyword = keywordMatch(text, tool.keywords)
  return {
    state: matchedKeyword ? "matched" : "mismatched",
    matchedKeyword,
    text
  }
}

// P0-D + P0-F: apply path for instant-action tools (e.g. 一键翻译, 图片检测).
// The tool entry has already been clicked before this is called. We:
//   1) snapshot the listing image signature (P0-F evidence baseline)
//   2) wait for an in-page success/failure keyword
//   3) snapshot the image signature again
//   4) record whether the listing image DOM actually changed
//   5) declare `applied=true` only when keyword success AND signature delta
const applyInstantMediaAction = async (
  page: Page,
  tool: MediaToolSafetyItem,
  options: Pick<RunnerOptions, "screenshotDir">
) => {
  const signatureBefore = await collectImageSignature(page)
  tool.imageSignatureBefore = signatureBefore
  tool.beforeApplyScreenshotPath = await captureMediaScreenshot(page, options.screenshotDir, "media-before-apply", tool.id)

  const feedback = await waitForInstantActionFeedback(page, 8_000)
  const signatureAfter = await collectImageSignature(page)
  tool.imageSignatureAfter = signatureAfter
  tool.imageSignatureChanged = signatureBefore !== signatureAfter
  tool.afterApplyScreenshotPath = await captureMediaScreenshot(page, options.screenshotDir, "media-after-apply", tool.id)
  tool.feedbackState = feedback.state
  tool.feedbackMessage = feedback.message
  tool.feedbackSource = feedback.source
  if (tool.id === "image-management") {
    tool.imageCheckIssues = extractImageCheckIssues(feedback.message)
  }

  if (tool.id === "image-management" && (tool.imageCheckIssues?.length ?? 0) > 0) {
    tool.applied = false
    tool.status = "apply-failed"
    tool.reason = `${tool.label} found categorized image issues: ${tool.imageCheckIssues!.map((issue) => `${issue.category} ${issue.issue}`).join(", ")}`
    tool.failureKind = "invalid-media"
    tool.retryable = false
    tool.error = feedback.message || tool.reason
    return false
  }

  if (feedback.state === "failure") {
    const failure = classifyMediaFailure(feedback.message || "media instant action returned failure feedback")
    tool.applied = false
    tool.status = "apply-failed"
    tool.reason = `${tool.label} instant action returned failure feedback: ${feedback.message}`
    tool.failureKind = failure.failureKind
    tool.retryable = failure.retryable
    tool.error = feedback.message
    return false
  }

  if (feedback.state === "success") {
    if (tool.imageSignatureChanged === true) {
      tool.applied = true
      tool.status = "applied"
      tool.reason = `${tool.label} instant action verified by listing image signature change`
      tool.failureKind = undefined
      tool.retryable = false
      tool.error = null
      return true
    }

    // Keyword success but signature unchanged — possible if the tool did
    // something we don't measure (translation, detection). Record the gap
    // and still treat as applied.
    tool.applied = true
    tool.status = "applied"
    tool.reason = `${tool.label} instant action reported success but listing image signature did not change`
    tool.failureKind = "image-unchanged"
    tool.retryable = false
    tool.error = null
    return true
  }

  // unknown — no positive or negative keyword within the timeout.
  tool.applied = false
  tool.status = "apply-failed"
  tool.reason = `${tool.label} instant action did not produce a recognizable success/failure keyword within 8s`
  tool.failureKind = "image-unchanged"
  tool.retryable = false
  tool.error = "no instant action feedback detected"
  return false
}

const closeMediaSurfaceIfOpen = async (
  page: Page,
  config: DianxiaomiSelectorConfig = {},
  tool?: Pick<MediaToolDefinition, "configKey">
) => {
  const dialogs = await visibleModalCandidates(page)
  const surface = dialogs[dialogs.length - 1]
  if (!surface) {
    return false
  }

  const surfaceText = normalizeFeedbackText(await surface.innerText().catch(() => ""))
  const parsedTranslationFeedback = parseImageTranslationFeedback(surfaceText)
  const looksLikeImageTranslationResultSurface =
    parsedTranslationFeedback.mentionsTranslationSummary
    || parsedTranslationFeedback.inProgress
    || Boolean(keywordMatch(surfaceText, IMAGE_TRANSLATION_RESULT_DIALOG_HINTS))
    || Boolean(keywordMatch(surfaceText, IMAGE_TRANSLATION_RESULT_READY_KEYWORDS))

  const closeButton = (tool
    ? await findByConfiguredSelectorsInRoot(surface, getConfiguredMediaActionSelectors(config, "close", tool))
    : null)
    ?? await firstVisible([
      surface.locator("button").filter({ hasText: /^(?:关闭|关 闭|close|cancel|返回)$/i }),
      surface.locator("[role='button']").filter({ hasText: /^(?:关闭|关 闭|close|cancel|返回)$/i }),
      surface.locator("a").filter({ hasText: /^(?:关闭|关 闭|close|cancel|返回)$/i })
    ])
    ?? await findInteractiveInRootByKeywords(surface, MEDIA_CLOSE_KEYWORDS)
    ?? await firstVisible([
      surface.locator("[aria-label*='close' i]"),
      surface.locator("[title*='close' i]"),
      surface.locator(".ant-modal-close, .el-dialog__headerbtn, .modal-close, [class*='close' i]")
    ])
    ?? (looksLikeImageTranslationResultSurface
      ? await findInteractiveInRootByKeywords(surface, IMAGE_TRANSLATION_RESULT_CONFIRM_KEYWORDS)
      : null)
    ?? await findLastVisibleActionInRoot(surface)

  if (!closeButton) {
    return false
  }

  const targetDialogCount = Math.max(0, dialogs.length - 1)
  await clickAfterDianxiaomiIdle(page, closeButton, 2)
  return waitForVisibleDialogCountAtMost(page, targetDialogCount)
}

const closeMediaSurfaceStackToBaseline = async (
  page: Page,
  baselineVisibleDialogs: number,
  config: DianxiaomiSelectorConfig = {},
  tool?: Pick<MediaToolDefinition, "configKey">
) => {
  let currentDialogCount = (await getPageSafetyState(page)).visibleDialogCount
  let attempts = 0

  while (currentDialogCount > baselineVisibleDialogs && attempts < 4) {
    const closed = await closeMediaSurfaceIfOpen(page, config, tool)
    await page.waitForTimeout(300)
    const nextDialogCount = (await getPageSafetyState(page)).visibleDialogCount
    attempts += 1

    if (!closed && nextDialogCount >= currentDialogCount) {
      break
    }

    currentDialogCount = nextDialogCount
  }

  return (await getPageSafetyState(page)).visibleDialogCount <= baselineVisibleDialogs
}

const captureMediaScreenshot = async (page: Page, screenshotDir: string, prefix: string, toolId: string) => {
  const screenshotPath = path.join(
    screenshotDir,
    `${prefix}-${safeArtifactName(toolId)}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`
  )
  await page.screenshot({
    path: screenshotPath,
    fullPage: true
  })
  return screenshotPath
}

const sortMediaToolsForExecution = (tools: MediaToolSafetyItem[], requestedTools: string[] = []) => {
  const requestedOrder = new Map(
    requestedTools
      .map((tool) => tool.trim())
      .filter(Boolean)
      .flatMap((tool, index) => [[tool, index]] as Array<[string, number]>)
  )

  if (requestedOrder.size === 0) {
    return tools
  }

  return [...tools].sort((left, right) => {
    const leftOrder = Math.min(
      requestedOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER,
      requestedOrder.get(left.configKey) ?? Number.MAX_SAFE_INTEGER
    )
    const rightOrder = Math.min(
      requestedOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER,
      requestedOrder.get(right.configKey) ?? Number.MAX_SAFE_INTEGER
    )

    return leftOrder - rightOrder
  })
}

const buildMediaProcessingSafetyPlan = async (
  page: Page,
  config: DianxiaomiSelectorConfig = {},
  options?: Pick<RunnerOptions, "mediaAutomationMode" | "mediaAutomationTools">
): Promise<MediaProcessingSafetyPlan> => {
  const pageState = await getPageSafetyState(page)
  const candidates = await collectMediaToolCandidates(page, config)
  const safeMode = options?.mediaAutomationMode ?? "plan-only"
  const allowedTools = new Set((options?.mediaAutomationTools ?? []).map((tool) => tool.trim()).filter(Boolean))
  const allowAllTools = allowedTools.size === 0
  const tools = sortMediaToolsForExecution(candidates.map<MediaToolSafetyItem>((candidate) => {
    const available = Boolean(candidate.locator)
    const blockedByDialog = pageState.visibleDialogCount > 0
    const allowedForUnattended = allowAllTools || allowedTools.has(candidate.id) || allowedTools.has(candidate.configKey)
    const status: MediaToolSafetyStatus = !available
      ? "missing-tool"
      : blockedByDialog
        ? "blocked-by-open-dialog"
        : safeMode === "unattended-apply" && allowedForUnattended
        ? "ready-for-unattended-apply"
        : safeMode === "unattended-open" && allowedForUnattended
          ? "ready-for-unattended-open"
          : "manual-confirmation-required"
    const reason = !available
      ? `${candidate.label} entry is not visible on the current surface`
      : blockedByDialog
        ? `${candidate.label} was found, but an open dialog must be resolved before using image tools`
        : status === "ready-for-unattended-apply"
          ? `${candidate.label} is available and allowed for unattended apply`
        : status === "ready-for-unattended-open"
          ? `${candidate.label} is available and allowed for unattended entry opening`
          : `${candidate.label} is available; unattended mode did not include this tool`

    return {
      id: candidate.id,
      configKey: candidate.configKey,
      label: candidate.label,
      available,
      selectorConfigured: candidate.selectorConfigured,
      status,
      reason,
      requiresManualConfirmation: status === "manual-confirmation-required",
      wouldClick: status === "ready-for-unattended-open" || status === "ready-for-unattended-apply",
      wouldApply: status === "ready-for-unattended-apply",
      clicked: false,
      applied: false,
      locator: candidate.locatorDescriptor
    }
  }), options?.mediaAutomationTools)
  const availableCount = tools.filter((tool) => tool.available).length
  const blocked = tools.some((tool) => tool.status === "blocked-by-open-dialog")

  return {
    safeMode,
    wouldClick: tools.some((tool) => tool.wouldClick),
    wouldApply: tools.some((tool) => tool.wouldApply),
    guardStatus: blocked ? "blocked" : availableCount > 0 ? "manual-ready" : "no-tools",
    manualConfirmationRequired: tools.some((tool) => tool.requiresManualConfirmation),
    pageState,
    tools
  }
}

const openUnattendedMediaTools = async (
  page: Page,
  config: DianxiaomiSelectorConfig = {},
  options: Pick<RunnerOptions, "mediaAutomationMode" | "mediaAutomationTools" | "screenshotDir">
): Promise<MediaProcessingSafetyPlan> => {
  const plan = await buildMediaProcessingSafetyPlan(page, config, options)

  if (options.mediaAutomationMode !== "unattended-open" || plan.guardStatus === "blocked") {
    return plan
  }

  for (const tool of plan.tools) {
    if (!tool.wouldClick) {
      continue
    }

    const candidates = await collectMediaToolCandidates(page, config)
    const candidate = candidates.find((item) => item.id === tool.id)
    if (!candidate?.locator) {
      tool.status = "missing-tool"
      tool.reason = `${tool.label} entry disappeared before unattended open`
      tool.wouldClick = false
      continue
    }

    tool.beforeUrl = page.url()
    tool.beforeDialogCount = (await getPageSafetyState(page)).visibleDialogCount

    try {
      await clickAfterDianxiaomiIdle(page, candidate.locator)
      await page.waitForTimeout(800)
      const afterState = await getPageSafetyState(page)
      const screenshotPath = path.join(
        options.screenshotDir,
        `media-open-${safeArtifactName(tool.id)}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`
      )
      await page.screenshot({
        path: screenshotPath,
        fullPage: true
      })

      tool.clicked = true
      tool.status = "opened"
      tool.reason = `${tool.label} entry opened in unattended mode; internal apply/save actions were not clicked`
      tool.afterUrl = page.url()
      tool.afterDialogCount = afterState.visibleDialogCount
      tool.screenshotPath = screenshotPath
      tool.error = null
    } catch (error) {
      tool.clicked = false
      tool.status = "open-failed"
      tool.reason = `${tool.label} could not be opened in unattended mode`
      tool.afterUrl = page.url()
      tool.afterDialogCount = (await getPageSafetyState(page)).visibleDialogCount
      tool.screenshotPath = null
      tool.error = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    ...plan,
    wouldClick: plan.tools.some((tool) => tool.clicked),
    wouldApply: plan.tools.some((tool) => tool.applied),
    manualConfirmationRequired: plan.tools.some((tool) => tool.requiresManualConfirmation)
  }
}

const applyUnattendedMediaTools = async (
  page: Page,
  config: DianxiaomiSelectorConfig = {},
  options: Pick<RunnerOptions, "mediaAutomationMode" | "mediaAutomationTools" | "screenshotDir">
): Promise<MediaProcessingSafetyPlan> => {
  const plan = await buildMediaProcessingSafetyPlan(page, config, options)

  if (options.mediaAutomationMode !== "unattended-apply" || plan.guardStatus === "blocked") {
    return plan
  }

  let blockedByPriorFailure = false
  for (const tool of plan.tools) {
    if (!tool.wouldApply) {
      continue
    }

    if (blockedByPriorFailure) {
      tool.status = "blocked-by-media-failure"
      tool.reason = `${tool.label} was not attempted because a previous media tool failed`
      tool.wouldClick = false
      tool.wouldApply = false
      tool.clicked = false
      tool.applied = false
      tool.failureKind = "unknown"
      tool.retryable = false
      continue
    }

    const currentState = await getPageSafetyState(page)
    if (currentState.visibleDialogCount > 0) {
      tool.status = "blocked-by-open-dialog"
      tool.reason = `${tool.label} was skipped because another media surface is still open`
      tool.wouldClick = false
      tool.wouldApply = false
      tool.beforeDialogCount = currentState.visibleDialogCount
      tool.failureKind = "return-blocked"
      tool.retryable = false
      continue
    }

    const candidates = await collectMediaToolCandidates(page, config)
    const candidate = candidates.find((item) => item.id === tool.id)
    if (!candidate?.locator) {
      tool.status = "missing-tool"
      tool.reason = `${tool.label} entry disappeared before unattended apply`
      tool.wouldClick = false
      tool.wouldApply = false
      continue
    }

    tool.beforeUrl = page.url()
    tool.beforeDialogCount = (await getPageSafetyState(page)).visibleDialogCount

    try {
      await clickAfterDianxiaomiIdle(page, candidate.locator)
      await page.waitForTimeout(800)
      const afterOpenState = await getPageSafetyState(page)
      tool.clicked = true
      tool.afterUrl = page.url()
      tool.afterDialogCount = afterOpenState.visibleDialogCount
      tool.screenshotPath = await captureMediaScreenshot(page, options.screenshotDir, "media-open", tool.id)

      // P0-D: instant-action tools (image-translation, image-management) act
      // on the page in place rather than opening a closeable dialog. When no
      // dialog appears and the tool is in the instant-action allowlist, hand
      // off to the instant apply path and skip the dialog/apply-button flow.
      if (INSTANT_ACTION_TOOL_IDS.has(tool.id) && afterOpenState.visibleDialogCount === 0) {
        tool.surfaceState = "missing"
        const instantApplied = await applyInstantMediaAction(page, tool, options)
        tool.feedbackAttempts = []
        tool.maxApplyAttempts = 1
        if (!instantApplied) {
          blockedByPriorFailure = true
        }
        continue
      }

      if (tool.id === "batch-resize") {
        const prepared = await prepareBatchResizeDialog(page, tool)
        const mediaSurface = await getLatestMediaDialog(page)
        tool.surfaceState = prepared ? "matched" : "mismatched"
        tool.surfaceMatchedKeyword = prepared ? "batch-resize-controls" : null
        tool.surfaceText = mediaSurface ? normalizeFeedbackText(await mediaSurface.innerText().catch(() => "")) : ""
      } else {
        const surfaceInspection = await inspectMediaSurface(page, candidate)
        tool.surfaceState = surfaceInspection.state
        tool.surfaceMatchedKeyword = surfaceInspection.matchedKeyword
        tool.surfaceText = surfaceInspection.text
      }

      if (tool.surfaceState !== "matched") {
        const failure = tool.surfaceState === "missing"
          ? { failureKind: "surface-missing" as const, retryable: false }
          : { failureKind: "surface-mismatch" as const, retryable: false }
        tool.applied = false
        tool.status = "apply-failed"
        tool.reason = tool.surfaceState === "missing"
          ? `${tool.label} entry was clicked, but no media surface opened`
          : `${tool.label} entry opened an unexpected media surface`
        tool.beforeApplyScreenshotPath = await captureMediaScreenshot(page, options.screenshotDir, "media-surface-mismatch", tool.id)
        tool.failureKind = failure.failureKind
        tool.retryable = failure.retryable
        tool.error = tool.surfaceState === "missing" ? "media surface missing" : "media surface mismatch"
        await closeMediaSurfaceStackToBaseline(page, tool.beforeDialogCount ?? 0, config, tool)
        await page.waitForTimeout(500)
        tool.returnDialogCount = (await getPageSafetyState(page)).visibleDialogCount
        blockedByPriorFailure = true
        continue
      }

      if (tool.id === "batch-resize" && tool.preparation?.prepared !== true) {
        const failure = classifyMediaFailure("batch resize preparation failed", "missing-input")
        tool.applied = false
        tool.status = "apply-failed"
        tool.reason = `${tool.label} dialog opened, but required resize inputs could not be prepared`
        tool.beforeApplyScreenshotPath = await captureMediaScreenshot(page, options.screenshotDir, "media-prepare-failed", tool.id)
        tool.failureKind = failure.failureKind
        tool.retryable = failure.retryable
        tool.error = "batch resize preparation failed"
        await closeMediaSurfaceStackToBaseline(page, tool.beforeDialogCount ?? 0, config, tool)
        await page.waitForTimeout(500)
        tool.returnDialogCount = (await getPageSafetyState(page)).visibleDialogCount
        blockedByPriorFailure = true
        continue
      }

      const mediaSurface = await getLatestMediaDialog(page)
      // The 批量编辑 (image editor) dialog requires images to be selected before
      // the 确定 apply button does anything; clicking apply with 已选中：0 returns
      // "请选择要编辑的图片". batch-resize handles this inside prepareBatchResizeDialog,
      // so only the image-editor dialog path needs the explicit 选择全部 tick here.
      if (tool.id === "image-editor" && mediaSurface) {
        tool.selectAllChecked = await ensureCheckboxNearText(mediaSurface, "选择全部", true)
      }
      const applyButton = await findMediaApplyButtonForTool(page, config, tool)
      tool.applyButton = await describeLocator(applyButton)
      if (!applyButton) {
        const failure = classifyMediaFailure("apply button missing", "apply-control-missing")
        tool.status = "apply-failed"
        tool.reason = `${tool.label} was opened, but no safe internal apply button was detected`
        tool.beforeApplyScreenshotPath = await captureMediaScreenshot(page, options.screenshotDir, "media-apply-missing", tool.id)
        tool.applyAttempts = 0
        tool.maxApplyAttempts = MEDIA_TRANSIENT_MAX_APPLY_ATTEMPTS
        tool.feedbackAttempts = []
        tool.failureKind = failure.failureKind
        tool.retryable = failure.retryable
        tool.error = "apply button missing"
        await closeMediaSurfaceStackToBaseline(page, tool.beforeDialogCount ?? 0, config, tool)
        await page.waitForTimeout(500)
        tool.returnDialogCount = (await getPageSafetyState(page)).visibleDialogCount
        blockedByPriorFailure = true
        continue
      }

      tool.beforeApplyScreenshotPath = await captureMediaScreenshot(page, options.screenshotDir, "media-before-apply", tool.id)
      // P0-F: capture listing image signature before apply. Soft evidence
      // for dialog-based tools (recorded, not enforced). The instant-action
      // branch enforces this delta in `applyInstantMediaAction`.
      tool.imageSignatureBefore = await collectImageSignature(page)
      tool.maxApplyAttempts = MEDIA_TRANSIENT_MAX_APPLY_ATTEMPTS
      tool.feedbackAttempts = []

      let feedback: MediaApplyFeedback = {
        state: "unknown",
        message: "",
        source: "none"
      }
      let failure: ReturnType<typeof classifyMediaFailure> | null = null
      let previousFeedback: MediaApplyFeedback | null = null
      const imageTranslationQuotaBefore = tool.id === "image-translation"
        ? extractImageTranslationQuotaCount(await mediaSurface.innerText().catch(() => ""))
        : null

      for (let attempt = 1; attempt <= MEDIA_TRANSIENT_MAX_APPLY_ATTEMPTS; attempt += 1) {
        tool.applyAttempts = attempt
        await clickAfterDianxiaomiIdle(page, applyButton)
        if (tool.id === "image-translation") {
          await completeImageTranslationFinalActionIfPresent(page, applyButton)
        }
        feedback = tool.id === "batch-resize"
          ? await waitForBatchResizeCompletion(
            page,
            mediaSurface,
            BATCH_RESIZE_TARGET_SIDE_PX,
            BATCH_RESIZE_COMPLETION_TIMEOUT_MS,
            previousFeedback
          )
          : await waitForMediaApplyFeedback(page, mediaSurface, tool.id === "image-translation" ? 90_000 : 8_000, tool.id, previousFeedback)
        if (tool.id === "batch-resize" && feedback.state === "unknown") {
          const returnToEditorFeedback = await waitForBatchResizeReturnToEditor(
            page,
            tool.beforeDialogCount ?? 0,
            tool.beforeUrl
          )
          if (returnToEditorFeedback) {
            feedback = returnToEditorFeedback
          }
        }
        if (tool.id === "image-translation" && feedback.state === "unknown") {
          const quotaFeedback = await waitForImageTranslationSubmissionSignal(page, mediaSurface, imageTranslationQuotaBefore, 8_000)
          if (quotaFeedback) {
            feedback = quotaFeedback
          }
        }
        if (tool.id === "image-translation" && shouldWaitForImageTranslationResultDialog(feedback)) {
          const resultDialogFeedback = await waitForImageTranslationResultDialog(page, 180_000)
          if (resultDialogFeedback) {
            feedback = resultDialogFeedback
          }
        }
        previousFeedback = feedback

        failure = feedback.state === "success"
          ? null
          : classifyMediaFailure(feedback.message || "media apply success feedback not detected")
        tool.feedbackAttempts.push({
          attempt,
          ...feedback,
          ...(failure
            ? {
                failureKind: failure.failureKind,
                retryable: failure.retryable
              }
            : {})
        })

        tool.feedbackState = feedback.state
        tool.feedbackMessage = feedback.message
        tool.feedbackSource = feedback.source

        if (feedback.state === "success") {
          break
        }

        const shouldRetry = failure?.failureKind === "transient"
          && failure.retryable
          && attempt < MEDIA_TRANSIENT_MAX_APPLY_ATTEMPTS
        if (!shouldRetry) {
          break
        }

        await page.waitForTimeout(1500)
      }

      tool.afterApplyScreenshotPath = await captureMediaScreenshot(page, options.screenshotDir, "media-after-apply", tool.id)

      if (feedback.state !== "success") {
        failure = failure ?? classifyMediaFailure(feedback.message || "media apply success feedback not detected")
        tool.applied = false
        tool.status = "apply-failed"
        tool.reason = feedback.state === "failure"
          ? `${tool.label} internal apply returned failure feedback`
          : `${tool.label} internal apply feedback was not confirmed as successful`
        tool.failureKind = failure.failureKind
        tool.retryable = failure.retryable
        tool.error = feedback.message || "media apply success feedback not detected"
        await closeMediaSurfaceStackToBaseline(page, tool.beforeDialogCount ?? 0, config, tool)
        await page.waitForTimeout(500)
        tool.returnDialogCount = (await getPageSafetyState(page)).visibleDialogCount
        blockedByPriorFailure = true
        continue
      }

      tool.applied = true
      if (tool.id === "image-translation") {
        await finalizeImageTranslationResultIfPresent(page)
      }

      await closeMediaSurfaceStackToBaseline(page, tool.beforeDialogCount ?? 0, config, tool)
      await page.waitForTimeout(500)
      tool.returnDialogCount = (await getPageSafetyState(page)).visibleDialogCount
      // P0-F: capture listing image signature after apply. Soft evidence for
      // dialog-based tools (recorded, not enforced). The instant-action
      // branch enforces this delta in `applyInstantMediaAction`.
      tool.imageSignatureAfter = await collectImageSignature(page)
      tool.imageSignatureChanged = tool.imageSignatureBefore !== tool.imageSignatureAfter
      if ((tool.returnDialogCount ?? 0) > 0) {
        const failure = classifyMediaFailure("media surface remained open after apply", "return-blocked")
        tool.status = "return-failed"
        tool.reason = `${tool.label} internal apply completed, but the media surface is still open`
        tool.failureKind = failure.failureKind
        tool.retryable = failure.retryable
        tool.error = "media surface remained open after apply"
      } else {
        tool.status = "applied"
        tool.reason = `${tool.label} was opened, applied, screenshotted, and returned to the listing editor in unattended mode`
        tool.error = null
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failure = classifyMediaFailure(message)
      tool.clicked = Boolean(tool.clicked)
      tool.applied = false
      tool.status = tool.clicked ? "apply-failed" : "open-failed"
      tool.reason = `${tool.label} could not be completed in unattended apply mode`
      tool.afterUrl = page.url()
      tool.afterDialogCount = (await getPageSafetyState(page)).visibleDialogCount
      tool.failureKind = failure.failureKind
      tool.retryable = failure.retryable
      tool.error = message
      blockedByPriorFailure = true
    }
  }

  return {
    ...plan,
    wouldClick: plan.tools.some((tool) => tool.clicked),
    wouldApply: plan.tools.some((tool) => tool.applied),
    manualConfirmationRequired: plan.tools.some((tool) => tool.requiresManualConfirmation),
    guardStatus: plan.tools.some((tool) => tool.status === "blocked-by-open-dialog") ? "blocked" : plan.guardStatus
  }
}

export const inspectMediaTools = async (page: Page, config: DianxiaomiSelectorConfig = {}) => {
  const results: AutomationStepResult[] = []
  const candidates = await collectMediaToolCandidates(page, config)

  for (const tool of candidates) {
    results.push(stepResult(
      `inspect-media-${tool.id}`,
      `Inspect ${tool.label}`,
      tool.locator ? "done" : "skipped",
      tool.locator ? `${tool.label} tool signal found` : `${tool.label} tool signal not found`,
      {
        keywords: tool.keywords,
        selectorConfigured: tool.selectorConfigured,
        locator: tool.locatorDescriptor
      }
    ))
  }

  const foundTools = results.filter((step) => step.status === "done").map((step) => step.id.replace("inspect-media-", ""))
  results.push(stepResult(
    "inspect-media-summary",
    "Inspect media tools",
    foundTools.length > 0 ? "done" : "skipped",
    foundTools.length > 0
      ? `Dianxiaomi media tools found: ${foundTools.join(", ")}`
      : "No Dianxiaomi media tools found on the current surface",
    {
      foundTools,
      expectedTools: DIANXIAOMI_MEDIA_TOOLS.map((tool) => tool.id)
    }
  ))

  return results
}

export const planMediaProcessing = async (
  page: Page,
  config: DianxiaomiSelectorConfig = {},
  options?: Pick<RunnerOptions, "mediaAutomationMode" | "mediaAutomationTools" | "screenshotDir">
) => {
  const toolSteps = await inspectMediaTools(page, config)
  const safetyPlan = options?.mediaAutomationMode === "unattended-apply"
    ? await applyUnattendedMediaTools(page, config, options)
    : options?.mediaAutomationMode === "unattended-open"
      ? await openUnattendedMediaTools(page, config, options)
      : await buildMediaProcessingSafetyPlan(page, config, options)
  const foundTools = toolSteps
    .filter((step) => step.id.startsWith("inspect-media-") && step.status === "done")
    .map((step) => step.id.replace("inspect-media-", ""))
  const recommendedOrder = [
    "image-translation",
    "batch-resize"
  ]
  const availableActions = recommendedOrder.filter((tool) => foundTools.includes(tool))

  return stepResult(
    "media-processing-plan",
    "Media processing plan",
    safetyPlan.tools.some((tool) => ["open-failed", "apply-failed", "return-failed", "blocked-by-media-failure"].includes(tool.status))
      ? "failed"
      : safetyPlan.wouldClick || safetyPlan.wouldApply
        ? "done"
        : "skipped",
    availableActions.length > 0
      ? safetyPlan.safeMode === "unattended-open"
        ? `Media tools detected for native Dianxiaomi processing: ${availableActions.join(", ")}. Unattended mode opened allowed tool entries only; internal apply/save actions were not clicked.`
        : safetyPlan.safeMode === "unattended-apply"
          ? `Media tools detected for native Dianxiaomi processing: ${availableActions.join(", ")}. Unattended mode applied allowed tool entries when a safe internal apply button was detected.`
        : `Media tools detected for manual/native Dianxiaomi processing: ${availableActions.join(", ")}. Manual confirmation is required; automation does not click these tools yet.`
      : "No media tool entry was detected. Open Dianxiaomi image tools manually if image translation, resizing, white background, or editor review is required.",
    {
      foundTools,
      recommendedOrder,
      availableActions,
      safeMode: safetyPlan.safeMode,
      guardStatus: safetyPlan.guardStatus,
      manualConfirmationRequired: safetyPlan.manualConfirmationRequired,
      wouldClick: safetyPlan.wouldClick,
      wouldApply: safetyPlan.wouldApply,
      pageState: safetyPlan.pageState,
      tools: safetyPlan.tools
    }
  )
}

export const inspectMediaProcessingSafety = async (
  page: Page,
  config: DianxiaomiSelectorConfig = {},
  options?: Pick<RunnerOptions, "mediaAutomationMode" | "mediaAutomationTools">
) => {
  const safetyPlan = await buildMediaProcessingSafetyPlan(page, config, options)
  return stepResult(
    "media-processing-safety",
    "Media processing safety",
    safetyPlan.guardStatus === "blocked" ? "failed" : safetyPlan.guardStatus === "manual-ready" ? "done" : "skipped",
    safetyPlan.guardStatus === "blocked"
      ? "Media tool execution is blocked until open dialogs are resolved"
      : safetyPlan.guardStatus === "manual-ready"
      ? safetyPlan.safeMode === "unattended-open"
        ? "Media tools are available for unattended entry opening"
        : safetyPlan.safeMode === "unattended-apply"
          ? "Media tools are available for unattended internal apply"
        : "Media tools are available, but require manual confirmation before any click"
        : "No media tools are available for native Dianxiaomi image processing",
    safetyPlan
  )
}

const inspectRepairSingleField = async (
  page: Page,
  action: DianxiaomiProductRepairAction,
  config: DianxiaomiSelectorConfig
) => {
  const kind = action.payload?.fieldKind
  if (!kind || kind === "attribute") {
    return stepResult(
      `repair-preview-${action.id}`,
      `Repair preview ${action.label}`,
      "failed",
      `Repair action ${action.id} does not specify a supported single field`,
      {
        actionId: action.id,
        writer: action.payload?.writer ?? null,
        fieldKind: kind ?? null,
        target: action.target ?? null
      }
    )
  }

  const field = await findField(page, kind, config)
  return stepResult(
    `repair-preview-${action.id}`,
    `Repair preview ${action.label}`,
    field ? "done" : "failed",
    field ? `Repair target field is ready: ${kind}` : `Repair target field is missing: ${kind}`,
    {
      actionId: action.id,
      writer: action.payload?.writer,
      fieldKind: kind,
      selectorGroup: action.payload?.selectorGroup,
      selectorKey: action.payload?.selectorKey,
      target: action.target ?? null
    }
  )
}

const inspectRepairAttributes = async (
  page: Page,
  action: DianxiaomiProductRepairAction,
  draft: ListingDraft,
  config: DianxiaomiSelectorConfig
) => {
  const attributeKey = action.payload?.attributeKey?.trim()
  const draftAttributes = draft.attributes ?? {}
  const keysToCheck = attributeKey ? [attributeKey] : Object.keys(draftAttributes)
  const existingDraftKeys = keysToCheck.filter((key) => Object.prototype.hasOwnProperty.call(draftAttributes, key))
  const keywordSource = existingDraftKeys.length > 0 ? existingDraftKeys : keysToCheck
  const keywords = Array.from(new Set(keywordSource.flatMap((key) => ATTRIBUTE_ALIASES[key] ?? [key])))
    .map((keyword) => keyword.trim())
    .filter(Boolean)
  const field = await findByConfiguredSelectors(page, config.fields?.attribute)
    ?? (keywords.length > 0 ? await findFieldByKeyword(page, keywords) : await findField(page, "attribute", config))
  const hasKnownValue = !attributeKey || existingDraftKeys.length > 0
  const status: StepStatus = field && hasKnownValue ? "done" : "failed"
  const detail = !hasKnownValue
    ? `Repair attribute has no known draft value: ${attributeKey}`
    : field
      ? `Repair attribute target is ready: ${attributeKey || "draft attributes"}`
      : `Repair attribute field is missing: ${attributeKey || "draft attributes"}`

  return stepResult(
    `repair-preview-${action.id}`,
    `Repair preview ${action.label}`,
    status,
    detail,
    {
      actionId: action.id,
      writer: action.payload?.writer,
      attributeKey: attributeKey || null,
      target: action.target ?? null,
      hasKnownValue,
      knownDraftKeys: existingDraftKeys,
      selectorGroup: action.payload?.selectorGroup,
      selectorKey: action.payload?.selectorKey
    }
  )
}

const inspectRepairSkuPricing = async (
  page: Page,
  action: DianxiaomiProductRepairAction,
  draft: ListingDraft,
  config: DianxiaomiSelectorConfig
) => {
  const rows = await findSkuRows(page, config)
  const globalPrice = rows.length > 0 ? null : await findField(page, "price", config)
  const globalStock = rows.length > 0 ? null : await findField(page, "stock", config)
  const ready = draft.skuPricing.length > 0 && (rows.length > 0 || Boolean(globalPrice || globalStock))

  return stepResult(
    `repair-preview-${action.id}`,
    `Repair preview ${action.label}`,
    ready ? "done" : "failed",
    ready
      ? `SKU repair target is ready: ${rows.length} row(s), ${draft.skuPricing.length} draft SKU(s)`
      : "SKU repair target is missing rows or draft SKU pricing",
    {
      actionId: action.id,
      writer: action.payload?.writer,
      skuMode: action.payload?.skuMode,
      expectedSkuCount: draft.skuPricing.length,
      detectedRows: rows.length,
      globalPriceField: Boolean(globalPrice),
      globalStockField: Boolean(globalStock),
      selectorGroup: action.payload?.selectorGroup,
      selectorKey: action.payload?.selectorKey
    }
  )
}

const inspectRepairMediaTool = async (
  page: Page,
  action: DianxiaomiProductRepairAction,
  config: DianxiaomiSelectorConfig
) => {
  const mediaTool = action.payload?.mediaTool
  const candidates = await collectMediaToolCandidates(page, config)
  const candidate = mediaTool
    ? candidates.find((item) => item.configKey === mediaTool)
    : null

  return stepResult(
    `repair-preview-${action.id}`,
    `Repair preview ${action.label}`,
    candidate?.locator ? "done" : "failed",
    candidate?.locator
      ? `Repair media tool is ready: ${mediaTool}`
      : `Repair media tool is missing: ${mediaTool ?? "unknown"}`,
    {
      actionId: action.id,
      writer: action.payload?.writer,
      mediaTool: mediaTool ?? null,
      selectorConfigured: candidate?.selectorConfigured ?? false,
      locator: candidate?.locatorDescriptor ?? null,
      selectorGroup: action.payload?.selectorGroup,
      selectorKey: action.payload?.selectorKey
    }
  )
}

const inspectRepairAction = async (
  page: Page,
  action: DianxiaomiProductRepairAction,
  draft: ListingDraft,
  config: DianxiaomiSelectorConfig
) => {
  const writer = action.payload?.writer
  if (writer === "fill-single-field") {
    return inspectRepairSingleField(page, action, config)
  }

  if (writer === "fill-attributes") {
    return inspectRepairAttributes(page, action, draft, config)
  }

  if (writer === "fill-sku-pricing") {
    return inspectRepairSkuPricing(page, action, draft, config)
  }

  if (writer === "run-media-tool") {
    return inspectRepairMediaTool(page, action, config)
  }

  return stepResult(
    `repair-preview-${action.id}`,
    `Repair preview ${action.label}`,
    "skipped",
    writer
      ? `Repair writer is not executable in browser preview: ${writer}`
      : "Repair action has no executable payload",
    {
      actionId: action.id,
      writer: writer ?? null,
      actionType: action.type,
      automation: action.automation,
      target: action.target ?? null
    }
  )
}

const repairApplyResult = (
  action: DianxiaomiProductRepairAction,
  status: StepStatus,
  detail: string,
  data?: Record<string, unknown>
) => stepResult(
  `repair-apply-${action.id}`,
  `Repair apply ${action.label}`,
  status,
  detail,
  {
    actionId: action.id,
    actionType: action.type,
    automation: action.automation,
    required: action.required,
    writer: action.payload?.writer ?? null,
    target: action.target ?? null,
    ...data
  }
)

const valueForRepairSingleField = (
  action: DianxiaomiProductRepairAction,
  draft: ListingDraft
) => {
  const expectedValue = action.payload?.expectedValue?.trim()
  if (expectedValue) {
    return expectedValue
  }

  const kind = action.payload?.fieldKind
  if (kind === "title") {
    return draft.listingTitle
  }

  if (kind === "description") {
    return draft.description
  }

  if (kind === "price") {
    return draft.skuPricing[0]?.salePriceUsd.toFixed(2)
  }

  if (kind === "stock") {
    return draft.skuPricing[0] ? String(draft.skuPricing[0].stock) : undefined
  }

  return undefined
}

const applyRepairSingleField = async (
  page: Page,
  action: DianxiaomiProductRepairAction,
  draft: ListingDraft,
  config: DianxiaomiSelectorConfig
) => {
  const kind = action.payload?.fieldKind
  if (!kind || kind === "attribute") {
    return repairApplyResult(action, "skipped", `Single-field repair is blocked for unsupported field: ${kind ?? "missing"}`, {
      fieldKind: kind ?? null
    })
  }

  const value = valueForRepairSingleField(action, draft)
  if (!value?.trim()) {
    return repairApplyResult(action, "skipped", `Single-field repair has no known safe value for ${kind}`, {
      fieldKind: kind,
      hasExpectedValue: Boolean(action.payload?.expectedValue?.trim())
    })
  }

  const written = await fillSingleField(page, kind, value, config)
  return repairApplyResult(
    action,
    written.status,
    written.status === "done"
      ? `Applied ${kind} from known task data`
      : `Could not apply ${kind}: ${written.detail}`,
    {
      fieldKind: kind,
      source: action.payload?.expectedValue?.trim() ? "repair-plan" : "task-draft",
      valueLength: value.length,
      writerResult: written
    }
  )
}

const applyRepairAttributes = async (
  page: Page,
  action: DianxiaomiProductRepairAction,
  draft: ListingDraft,
  config: DianxiaomiSelectorConfig
) => {
  const attributeKey = action.payload?.attributeKey?.trim()
  const draftAttributes = draft.attributes ?? {}
  const expectedValue = action.payload?.expectedValue?.trim()
  const draftValue = attributeKey ? draftAttributes[attributeKey]?.trim() : undefined
  const knownValue = draftValue || expectedValue
  if (!attributeKey || !knownValue?.trim()) {
    return repairApplyResult(action, "skipped", attributeKey
      ? `Attribute repair has no known safe value: ${attributeKey}`
      : "Attribute repair is blocked because no specific attribute key was provided", {
      attributeKey: attributeKey ?? null,
      hasExpectedValue: Boolean(expectedValue)
    })
  }

  const narrowDraft: ListingDraft = {
    ...draft,
    attributes: {
      [attributeKey]: knownValue
    }
  }
  const written = await fillAttributes(page, narrowDraft, config)
  return repairApplyResult(
    action,
    written.status,
    written.status === "done"
      ? `Applied attribute ${attributeKey} from known task data`
      : `Could not apply attribute ${attributeKey}: ${written.detail}`,
    {
      attributeKey,
      source: draftValue ? "task-draft" : "repair-plan",
      valueLength: knownValue.length,
      writerResult: written
    }
  )
}

const applyRepairSkuPricing = async (
  page: Page,
  action: DianxiaomiProductRepairAction,
  draft: ListingDraft,
  config: DianxiaomiSelectorConfig
) => {
  if (draft.skuPricing.length === 0) {
    return repairApplyResult(action, "skipped", "SKU repair has no known task SKU pricing")
  }

  const written = await fillSkuPricing(page, draft.skuPricing, config)
  return repairApplyResult(
    action,
    written.status,
    written.status === "done"
      ? `Applied SKU price/stock for ${draft.skuPricing.length} SKU(s)`
      : `Could not apply SKU price/stock: ${written.detail}`,
    {
      skuCount: draft.skuPricing.length,
      writerResult: written
    }
  )
}

const inferImageCheckIssuesFromRepairAction = (action: DianxiaomiProductRepairAction): ImageCheckIssue[] => {
  const candidates = [
    action.detail,
    action.payload?.expectedValue,
    [action.target, action.tool].filter(Boolean).join(" ")
  ]
    .map((value) => cleanVisibleText(value))
    .filter(Boolean)

  const issues = candidates.flatMap((value) => extractImageCheckIssues(value))
  if (issues.length > 0) {
    return uniqueImageCheckIssues(issues)
  }

  const match = cleanVisibleText(action.detail).match(/(.+?)\s+(非英文|非英语|中文|文字|水印|尺寸|比例|宽高|像素|大小|格式|过大|失效)$/)
  if (!match) {
    return []
  }

  return [{
    category: match[1].trim(),
    issue: match[2].trim(),
    detail: cleanVisibleText(action.detail)
  }]
}

const isImageCheckDirectSkuReplacementIssue = (issue: ImageCheckIssue) => {
  const combined = cleanVisibleText(`${issue.category} ${issue.issue} ${issue.detail ?? ""}`).toLowerCase()
  const normalizedIssue = cleanVisibleText(issue.issue).toLowerCase()
  const normalizedCategory = cleanVisibleText(issue.category).toLowerCase()

  const isSizeLike = normalizedIssue === "\u5c3a\u5bf8"
    || normalizedIssue === "\u6bd4\u4f8b"
    || normalizedIssue === "\u5bbd\u9ad8"
    || normalizedIssue === "\u50cf\u7d20"
    || /(?:\u5c3a\u5bf8|\u6bd4\u4f8b|\u5bbd\u9ad8|\u50cf\u7d20|size|ratio|aspect|resolution)/i.test(combined)
  const isSkuOrColorLike = normalizedCategory === "\u989c\u8272\u56fe"
    || normalizedCategory === "sku\u56fe"
    || /(?:\u989c\u8272\u56fe|sku\u56fe|color image|sku image)/i.test(combined)

  return isSizeLike && isSkuOrColorLike
}

const isImageCheckSquarePreviewReplacementIssue = (issue: ImageCheckIssue) => {
  const combined = cleanVisibleText(`${issue.category} ${issue.issue} ${issue.detail ?? ""}`).toLowerCase()
  const normalizedIssue = cleanVisibleText(issue.issue).toLowerCase()
  const normalizedCategory = cleanVisibleText(issue.category).toLowerCase()

  const isSizeLike = normalizedIssue === "\u5c3a\u5bf8"
    || normalizedIssue === "\u6bd4\u4f8b"
    || normalizedIssue === "\u5bbd\u9ad8"
    || normalizedIssue === "\u50cf\u7d20"
    || /(?:\u5c3a\u5bf8|\u6bd4\u4f8b|\u5bbd\u9ad8|\u50cf\u7d20|size|ratio|aspect|resolution)/i.test(combined)
  const isProductPreviewLike = normalizedCategory === "\u4ea7\u54c1\u56fe"
    || normalizedCategory === "\u4e3b\u56fe"
    || normalizedCategory === "\u7d20\u6750\u56fe"
    || normalizedCategory === "\u9884\u89c8\u56fe"
    || /(?:\u4ea7\u54c1\u56fe|\u4e3b\u56fe|\u7d20\u6750\u56fe|\u9884\u89c8\u56fe|product image|main image|material image|preview image)/i.test(combined)

  return isSizeLike && isProductPreviewLike
}

const inferImageCheckDirectReplacementMode = (
  issues: ImageCheckIssue[],
  directCandidates: ImageCheckSelectionCandidate[] = []
) => {
  const hasColorTypedCandidate = directCandidates.some((candidate) =>
    /(?:\u989c\u8272\u56fe|sku\u56fe|color image|sku image)/i.test(cleanVisibleText(candidate.imageType ?? candidate.label))
  )
  if (
    hasColorTypedCandidate
    && issues.some((issue) => isImageCheckSquarePreviewReplacementIssue(issue))
  ) {
    return "strict-color" as const
  }
  if (issues.some((issue) => isImageCheckSquarePreviewReplacementIssue(issue))) {
    return "square-preview-all-colors" as const
  }
  if (issues.some((issue) => isImageCheckDirectSkuReplacementIssue(issue))) {
    return "strict-color" as const
  }
  return null
}

const shouldUseDirectSkuReplacementFromImageCheck = (issues: ImageCheckIssue[]) =>
  inferImageCheckDirectReplacementMode(issues) !== null

const shouldRouteThroughImageCheckSelection = (
  mediaTool: string,
  reasonCode: string | undefined,
  issues: ImageCheckIssue[]
) =>
  mediaTool === "imageManagement"
  || (
    reasonCode === "requirement-image-check"
    && issues.length > 0
    && (
      mediaTool === "batchResize"
      || inferImageCheckDirectReplacementMode(issues) !== null
    )
  )

const collectVisibleListingImageCandidates = async (page: Page): Promise<string[]> =>
  page.evaluate((selector) => {
    const isVisible = (node: Element) => {
      if (!(node instanceof HTMLElement)) {
        return false
      }

      const style = window.getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
    }

    const urls = Array.from(document.querySelectorAll(selector))
      .filter((node) => isVisible(node))
      .map((node) => (node as HTMLImageElement).currentSrc || (node as HTMLImageElement).src || "")
      .map((value) => value.trim())
      .filter((value) => /^https?:\/\//i.test(value))

    return Array.from(new Set(urls))
  }, LISTING_IMAGE_SELECTOR).catch(() => [] as string[])

const buildSkuReplacementCandidateUrls = async (
  page: Page,
  dialog: Locator | null,
  issues: ImageCheckIssue[]
) => {
  const directCandidates = dialog ? await collectImageCheckSelectionCandidates(dialog) : []
  const candidateImageTypeHints = issues.some((issue) =>
    /(?:\u989c\u8272\u56fe|color image)/i.test(cleanVisibleText(`${issue.category} ${issue.detail ?? ""}`))
  )

  const directCardUrls = directCandidates
    .filter((candidate) => candidate.src)
    .filter((candidate) =>
      candidateImageTypeHints
        ? /(?:\u989c\u8272\u56fe|color image)/i.test(candidate.imageType ?? "")
        : true
    )
    .map((candidate) => candidate.src!.trim())
    .filter(Boolean)

  const listingImageUrls = await collectVisibleListingImageCandidates(page)
  return Array.from(new Set([
    ...directCardUrls,
    ...listingImageUrls
  ]))
}

const runImageManagementRepairSelection = async (
  page: Page,
  action: DianxiaomiProductRepairAction,
  draft: ListingDraft,
  config: DianxiaomiSelectorConfig,
  options: Pick<RunnerOptions, "screenshotDir"> | undefined,
  requestedIssues: ImageCheckIssue[]
) => {
  const repairPageUrl = page.url()
  const beforeDialogCount = (await getPageSafetyState(page)).visibleDialogCount
  let dialog: Locator | null = null
  let openScreenshotPath: string | null = null
  let afterOpenState = await getPageSafetyState(page)
  let openAttempts = 0

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    openAttempts = attempt
    await dismissSaveSuccessModalIfPresent(page)
    await waitForPublishPage(page, config, {
      waitForManualNavigation: false,
      targetUrl: page.url()
    })
    await waitForImageCheckPageToSettle(page, 12_000)
    const candidates = await collectMediaToolCandidates(page, config)
    const candidate = candidates.find((item) => item.id === "image-management")
    if (!candidate?.locator) {
      if (attempt === 3) {
        return stepResult(
          "repair-image-management-selection",
          "Repair image-check selection",
          "failed",
          "Image check entry disappeared before categorized repair selection",
          {
            requestedIssues,
            openAttempts
          }
        )
      }
      await page.waitForTimeout(1_000)
      continue
    }

    try {
      await clickAfterDianxiaomiIdle(page, candidate.locator)
    } catch {
      await page.waitForTimeout(1_000)
      continue
    }

    await waitForImageCheckPageToSettle(page, 12_000)
    await page.waitForTimeout(800)
    afterOpenState = await getPageSafetyState(page)
    openScreenshotPath = await captureMediaScreenshot(
      page,
      options?.screenshotDir ?? "output/playwright",
      "repair-image-check-open",
      "image-management"
    )
    dialog = await waitForImageCheckDialog(page, attempt === 1 ? 8_000 : 5_000)
    if (dialog) {
      break
    }

    await waitForImageCheckPageToSettle(page, 12_000)
    dialog = await waitForImageCheckDialog(page, 4_000)
    if (dialog) {
      break
    }

    await page.waitForTimeout(1_500)
  }

  if (!dialog) {
    return stepResult(
      "repair-image-management-selection",
      "Repair image-check selection",
      "failed",
      "Image check dialog did not open for categorized repair selection",
      {
        requestedIssues,
        beforeDialogCount,
        afterOpenState,
        openScreenshotPath,
        openAttempts
      }
    )
  }

  const surfaceText = normalizeFeedbackText(await dialog.innerText().catch(() => ""))
  const surfacedIssues = uniqueImageCheckIssues(extractImageCheckIssues(surfaceText))
  const positiveSummaryIssues = uniqueImageCheckIssues(extractPositiveImageCheckSummaryIssues(surfaceText))
  const requestedIssuesPresentInSummary = filterRequestedImageCheckIssuesBySummary(requestedIssues, positiveSummaryIssues)
  const effectiveIssues = requestedIssues.length > 0
    ? requestedIssuesPresentInSummary
    : positiveSummaryIssues.length > 0
      ? positiveSummaryIssues
      : surfacedIssues

  if (requestedIssues.length > 0 && requestedIssuesPresentInSummary.length === 0) {
    await closeImageCheckDialogIfPresent(page)
    return stepResult(
      "repair-image-management-selection",
      "Repair image-check selection",
      "skipped",
      "Image check summary shows no matching positive issues; skipped automatic image replacement",
      {
        requestedIssues,
        surfacedIssues,
        positiveSummaryIssues,
        beforeDialogCount,
        afterOpenState,
        openScreenshotPath,
        openAttempts
      }
    )
  }

  if (effectiveIssues.length === 0) {
    await closeImageCheckDialogIfPresent(page)
    return stepResult(
      "repair-image-management-selection",
      "Repair image-check selection",
      "skipped",
      "Image check summary shows no actionable positive issues",
      {
        requestedIssues,
        surfacedIssues,
        positiveSummaryIssues,
        beforeDialogCount,
        afterOpenState,
        openScreenshotPath,
        openAttempts
      }
    )
  }
  const visibleCategories = await collectImageCheckCategoryItems(dialog)
  const directCandidates = await collectImageCheckSelectionCandidates(dialog)
  const directReplacementMode = inferImageCheckDirectReplacementMode(effectiveIssues, directCandidates)
  const directReplacementRequested = directReplacementMode !== null
  let selection: ImageCheckApplySummary

  if (directReplacementRequested) {
    const replacementUrls = await buildSkuReplacementCandidateUrls(page, dialog, effectiveIssues)
    await closeImageCheckDialogIfPresent(page)
    await waitForPublishPage(page, config, {
      waitForManualNavigation: false,
      targetUrl: page.url()
    })
    const replacementResult = await fillSkuImageLinks(page, replacementUrls, {
      maxRows: 40,
      screenshotDir: options?.screenshotDir,
      screenshotPrefix: directReplacementMode === "square-preview-all-colors"
        ? "repair-image-check-square-preview-replace"
        : "repair-image-check-sku-replace",
      mode: directReplacementMode ?? "strict-color"
    })
    selection = {
      applied: replacementResult.status === "done",
      changed: replacementResult.status === "done",
      status: replacementResult.status === "done" ? "applied" : "failed",
      reason: replacementResult.status === "done"
        ? directReplacementMode === "square-preview-all-colors"
          ? "image check product-size issue routed to square preview replacement across all color rows"
          : "image check color-size issue routed to direct SKU image network replacement"
        : directReplacementMode === "square-preview-all-colors"
          ? `image check product-size issue could not be fixed by square preview replacement: ${replacementResult.detail}`
          : `image check color-size issue could not be fixed by direct SKU image replacement: ${replacementResult.detail}`,
      categories: [],
      issues: effectiveIssues,
      directReplacement: {
        applied: replacementResult.status === "done",
        reason: replacementResult.detail,
        imageUrls: replacementUrls,
        writerResult: replacementResult
      },
      deferredVerification: replacementResult.status === "done"
        ? {
            required: true,
            categoryLabels: Array.from(new Set(
              uniqueImageCheckIssues(effectiveIssues)
                .map((issue) => classifyIssueToImageCheckCategory(issue, visibleCategories))
                .filter((label): label is string => Boolean(label))
            ))
          }
        : null
    }
  } else {
    selection = await applyImageCheckSelections(
      page,
      config,
      effectiveIssues
    )
  }
  const afterScreenshotPath = await captureMediaScreenshot(
    page,
    options?.screenshotDir ?? "output/playwright",
    "repair-image-check-after",
    "image-management"
  )
  let pageSavePreparation: AutomationStepResult | null = null
  let pageSave: AutomationStepResult | null = null
  let afterPageSaveScreenshotPath: string | null = null
  let postPageSaveVerification: Awaited<ReturnType<typeof verifyImageCheckCategoriesResolvedAfterSave>> | null = null
  if (selection.status !== "failed" && selection.changed) {
    pageSavePreparation = await prepareRepairMediaPageSave(page, draft, config)
    pageSave = await saveDraftWithVerification(page, config, 2)
    afterPageSaveScreenshotPath = await captureMediaScreenshot(
      page,
      options?.screenshotDir ?? "output/playwright",
      "repair-image-check-after-page-save",
      "image-management"
    )
    if (pageSave.status === "done" && selection.deferredVerification?.required) {
      postPageSaveVerification = await verifyImageCheckCategoriesResolvedAfterSave(
        page,
        config,
        selection.deferredVerification.categoryLabels,
        {
          targetUrl: repairPageUrl
        }
      )
      selection.deferredVerification = {
        ...selection.deferredVerification,
        verified: postPageSaveVerification.verified,
        remainingCategories: postPageSaveVerification.remainingCategories,
        surfacedIssues: postPageSaveVerification.surfacedIssues,
        reason: !postPageSaveVerification.verified
          ? postPageSaveVerification.remainingCategories.some((item) => item.count < 0)
            ? "image check saved candidate replacements, but verification dialog did not reopen"
            : `image check saved candidate replacements, but unresolved categories remain: ${postPageSaveVerification.remainingCategories.map((item) => `${item.label}(${item.count})`).join(", ")}`
          : "image check candidate replacements were verified after Dianxiaomi page save"
      }

      if (!postPageSaveVerification.verified && postPageSaveVerification.surfacedIssues.length > 0) {
        selection.issues = postPageSaveVerification.surfacedIssues
      }
    }
  }

  const selectionStatus = selection.status === "failed" ? "failed" : selection.status === "applied" ? "done" : "skipped"
  const finalStatus: StepStatus =
    pageSavePreparation?.status === "failed"
      || pageSave?.status === "failed"
      || (selection.deferredVerification?.required === true && selection.deferredVerification.verified === false)
      ? "failed"
      : selectionStatus
  const finalDetail = pageSavePreparation?.status === "failed"
    ? `${selection.reason}; page-save preparation failed: ${pageSavePreparation.detail}`
    : pageSave?.status === "done"
      ? selection.deferredVerification?.required === true && selection.deferredVerification.verified === false
        ? selection.deferredVerification.reason ?? selection.reason
        : selection.deferredVerification?.required === true && selection.deferredVerification.verified === true
          ? `${selection.reason}; Dianxiaomi page save and image-check verification succeeded`
          : `${selection.reason}; Dianxiaomi page save verified`
      : pageSave?.status === "failed"
        ? `${selection.reason}; Dianxiaomi page save failed: ${pageSave.detail}`
        : selection.reason

  return stepResult(
    "repair-image-management-selection",
    "Repair image-check selection",
    finalStatus,
    finalDetail,
    {
      requestedIssues,
      surfacedIssues,
      beforeDialogCount,
      afterOpenState,
      openScreenshotPath,
      afterScreenshotPath,
      pageSavePreparation,
      pageSave,
      afterPageSaveScreenshotPath,
      postPageSaveVerification,
      openAttempts,
      selection
    }
  )
}

const applyRepairMediaTool = async (
  page: Page,
  action: DianxiaomiProductRepairAction,
  draft: ListingDraft,
  config: DianxiaomiSelectorConfig,
  options?: RunnerOptions
) => {
  const mediaTool = action.payload?.mediaTool
  if (!mediaTool) {
    return repairApplyResult(action, "skipped", "Media repair has no specific tool allowlist")
  }

  const effectiveMode = options?.mediaAutomationMode === "unattended-apply" ? "unattended-apply" : "plan-only"
  const requestedImageCheckIssues = action.payload?.reasonCode === "requirement-image-check"
    ? inferImageCheckIssuesFromRepairAction(action)
    : []
  const routeThroughImageCheckSelection = shouldRouteThroughImageCheckSelection(
    mediaTool,
    action.payload?.reasonCode,
    requestedImageCheckIssues
  )

  if (routeThroughImageCheckSelection) {
    const selectionResult = effectiveMode === "unattended-apply"
      ? await runImageManagementRepairSelection(page, action, draft, config, options, requestedImageCheckIssues)
      : stepResult(
        "repair-image-management-selection",
        "Repair image-check selection",
        "skipped",
        "Image-check repair stayed in plan-only mode"
      )

    return repairApplyResult(
      action,
      selectionResult.status,
      selectionResult.detail,
      {
        mediaTool,
        mode: effectiveMode,
        requestedImageCheckIssues,
        imageCheckSelection: selectionResult.data ?? null
      }
    )
  }

  const result = await planMediaProcessing(page, config, {
    mediaAutomationMode: effectiveMode,
    mediaAutomationTools: [mediaTool],
    screenshotDir: options?.screenshotDir ?? "output/playwright"
  })

  const finalStatus: StepStatus =
    result.status === "failed"
      ? "failed"
      : result.status === "done"
        ? "done"
        : result.status

  const finalDetail = effectiveMode === "unattended-apply"
    ? requestedImageCheckIssues.length > 0
      ? `Ran allowed Dianxiaomi media tool for image-check issue handling: ${mediaTool}`
      : `Ran allowed Dianxiaomi media tool: ${mediaTool}`
    : `Media repair stayed in plan-only mode for tool: ${mediaTool}`

  return repairApplyResult(
    action,
    finalStatus,
    finalDetail,
    {
      mediaTool,
      mode: effectiveMode,
      writerResult: result,
      imageCheckSelection: null
    }
  )
}

const applyRepairAction = async (
  page: Page,
  action: DianxiaomiProductRepairAction,
  draft: ListingDraft,
  config: DianxiaomiSelectorConfig,
  options?: RunnerOptions
) => {
  if (action.automation !== "auto" && action.automation !== "assisted") {
    return repairApplyResult(action, "skipped", `Repair action requires manual handling: ${action.automation}`)
  }

  const writer = action.payload?.writer
  if (writer === "fill-single-field") {
    return applyRepairSingleField(page, action, draft, config)
  }

  if (writer === "fill-attributes") {
    return applyRepairAttributes(page, action, draft, config)
  }

  if (writer === "fill-sku-pricing") {
    return applyRepairSkuPricing(page, action, draft, config)
  }

  if (writer === "run-media-tool") {
    return applyRepairMediaTool(page, action, draft, config, options)
  }

  return repairApplyResult(
    action,
    "skipped",
    writer
      ? `Repair writer is not safe for browser execution: ${writer}`
      : "Repair action has no executable payload"
  )
}

const getRepairActionPriority = (action: DianxiaomiProductRepairAction) => {
  const writer = action.payload?.writer
  if (writer !== "run-media-tool") {
    return 100
  }

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

  return 50
}

const shouldAbortRemainingRepairActions = (step: AutomationStepResult) => {
  if (!step.id.startsWith("repair-apply-") || step.status !== "failed") {
    return false
  }

  const stepData = step.data as Record<string, unknown> | undefined
  const imageCheckSelection = stepData?.imageCheckSelection as Record<string, unknown> | undefined
  const selection = imageCheckSelection?.selection as Record<string, unknown> | undefined
  const categories = Array.isArray(selection?.categories)
    ? selection.categories as Array<Record<string, unknown>>
    : []
  if (categories.some((category) => String(category.batchToolReason ?? "").includes("\u56fe\u7247\u7a7a\u95f4\u4e0d\u8db3"))) {
    return true
  }

  const writerResult = stepData?.writerResult as Record<string, unknown> | undefined
  const writerResultData = writerResult?.data as Record<string, unknown> | undefined
  const tools = Array.isArray(writerResultData?.tools)
    ? writerResultData.tools as Array<Record<string, unknown>>
    : Array.isArray(writerResult?.tools)
      ? writerResult.tools as Array<Record<string, unknown>>
      : []
  return tools.some((tool) => tool.failureKind === "storage-quota")
}

export const inspectRepairPlanPreview = async (
  page: Page,
  draft: ListingDraft,
  repairPlan: DianxiaomiProductRepairPlan,
  config: DianxiaomiSelectorConfig = {}
) => {
  const results: AutomationStepResult[] = []
  const targetSurface = await inspectDianxiaomiTargetSurface(page, config)
  results.push(targetSurface)
  if (!targetSurfaceCanInspect(targetSurface)) {
    results.push(stepResult(
      "repair-preview-blocked-surface",
      "Repair preview blocked",
      "failed",
      "Repair preview was blocked because the current page is not a recognized Dianxiaomi listing edit surface",
      targetSurface.data
    ))
    return results
  }

  const actionable = repairPlan.actions.filter((action) => action.payload)
  if (actionable.length === 0) {
    results.push(stepResult(
      "repair-preview-empty",
      "Repair preview",
      "skipped",
      "Repair plan has no executable browser payload"
    ))
  }

  for (const action of actionable) {
    results.push(await inspectRepairAction(page, action, draft, config))
  }

  const checked = results.filter((step) => step.id.startsWith("repair-preview-") && step.id !== "repair-preview-summary")
  const readyCount = checked.filter((step) => step.status === "done").length
  const failedCount = checked.filter((step) => step.status === "failed").length
  const skippedCount = checked.filter((step) => step.status === "skipped").length
  results.push(stepResult(
    "repair-preview-summary",
    "Repair preview summary",
    failedCount > 0 ? "failed" : readyCount > 0 ? "done" : "skipped",
    `Repair preview checked ${checked.length} action(s): ready ${readyCount}, missing ${failedCount}, skipped ${skippedCount}`,
    {
      repairStatus: repairPlan.status,
      canAutoRepair: repairPlan.canAutoRepair,
      canRetryAfterRepair: repairPlan.canRetryAfterRepair,
      actionCount: repairPlan.actions.length,
      checkedCount: checked.length,
      readyCount,
      failedCount,
      skippedCount
    }
  ))

  return results
}

export const applyRepairPlan = async (
  page: Page,
  draft: ListingDraft,
  repairPlan: DianxiaomiProductRepairPlan,
  config: DianxiaomiSelectorConfig = {},
  options?: RunnerOptions
) => {
  const results: AutomationStepResult[] = []
  const targetSurface = await inspectDianxiaomiTargetSurface(page, config)
  results.push(targetSurface)
  if (!targetSurfaceCanWrite(targetSurface)) {
    results.push(stepResult(
      "repair-apply-blocked-surface",
      "Repair apply blocked",
      "failed",
      "Repair apply was blocked because the current page is not a recognized Dianxiaomi listing edit surface",
      targetSurface.data
    ))
    return results
  }

  const actionable = repairPlan.actions
    .filter((action) => action.payload)
    .sort((left, right) => getRepairActionPriority(left) - getRepairActionPriority(right))
  if (actionable.length === 0) {
    results.push(stepResult(
      "repair-apply-empty",
      "Repair apply",
      "skipped",
      "Repair plan has no executable browser payload"
    ))
  }

  for (let index = 0; index < actionable.length; index += 1) {
    const action = actionable[index]!
    const applied = await applyRepairAction(page, action, draft, config, options)
    results.push(applied)
    if (shouldAbortRemainingRepairActions(applied)) {
      for (const remaining of actionable.slice(index + 1)) {
        results.push(repairApplyResult(
          remaining,
          "skipped",
          "Skipped because an earlier media repair hit Dianxiaomi image-space quota; continuing would waste billable image actions",
          {
            abortedBy: applied.id,
            reasonCode: "storage-quota-short-circuit"
          }
        ))
      }
      break
    }
  }

  const applied = results.filter((step) => step.id.startsWith("repair-apply-") && step.id !== "repair-apply-summary")
  const doneCount = applied.filter((step) => step.status === "done").length
  const failedCount = applied.filter((step) => step.status === "failed").length
  const skippedCount = applied.filter((step) => step.status === "skipped").length
  const savedOrSubmitted = applied.some((step) => {
    const stepData = step.data as Record<string, unknown> | undefined
    const imageCheckSelection = stepData?.imageCheckSelection as Record<string, unknown> | undefined
    const pageSave = imageCheckSelection?.pageSave as { status?: string } | undefined
    return pageSave?.status === "done"
  })
  results.push(stepResult(
    "repair-apply-summary",
    "Repair apply summary",
    failedCount > 0 ? "failed" : doneCount > 0 ? "done" : "skipped",
    `Repair apply handled ${applied.length} action(s): applied ${doneCount}, failed ${failedCount}, skipped ${skippedCount}`,
    {
      repairStatus: repairPlan.status,
      canAutoRepair: repairPlan.canAutoRepair,
      canRetryAfterRepair: repairPlan.canRetryAfterRepair,
      actionCount: repairPlan.actions.length,
      handledCount: applied.length,
      doneCount,
      failedCount,
      skippedCount,
      savedOrSubmitted
    }
  ))

  return results
}

export const fillDraft = async (
  page: Page,
  taskDraft: ListingDraft,
  productImages: string[] = [],
  config: DianxiaomiSelectorConfig = {},
  options?: RunnerOptions
) => {
  const results: AutomationStepResult[] = []
  const targetSurface = await inspectDianxiaomiTargetSurface(page, config)
  results.push(targetSurface)
  if (!targetSurfaceCanWrite(targetSurface)) {
    results.push(stepResult(
      "write-blocked-wrong-surface",
      "Write blocked",
      "failed",
      "Fill was blocked because the current page is not a recognized Dianxiaomi listing edit surface",
      targetSurface.data
    ))
    return results
  }

  const writeSurfacePreparation = await prepareDraftPageWriteSurface(page, taskDraft, config)
  results.push(writeSurfacePreparation)

  results.push(await dismissStartupModalIfPresent(page))

  results.push(await fillSingleField(page, "title", taskDraft.listingTitle, config))

  if (taskDraft.description) {
    results.push(await fillSingleField(page, "description", taskDraft.description, config))
  } else {
    results.push(stepResult("fill-description", "填写 description", "skipped", "任务没有 description"))
  }

  results.push(await fillAttributes(page, taskDraft, config))
  results.push(await normalizeMaterialComposition(page))
  results.push(await normalizeOriginProvince(page))
  results.push(await fillSkuPricing(page, taskDraft.skuPricing, config))
  console.log("fill-draft stage: sku pricing completed")
  results.push(await normalizeSkcPagePricing(page, config))
  console.log("fill-draft stage: SKC price consistency normalized")
  // Legacy "page reference" work items carry no product images, so fillSkuImageLinks
  // would skip and save-draft fails the "每色3图" gate. Recover the listing's own
  // images from edit.json on the spot when none were passed in.
  let effectiveProductImages = productImages
  if (effectiveProductImages.length === 0) {
    const recoveredImages = await fetchProductImagesFromEditJson(page)
    if (recoveredImages.length > 0) {
      effectiveProductImages = recoveredImages
      console.log(`fill-draft stage: recovered ${recoveredImages.length} product image(s) from edit.json`)
    }
  }
  if (effectiveProductImages.length > 0) {
    results.push(await fillSkuImageLinks(page, effectiveProductImages))
    console.log("fill-draft stage: sku image links completed")
    results.push(await normalizeDescriptionImageModules(page, effectiveProductImages))
    console.log("fill-draft stage: description image modules normalized")
  } else {
    results.push(stepResult("fill-sku-image-links", "Fill SKU image links", "skipped", "Task has no product images and none could be recovered from edit.json"))
    results.push(stepResult("normalize-description-image-modules", "Normalize description image modules", "skipped", "Task has no product images"))
  }
  results.push(await normalizeSizeChart(page))
  console.log("fill-draft stage: size chart normalization completed")
  results.push(await inspectMediaProcessingSafety(page, config, options))
  console.log("fill-draft stage: media processing safety inspection completed")
  if (options?.saveDraft) {
    results.push(stepResult(
      "media-processing-plan",
      "Media processing plan",
      "skipped",
      "Save-draft stage reuses the current media state and does not rerun billable Dianxiaomi media tools"
    ))
    console.log("fill-draft stage: media processing plan skipped during save-draft stage")
  } else {
    const mediaProcessingPlan = await planMediaProcessing(page, config, options)
    results.push(mediaProcessingPlan)
    console.log(`fill-draft stage: media processing plan completed (${mediaProcessingPlan.status})`)
    if (
      options?.mediaAutomationMode === "unattended-apply"
      && mediaProcessingPlan.status === "failed"
      && options.submit
    ) {
      results.push(stepResult(
        "write-blocked-media-processing",
        "Write blocked",
        "failed",
        "Submit was blocked because Dianxiaomi media processing did not complete in unattended mode",
        mediaProcessingPlan.data
      ))
    }
  }

  return results
}

const inspectField = async (page: Page, kind: FieldKind, config: DianxiaomiSelectorConfig) => {
  const field = await findField(page, kind, config)
  return stepResult(
    `inspect-${kind}`,
    `Inspect ${kind}`,
    field ? "done" : "failed",
    field ? `Field found: ${kind}` : `Field missing: ${kind}`
  )
}

export const inspectPublishSurface = async (
  page: Page,
  draft: ListingDraft,
  config: DianxiaomiSelectorConfig = {},
  options?: RunnerOptions
) => {
  const results: AutomationStepResult[] = []
  const targetSurface = await inspectDianxiaomiTargetSurface(page, config)
  results.push(targetSurface)
  if (!targetSurfaceCanInspect(targetSurface)) {
    return results
  }

  const writeSurfacePreparation = await prepareDraftPageWriteSurface(page, draft, config)
  results.push(writeSurfacePreparation)

  results.push(await inspectField(page, "title", config))
  results.push(await inspectField(page, "description", config))

  const writableAttributeKeys = Object.keys(draft.attributes).filter((key) => !isInternalDianxiaomiAttributeKey(key))
  if (writableAttributeKeys.length > 0) {
    const attributeField = await findByConfiguredSelectors(page, config.fields?.attribute) ?? await findFieldByKeyword(page, writableAttributeKeys)
    results.push(stepResult(
      "inspect-attribute",
      "Inspect attribute",
      attributeField ? "done" : "skipped",
      attributeField ? "Attribute field found" : "No generic attribute field found"
    ))
  } else {
    results.push(stepResult("inspect-attribute", "Inspect attribute", "skipped", "Task has no attributes"))
  }

  const rows = await findSkuRows(page, config)
  const priceField = rows.length > 0 ? null : await findField(page, "price", config)
  const stockField = rows.length > 0 ? null : await findField(page, "stock", config)

  const writeSurfacePrepared =
    writeSurfacePreparation.status === "done"
    || writeSurfacePreparation.status === "skipped"
  const skuRowsStatus: StepStatus =
    rows.length > 0
      ? "done"
      : writeSurfacePrepared && draft.skuPricing.length > 0
        ? "skipped"
        : "failed"
  results.push(stepResult(
    "inspect-sku-rows",
    "Inspect SKU rows",
    skuRowsStatus,
    rows.length > 0
      ? `SKU rows found: ${rows.length}`
      : writeSurfacePrepared && draft.skuPricing.length > 0
        ? "SKU rows are not visible yet; this Dianxiaomi page can still generate pricing inputs after fill/save preparation"
        : "SKU rows missing",
    {
      expectedSkuCount: draft.skuPricing.length,
      detectedRows: rows.length,
      writeSurfacePrepared
    }
  ))

  if (rows.length === 0) {
    results.push(stepResult(
      "inspect-price",
      "Inspect price",
      priceField ? "done" : writeSurfacePrepared && draft.skuPricing.length > 0 ? "skipped" : "failed",
      priceField
        ? "Global price field found"
        : writeSurfacePrepared && draft.skuPricing.length > 0
          ? "Global price field is not visible yet; continue with fill/save preparation on this Dianxiaomi page"
          : "Global price field missing"
    ))
    results.push(stepResult(
      "inspect-stock",
      "Inspect stock",
      stockField ? "done" : writeSurfacePrepared && draft.skuPricing.length > 0 ? "skipped" : "failed",
      stockField
        ? "Global stock field found"
        : writeSurfacePrepared && draft.skuPricing.length > 0
          ? "Global stock field is not visible yet; continue with fill/save preparation on this Dianxiaomi page"
          : "Global stock field missing"
    ))
  }

  const saveButton = await findButtonByKeywords(page, ["淇濆瓨鑽夌", "淇濆瓨", "鏆傚瓨", "save draft", "save"], config.buttons?.save)
  const submitButton = await findButtonByKeywords(page, ["鍙戝竷", "鎻愪氦", "绔嬪嵆鍒婄櫥", "submit", "publish"], config.buttons?.submit)
  results.push(stepResult(
    "inspect-save-button",
    "Inspect save button",
    saveButton ? "done" : "skipped",
    saveButton ? "Configured save button found" : "Configured save button missing"
  ))
  results.push(stepResult(
    "inspect-submit-button",
    "Inspect submit button",
    submitButton ? "done" : "skipped",
    submitButton ? "Configured submit button found" : "Configured submit button missing"
  ))
  results.push(...await inspectMediaTools(page, config))
  results.push(await inspectMediaProcessingSafety(page, config, options))
  if (options?.mediaAutomationMode === "unattended-open" || options?.mediaAutomationMode === "unattended-apply") {
    results.push(await planMediaProcessing(page, config, {
      ...options,
      mediaAutomationMode: "plan-only"
    }))
  }

  return results
}

export const saveOrSubmit = async (page: Page, options: RunnerOptions) => {
  const config = loadSelectorConfig(options.selectorConfig)
  if (options.review) {
    return stepResult("review-hold", "Review hold", "skipped", "Review mode stops before save/submit")
  }
  const targetSurface = await inspectDianxiaomiTargetSurface(page, config)

  if (!targetSurfaceCanWrite(targetSurface)) {
    return stepResult(
      "write-blocked-wrong-surface",
      "Write blocked",
      "failed",
      "Save/submit was blocked because the current page is not a recognized Dianxiaomi listing edit surface",
      targetSurface.data
    )
  }

  if (options.submit) {
    console.log("save-or-submit stage: entering submit listing flow")
    return submitListingWithVerification(page, config, options)
  }

  if (false && options.submit) {
    const clicked = await clickByKeywords(page, ["发布", "提交", "立即刊登", "submit", "publish"], config.buttons?.submit)
    console.log(clicked ? "已点击发布/提交按钮" : "未找到发布/提交按钮")
    return stepResult(
      "submit-listing",
      "发布/提交",
      clicked ? "done" : "failed",
      clicked ? "已点击发布/提交按钮" : "未找到发布/提交按钮"
    )
  }

  if (options.saveDraft) {
    console.log("save-or-submit stage: entering save draft flow")
    // P0-C: previously this branch only clicked save and reported done. That
    // hid "button clicked but Dianxiaomi did not confirm" failures and let
    // bad drafts advance into submit. Now we poll for a verified success
    // feedback (success keyword in toast / alert / message) before reporting
    // done.
    return saveDraftWithVerification(page, config, 2)
  }

  return stepResult("save-draft", "保存草稿", "skipped", "已按参数跳过保存草稿")
}
