import { strict as assert } from "node:assert"
import {
  normalizeSelectorList,
  cloneSelectorConfig,
  buildSelectorConfigDiffPreview,
  selectorDiffChangeCount
} from "../src/lib/selector-config.ts"
import type { DianxiaomiSelectorConfig } from "@temu-ai-ops/shared"

// Unit tests for the selector-config editing helpers. These gate whether a new
// selector config is safe to save — the risk logic (block when a REQUIRED
// selector would be emptied, confirm when it changes) is what stops an operator
// from silently breaking automation writes. Worth pinning carefully.

const baseConfig = (): DianxiaomiSelectorConfig =>
  ({
    fields: { title: ["#t"], description: ["#d"], price: ["#p"], stock: ["#s"] },
    buttons: { save: ["#save"] },
    mediaTools: {},
    mediaToolActions: {},
    skuRows: ["tr"]
  } as unknown as DianxiaomiSelectorConfig)

const clone = (config: DianxiaomiSelectorConfig) => JSON.parse(JSON.stringify(config)) as DianxiaomiSelectorConfig

// ---------------------------------------------------------------------------
// normalizeSelectorList / cloneSelectorConfig
// ---------------------------------------------------------------------------
{
  assert.deepEqual(normalizeSelectorList([" a ", "a", "", "b"]), ["a", "b"], "trim + dedup + drop blanks")
  assert.deepEqual(normalizeSelectorList(undefined), [], "undefined → empty list")

  assert.deepEqual(
    cloneSelectorConfig(null),
    { fields: {}, buttons: {}, mediaTools: {}, mediaToolActions: {}, skuRows: [] },
    "clone of null → empty normalized structure"
  )
  // Clone normalizes nested selector lists.
  const messy = {
    fields: { title: [" #t ", "#t", ""] },
    buttons: {},
    mediaTools: {},
    mediaToolActions: {},
    skuRows: []
  } as unknown as DianxiaomiSelectorConfig
  assert.deepEqual(cloneSelectorConfig(messy).fields.title, ["#t"], "clone dedups/trims nested selectors")

  console.log("PASS normalizeSelectorList / cloneSelectorConfig")
}

// ---------------------------------------------------------------------------
// Diff: no change → everything unchanged, no risk
// ---------------------------------------------------------------------------
{
  const config = baseConfig()
  const diff = buildSelectorConfigDiffPreview(config, config)
  assert.equal(diff.summary.changedCount, 0, "no changes")
  assert.equal(diff.summary.addedCount, 0, "nothing added")
  assert.equal(diff.summary.removedCount, 0, "nothing removed")
  assert.equal(diff.blocked, false, "no-change diff is not blocked")
  assert.equal(diff.requiresConfirmation, false, "no-change diff needs no confirmation")
  assert.equal(selectorDiffChangeCount(diff), 0, "change count is zero")

  console.log("PASS diff: no change")
}

// ---------------------------------------------------------------------------
// Risk gate: emptying a REQUIRED selector → blocked
// ---------------------------------------------------------------------------
{
  const current = baseConfig()
  const next = clone(current)
  next.fields.title = [] // required field emptied
  const diff = buildSelectorConfigDiffPreview(current, next)

  assert.equal(diff.blocked, true, "emptying a required selector blocks the save")
  assert.equal(diff.summary.blockRiskCount, 1, "one block risk")
  assert.equal(diff.risks[0].level, "block", "risk level is block")
  assert.ok(diff.risks[0].message.includes("fields.title"), "risk names the offending selector")

  console.log("PASS risk gate: required selector emptied → block")
}

// ---------------------------------------------------------------------------
// Risk gate: changing (not emptying) a required selector → confirm
// ---------------------------------------------------------------------------
{
  const current = baseConfig()
  const next = clone(current)
  next.fields.title = ["#t2"] // required field changed but not empty
  const diff = buildSelectorConfigDiffPreview(current, next)

  assert.equal(diff.requiresConfirmation, true, "changing a required selector needs confirmation")
  assert.equal(diff.blocked, false, "a non-empty change is not blocked")
  assert.equal(diff.summary.confirmRiskCount, 1, "one confirm risk")
  assert.equal(diff.risks[0].level, "confirm", "risk level is confirm")
  assert.equal(selectorDiffChangeCount(diff), 1, "one changed entry")

  console.log("PASS risk gate: required selector changed → confirm")
}

// ---------------------------------------------------------------------------
// A non-critical selector change carries no risk
// ---------------------------------------------------------------------------
{
  const current = baseConfig()
  const next = clone(current)
  next.fields.attribute = ["#a"] // 'attribute' is NOT in the required set
  const diff = buildSelectorConfigDiffPreview(current, next)

  assert.equal(diff.blocked, false, "non-critical add is not blocked")
  assert.equal(diff.requiresConfirmation, false, "non-critical add needs no confirmation")
  assert.equal(diff.summary.addedCount >= 1, true, "the add is still counted")

  console.log("PASS non-critical change → no risk")
}

// ---------------------------------------------------------------------------
// currentExists reflects whether there was a prior config
// ---------------------------------------------------------------------------
{
  assert.equal(buildSelectorConfigDiffPreview(null, baseConfig()).currentExists, false, "null current → currentExists false")
  assert.equal(buildSelectorConfigDiffPreview(baseConfig(), baseConfig()).currentExists, true, "present current → currentExists true")

  console.log("PASS currentExists flag")
}

console.log("ALL SELECTOR-CONFIG TESTS PASSED")
