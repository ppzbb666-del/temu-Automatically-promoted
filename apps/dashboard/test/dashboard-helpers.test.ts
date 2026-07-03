import { strict as assert } from "node:assert"
import {
  parseAttributeText,
  formatAttributeText,
  parseImagesText,
  parseLines,
  formatLines,
  parseSkusText,
  parseLogisticsTiersText,
  formatLogisticsTiersText,
  countBy,
  formatCategoryCounts,
  getTaskProgress,
  formatMoney,
  getAutomaticPassRate,
  getManualTriggerStats
} from "../src/lib/dashboard-helpers.ts"
import type { PublishTask } from "@temu-ai-ops/shared"

// Unit tests for the pure dashboard helper functions (extracted out of App.tsx
// precisely so they could be tested). These are the parse/format round-trips
// operators rely on when editing drafts, plus the KPI derivations shown on the
// daily dashboard — both are pure and worth pinning.

// ---------------------------------------------------------------------------
// Attribute text <-> record round-trip
// ---------------------------------------------------------------------------
{
  // Accepts ; ； and : ： and newlines as separators.
  assert.deepEqual(
    parseAttributeText("color:red；size：L\nmaterial:cotton"),
    { color: "red", size: "L", material: "cotton" },
    "attribute parse handles mixed CN/EN separators + newlines"
  )
  // Pairs with no value are dropped.
  assert.deepEqual(parseAttributeText("color:red;lonelykey;;"), { color: "red" }, "keys without a value are dropped")
  assert.deepEqual(parseAttributeText(""), {}, "empty → empty record")

  // Round-trip: format then parse gets the same record.
  const attrs = { a: "1", b: "2", c: "three" }
  assert.deepEqual(parseAttributeText(formatAttributeText(attrs)), attrs, "format→parse round-trips")
  assert.equal(formatAttributeText({ color: "red", size: "L" }), "color:red;size:L", "format uses key:value;… form")

  console.log("PASS attribute parse/format round-trip")
}

// ---------------------------------------------------------------------------
// images / lines
// ---------------------------------------------------------------------------
{
  assert.deepEqual(
    parseImagesText("a.jpg, b.jpg；c.jpg\nd.jpg"),
    ["a.jpg", "b.jpg", "c.jpg", "d.jpg"],
    "images split on , ； and newlines, trimmed"
  )
  assert.deepEqual(parseImagesText("  \n  "), [], "blank images → empty")

  assert.deepEqual(parseLines("x\n  y  \n\nz"), ["x", "y", "z"], "lines trimmed + blanks dropped")
  assert.deepEqual(parseLines(formatLines(["one", "two"])), ["one", "two"], "lines round-trip")
  assert.equal(formatLines(undefined), "", "formatLines(undefined) → empty string")

  console.log("PASS images / lines")
}

// ---------------------------------------------------------------------------
// SKU text parsing (CSV-per-line with fallbacks)
// ---------------------------------------------------------------------------
{
  const fallback = { costCny: 1, stock: 2, attributes: { base: "v" } }
  const skus = parseSkusText("Red,10,5,color:red\nBlue", fallback)
  assert.equal(skus.length, 2, "one sku per line")
  assert.deepEqual(
    skus[0],
    { skuName: "Red", costCny: 10, stock: 5, attributes: { base: "v", color: "red" } },
    "full row: parsed values + merged attributes (fallback under parsed)"
  )
  assert.deepEqual(
    skus[1],
    { skuName: "Blue", costCny: 1, stock: 2, attributes: { base: "v" } },
    "sparse row falls back to defaults for cost/stock/attributes"
  )
  // Missing name → default; stock floored.
  const defaulted = parseSkusText(",,,", fallback)
  assert.equal(defaulted[0].skuName, "默认规格", "empty sku name → 默认规格")
  const floored = parseSkusText("X,3,7.9,", fallback)
  assert.equal(floored[0].stock, 7, "stock is floored to an integer")

  console.log("PASS parseSkusText")
}

