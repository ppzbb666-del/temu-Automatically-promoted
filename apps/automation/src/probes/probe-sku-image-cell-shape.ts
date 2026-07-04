// Read-only probe: compare the SKU color-image-cell DOM between a page where
// fill-sku-image-links FAILS ("SKU image cells not found") and one where it
// SUCCEEDS, to explain why findSkuImageCells' selector
// `td.color-table-cell[data-column-index='2']` matches zero cells on the former.
//
// Read-only: goto + DOM inspection only. No clicks, no writes, no save/submit.
// Usage:
//   tsx src/probes/probe-sku-image-cell-shape.ts \
//     --fail=<editUrlOrId> --ok=<editUrlOrId> [--profile=<dir>] [--headed=true]
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type Page } from "playwright"
import { getArgValue, parseBoolean } from "../common"

const DEFAULT_PROFILE = ".runtime/playwright/dianxiaomi-profile"
const DEFAULT_FAIL = "161406453047896984"
const DEFAULT_OK = "161406453047896424"

const toEditUrl = (arg: string) =>
  /^\d+$/.test(arg) ? `https://www.dianxiaomi.com/web/popTemu/edit?id=${arg}` : arg

// Runs in the page. Reports everything needed to compare the SKU image-cell
// region: the exact adapter selector's match count, plus every table/td shape
// that could be the color image grid, so we can tell "different DOM shape"
// (→ adapt selector) from "no per-color image grid at all" (→ skip).
const inspectEval = new Function(String.raw`
  const clean = (v) => (v ?? "").replace(/\s+/g, " ").trim()
  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) return false
    const s = window.getComputedStyle(node)
    const r = node.getBoundingClientRect()
    return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0
  }
  const tdShape = (td) => ({
    className: typeof td.className === "string" ? td.className : "",
    dataColumnIndex: td.getAttribute("data-column-index"),
    dataRowIndex: td.getAttribute("data-row-index"),
    imgCount: td.querySelectorAll("img").length,
    hasSelectImage: /选择图片|选择图|上传|add|upload/i.test(clean(td.innerText || td.textContent)),
    text: clean(td.innerText || td.textContent).slice(0, 80)
  })

  // 1) The EXACT selector findSkuImageCells uses.
  const adapterSelector = "td.color-table-cell[data-column-index='2']"
  const adapterCells = Array.from(document.querySelectorAll(adapterSelector))
  const adapterVisibleCells = adapterCells.filter(isVisible)

  // 2) Broader color-table cell shapes to see what actually exists.
  const anyColorTableCell = Array.from(document.querySelectorAll("td.color-table-cell"))
  const columnIndexHistogram = {}
  for (const td of anyColorTableCell) {
    const ci = td.getAttribute("data-column-index") ?? "(none)"
    columnIndexHistogram[ci] = (columnIndexHistogram[ci] || 0) + 1
  }

  // 3) Candidate color/variant tables and their header + a sample row's tds.
  const tableSelectors = [
    ".batch-table-wrap.color-table",
    ".color-table",
    "table.color-table",
    ".batch-table-wrap",
    ".skuAttrItem_1001",
    ".variantImgTable, [class*='colorTable' i], [class*='color-table' i]"
  ]
  const tables = []
  const seen = new Set()
  for (const sel of tableSelectors) {
    for (const node of Array.from(document.querySelectorAll(sel))) {
      if (seen.has(node)) continue
      seen.add(node)
      const rows = Array.from(node.querySelectorAll("tr")).filter(isVisible)
      const headerCells = rows.length ? Array.from(rows[0].querySelectorAll("th, td")).map((c) => clean(c.innerText || c.textContent).slice(0, 24)) : []
      // pick a data row (prefer one that has an img or a "选择图片" cell)
      const dataRow = rows.find((r) => Array.from(r.querySelectorAll("td")).some((c) => c.querySelector("img") || /选择图片|选择图|上传/i.test(clean(c.innerText || c.textContent)))) || rows[1] || rows[0]
      tables.push({
        selector: sel,
        matchedClassName: typeof node.className === "string" ? node.className : "",
        visible: isVisible(node),
        rowCount: rows.length,
        headerCells,
        sampleRowTds: dataRow ? Array.from(dataRow.querySelectorAll("td")).map(tdShape) : []
      })
    }
  }

  // 4) The per-color "图片(3-10张)" / "每色3图" requirement signal + image-cell
  //    columns identified by their header text (image column, whatever its index).
  const bodyText = clean(document.body ? document.body.innerText : "")
  const requirement = {
    hasImage3to10Header: /图片\s*[\(（]\s*3\s*-\s*10\s*张\s*[\)）]/.test(bodyText),
    hasPerColor3ImgText: /每色.*3.*图|颜色.*必须.*上传.*3.*图|至少.*3.*张/.test(bodyText),
    mentionsSelectImage: (bodyText.match(/选择图片/g) || []).length
  }

  // 5) Any td whose header column is the image column — find image cells the
  //    robust way (by header text) regardless of data-column-index.
  let imageColumnIndex = -1
  const firstColorTable = document.querySelector(".batch-table-wrap.color-table, .color-table, table")
  if (firstColorTable) {
    const headerRow = firstColorTable.querySelector("tr")
    if (headerRow) {
      const hs = Array.from(headerRow.querySelectorAll("th, td"))
      imageColumnIndex = hs.findIndex((c) => /图片/.test(clean(c.innerText || c.textContent)))
    }
  }

  return {
    url: location.href,
    title: document.title,
    adapterSelector,
    adapterSelectorMatchCount: adapterCells.length,
    adapterSelectorVisibleCount: adapterVisibleCells.length,
    adapterSampleCells: adapterVisibleCells.slice(0, 4).map(tdShape),
    anyColorTableCellCount: anyColorTableCell.length,
    columnIndexHistogram,
    imageColumnIndexByHeader: imageColumnIndex,
    tables,
    requirement,
    bodyMentionsVariantInfo: /变种信息/.test(bodyText)
  }
`)

