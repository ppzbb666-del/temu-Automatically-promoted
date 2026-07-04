import { strict as assert } from "node:assert"
import {
  clampInteger,
  formatDurationCompact,
  getAutomationJobTimeoutMs,
  getFullFlowJobTimeoutMs,
  parseTimestampMs,
  averagePerProduct,
  getProfileLockStaleMs,
  getRealCalibrationStaleMs,
  getUnattendedMaxSku,
  getUnattendedMinFreeMemMb,
  allowDianxiaomiSmokeCalibration
} from "../src/automation-runner-constants.ts"

// Unit tests for the pure/env-driven constant helpers. These clamp operator
// config (stale windows, timeouts) and format durations shown in the panel, so
// getting the boundaries right matters. Env-reading getters are exercised with
// saved-and-restored process.env.

const MIN = 60_000
const HOUR = 60 * MIN

// ---------------------------------------------------------------------------
// clampInteger — clamp + integer floor + NaN fallback
// ---------------------------------------------------------------------------
{
  assert.equal(clampInteger(50, 0, 10, 100), 50, "in-range value kept")
  assert.equal(clampInteger(5, 0, 10, 100), 10, "below min → min")
  assert.equal(clampInteger(500, 0, 10, 100), 100, "above max → max")
  assert.equal(clampInteger(50.9, 0, 10, 100), 50, "float floored")
  assert.equal(clampInteger(Number.NaN, 42, 10, 100), 42, "NaN → fallback (not clamped)")
  assert.equal(clampInteger(Infinity, 42, 10, 100), 42, "Infinity is not finite → fallback (not max)")

  console.log("PASS clampInteger")
}

// ---------------------------------------------------------------------------
// formatDurationCompact — minute/hour/day thresholds
// ---------------------------------------------------------------------------
{
  assert.equal(formatDurationCompact(30_000), "1m", "under a minute rounds up to 1m")
  assert.equal(formatDurationCompact(5 * MIN), "5m", "5 minutes")
  assert.equal(formatDurationCompact(59 * MIN), "59m", "59 minutes stays minutes")
  assert.equal(formatDurationCompact(60 * MIN), "1h", "60 minutes → 1h (integer, no decimal)")
  assert.equal(formatDurationCompact(90 * MIN), "1.5h", "90 minutes → 1.5h")
  assert.equal(formatDurationCompact(2 * HOUR), "2h", "2 hours integer")
  assert.equal(formatDurationCompact(48 * HOUR), "2d", "48 hours → 2d (integer)")
  assert.equal(formatDurationCompact(60 * HOUR), "2.5d", "60 hours → 2.5d")

  console.log("PASS formatDurationCompact")
}

// ---------------------------------------------------------------------------
// getAutomationJobTimeoutMs — per-mode lookup with default
// ---------------------------------------------------------------------------
{
  assert.equal(getAutomationJobTimeoutMs("dry-run"), 10 * 60 * 1000, "dry-run default timeout")
  assert.equal(getAutomationJobTimeoutMs("fill-draft"), 20 * 60 * 1000, "fill-draft has a longer timeout")
  assert.equal(getAutomationJobTimeoutMs("repair-apply"), 15 * 60 * 1000, "repair-apply timeout")
  assert.equal(getAutomationJobTimeoutMs("unknown-mode" as never), 10 * 60 * 1000, "unknown mode → default")
  assert.equal(getFullFlowJobTimeoutMs(), 60 * 60 * 1000, "full-flow timeout is one hour")

  console.log("PASS getAutomationJobTimeoutMs / getFullFlowJobTimeoutMs")
}

// ---------------------------------------------------------------------------
// parseTimestampMs / averagePerProduct
// ---------------------------------------------------------------------------
{
  assert.equal(parseTimestampMs("2026-01-01T00:00:00Z"), Date.parse("2026-01-01T00:00:00Z"), "valid ISO → ms")
  assert.equal(parseTimestampMs("not a date"), null, "invalid → null")
  assert.equal(parseTimestampMs(""), null, "empty → null")
  assert.equal(parseTimestampMs("   "), null, "blank → null")
  assert.equal(parseTimestampMs(null as never), null, "non-string → null")

  assert.equal(averagePerProduct(10, 4), 2.5, "average over positive count")
  assert.equal(averagePerProduct(10, 0), 0, "divide by zero → 0")
  assert.equal(averagePerProduct(0, 5), 0, "zero total → 0")

  console.log("PASS parseTimestampMs / averagePerProduct")
}

