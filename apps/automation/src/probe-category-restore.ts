import fs from "node:fs"
import path from "node:path"
import { chromium, type Page } from "playwright"

const SOURCE_PROFILE = path.resolve(".runtime/dianxiaomi-real-profile")
const EXECUTABLE_PATH = "C:/Program Files/Google/Chrome/Application/chrome.exe"
const TARGET_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453261437108"
const CATEGORY_MISSING_TEXT = "\u672a\u9009\u62e9\u5206\u7c7b"
const CHOOSE_CATEGORY_TEXT = "\u9009\u62e9\u5206\u7c7b"
const TARGET_CATEGORY_TEXT = "\u5176\u4ed6\uff08\u5973\u88c5\u957f\u88e4\uff09"
const SEARCH_PLACEHOLDER_TEXT = "\u641c\u7d22\u5206\u7c7b\u540d\u79f0"
const SEARCH_BUTTON_TEXT = "\u641c\u7d22"

const artifactDir = path.resolve(
  `output/playwright/probe-category-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`
)

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()

const snapshotCategoryHitsEval = new Function("input", `
  const { categoryMissingText, chooseCategoryText, targetCategoryText } = input
  const cleanText = (value) => (value ?? "").replace(/\\s+/g, " ").trim()

  return Array.from(document.querySelectorAll("input, select, textarea, button, a, div, span"))
    .map((node) => {
      const element = node
      const value = "value" in element ? cleanText(String(element.value ?? "")) : ""
      const className = typeof element.className === "string" ? element.className : ""
      return {
        tag: node.tagName,
        text: cleanText(node.textContent),
        name: "name" in element ? element.name ?? "" : "",
        id: element.id ?? "",
        value,
        className,
        html: element instanceof HTMLElement ? element.outerHTML.slice(0, 500) : ""
      }
    })
    .filter((item) => {
      const blob = \`\${item.text} \${item.name} \${item.id} \${item.value} \${item.className} \${item.html}\`
      return blob.includes(categoryMissingText)
        || blob.includes(chooseCategoryText)
        || blob.includes(targetCategoryText)
        || /category|catid|fullcid|classid|nodepath/i.test(blob)
    })
    .slice(0, 120)
`)

const collectModalStateEval = new Function(`
  const cleanText = (value) => (value ?? "").replace(/\\s+/g, " ").trim()
  return {
    modalTitles: Array.from(document.querySelectorAll(".ant-modal-title")).map((node) => cleanText(node.textContent)).filter(Boolean),
    footerButtons: Array.from(document.querySelectorAll(".ant-modal-footer button")).map((node) => cleanText(node.textContent)).filter(Boolean),
    pickedText: cleanText(document.querySelector(".w-960.mt-8.pl-10.minh-24")?.textContent ?? ""),
    categoryColumns: Array.from(document.querySelectorAll(".categories-box")).map((box) =>
      Array.from(box.querySelectorAll(".categories-item-name")).map((node) => cleanText(node.textContent)).filter(Boolean).slice(0, 40)
    ),
    searchResults: Array.from(document.querySelectorAll(".search-result-item")).map((node) => ({
      text: cleanText(node.textContent),
      className: node.className,
      ariaSelected: node.getAttribute("aria-selected"),
      dataValue: node.getAttribute("data-value"),
      html: node instanceof HTMLElement ? node.outerHTML.slice(0, 500) : ""
    })).slice(0, 20)
  }
`)

const removeCopiedLocks = (root: string) => {
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }

      if (/^(LOCK|Singleton.*|lockfile)$/i.test(entry.name)) {
        fs.rmSync(fullPath, { force: true })
      }
    }
  }
}

const createProbeProfile = () => {
  const profilePath = path.resolve(`.runtime/dxm-category-probe-${Date.now()}`)
  fs.cpSync(SOURCE_PROFILE, profilePath, { recursive: true })
  removeCopiedLocks(profilePath)
  return profilePath
}

const snapshotCategoryHits = async (page: Page) =>
  page.evaluate(
    snapshotCategoryHitsEval as (input: {
      categoryMissingText: string
      chooseCategoryText: string
      targetCategoryText: string
    }) => unknown,
    {
      categoryMissingText: CATEGORY_MISSING_TEXT,
      chooseCategoryText: CHOOSE_CATEGORY_TEXT,
      targetCategoryText: TARGET_CATEGORY_TEXT
    }
  )

const fetchProductCategoryFields = async (page: Page, profileRequest: Awaited<ReturnType<typeof chromium.launchPersistentContext>>["request"]) => {
  const productId = new URL(page.url()).searchParams.get("id")?.trim() ?? ""
  const response = await profileRequest.get(`https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${productId}`)
  const payload = JSON.parse(await response.text()) as {
    data?: {
      product?: Record<string, unknown>
    }
  }
  const product = payload.data?.product ?? {}

  return {
    categoryId: product.categoryId ?? null,
    fullCid: product.fullCid ?? null,
    shopId: product.shopId ?? null,
    siteId: product.siteId ?? null,
    classId: product.classId ?? null,
    classType: product.classType ?? null,
    nodePathId: product.nodePathId ?? null,
    nodePath: product.nodePath ?? null,
    categoryName: product.categoryName ?? null,
    keys: Object.keys(product).filter((key) => /cat|category|cid|class|shopId|siteId|nodePath|fullCid/i.test(key)).sort()
  }
}