const inspectPage = async (page: Page, url: string, artifactDir: string, tag: string) => {
  // The Dianxiaomi edit page bounces to the ERP home on first load and needs a
  // re-navigation before the listing form renders — mirror the adapter's
  // refresh-until-form-loads loop (read-only: goto + scroll only). We wait for
  // the color/variant table, the strongest signal the SKU image grid mounted.
  const colorTableSelector = ".batch-table-wrap.color-table tbody tr, td.color-table-cell, .color-table tr"
  // Warm the SPA session on the ERP home first so the edit route does not bounce.
  await page.goto("https://www.dianxiaomi.com/web/popTemu/product.htm", { waitUntil: "domcontentloaded" }).catch(() => undefined)
  await page.waitForTimeout(4_000)
  let landedOnForm = false
  let sawLoginPage = false
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined)
    await page.waitForTimeout(3_500)
    const currentUrl = page.url()
    // Detect an expired session: the edit route redirects to home and shows a
    // login form (username / password / captcha). Surface it instead of silently
    // returning an empty DOM — re-login is required before this probe is useful.
    const loginVisible = await page.locator("input[type='password'], input[placeholder*='密码'], input[placeholder*='验证码']").first().isVisible().catch(() => false)
    if (loginVisible || /\/(index\.htm|login)/i.test(currentUrl)) {
      sawLoginPage = sawLoginPage || loginVisible
    }
    const onEdit = /\/web\/popTemu\/edit/.test(currentUrl)
    if (onEdit) {
      // The 变种信息 color/image table is lazily rendered far down the page.
      // Click the "变种信息" sidebar anchor, then incrementally scroll the whole
      // page to the bottom so every lazy section mounts. Read-only: navigation
      // clicks + scrolling only, no form edits, no save/submit.
      await page.evaluate(() => {
        const anchor = Array.from(document.querySelectorAll("a, li, span, div"))
          .find((n) => {
            const t = ((n as HTMLElement).innerText || n.textContent || "").replace(/\s+/g, " ").trim()
            return t === "变种信息"
          }) as HTMLElement | undefined
        anchor?.click()
        anchor?.scrollIntoView({ block: "center" })
      }).catch(() => undefined)
      await page.waitForTimeout(1_500)
      // step-scroll to the bottom to force lazy mounts
      await page.evaluate(async () => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
        const step = Math.max(600, Math.floor(window.innerHeight * 0.8))
        for (let y = 0; y <= document.body.scrollHeight; y += step) {
          window.scrollTo(0, y)
          await sleep(250)
        }
        // then bring the color section back into view
        const el = document.querySelector(".skuAttrItem_1001, .batch-table-wrap.color-table, .color-table")
        el?.scrollIntoView({ block: "center" })
      }).catch(() => undefined)
      await page.waitForTimeout(2_500)
      const appeared = await page.locator(colorTableSelector).first().waitFor({ timeout: 15_000 }).then(() => true).catch(() => false)
      if (appeared) {
        landedOnForm = true
        break
      }
    }
    // not on the form yet (redirected to home, or form not rendered) — retry
    await page.waitForTimeout(2_000)
  }
  await page.waitForTimeout(2_000)
  const state = await page.evaluate(inspectEval as never).catch((e) => ({ evalError: String(e) }))
  const stateWithMeta = state && typeof state === "object"
    ? { landedOnForm, sessionExpired: !landedOnForm && sawLoginPage, ...state }
    : { landedOnForm, sessionExpired: !landedOnForm && sawLoginPage, raw: state }
  await page.screenshot({ path: path.join(artifactDir, `${tag}.png`) }).catch(() => undefined)
  return stateWithMeta
}

const main = async () => {
  const failUrl = toEditUrl(getArgValue("fail") ?? DEFAULT_FAIL)
  const okUrl = toEditUrl(getArgValue("ok") ?? DEFAULT_OK)
  const profileDir = path.resolve(getArgValue("profile") ?? DEFAULT_PROFILE)
  const headed = parseBoolean(getArgValue("headed"), false)
  const artifactDir = path.resolve(
    getArgValue("artifact-dir") ?? `.runtime/probe-sku-image-cell-shape-${new Date().toISOString().replace(/[:.]/g, "-")}`
  )
  await mkdir(artifactDir, { recursive: true })

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: !headed,
    viewport: { width: 1440, height: 960 }
  })
  try {
    const page = await context.newPage()
    const fail = await inspectPage(page, failUrl, artifactDir, "fail")
    const ok = await inspectPage(page, okUrl, artifactDir, "ok")
    const payload = { createdAt: new Date().toISOString(), artifactDir, failUrl, okUrl, fail, ok }
    const jsonPath = path.join(artifactDir, "probe-sku-image-cell-shape.json")
    await writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8")
    console.log(jsonPath)
  } finally {
    await context.close().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
