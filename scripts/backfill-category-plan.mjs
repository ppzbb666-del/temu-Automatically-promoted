// One-off: backfill categoryHint.label per work item from the probe-derived plan
// (.runtime/_backfill_plan.json: [{id,label,url}]). Each item's page ALREADY has a
// category selected, so this only restores the category signal to clear the
// category-selection gate; full-flow's normalizeCategorySelection will skip.
//
// Dry-run by default (prints the plan). Pass --apply to actually POST.
// Usage:
//   node scripts/backfill-category-plan.mjs            # dry-run
//   node scripts/backfill-category-plan.mjs --apply    # write
import { readFileSync } from "node:fs"

const SERVER = process.env.SERVER ?? "http://localhost:8787"
const APPLY = process.argv.includes("--apply")

const plan = JSON.parse(readFileSync(".runtime/_backfill_plan.json", "utf8"))
const snapshot = JSON.parse(readFileSync(".runtime/_wi_probe.json", "utf8"))
const items = Array.isArray(snapshot) ? snapshot : (snapshot.items ?? snapshot.workItems ?? [])
const byId = new Map(items.map((it) => [it.id, it]))

console.log(`${APPLY ? "APPLY" : "DRY-RUN"}: ${plan.length} work item(s)`)

let ok = 0, ready = 0, fail = 0
for (const { id, label } of plan) {
  const it = byId.get(id)
  if (!it) {
    console.log(JSON.stringify({ id, error: "not in snapshot" }))
    fail++
    continue
  }
  if (!APPLY) {
    console.log(`  ${id}  <-  "${label}"   (${(it.title ?? "").slice(0, 30)})`)
    continue
  }
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
  const catOk = (out?.requirements?.checks ?? []).find((c) => c.id === "category-selection")?.ok
  const newStatus = out?.status
  if (res.ok && catOk) ok++
  else fail++
  if (newStatus === "ready-for-automation") ready++
  console.log(JSON.stringify({ id, httpStatus: res.status, newStatus, categorySelectionOk: catOk, label }))
}

if (APPLY) console.log(`\ndone: categorySelectionOk=${ok}  nowReady=${ready}  failed=${fail}`)