const collectPageState = async (
  page: Page,
  profileRequest: Awaited<ReturnType<typeof chromium.launchPersistentContext>>["request"],
  label: string
) => {
  const bodyText = clean(await page.locator("body").innerText().catch(() => ""))

  return {
    label,
    url: page.url(),
    title: await page.title().catch(() => ""),
    bodyHasMissingCategory: bodyText.includes(CATEGORY_MISSING_TEXT),
    bodyExcerpt: bodyText.slice(0, 1_000),
    productCategoryFields: await fetchProductCategoryFields(page, profileRequest),
    categoryHits: await snapshotCategoryHits(page)
  }
}

const collectModalState = async (page: Page) =>
  page.evaluate(collectModalStateEval as () => unknown)

const main = async () => {
  fs.mkdirSync(artifactDir, { recursive: true })
  const probeProfile = createProbeProfile()
  const context = await chromium.launchPersistentContext(probeProfile, {
    executablePath: EXECUTABLE_PATH,
    headless: true,
    viewport: {
      width: 1440,
      height: 960
    }
  })

  const events: Array<Record<string, unknown>> = []

  try {
    const page = await context.newPage()
    page.on("request", (request) => {
      const url = request.url()
      if (!/popTemuCategory|modifyCategory|reEdit|searchCategory|batchCheckProductHasVariationTheme|popTemuProduct/i.test(url)) {
        return
      }

      events.push({
        type: "request",
        url,
        method: request.method(),
        postData: request.postData() ?? ""
      })
    })
    page.on("response", async (response) => {
      const url = response.url()
      if (!/popTemuCategory|modifyCategory|reEdit|searchCategory|batchCheckProductHasVariationTheme|popTemuProduct/i.test(url)) {
        return
      }

      let body = ""
      try {
        body = (await response.text()).slice(0, 4_000)
      } catch {
        body = ""
      }

      events.push({
        type: "response",
        url,
        status: response.status(),
        body
      })
    })

    await page.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    })
    await page.waitForTimeout(3_000)

    const before = await collectPageState(page, context.request, "before")
    await page.screenshot({
      path: path.join(artifactDir, "01-before.png"),
      fullPage: true
    })

    const chooseButton = page.getByRole("button", { name: CHOOSE_CATEGORY_TEXT })
    const chooseCount = await chooseButton.count()
    if (chooseCount !== 1) {
      const result = {
        artifactDir,
        error: "choose-category-button-not-unique",
        chooseCount,
        before,
        events
      }
      fs.writeFileSync(path.join(artifactDir, "result.json"), JSON.stringify(result, null, 2), "utf8")
      console.log(path.join(artifactDir, "result.json"))
      return
    }

    await chooseButton.click()
    await page.waitForTimeout(1_500)

    const modalBeforeSearch = await collectModalState(page)
    await page.screenshot({
      path: path.join(artifactDir, "02-modal-before-search.png"),
      fullPage: true
    })

    const searchInput = page.getByPlaceholder(SEARCH_PLACEHOLDER_TEXT, { exact: true })
    const searchInputCount = await searchInput.count()
    if (searchInputCount === 1) {
      await searchInput.fill(TARGET_CATEGORY_TEXT)
      const searchButton = page.getByRole("button", { name: SEARCH_BUTTON_TEXT })
      if (await searchButton.count() === 1) {
        await searchButton.click()
        await page.waitForTimeout(2_000)
      }
    }

    const modalAfterSearch = await collectModalState(page)
    await page.screenshot({
      path: path.join(artifactDir, "03-modal-after-search.png"),
      fullPage: true
    })

    const resultItem = page.locator(".search-result-item")
    const resultCount = await resultItem.count()
    if (resultCount > 0) {
      await resultItem.click()
      await page.waitForTimeout(1_000)
    }

    const afterSingleClick = await collectPageState(page, context.request, "after-single-click")
    const singleClickModalState = await collectModalState(page)
    await page.screenshot({
      path: path.join(artifactDir, "04-after-single-click.png"),
      fullPage: true
    })

    if (resultCount > 0) {
      await resultItem.dblclick().catch(() => undefined)
      await page.waitForTimeout(1_000)
      await page.keyboard.press("Enter").catch(() => undefined)
      await page.waitForTimeout(1_000)
    }

    const afterDoubleClickEnter = await collectPageState(page, context.request, "after-double-click-enter")
    const doubleClickModalState = await collectModalState(page)
    await page.screenshot({
      path: path.join(artifactDir, "05-after-double-click-enter.png"),
      fullPage: true
    })

    const result = {
      artifactDir,
      before,
      modalBeforeSearch,
      modalAfterSearch,
      afterSingleClick,
      singleClickModalState,
      afterDoubleClickEnter,
      doubleClickModalState,
      events
    }
    fs.writeFileSync(path.join(artifactDir, "result.json"), JSON.stringify(result, null, 2), "utf8")
    console.log(path.join(artifactDir, "result.json"))
  } finally {
    await context.close().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
