// One-off read-only probe: does each Dianxiaomi edit page already have a Temu category selected?
// Reads the same "未选择分类" signal the adapter uses. No clicks, no writes.
import path from "node:path"
import { chromium } from "playwright"

const PROFILE_DIR = path.resolve(".runtime/dianxiaomi-real-profile")
const CATEGORY_MISSING_TEXT = "未选择分类"

const urls = process.argv.slice(2)
if (urls.length === 0) {
  console.error("usage: tsx src/probe-readonly-category-state.ts <url> [url...]")
  process.exit(1)
}

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
        const bodyText = (await page.locator("body").textContent().catch(() => "")) ?? ""
        const categoryButton = await page
          .getByText(/选择分类|选择类目/)
          .first()
          .isVisible()
          .catch(() => false)
        // Grab any text near a "分类/类目" label for context
        const nearby = (bodyText.match(/.{0,12}(?:分类|类目).{0,40}/g) ?? []).slice(0, 4)
        console.log(JSON.stringify({
          url,
          title: await page.title().catch(() => ""),
          missingCategory: bodyText.includes(CATEGORY_MISSING_TEXT),
          selectCategoryButtonVisible: categoryButton,
          nearbyCategoryText: nearby
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
