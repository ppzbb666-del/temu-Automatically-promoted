import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type Locator, type Page } from "playwright"
import { waitForManualLoginIfNeeded, type RunnerOptions } from "../common"
import { applyRepairPlan, waitForPublishPage } from "../adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "../selector-config"

const PRODUCT_ID = "161406453261437092"
const TARGET_URL = `https://www.dianxiaomi.com/web/popTemu/edit?id=${PRODUCT_ID}`
const PROFILE_DIR = path.resolve(".runtime/dianxiaomi-real-profile")
const SELECTOR_CONFIG_PATH = path.resolve(".runtime/dianxiaomi-selector-config.json")
const IMAGE_CHECK_TEXT = "图片检测"
const CLOSE_TEXTS = ["关闭", "取消", "close", "cancel"]

type ImageCheckState = {
  summaryText: string
  categories: string[]
  cards: Array<{
    text: string
    imageType: string | null
    src: string | null
    checked: boolean | null
  }>
}

type ProductSnapshot = {
  materialImgUrl: string | null
  firstPreviewImgUrls: string | null
  title: string | null
  platformTitle: string | null
  descriptionLength: number | null
}

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()

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
    await locator.click({ timeout: 5_000 })
    return true
  } catch {
    try {
      await locator.click({ timeout: 5_000, force: true })
      return true
    } catch {
      return false
    }
  }
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

const openImageCheck = async (page: Page) => {
  const trigger = await firstVisible([
    page.getByRole("button", { name: new RegExp(IMAGE_CHECK_TEXT) }),
    page.locator("button, a, [role='button']").filter({ hasText: IMAGE_CHECK_TEXT }).first()
  ])
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

  for (const text of CLOSE_TEXTS) {
    const control = await firstVisible([
      dialog.getByRole("button", { name: new RegExp(text, "i") }),
      dialog.locator("button, a, [role='button']").filter({ hasText: new RegExp(text, "i") }).first()
    ])
    if (await clickBestEffort(control)) {
      await page.waitForTimeout(600)
      return true
    }
  }

  await page.keyboard.press("Escape").catch(() => undefined)
  await page.waitForTimeout(600)
  return true
}

const collectImageCheckState = async (dialog: Locator | null): Promise<ImageCheckState> => {
  if (!dialog) {
    return {
      summaryText: "",
      categories: [],
      cards: []
    }
  }

  const categories = await dialog.locator(".img-test-items li").evaluateAll((nodes) =>
    nodes
      .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
  ).catch(() => [] as string[])

  const cards = await dialog.locator(".img-test-details-list .single-image, .img-test-details-list label.image-checkbox").evaluateAll((nodes) =>
    nodes.slice(0, 20).map((node) => {
      const text = (node.textContent || "").replace(/\s+/g, " ").trim()
      const tag = node.querySelector(".img-tag")
      const img = node.querySelector("img")
      const checkbox = node.querySelector("input[type='checkbox']")
      return {
        text,
        imageType: clean(tag?.textContent) || null,
        src: img instanceof HTMLImageElement ? (img.currentSrc || img.src || "").trim() || null : null,
        checked: checkbox instanceof HTMLInputElement ? checkbox.checked : null
      }
    }).filter((item) => item.text)
  ).catch(() => [] as ImageCheckState["cards"])

  return {
    summaryText: clean(await dialog.innerText().catch(() => "")),
    categories,
    cards
  }
}

const fetchProductSnapshot = async (
  requestContext: Awaited<ReturnType<typeof chromium.launchPersistentContext>>["request"]
): Promise<ProductSnapshot> => {
  const response = await requestContext.get(`https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${PRODUCT_ID}`)
  const payload = JSON.parse(await response.text()) as {
    data?: {
      product?: Record<string, unknown>
    }
  }
  const product = payload.data?.product ?? {}
  const specs = Array.isArray(product.mainProductSkuSpecReqsList)
    ? product.mainProductSkuSpecReqsList as Array<Record<string, unknown>>
    : []

  return {
    materialImgUrl: typeof product.materialImgUrl === "string" ? product.materialImgUrl : null,
    firstPreviewImgUrls: typeof specs[0]?.previewImgUrls === "string" ? specs[0].previewImgUrls : null,
    title: typeof product.title === "string" ? product.title : null,
    platformTitle: typeof product.platformTitle === "string" ? product.platformTitle : null,
    descriptionLength: typeof product.description === "string" ? product.description.length : null
  }
}

