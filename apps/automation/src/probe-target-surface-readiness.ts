// One-off read-only diagnostic: why does targetSurfaceCanInspect judge a fully
// rendered real edit page as "not an edit surface"? Prints the full fieldReadiness
// + reasons from inspectDianxiaomiTargetSurface. No clicks, no writes.
// Usage: tsx src/probe-target-surface-readiness.ts [--url=...] [--headed=true]
import path from "node:path"
import { chromium } from "playwright"
import { getArgValue, parseBoolean, waitForManualLoginIfNeeded } from "./common"
import { inspectDianxiaomiTargetSurface } from "./adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "./selector-config"

const DEFAULT_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453261437376"

const main = async () => {
  const targetUrl = getArgValue("url") ?? DEFAULT_URL
  const profileDir = path.resolve(getArgValue("profile") ?? ".runtime/dianxiaomi-real-profile")
  const headed = parseBoolean(getArgValue("headed"), false)
  const selectorConfig = loadSelectorConfig(getArgValue("selector-config") ?? ".runtime/dianxiaomi-selector-config.json")

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: !headed,
    viewport: { width: 1440, height: 960 }
  })
  try {
    const page = context.pages().find((item) => !item.isClosed()) ?? await context.newPage()
    page.setDefaultTimeout(20_000)
    if (page.url() !== targetUrl) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined)
    }
    await waitForManualLoginIfNeeded(page)
    // Give the Vue SPA time to hydrate the listing form after domcontentloaded.
    await page.waitForTimeout(6_000)

    const step = await inspectDianxiaomiTargetSurface(page, selectorConfig)
    const data = step.data as Record<string, unknown>
    console.log(JSON.stringify({
      status: step.status,
      detail: step.detail,
      surfaceStatus: data.surfaceStatus,
      canInspect: data.canInspect,
      canWrite: data.canWrite,
      loginOrCaptchaDetected: data.loginOrCaptchaDetected,
      reasons: data.reasons,
      fieldReadiness: data.fieldReadiness,
      pageTitle: data.pageTitle,
      pageUrl: data.pageUrl
    }, null, 2))

    // Diagnose WHY save/submit buttons read 0: dump every element whose text
    // contains 保存/提交/发布, with its real tag/role/class. Reveals whether the
    // control is a <button role=button> (getByRole matches) or an <a>/<div>/<span>
    // (getByRole misses) so we know which detector the surface check should use.
    const buttonLike = await page.evaluate(() => {
      const wanted = ["保存", "暂存", "提交", "发布", "刊登"]
      const out: Array<Record<string, unknown>> = []
      const nodes = Array.from(document.querySelectorAll("button, a, span, div, input"))
      for (const el of nodes) {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim()
        const value = (el as HTMLInputElement).value || ""
        const hay = text || value
        if (!hay || hay.length > 12) continue
        if (!wanted.some((w) => hay.includes(w))) continue
        const rect = el.getBoundingClientRect()
        const visible = rect.width > 0 && rect.height > 0
        // Only keep VISIBLE, short-text controls — skip nav-bar noise like 待发布/采集箱.
        if (!visible) continue
        out.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          type: el.getAttribute("type"),
          cls: (typeof el.className === "string" ? el.className : "").slice(0, 80),
          text: hay,
          top: Math.round(rect.top)
        })
        if (out.length >= 30) break
      }
      return out
    }).catch((e) => ({ evalError: String(e).slice(0, 200) }))
    console.log("=== VISIBLE button-like elements (保存/提交/发布) ===")
    console.log(JSON.stringify(buttonLike, null, 2))

    // For the save/submit spans, check the exact signals isLikelyCompactInteractive
    // relies on (cursor:pointer, onclick, tabindex) so we know a class-regex widening
    // is enough vs. needing a different detector.
    const spanSignals = await page.evaluate(() => {
      const wanted = ["保存", "提交", "发布", "刊登"]
      const out: Array<Record<string, unknown>> = []
      for (const el of Array.from(document.querySelectorAll("span, a, div"))) {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim()
        if (!wanted.includes(text)) continue
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        const cs = getComputedStyle(el)
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: (typeof el.className === "string" ? el.className : "").slice(0, 60),
          text,
          cursor: cs.cursor,
          onclick: el.hasAttribute("onclick"),
          tabindex: el.getAttribute("tabindex")
        })
        if (out.length >= 12) break
      }
      return out
    }).catch((e) => ({ evalError: String(e).slice(0, 200) }))
    console.log("=== exact 保存/提交/发布 controls + interactivity signals ===")
    console.log(JSON.stringify(spanSignals, null, 2))
  } finally {
    await context.close().catch(() => undefined)
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1 })
