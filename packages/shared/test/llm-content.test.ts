import { strict as assert } from "node:assert"
import { enhanceListingDraftWithLlm, isLlmConfigured, readLlmConfig } from "../src/llm-content.ts"
import { generateListingDraft } from "../src/content.ts"
import type { ProductCandidate } from "../src/types.ts"

// Unit tests for the real-LLM content enhancement layer. The contract that
// matters most here is the graceful-fallback guarantee (CLAUDE.md §8): the
// unattended main flow must never break because the LLM is unconfigured, slow,
// or wrong, so `enhanceListingDraftWithLlm` must NEVER throw and must fall back
// to the rule-based draft on any failure. `fetch` is stubbed so these run fully
// offline and deterministically.

const product: ProductCandidate = {
  id: "prod-test-01",
  source: "1688",
  title: "无线便携桌面吸尘器",
  category: "家居清洁",
  supplierPriceCny: 18.5,
  estimatedDomesticShippingCny: 2.8,
  estimatedWeightKg: 0.36,
  images: ["https://images.example.com/a.jpg"],
  attributes: { color: "白色", power: "USB 充电" },
  skus: [
    { skuId: "sku-white", name: "白色标准款", costCny: 18.5, stock: 120, attributes: { color: "白色" } }
  ]
}

const baseDraft = generateListingDraft(product)

const realFetch = globalThis.fetch
const savedEnv = {
  key: process.env.LLM_API_KEY,
  baseUrl: process.env.LLM_BASE_URL,
  model: process.env.LLM_MODEL,
  timeout: process.env.LLM_TIMEOUT_MS
}

const configure = (overrides: Record<string, string | undefined> = {}) => {
  const env: Record<string, string | undefined> = {
    LLM_API_KEY: "test-key",
    LLM_BASE_URL: "https://mock.local/v1",
    LLM_MODEL: "test-model",
    LLM_TIMEOUT_MS: undefined,
    ...overrides
  }
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

const restoreEnv = () => {
  configure({
    LLM_API_KEY: savedEnv.key,
    LLM_BASE_URL: savedEnv.baseUrl,
    LLM_MODEL: savedEnv.model,
    LLM_TIMEOUT_MS: savedEnv.timeout
  })
  delete process.env.LLM_TEMPERATURE
}

const stubFetch = (impl: (url: string, opts: any) => Promise<any>) => {
  globalThis.fetch = impl as unknown as typeof fetch
}

const chatResponse = (content: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] })
})

// ---------------------------------------------------------------------------
// readLlmConfig / isLlmConfigured — env gate + defaults
// ---------------------------------------------------------------------------
{
  delete process.env.LLM_API_KEY
  assert.equal(isLlmConfigured(), false, "no key → not configured")
  assert.equal(readLlmConfig(), null, "no key → null config")

  configure({ LLM_BASE_URL: undefined, LLM_MODEL: undefined })
  const cfg = readLlmConfig()
  assert.ok(cfg, "with key → config present")
  assert.equal(cfg!.baseUrl, "https://api.openai.com/v1", "default baseUrl")
  assert.equal(cfg!.model, "gpt-4o-mini", "default model")
  assert.equal(cfg!.timeoutMs, 20000, "default timeout")

  configure({ LLM_BASE_URL: "https://x.test/v1/", LLM_TIMEOUT_MS: "5000" })
  const cfg2 = readLlmConfig()
  assert.equal(cfg2!.baseUrl, "https://x.test/v1", "trailing slash stripped from baseUrl")
  assert.equal(cfg2!.timeoutMs, 5000, "custom timeout parsed")
}

// ---------------------------------------------------------------------------
// temperature gate — default OFF (regression: claude-sonnet-5 & other newer
// models reject `temperature` with HTTP 400 "deprecated for this model"). The
// field must be omitted from config AND from the request body unless the
// operator explicitly opts in via LLM_TEMPERATURE.
// ---------------------------------------------------------------------------
{
  configure()
  delete process.env.LLM_TEMPERATURE
  assert.equal(readLlmConfig()!.temperature, undefined, "no LLM_TEMPERATURE → temperature undefined")

  process.env.LLM_TEMPERATURE = "0.4"
  assert.equal(readLlmConfig()!.temperature, 0.4, "LLM_TEMPERATURE parsed when set")
  delete process.env.LLM_TEMPERATURE

  // Body must NOT carry temperature by default.
  configure()
  delete process.env.LLM_TEMPERATURE
  let sentBody: any = null
  stubFetch(async (_url, opts) => {
    sentBody = JSON.parse(opts.body)
    return chatResponse(JSON.stringify({
      title: "Good English Title", sellingPoints: ["A point"], description: "A description here."
    }))
  })
  await enhanceListingDraftWithLlm(product, baseDraft)
  assert.equal("temperature" in sentBody, false, "default request body omits temperature (newer-model compatible)")

  // Body MUST carry temperature when explicitly configured.
  process.env.LLM_TEMPERATURE = "0.4"
  sentBody = null
  await enhanceListingDraftWithLlm(product, baseDraft)
  assert.equal(sentBody.temperature, 0.4, "explicit LLM_TEMPERATURE flows into request body")
  delete process.env.LLM_TEMPERATURE
}

