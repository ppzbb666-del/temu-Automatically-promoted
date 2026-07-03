import { strict as assert } from "node:assert"
import {
  calculatePricing,
  calculateLogisticsUsd,
  findLogisticsRateTier,
  defaultPricingRules,
  hashPricingRules
} from "../src/pricing.ts"
import type { PricingRules, ProductCandidate } from "../src/types.ts"

// Pure-function unit tests for the pricing engine. No I/O, no mocks — every
// expected number was verified against the implementation. These lock the
// business-critical money math: logistics tiering, floor/suggested price, the
// rules hash used for staleness detection, and money rounding.

const makeProduct = (overrides: Partial<ProductCandidate> = {}): ProductCandidate => ({
  id: "p1",
  source: "manual",
  title: "test product",
  category: "test",
  supplierPriceCny: 36,
  estimatedDomesticShippingCny: 0,
  estimatedWeightKg: 0.5,
  images: [],
  attributes: {},
  skus: [],
  ...overrides
})

// ---------------------------------------------------------------------------
// findLogisticsRateTier — tier selection + exclusive-max boundary
// ---------------------------------------------------------------------------
{
  const tiers = defaultPricingRules.logisticsRateTiers!

  // A weight strictly inside the first tier.
  assert.equal(findLogisticsRateTier(0.1, tiers)?.baseFeeUsd, 0.35, "0.1kg → first tier")

  // Boundary: maxWeightKg is EXCLUSIVE. Exactly 0.25 belongs to the SECOND tier,
  // not the first. This is the subtle rule most likely to regress.
  assert.equal(findLogisticsRateTier(0.25, tiers)?.baseFeeUsd, 0.45, "0.25kg → second tier (exclusive max)")
  assert.equal(findLogisticsRateTier(0.2499, tiers)?.baseFeeUsd, 0.35, "just under 0.25kg → first tier")

  // Open-ended top tier (no maxWeightKg) matches everything at/above its min.
  assert.equal(findLogisticsRateTier(0.75, tiers)?.baseFeeUsd, 0.75, "0.75kg → open-ended tier")
  assert.equal(findLogisticsRateTier(100, tiers)?.baseFeeUsd, 0.75, "very heavy → open-ended tier")

  // Zero weight still lands in the first tier (0 >= 0 && 0 < 0.25).
  assert.equal(findLogisticsRateTier(0, tiers)?.baseFeeUsd, 0.35, "0kg → first tier")

  // Unsorted input is sorted internally, so tier lookup is order-independent.
  const shuffled = [tiers[2], tiers[0], tiers[1]]
  assert.equal(findLogisticsRateTier(0.5, shuffled)?.baseFeeUsd, 0.45, "unsorted tiers still resolve correctly")

  // No tiers → undefined.
  assert.equal(findLogisticsRateTier(0.5, []), undefined, "empty tiers → undefined")
  assert.equal(findLogisticsRateTier(0.5), undefined, "missing tiers arg → undefined")

  console.log("PASS findLogisticsRateTier (tiering + exclusive-max boundary)")
}

// ---------------------------------------------------------------------------
// calculateLogisticsUsd — tier formula + flat-rate fallback
// ---------------------------------------------------------------------------
{
  // Tier found: baseFee + weight * usdPerKg. 0.45 + 0.5*3.2 = 2.05
  const inTier = calculateLogisticsUsd(0.5, defaultPricingRules)
  assert.equal(inTier.amountUsd, 2.05, "0.5kg logistics = 0.45 + 0.5*3.2")
  assert.equal(inTier.tier?.baseFeeUsd, 0.45, "returns the matched tier")

  // First tier at 0kg: 0.35 + 0 = 0.35
  assert.equal(calculateLogisticsUsd(0, defaultPricingRules).amountUsd, 0.35, "0kg logistics = base fee only")

  // No tiers → flat fallback weight * logisticsUsdPerKg. 0.5*3.2 = 1.6
  const noTiers: PricingRules = { ...defaultPricingRules, logisticsRateTiers: [] }
  const fallback = calculateLogisticsUsd(0.5, noTiers)
  assert.equal(fallback.amountUsd, 1.6, "no tiers → flat rate weight*logisticsUsdPerKg")
  assert.equal(fallback.tier, undefined, "flat-rate result carries no tier")

  console.log("PASS calculateLogisticsUsd (tier formula + fallback)")
}

