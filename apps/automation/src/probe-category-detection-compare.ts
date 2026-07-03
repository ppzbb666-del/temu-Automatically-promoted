// One-off: compare textContent-based vs innerText-based "未选择分类" detection,
// the exact discrepancy between probe-readonly-category-state.ts (textContent)
// and the adapter's inspectCategoryPreparationState (innerText). Read-only.
// Usage: tsx src/probe-category-detection-compare.ts <url> [url...]
import path from "node:path"
import { chromium } from "playwright"

const PROFILE_DIR = path.resolve(".runtime/dianxiaomi-real-profile")
const MISSING = "未选择分类"

const urls = process.argv.slice(2)
const main = async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 960 }
  })
  try {
    for (const url of urls) {
      const page = await context.newPage()
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })
        await page.waitForTimeout(3_000)
        const textContent = (await page.locator("body").textContent().catch(() => "")) ?? ""
        const innerText = (await page.locator("body").innerText().catch(() => "")) ?? ""
        console.log(JSON.stringify({
          url,
          byTextContent_missing: textContent.includes(MISSING),
          byInnerText_missing: innerText.includes(MISSING)
        }))
      } catch (error) {
        console.log(JSON.stringify({ url, error: error instanceof Error ? error.message : String(error) }))
      } finally {
        await page.close().catch(() => undefined)
      }
    }
  } finally {
    await context.close().catch(() => undefined)
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
