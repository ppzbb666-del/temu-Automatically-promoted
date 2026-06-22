import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Page } from "playwright"
import { ensureDirectory, getArgValue, parseBoolean, waitForManualLoginIfNeeded } from "./common"

type SourceBucket = "collection-box" | "pending-publish" | "listing-draft"

type DianxiaomiCollectedProductRecord = {
  id: string
  pageUrl: string
  collectedAt: string
  storeName?: string
  sourceBucket?: SourceBucket
  category?: string
  notes?: string[]
}

type DianxiaomiProductWorkItemRecord = {
  id: string
  pageUrl: string
  updatedAt: string
  storeName?: string
  sourceBucket?: SourceBucket
  pageProfile?: string
  status?: string
  notes?: string[]
}

type CalibrationArtifact = {
  ok: boolean
  checkedAt: string
  pageUrl: string
  pageTitle: string
  expectedSourceBucket: SourceBucket | null
  extensionPath: string
  profileDir: string
  beforeScreenshotPath: string
  afterScreenshotPath?: string
  failureScreenshotPath?: string
  panelTextSample?: string
  collectedProduct?: DianxiaomiCollectedProductRecord | null
  workItem?: DianxiaomiProductWorkItemRecord | null
  error?: string
}

const SERVER_BASE_URL = "http://localhost:8787"

const timestampId = () => new Date().toISOString().replace(/[:.]/g, "-")

const getRepoRoot = () => {
  const currentFile = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(currentFile), "../../..")
}

const normalizeText = (value: string | null | undefined) =>
  (value ?? "").replace(/\s+/g, " ").trim().toLowerCase()

const normalizePageUrl = (value: string | null | undefined) => {
  try {
    const url = new URL(String(value ?? "").trim())
    url.hash = ""
    return url.toString()
  } catch {
    return String(value ?? "").trim()
  }
}

const parseSourceBucket = (value: string | undefined | null): SourceBucket | null => {
  if (value === "collection-box" || value === "pending-publish" || value === "listing-draft") {
    return value
  }

  return null
}

