import { writeFileSync } from "node:fs"
import path from "node:path"
import { chromium, type Locator, type Page } from "playwright"
import { ensureDirectory, getArgValue, parseBoolean, waitForManualLoginIfNeeded } from "./common"
import {
  inspectDianxiaomiTargetSurface,
  normalizeVariantRemap,
  waitForPublishPage,
  waitForVariantRemapSurface
} from "./adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "./selector-config"

type VariantRowSummary = {
  rowIndex: number
  rowText: string
  sourceText: string
  selectedText: string
  customName: string
  cells: string[]
}

type ProbePayload = {
  createdAt: string
  targetUrl: string
  pageUrl: string
  pageTitle: string
  beforeSurfaceText: string
  beforeRows: VariantRowSummary[]
  normalizeStep: {
    status: string
    detail: string
    data?: Record<string, unknown>
  }
  afterSurfaceText: string
  afterRows: VariantRowSummary[]
  toastTexts: string[]
  feedbackTexts: string[]
  variantInfoExcerpt: string
  modalVisibleAfterNormalize: boolean
  xhrRequests: Array<{
    direction: "request" | "response"
    url: string
    method?: string
    status?: number
  }>
  requestFailures: Array<{
    url: string
    method: string
    errorText: string
  }>
  consoleMessages: Array<{
    type: string
    text: string
    location: string
  }>
  pageErrors: string[]
  screenshots: {
    before: string
    after: string
  }
}

const TARGET_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453261437108"

const cleanText = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()

const firstVisible = async (locators: Locator[]) => {
  for (const locator of locators) {
    const count = Math.min(await locator.count().catch(() => 0), 40)
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index)
      if (await item.isVisible().catch(() => false)) {
        return item
      }
    }
  }

  return null
}

const collectRows = async (surface: Locator | null): Promise<VariantRowSummary[]> => {
  if (!surface) {
    return []
  }

  const rows = surface.locator("tbody tr, .ant-table-row, [class*='table-row' i], tr")
  const rowCount = Math.min(await rows.count().catch(() => 0), 80)
  const summaries: VariantRowSummary[] = []

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = rows.nth(rowIndex)
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
      cellTexts.push(cleanText(await cells.nth(cellIndex).innerText().catch(() => "")))
    }

    const customInput = await firstVisible([
      row.locator("input[placeholder*='自定义名称' i]"),
      row.locator("input:not(.ant-select-selection-search-input):not([type='hidden'])")
    ])

    const sourceText = cleanText(
      cellTexts[1]
      ?? cellTexts.find((text, cellIndex) =>
        cellIndex > 0
        && Boolean(text)
        && !text.includes("移除")
        && !text.includes("请选择")
      )
      ?? ""
    )

    const selectedText = cleanText(await select.innerText().catch(() => ""))
    const customName = customInput
      ? cleanText(await customInput.inputValue().catch(() => ""))
      : ""

    if (!sourceText && !selectedText && !customName) {
      continue
    }

    summaries.push({
      rowIndex,
      rowText: cleanText(await row.innerText().catch(() => "")),
      sourceText,
      selectedText,
      customName,
      cells: cellTexts
    })
  }

  return summaries
}

const collectToastTexts = async (page: Page) => {
  const nodes = page.locator([
    ".ant-message",
    ".ant-notification",
    ".ant-alert",
    ".ant-form-item-explain-error",
    "[class*='message' i]",
    "[class*='notification' i]",
    "[class*='error' i]"
  ].join(", "))
  const count = Math.min(await nodes.count().catch(() => 0), 24)
  const texts: string[] = []
  for (let index = 0; index < count; index += 1) {
    const item = nodes.nth(index)
    if (!await item.isVisible().catch(() => false)) {
      continue
    }
    const text = cleanText(await item.innerText().catch(() => ""))
    if (text && text !== "×" && !texts.includes(text)) {
      texts.push(text)
    }
  }
  return texts
}

const captureScreenshot = async (page: Page, artifactDir: string, fileName: string) => {
  const filePath = path.join(artifactDir, fileName)
  await page.screenshot({
    path: filePath,
    fullPage: true
  }).catch(() => undefined)
  return filePath
}

const extractVariantInfoExcerpt = async (page: Page) => {
  const bodyText = cleanText(await page.locator("body").innerText().catch(() => ""))
  const anchorIndex = bodyText.indexOf("变种信息")
  if (anchorIndex < 0) {
    return bodyText.slice(0, 1_200)
  }
  return bodyText.slice(anchorIndex, anchorIndex + 1_800)
}

