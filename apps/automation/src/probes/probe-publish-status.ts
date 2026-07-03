// One-off read-only probe: did the listing actually submit? Reads Dianxiaomi's
// own status for the product via edit.json (product.status / auditStatus / any
// publish-state field) and the page's status label. No clicks, no submit, no writes.
// Usage: tsx src/probe-publish-status.ts [--id=...] [--url=...]
import path from "node:path"
import { chromium } from "playwright"

const PROFILE_DIR = path.resolve(".runtime/dianxiaomi-real-profile")
const DEFAULT_ID = "161406453257944306"

const toId = (arg: string | undefined): string | null => {
  if (!arg) return null
  try { return new URL(arg).searchParams.get("id") } catch { return /^\d+$/.test(arg) ? arg : null }
}
const getArg = (name: string) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

const main = async () => {
  const id = toId(getArg("id")) ?? toId(getArg("url")) ?? DEFAULT_ID
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chromium", headless: true, viewport: { width: 1280, height: 800 }
  })
  try {
    // Read the product's edit.json — status fields reveal publish state.
    const res = await context.request.get(`https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${id}`)
    const payload = await res.json().catch(() => null) as { data?: { product?: Record<string, unknown> } } | null
    const product = payload?.data?.product ?? {}
    const statusish: Record<string, unknown> = {}
    for (const k of Object.keys(product)) {
      if (/status|state|audit|publish|发布|shelf|online|stage/i.test(k)) statusish[k] = (product as Record<string, unknown>)[k]
    }
    console.log(JSON.stringify({
      id,
      httpStatus: res.status(),
      statusFields: statusish,
      title: (product as Record<string, unknown>).title ?? (product as Record<string, unknown>).productName ?? null
    }, null, 2))
  } finally {
    await context.close().catch(() => undefined)
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : String(e)); process.exitCode = 1 })
