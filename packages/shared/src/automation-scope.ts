import type { AutomationDryRunStartInput, AutomationSourceBucket } from "./types"

export const automationSourceBucketOptions: Array<{
  value: AutomationSourceBucket
  label: string
  description: string
}> = [
  {
    value: "collection-box",
    label: "采集箱",
    description: "只处理采集箱来源的商品"
  },
  {
    value: "pending-publish",
    label: "待发布",
    description: "只处理待发布来源的商品"
  },
  {
    value: "listing-draft",
    label: "待刊登",
    description: "只处理待刊登来源的商品"
  }
]

export type AutomationItemScopeCandidate = {
  sourceBucket?: AutomationSourceBucket | string
  pageUrl?: string
  pageTitle?: string
  pageProfile?: string
  rawTextSample?: string
  notes?: string[]
}

const automationSourceBucketSet = new Set<AutomationSourceBucket>(
  automationSourceBucketOptions.map((option) => option.value)
)

const normalizeScopeText = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, " ")

export const normalizeAutomationScopeUrl = (value: string | null | undefined) => {
  if (typeof value !== "string") {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  // Idempotency guard: an already-normalized Dianxiaomi scope key is `dxm:<path>?id=<id>`.
  // Feeding it back through `new URL()` parses `dxm:` as a scheme and re-normalizes to
  // `dxm:///<path>...`, which no longer matches the original key — so a value normalized
  // once (e.g. stored on the queue daemon input) would fail to match on the second pass,
  // silently dropping the scoped work item. Return canonical keys unchanged.
  if (trimmed.startsWith("dxm:") && !trimmed.startsWith("dxm://")) {
    return trimmed
  }

  try {
    const url = new URL(trimmed)
    const host = url.hostname.toLowerCase()
    const pathname = url.pathname.replace(/\/+$/, "") || "/"
    const id = url.searchParams.get("id")?.trim()

    if (host.includes("dianxiaomi.com") && id) {
      return `dxm:${pathname}?id=${id}`
    }

    const params: string[][] = []
    url.searchParams.forEach((currentValue, key) => {
      if (key.trim() && currentValue.trim()) {
        params.push([key, currentValue])
      }
    })
    params.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
    )
    const normalizedSearch = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : ""
    return `${url.protocol.toLowerCase()}//${host}${pathname}${normalizedSearch}`
  } catch {
    return trimmed.replace(/#.*$/, "").replace(/\/+$/, "")
  }
}

export const normalizeAutomationItemUrls = (values: Array<string | null | undefined> | null | undefined) =>
  Array.from(new Set(
    (values ?? [])
      .map((value) => normalizeAutomationScopeUrl(value))
      .filter((value): value is string => Boolean(value))
  ))

export const normalizeAutomationSourceBuckets = (
  values: Array<AutomationSourceBucket | string | null | undefined> | null | undefined
) =>
  Array.from(new Set(
    (values ?? [])
      .map((value) => typeof value === "string" ? value.trim() : "")
      .filter((value): value is AutomationSourceBucket => automationSourceBucketSet.has(value as AutomationSourceBucket))
  ))

export const hasAutomationItemScope = (input: Pick<AutomationDryRunStartInput, "itemUrls" | "sourceBuckets"> = {}) =>
  normalizeAutomationItemUrls(input.itemUrls).length > 0
  || normalizeAutomationSourceBuckets(input.sourceBuckets).length > 0

export const resolveAutomationSourceBucket = (candidate: AutomationItemScopeCandidate): AutomationSourceBucket | null => {
  const explicitSourceBucket = normalizeAutomationSourceBuckets([candidate.sourceBucket])[0] ?? null
  if (explicitSourceBucket) {
    return explicitSourceBucket
  }

  const signals = normalizeScopeText([
    candidate.pageProfile,
    candidate.pageTitle,
    candidate.rawTextSample,
    ...(candidate.notes ?? [])
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" "))

  if (!signals) {
    return null
  }

  if (
    signals.includes("采集箱")
    || signals.includes("collection box")
    || signals.includes("platform collection")
    || signals.includes("collection-box")
  ) {
    return "collection-box"
  }

  if (
    signals.includes("待发布")
    || signals.includes("pending publish")
    || signals.includes("pending-publish")
    || signals.includes("product-edit")
    || signals.includes("编辑temu半托管产品")
    || signals.includes("edit temu")
  ) {
    return "pending-publish"
  }

  if (
    signals.includes("待刊登")
    || signals.includes("刊登草稿")
    || signals.includes("draft listing")
    || signals.includes("draft box")
    || signals.includes("listing-draft")
  ) {
    return "listing-draft"
  }

  return null
}

export const matchesAutomationItemScope = (
  candidate: AutomationItemScopeCandidate,
  input: Pick<AutomationDryRunStartInput, "itemUrls" | "sourceBuckets"> = {}
) => {
  const normalizedItemUrls = normalizeAutomationItemUrls(input.itemUrls)
  if (normalizedItemUrls.length > 0) {
    const candidateUrl = normalizeAutomationScopeUrl(candidate.pageUrl)
    return Boolean(candidateUrl && normalizedItemUrls.includes(candidateUrl))
  }

  const normalizedSourceBuckets = normalizeAutomationSourceBuckets(input.sourceBuckets)
  if (normalizedSourceBuckets.length > 0) {
    const bucket = resolveAutomationSourceBucket(candidate)
    return Boolean(bucket && normalizedSourceBuckets.includes(bucket))
  }

  return true
}
