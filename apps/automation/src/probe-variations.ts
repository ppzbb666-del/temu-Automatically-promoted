import path from "node:path"
import { chromium } from "playwright"
const PROFILE = path.resolve(".runtime/dianxiaomi-real-profile")
const ID = "161406453257944306"
const ctx = await chromium.launchPersistentContext(PROFILE, { channel:"chromium", headless:true })
try {
  const res = await ctx.request.get(`https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${ID}`)
  const j = await res.json().catch(()=>null) as any
  const p = j?.data?.product ?? {}
  const vars = p.variations ?? []
  console.log("variation count:", vars.length)
  if (vars[0]) console.log("=== first variation ALL keys ===\n", Object.keys(vars[0]).join(", "))
  // dump the spec structure of the first one so we learn the color path
  if (vars[0]) {
    const specKeys = Object.keys(vars[0]).filter(k=>/spec|attr|prop/i.test(k))
    for (const sk of specKeys) console.log(`  ${sk}:`, JSON.stringify(vars[0][sk]).slice(0,300))
  }
  // list every distinct supplierPrice with counts
  const cnt: Record<string,number> = {}
  for (const v of vars) { const key=String(v.supplierPrice); cnt[key]=(cnt[key]??0)+1 }
  console.log("=== supplierPrice distribution ===")
  for (const [k,c] of Object.entries(cnt)) console.log(`  supplierPrice=${k} (¥${Number(k)/100}) x${c}`)
  const cnt2: Record<string,number> = {}
  for (const v of vars) { const key=String(v.suggestedPrice); cnt2[key]=(cnt2[key]??0)+1 }
  console.log("=== suggestedPrice distribution ===")
  for (const [k,c] of Object.entries(cnt2)) console.log(`  suggestedPrice=${k} x${c}`)
  // show any variation whose supplierPrice differs from the mode
  const modeKey = Object.entries(cnt).sort((a,b)=>b[1]-a[1])[0][0]
  const outliers = vars.filter((v:any)=>String(v.supplierPrice)!==modeKey)
  console.log(`=== outliers vs mode supplierPrice=${modeKey}: ${outliers.length} ===`)
  console.log(JSON.stringify(outliers.slice(0,4), null, 2))
} finally { await ctx.close().catch(()=>{}) }
