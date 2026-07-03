import fs from "node:fs"
import path from "node:path"
import { chromium, type BrowserContext, type Page } from "playwright"

const SOURCE_PROFILE = path.resolve(".runtime/dianxiaomi-real-profile")
const EXECUTABLE_PATH = "C:/Program Files/Google/Chrome/Application/chrome.exe"
const TARGET_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453261437108"
const TARGET_CATEGORY_TEXT = "其他（女装长裤）"

const artifactDir = path.resolve(
  `output/playwright/probe-category-vue-state-${new Date().toISOString().replace(/[:.]/g, "-")}`
)

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()

const inspectStateEval = new Function(
  "input",
  `
  const { label, targetCategoryText } = input
  const cleanText = (value) => (value ?? "").replace(/\\s+/g, " ").trim()
  const isVisible = (node) => {
    if (!node) {
      return false
    }

    const style = window.getComputedStyle(node)
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false
    }

    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  const elementPath = (node) => {
    if (!node) {
      return ""
    }

    const parts = []
    let current = node
    let depth = 0
    while (current && depth < 6) {
      const tag = current.tagName.toLowerCase()
      const className = typeof current.className === "string" ? current.className.trim() : ""
      const classPart = className
        ? "." + className.split(/\\s+/).slice(0, 3).join(".")
        : ""
      parts.push(tag + classPart)
      current = current.parentElement
      depth += 1
    }
    return parts.join(" <- ")
  }

  const summarizeValue = (inputValue, depth = 0) => {
    if (depth > 2) {
      return typeof inputValue
    }

    if (
      inputValue == null
      || typeof inputValue === "string"
      || typeof inputValue === "number"
      || typeof inputValue === "boolean"
    ) {
      return inputValue
    }

    if (Array.isArray(inputValue)) {
      return {
        type: "array",
        length: inputValue.length,
        sample: inputValue.slice(0, 3).map((item) => summarizeValue(item, depth + 1))
      }
    }

    if (typeof inputValue === "function") {
      return {
        type: "function",
        name: inputValue.name || "(anonymous)"
      }
    }

    if (typeof inputValue === "object") {
      const value = inputValue
      const preferredKeys = [
        "catId",
        "catName",
        "categoryId",
        "categoryName",
        "nodePath",
        "nodePathId",
        "parentCatId",
        "isLeaf",
        "isHidden",
        "hiddenType",
        "classType",
        "classId",
        "categoryType",
        "fullCid",
        "searchCategory"
      ]
      const keys = Object.keys(value)
      const picked = preferredKeys.filter((key) => key in value)
      if (picked.length > 0) {
        const summary = {}
        for (const key of picked) {
          summary[key] = summarizeValue(value[key], depth + 1)
        }
        return summary
      }
      return {
        type: value.constructor?.name || "object",
        keys: keys.slice(0, 20)
      }
    }

    return typeof inputValue
  }

  const summarizeComponentChain = (node) => {
    const chain = []
    let current = node ? (node.__vueParentComponent ?? null) : null
    let depth = 0
    while (current && depth < 8) {
      const instance = current
      const typeObject = instance.type && typeof instance.type === "object" ? instance.type : {}
      const props = instance.props && typeof instance.props === "object" ? instance.props : {}
      const ctx = instance.ctx && typeof instance.ctx === "object" ? instance.ctx : {}
      const setupState = instance.setupState && typeof instance.setupState === "object" ? instance.setupState : {}
      const merged = { ...props, ...ctx, ...setupState }
      const matchedKeys = Object.keys(merged)
        .filter((key) => /(category|search|result|select|choose|hidden|node|class|cat|path|fullCid|leaf)/i.test(key))
        .slice(0, 40)

      const matchedValues = {}
      for (const key of matchedKeys.slice(0, 18)) {
        try {
          matchedValues[key] = summarizeValue(merged[key])
        } catch (error) {
          matchedValues[key] = "error:" + String(error)
        }
      }

      chain.push({
        depth,
        name: [cleanText(String(typeObject.name ?? "")), cleanText(String(typeObject.__name ?? ""))]
          .filter(Boolean)[0] || "(anonymous)",
        propKeys: Object.keys(props).slice(0, 25),
        setupKeys: Object.keys(setupState).slice(0, 25),
        ctxKeys: Object.keys(ctx).slice(0, 25),
        matchedKeys,
        matchedValues
      })

      current = instance.parent ?? null
      depth += 1
    }

    return chain
  }

  const pickVisible = (selector) =>
    Array.from(document.querySelectorAll(selector)).find((node) => isVisible(node)) ?? null

  const pickButton = (text) =>
    Array.from(document.querySelectorAll("button"))
      .find((node) => isVisible(node) && cleanText(node.textContent).includes(text)) ?? null

  const searchResult = Array.from(document.querySelectorAll(".search-result-item"))
    .find((node) => isVisible(node) && cleanText(node.textContent).includes(targetCategoryText)) ?? null

  const nodes = {
    warning: pickVisible(".category-list"),
    select: pickVisible(".ant-select-selector"),
    chooseButton: pickButton("选择分类"),
    modal: pickVisible(".ant-modal-content"),
    modalBody: pickVisible(".ant-modal-body"),
    searchInput: pickVisible("input[name='searchCategory']"),
    searchResultContainer: pickVisible(".search-result"),
    searchResult,
    modalFooter: pickVisible(".ant-modal-footer"),
    pickedText: pickVisible(".w-960.mt-8.pl-10.minh-24")
  }

  const result = {
    label,
    bodyHasMissingCategory: cleanText(document.body.innerText).includes("未选择分类")
  }

  for (const [key, node] of Object.entries(nodes)) {
    if (!node) {
      result[key] = null
      continue
    }

    result[key] = {
      text: cleanText(node.innerText || node.textContent).slice(0, 300),
      className: typeof node.className === "string" ? node.className : "",
      path: elementPath(node),
      html: node.outerHTML.slice(0, 600),
      componentChain: summarizeComponentChain(node)
    }
  }

  return result
`
)

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
  const profilePath = path.resolve(`.runtime/dxm-category-vue-probe-${Date.now()}`)
  fs.cpSync(SOURCE_PROFILE, profilePath, { recursive: true })
  removeCopiedLocks(profilePath)
  return profilePath
}