// ---------------------------------------------------------------------------
// Logistics tiers <-> text round-trip
// ---------------------------------------------------------------------------
{
  const tiers = [
    { minWeightKg: 0, maxWeightKg: 0.25, baseFeeUsd: 0.35, usdPerKg: 3.6 },
    { minWeightKg: 0.25, baseFeeUsd: 0.5, usdPerKg: 3 } // open-ended top tier (no maxWeightKg)
  ]
  const roundTripped = parseLogisticsTiersText(formatLogisticsTiersText(tiers))
  // The open-ended tier round-trips as an EXPLICIT `maxWeightKg: undefined` key
  // (from `maxWeightKg ? Number(...) : undefined`), which deepStrictEqual treats
  // as distinct from an omitted key — so assert the exact shape the parser emits.
  assert.deepEqual(
    roundTripped,
    [
      { minWeightKg: 0, maxWeightKg: 0.25, baseFeeUsd: 0.35, usdPerKg: 3.6 },
      { minWeightKg: 0.25, maxWeightKg: undefined, baseFeeUsd: 0.5, usdPerKg: 3 }
    ],
    "tiers round-trip; open-ended tier keeps an explicit maxWeightKg: undefined"
  )

  // A malformed tier line with non-numeric core fields is filtered out.
  const filtered = parseLogisticsTiersText("0,0.25,0.35,3.6\ngarbage,,,")
  assert.equal(filtered.length, 1, "non-numeric tier line dropped")

  console.log("PASS logistics tiers round-trip")
}

// ---------------------------------------------------------------------------
// countBy / formatCategoryCounts
// ---------------------------------------------------------------------------
{
  assert.deepEqual(countBy(["a", "b", "a", "a"]), { a: 3, b: 1 }, "countBy tallies occurrences")
  assert.deepEqual(countBy([]), {}, "countBy of empty → empty")

  // Sorted by count descending.
  assert.equal(formatCategoryCounts({ home: 2, travel: 5, acc: 1 }), "travel 5 / home 2 / acc 1", "category counts sorted desc")
  assert.equal(formatCategoryCounts({}), "", "empty counts → empty string")

  console.log("PASS countBy / formatCategoryCounts")
}

// ---------------------------------------------------------------------------
// getTaskProgress — floors at 20, scales to 100
// ---------------------------------------------------------------------------
{
  const task = (statuses: string[]): PublishTask =>
    ({ steps: statuses.map((status) => ({ status })) } as unknown as PublishTask)

  assert.equal(getTaskProgress(task([])), 20, "no steps → 20 floor (no divide-by-zero)")
  assert.equal(getTaskProgress(task(["pending", "pending"])), 20, "0% done → 20 floor")
  assert.equal(getTaskProgress(task(["done", "pending", "done", "pending"])), 50, "half done → 50")
  assert.equal(getTaskProgress(task(["done", "done"])), 100, "all done → 100")

  console.log("PASS getTaskProgress")
}

// ---------------------------------------------------------------------------
// formatMoney + KPI empty-state safety
// ---------------------------------------------------------------------------
{
  assert.equal(formatMoney(12.1), "$12.10", "money formatted with 2 decimals")
  assert.equal(formatMoney(0), "$0.00", "zero money")

  // The KPI helpers must be divide-by-zero safe on empty inputs (they drive the
  // daily dashboard tiles).
  assert.deepEqual(getAutomaticPassRate([], [], []), { finished: 0, completed: 0, rate: null }, "empty pass-rate → rate null")
  assert.deepEqual(getManualTriggerStats([]), { triggerCount: 0, productCount: 0, average: 0 }, "empty manual stats → zeros")

  console.log("PASS formatMoney + KPI empty-state safety")
}

console.log("ALL DASHBOARD-HELPERS TESTS PASSED")
