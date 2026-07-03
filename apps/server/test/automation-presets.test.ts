import { strict as assert } from "node:assert"
import { mkdtempSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// CRUD test for the automation launch presets store. Hermetic: it points
// AUTOMATION_PRESET_PATH at a throwaway temp file so it never touches the real
// .runtime state. (That env override was added alongside this test to bring
// presets in line with every other persisted store's isolation convention.)

const dir = mkdtempSync(path.join(tmpdir(), "automation-presets-test-"))
const presetPath = path.join(dir, "presets.json")
process.env.AUTOMATION_PRESET_PATH = presetPath

// Import AFTER setting the env var. getPresetPath() reads it at call time, so
// this guarantees isolation regardless of import order.
const {
  listAutomationLaunchPresets,
  createAutomationLaunchPreset,
  updateAutomationLaunchPreset,
  deleteAutomationLaunchPreset
} = await import("../src/automation-presets.ts")

// ---------------------------------------------------------------------------
// Starts empty; create normalizes and persists
// ---------------------------------------------------------------------------
assert.deepEqual(listAutomationLaunchPresets(), [], "no file yet → empty list")

const created = createAutomationLaunchPreset({
  name: "  Daily Run  ",
  input: {
    url: "  https://dianxiaomi.com/x  ",
    headed: true,
    mediaAutomationTools: [" image-translation ", "", "batch-resize"],
    submitAfterSave: true
  }
})

assert.ok(created.id.startsWith("automation-preset-"), "generated id is prefixed")
assert.equal(created.name, "Daily Run", "name is trimmed")
assert.equal(created.input.url, "https://dianxiaomi.com/x", "url is trimmed")
assert.deepEqual(created.input.mediaAutomationTools, ["image-translation", "batch-resize"], "tools trimmed + empties dropped")
assert.equal(created.input.headed, true, "boolean input preserved")
assert.equal(created.createdAt, created.updatedAt, "createdAt == updatedAt on create")
assert.ok(existsSync(presetPath), "preset file written to the isolated path")
console.log("PASS create + normalize + persist")

// ---------------------------------------------------------------------------
// Persistence is real: a fresh read sees the created preset
// ---------------------------------------------------------------------------
{
  const listed = listAutomationLaunchPresets()
  assert.equal(listed.length, 1, "one preset listed")
  assert.equal(listed[0].id, created.id, "listed preset matches")
  // And it's genuinely on disk.
  const onDisk = JSON.parse(readFileSync(presetPath, "utf8"))
  assert.equal(onDisk.length, 1, "one preset on disk")
  console.log("PASS list + on-disk persistence")
}

// ---------------------------------------------------------------------------
// Update: rename, missing id → null
// ---------------------------------------------------------------------------
{
  const updated = updateAutomationLaunchPreset(created.id, { name: "  Renamed  " })
  assert.ok(updated, "update returns the preset")
  assert.equal(updated!.name, "Renamed", "name updated + trimmed")
  assert.equal(updated!.id, created.id, "id unchanged")
  assert.ok(updated!.updatedAt >= created.updatedAt, "updatedAt is not older")
  // A blank name falls back to the current name (no wipe).
  const blankName = updateAutomationLaunchPreset(created.id, { name: "   " })
  assert.equal(blankName!.name, "Renamed", "blank name falls back to current name")

  assert.equal(updateAutomationLaunchPreset("does-not-exist", { name: "x" }), null, "update unknown id → null")
  console.log("PASS update (rename, blank-name fallback, missing → null)")
}

// ---------------------------------------------------------------------------
// Delete: existing → result, missing → null, list shrinks
// ---------------------------------------------------------------------------
{
  const second = createAutomationLaunchPreset({ name: "Second", input: {} })
  assert.equal(listAutomationLaunchPresets().length, 2, "two presets now")

  const del = deleteAutomationLaunchPreset(created.id)
  assert.deepEqual(del, { id: created.id, deleted: true }, "delete returns the result")
  const remaining = listAutomationLaunchPresets()
  assert.equal(remaining.length, 1, "one preset remains")
  assert.equal(remaining[0].id, second.id, "the other preset remains")

  assert.equal(deleteAutomationLaunchPreset("does-not-exist"), null, "delete unknown id → null")
  console.log("PASS delete (result, remaining list, missing → null)")
}

// ---------------------------------------------------------------------------
// Ordering: list is sorted newest-updated first
// ---------------------------------------------------------------------------
{
  const a = createAutomationLaunchPreset({ name: "Older", input: {} })
  const b = createAutomationLaunchPreset({ name: "Newer", input: {} })
  const ids = listAutomationLaunchPresets().map((p) => p.id)
  // b was created last so it sorts before a (updatedAt desc); both precede any
  // earlier-updated presets.
  assert.ok(ids.indexOf(b.id) <= ids.indexOf(a.id), "list is sorted by updatedAt descending")
  console.log("PASS list ordering (newest updated first)")
}

console.log("ALL AUTOMATION-PRESETS TESTS PASSED")
