import { writeFileSync } from "node:fs"
import path from "node:path"
import { chromium, type Locator, type Page } from "playwright"
import { ensureDirectory, getArgValue, parseBoolean, waitForManualLoginIfNeeded } from "./common"
import { inspectDianxiaomiTargetSurface, waitForPublishPage } from "./adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "./selector-config"

const TARGET_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453261437092"
const FIELD_LABEL = "承诺发货时效"
const SNAPSHOT_EVAL = String.raw`
  const cleanText = (value) => (value ?? "").replace(/\s+/g, " ").trim();
  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const rectOf = (node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  };

  const descendants = Array.from(root.querySelectorAll("*"))
    .filter((node) => isVisible(node))
    .map((node) => ({
      tag: node.tagName.toLowerCase(),
      className: typeof node.className === "string" ? node.className : "",
      text: cleanText(node.textContent).slice(0, 200),
      role: node.getAttribute("role") ?? "",
      ariaChecked: node.getAttribute("aria-checked") ?? "",
      ariaSelected: node.getAttribute("aria-selected") ?? "",
      ariaDisabled: node.getAttribute("aria-disabled") ?? "",
      title: node.getAttribute("title") ?? "",
      name: node.getAttribute("name") ?? "",
      dataChecked: node.getAttribute("data-checked") ?? "",
      dataSelected: node.getAttribute("data-selected") ?? "",
      type: node instanceof HTMLInputElement ? node.type : "",
      checked: node instanceof HTMLInputElement ? node.checked : false,
      disabled: node instanceof HTMLInputElement ? node.disabled : false,
      html: node instanceof HTMLElement ? node.outerHTML.slice(0, 1200) : "",
      rect: rectOf(node)
    }))
    .filter((item) => Boolean(item.text || item.role || item.type));

  return {
    rootText: cleanText(root.textContent),
    rootHtml: root instanceof HTMLElement ? root.outerHTML.slice(0, 8000) : "",
    rootRect: rectOf(root),
    descendants
  };
`
const SNAPSHOT_FN = new Function("root", SNAPSHOT_EVAL) as (root: Element) => unknown

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()

const firstVisible = async (locator: Locator, maxCount = 40) => {
  const count = Math.min(await locator.count().catch(() => 0), maxCount)
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index)
    if (await item.isVisible().catch(() => false)) {
      return item
    }
  }
  return null
}

const main = async () => {
  const targetUrl = getArgValue("url") ?? TARGET_URL
  const profileDir = path.resolve(getArgValue("profile") ?? ".runtime/dianxiaomi-real-profile")
  const headed = parseBoolean(getArgValue("headed"), false)
  const keepOpen = parseBoolean(getArgValue("keep-open"), false)
  const artifactDir = path.resolve(
    getArgValue("screenshots") ?? `.runtime/automation-artifacts/shipment-promise-probe-${new Date().toISOString().replace(/[:.]/g, "-")}`
  )
  const selectorConfig = loadSelectorConfig(".runtime/dianxiaomi-selector-config.json")

  ensureDirectory(profileDir)
  ensureDirectory(artifactDir)

  const context = await chromium.launchPersistentContext(profileDir, {
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

    const rowLocator = page.locator(".shipment-wrapper .ant-form-item").filter({
      hasText: new RegExp(FIELD_LABEL, "i")
    })
    const row = await firstVisible(rowLocator)
    if (!row) {
      throw new Error(`Could not find visible shipment row for ${FIELD_LABEL}`)
    }

    await row.scrollIntoViewIfNeeded().catch(() => undefined)
    await page.waitForTimeout(600)

    const snapshot = await row.evaluate(SNAPSHOT_FN as never)

    const box = await row.boundingBox().catch(() => null)
    const rowScreenshotPath = path.join(artifactDir, "shipment-promise-row.png")
    const pageScreenshotPath = path.join(artifactDir, "shipment-promise-page.png")
    await page.screenshot({
      path: pageScreenshotPath,
      fullPage: true
    })
    if (box) {
      await page.screenshot({
        path: rowScreenshotPath,
        clip: {
          x: Math.max(0, Math.floor(box.x - 20)),
          y: Math.max(0, Math.floor(box.y - 20)),
          width: Math.ceil(box.width + 40),
          height: Math.ceil(box.height + 40)
        }
      }).catch(() => undefined)
    }

    const outputPath = path.join(artifactDir, "shipment-promise-row.json")
    writeFileSync(outputPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      pageUrl: page.url(),
      pageTitle: await page.title().catch(() => ""),
      targetUrl,
      fieldLabel: FIELD_LABEL,
      snapshot,
      rowScreenshotPath,
      pageScreenshotPath
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
