import { strict as assert } from "node:assert"
import { createMockTask, mockProducts } from "../src/mock.ts"
import type { ProductCandidate } from "../src/types.ts"

// Unit tests for the mock task factory + seed data. createMockTask is the
// deterministic PublishTask builder used as the AI-orchestration placeholder;
// its pricing math and task skeleton are worth pinning so the mock stays a
// faithful stand-in.

const makeProduct = (overrides: Partial<ProductCandidate> = {}): ProductCandidate => ({
  id: "p9",
  source: "manual",
  title: "Widget",
  category: "家居",
  supplierPriceCny: 36,
  estimatedDomesticShippingCny: 0,
  estimatedWeightKg: 0.5,
  images: ["https://img.example.com/a.jpg"],
  attributes: { color: "white" },
  skus: [{ skuId: "s1", name: "S1", costCny: 18, stock: 7, attributes: { color: "white" } }],
  ...overrides
}) as ProductCandidate

// ---------------------------------------------------------------------------
// createMockTask — id, pricing math, draft/sku mirroring, task skeleton
// ---------------------------------------------------------------------------
{
  const task = createMockTask(makeProduct())

  assert.equal(task.id, "task-p9", "task id = task-<productId>")
  assert.equal(task.status, "planned", "status starts planned")
  assert.equal(task.product.id, "p9", "carries the product")

  // Pricing math (NOTE: this is the mock's own hardcoded formula, intentionally
  // separate from pricing.ts calculatePricing — the mock uses a FLAT weight*3.2
  // logistics, not the tiered rate. Keeping this test documents that split).
  //   logistics = 0.5 * 3.2 = 1.60
  //   supplierCost = (36 + 0) / 7.2 = 5.00
  //   floor = 5.00 + 1.60 + 0.78 = 7.38
  //   suggested = 7.38 * 1.55 = 11.439 → 11.44
  assert.equal(task.pricing.estimatedLogisticsUsd, 1.6, "flat logistics = weight*3.2")
  assert.equal(task.pricing.floorPriceUsd, 7.38, "floor = supplierCost + logistics + platformFee")
  assert.equal(task.pricing.suggestedPriceUsd, 11.44, "suggested = floor * 1.55, rounded")
  assert.equal(task.pricing.targetMarginRate, 0.28, "targetMarginRate")
  assert.equal(task.pricing.estimatedPlatformFeeUsd, 0.78, "platform fee")

  // Draft skuPricing mirrors skus and applies the suggested price.
  assert.equal(task.draft.skuPricing.length, 1, "one pricing row per sku")
  assert.equal(task.draft.skuPricing[0].skuId, "s1", "sku id carried")
  assert.equal(task.draft.skuPricing[0].salePriceUsd, 11.44, "sku priced at suggested price")
  assert.equal(task.draft.skuPricing[0].stock, 7, "sku stock carried")

  // Task skeleton.
  assert.equal(task.steps.length, 6, "six execution steps")
  assert.equal(task.steps[0].status, "pending", "steps start pending")
  assert.ok(task.risks.length >= 1, "carries at least the DOM-change risk")
  assert.ok(task.risks.some((r) => r.id === "risk-dom-change"), "includes the DOM-change risk")
  assert.deepEqual(task.draft.categoryPath, ["Home & Kitchen", "家居"], "draft category path")

  // Multi-SKU products produce one pricing row each.
  const multiSku = createMockTask(
    makeProduct({
      skus: [
        { skuId: "a", name: "A", costCny: 1, stock: 1, attributes: {} },
        { skuId: "b", name: "B", costCny: 1, stock: 2, attributes: {} }
      ]
    } as Partial<ProductCandidate>)
  )
  assert.equal(multiSku.draft.skuPricing.length, 2, "one pricing row per sku (multi-sku)")

  console.log("PASS createMockTask (id, pricing, mirroring, skeleton)")
}

// ---------------------------------------------------------------------------
// mockProducts — seed data validity
// ---------------------------------------------------------------------------
{
  assert.ok(mockProducts.length > 0, "has seed products")
  for (const product of mockProducts) {
    assert.ok(product.id, "each product has an id")
    assert.ok(product.title, "each product has a title")
    assert.ok(Array.isArray(product.skus) && product.skus.length > 0, "each product has skus")
    assert.ok(typeof product.supplierPriceCny === "number", "supplier price is numeric")
    // Every seed product must build a valid task without throwing.
    const task = createMockTask(product)
    assert.equal(task.id, `task-${product.id}`, "seed product builds a matching task")
  }
  // ids are unique.
  const ids = mockProducts.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length, "seed product ids are unique")

  console.log("PASS mockProducts (seed validity)")
}

console.log("ALL MOCK TESTS PASSED")
