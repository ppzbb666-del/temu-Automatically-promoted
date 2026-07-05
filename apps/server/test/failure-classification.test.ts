import { strict as assert } from "node:assert"
import { classifyDianxiaomiWorkFailure } from "../src/automation-runner-failure-classification.ts"

// Direct, exhaustive test for the failure classifier — the pure function that
// routes every automation failure into one of four handling lanes (published /
// auto-retry / browser-recovery / manual-budget) via its category + retry flags.
// The automation-runner.test.ts suite touches a few of these; this pins ALL
// categories and the retry routing that decides whether a failure auto-retries.

const classify = (reason: string, source?: string) =>
  source === undefined ? classifyDianxiaomiWorkFailure(reason) : classifyDianxiaomiWorkFailure(reason, source)

// category, retryable, autoRetryRecommended per pattern.
const cases: Array<{
  name: string
  reason: string
  category: string
  retryable: boolean
  autoRetry: boolean
}> = [
  { name: "login/captcha", reason: "login captcha required", category: "login-or-captcha", retryable: false, autoRetry: false },
  { name: "selector config", reason: "selector config validation failed", category: "selector-config", retryable: false, autoRetry: false },
  { name: "real-page calibration", reason: "real-dianxiaomi-calibration needed", category: "real-page-calibration", retryable: false, autoRetry: false },
  { name: "target surface", reason: "write-blocked-wrong-surface", category: "target-surface", retryable: false, autoRetry: false },
  { name: "profile lock", reason: "profile is locked singletonlock", category: "browser-profile", retryable: true, autoRetry: false },
  { name: "browser crash/OOM", reason: "browser process disconnected out of memory", category: "browser-profile", retryable: true, autoRetry: true },
  // OOM mitigation (layer 1, item ②): the sku-count-over-cap reason string itself
  // contains "oom"; it must classify as sku-count-over-cap (checked first), NOT
  // fall through to the browser-crash auto-retry branch.
  { name: "sku count over cap", reason: "sku-count-over-cap: 322 SKU exceeds UNATTENDED_MAX_SKU 200; skipped to avoid variant-remap OOM", category: "sku-count-over-cap", retryable: false, autoRetry: false },
  // Broken source images: 0×0 carousel images can never be resized to 1:1. The
  // reason contains "batch resize" / 图片 tokens, so it must be caught BEFORE the
  // media-processing branch and must NOT be retryable/auto-retryable.
  { name: "broken source images", reason: "Batch resize: broken-source-images: batch resize dialog has no selectable image and all 5 carousel images are 0×0 (broken source images, need re-upload)", category: "broken-source-images", retryable: false, autoRetry: false },
  { name: "task file", reason: "could not export automation task", category: "task-file", retryable: true, autoRetry: true },
  { name: "media processing", reason: "media processing failed during batch resize", category: "media-processing", retryable: false, autoRetry: false },
  // Temu carousel aspect-ratio rejection at submit → media-processing, and
  // auto-retryable because rerunning re-applies the batch-resize 1:1 path.
  { name: "carousel 1:1", reason: "Dianxiaomi submit failed: 产品轮播图必须1:1尺寸", category: "media-processing", retryable: true, autoRetry: true },
  { name: "publish validation", reason: "missing required attribute Color", category: "publish-validation", retryable: true, autoRetry: false },
  { name: "unknown", reason: "something totally unrelated", category: "unknown", retryable: false, autoRetry: false }
]

for (const testCase of cases) {
  const result = classify(testCase.reason)
  assert.equal(result.category, testCase.category, `${testCase.name}: category`)
  assert.equal(result.retryable, testCase.retryable, `${testCase.name}: retryable`)
  assert.equal(result.autoRetryRecommended, testCase.autoRetry, `${testCase.name}: autoRetryRecommended`)
  assert.ok(result.nextAction && result.nextAction.length > 0, `${testCase.name}: has a nextAction`)
  assert.ok(result.updatedAt, `${testCase.name}: stamps updatedAt`)
}
console.log("PASS all failure categories + retry routing")

// Auto-retry-eligible lanes: transient browser crashes, task-file issues, and
// carousel aspect-ratio rejections (rerun re-applies the batch-resize 1:1 path).
// Every other content/selector/gate failure must NOT auto-retry — note the plain
// "media processing" case above stays autoRetry:false; only the 1:1 sub-case flips.
const autoRetryReasons = cases.filter((c) => c.autoRetry).map((c) => c.category)
assert.deepEqual(
  [...new Set(autoRetryReasons)].sort(),
  ["browser-profile", "media-processing", "task-file"],
  "only browser crash + task-file + carousel-ratio auto-retry"
)
console.log("PASS auto-retry lane is limited to transient failures")

// Edge cases.
assert.equal(classify("").category, "unknown", "empty reason → unknown")
assert.equal(classify("   ").category, "unknown", "blank reason → unknown")
assert.equal(classify("x").source, "queue-daemon", "source defaults to queue-daemon")
assert.equal(classify("x", "manual").source, "manual", "source override honored")
assert.equal(classify("LOGIN CAPTCHA").category, "login-or-captcha", "matching is case-insensitive")

// Chinese failure text also classifies (the messages Dianxiaomi surfaces).
assert.equal(classify("验证码").category, "login-or-captcha", "Chinese captcha text → login-or-captcha")
console.log("PASS edge cases (empty, source, case-insensitive, Chinese)")

console.log("ALL FAILURE-CLASSIFICATION TESTS PASSED")
