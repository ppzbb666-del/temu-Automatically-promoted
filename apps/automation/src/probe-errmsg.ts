import path from "node:path"
import { chromium } from "playwright"
const PROFILE = path.resolve(".runtime/dianxiaomi-real-profile")
const ID = "161406453257944306"
const ctx = await chromium.launchPersistentContext(PROFILE, { channel:"chromium", headless:true })
try {
  const res = await ctx.request.get(`https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${ID}`)
  const j = await res.json().catch(()=>null) as any
  const p = j?.data?.product ?? {}
  const out: Record<string,unknown> = {}
  for (const k of Object.keys(p)) if (/err|msg|message|fail|reason|reject|audit/i.test(k)) out[k]=p[k]
  console.log(JSON.stringify({ dxmOfflineState:p.dxmOfflineState, errish:out }, null, 2))
} finally { await ctx.close().catch(()=>{}) }
