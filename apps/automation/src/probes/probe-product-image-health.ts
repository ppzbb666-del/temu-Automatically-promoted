// Read-only: for each product id, read edit.json (SKU/variant structure) AND
// HEAD/GET the carousel image URLs to confirm they return real image bytes (not
// the 0×0 broken state that blocks 1:1 resize). Picks a product with valid
// carousel images AND skuCount ≤ cap for the 1:1 full-flow verification. No fill.
// Usage: tsx src/probes/probe-product-image-health.ts <id> [id...] [--max-sku=200]
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type Page } from "playwright"
import { getArgValue, waitForManualLoginIfNeeded } from "../common"
import { inspectDianxiaomiTargetSurface, waitForPublishPage } from "../adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "../selector-config"

const PROFILE = ".runtime/playwright/dianxiaomi-profile"
const splitPipe = (v: unknown): string[] =>
  typeof v === "string" ? v.split("|").map((s) => s.trim()).filter((s) => /^https?:/i.test(s)) : []

const inspect = async (page: Page, id: string, selectorConfig: ReturnType<typeof loadSelectorConfig>) => {
  const editUrl = `https://www.dianxiaomi.com/web/popTemu/edit?id=${id}`
  if (page.url() !== editUrl) await page.goto(editUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined)
  await waitForManualLoginIfNeeded(page)
  await waitForPublishPage(page, selectorConfig, { targetUrl: editUrl })
  await inspectDianxiaomiTargetSurface(page, selectorConfig)
  await page.waitForTimeout(2000)

  const res = await page.context().request.get(`https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${id}`)
  const payload = await res.json().catch(() => null) as { code?: number; msg?: string; data?: { product?: Record<string, unknown> } } | null
  const product = payload?.data?.product
  if (!product) return { id, error: "no product (published or blocked)", apiCode: payload?.code, apiMsg: payload?.msg }

  const specList = (product.mainProductSkuSpecReqsList ?? product.mainProductSkuSpecReqs) as unknown[]
  const colorSpecCount = Array.isArray(specList) ? specList.length : 0
  // gather carousel/material image URLs
  const urls: string[] = []
  urls.push(...splitPipe(product.materialImgUrl), ...splitPipe(product.mainImage), ...splitPipe(product.extraImages))
  if (Array.isArray(specList)) for (const spec of specList.slice(0, 3)) urls.push(...splitPipe((spec as Record<string, unknown>).previewImgUrls))
  const uniqueUrls = Array.from(new Set(urls)).slice(0, 6)

  // fetch each url and check it returns real image bytes
  const imgHealth: Array<{ url: string; ok: boolean; status: number; type: string; bytes: number }> = []
  for (const url of uniqueUrls) {
    const r = await page.context().request.get(url).catch(() => null)
    if (!r) { imgHealth.push({ url: url.slice(0, 60), ok: false, status: 0, type: "", bytes: 0 }); continue }
    const body = await r.body().catch(() => Buffer.alloc(0))
    const type = r.headers()["content-type"] ?? ""
    imgHealth.push({ url: url.slice(0, 60), ok: r.ok() && /image\//i.test(type) && body.length > 512, status: r.status(), type, bytes: body.length })
  }
  const healthyImages = imgHealth.filter((h) => h.ok).length
  // best-effort SKU count: largest sku-named flat array on product
  const skuKeys = Object.keys(product).filter((k) => /sku/i.test(k))
  let skuRowCount = 0
  for (const k of skuKeys) { const v = (product as Record<string, unknown>)[k]; if (Array.isArray(v)) skuRowCount = Math.max(skuRowCount, v.length) }

  return {
    id,
    title: String(product.productName ?? product.title ?? "").slice(0, 30),
    colorSpecCount,
    skuRowCount,
    carouselUrlCount: uniqueUrls.length,
    healthyImages,
    imgHealth
  }
}

const main = async () => {
  const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a))
  const maxSku = Number(getArgValue("max-sku") ?? "200")
  const selectorConfig = loadSelectorConfig(".runtime/dianxiaomi-selector-config.json")
  const artifactDir = path.resolve(`.runtime/probe-product-image-health-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  await mkdir(artifactDir, { recursive: true })
  const context = await chromium.launchPersistentContext(path.resolve(PROFILE), { channel: "chromium", headless: true, viewport: { width: 1440, height: 960 } })
  try {
    const page = context.pages().find((p) => !p.isClosed()) ?? await context.newPage()
    page.setDefaultTimeout(20000)
    const results = []
    for (const id of ids) results.push(await inspect(page, id, selectorConfig))
    const eligible = results.filter((r) => !("error" in r) && (r as { healthyImages: number }).healthyImages > 0 && (r as { skuRowCount: number }).skuRowCount <= maxSku)
    await writeFile(path.join(artifactDir, "probe-product-image-health.json"), JSON.stringify({ createdAt: new Date().toISOString(), maxSku, results, eligibleIds: eligible.map((r) => (r as { id: string }).id) }, null, 2), "utf8")
    console.log(path.join(artifactDir, "probe-product-image-health.json"))
  } finally { await context.close().catch(() => undefined) }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : String(e)); process.exitCode = 1 })
