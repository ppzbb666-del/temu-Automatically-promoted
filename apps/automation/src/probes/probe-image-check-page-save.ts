import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Locator, type Page } from "playwright"
import { ensureDirectory, getArgValue, waitForManualLoginIfNeeded, type RunnerOptions } from "../common"
import { saveOrSubmit, waitForPublishPage } from "../adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "../selector-config"

const DEFAULT_PRODUCT_ID = "161406453261437092"
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const IMAGE_CHECK_BUTTON_KEYWORDS = ["\u56fe\u7247\u68c0\u6d4b", "\u68c0\u6d4b\u56fe\u7247"]
const IMAGE_CHECK_CLOSE_KEYWORDS = ["\u5173\u95ed", "\u53d6\u6d88", "close", "cancel"]
const IMAGE_CHECK_SAVE_KEYWORDS = ["\u4fdd\u5b58", "\u5e94\u7528", "\u786e\u8ba4", "save", "apply", "confirm"]

type CardSummary = {
  index: number
  text: string
  imageType: string | null
  dimensions: string | null
  checked: boolean
}

type DialogSummary = {
  summaryText: string
  categories: string[]
  cards: CardSummary[]
}

type ProductImageSnapshot = {
  materialImgUrl: string | null
  mainImage: string | null
  draftImgUrl: string | null
  firstPreviewImgUrls: string | null
  firstVariantThumbUrl: string | null
  firstVariantSkcThumbUrl: string | null
  descriptionModuleCount: number | null
}

type ProbeResult = {
  createdAt: string
  url: string
  pageUrl: string
  pageTitle: string
  before: DialogSummary | null
  afterDialogSave: DialogSummary | null
  afterReopen: DialogSummary | null
  beforeProductSnapshot: ProductImageSnapshot | null
  afterProductSnapshot: ProductImageSnapshot | null
  pageSave: {
    status: string
    detail: string
    data?: Record<string, unknown>
  } | null
  actionLog: Array<Record<string, unknown>>
  screenshots: Record<string, string | null>
}

const cleanText = (value: string | null | undefined) =>
  (value ?? "").replace(/\s+/g, " ").trim()

const resolveRepoPath = (value: string) =>
  path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value)

const normalizeUrl = (value: unknown) => {
  const text = typeof value === "string" ? value.trim() : ""
  return text.length > 0 ? text : null
}

const readDescriptionModuleCount = (value: unknown) => {
  if (typeof value !== "string" || !value.trim().startsWith("[")) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as unknown[]
    return Array.isArray(parsed) ? parsed.length : null
  } catch {
    return null
  }
}

const parseMaybeJsonArray = (value: unknown) => {
  if (Array.isArray(value)) {
    return value
  }

  if (typeof value !== "string" || !value.trim().startsWith("[")) {
    return []
  }

  try {
    const parsed = JSON.parse(value) as unknown[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const firstVisible = async (locators: Locator[]) => {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0)
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index)
      if (await item.isVisible().catch(() => false)) {
        return item
      }
    }
  }

  return null
}

const clickBestEffort = async (locator: Locator | null) => {
  if (!locator) {
    return false
  }

  await locator.scrollIntoViewIfNeeded().catch(() => undefined)
  try {
    await locator.click({
      timeout: 5_000
    })
    return true
  } catch {
    try {
      await locator.click({
        timeout: 5_000,
        force: true
      })
      return true
    } catch {
      return false
    }
  }
}

const captureScreenshot = async (page: Page, artifactDir: string, fileName: string) => {
  const filePath = path.join(artifactDir, fileName)
  await page.screenshot({
    path: filePath,
    fullPage: true
  }).catch(() => undefined)
  return filePath
}

const findActionByKeywords = async (root: Page | Locator, keywords: string[]) => {
  for (const keyword of keywords) {
    const pattern = new RegExp(keyword, "i")
    const locator = await firstVisible([
      root.getByRole("button", { name: pattern }),
      root.getByRole("menuitem", { name: pattern }),
      root.getByRole("link", { name: pattern }),
      root.locator("button, a, [role='button'], [role='menuitem']").filter({ hasText: pattern }).first()
    ])

    if (locator) {
      return locator
    }
  }

  return null
}

const waitForImageCheckDialog = async (page: Page, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const dialog = page.locator(".img-test:visible").last()
    if (await dialog.isVisible().catch(() => false)) {
      return dialog
    }

    await page.waitForTimeout(300)
  }

  return null
}

