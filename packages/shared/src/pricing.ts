import type { LogisticsRateTier, PricingAnalysis, PricingRules, ProductCandidate } from "./types"

export const defaultPricingRules: PricingRules = {
  exchangeRateCnyPerUsd: 7.2,
  logisticsUsdPerKg: 3.2,
  logisticsRateTiers: [
    { minWeightKg: 0, maxWeightKg: 0.25, baseFeeUsd: 0.35, usdPerKg: 3.6 },
    { minWeightKg: 0.25, maxWeightKg: 0.75, baseFeeUsd: 0.45, usdPerKg: 3.2 },
    { minWeightKg: 0.75, baseFeeUsd: 0.75, usdPerKg: 2.8 }
  ],
  platformFeeUsd: 0.78,
  targetMarginRate: 0.28,
  priceMultiplier: 1.55,
  minimumMarginRate: 0.18,
  minimumSuggestedPriceUsd: 3
}

const roundMoney = (value: number) => Number(value.toFixed(2))

export const findLogisticsRateTier = (weightKg: number, tiers: LogisticsRateTier[] = []) =>
  tiers
    .slice()
    .sort((left, right) => left.minWeightKg - right.minWeightKg)
    .find((tier) => weightKg >= tier.minWeightKg && (tier.maxWeightKg === undefined || weightKg < tier.maxWeightKg))

export const calculateLogisticsUsd = (weightKg: number, rules: PricingRules) => {
  const tier = findLogisticsRateTier(weightKg, rules.logisticsRateTiers)

  if (!tier) {
    return {
      amountUsd: roundMoney(weightKg * rules.logisticsUsdPerKg),
      tier
    }
  }

  return {
    amountUsd: roundMoney(tier.baseFeeUsd + weightKg * tier.usdPerKg),
    tier
  }
}

export const calculatePricing = (
  product: ProductCandidate,
  rules: PricingRules = defaultPricingRules
): PricingAnalysis => {
  const logistics = calculateLogisticsUsd(product.estimatedWeightKg, rules)
  const supplierCostUsd = roundMoney(
    (product.supplierPriceCny + product.estimatedDomesticShippingCny) / rules.exchangeRateCnyPerUsd
  )
  const floorPriceUsd = roundMoney(supplierCostUsd + logistics.amountUsd + rules.platformFeeUsd)
  const suggestedPriceUsd = roundMoney(floorPriceUsd * rules.priceMultiplier)
  const tierDescription = logistics.tier
    ? `${logistics.tier.minWeightKg}-${logistics.tier.maxWeightKg ?? "∞"} kg，基础费 $${logistics.tier.baseFeeUsd} + $${logistics.tier.usdPerKg}/kg`
    : `$${rules.logisticsUsdPerKg}/kg`

  return {
    productId: product.id,
    suggestedPriceUsd,
    floorPriceUsd,
    targetMarginRate: rules.targetMarginRate,
    estimatedPlatformFeeUsd: rules.platformFeeUsd,
    estimatedLogisticsUsd: logistics.amountUsd,
    rationale: [
      `按汇率 ${rules.exchangeRateCnyPerUsd} 将采购成本和国内运费折算为美元`,
      `按重量 ${product.estimatedWeightKg} kg 使用物流规则 ${tierDescription}，物流成本 $${logistics.amountUsd}`,
      `保留 $${rules.platformFeeUsd} 平台费和 ${Math.round(rules.targetMarginRate * 100)}% 目标毛利空间`
    ],
    // P1-4: stamp the analysis with the rules hash + computed time so the
    // queue-run layer can detect stale prices before exporting a task.
    rulesHash: hashPricingRules(rules),
    computedAt: new Date().toISOString()
  }
}

// P1-4: stable hash of the pricing-rule fields that affect suggestedPriceUsd.
// Used by `recomputeDraftPricingIfStale` to detect when the operator
// changed pricing rules since the last draft rebuild.
export const hashPricingRules = (rules: PricingRules): string => {
  const projection = {
    exchangeRate: rules.exchangeRateCnyPerUsd,
    platformFee: rules.platformFeeUsd,
    targetMargin: rules.targetMarginRate,
    priceMultiplier: rules.priceMultiplier,
    minimumSuggestedPrice: rules.minimumSuggestedPriceUsd,
    logisticsUsdPerKg: rules.logisticsUsdPerKg,
    tiers: (rules.logisticsRateTiers ?? []).map((t) => [
      t.minWeightKg,
      t.maxWeightKg ?? null,
      t.baseFeeUsd,
      t.usdPerKg
    ])
  }
  return JSON.stringify(projection)
}
