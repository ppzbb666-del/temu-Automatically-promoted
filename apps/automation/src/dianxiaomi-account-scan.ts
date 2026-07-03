import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type BrowserContext, type Page } from "playwright"
import type {
  AutomationSourceBucket,
  DianxiaomiAccountScanLink,
  DianxiaomiAccountScanResult,
  DianxiaomiAccountScanStartInput,
  DianxiaomiAccountScanStore
} from "@temu-ai-ops/shared"
import { ensureDirectory, getArgValue, parseBoolean, waitForManualLoginIfNeeded } from "./common"

type SupportedBucket = Extract<AutomationSourceBucket, "collection-box" | "pending-publish">

type StoreProbe = {
  storeName: string
  shopId: string | null
}

type PageListItem = {
  id?: number | string
  idStr?: string
  shopId?: number | string
  productName?: string
  platformTitle?: string
  platformEditUrl?: string
  sourceUrl?: string
  outerGoodsUrl?: string
  categoryId?: number | string
  fullCid?: string | null
  siteValue?: string
  siteName?: string
  platformSite?: string
  sourcePlatform?: string
  createTime?: number
  updateTime?: number
}

type PageListResponse = {
  code: number
  msg?: string
  data?: {
    page?: {
      list?: PageListItem[]
    }
  }
}

const timestampId = () => new Date().toISOString().replace(/[:.]/g, "-")

const getRepoRoot = () => {
  const currentFile = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(currentFile), "../../..")
}

const DEFAULT_BUCKETS: SupportedBucket[] = ["collection-box", "pending-publish"]
const DEFAULT_MAX_PAGES = 20
const PAGE_LIST_ENDPOINT = "https://www.dianxiaomi.com/api/popTemuProduct/pageList.json"
const OFFLINE_URL = "https://www.dianxiaomi.com/web/popTemu/pageList/offline"
const DRAFT_URL = "https://www.dianxiaomi.com/web/popTemu/pageList/draft"
const STORE_LABEL = "店铺账号:"
const ALL_STORES_LABEL = "全部"

const bucketSpecs: Record<SupportedBucket, {
  sourceBucket: SupportedBucket
  url: string
  dxmState: "draft" | "offline"
  label: string
}> = {
  "collection-box": {
    sourceBucket: "collection-box",
    url: DRAFT_URL,
    dxmState: "draft",
    label: "collection-box"
  },
  "pending-publish": {
    sourceBucket: "pending-publish",
    url: OFFLINE_URL,
    dxmState: "offline",
    label: "pending-publish"
  }
}

const parseSourceBuckets = (value: string | undefined): AutomationSourceBucket[] =>
  (value ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item): item is AutomationSourceBucket =>
      item === "collection-box" || item === "pending-publish" || item === "listing-draft"
    )

const parsePositiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.max(1, Math.min(100, Math.floor(parsed)))
}

const getInput = (): Required<Pick<DianxiaomiAccountScanStartInput, "headed" | "profile" | "screenshots" | "maxPages">> & {
  sourceBuckets: AutomationSourceBucket[]
  storeId?: string
  storeName?: string
} => {
  const repoRoot = getRepoRoot()
  return {
    headed: parseBoolean(getArgValue("headed") ?? process.env.HEADED, false),
    profile: path.resolve(
      repoRoot,
      getArgValue("profile") ?? process.env.TEMU_PROFILE_DIR ?? ".runtime/playwright/dianxiaomi-profile"
    ),
    screenshots: path.resolve(
      repoRoot,
      getArgValue("screenshots") ?? process.env.SCREENSHOT_DIR ?? `output/playwright/dianxiaomi-account-scan-${timestampId()}`
    ),
    sourceBuckets: parseSourceBuckets(getArgValue("source-buckets") ?? process.env.SOURCE_BUCKETS),
    maxPages: parsePositiveInteger(getArgValue("max-pages") ?? process.env.MAX_PAGES, DEFAULT_MAX_PAGES),
    storeId: normalizeText(getArgValue("store-id") ?? process.env.STORE_ID) || undefined,
    storeName: normalizeText(getArgValue("store-name") ?? process.env.STORE_NAME) || undefined
  }
}

const normalizeText = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()

const normalizeOptionalText = (value: string | number | null | undefined) => {
  const normalized = normalizeText(value == null ? "" : String(value))
  return normalized || null
}

const sameStore = (left: StoreProbe, right: { storeName?: string | null; shopId?: string | null }) => {
  const leftShopId = normalizeText(left.shopId)
  const rightShopId = normalizeText(right.shopId)
  const leftStoreName = normalizeText(left.storeName)
  const rightStoreName = normalizeText(right.storeName)

  if (leftShopId && rightShopId) {
    return leftShopId === rightShopId
  }

  if (leftStoreName && rightStoreName) {
    return leftStoreName === rightStoreName
  }

  return false
}

