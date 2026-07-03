// One-off read-only probe: validate fetchProductImagesFromEditJson's assumption
// against the live Dianxiaomi edit.json — does it expose per-color image URLs for
// "page reference" work items that carry no product.images? No clicks, no writes.
// Usage: tsx src/probe-editjson-images.ts <editUrlOrId> [id...]
import path from "node:path"
import { chromium } from "playwright"

const PROFILE_DIR = path.resolve(".runtime/dianxiaomi-real-profile")

const toId = (arg: string): string | null => {
  try {
    return new URL(arg).searchParams.get("id")
  } catch {
    return /^\d+$/.test(arg) ? arg : null
  }
}

const pushPipe = (urls: string[], value: unknown) => {
  if (typeof value !== "string") return
  for (const part of value.split("|")) {
    const u = part.trim()
    if (/^https?:\/\//i.test(u)) urls.push(u)
  }
}

const main = async () => {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error("usage: tsx src/probe-editjson-images.ts <editUrlOrId> [id...]")
    process.exit(1)
  }
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chromium", headless: true, viewport: { width: 1280, height: 800 }
  })
  try {
    for (const arg of args) {
      const id = toId(arg)
      if (!id) { console.log(JSON.stringify({ arg, error: "no id" })); continue }
      const res = await context.request.get(`https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${id}`)
      if (!res.ok()) { console.log(JSON.stringify({ id, httpStatus: res.status() })); continue }
      const payload = await res.json().catch(() => null) as { data?: { product?: Record<string, unknown> } } | null
      const product = payload?.data?.product
      if (!product) { console.log(JSON.stringify({ id, error: "no product in payload", keys: payload ? Object.keys(payload) : null })); continue }

      const perColor: number[] = []
      const urls: string[] = []
      const specList = (product.mainProductSkuSpecReqsList ?? product.mainProductSkuSpecReqs) as unknown
      if (Array.isArray(specList)) {
        for (const spec of specList) {
          const before = urls.length
          pushPipe(urls, (spec as Record<string, unknown>)?.previewImgUrls)
          perColor.push(urls.length - before)
        }
      }
      const afterColor = urls.length
      pushPipe(urls, product.materialImgUrl)
      pushPipe(urls, product.mainImage)
      pushPipe(urls, product.extraImages)
      const deduped = Array.from(new Set(urls))

      console.log(JSON.stringify({
        id,
        colorSpecCount: Array.isArray(specList) ? specList.length : 0,
        imagesPerColor: perColor,
        fromColorSpecs: afterColor,
        fromFallback: urls.length - afterColor,
        totalDeduped: deduped.length,
        sample: deduped.slice(0, 2)
      }))
    }
  } finally {
    await context.close().catch(() => undefined)
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
