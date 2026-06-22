import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type Locator, type Page } from "playwright"

const IMAGE_CHECK_TEXT = "\u56fe\u7247\u68c0\u6d4b"
const SAVE_TEXT = "\u4fdd\u5b58"
const CLOSE_TEXT = "\u5173\u95ed"
const USE_TEXT = "\u9009\u7528"
const PRODUCT_SIZE_TEXT = "\u4ea7\u54c1\u56fe\u5c3a\u5bf8\u4e0d\u5408\u89c4"
const TEXT_WATERMARK_TEXT = "\u56fe\u7247\u5305\u542b\u6587\u5b57\u3001\u6c34\u5370"

const DEFAULT_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453261437092"
const DEFAULT_PROFILE = ".runtime/playwright/dianxiaomi-profile"
const DEFAULT_SCREENSHOTS = ".runtime/manual-probe-image-check-replacement"

type Mode = "checkbox" | "use-button"
type CategoryMode = "non-english" | "size"

type CardSnapshot = {
  index: number
  text: string
  imageType: string | null
  dimensions: string | null
  checked: boolean | null
  useControls: string[]
  html: string
}

type DialogSnapshot = {
  summaryText: string
  categories: string[]
  detailActions: string[]
  cards: CardSnapshot[]
}

type ProbeResult = {
  url: string
  profileDir: string
  mode: Mode
  categoryMode: CategoryMode
  clickedCategory: string | null
  before: DialogSnapshot | null
  afterSave: DialogSnapshot | null
  afterReopen: DialogSnapshot | null
  actionLog: Array<Record<string, unknown>>
  error?: string
}

const getArgValue = (name: string) => {
  const prefix = `--${name}=`
  const direct = process.argv.find((arg) => arg.startsWith(prefix))
  if (direct) {
    return direct.slice(prefix.length)
  }

  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0) {
    return process.argv[index + 1]
  }

  return undefined
}

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const isVisible = async (locator: Locator | null) => locator ? locator.isVisible().catch(() => false) : false

