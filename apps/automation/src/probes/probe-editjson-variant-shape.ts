// Read-only probe: compare the SKU/color variant STRUCTURE of two products via
// the authenticated edit.json API. This is the truly read-only way to see why
// fill-sku-image-links' color-image cells (td.color-table-cell[data-column-index='2'])
// exist on one product but not the other — the cells only render in the DOM
// after variant-remap (a write), but edit.json exposes the underlying variant
// shape without touching the page. Navigates to each edit page first so the API
// request inherits the warmed session (mirrors fetchProductImagesFromEditJson).
//
// Read-only: goto + authenticated GET only. No clicks, no writes.
// Usage: tsx src/probes/probe-editjson-variant-shape.ts <id> [id...]
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type Page } from "playwright"
import { getArgValue, parseBoolean } from "../common"

const DEFAULT_PROFILE = ".runtime/playwright/dianxiaomi-profile"

const summarizeSpec = (spec: Record<string, unknown>) => {
  const keys = Object.keys(spec)
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const v = spec[k]
    if (Array.isArray(v)) out[k] = `array[${v.length}]`
    else if (v && typeof v === "object") out[k] = `object{${Object.keys(v).slice(0, 6).join(",")}}`
    else if (typeof v === "string") out[k] = v.length > 60 ? v.slice(0, 60) + "…" : v
    else out[k] = v
  }
  return out
}

const inspect = async (page: Page, id: string) => {
  await page.goto(`https://www.dianxiaomi.com/web/popTemu/edit?id=${id}`, { waitUntil: "domcontentloaded" }).catch(() => undefined)
  await page.waitForTimeout(4_000)
  const res = await page.context().request.get(`https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${id}`)
  const payload = await res.json().catch(() => null) as { code?: number; msg?: string; data?: { product?: Record<string, unknown> } } | null
  if (payload?.code && payload.code !== 0 && payload.code !== 200) {
    return { id, apiCode: payload.code, apiMsg: payload.msg }
  }
  const product = payload?.data?.product
  if (!product) {
    return { id, error: "no product", topKeys: payload ? Object.keys(payload) : null }
  }

  // All sku/spec/variant-related fields on the product, with shapes.
  const skuKeys = Object.keys(product).filter((k) => /sku|spec|variant|color|image|img|preview/i.test(k))
  const skuFieldShapes: Record<string, unknown> = {}
  for (const k of skuKeys) {
    const v = (product as Record<string, unknown>)[k]
    skuFieldShapes[k] = Array.isArray(v) ? `array[${v.length}]` : v && typeof v === "object" ? `object{${Object.keys(v).slice(0, 8).join(",")}}` : typeof v === "string" ? (v.length > 40 ? v.slice(0, 40) + "…" : v) : v
  }

  // The color-spec list: how the adapter recovers per-color images. Each entry is
  // a color variant; its previewImgUrls / image fields drive the SKU image cells.
  const specList = ((product as Record<string, unknown>).mainProductSkuSpecReqsList
    ?? (product as Record<string, unknown>).mainProductSkuSpecReqs) as unknown[]
  const colorSpecCount = Array.isArray(specList) ? specList.length : 0
  const colorSpecSample = Array.isArray(specList) && specList.length > 0
    ? summarizeSpec(specList[0] as Record<string, unknown>)
    : null
  const colorSpecImgKeys = Array.isArray(specList) && specList.length > 0
    ? Object.keys(specList[0] as Record<string, unknown>).filter((k) => /img|image|preview|pic/i.test(k))
    : []
  const perColorImgCounts = Array.isArray(specList)
    ? specList.slice(0, 20).map((spec) => {
        const s = spec as Record<string, unknown>
        // count pipe-joined preview image urls if present
        const preview = typeof s.previewImgUrls === "string" ? s.previewImgUrls : ""
        return preview ? preview.split("|").filter((u) => /^https?:/i.test(u.trim())).length : 0
      })
    : []

  return {
    id,
    productName: String((product as Record<string, unknown>).productName ?? (product as Record<string, unknown>).title ?? "").slice(0, 40),
    skuFieldShapes,
    colorSpecCount,
    colorSpecImgKeys,
    colorSpecSample,
    perColorImgCounts
  }
}

const main = async () => {
  const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a))
  if (ids.length === 0) {
    console.error("usage: tsx src/probes/probe-editjson-variant-shape.ts <id> [id...]")
    process.exit(1)
  }
  const profileDir = path.resolve(getArgValue("profile") ?? DEFAULT_PROFILE)
  const headed = parseBoolean(getArgValue("headed"), false)
  const artifactDir = path.resolve(getArgValue("artifact-dir") ?? `.runtime/probe-editjson-variant-shape-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  await mkdir(artifactDir, { recursive: true })

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: !headed,
    viewport: { width: 1440, height: 960 }
  })
  try {
    const page = await context.newPage()
    const results = []
    for (const id of ids) {
      results.push(await inspect(page, id))
    }
    const jsonPath = path.join(artifactDir, "probe-editjson-variant-shape.json")
    await writeFile(jsonPath, JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2), "utf8")
    console.log(jsonPath)
  } finally {
    await context.close().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