const formatTimestamp = (value: unknown) => {
  const numeric = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null
  }

  return new Date(numeric).toISOString()
}

const resolveEditUrl = (item: PageListItem) => {
  const explicit = normalizeText(item.platformEditUrl)
  if (explicit) {
    if (/^https?:\/\//i.test(explicit)) {
      return explicit
    }
    return new URL(explicit, "https://www.dianxiaomi.com").toString()
  }

  const id = normalizeText(String(item.idStr ?? item.id ?? ""))
  if (!id) {
    return null
  }

  return `https://www.dianxiaomi.com/web/popTemu/edit?id=${encodeURIComponent(id)}`
}

const postPageList = async (context: BrowserContext, input: {
  shopId: string
  dxmState: "draft" | "offline"
  pageNo: number
}) => {
  const response = await context.request.post(PAGE_LIST_ENDPOINT, {
    headers: {
      referer: input.dxmState === "offline" ? OFFLINE_URL : DRAFT_URL
    },
    form: {
      sortName: "2",
      pageNo: String(input.pageNo),
      pageSize: "50",
      total: "0",
      searchType: "0",
      searchValue: "",
      productSearchType: "1",
      shopId: input.shopId,
      dxmState: input.dxmState,
      site: "0",
      fullCid: "",
      sortValue: "2",
      productType: ""
    }
  })

  return response.json() as Promise<PageListResponse>
}

const discoverStores = async (page: Page) => {
  await page.goto(OFFLINE_URL, {
    waitUntil: "domcontentloaded"
  })
  await waitForManualLoginIfNeeded(page)
  if (page.isClosed()) {
    throw new Error("browser page closed during login flow")
  }

  await page.goto(OFFLINE_URL, {
    waitUntil: "domcontentloaded"
  })
  await page.waitForTimeout(2500)

  const storeSection = page.locator(".in-screen-single").filter({
    has: page.locator(".title", {
      hasText: STORE_LABEL
    })
  }).first()

  const storeNames = (await storeSection.locator(".d-tag-group-item").allInnerTexts())
    .map((item) => normalizeText(item))
    .filter(Boolean)
  const uniqueStoreNames = Array.from(new Set(storeNames)).filter((storeName) => storeName !== ALL_STORES_LABEL)

  const stores: StoreProbe[] = []
  let lastPostData = ""

  for (const storeName of uniqueStoreNames) {
    const tag = storeSection.locator(".d-tag-group-item").filter({
      hasText: storeName
    }).first()

    const responsePromise = page.waitForResponse((response) => {
      if (!response.url().includes("/api/popTemuProduct/pageList.json")) {
        return false
      }

      const postData = response.request().postData() ?? ""
      if (!postData.includes("dxmState=offline")) {
        return false
      }

      return postData !== lastPostData
    }, {
      timeout: 15000
    })

    await tag.click()
    const response = await responsePromise
    lastPostData = response.request().postData() ?? ""
    const params = new URLSearchParams(lastPostData)
    const shopId = normalizeText(params.get("shopId"))
    stores.push({
      storeName,
      shopId: shopId && shopId !== "-1" ? shopId : null
    })
    await page.waitForTimeout(300)
  }

  return stores
}

const filterStores = (
  stores: StoreProbe[],
  scope: { storeId?: string; storeName?: string }
) => {
  const normalizedStoreId = normalizeText(scope.storeId)
  const normalizedStoreName = normalizeText(scope.storeName)
  if (!normalizedStoreId && !normalizedStoreName) {
    return {
      stores,
      warnings: [] as string[]
    }
  }

  const filtered = stores.filter((store) => sameStore(store, {
    shopId: normalizedStoreId || null,
    storeName: normalizedStoreName || null
  }))

  if (filtered.length > 0) {
    return {
      stores: filtered,
      warnings: [] as string[]
    }
  }

  const requestedStoreLabel = normalizedStoreName || normalizedStoreId || "unknown store"
  return {
    stores: [],
    warnings: [`requested store not found in Dianxiaomi account list: ${requestedStoreLabel}`]
  }
}