const inferExpectedSourceBucket = (pageUrl: string, pageText: string): SourceBucket | null => {
  const haystack = normalizeText(`${pageUrl} ${pageText}`)

  if (
    haystack.includes("待发布")
    || haystack.includes("pending publish")
    || haystack.includes("temu半托管产品>待发布")
  ) {
    return "pending-publish"
  }

  if (
    haystack.includes("待刊登")
    || haystack.includes("刊登草稿")
    || haystack.includes("draft listing")
    || haystack.includes("draft box")
  ) {
    return "listing-draft"
  }

  if (
    haystack.includes("采集箱")
    || haystack.includes("collection box")
    || haystack.includes("collect box")
    || haystack.includes("platform collection")
  ) {
    return "collection-box"
  }

  return null
}

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} (${url})`)
  }

  return response.json() as Promise<T>
}

const getRecordTimestampMs = (record: { updatedAt?: string; collectedAt?: string } | null | undefined) => {
  const value = record?.updatedAt ?? record?.collectedAt
  const parsed = Date.parse(value ?? "")
  return Number.isFinite(parsed) ? parsed : 0
}

const findLatestByPageUrl = <T extends { pageUrl: string }>(items: T[], pageUrl: string) => {
  const normalizedTargetUrl = normalizePageUrl(pageUrl)

  return items.find((item) => normalizePageUrl(item.pageUrl) === normalizedTargetUrl) ?? null
}

const waitForServerRecord = async <T extends { pageUrl: string; updatedAt?: string; collectedAt?: string }>(
  label: string,
  endpoint: string,
  pageUrl: string,
  minTimestampMs: number,
  timeoutMs = 45_000
) => {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const items = await fetchJson<T[]>(endpoint)
    const matched = findLatestByPageUrl(items, pageUrl)

    if (matched && getRecordTimestampMs(matched) >= minTimestampMs) {
      return matched
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  throw new Error(`Timed out waiting for ${label} update for ${pageUrl}`)
}

const readBodyText = async (page: Page) =>
  (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim()

const readPanelText = async (page: Page) =>
  page.locator("#temu-ai-root").innerText().catch(() => "")

const assertSourceBucket = (
  expected: SourceBucket | null,
  actual: string | undefined,
  label: string
) => {
  if (!expected) {
    return
  }

  if (actual !== expected) {
    throw new Error(`${label} sourceBucket mismatch: expected ${expected}, got ${actual ?? "missing"}`)
  }
}

const assertIncludesNote = (notes: string[] | undefined, expectedFragment: string, label: string) => {
  if (notes?.some((note) => note.includes(expectedFragment))) {
    return
  }

  throw new Error(`${label} missing note fragment: ${expectedFragment}`)
}

const assertPageProfileMatchesBucket = (pageProfile: string | undefined, expected: SourceBucket | null) => {
  if (!expected) {
    return
  }

  const normalizedProfile = normalizeText(pageProfile)

  if (expected === "pending-publish" && normalizedProfile.includes("待发布")) {
    return
  }

  if (expected === "listing-draft" && (normalizedProfile.includes("待刊登") || normalizedProfile.includes("草稿"))) {
    return
  }

  if (expected === "collection-box" && normalizedProfile.includes("采集箱")) {
    return
  }

  throw new Error(`work item pageProfile does not match expected bucket ${expected}: ${pageProfile ?? "missing"}`)
}

const writeArtifact = (artifactPath: string, artifact: CalibrationArtifact) => {
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), "utf8")
}

const main = async () => {
  const repoRoot = getRepoRoot()
  const targetUrl = getArgValue("url") ?? process.env.TEMU_TARGET_URL

  if (!targetUrl) {
    throw new Error("Missing target URL. Provide --url=<real Dianxiaomi edit/listing page>.")
  }

  const headed = parseBoolean(getArgValue("headed") ?? process.env.HEADED, true)
  const keepOpen = parseBoolean(getArgValue("keep-open") ?? process.env.KEEP_OPEN, false)
  const profileDir = path.resolve(
    repoRoot,
    getArgValue("profile") ?? process.env.TEMU_PROFILE_DIR ?? ".runtime/playwright/dianxiaomi-real-profile"
  )
  const extensionPath = path.resolve(
    repoRoot,
    getArgValue("extension") ?? process.env.DIANXIAOMI_EXTENSION_PATH ?? "apps/extension/dist"
  )
  const artifactDir = path.resolve(
    repoRoot,
    getArgValue("screenshots") ?? process.env.SCREENSHOT_DIR ?? `output/playwright/real-admission-${timestampId()}`
  )

  const manifestPath = path.join(extensionPath, "manifest.json")
  if (!existsSync(manifestPath)) {
    throw new Error(`Extension build not found: ${manifestPath}. Run npm run build --workspace @temu-ai-ops/extension first.`)
  }

  ensureDirectory(profileDir)
  ensureDirectory(artifactDir)

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: !headed,
    slowMo: headed ? 120 : 0,
    viewport: {
      width: 1440,
      height: 960
    },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  })

  let page = context.pages()[0] ?? await context.newPage()
  page.setDefaultTimeout(20_000)

  const beforeScreenshotPath = path.join(artifactDir, "before-collect.png")
  const afterScreenshotPath = path.join(artifactDir, "after-collect.png")
  const failureScreenshotPath = path.join(artifactDir, "failure.png")
  const artifactPath = path.join(artifactDir, "real-admission-calibration.json")

  try {
    console.log(`Opening ${targetUrl}`)
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded"
    })
    await waitForManualLoginIfNeeded(page)
    if (page.isClosed()) {
      page = context.pages().find((candidate) => !candidate.isClosed()) ?? await context.newPage()
      page.setDefaultTimeout(20_000)
    }
    if (page.url() !== targetUrl) {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded"
      })
    }

    const panelRoot = page.locator("#temu-ai-root")
    await panelRoot.waitFor({
      state: "visible",
      timeout: 20_000
    })
    await page.waitForTimeout(1_500)

    await page.screenshot({
      path: beforeScreenshotPath,
      fullPage: true
    })

    const pageText = await readBodyText(page)
    const expectedSourceBucket = parseSourceBucket(
      getArgValue("expected-source-bucket") ?? process.env.EXPECTED_SOURCE_BUCKET
    ) ?? inferExpectedSourceBucket(page.url(), pageText)

    const previousWorkItem = findLatestByPageUrl(
      await fetchJson<DianxiaomiProductWorkItemRecord[]>(`${SERVER_BASE_URL}/dianxiaomi/product-work-items?limit=50`),
      page.url()
    )
    const previousCollectedProduct = findLatestByPageUrl(
      await fetchJson<DianxiaomiCollectedProductRecord[]>(`${SERVER_BASE_URL}/dianxiaomi/collected-products?limit=50`),
      page.url()
    )
    const collectStartedAt = Math.max(
      Date.now() - 500,
      getRecordTimestampMs(previousWorkItem) + 1,
      getRecordTimestampMs(previousCollectedProduct) + 1
    )

    const collectButton = page.locator("#temu-ai-root #temu-ai-collect")
    await collectButton.waitFor({
      state: "visible"
    })
    await collectButton.click()

    const collectedProduct = await waitForServerRecord<DianxiaomiCollectedProductRecord>(
      "collected product",
      `${SERVER_BASE_URL}/dianxiaomi/collected-products?limit=50`,
      page.url(),
      collectStartedAt
    )
    const workItem = await waitForServerRecord<DianxiaomiProductWorkItemRecord>(
      "product work item",
      `${SERVER_BASE_URL}/dianxiaomi/product-work-items?limit=50`,
      page.url(),
      collectStartedAt
    )

    assertSourceBucket(expectedSourceBucket, collectedProduct.sourceBucket, "collected product")
    assertSourceBucket(expectedSourceBucket, workItem.sourceBucket, "work item")
    assertPageProfileMatchesBucket(workItem.pageProfile, expectedSourceBucket)
    assertIncludesNote(workItem.notes, "page profile key:", "work item")
    if (expectedSourceBucket) {
      assertIncludesNote(workItem.notes, `source bucket: ${expectedSourceBucket}`, "work item")
      assertIncludesNote(collectedProduct.notes, `source bucket: ${expectedSourceBucket}`, "collected product")
    }

    const panelTextSample = (await readPanelText(page)).replace(/\s+/g, " ").trim().slice(0, 600)

    await page.screenshot({
      path: afterScreenshotPath,
      fullPage: true
    })

    writeArtifact(artifactPath, {
      ok: true,
      checkedAt: new Date().toISOString(),
      pageUrl: page.url(),
      pageTitle: await page.title(),
      expectedSourceBucket,
      extensionPath,
      profileDir,
      beforeScreenshotPath,
      afterScreenshotPath,
      panelTextSample,
      collectedProduct,
      workItem
    })

    console.log(`Real admission calibration passed.`)
    console.log(`Artifacts: ${artifactDir}`)
  } catch (error) {
    await page.screenshot({
      path: failureScreenshotPath,
      fullPage: true
    }).catch(() => undefined)

    const pageTitle = await page.title().catch(() => "")
    writeArtifact(artifactPath, {
      ok: false,
      checkedAt: new Date().toISOString(),
      pageUrl: page.url(),
      pageTitle,
      expectedSourceBucket: null,
      extensionPath,
      profileDir,
      beforeScreenshotPath,
      failureScreenshotPath,
      error: error instanceof Error ? error.message : String(error)
    })

    throw error
  } finally {
    if (!headed || !keepOpen) {
      await context.close()
    } else {
      console.log("Headed browser left open for inspection.")
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
