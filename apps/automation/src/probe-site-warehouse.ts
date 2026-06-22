import { writeFileSync } from "node:fs"
import path from "node:path"
import { chromium, type Locator, type Page } from "playwright"
import { ensureDirectory, getArgValue, parseBoolean, waitForManualLoginIfNeeded } from "./common"
import { inspectDianxiaomiTargetSurface, waitForPublishPage } from "./adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "./selector-config"

type Rect = {
  left: number
  top: number
  width: number
  height: number
}

type WarehouseProbeResult = {
  createdAt: string
  pageUrl: string
  pageTitle: string
  targetUrl: string
  matchingNodes: Array<{
    text: string
    className: string
    rect: Rect
  }>
  containers: Array<{
    selector: string
    text: string
    className: string
    rect: Rect
    selectTexts: string[]
    buttons: Array<{
      text: string
      className: string
      rect: Rect
    }>
  }>
  activeAttempt: {
    containerText: string | null
    selectCount: number
    beforeText: string | null
    syncButtonText: string | null
    syncClicked: boolean
    dropdownVisible: boolean
    optionTexts: string[]
  } | null
  screenshotPath: string
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

const INSPECT_WAREHOUSE_SURFACE_SCRIPT = String.raw`
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

  const matchingNodes = Array.from(document.querySelectorAll("body *"))
    .filter(isVisible)
    .map((node) => ({
      node,
      text: cleanText(node.textContent)
    }))
    .filter((item) => /选择仓库|站点仓库|同步说明|请选择站点仓库/.test(item.text) && item.text.length <= 300)
    .slice(0, 40)
    .map((item) => ({
      text: item.text,
      className: typeof item.node.className === "string" ? item.node.className : "",
      rect: rectOf(item.node)
    }))

  const containerSelectors = [
    ".ant-form-item",
    "tr",
    ".commonCard",
    ".commonCardCon",
    ".batch-table-wrap",
    "div"
  ]

  const containers = containerSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .filter(isVisible)
    .filter((node) => /选择仓库|站点仓库/.test(cleanText(node.textContent)) && node.querySelector(".ant-select"))
    .slice(0, 20)
    .map((node) => ({
      selector: node.tagName.toLowerCase(),
      text: cleanText(node.textContent).slice(0, 1200),
      className: typeof node.className === "string" ? node.className : "",
      rect: rectOf(node),
      selectTexts: Array.from(node.querySelectorAll(".ant-select"))
        .filter(isVisible)
        .map((select) => cleanText(select.textContent))
        .filter(Boolean)
        .slice(0, 10),
      buttons: Array.from(node.querySelectorAll("button, a, [role='button'], .link, span"))
        .filter(isVisible)
        .map((button) => ({
          text: cleanText(button.textContent),
          className: typeof button.className === "string" ? button.className : "",
          rect: rectOf(button)
        }))
        .filter((item) => item.text)
        .slice(0, 20)
    }))

  return {
    matchingNodes,
    containers
  }
`

const inspectWarehouseSurface = async (page: Page) =>
  page.evaluate(new Function(INSPECT_WAREHOUSE_SURFACE_SCRIPT) as () => {
    matchingNodes: WarehouseProbeResult["matchingNodes"]
    containers: WarehouseProbeResult["containers"]
  })

const clickIfVisible = async (locator: Locator | null) => {
  if (!locator) {
    return false
  }
  if (!await locator.isVisible().catch(() => false)) {
    return false
  }
  await locator.scrollIntoViewIfNeeded().catch(() => undefined)
  await locator.click().catch(() => undefined)
  return true
}

const main = async () => {
  const targetUrl = getArgValue("url") ?? TARGET_URL
  const profileDir = path.resolve(getArgValue("profile") ?? ".runtime/dianxiaomi-real-profile")
  const headed = parseBoolean(getArgValue("headed"), false)
  const keepOpen = parseBoolean(getArgValue("keep-open"), false)
  const artifactDir = path.resolve(
    getArgValue("screenshots") ?? `.runtime/automation-artifacts/warehouse-probe-${new Date().toISOString().replace(/[:.]/g, "-")}`
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

    const surface = await inspectWarehouseSurface(page)

    const container = await firstVisible(page.locator(".ant-form-item").filter({ hasText: /选择仓库|站点仓库/i }))
      ?? await firstVisible(page.locator("tr, .commonCard, .commonCardCon, .batch-table-wrap, div").filter({
        hasText: /选择仓库|站点仓库/i
      }), 40)

    let activeAttempt: WarehouseProbeResult["activeAttempt"] = null
    if (container) {
      const selects = container.locator(".ant-select")
      const selectCount = await countVisible(selects, 10)
      const select = await firstVisible(selects, 10)
      const syncButton = await firstVisible(container.locator("button, a, [role='button'], .link, span").filter({ hasText: /同步/i }), 20)
      const beforeText = select ? clean(await select.innerText().catch(() => "")) : null
      const syncButtonText = syncButton ? clean(await syncButton.innerText().catch(() => "")) : null
      const syncClicked = await clickIfVisible(syncButton)
      if (syncClicked) {
        await page.waitForTimeout(2_000)
      }
      if (select) {
        await select.scrollIntoViewIfNeeded().catch(() => undefined)
        await select.click().catch(() => undefined)
        await page.waitForTimeout(1_200)
      }
      const dropdownVisible = await countVisible(page.locator(".ant-select-dropdown:visible"), 5) > 0
      const optionTexts = await page.locator(".ant-select-dropdown:visible .ant-select-item-option")
        .evaluateAll((nodes) =>
          nodes
            .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
            .filter(Boolean)
        ).catch(() => [])
      if (select) {
        await page.keyboard.press("Escape").catch(() => undefined)
      }

      activeAttempt = {
        containerText: clean(await container.innerText().catch(() => "")).slice(0, 1200),
        selectCount,
        beforeText,
        syncButtonText,
        syncClicked,
        dropdownVisible,
        optionTexts
      }
    }

    const screenshotPath = path.join(artifactDir, "warehouse-probe.png")
    await page.screenshot({
      path: screenshotPath,
      fullPage: true
    })

    const payload: WarehouseProbeResult = {
      createdAt: new Date().toISOString(),
      pageUrl: page.url(),
      pageTitle: await page.title().catch(() => ""),
      targetUrl,
      matchingNodes: surface.matchingNodes,
      containers: surface.containers,
      activeAttempt,
      screenshotPath
    }

    const outputPath = path.join(artifactDir, "warehouse-probe.json")
    writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8")
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
