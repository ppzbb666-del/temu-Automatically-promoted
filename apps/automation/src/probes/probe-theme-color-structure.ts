// One-off read-only probe: dump the 主题颜色 / 变种主题 / color SKC section structure
// on a real Dianxiaomi edit page, to find what control must be ticked so save-draft
// stops failing with "主题颜色至少需要选一个". No clicks, no writes.
// Usage: tsx src/probe-theme-color-structure.ts <editUrl>
import path from "node:path"
import { chromium } from "playwright"

const PROFILE_DIR = path.resolve(".runtime/dianxiaomi-real-profile")
const editUrl = process.argv[2]
if (!editUrl) { console.error("usage: tsx src/probe-theme-color-structure.ts <editUrl>"); process.exit(1) }

const main = async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chromium", headless: true, viewport: { width: 1440, height: 1200 }
  })
  try {
    const page = await context.newPage()
    await page.goto(editUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await page.waitForTimeout(3_500)

    // 1) Any element whose text mentions 主题颜色 / 主题色
    const themeMentions = await page.evaluate(() => {
      const out: any[] = []
      const all = Array.from(document.querySelectorAll("*")) as HTMLElement[]
      for (const el of all) {
        const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent || "").join("").trim()
        if (/主题颜色|主题色/.test(own)) {
          out.push({ tag: el.tagName, cls: el.className?.toString().slice(0, 60), text: own.slice(0, 50) })
        }
      }
      return out.slice(0, 15)
    })

    // 2) The color SKC section (.skuAttrItem_1001): rows, checkboxes, which are checked
    const skcState = await page.evaluate(() => {
      const sec = document.querySelector(".skuAttrItem_1001")
      if (!sec) return { found: false }
      const checkboxes = Array.from(sec.querySelectorAll("input[type=checkbox]")) as HTMLInputElement[]
      const checks = checkboxes.slice(0, 30).map(cb => ({
        checked: cb.checked,
        disabled: cb.disabled,
        near: (cb.closest("label,td,tr,div")?.textContent || "").trim().slice(0, 30)
      }))
      const labels = Array.from(sec.querySelectorAll("label")).slice(0, 20).map(l => (l.textContent || "").trim().slice(0, 24)).filter(Boolean)
      return { found: true, checkboxCount: checkboxes.length, checkedCount: checks.filter(c => c.checked).length, checks: checks.slice(0, 12), labels }
    })

    // 3) Variant/SKC color table rows (the 5 groups) + whether any row has a selection/checkbox on
    const colorTable = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".batch-table-wrap.color-table tbody tr"))
      return rows.slice(0, 12).map((r, i) => {
        const cb = r.querySelector("input[type=checkbox]") as HTMLInputElement | null
        return {
          i,
          firstCell: (r.querySelector("td")?.textContent || "").trim().slice(0, 20),
          hasCheckbox: !!cb,
          checked: cb?.checked ?? null
        }
      })
    })

    console.log(JSON.stringify({ editUrl, themeMentions, skcState, colorTable }, null, 2))
  } finally {
    await context.close().catch(() => undefined)
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
