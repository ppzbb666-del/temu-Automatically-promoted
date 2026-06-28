// One-off analysis: from the read-only probe results (.runtime/_probe_all.jsonl),
// build a clean id -> 店小秘 category short-name map for the items whose page
// ALREADY has a category selected (missingCategory=false). These just need a
// category signal backfilled to clear the category-selection gate; at full-flow
// time normalizeCategorySelection will skip (page already selected).
import { readFileSync, writeFileSync } from "node:fs"

const probe = readFileSync(".runtime/_probe_all.jsonl", "utf8").trim().split("\n").filter(Boolean)
const byUrl = new Map()
for (const line of probe) {
  try {
    const o = JSON.parse(line)
    if (!byUrl.has(o.url) || (byUrl.get(o.url).error && !o.error)) byUrl.set(o.url, o)
  } catch {}
}

// id<->url map from the rescuable snapshot
const rescuable = JSON.parse(readFileSync(".runtime/_rescuable_map.json", "utf8"))
const idByUrl = new Map(rescuable.map((r) => [r.pageUrl, r.id]))

const isRealEditUrl = (u) => /dianxiaomi\.com\/web\/popTemu\/edit\?id=/.test(u)

// Extract the 店小秘 short category name that sits between "产品分类" and "选择分类".
// Two observed shapes:
//   产品分类女装短针织衫选择分类...   (Chinese immediately follows)
//   产品分类T 恤选择分类...           (starts with latin "T 恤")
const extractShortName = (probeResult) => {
  const txt = (probeResult.nearbyCategoryText || []).join(" || ")
  const m = txt.match(/产品分类\s*(.*?)\s*选择分类/)
  if (!m) return null
  let name = m[1]
    // strip leading non-category noise like "ace", "g 2" that precedes 产品分类 capture leak
    .replace(/^[a-z0-9]+\s*/i, (s) => (/^t\s/i.test(s) ? s : "")) // keep "T " (as in T恤), drop "ace"/"g 2"
    .replace(/\s+/g, " ")
    .trim()
  // guard: reject the "未选" sentinel and empties
  if (!name || name.includes("请选择") || name.includes("未选择") || name.length > 24) return null
  return name
}

const selected = [...byUrl.values()].filter((p) => !p.error && p.missingCategory === false && isRealEditUrl(p.url))
const out = []
const failed = []
for (const s of selected) {
  const id = idByUrl.get(s.url)
  const label = extractShortName(s)
  if (id && label) out.push({ id, label, url: s.url })
  else failed.push({ id: id ?? null, url: s.url, raw: ((s.nearbyCategoryText || []).join("|")).slice(0, 60) })
}

writeFileSync(".runtime/_backfill_plan.json", JSON.stringify(out, null, 2))
console.log(`selected(real): ${selected.length}  clean: ${out.length}  failed: ${failed.length}`)
const dist = {}
for (const o of out) dist[o.label] = (dist[o.label] || 0) + 1
console.log("=== label 分布 ===")
for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`)
if (failed.length) {
  console.log("=== 仍需人工看 ===")
  for (const f of failed) console.log(JSON.stringify(f))
}
