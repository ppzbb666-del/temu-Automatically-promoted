// Read-only diagnostic: why do batch-resize / image-translation report
// missing-tool during fill even though probe-carousel-media-tools finds the same
// "编辑图片" entry? Calls the PRODUCTION collectMediaToolCandidates + findImageOptionsTrigger
// (not copied logic) and dumps, for the real carousel trigger, tagName/className/
// cursor and whether the production isLikelyCompactInteractive filter accepts it.
// Read-only: navigates + reads DOM, no clicks/writes.
// Usage: tsx src/probes/probe-media-tool-discovery.ts [--url=...] [--profile=...]
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium } from "playwright"
import { getArgValue, waitForManualLoginIfNeeded } from "../common"
import {
  collectMediaToolCandidates,
  findImageOptionsTrigger,
  inspectDianxiaomiTargetSurface,
  waitForPublishPage
} from "../adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "../selector-config"

const DEFAULT_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453047896984"
const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim()

const main = async () => {
  const targetUrl = getArgValue("url") ?? DEFAULT_URL
  const profileDir = path.resolve(getArgValue("profile") ?? ".runtime/playwright/dianxiaomi-profile")
  const selectorConfig = loadSelectorConfig(getArgValue("selector-config") ?? ".runtime/dianxiaomi-selector-config.json")
  const artifactDir = path.resolve(getArgValue("artifact-dir") ?? `.runtime/probe-media-tool-discovery-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  await mkdir(artifactDir, { recursive: true })

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium", headless: true, viewport: { width: 1440, height: 960 }
  })
  try {
    const page = context.pages().find((p) => !p.isClosed()) ?? await context.newPage()
    page.setDefaultTimeout(20_000)
    if (page.url() !== targetUrl) await page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined)
    await waitForManualLoginIfNeeded(page)
    await waitForPublishPage(page, selectorConfig, { targetUrl })
    await inspectDianxiaomiTargetSurface(page, selectorConfig)
    await page.waitForTimeout(3_000)

    // 1) Raw DOM: every element whose text contains 编辑图片 — dump the exact
    //    tag/class/cursor + whether it is inside .img-module, so we see if the
    //    production .img-module-scoped selectors can reach it.
    const rawTriggers = await page.evaluate(() => {
      const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim()
      const nodes = Array.from(document.querySelectorAll("*")).filter((n) => {
        const t = clean((n as HTMLElement).innerText || n.textContent)
        return /编辑图片/.test(t) && t.length <= 16
      })
      return nodes.slice(0, 12).map((n) => {
        const el = n as HTMLElement
        const cs = getComputedStyle(el)
        return {
          tag: el.tagName.toLowerCase(),
          className: typeof el.className === "string" ? el.className : "",
          role: el.getAttribute("role"),
          tabindex: el.getAttribute("tabindex"),
          hasOnclick: el.hasAttribute("onclick"),
          cursor: cs.cursor,
          text: clean(el.innerText || el.textContent).slice(0, 30),
          inImgModule: Boolean(el.closest(".img-module")),
          closestModuleClass: (el.closest("[class*='img-module' i], [class*='module' i]") as HTMLElement | null)?.className ?? null,
          // replicate the production isLikelyCompactInteractive decision inline so
          // we can see WHY it would accept/reject (read-only, no import needed here)
          intrinsic: ["button", "a", "input"].includes(el.tagName.toLowerCase()),
          interactiveRole: ["button", "link", "menuitem"].includes(el.getAttribute("role") ?? ""),
          classRegexHit: /\b(btn|button|tool|action|operate|menu|media|image|upload|translate|resize|editor|manage)\b/i.test(typeof el.className === "string" ? el.className : "")
        }
      })
    }).catch((e) => ({ evalError: String(e) }))

    // 2) Production trigger finder result.
    const prodTrigger = await findImageOptionsTrigger(page).catch(() => null)
    const prodTriggerInfo = prodTrigger
      ? await prodTrigger.evaluate((el) => ({
          tag: (el as HTMLElement).tagName.toLowerCase(),
          className: typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className : "",
          text: ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30)
        })).catch(() => null)
      : null

    // 3) Production candidate collection — the actual function fill uses.
    const candidates = await collectMediaToolCandidates(page, selectorConfig).catch((e) => [{ collectError: String(e) }])
    const candidateSummary = (candidates as Array<Record<string, unknown>>).map((c) => ({
      id: c.id,
      hasLocator: Boolean(c.locator),
      locatorDescriptor: c.locatorDescriptor ?? null,
      selectorConfigured: c.selectorConfigured ?? null,
      collectError: c.collectError ?? undefined
    }))

    await page.screenshot({ path: path.join(artifactDir, "discovery.png") }).catch(() => undefined)
    const payload = {
      createdAt: new Date().toISOString(),
      targetUrl,
      pageUrl: page.url(),
      rawTriggers,
      prodTriggerFound: Boolean(prodTrigger),
      prodTriggerInfo,
      candidateSummary
    }
    const jsonPath = path.join(artifactDir, "probe-media-tool-discovery.json")
    await writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8")
    console.log(jsonPath)
  } finally {
    await context.close().catch(() => undefined)
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : String(e)); process.exitCode = 1 })
