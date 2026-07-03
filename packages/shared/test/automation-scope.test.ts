import { strict as assert } from "node:assert"
import {
  normalizeAutomationScopeUrl,
  normalizeAutomationItemUrls,
  normalizeAutomationSourceBuckets,
  resolveAutomationSourceBucket,
  matchesAutomationItemScope,
  hasAutomationItemScope
} from "../src/automation-scope.ts"

// Pure-function unit tests for the automation scope filter. This is the layer
// that decides which items are in-scope for an automation run, so its URL
// canonicalization and default-open matching are security-relevant: two URLs
// that point at the same item must normalize equal, and an empty scope must
// mean "match everything" (the documented default-open gate).

// ---------------------------------------------------------------------------
// normalizeAutomationScopeUrl — canonicalization
// ---------------------------------------------------------------------------
{
  // Dianxiaomi item URLs collapse to a stable dxm: key based on path + id,
  // dropping every other query param and ignoring param order and host prefix.
  // This is what lets the same item match regardless of URL noise.
  assert.equal(
    normalizeAutomationScopeUrl("https://www.dianxiaomi.com/order/edit.htm?id=999&x=1"),
    "dxm:/order/edit.htm?id=999",
    "dianxiaomi url → dxm key (extra params dropped)"
  )
  assert.equal(
    normalizeAutomationScopeUrl("https://dianxiaomi.com/order/edit.htm?x=2&id=999"),
    "dxm:/order/edit.htm?id=999",
    "dianxiaomi url → dxm key is order- and host-prefix-independent"
  )

  // Generic URLs: protocol + host lowercased, path case PRESERVED, trailing
  // slash stripped, query params sorted so ordering doesn't matter.
  assert.equal(
    normalizeAutomationScopeUrl("HTTPS://Example.COM/Path/?b=2&a=1"),
    "https://example.com/Path?a=1&b=2",
    "generic url: lowercase host/protocol, keep path case, strip trailing slash, sort params"
  )
  assert.equal(
    normalizeAutomationScopeUrl("https://example.com/Path?a=1&b=2"),
    normalizeAutomationScopeUrl("HTTPS://Example.COM/Path/?b=2&a=1"),
    "param order and casing do not change the canonical form"
  )

  // Non-URL strings fall back to stripping the fragment and trailing slashes.
  assert.equal(normalizeAutomationScopeUrl("not a url/#frag"), "not a url", "non-url fallback strips #fragment + trailing slash")

  // Empty / non-string → null.
  assert.equal(normalizeAutomationScopeUrl("   "), null, "blank → null")
  assert.equal(normalizeAutomationScopeUrl(null), null, "null → null")
  assert.equal(normalizeAutomationScopeUrl(undefined), null, "undefined → null")

  console.log("PASS normalizeAutomationScopeUrl (canonicalization)")
}

// ---------------------------------------------------------------------------
// normalizeAutomationItemUrls — normalize + dedup
// ---------------------------------------------------------------------------
{
  // Trailing-slash variants collapse to one entry; blanks/null dropped.
  assert.deepEqual(
    normalizeAutomationItemUrls(["https://example.com/a/", "https://example.com/a", null, ""]),
    ["https://example.com/a"],
    "normalize + dedup trailing-slash variants, drop empties"
  )
  assert.deepEqual(normalizeAutomationItemUrls(null), [], "null input → empty list")
  assert.deepEqual(normalizeAutomationItemUrls(undefined), [], "undefined input → empty list")

  console.log("PASS normalizeAutomationItemUrls (normalize + dedup)")
}

// ---------------------------------------------------------------------------
// normalizeAutomationSourceBuckets — whitelist + trim + dedup
// ---------------------------------------------------------------------------
{
  assert.deepEqual(
    normalizeAutomationSourceBuckets(["collection-box", "bogus", " listing-draft ", "collection-box"]),
    ["collection-box", "listing-draft"],
    "keep only whitelisted buckets, trim, dedup"
  )
  assert.deepEqual(normalizeAutomationSourceBuckets(["pending-publish"]), ["pending-publish"], "known bucket survives")
  assert.deepEqual(normalizeAutomationSourceBuckets(["not-a-bucket"]), [], "unknown bucket rejected")
  assert.deepEqual(normalizeAutomationSourceBuckets(null), [], "null → empty")

  console.log("PASS normalizeAutomationSourceBuckets (whitelist)")
}

