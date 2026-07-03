import { writeFileSync } from "node:fs"
import path from "node:path"
import { chromium, type Locator, type Page } from "playwright"
import { ensureDirectory, getArgValue, parseBoolean, waitForManualLoginIfNeeded } from "../common"
import { inspectDianxiaomiTargetSurface, waitForPublishPage } from "../adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "../selector-config"

type ProbeItem = {
  text: string
  className: string
  rect: {
    left: number
    top: number
    width: number
    height: number
  }
}

type FieldProbe = {
  name: string
  containerText: string | null
  selectCount: number
  beforeText: string | null
  optionTexts: string[]
}

const TARGET_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453261437092"

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()

const countVisible = async (locator: Locator, maxCount = 20) => {
  const count = Math.min(await locator.count().catch(() => 0), maxCount)
  let visible = 0
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) {
      visible += 1
    }
  }
  return visible
}

const firstVisible = async (locator: Locator, maxCount = 20) => {
  const count = Math.min(await locator.count().catch(() => 0), maxCount)
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index)
    if (await item.isVisible().catch(() => false)) {
      return item
    }
  }
  return null
}

const FIELD_NAMES = [
  "承诺发货时效",
  "运费模板"
] as const

const INSPECT_SCRIPT = String.raw`
  const fieldNames = ["承诺发货时效", "运费模板"]
  const cleanText = (value) => (value ?? "").replace(/\s+/g, " ").trim()
  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) {
      return false
    }
    const style = window.getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
  }
  const rectOf = (node) => {
    const rect = node.getBoundingClientRect()
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  }

  const items = Array.from(document.querySelectorAll("body *"))
    .filter(isVisible)
    .map((node) => ({
      node,
      text: cleanText(node.textContent)
    }))
    .filter((item) => fieldNames.some((name) => item.text.includes(name)) && item.text.length <= 320)
    .slice(0, 80)
    .map((item) => ({
      text: item.text,
      className: typeof item.node.className === "string" ? item.node.className : "",
      rect: rectOf(item.node)
    }))

  return {
    items
  }
`

const inspectSurface = async (page: Page) =>
  page.evaluate(new Function(INSPECT_SCRIPT) as () => { items: ProbeItem[] })

const probeField = async (page: Page, fieldName: string): Promise<FieldProbe> => {
  const locator = page.locator([
    ".ant-form-item",
    "tr",
    ".commonCard",
    ".commonCardCon",
    ".batch-table-wrap",
    "div"
  ].join(", ")).filter({
    hasText: new RegExp(fieldName, "i")
  })

  const count = Math.min(await locator.count().catch(() => 0), 40)
  let best: Locator | null = null
  let bestScore = Number.POSITIVE_INFINITY

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index)
    if (!await item.isVisible().catch(() => false)) {
      continue
    }
    const text = clean(await item.innerText().catch(() => ""))
    if (!text.includes(fieldName)) {
      continue
    }
    const selectCount = await countVisible(item.locator(".ant-select"), 8)
    if (selectCount <= 0) {
      continue
    }
    const box = await item.boundingBox().catch(() => null)
    const areaPenalty = box ? Math.round((box.width * box.height) / 1000) : 10_000
    const score = areaPenalty + text.length + (selectCount * 100)
    if (score < bestScore) {
      best = item
      bestScore = score
    }
  }

  if (!best) {
    return {
      name: fieldName,
      containerText: null,
      selectCount: 0,
      beforeText: null,
      optionTexts: []
    }
  }

  const selects = best.locator(".ant-select")
  const selectCount = await countVisible(selects, 8)
  const select = await firstVisible(selects, 8)
  const beforeText = select ? clean(await select.innerText().catch(() => "")) : null
  if (select) {
    await select.scrollIntoViewIfNeeded().catch(() => undefined)
    await select.click().catch(() => undefined)
    await page.waitForTimeout(1_000)
  }
  const optionTexts = await page.locator(".ant-select-dropdown:visible .ant-select-item-option")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
    ).catch(() => [])
  await page.keyboard.press("Escape").catch(() => undefined)

  return {
    name: fieldName,
    containerText: clean(await best.innerText().catch(() => "")).slice(0, 1200),
    selectCount,
    beforeText,
    optionTexts
  }
}

const main = async () => {
  const targetUrl = getArgValue("url") ?? TARGET_URL
  const profileDir = path.resolve(getArgValue("profile") ?? ".runtime/dianxiaomi-real-profile")
  const headed = parseBoolean(getArgValue("headed"), false)
  const keepOpen = parseBoolean(getArgValue("keep-open"), false)
  const artifactDir = path.resolve(
    getArgValue("screenshots") ?? `.runtime/automation-artifacts/transport-probe-${new Date().toISOString().replace(/[:.]/g, "-")}`
  )
  const selectorConfig = loadSelectorConfig(".runtime/dianxiaomi-selector-config.json")

  ensureDirectory(profileDir)
  ensureDirectory(artifactDir)

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: !headed,
    viewport: {
      width: 1440,
      height: 960
    }
  })

  try {
    let page = context.pages().find((item) => !item.isClosed()) ?? await context.newPage()
    page.setDefaultTimeout(20_000)
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
    await page.waitForTimeout(4_000)

    const surface = await inspectSurface(page)
    const fields = []
    for (const fieldName of FIELD_NAMES) {
      fields.push(await probeField(page, fieldName))
    }

    const screenshotPath = path.join(artifactDir, "transport-probe.png")
    await page.screenshot({
      path: screenshotPath,
      fullPage: true
    })

    const outputPath = path.join(artifactDir, "transport-probe.json")
    writeFileSync(outputPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      pageUrl: page.url(),
      pageTitle: await page.title().catch(() => ""),
      targetUrl,
      surface,
      fields,
      screenshotPath
    }, null, 2), "utf8")
    console.log(outputPath)
  } finally {
    if (!headed || !keepOpen) {
      await context.close().catch(() => undefined)
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
