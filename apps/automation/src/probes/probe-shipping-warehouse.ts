// Read-only probe: dump 896984's 发货仓 (shipping warehouse) + 配送时效 (delivery
// time / working-days) selectors in the 运输信息 section, plus the LV2600 stock
// binding. Temu rejected submit with "不支持发货仓 LV2600, 请换三方仓/自营仓/家庭仓".
// User (US 半托管) says the correct warehouse IS supported and needs the 9-working-
// day option. This dumps the real select options + current values so we can either
// automate the correct pick or tell the user exactly what to set. NO writes.
// Usage: tsx src/probes/probe-shipping-warehouse.ts [--url=...] [--profile=...]
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium } from "playwright"
import { getArgValue, waitForManualLoginIfNeeded } from "../common"
import { inspectDianxiaomiTargetSurface, waitForPublishPage } from "../adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "../selector-config"

const DEFAULT_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453047896984"

const main = async () => {
  const targetUrl = getArgValue("url") ?? DEFAULT_URL
  const profileDir = getArgValue("profile") ?? ".runtime/playwright/dianxiaomi-profile"
  const cfg = loadSelectorConfig(".runtime/dianxiaomi-selector-config.json")
  const artifactDir = path.resolve(`.runtime/probe-shipping-warehouse-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  await mkdir(artifactDir, { recursive: true })
  const context = await chromium.launchPersistentContext(profileDir, { channel: "chromium", headless: true, viewport: { width: 1440, height: 960 } })
  try {
    const page = context.pages().find((p) => !p.isClosed()) ?? await context.newPage()
    page.setDefaultTimeout(20000)
    if (page.url() !== targetUrl) await page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined)
    await waitForManualLoginIfNeeded(page)
    await waitForPublishPage(page, cfg, { targetUrl })
    await inspectDianxiaomiTargetSurface(page, cfg)
    await page.waitForTimeout(2500)

    // Scroll to 运输信息 section
    await page.evaluate(() => {
      const n = Array.from(document.querySelectorAll("*")).find((x) => /运输信息|发货仓|配送/.test((x as HTMLElement).innerText?.slice(0, 30) ?? ""))
      n?.scrollIntoView({ block: "center" })
    }).catch(() => undefined)
    await page.waitForTimeout(800)

    const dump = await page.evaluate(() => {
      const clean = (s: string) => s.replace(/\s+/g, " ").trim()
      // Any ant-select or native select whose surrounding label mentions warehouse/delivery/时效
      const results: Array<{ labelContext: string; kind: string; currentValue: string; options: string[] }> = []
      // ant-selects
      const antSelects = Array.from(document.querySelectorAll(".ant-select")) as HTMLElement[]
      for (const sel of antSelects) {
        const ctx = clean((sel.closest(".ant-form-item, td, tr, [class*='item' i]") as HTMLElement | null)?.innerText ?? "")
        if (!/发货仓|仓库|配送|时效|运输|工作日|warehouse|delivery|ship/i.test(ctx)) continue
        const current = clean((sel.querySelector(".ant-select-selection-item") as HTMLElement | null)?.innerText ?? (sel.querySelector(".ant-select-selection-placeholder") as HTMLElement | null)?.innerText ?? "")
        results.push({ labelContext: ctx.slice(0, 100), kind: "ant-select", currentValue: current, options: [] })
      }
      // native selects
      const natSelects = Array.from(document.querySelectorAll("select")) as HTMLSelectElement[]
      for (const sel of natSelects) {
        const ctx = clean((sel.closest(".ant-form-item, td, tr, [class*='item' i]") as HTMLElement | null)?.innerText ?? "")
        if (!/发货仓|仓库|配送|时效|运输|工作日|warehouse|delivery|ship/i.test(ctx)) continue
        results.push({ labelContext: ctx.slice(0, 100), kind: "native-select", currentValue: sel.value, options: Array.from(sel.options).map((o) => clean(o.text)).slice(0, 40) })
      }
      // free-text scan of the 运输信息 area for warehouse/delivery mentions
      const shipSection = Array.from(document.querySelectorAll("*")).find((x) => /运输信息/.test((x as HTMLElement).innerText?.slice(0, 20) ?? ""))
      const shipText = clean((shipSection?.closest("[class*='module' i], .ant-card, section, form") as HTMLElement | null)?.innerText ?? shipSection?.parentElement?.innerText ?? "").slice(0, 800)
      // LV2600 / warehouse mentions anywhere
      const bodyText = document.body.innerText
      const whMentions = [...new Set((bodyText.match(/[^\n]{0,15}(LV\d+|三方仓|自营仓|家庭仓|合作履约仓|发货仓|工作日|日达|时效)[^\n]{0,20}/gi) ?? []))].slice(0, 15)
      return { selectors: results, shipText, whMentions }
    })

    await writeFile(path.join(artifactDir, "probe-shipping-warehouse.json"), JSON.stringify(dump, null, 2), "utf8")
    await page.screenshot({ path: path.join(artifactDir, "shipping-section.png"), fullPage: false }).catch(() => undefined)
    console.log("selectors found:", dump.selectors.length)
    dump.selectors.forEach((s) => console.log(`  [${s.kind}] ctx="${s.labelContext}" current="${s.currentValue}" opts=${JSON.stringify(s.options.slice(0, 12))}`))
    console.log("warehouse/delivery mentions:", JSON.stringify(dump.whMentions))
    console.log("shipText:", dump.shipText.slice(0, 400))
    console.log(path.join(artifactDir, "probe-shipping-warehouse.json"))
  } finally { await context.close().catch(() => undefined) }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : String(e)); process.exitCode = 1 })
