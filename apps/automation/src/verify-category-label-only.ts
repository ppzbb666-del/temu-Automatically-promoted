// One-off verification: can normalizeCategorySelection pick a category on a real
// edit page given ONLY a label (no categoryId/fullCid)? Read-mostly: it WILL click
// the picker and select, but does NOT fill other fields, save, or submit.
// Usage: tsx src/verify-category-label-only.ts <editUrl> <label>
import path from "node:path"
import { chromium } from "playwright"
import type { ListingDraft } from "@temu-ai-ops/shared"
import { normalizeCategorySelection, waitForPublishPage } from "./adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "./selector-config"

const PROFILE_DIR = path.resolve(".runtime/dianxiaomi-real-profile")
const SELECTOR_CONFIG = ".runtime/dianxiaomi-selector-config.json"

const [, , editUrl, label] = process.argv
if (!editUrl || !label) {
  console.error("usage: tsx src/verify-category-label-only.ts <editUrl> <label>")
  process.exit(1)
}

const draft: ListingDraft = {
  productId: "verify-label-only",
  listingTitle: "verify category label only",
  sellingPoints: [],
  description: "",
  categoryPath: [],
  attributes: {
    dianxiaomiPageUrl: editUrl,
    dianxiaomiCategoryLabel: label,
    dianxiaomiCategoryMissing: "true",
    dianxiaomiCategoryHintSource: "verify-label-only"
  },
  skuPricing: []
}

const main = async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chromium",
    headless: false,
    viewport: { width: 1440, height: 960 }
  })
  try {
    const page = await context.newPage()
    await page.goto(editUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await page.waitForTimeout(2_500)
    const config = loadSelectorConfig(SELECTOR_CONFIG)
    await waitForPublishPage(page, config, { waitForManualNavigation: false, targetUrl: editUrl })
    const categoryStep = await normalizeCategorySelection(page, draft)
    const data = (categoryStep.data ?? {}) as Record<string, any>
    console.log(JSON.stringify({
      editUrl,
      label,
      status: categoryStep.status,
      detail: categoryStep.detail,
      selectedPath: data.selectedPath ?? null,
      candidatePaths: data.candidatePaths ?? null,
      apiRecovery: data.apiRecovery?.lookups ?? null
    }, null, 2))
  } finally {
    await context.close().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
