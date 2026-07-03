// One-off read-only probe: dump the real size-chart modal structure for a listing
// so we know what the manual fallback must fill for upper-garment categories
// (A = 女装短针织衫 hit "not configured"). No writes — opens the modal, reads the
// category text + table headers + per-row size labels + input placeholders, closes.
// Usage: tsx src/probe-size-chart-structure.ts [--url=...]
import path from "node:path"
import { chromium, type Locator } from "playwright"
import { getArgValue, waitForManualLoginIfNeeded } from "./common"
import { inspectDianxiaomiTargetSurface, waitForPublishPage } from "./adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "./selector-config"

const DEFAULT_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453257944306"
const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim()

const main = async () => {
  const targetUrl = getArgValue("url") ?? DEFAULT_URL
  const profileDir = path.resolve(getArgValue("profile") ?? ".runtime/dianxiaomi-real-profile")
  const selectorConfig = loadSelectorConfig(getArgValue("selector-config") ?? ".runtime/dianxiaomi-selector-config.json")

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium", headless: true, viewport: { width: 1440, height: 960 }
  })
  try {
    const page = context.pages().find((p) => !p.isClosed()) ?? await context.newPage()
    page.setDefaultTimeout(20_000)
    if (page.url() !== targetUrl) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined)
    }
    await waitForManualLoginIfNeeded(page)
    await waitForPublishPage(page, selectorConfig, { targetUrl })
    await inspectDianxiaomiTargetSurface(page, selectorConfig)
    await page.waitForTimeout(3_000)

    // Click the size chart trigger (same selectors normalizeSizeChart uses).
    const firstVisible = async (locators: Locator[]) => {
      for (const l of locators) {
        const c = Math.min(await l.count().catch(() => 0), 20)
        for (let i = 0; i < c; i += 1) { const it = l.nth(i); if (await it.isVisible().catch(() => false)) return it }
      }
      return null
    }
    const trigger = await firstVisible([
      page.locator(".skuAttrSizeChart .link"),
      page.locator(".ant-form-item").filter({ hasText: /尺码表/ }).locator(".link"),
      page.getByText("添加尺码表", { exact: false }),
      page.getByText("新增尺码表", { exact: false })
    ])
    if (!trigger) { console.log(JSON.stringify({ error: "no size chart trigger visible" })); return }
    await trigger.scrollIntoViewIfNeeded()
    await trigger.click()
    await page.waitForTimeout(1200)

    const modal = page.locator(".ant-modal-content").filter({ hasText: /尺码|size/i }).first()
    if (!(await modal.isVisible().catch(() => false))) {
      console.log(JSON.stringify({ error: "size chart modal did not open" }))
      return
    }

    // Category text (first select), template selects, table headers, rows, inputs.
    const selectTexts: string[] = []
    const selects = modal.locator(".ant-select")
    const selCount = Math.min(await selects.count().catch(() => 0), 6)
    for (let i = 0; i < selCount; i += 1) selectTexts.push(clean(await selects.nth(i).innerText().catch(() => "")))

    const headers: string[] = []
    const headerCells = modal.locator("thead th, thead td, table tr:first-child th, table tr:first-child td")
    const hc = Math.min(await headerCells.count().catch(() => 0), 12)
    for (let i = 0; i < hc; i += 1) headers.push(clean(await headerCells.nth(i).innerText().catch(() => "")))

    const rows = modal.locator("table tr")
    const rc = Math.min(await rows.count().catch(() => 0), 14)
    const rowDump: Array<Record<string, unknown>> = []
    for (let i = 0; i < rc; i += 1) {
      const row = rows.nth(i)
      if (!await row.isVisible().catch(() => false)) continue
      const cells = row.locator("td")
      const cc = Math.min(await cells.count().catch(() => 0), 12)
      if (cc === 0) continue
      const cellTexts: string[] = []
      for (let j = 0; j < cc; j += 1) cellTexts.push(clean(await cells.nth(j).innerText().catch(() => "")))
      const inputs = row.locator("input")
      const ic = Math.min(await inputs.count().catch(() => 0), 12)
      const inputInfo: Array<{ type: string; ph: string; val: string }> = []
      for (let j = 0; j < ic; j += 1) {
        const inp = inputs.nth(j)
        if (!await inp.isVisible().catch(() => false)) continue
        inputInfo.push({
          type: await inp.getAttribute("type").catch(() => "") ?? "",
          ph: clean(await inp.getAttribute("placeholder").catch(() => "")),
          val: clean(await inp.inputValue().catch(() => ""))
        })
      }
      rowDump.push({ rowIndex: i, cells: cellTexts, inputCount: inputInfo.length, inputs: inputInfo })
    }

    console.log(JSON.stringify({
      pageUrl: page.url(),
      selectTexts,
      headers,
      rowCount: rowDump.length,
      rows: rowDump,
      modalTextExcerpt: clean(await modal.innerText().catch(() => "")).slice(0, 600)
    }, null, 2))
  } finally {
    await context.close().catch(() => undefined)
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : String(e)); process.exitCode = 1 })
