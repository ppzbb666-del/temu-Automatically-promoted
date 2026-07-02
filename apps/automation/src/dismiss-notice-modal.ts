// One-off: dismiss the Dianxiaomi 运营公告 (notice-list-modal) popup that overlays
// the edit page and intercepts pointer events, causing automation clicks to time
// out. Read-only w.r.t. the product form — only closes the notice layer(s).
import path from "node:path"
import { chromium } from "playwright"

const PROFILE_DIR = path.resolve(".runtime/dianxiaomi-real-profile")
const URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453257944306"

const main = async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chromium", headless: true, viewport: { width: 1440, height: 960 }
  })
  try {
    const page = context.pages().find((p) => !p.isClosed()) ?? await context.newPage()
    page.setDefaultTimeout(8000)
    if (!page.url().includes("944306")) {
      await page.goto(URL, { waitUntil: "domcontentloaded" }).catch(() => undefined)
    }
    await page.waitForTimeout(3000)
    const closers = [
      ".notice-list-modal .ant-modal-close",
      ".notice-list-modal .anticon-close",
      ".notice-list-modal .ant-modal-close-x",
      ".ant-modal-wrap.notice-list-modal .ant-modal-close",
      ".notice-content__body ~ * .close",
    ]
    let closed = 0
    for (let round = 0; round < 4; round += 1) {
      let acted = false
      for (const sel of closers) {
        const loc = page.locator(sel)
        const n = await loc.count().catch(() => 0)
        for (let i = 0; i < n; i += 1) {
          const it = loc.nth(i)
          if (await it.isVisible().catch(() => false)) {
            await it.click({ timeout: 3000 }).catch(() => undefined)
            closed += 1; acted = true
            await page.waitForTimeout(600)
          }
        }
      }
      // Fallback: press Escape to dismiss any ant-modal on top.
      await page.keyboard.press("Escape").catch(() => undefined)
      await page.waitForTimeout(500)
      const stillThere = await page.locator(".notice-list-modal").isVisible().catch(() => false)
      if (!stillThere && !acted) break
    }
    const remaining = await page.locator(".notice-list-modal").count().catch(() => 0)
    const visibleRemaining = await page.locator(".notice-list-modal").isVisible().catch(() => false)
    console.log(JSON.stringify({ url: page.url(), closedClicks: closed, noticeModalNodes: remaining, noticeModalVisible: visibleRemaining }, null, 2))
  } finally {
    await context.close().catch(() => undefined)
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : String(e)); process.exitCode = 1 })