const readDialogSummary = async (dialog: Locator | null): Promise<DialogSummary | null> => {
  if (!dialog) {
    return null
  }

  const categories = dialog.locator(".img-test-items li")
  const categoryCount = Math.min(await categories.count().catch(() => 0), 8)
  const categoryTexts: string[] = []
  for (let index = 0; index < categoryCount; index += 1) {
    const item = categories.nth(index)
    if (!await item.isVisible().catch(() => false)) {
      continue
    }
    categoryTexts.push(cleanText(await item.innerText().catch(() => "")))
  }

  const cards = dialog.locator(".img-test-details-list label.image-checkbox")
  const cardCount = Math.min(await cards.count().catch(() => 0), 12)
  const cardSummaries: CardSummary[] = []
  for (let index = 0; index < cardCount; index += 1) {
    const card = cards.nth(index)
    if (!await card.isVisible().catch(() => false)) {
      continue
    }

    const imageType = cleanText(await card.locator(".img-tag").first().innerText().catch(() => "")) || null
    const dimensions = cleanText(await card.locator(".img-size").first().innerText().catch(() => "")) || null
    const checkbox = card.locator("input[type='checkbox']").first()
    cardSummaries.push({
      index,
      text: cleanText(await card.innerText().catch(() => "")),
      imageType,
      dimensions,
      checked: await checkbox.isChecked().catch(() => false)
    })
  }

  return {
    summaryText: cleanText(await dialog.innerText().catch(() => "")),
    categories: categoryTexts,
    cards: cardSummaries
  }
}

const openImageCheck = async (page: Page) => {
  const trigger = await findActionByKeywords(page, IMAGE_CHECK_BUTTON_KEYWORDS)
  const clicked = await clickBestEffort(trigger)
  if (!clicked) {
    return null
  }

  return waitForImageCheckDialog(page, 20_000)
}

const closeImageCheck = async (page: Page, dialog: Locator | null) => {
  if (!dialog) {
    return false
  }

  const closeAction = await findActionByKeywords(dialog, IMAGE_CHECK_CLOSE_KEYWORDS)
  if (await clickBestEffort(closeAction)) {
    await page.waitForTimeout(800)
    return true
  }

  await page.keyboard.press("Escape").catch(() => undefined)
  await page.waitForTimeout(800)
  return true
}

const fetchProductImageSnapshot = async (
  requestContext: Awaited<ReturnType<typeof chromium.launchPersistentContext>>["request"],
  productId: string
): Promise<ProductImageSnapshot | null> => {
  const response = await requestContext.get(`https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${productId}`)
  const text = await response.text()

  if (!response.ok) {
    return null
  }

  const payload = JSON.parse(text) as {
    data?: {
      product?: Record<string, unknown>
      arrayVariant?: unknown
    }
  }

  const product = payload.data?.product ?? {}
  const variantList = parseMaybeJsonArray((product as Record<string, unknown>).arrayVariant)
  const firstVariant = (variantList[0] ?? {}) as Record<string, unknown>
  const mainProductSkuSpecReqsList = Array.isArray((product as Record<string, unknown>).mainProductSkuSpecReqsList)
    ? ((product as Record<string, unknown>).mainProductSkuSpecReqsList as Array<Record<string, unknown>>)
    : []

  return {
    materialImgUrl: normalizeUrl((product as Record<string, unknown>).materialImgUrl),
    mainImage: normalizeUrl((product as Record<string, unknown>).mainImage),
    draftImgUrl: normalizeUrl((product as Record<string, unknown>).draftImgUrl),
    firstPreviewImgUrls: normalizeUrl(mainProductSkuSpecReqsList[0]?.previewImgUrls),
    firstVariantThumbUrl: normalizeUrl(firstVariant.thumbUrl),
    firstVariantSkcThumbUrl: normalizeUrl(firstVariant.skcThumbUrl),
    descriptionModuleCount: readDescriptionModuleCount((product as Record<string, unknown>).description)
  }
}

const buildSaveOptions = (targetUrl: string, profileDir: string, artifactDir: string, selectorConfigPath: string): RunnerOptions => ({
  platform: "dianxiaomi",
  targetUrl,
  taskApiUrl: "",
  profileDir,
  headed: false,
  keepOpen: false,
  slowMo: 0,
  saveDraft: true,
  submit: false,
  review: false,
  dryRun: false,
  repairMode: "preview",
  screenshotDir: artifactDir,
  selectorConfig: selectorConfigPath,
  mediaAutomationMode: "plan-only",
  mediaAutomationTools: [],
  skipDraftFill: false,
  sampleMediaActions: false,
  submitMaxAttempts: 3
})