// ---------------------------------------------------------------------------
// unconfigured → pure passthrough, no LLM call
// ---------------------------------------------------------------------------
{
  delete process.env.LLM_API_KEY
  let called = false
  stubFetch(async () => { called = true; return chatResponse("{}") })

  const result = await enhanceListingDraftWithLlm(product, baseDraft)
  assert.equal(called, false, "unconfigured must not call fetch")
  assert.equal(result.usedLlm, false, "unconfigured → usedLlm false")
  assert.equal(result.fallbackReason, undefined, "unconfigured is not a fallback (no reason)")
  assert.equal(result.draft, baseDraft, "unconfigured returns the exact base draft object")
}

// ---------------------------------------------------------------------------
// configured + success → overwrite copy, preserve non-copy fields
// ---------------------------------------------------------------------------
{
  configure()
  stubFetch(async (url, opts) => {
    assert.ok(url.endsWith("/chat/completions"), "hits chat/completions")
    assert.equal(opts.headers.authorization, "Bearer test-key", "bearer auth header set")
    const body = JSON.parse(opts.body)
    assert.equal(body.model, "test-model", "uses configured model")
    assert.deepEqual(body.response_format, { type: "json_object" }, "requests json_object")
    return chatResponse(JSON.stringify({
      title: "Portable Handheld Desk Vacuum Cleaner USB Rechargeable",
      sellingPoints: ["Cordless and lightweight", "USB rechargeable", "Great for desks"],
      description: "A compact cordless desk vacuum for daily cleanup."
    }))
  })

  const result = await enhanceListingDraftWithLlm(product, baseDraft)
  assert.equal(result.usedLlm, true, "success → usedLlm true")
  assert.notEqual(result.draft.listingTitle, baseDraft.listingTitle, "title overwritten")
  assert.equal(result.draft.sellingPoints.length, 3, "selling points from model")
  assert.equal(result.draft.attributes, baseDraft.attributes, "attributes NOT touched by LLM")
  assert.equal(result.draft.skuPricing, baseDraft.skuPricing, "skuPricing NOT touched by LLM")
  assert.deepEqual(result.draft.categoryPath, baseDraft.categoryPath, "categoryPath unchanged")
}

// ---------------------------------------------------------------------------
// success but loose JSON (markdown-fenced) → still parsed
// ---------------------------------------------------------------------------
{
  configure()
  stubFetch(async () => chatResponse(
    "Here you go:\n```json\n" +
    JSON.stringify({ title: "Clean English Title", sellingPoints: ["One good point"], description: "A short description." }) +
    "\n```"
  ))
  const result = await enhanceListingDraftWithLlm(product, baseDraft)
  assert.equal(result.usedLlm, true, "markdown-fenced JSON still parsed")
  assert.equal(result.draft.listingTitle, "Clean English Title", "title from fenced JSON")
}

// ---------------------------------------------------------------------------
// title capped at 120 chars; sellingPoints capped at 4
// ---------------------------------------------------------------------------
{
  configure()
  stubFetch(async () => chatResponse(JSON.stringify({
    title: "Word ".repeat(60).trim(),               // ~300 chars
    sellingPoints: ["a", "b", "c", "d", "e", "f"],   // 6 points
    description: "Long enough description here."
  })))
  const result = await enhanceListingDraftWithLlm(product, baseDraft)
  assert.ok(result.draft.listingTitle.length <= 120, "title capped at 120 chars")
  assert.ok(result.draft.sellingPoints.length <= 4, "selling points capped at 4")
}

// ---------------------------------------------------------------------------
// network failure → fallback to base draft, reason set, never throws
// ---------------------------------------------------------------------------
{
  configure()
  stubFetch(async () => { throw new Error("boom network") })
  const result = await enhanceListingDraftWithLlm(product, baseDraft)
  assert.equal(result.usedLlm, false, "network failure → usedLlm false")
  assert.equal(result.draft.listingTitle, baseDraft.listingTitle, "falls back to base draft")
  assert.ok(result.fallbackReason?.includes("boom network"), "fallbackReason carries the cause")
}

// ---------------------------------------------------------------------------
// HTTP non-2xx → fallback with status in reason
// ---------------------------------------------------------------------------
{
  configure()
  stubFetch(async () => ({ ok: false, status: 401, text: async () => "invalid api key" }))
  const result = await enhanceListingDraftWithLlm(product, baseDraft)
  assert.equal(result.usedLlm, false, "HTTP 401 → usedLlm false")
  assert.ok(result.fallbackReason?.includes("401"), "fallbackReason includes HTTP status")
}

// ---------------------------------------------------------------------------
// missing/empty required fields → fallback (model returned junk)
// ---------------------------------------------------------------------------
{
  configure()
  stubFetch(async () => chatResponse(JSON.stringify({ title: "Only a title" })))
  const result = await enhanceListingDraftWithLlm(product, baseDraft)
  assert.equal(result.usedLlm, false, "missing sellingPoints/description → fallback")
  assert.ok(result.fallbackReason, "fallback reason present for incomplete output")
}

// ---------------------------------------------------------------------------
// empty content → fallback
// ---------------------------------------------------------------------------
{
  configure()
  stubFetch(async () => chatResponse(""))
  const result = await enhanceListingDraftWithLlm(product, baseDraft)
  assert.equal(result.usedLlm, false, "empty content → fallback")
}

globalThis.fetch = realFetch
restoreEnv()

console.log("ALL LLM-CONTENT TESTS PASSED")