const scanBucketForStore = async (
  context: BrowserContext,
  store: StoreProbe,
  bucket: SupportedBucket,
  maxPages: number
) => {
  const spec = bucketSpecs[bucket]
  const links: DianxiaomiAccountScanLink[] = []

  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const payload = await postPageList(context, {
      shopId: store.shopId ?? "-1",
      dxmState: spec.dxmState,
      pageNo
    })

    if (payload.code !== 0) {
      throw new Error(`${spec.label} API failed for ${store.storeName}: ${payload.msg ?? payload.code}`)
    }

    const list = payload.data?.page?.list ?? []
    if (list.length === 0) {
      break
    }

    for (const item of list) {
      const editUrl = resolveEditUrl(item)
      if (!editUrl) {
        continue
      }

      const id = normalizeText(String(item.idStr ?? item.id ?? ""))
      links.push({
        id: `${bucket}:${id || editUrl}`,
        shopId: store.shopId ?? (normalizeText(String(item.shopId ?? "")) || null),
        storeName: store.storeName,
        sourceBucket: bucket,
        title: normalizeText(item.productName ?? item.platformTitle ?? ""),
        editUrl,
        sourceUrl: normalizeText(item.sourceUrl ?? item.outerGoodsUrl ?? "") || null,
        siteLabel: normalizeText(
          typeof item.siteValue === "string" ? item.siteValue : item.siteName ?? item.platformSite ?? ""
        ) || null,
        sourcePlatform: normalizeText(item.sourcePlatform ?? "") || null,
        categoryId: normalizeOptionalText(item.categoryId),
        fullCid: normalizeOptionalText(item.fullCid),
        createdAt: formatTimestamp(item.createTime),
        updatedAt: formatTimestamp(item.updateTime)
      })
    }

    if (list.length < 50) {
      break
    }
  }

  return links
}

const buildResult = (
  stores: DianxiaomiAccountScanStore[],
  sourceBuckets: SupportedBucket[],
  warnings: string[],
  profile: string
): DianxiaomiAccountScanResult => {
  const bucketCounts: Partial<Record<AutomationSourceBucket, number>> = {}
  let linkCount = 0

  for (const store of stores) {
    for (const bucket of sourceBuckets) {
      const count = store.bucketCounts[bucket] ?? 0
      if (!count) {
        continue
      }
      bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + count
      linkCount += count
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    profile,
    sourceBuckets,
    stores,
    totals: {
      storeCount: stores.length,
      linkCount,
      bucketCounts
    },
    warnings
  }
}

const main = async () => {
  const input = getInput()
  const artifactDir = input.screenshots
  const requestedSourceBuckets = input.sourceBuckets.length > 0 ? input.sourceBuckets : DEFAULT_BUCKETS
  const supportedSourceBuckets = requestedSourceBuckets.filter((bucket): bucket is SupportedBucket =>
    bucket === "collection-box" || bucket === "pending-publish"
  )
  const warnings: string[] = []

  if (requestedSourceBuckets.includes("listing-draft")) {
    warnings.push("listing-draft is not included yet in account scan.")
  }

  ensureDirectory(artifactDir)

  const context = await chromium.launchPersistentContext(input.profile, {
    channel: "chromium",
    headless: !input.headed,
    viewport: {
      width: 1440,
      height: 960
    }
  })

  const page = context.pages()[0] ?? await context.newPage()
  page.setDefaultTimeout(20000)

  try {
    const discoveredStores = await discoverStores(page)
    if (discoveredStores.length === 0) {
      throw new Error("no stores found on Dianxiaomi offline page")
    }
    const filteredStores = filterStores(discoveredStores, {
      storeId: input.storeId,
      storeName: input.storeName
    })
    warnings.push(...filteredStores.warnings)
    if (filteredStores.stores.length === 0) {
      throw new Error(filteredStores.warnings[0] ?? "requested store not found")
    }

    const stores: DianxiaomiAccountScanStore[] = []
    const dedupe = new Set<string>()

    for (const store of filteredStores.stores) {
      if (!store.shopId) {
        warnings.push(`missing shopId for store: ${store.storeName}`)
        stores.push({
          shopId: null,
          storeName: store.storeName,
          bucketCounts: {},
          links: []
        })
        continue
      }

      const bucketCounts: Partial<Record<AutomationSourceBucket, number>> = {}
      const links: DianxiaomiAccountScanLink[] = []

      for (const bucket of supportedSourceBuckets) {
        const scannedLinks = await scanBucketForStore(context, store, bucket, input.maxPages)
        for (const link of scannedLinks) {
          const key = `${link.sourceBucket}:${link.editUrl}`
          if (dedupe.has(key)) {
            continue
          }
          dedupe.add(key)
          links.push(link)
        }
        bucketCounts[bucket] = scannedLinks.length
      }

      stores.push({
        shopId: store.shopId,
        storeName: store.storeName,
        bucketCounts,
        links
      })
    }

    const result = buildResult(stores, supportedSourceBuckets, warnings, input.profile)
    const resultPath = path.join(artifactDir, "dianxiaomi-account-scan.result.json")
    writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8")

    console.log(`Scanned ${result.totals.storeCount} stores, ${result.totals.linkCount} links.`)
    console.log(`Result: ${resultPath}`)
  } finally {
    await context.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