// ---------------------------------------------------------------------------
// resolveAutomationSourceBucket — explicit wins, else infer from signals
// ---------------------------------------------------------------------------
{
  // Explicit valid bucket short-circuits.
  assert.equal(resolveAutomationSourceBucket({ sourceBucket: "pending-publish" }), "pending-publish", "explicit bucket wins")

  // Chinese + English text signals map to buckets.
  assert.equal(resolveAutomationSourceBucket({ pageTitle: "采集箱页面" }), "collection-box", "采集箱 → collection-box")
  assert.equal(resolveAutomationSourceBucket({ rawTextSample: "Draft Listing box" }), "listing-draft", "draft listing → listing-draft")
  assert.equal(resolveAutomationSourceBucket({ notes: ["编辑temu半托管产品"] }), "pending-publish", "edit-temu note → pending-publish")

  // No recognizable signal → null.
  assert.equal(resolveAutomationSourceBucket({ pageTitle: "random unrelated title" }), null, "no signal → null")
  assert.equal(resolveAutomationSourceBucket({}), null, "empty candidate → null")

  // An invalid explicit bucket is ignored and inference takes over.
  assert.equal(
    resolveAutomationSourceBucket({ sourceBucket: "garbage", pageTitle: "采集箱" }),
    "collection-box",
    "invalid explicit bucket falls through to signal inference"
  )

  console.log("PASS resolveAutomationSourceBucket (explicit + signal inference)")
}

// ---------------------------------------------------------------------------
// matchesAutomationItemScope — url-scope priority, bucket fallback, default-open
// ---------------------------------------------------------------------------
{
  // Empty scope = OPEN: everything matches. This is the documented default gate.
  assert.equal(matchesAutomationItemScope({ pageUrl: "https://x.com/a" }, {}), true, "empty scope matches everything (default-open)")

  // URL scope: candidate URL is canonicalized before comparison, so a trailing
  // slash still matches.
  assert.equal(
    matchesAutomationItemScope({ pageUrl: "https://x.com/a/" }, { itemUrls: ["https://x.com/a"] }),
    true,
    "url scope hit after canonicalization"
  )
  assert.equal(
    matchesAutomationItemScope({ pageUrl: "https://x.com/b" }, { itemUrls: ["https://x.com/a"] }),
    false,
    "url scope miss excludes the candidate"
  )

  // URL scope takes PRIORITY over bucket scope: when itemUrls is set, a bucket
  // match cannot rescue a URL miss.
  assert.equal(
    matchesAutomationItemScope(
      { pageUrl: "https://x.com/b", sourceBucket: "collection-box" },
      { itemUrls: ["https://x.com/a"], sourceBuckets: ["collection-box"] }
    ),
    false,
    "url scope wins: bucket match does not override a url miss"
  )

  // Bucket scope only (no itemUrls).
  assert.equal(
    matchesAutomationItemScope({ sourceBucket: "collection-box" }, { sourceBuckets: ["collection-box"] }),
    true,
    "bucket scope hit"
  )
  assert.equal(
    matchesAutomationItemScope({ sourceBucket: "listing-draft" }, { sourceBuckets: ["collection-box"] }),
    false,
    "bucket scope miss"
  )

  console.log("PASS matchesAutomationItemScope (priority + default-open)")
}

// ---------------------------------------------------------------------------
// hasAutomationItemScope
// ---------------------------------------------------------------------------
{
  assert.equal(hasAutomationItemScope({}), false, "no scope inputs → false")
  assert.equal(hasAutomationItemScope({ itemUrls: ["https://x.com/a"] }), true, "url scope present → true")
  assert.equal(hasAutomationItemScope({ sourceBuckets: ["collection-box"] }), true, "bucket scope present → true")
  assert.equal(hasAutomationItemScope({ itemUrls: [""], sourceBuckets: ["bogus"] }), false, "only invalid inputs → false")

  console.log("PASS hasAutomationItemScope")
}

console.log("ALL AUTOMATION-SCOPE TESTS PASSED")
