import { strict as assert } from "node:assert"
import {
  sanitizeMarketplaceEnglishText,
  generateMarketplaceSafeTitle,
  generateListingDraft,
  generateContentRisks
} from "../src/content.ts"
import type { ProductCandidate } from "../src/types.ts"

// Pure-function unit tests for the rule-based content layer. This is the
// deterministic baseline the LLM path enhances (and falls back to), plus the
// compliance risk gate. All are pure — no I/O.

const makeProduct = (overrides: Partial<ProductCandidate> = {}): ProductCandidate => ({
  id: "p1",
  source: "manual",
  title: "portable desk vacuum",
  category: "家居清洁",
  supplierPriceCny: 18.5,
  estimatedDomesticShippingCny: 2.8,
  estimatedWeightKg: 0.36,
  images: ["https://img.example.com/a.jpg"],
  attributes: { color: "白色", power: "USB" },
  skus: [{ skuId: "s1", name: "白色标准款", costCny: 18.5, stock: 10, attributes: {} }],
  ...overrides
}) as ProductCandidate

// ---------------------------------------------------------------------------
// sanitizeMarketplaceEnglishText — strips CJK + CJK punctuation, normalizes ws
// ---------------------------------------------------------------------------
{
  assert.equal(
    sanitizeMarketplaceEnglishText("Hello 世界，foo！bar"),
    "Hello foo bar",
    "strips CJK chars and CJK punctuation, collapses whitespace"
  )
  assert.equal(sanitizeMarketplaceEnglishText("  clean   english  "), "clean english", "collapses + trims whitespace")
  assert.equal(sanitizeMarketplaceEnglishText("纯中文标题"), "", "CJK-only text → empty string")
  assert.equal(sanitizeMarketplaceEnglishText("ASCII-only, kept."), "ASCII-only, kept.", "ascii punctuation kept")

  console.log("PASS sanitizeMarketplaceEnglishText")
}

// ---------------------------------------------------------------------------
// generateMarketplaceSafeTitle — English-only, <= 120 chars, never empty
// ---------------------------------------------------------------------------
{
  const cjkTitle = generateMarketplaceSafeTitle(makeProduct({ title: "无线便携桌面吸尘器", category: "家居清洁" }))
  assert.ok(cjkTitle.length > 0 && cjkTitle.length <= 120, "produces a bounded non-empty title from CJK input")
  assert.ok(!/[㐀-鿿]/.test(cjkTitle), "title contains no CJK characters")

  // A product with no usable words still yields the safety fallback.
  const emptyish = generateMarketplaceSafeTitle(
    makeProduct({ title: "。。。", category: "未知", attributes: {}, skus: [] })
  )
  assert.ok(emptyish.length > 0, "falls back to a non-empty title when nothing usable is present")

  // ASCII title preserves its own words.
  const asciiTitle = generateMarketplaceSafeTitle(makeProduct({ title: "portable handheld vacuum", category: "clean" }))
  assert.ok(/portable/i.test(asciiTitle), "ascii title keeps meaningful source words")

  console.log("PASS generateMarketplaceSafeTitle")
}

// ---------------------------------------------------------------------------
// generateListingDraft — invariants
// ---------------------------------------------------------------------------
{
  const draft = generateListingDraft(makeProduct())
  assert.equal(draft.productId, "p1", "carries productId")
  assert.ok(draft.listingTitle.length > 0 && draft.listingTitle.length <= 120, "title bounded")
  assert.ok(draft.sellingPoints.length >= 1, "has selling points")
  assert.ok(!/[㐀-鿿]/.test(draft.description), "description has no CJK (sanitized)")
  assert.deepEqual(draft.categoryPath, ["Temu", "家居清洁"], "category path = [Temu, category]")

  // inferAttributes always backfills usage/package/source on top of product attrs.
  assert.ok("usage" in draft.attributes, "backfills usage")
  assert.ok("package" in draft.attributes, "backfills package")
  assert.ok("source" in draft.attributes, "backfills source")
  assert.equal(draft.attributes.color, "白色", "keeps original product attribute")

  // skuPricing mirrors skus with salePriceUsd defaulted to 0 (pricing is applied
  // later by the planner, not here).
  assert.equal(draft.skuPricing.length, 1, "one pricing row per sku")
  assert.equal(draft.skuPricing[0].salePriceUsd, 0, "salePriceUsd defaults to 0 (priced later)")
  assert.equal(draft.skuPricing[0].stock, 10, "carries sku stock")

  console.log("PASS generateListingDraft (invariants)")
}

// ---------------------------------------------------------------------------
// generateContentRisks — the compliance gate (all four rules)
// ---------------------------------------------------------------------------
{
  const riskIds = (p: ProductCandidate) => {
    const draft = generateListingDraft(p)
    return generateContentRisks(p, draft).map((r) => r.id)
  }

  // Clean product: images present, >=3 attributes, no sensitive words, short title.
  const clean = makeProduct()
  assert.deepEqual(riskIds(clean), [], "clean product → no risks")

  // Sensitive brand/keyword in the title → high risk.
  const sensitive = makeProduct({ title: "迪士尼 vacuum" })
  assert.ok(riskIds(sensitive).includes("risk-sensitive-keywords"), "sensitive keyword → risk-sensitive-keywords")

  // No images → high risk.
  const noImages = makeProduct({ images: [] })
  assert.ok(riskIds(noImages).includes("risk-missing-images"), "no images → risk-missing-images")

  // Thin attributes: force the draft's attribute count below 3. inferAttributes
  // backfills usage/package/source, so to stay under 3 we need a product whose
  // inferred set is small — but since backfill guarantees >=3, this rule is only
  // reachable if a caller passes a pre-built draft with few attributes. Verify
  // the rule fires when given such a draft directly.
  const thinDraft = { ...generateListingDraft(clean), attributes: { color: "白" } }
  assert.ok(
    generateContentRisks(clean, thinDraft).some((r) => r.id === "risk-thin-attributes"),
    "draft with <3 attributes → risk-thin-attributes"
  )

  // Title over 120 chars → medium risk (again via a pre-built draft, since the
  // generator caps at 120).
  const longDraft = { ...generateListingDraft(clean), listingTitle: "A".repeat(130) }
  assert.ok(
    generateContentRisks(clean, longDraft).some((r) => r.id === "risk-title-too-long"),
    "title > 120 chars → risk-title-too-long"
  )

  // Levels: sensitive + missing images are high; thin + long title are medium.
  const combo = makeProduct({ title: "耐克 shoes", images: [] })
  const comboRisks = generateContentRisks(combo, generateListingDraft(combo))
  const byId = Object.fromEntries(comboRisks.map((r) => [r.id, r.level]))
  assert.equal(byId["risk-sensitive-keywords"], "high", "sensitive keyword is high severity")
  assert.equal(byId["risk-missing-images"], "high", "missing images is high severity")

  console.log("PASS generateContentRisks (compliance gate, all rules)")
}

console.log("ALL CONTENT TESTS PASSED")