const firstVisible = async (locators: Locator[]) => {
  for (const locator of locators) {
    if (await locator.isVisible().catch(() => false)) {
      return locator
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

const screenshot = async (page: Page, dir: string, fileName: string) => {
  const filePath = path.join(dir, fileName)
  await page.screenshot({
    path: filePath,
    fullPage: true
  }).catch(() => undefined)
  return filePath
}

const writeDialogHtml = async (dialog: Locator, dir: string, fileName: string) => {
  const filePath = path.join(dir, fileName)
  const html = await dialog.evaluate((node) => node.outerHTML).catch(() => "")
  await writeFile(filePath, html, "utf8")
  return filePath
}

const getImageCheckDialog = async (page: Page) => {
  const roots = [
    page.locator(".img-test:visible"),
    page.locator(".ant-modal:visible").filter({ has: page.locator(".img-test") })
  ]

  for (const root of roots) {
    const count = await root.count().catch(() => 0)
    for (let index = count - 1; index >= 0; index -= 1) {
      const locator = root.nth(index)
      if (await locator.isVisible().catch(() => false)) {
        return locator
      }
    }
  }

  return null
}

const waitForImageCheckDialog = async (page: Page, timeoutMs = 12_000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const dialog = await getImageCheckDialog(page)
    if (dialog) {
      return dialog
    }
    await sleep(300)
  }

  return null
}

const readCardSnapshot = async (card: Locator, index: number): Promise<CardSnapshot | null> => {
  if (!await card.isVisible().catch(() => false)) {
    return null
  }

  const text = clean(await card.innerText().catch(() => ""))
  if (!text) {
    return null
  }

  const checkbox = card.locator("input[type='checkbox']").first()
  const hasCheckbox = await checkbox.count().catch(() => 0) > 0
  const useControls = await card.locator("button, a, [role='button'], span, div")
    .evaluateAll((nodes, expected) => nodes
      .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
      .filter((text) => text === expected), USE_TEXT)
    .catch(() => [] as string[])

  return {
    index,
    text,
    imageType: clean(await card.locator(".img-tag").first().innerText().catch(() => "")) || null,
    dimensions: text.match(/(\d+\s*[xX]\s*\d+)/)?.[1] ?? null,
    checked: hasCheckbox ? await checkbox.isChecked().catch(() => false) : null,
    useControls,
    html: await card.evaluate((node) => node.outerHTML).catch(() => "")
  }
}

const collectDialogSnapshot = async (dialog: Locator): Promise<DialogSnapshot> => {
  const categories = await dialog.locator(".img-test-items li")
    .evaluateAll((nodes) => nodes
      .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean))
    .catch(() => [] as string[])

  const cardsLocator = dialog.locator(".img-test-details-list .single-image")
  const cardCount = Math.min(await cardsLocator.count().catch(() => 0), 30)
  const cards: CardSnapshot[] = []
  for (let index = 0; index < cardCount; index += 1) {
    const snapshot = await readCardSnapshot(cardsLocator.nth(index), index)
    if (snapshot) {
      cards.push(snapshot)
    }
  }

  return {
    summaryText: clean(await dialog.innerText().catch(() => "")),
    categories,
    detailActions: await dialog.locator(".img-test-details button, .img-test-details a, .img-test-details [role='button'], .img-test-details span, .img-test-details div")
      .evaluateAll((nodes) => nodes
        .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
        .filter((text) => Boolean(text) && text.length <= 20))
      .catch(() => [] as string[]),
    cards
  }
}

const openImageCheck = async (page: Page) => {
  const button = await firstVisible([
    page.getByRole("button", { name: new RegExp(escapeRegExp(IMAGE_CHECK_TEXT)) }),
    page.locator("button, a, [role='button']").filter({ hasText: IMAGE_CHECK_TEXT }).first()
  ])
  if (!button) {
    return null
  }

  const clicked = await clickBestEffort(button)
  if (!clicked) {
    return null
  }

  return waitForImageCheckDialog(page, 15_000)
}

const reopenImageCheck = async (page: Page) => {
  const existing = await getImageCheckDialog(page)
  if (existing) {
    return existing
  }
  return openImageCheck(page)
}

const clickCategory = async (dialog: Locator, categoryMode: CategoryMode) => {
  const pattern = categoryMode === "size"
    ? PRODUCT_SIZE_TEXT
    : TEXT_WATERMARK_TEXT
  const item = dialog.locator(".img-test-items li").filter({ hasText: pattern }).first()
  if (!await isVisible(item)) {
    return null
  }

  await clickBestEffort(item)
  await sleep(800)
  return clean(await item.innerText().catch(() => ""))
}

const clickUseButtonInCard = async (card: Locator) => {
  const control = await firstVisible([
    card.getByRole("button", { name: new RegExp(`^${escapeRegExp(USE_TEXT)}$`) }),
    card.locator("button, a, [role='button']").filter({ hasText: new RegExp(`^${escapeRegExp(USE_TEXT)}$`) }).first(),
    card.locator("span, div").filter({ hasText: new RegExp(`^${escapeRegExp(USE_TEXT)}$`) }).first()
  ])
  return clickBestEffort(control)
}

const applyByCheckbox = async (dialog: Locator, actionLog: Array<Record<string, unknown>>) => {
  const labels = dialog.locator(".img-test-details-list label.image-checkbox")
  const count = Math.min(await labels.count().catch(() => 0), 24)

  for (let index = 0; index < count; index += 1) {
    const label = labels.nth(index)
    if (!await isVisible(label)) {
      continue
    }
    const checkbox = label.locator("input[type='checkbox']").first()
    const before = await checkbox.isChecked().catch(() => false)
    if (!before) {
      await checkbox.check({ force: true }).catch(async () => {
        await label.click({ force: true }).catch(() => undefined)
      })
    }
    const after = await checkbox.isChecked().catch(() => false)
    actionLog.push({
      step: "checkbox",
      index,
      text: clean(await label.innerText().catch(() => "")),
      before,
      after
    })
  }
}

const applyByUseButton = async (dialog: Locator, actionLog: Array<Record<string, unknown>>) => {
  const cards = dialog.locator(".img-test-details-list .single-image")
  const count = Math.min(await cards.count().catch(() => 0), 24)

  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index)
    if (!await isVisible(card)) {
      continue
    }
    const clicked = await clickUseButtonInCard(card)
    actionLog.push({
      step: "use-button",
      index,
      text: clean(await card.innerText().catch(() => "")),
      clicked
    })
    if (clicked) {
      await sleep(500)
    }
  }
}

const saveDialog = async (page: Page, dialog: Locator, actionLog: Array<Record<string, unknown>>) => {
  const saveButton = await firstVisible([
    dialog.getByRole("button", { name: new RegExp(`^${escapeRegExp(SAVE_TEXT)}$`) }),
    dialog.locator("button, a, [role='button']").filter({ hasText: new RegExp(`^${escapeRegExp(SAVE_TEXT)}$`) }).first()
  ])
  const clicked = await clickBestEffort(saveButton)
  actionLog.push({
    step: "save",
    clicked
  })

  const startedAt = Date.now()
  while (Date.now() - startedAt < 12_000) {
    const current = await getImageCheckDialog(page)
    if (!current) {
      return true
    }
    await sleep(300)
  }

  return false
}