const main = async () => {
  const targetUrl = getArgValue("url") ?? TARGET_URL
  const profileDir = path.resolve(getArgValue("profile") ?? ".runtime/dianxiaomi-real-profile")
  const headed = parseBoolean(getArgValue("headed"), false)
  const keepOpen = parseBoolean(getArgValue("keep-open"), false)
  const artifactDir = path.resolve(
    getArgValue("screenshots") ?? `.runtime/automation-artifacts/variant-remap-confirm-${new Date().toISOString().replace(/[:.]/g, "-")}`
  )
  const selectorConfig = loadSelectorConfig(getArgValue("selector-config") ?? ".runtime/dianxiaomi-selector-config.json")

  ensureDirectory(profileDir)
  ensureDirectory(artifactDir)

  const consoleMessages: ProbePayload["consoleMessages"] = []
  const pageErrors: string[] = []
  const requestFailures: ProbePayload["requestFailures"] = []
  const xhrRequests: ProbePayload["xhrRequests"] = []

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: !headed,
    viewport: {
      width: 1440,
      height: 960
    }
  })

  try {
    const page = context.pages().find((item) => !item.isClosed()) ?? await context.newPage()
    page.setDefaultTimeout(20_000)

    page.on("console", (message) => {
      consoleMessages.push({
        type: message.type(),
        text: cleanText(message.text()).slice(0, 800),
        location: message.location().url
          ? `${message.location().url}:${message.location().lineNumber ?? 0}`
          : ""
      })
    })
    page.on("pageerror", (error) => {
      pageErrors.push((error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 1_500))
    })
    page.on("requestfailed", (request) => {
      requestFailures.push({
        url: request.url(),
        method: request.method(),
        errorText: request.failure()?.errorText ?? ""
      })
    })
    page.on("request", (request) => {
      if (["xhr", "fetch"].includes(request.resourceType())) {
        xhrRequests.push({
          direction: "request",
          url: request.url(),
          method: request.method()
        })
      }
    })
    page.on("response", (response) => {
      if (["xhr", "fetch"].includes(response.request().resourceType())) {
        xhrRequests.push({
          direction: "response",
          url: response.url(),
          status: response.status()
        })
      }
    })

    if (page.url() !== targetUrl) {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded"
      }).catch(() => undefined)
    }
    await waitForManualLoginIfNeeded(page)
    await waitForPublishPage(page, selectorConfig, {
      targetUrl
    })
    await inspectDianxiaomiTargetSurface(page, selectorConfig)
    await page.waitForTimeout(3_000)

    const beforeSurface = await waitForVariantRemapSurface(page, 1_500)
    const beforeRows = await collectRows(beforeSurface)
    const beforeSurfaceText = cleanText(await beforeSurface?.innerText().catch(() => "") ?? "").slice(0, 4_000)
    const beforeScreenshot = await captureScreenshot(page, artifactDir, "01-before-normalize.png")

    const normalizeStep = await normalizeVariantRemap(page, "probe variant remap confirm")
    await page.waitForTimeout(2_000)

    const afterSurface = await waitForVariantRemapSurface(page, 1_500)
    const afterRows = await collectRows(afterSurface)
    const afterSurfaceText = cleanText(await afterSurface?.innerText().catch(() => "") ?? "").slice(0, 4_000)
    const afterScreenshot = await captureScreenshot(page, artifactDir, "02-after-normalize.png")
    const toastTexts = await collectToastTexts(page)
    const feedbackTexts = Array.isArray(normalizeStep.data?.feedbackTexts)
      ? (normalizeStep.data?.feedbackTexts as Array<{ source?: string; text?: string }>)
        .map((item) => cleanText(item.text ?? ""))
        .filter(Boolean)
      : []

    const payload: ProbePayload = {
      createdAt: new Date().toISOString(),
      targetUrl,
      pageUrl: page.url(),
      pageTitle: await page.title().catch(() => ""),
      beforeSurfaceText,
      beforeRows,
      normalizeStep: {
        status: normalizeStep.status,
        detail: normalizeStep.detail,
        data: normalizeStep.data
      },
      afterSurfaceText,
      afterRows,
      toastTexts,
      feedbackTexts,
      variantInfoExcerpt: await extractVariantInfoExcerpt(page),
      modalVisibleAfterNormalize: Boolean(afterSurface),
      xhrRequests,
      requestFailures,
      consoleMessages,
      pageErrors,
      screenshots: {
        before: beforeScreenshot,
        after: afterScreenshot
      }
    }

    const outputPath = path.join(artifactDir, "variant-remap-confirm.json")
    writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8")
    console.log(outputPath)

    if (!headed || !keepOpen) {
      await context.close()
    }
  } catch (error) {
    await context.close().catch(() => undefined)
    throw error
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