const buildRunnerOptions = (artifactDir: string): RunnerOptions => ({
  platform: "dianxiaomi",
  targetUrl: TARGET_URL,
  taskApiUrl: "",
  profileDir: PROFILE_DIR,
  headed: false,
  keepOpen: false,
  slowMo: 0,
  saveDraft: false,
  submit: false,
  review: false,
  dryRun: false,
  repairMode: "apply",
  screenshotDir: artifactDir,
  selectorConfig: SELECTOR_CONFIG_PATH,
  mediaAutomationMode: "unattended-apply",
  mediaAutomationTools: ["imageManagement", "batchResize"],
  skipDraftFill: false,
  sampleMediaActions: false,
  submitMaxAttempts: 3
})

const artifactDir = path.resolve(
  `output/playwright/live-image-check-repair-${new Date().toISOString().replace(/[:.]/g, "-")}`
)

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: true,
  viewport: {
    width: 1440,
    height: 960
  }
})

const result: Record<string, unknown> = {
  createdAt: new Date().toISOString(),
  targetUrl: TARGET_URL,
  artifactDir,
  beforeImageCheck: null,
  afterImageCheck: null,
  beforeProduct: null,
  afterProduct: null,
  repairResults: [],
  screenshots: {},
  error: null
}

await mkdir(artifactDir, { recursive: true })

try {
  const selectorConfig = loadSelectorConfig(SELECTOR_CONFIG_PATH)
  const page = context.pages().find((item) => item.url().includes(`/web/popTemu/edit?id=${PRODUCT_ID}`)) ?? await context.newPage()
  page.setDefaultTimeout(20_000)

  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined)
  await waitForManualLoginIfNeeded(page)
  await waitForPublishPage(page, selectorConfig, {
    waitForManualNavigation: false,
    targetUrl: TARGET_URL
  })
  await page.waitForTimeout(1_500)

  result.beforeProduct = await fetchProductSnapshot(context.request)
  const beforePagePath = path.join(artifactDir, "00-before-page.png")
  await page.screenshot({ path: beforePagePath, fullPage: true }).catch(() => undefined)
  ;(result.screenshots as Record<string, string>).beforePage = beforePagePath

  let dialog = await openImageCheck(page)
  result.beforeImageCheck = await collectImageCheckState(dialog)
  const beforeImageCheckPath = path.join(artifactDir, "01-before-image-check.png")
  await page.screenshot({ path: beforeImageCheckPath, fullPage: true }).catch(() => undefined)
  ;(result.screenshots as Record<string, string>).beforeImageCheck = beforeImageCheckPath
  await closeImageCheck(page, dialog)
  await waitForPublishPage(page, selectorConfig, {
    waitForManualNavigation: false,
    targetUrl: page.url()
  })

  const draft = {
    productId: PRODUCT_ID,
    listingTitle: "",
    sellingPoints: [],
    description: "",
    categoryPath: [],
    attributes: {},
    skuPricing: []
  }
  const repairPlan = {
    status: "auto-ready" as const,
    source: "requirements" as const,
    summary: "repair live image-check size issue",
    canAutoRepair: true,
    canRetryAfterRepair: true,
    blockers: [],
    createdAt: new Date().toISOString(),
    actions: [{
      id: "live-image-check-size",
      type: "apply-media-tool" as const,
      label: "repair live image check size",
      detail: "产品图 尺寸",
      automation: "auto" as const,
      required: true,
      field: "image" as const,
      target: "产品图",
      tool: "batchResize",
      payload: {
        writer: "run-media-tool" as const,
        selectorGroup: "mediaTools" as const,
        selectorKey: "batchResize",
        mediaTool: "batchResize" as const,
        expectedValue: "产品图 尺寸",
        reasonCode: "requirement-image-check"
      }
    }]
  }

  result.repairResults = await applyRepairPlan(page, draft, repairPlan, selectorConfig, buildRunnerOptions(artifactDir))
  result.afterProduct = await fetchProductSnapshot(context.request)

  const afterRepairPagePath = path.join(artifactDir, "02-after-repair-page.png")
  await page.screenshot({ path: afterRepairPagePath, fullPage: true }).catch(() => undefined)
  ;(result.screenshots as Record<string, string>).afterRepairPage = afterRepairPagePath

  dialog = await openImageCheck(page)
  result.afterImageCheck = await collectImageCheckState(dialog)
  const afterImageCheckPath = path.join(artifactDir, "03-after-image-check.png")
  await page.screenshot({ path: afterImageCheckPath, fullPage: true }).catch(() => undefined)
  ;(result.screenshots as Record<string, string>).afterImageCheck = afterImageCheckPath
  await closeImageCheck(page, dialog)
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error)
} finally {
  const outputPath = path.join(artifactDir, "result.json")
  await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8")
  await context.close().catch(() => undefined)
  console.log(outputPath)
}