// ---------------------------------------------------------------------------
// Env-driven clamped getters — read process.env live; save/restore around each
// ---------------------------------------------------------------------------
{
  const saved = {
    lock: process.env.PROFILE_LOCK_STALE_MINUTES,
    calib: process.env.REAL_DIANXIAOMI_CALIBRATION_STALE_MINUTES,
    smoke: process.env.ALLOW_DIANXIAOMI_SMOKE_URLS,
    maxSku: process.env.UNATTENDED_MAX_SKU,
    minMem: process.env.UNATTENDED_MIN_FREE_MEM_MB
  }
  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    // Profile-lock stale window: minutes clamped to [5, 10080], then *60000.
    setEnv("PROFILE_LOCK_STALE_MINUTES", undefined)
    assert.equal(getProfileLockStaleMs(), 12 * HOUR, "unset → 12h default")
    setEnv("PROFILE_LOCK_STALE_MINUTES", "1")
    assert.equal(getProfileLockStaleMs(), 5 * MIN, "1 min clamps up to 5 min")
    setEnv("PROFILE_LOCK_STALE_MINUTES", "999999")
    assert.equal(getProfileLockStaleMs(), 7 * 24 * HOUR, "huge value clamps to 7 days")
    setEnv("PROFILE_LOCK_STALE_MINUTES", "not-a-number")
    assert.equal(getProfileLockStaleMs(), 12 * HOUR, "non-numeric → default (12h)")

    // Real-calibration stale window: minutes clamped to [30, 10080].
    setEnv("REAL_DIANXIAOMI_CALIBRATION_STALE_MINUTES", undefined)
    assert.equal(getRealCalibrationStaleMs(), 24 * HOUR, "unset → 24h default")
    setEnv("REAL_DIANXIAOMI_CALIBRATION_STALE_MINUTES", "10")
    assert.equal(getRealCalibrationStaleMs(), 30 * MIN, "10 min clamps up to 30 min")

    // Smoke-calibration boolean gate.
    setEnv("ALLOW_DIANXIAOMI_SMOKE_URLS", undefined)
    assert.equal(allowDianxiaomiSmokeCalibration(), false, "unset → false")
    setEnv("ALLOW_DIANXIAOMI_SMOKE_URLS", "true")
    assert.equal(allowDianxiaomiSmokeCalibration(), true, "'true' → true")
    setEnv("ALLOW_DIANXIAOMI_SMOKE_URLS", "1")
    assert.equal(allowDianxiaomiSmokeCalibration(), false, "only exact 'true' enables it")

    // OOM mitigation (layer 1): unattended SKU cap, minutes clamped to [1, 2000].
    setEnv("UNATTENDED_MAX_SKU", undefined)
    assert.equal(getUnattendedMaxSku(), 200, "unset → 200 default")
    setEnv("UNATTENDED_MAX_SKU", "50")
    assert.equal(getUnattendedMaxSku(), 50, "in-range value kept")
    setEnv("UNATTENDED_MAX_SKU", "0")
    assert.equal(getUnattendedMaxSku(), 1, "0 clamps up to 1")
    setEnv("UNATTENDED_MAX_SKU", "999999")
    assert.equal(getUnattendedMaxSku(), 2000, "huge value clamps to 2000")
    setEnv("UNATTENDED_MAX_SKU", "not-a-number")
    assert.equal(getUnattendedMaxSku(), 200, "non-numeric → default")

    // OOM mitigation (layer 1): min free memory MB, clamped to [256, 131072].
    setEnv("UNATTENDED_MIN_FREE_MEM_MB", undefined)
    assert.equal(getUnattendedMinFreeMemMb(), 3072, "unset → 3072 default")
    setEnv("UNATTENDED_MIN_FREE_MEM_MB", "4096")
    assert.equal(getUnattendedMinFreeMemMb(), 4096, "in-range value kept")
    setEnv("UNATTENDED_MIN_FREE_MEM_MB", "10")
    assert.equal(getUnattendedMinFreeMemMb(), 256, "10 clamps up to 256")
    setEnv("UNATTENDED_MIN_FREE_MEM_MB", "999999")
    assert.equal(getUnattendedMinFreeMemMb(), 131072, "huge value clamps to 131072")
  } finally {
    setEnv("PROFILE_LOCK_STALE_MINUTES", saved.lock)
    setEnv("REAL_DIANXIAOMI_CALIBRATION_STALE_MINUTES", saved.calib)
    setEnv("ALLOW_DIANXIAOMI_SMOKE_URLS", saved.smoke)
    setEnv("UNATTENDED_MAX_SKU", saved.maxSku)
    setEnv("UNATTENDED_MIN_FREE_MEM_MB", saved.minMem)
  }

  console.log("PASS env-driven clamped getters")
}

console.log("ALL CONSTANTS TESTS PASSED")