const clickVisibleButtonByText = async (page: Page, text: string) => {
  const button = page
    .locator("button")
    .filter({ hasText: text })
    .filter({ hasNotText: "关闭当前标签" })
    .first()
  await button.click({ timeout: 15_000 })
}

const findFirstVisible = async (page: Page, selectors: string[]) => {
  for (const selector of selectors) {
    const locator = page.locator(selector)
    const count = Math.min(await locator.count().catch(() => 0), 40)
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index)
      if (await item.isVisible().catch(() => false)) {
        return item
      }
    }
  }

  return null
}

const inspectState = async (page: Page, label: string) =>
  page.evaluate(
    inspectStateEval as (input: {
      label: string
      targetCategoryText: string
    }) => unknown,
    {
      label,
      targetCategoryText: TARGET_CATEGORY_TEXT
    }
  )

const collectEditJsonSummary = async (context: BrowserContext, page: Page) => {
  const productId = new URL(page.url()).searchParams.get("id")?.trim() ?? ""
  const response = await context.request.get(`https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${productId}`)
  const payload = JSON.parse(await response.text()) as {
    data?: {
      product?: Record<string, unknown>
    }
  }
  const product = payload.data?.product ?? {}
  const keys = Object.keys(product)
    .filter((key) => /cat|category|cid|class|shopId|siteId|nodePath|fullCid/i.test(key))
    .sort()
  const summary: Record<string, unknown> = {}
  for (const key of keys) {
    summary[key] = product[key]
  }
  return summary
}

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

  try {
    const page = await context.newPage()
    await page.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    })
    await page.waitForTimeout(3_000)

    await clickVisibleButtonByText(page, "选择分类")
    await page.waitForTimeout(1_200)

    const searchInput = await findFirstVisible(page, ["input[name='searchCategory']", ".ant-modal-body input.ant-input"])
    if (!searchInput) {
      throw new Error("search category input not found")
    }
    await searchInput.fill(TARGET_CATEGORY_TEXT)
    await clickVisibleButtonByText(page, "搜索")
    await page.waitForTimeout(2_000)

    const beforeClick = await inspectState(page, "before-click")
    await page.screenshot({
      path: path.join(artifactDir, "01-before-click.png"),
      fullPage: true
    })

    const result = page.locator(".search-result-item").filter({ hasText: TARGET_CATEGORY_TEXT }).first()
    await result.click({ timeout: 10_000 })
    await page.waitForTimeout(1_000)

    const afterClick = await inspectState(page, "after-click")
    await page.screenshot({
      path: path.join(artifactDir, "02-after-click.png"),
      fullPage: true
    })

    const payload = {
      artifactDir,
      beforeClick,
      afterClick,
      editJson: await collectEditJsonSummary(context, page)
    }

    const outputPath = path.join(artifactDir, "result.json")
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8")
    console.log(outputPath)
  } finally {
    await context.close().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
