// One-off: backfill categoryHint.label on selected work items via the existing
// POST /dianxiaomi/product-work-items endpoint (which recomputes requirements + status).
// Usage: node scripts/backfill-category-hint.mjs <label> <id1> <id2> ...
import { readFileSync } from "node:fs"

const SERVER = process.env.SERVER ?? "http://localhost:8787"
const [, , label, ...ids] = process.argv
if (!label || ids.length === 0) {
  console.error("usage: node scripts/backfill-category-hint.mjs <label> <id...>")
  process.exit(1)
}

const all = JSON.parse(readFileSync(new URL("../.runtime/_wi_probe.json", import.meta.url), "utf8"))
const items = Array.isArray(all) ? all : (all.items ?? all.workItems ?? [])
const byId = new Map(items.map((it) => [it.id, it]))

for (const id of ids) {
  const it = byId.get(id)
  if (!it) {
    console.log(JSON.stringify({ id, error: "not found in probe snapshot" }))
    continue
  }
  // Carry required fields + id so saveDianxiaomiProductWorkItem updates in place and recomputes.
  const body = {
    id: it.id,
    pageUrl: it.pageUrl,
    pageTitle: it.pageTitle,
    title: it.title ?? "",
    snapshot: it.snapshot,
    categoryHint: { label, source: "manual" }
  }
  const res = await fetch(`${SERVER}/dianxiaomi/product-work-items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
  const out = await res.json().catch(() => null)
  const catCheck = (out?.requirements?.checks ?? []).find((c) => c.id === "category-selection")
  console.log(JSON.stringify({
    id,
    httpStatus: res.status,
    newStatus: out?.status,
    categorySelectionOk: catCheck?.ok,
    categoryHint: out?.categoryHint
  }))
}
