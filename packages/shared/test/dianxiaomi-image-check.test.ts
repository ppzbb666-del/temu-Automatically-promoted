import { strict as assert } from "node:assert"
import {
  extractDianxiaomiImageCheckIssues,
  parseDianxiaomiImageCheckSummary,
  summarizeDianxiaomiImageCheckIssues
} from "../src/dianxiaomi-image-check.ts"
import type { DianxiaomiImageCheckIssue } from "../src/dianxiaomi-image-check.ts"

// Pure-function unit tests for the image-check parsing layer. These turn free
// text from Dianxiaomi's image inspector into structured, canonicalized issues
// that gate whether media is publish-ready — so their canonicalization, dedup,
// and count handling are worth pinning.

// ---------------------------------------------------------------------------
// extractDianxiaomiImageCheckIssues — free-text line parsing
// ---------------------------------------------------------------------------
{
  // A line with a category label + an issue label yields one canonicalized issue.
  // 素材图 canonicalizes to 产品图.
  const one = extractDianxiaomiImageCheckIssues("素材图尺寸不合规")
  assert.equal(one.length, 1, "single issue line → one issue")
  assert.equal(one[0].category, "产品图", "素材图 canonicalizes to 产品图")
  assert.equal(one[0].issue, "尺寸", "尺寸 issue canonicalized")

  // Multiple issues separated by ；/newlines.
  const multi = extractDianxiaomiImageCheckIssues("轮播图有水印；详情图比例不对")
  assert.deepEqual(
    multi.map((i) => [i.category, i.issue]),
    [["轮播图", "水印"], ["详情图", "比例"]],
    "splits on ； and canonicalizes each"
  )

  // A line with no recognizable category+issue pair yields nothing.
  assert.deepEqual(extractDianxiaomiImageCheckIssues("hello world, nothing here"), [], "no labels → empty")
  assert.deepEqual(extractDianxiaomiImageCheckIssues(""), [], "empty input → empty")
  assert.deepEqual(extractDianxiaomiImageCheckIssues("   "), [], "whitespace-only → empty")

  // Duplicate lines collapse (dedup by category::issue::detail).
  assert.equal(
    extractDianxiaomiImageCheckIssues("产品图尺寸不合规\n产品图尺寸不合规").length,
    1,
    "identical issue lines dedup to one"
  )

  // English labels also parse.
  const en = extractDianxiaomiImageCheckIssues("carousel watermark detected")
  assert.equal(en.length, 1, "english labels parse")
  assert.equal(en[0].category, "轮播图", "carousel → 轮播图")
  assert.equal(en[0].issue, "水印", "watermark → 水印")

  console.log("PASS extractDianxiaomiImageCheckIssues")
}

// ---------------------------------------------------------------------------
// parseDianxiaomiImageCheckSummary — structured "<label> <count>" pairs
// ---------------------------------------------------------------------------
{
  const parsed = parseDianxiaomiImageCheckSummary("产品图尺寸不合规 3 详情图尺寸不合规 2")
  assert.deepEqual(
    parsed.map((i) => [i.category, i.issue, i.count]),
    [["产品图", "尺寸", 3], ["详情图", "尺寸", 2]],
    "parses label+count into canonical issues"
  )

  // Text/watermark maps to the 非英文 issue on 产品图.
  const wm = parseDianxiaomiImageCheckSummary("图片包含文字、水印 5")
  assert.equal(wm.length, 1, "watermark summary parsed")
  assert.deepEqual([wm[0].category, wm[0].issue, wm[0].count], ["产品图", "非英文", 5], "text/watermark → 产品图/非英文")

  // Oversize and dead-link labels.
  assert.equal(parseDianxiaomiImageCheckSummary("图片过大 4")[0].issue, "大小", "过大 → 大小")
  assert.equal(parseDianxiaomiImageCheckSummary("图片链接失效 1")[0].issue, "失效", "失效 → 失效")

  // count <= 0 is dropped.
  assert.deepEqual(parseDianxiaomiImageCheckSummary("图片过大 0"), [], "count 0 → dropped")

  // No recognizable pattern → empty.
  assert.deepEqual(parseDianxiaomiImageCheckSummary("all good, no issues"), [], "no pattern → empty")
  assert.deepEqual(parseDianxiaomiImageCheckSummary(""), [], "empty → empty")

  console.log("PASS parseDianxiaomiImageCheckSummary")
}

// ---------------------------------------------------------------------------
// summarizeDianxiaomiImageCheckIssues — formatting + dedup
// ---------------------------------------------------------------------------
{
  const issues: DianxiaomiImageCheckIssue[] = [
    { category: "产品图", issue: "尺寸", count: 3 },
    { category: "轮播图", issue: "水印" }
  ]
  assert.deepEqual(
    summarizeDianxiaomiImageCheckIssues(issues),
    ["产品图 尺寸 x3", "轮播图 水印"],
    "formats with count suffix only when count > 0"
  )

  // Dedup across identical issues.
  assert.deepEqual(
    summarizeDianxiaomiImageCheckIssues([
      { category: "产品图", issue: "尺寸" },
      { category: "产品图", issue: "尺寸" }
    ]),
    ["产品图 尺寸"],
    "dedups identical issues"
  )

  assert.deepEqual(summarizeDianxiaomiImageCheckIssues([]), [], "empty → empty")

  console.log("PASS summarizeDianxiaomiImageCheckIssues")
}

console.log("ALL IMAGE-CHECK TESTS PASSED")