const main = async () => {
  const targetUrl = getArgValue("url") ?? `https://www.dianxiaomi.com/web/popTemu/edit?id=${DEFAULT_PRODUCT_ID}`
  const profileDir = resolveRepoPath(getArgValue("profile") ?? ".runtime/dianxiaomi-real-profile")
  const selectorConfigPath = getArgValue("selector-config") ?? ".runtime/dianxiaomi-selector-config.json"
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const artifactDir = resolveRepoPath(getArgValue("artifacts") ?? `output/playwright/probe-image-check-page-save-${timestamp}`)
  const productId = new URL(targetUrl).searchParams.get("id")?.trim() || DEFAULT_PRODUCT_ID

  ensureDirectory(profileDir)
  ensureDirectory(artifactDir)

  const selectorConfig = loadSelectorConfig(resolveRepoPath(selectorConfigPath))
  const result: ProbeResult = {
    createdAt: new Date().toISOString(),
    url: targetUrl,
    pageUrl: "",
    pageTitle: "",
    before: null,
    afterDialogSave: null,
    afterReopen: null,
    beforeProductSnapshot: null,
    afterProductSnapshot: null,
    pageSave: null,
    actionLog: [],
    screenshots: {
      initial: null,
      dialogOpen: null,
      dialogSaved: null,
      pageAfterSave: null,
      afterReopen: null
    }
  }

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: {
      width: 1440,
      height: 960
    }
  })

  try {
    const page = context.pages().find((item) => item.url().includes(`/web/popTemu/edit?id=${productId}`)) ?? await context.newPage()
    page.setDefaultTimeout(20_000)

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded"
    }).catch(() => undefined)
    await waitForManualLoginIfNeeded(page)
    await waitForPublishPage(page, selectorConfig, {
      waitForManualNavigation: false,
      targetUrl
    })
    await page.waitForTimeout(1_500)

    result.pageUrl = page.url()
    result.pageTitle = await page.title().catch(() => "")
    result.beforeProductSnapshot = await fetchProductImageSnapshot(context.request, productId)
    result.screenshots.initial = await captureScreenshot(page, artifactDir, "00-initial.png")

    const dialog = await openImageCheck(page)
    if (!dialog) {
      throw new Error("Image check dialog did not open.")
    }

    result.screenshots.dialogOpen = await captureScreenshot(page, artifactDir, "01-image-check-open.png")
    result.before = await readDialogSummary(dialog)

    const category = dialog.locator(".img-test-items li").filter({
      hasText: /\u4ea7\u54c1\u56fe.*\u5c3a\u5bf8|\u4ea7\u54c1\u56fe\u5c3a\u5bf8\u4e0d\u5408\u89c4/i
    }).first()
    const categoryText = cleanText(await category.innerText().catch(() => ""))
    result.actionLog.push({
      step: "select-category",
      clicked: await clickBestEffort(category),
      text: categoryText
    })
    await page.waitForTimeout(800)

    const firstCard = dialog.locator(".img-test-details-list label.image-checkbox").first()
    if (!await firstCard.isVisible().catch(() => false)) {
      throw new Error("No image-check replacement candidate was visible.")
    }

    const firstCardText = cleanText(await firstCard.innerText().catch(() => ""))
    const checkbox = firstCard.locator("input[type='checkbox']").first()
    const checkedBefore = await checkbox.isChecked().catch(() => false)
    if (!checkedBefore) {
      await clickBestEffort(firstCard)
      await page.waitForTimeout(400)
    }
    result.actionLog.push({
      step: "select-candidate",
      text: firstCardText,
      checkedBefore,
      checkedAfter: await checkbox.isChecked().catch(() => checkedBefore)
    })

    const dialogSave = await findActionByKeywords(dialog, IMAGE_CHECK_SAVE_KEYWORDS)
    result.actionLog.push({
      step: "dialog-save",
      clicked: await clickBestEffort(dialogSave)
    })
    await page.waitForTimeout(1_200)

    result.afterDialogSave = await readDialogSummary(dialog)
    result.screenshots.dialogSaved = await captureScreenshot(page, artifactDir, "02-image-check-after-dialog-save.png")

    await closeImageCheck(page, dialog)
    await waitForPublishPage(page, selectorConfig, {
      waitForManualNavigation: false,
      targetUrl
    })

    const pageSaveResult = await saveOrSubmit(
      page,
      buildSaveOptions(targetUrl, profileDir, artifactDir, selectorConfigPath)
    )
    result.pageSave = {
      status: pageSaveResult.status,
      detail: pageSaveResult.detail,
      data: pageSaveResult.data
    }
    result.screenshots.pageAfterSave = await captureScreenshot(page, artifactDir, "03-page-after-save.png")
    result.afterProductSnapshot = await fetchProductImageSnapshot(context.request, productId)

    const reopenedDialog = await openImageCheck(page)
    result.afterReopen = await readDialogSummary(reopenedDialog)
    result.screenshots.afterReopen = await captureScreenshot(page, artifactDir, "04-image-check-after-reopen.png")
  } finally {
    const outputPath = path.join(artifactDir, "probe-result.json")
    writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8")
    await context.close().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
