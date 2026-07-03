import path from "node:path"
import { chromium } from "playwright"
import type { PublishTask } from "@temu-ai-ops/shared"
import { normalizeCategorySelection, waitForPublishPage } from "./adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "./selector-config"

const TARGET_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453261437108"
const PROFILE_DIR = path.resolve(".runtime/dianxiaomi-real-profile")
const SELECTOR_CONFIG = ".runtime/dianxiaomi-selector-config.json"

const task: PublishTask = {
  id: "verify-category-normalization",
  product: {
    id: "verify-category-product",
    source: "dianxiaomi",
    sourceUrl: TARGET_URL,
    title: "verify category normalization",
    category: "女装长裤",
    supplierPriceCny: 1,
    estimatedDomesticShippingCny: 0,
    estimatedWeightKg: 0.2,
    images: [],
    attributes: {},
    skus: []
  },
  pricing: {
    productId: "verify-category-product",
    suggestedPriceUsd: 9.99,
    floorPriceUsd: 5.99,
    targetMarginRate: 0.3,
    estimatedPlatformFeeUsd: 0,
    estimatedLogisticsUsd: 0,
    rationale: ["verification script"]
  },
  draft: {
    productId: "verify-category-product",
    listingTitle: "verify category normalization",
    sellingPoints: [],
    description: "",
    categoryPath: ["Temu", "其他（女装长裤）"],
    attributes: {
      dianxiaomiPageUrl: TARGET_URL,
      dianxiaomiCategoryId: "29012",
      dianxiaomiFullCid: "4933358-",
      dianxiaomiCategoryLabel: "其他（女装长裤）",
      dianxiaomiCategoryHintSource: "verify-script"
    },
    skuPricing: []
  },
  steps: [],
  risks: [],
  status: "approved",
  updatedAt: new Date().toISOString()
}

const main = async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chromium",
    headless: true,
    viewport: {
      width: 1440,
      height: 960
    }
  })

  try {
    const page = await context.newPage()
    await page.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    })
    await page.waitForTimeout(2_500)

    const config = loadSelectorConfig(SELECTOR_CONFIG)
    await waitForPublishPage(page, config, {
      waitForManualNavigation: false,
      targetUrl: TARGET_URL
    })

    const categoryStep = await normalizeCategorySelection(page, task.draft)

    console.log(JSON.stringify({
      targetUrl: page.url(),
      title: await page.title().catch(() => ""),
      categoryStep
    }, null, 2))
  } finally {
    await context.close().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