// ---------------------------------------------------------------------------
// calculatePricing — full computation
// ---------------------------------------------------------------------------
{
  // supplierCost = (36 + 0) / 7.2 = 5.00
  // logistics(0.5kg) = 2.05
  // floor = 5.00 + 2.05 + 0.78 (platformFee) = 7.83
  // suggested = 7.83 * 1.55 = 12.1365 → 12.14
  const analysis = calculatePricing(makeProduct(), defaultPricingRules)
  assert.equal(analysis.productId, "p1", "carries productId")
  assert.equal(analysis.estimatedLogisticsUsd, 2.05, "logistics")
  assert.equal(analysis.estimatedPlatformFeeUsd, 0.78, "platform fee passthrough")
  assert.equal(analysis.floorPriceUsd, 7.83, "floor = supplierCost + logistics + platformFee")
  assert.equal(analysis.suggestedPriceUsd, 12.14, "suggested = floor * priceMultiplier, rounded")
  assert.equal(analysis.targetMarginRate, 0.28, "targetMarginRate passthrough")
  assert.equal(analysis.rulesHash, hashPricingRules(defaultPricingRules), "stamps the rules hash")
  assert.ok(typeof analysis.computedAt === "string" && analysis.computedAt.length > 0, "stamps computedAt")
  assert.equal(analysis.rationale.length, 3, "rationale has three lines")

  // Domestic shipping is folded into supplier cost before FX conversion.
  // (36 + 7.2)/7.2 = 6.00 → floor = 6.00 + 2.05 + 0.78 = 8.83
  const withShipping = calculatePricing(makeProduct({ estimatedDomesticShippingCny: 7.2 }), defaultPricingRules)
  assert.equal(withShipping.floorPriceUsd, 8.83, "domestic shipping folds into supplier cost pre-FX")

  console.log("PASS calculatePricing (full computation)")
}

// ---------------------------------------------------------------------------
// BY DESIGN: calculatePricing computes the RAW price and deliberately does NOT
// clamp to minimumSuggestedPriceUsd or minimumMarginRate. Per docs/pricing-rules.md
// those thresholds drive RISK ALERTS, not price floors — the alerting lives in
// apps/server/src/planner.ts (risk-low-price / risk-low-margin). This test pins
// the "no clamp" contract so the compute/alert separation stays intact: if a
// future edit adds clamping here, it becomes a deliberate, visible change.
// ---------------------------------------------------------------------------
{
  // A near-free product: supplierCost = 0.72/7.2 = 0.10, logistics(0kg)=0.35,
  // floor = 0.10 + 0.35 + 0.78 = 1.23, suggested = 1.23*1.55 = 1.9065 → 1.91.
  // Below minimumSuggestedPriceUsd (3) yet NOT clamped — planner raises the
  // risk-low-price alert instead.
  const cheap = calculatePricing(
    makeProduct({ supplierPriceCny: 0.72, estimatedDomesticShippingCny: 0, estimatedWeightKg: 0 }),
    defaultPricingRules
  )
  assert.ok(defaultPricingRules.minimumSuggestedPriceUsd === 3, "precondition: minimum is 3")
  assert.equal(cheap.suggestedPriceUsd, 1.91, "suggested is NOT floored to minimumSuggestedPriceUsd (raw price by design)")
  assert.ok(
    cheap.suggestedPriceUsd < defaultPricingRules.minimumSuggestedPriceUsd,
    "suggested can fall below the configured minimum — clamping is intentionally NOT done here (alerting lives in planner)"
  )

  console.log("PASS calculatePricing no-clamp contract (compute/alert separation)")
}

// ---------------------------------------------------------------------------
// hashPricingRules — deterministic + sensitive to price-affecting fields only
// ---------------------------------------------------------------------------
{
  assert.equal(
    hashPricingRules(defaultPricingRules),
    hashPricingRules({ ...defaultPricingRules }),
    "same rules → same hash"
  )

  // Changing a price-affecting field changes the hash.
  assert.notEqual(
    hashPricingRules(defaultPricingRules),
    hashPricingRules({ ...defaultPricingRules, exchangeRateCnyPerUsd: 7.3 }),
    "exchange rate change → different hash"
  )
  assert.notEqual(
    hashPricingRules(defaultPricingRules),
    hashPricingRules({ ...defaultPricingRules, priceMultiplier: 1.6 }),
    "price multiplier change → different hash"
  )
  assert.notEqual(
    hashPricingRules(defaultPricingRules),
    hashPricingRules({
      ...defaultPricingRules,
      logisticsRateTiers: [{ minWeightKg: 0, baseFeeUsd: 1, usdPerKg: 1 }]
    }),
    "logistics tier change → different hash"
  )

  console.log("PASS hashPricingRules (deterministic + price-sensitive)")
}

console.log("ALL PRICING TESTS PASSED")