const closeDialog = async (page: Page, dialog: Locator) => {
  const closeButton = await firstVisible([
    dialog.getByRole("button", { name: new RegExp(`^${escapeRegExp(CLOSE_TEXT)}$`) }),
    dialog.locator("button, a, [role='button']").filter({ hasText: new RegExp(`^${escapeRegExp(CLOSE_TEXT)}$`) }).first()
  ])
  if (!closeButton) {
    return false
  }
  await clickBestEffort(closeButton)
  const startedAt = Date.now()
  while (Date.now() - startedAt < 5_000) {
    if (!await getImageCheckDialog(page)) {
      return true
    }
    await sleep(300)
  }
  return false
}

const main = async () => {
  const url = getArgValue("url") ?? DEFAULT_URL
  const profileDir = path.resolve(getArgValue("profile") ?? DEFAULT_PROFILE)
  const screenshotDir = path.resolve(getArgValue("screenshots") ?? DEFAULT_SCREENSHOTS)
  const mode = (getArgValue("mode") ?? "checkbox") as Mode
  const categoryMode = (getArgValue("category") ?? "non-english") as CategoryMode

  await mkdir(screenshotDir, { recursive: true })

  const result: ProbeResult = {
    url,
    profileDir,
    mode,
    categoryMode,
    clickedCategory: null,
    before: null,
    afterSave: null,
    afterReopen: null,
    actionLog: []
  }

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: {
      width: 1440,
      height: 960
    }
  })

  try {
    const page = context.pages().find((item) => item.url().includes("/web/popTemu/edit?id=")) ?? await context.newPage()
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined)
    await page.waitForTimeout(4_000)
    await screenshot(page, screenshotDir, "00-before-open.png")

    const dialog = await openImageCheck(page)
    if (!dialog) {
      throw new Error("image check dialog did not open")
    }

    result.before = await collectDialogSnapshot(dialog)
    await writeDialogHtml(dialog, screenshotDir, "01-image-check-open.html")
    await screenshot(page, screenshotDir, "01-image-check-open.png")

    result.clickedCategory = await clickCategory(dialog, categoryMode)
    const categoryDialog = await waitForImageCheckDialog(page, 6_000)
    if (!categoryDialog) {
      throw new Error("image check dialog disappeared after category click")
    }

    await writeDialogHtml(categoryDialog, screenshotDir, "02-category-selected.html")
    await screenshot(page, screenshotDir, "02-category-selected.png")

    if (mode === "checkbox") {
      await applyByCheckbox(categoryDialog, result.actionLog)
    } else {
      await applyByUseButton(categoryDialog, result.actionLog)
    }

    result.afterSave = await collectDialogSnapshot(categoryDialog)
    await writeDialogHtml(categoryDialog, screenshotDir, "03-after-action-before-save.html")
    await screenshot(page, screenshotDir, "03-after-action-before-save.png")

    const saved = await saveDialog(page, categoryDialog, result.actionLog)
    if (!saved) {
      result.actionLog.push({
        step: "save-timeout"
      })
      await closeDialog(page, categoryDialog).catch(() => undefined)
    }

    await page.waitForTimeout(2_000)
    await screenshot(page, screenshotDir, "04-after-save.png")

    const reopened = await reopenImageCheck(page)
    if (!reopened) {
      throw new Error("image check dialog did not reopen after save")
    }

    result.afterReopen = await collectDialogSnapshot(reopened)
    await writeDialogHtml(reopened, screenshotDir, "05-after-reopen.html")
    await screenshot(page, screenshotDir, "05-after-reopen.png")

    await closeDialog(page, reopened).catch(() => undefined)
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    await writeFile(path.join(screenshotDir, "probe-result.json"), JSON.stringify(result, null, 2), "utf8")
    await context.close().catch(() => undefined)
  }
}

main().catch(async (error) => {
  const screenshotDir = path.resolve(getArgValue("screenshots") ?? DEFAULT_SCREENSHOTS)
  await mkdir(screenshotDir, { recursive: true }).catch(() => undefined)
  await writeFile(
    path.join(screenshotDir, "probe-result.json"),
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }, null, 2),
    "utf8"
  )
  process.exitCode = 1
})
