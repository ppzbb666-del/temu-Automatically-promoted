import { strict as assert } from "node:assert"
import http from "node:http"
import { createReadStream, statSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { renderPanelFixtureHtml } from "./panel-fixture-template.mjs"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "../../..")
const fixturePath = "/.runtime/ui-fixtures/extension-panel.html"

// The fixture HTML lives under .runtime/ (gitignored), so it is regenerated
// from the committed template before each run — a fresh checkout has no stale
// dependency on an uncommitted artifact.
const writePanelFixture = () => {
  const absoluteFixturePath = path.join(repoRoot, fixturePath.replace(/^\//, ""))
  mkdirSync(path.dirname(absoluteFixturePath), { recursive: true })
  writeFileSync(
    absoluteFixturePath,
    renderPanelFixtureHtml({
      contentScriptUrl: "/apps/extension/src/content.js",
      contentCssUrl: "/apps/extension/src/content.css"
    }),
    "utf8"
  )
}
const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"]
])

const createFixtureServer = () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const requested = path.normalize(path.join(repoRoot, decodeURIComponent(url.pathname)))

    if (!requested.startsWith(repoRoot)) {
      response.writeHead(403)
      response.end("Forbidden")
      return
    }

    try {
      const stat = statSync(requested)
      if (!stat.isFile()) {
        response.writeHead(404)
        response.end("Not found")
        return
      }
    } catch {
      response.writeHead(404)
      response.end("Not found")
      return
    }

    response.writeHead(200, {
      "Content-Type": mime.get(path.extname(requested).toLowerCase()) ?? "application/octet-stream"
    })
    createReadStream(requested).pipe(response)
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      assert(address && typeof address === "object", "fixture server should expose an address")
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}${fixturePath}`
      })
    })
  })
}

const rowText = async (page, label) =>
  page
    .locator(".status-row")
    .filter({ has: page.locator("span", { hasText: label }) })
    .innerText()

const rowClass = async (page, label) =>
  page
    .locator(".status-row")
    .filter({ has: page.locator("span", { hasText: label }) })
    .getAttribute("class")

const repairPlanScenarios = [
  {
    mode: "auto-ready",
    compactLabel: /可自动处理（2 项）/,
    toneClass: "ok",
    visibleAlert: "改造计划：可自动处理（2 项）",
    hiddenDetails: ["自动执行图片翻译、尺寸整理和白底处理。", "自动补齐颜色、材质等已知商品属性。"],
    backendGateMessage: "后端门禁：可自动处理，默认动作允许继续。",
    defaultActionBlocked: false
  },
  {
    mode: "assisted",
    compactLabel: /需辅助处理（自动 1 \/ 辅助 1 \/ 人工 0）/,
    toneClass: "warn",
    visibleAlert: "改造计划：需辅助处理（自动 1 / 辅助 1 / 人工 0）",
    hiddenDetails: ["自动执行图片翻译、尺寸整理和白底处理。", "需要员工确认缺失属性值后再交给自动化填写。"],
    backendGateMessage: "后端门禁：需辅助处理，默认动作暂停。展开高级信息查看改造计划。",
    defaultActionBlocked: true
  },
  {
    mode: "manual",
    compactLabel: /需人工处理（自动 0 \/ 辅助 0 \/ 人工 1）/,
    toneClass: "warn",
    visibleAlert: "改造计划：需人工处理（自动 0 / 辅助 0 / 人工 1）",
    hiddenDetails: ["需要人工处理登录、验证码或平台风控后才能继续。"],
    backendGateMessage: "后端门禁：需人工处理，默认动作暂停。展开高级信息查看改造计划。",
    defaultActionBlocked: true
  },
  {
    mode: "blocked",
    compactLabel: /已阻塞（自动 0 \/ 辅助 0 \/ 人工 1）/,
    toneClass: "bad",
    visibleAlert: "改造计划：已阻塞（自动 0 / 辅助 0 / 人工 1）",
    hiddenDetails: ["登录、验证码或错误页面阻塞自动化", "需要人工处理登录、验证码或平台风控后才能继续。"],
    backendGateMessage: "后端门禁：已阻塞，默认动作暂停。展开高级信息查看改造计划。",
    defaultActionBlocked: true
  }
]

const verifyRepairPlanScenario = async (browser, baseUrl, scenario) => {
  const page = await browser.newPage({
    viewport: {
      width: 1280,
      height: 900
    }
  })
  // Cold-start Chromium on Windows plus five serial pages in one browser can push
  // the first page's waits past Playwright's 30s default and fail spuriously.
  // Give every wait a generous budget; a real hang still fails, just later.
  page.setDefaultTimeout(60_000)

  try {
    const url = `${baseUrl}?repairPlan=${encodeURIComponent(scenario.mode)}`
    await page.goto(url)
    await page.waitForSelector("#temu-ai-root .temu-ai-panel")

    const panel = page.locator("#temu-ai-root")
    const initialText = await panel.innerText()
    assert(initialText.includes("状态"), `${scenario.mode}: default panel should show status group`)
    assert(initialText.includes("告警"), `${scenario.mode}: default panel should show alerts group`)
    assert(initialText.includes("动作"), `${scenario.mode}: default panel should show actions group`)
    assert.match(await rowText(page, "改造"), /未生成/, `${scenario.mode}: repair row should start as a compact not-generated status`)
    assert.equal(await page.locator("details.advanced-panel").evaluate((node) => node.open), false, `${scenario.mode}: advanced panel should be collapsed by default`)

    await page.getByRole("button", { name: "加入队列" }).click()
    await page.waitForFunction((expected) => document.body.innerText.includes(expected), scenario.visibleAlert)

    const defaultTextAfterQueue = await panel.innerText()
    assert.match(await rowText(page, "改造"), scenario.compactLabel, `${scenario.mode}: repair row should show the compact repair conclusion`)
    assert((await rowClass(page, "改造"))?.includes(scenario.toneClass), `${scenario.mode}: repair row should use ${scenario.toneClass} tone`)
    assert(defaultTextAfterQueue.includes(scenario.visibleAlert), `${scenario.mode}: alerts may promote only the compact repair conclusion`)
    for (const detail of scenario.hiddenDetails) {
      assert(!defaultTextAfterQueue.includes(detail), `${scenario.mode}: default panel must not expose repair detail: ${detail}`)
    }
    if (scenario.mode !== "auto-ready") {
      assert(!/可自动处理/.test(await rowText(page, "改造")), `${scenario.mode}: non-auto repair plans must not look auto-ready`)
    }

    const runButton = page.locator("#temu-ai-run")
    const collectButton = page.locator("#temu-ai-collect")
    if (scenario.defaultActionBlocked) {
      assert(await runButton.isDisabled(), `${scenario.mode}: default fill action should be gated`)
      assert(await collectButton.isDisabled(), `${scenario.mode}: queue action should be gated after non-auto repair plan is known`)
      assert(defaultTextAfterQueue.includes("默认动作已暂停"), `${scenario.mode}: default panel should show compact action gate`)
      assert(defaultTextAfterQueue.includes(scenario.backendGateMessage), `${scenario.mode}: action gate should consume backend gate message`)
    } else {
      assert.equal(await runButton.isDisabled(), false, `${scenario.mode}: default fill action should remain available`)
      assert.equal(await collectButton.isDisabled(), false, `${scenario.mode}: queue action should remain available`)
      assert(!defaultTextAfterQueue.includes("默认动作已暂停"), `${scenario.mode}: auto-ready should not show action gate`)
      assert(!defaultTextAfterQueue.includes(scenario.backendGateMessage), `${scenario.mode}: allowed backend gate should stay out of the default action area`)
    }

    await page.locator("details.advanced-panel").evaluate((node) => {
      node.open = true
    })
    const expandedText = await panel.innerText()
    assert(expandedText.includes("改造计划"), `${scenario.mode}: advanced panel should expose the repair plan section when expanded`)
    for (const detail of scenario.hiddenDetails) {
      assert(expandedText.includes(detail), `${scenario.mode}: expanded advanced panel should show repair detail: ${detail}`)
    }

    const overflow = await page.locator("#temu-ai-root").evaluate((node) => node.scrollWidth > node.clientWidth)
    assert.equal(overflow, false, `${scenario.mode}: extension panel should not have horizontal overflow`)
  } finally {
    await page.close()
  }
}

const verifyPublishOutcomeScenario = async (browser, baseUrl) => {
  const page = await browser.newPage({
    viewport: {
      width: 1280,
      height: 900
    }
  })
  page.setDefaultTimeout(60_000)

  try {
    await page.goto(`${baseUrl}?repairPlan=auto-ready&publishOutcome=failed`)
    await page.waitForSelector("#temu-ai-root .temu-ai-panel")
    await page.getByRole("button", { name: "加入队列" }).click()
    await page.waitForFunction(() => document.body.innerText.includes("发布失败"))

    const panel = page.locator("#temu-ai-root")
    const text = await panel.innerText()
    assert(text.includes("发布失败（2/3 次）：missing required attribute Color。下一步：进入故障恢复。"), "publish outcome failure should appear as one compact default alert")
    assert.equal(await page.locator("details.advanced-panel").evaluate((node) => node.open), false, "publish outcome alert should not expand advanced details by default")
    assert.equal(await page.locator("#temu-ai-run").isDisabled(), false, "auto-ready repair plan should keep default fill available even with publish outcome history")

    const overflow = await page.locator("#temu-ai-root").evaluate((node) => node.scrollWidth > node.clientWidth)
    assert.equal(overflow, false, "publish outcome alert should not create horizontal overflow")
  } finally {
    await page.close()
  }
}

const main = async () => {
  writePanelFixture()
  const { server, url } = await createFixtureServer()
  const browser = await chromium.launch({ headless: true })
  const baseUrl = url

  // Warm the browser (first-navigation JIT/profile setup) outside any scenario's
  // wait budget so a cold Windows launch cannot make scenario #1 time out.
  const warmup = await browser.newPage()
  try {
    await warmup.goto(`${baseUrl}?repairPlan=auto-ready`)
    await warmup.waitForSelector("#temu-ai-root .temu-ai-panel", { timeout: 60_000 })
  } finally {
    await warmup.close()
  }

  try {
    for (const scenario of repairPlanScenarios) {
      await verifyRepairPlanScenario(browser, baseUrl, scenario)
    }
    await verifyPublishOutcomeScenario(browser, baseUrl)

    console.log("Extension panel fixture check passed")
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}

await main()
