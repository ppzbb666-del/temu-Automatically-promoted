import { writeFileSync } from "node:fs"
import path from "node:path"
import { chromium, type Page } from "playwright"
import { ensureDirectory, getArgValue, parseBoolean, waitForManualLoginIfNeeded } from "./common"
import { inspectDianxiaomiTargetSurface, waitForPublishPage } from "./adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "./selector-config"

type VisibleItem = {
  tag: string
  text: string
  className: string
  role: string | null
  left: number
  top: number
  width: number
  height: number
}

type PanelCandidate = VisibleItem & {
  zIndex: string
}

type InspectionPayload = {
  createdAt: string
  targetUrl: string
  pageUrl: string
  pageTitle: string
  clicked: boolean
  clickTargetText: string | null
  signals: {
    beforeDialogs: number
    afterDialogs: number
    bodySnippet: string
    statusTexts: string[]
  }
  panelInfo: {
    panelCandidates: PanelCandidate[]
    categoryNodes: VisibleItem[]
    actionNodes: VisibleItem[]
    issueNodes: VisibleItem[]
  }
  screenshotPath: string
}

type VisibleStateInspection = {
  panelCandidates: PanelCandidate[]
  categoryNodes: VisibleItem[]
  actionNodes: VisibleItem[]
  issueNodes: VisibleItem[]
  bodySnippet: string
  statusTexts: string[]
}

const TARGET_PAGE_PATTERN = /\/web\/popTemu\/edit\b/i

const IMAGE_CHECK_KEYWORDS = [
  "\u56fe\u7247\u68c0\u6d4b",
  "\u68c0\u6d4b\u56fe\u7247"
]

const ISSUE_KEYWORDS = [
  "\u95ee\u9898",
  "\u5f02\u5e38",
  "\u4fee\u590d",
  "\u6bd4\u4f8b",
  "\u5c3a\u5bf8",
  "\u5bbd\u9ad8",
  "3:4",
  "\u8f6e\u64ad",
  "\u4ea7\u54c1\u56fe",
  "\u8be6\u60c5\u56fe",
  "\u4e3b\u56fe",
  "\u901a\u8fc7",
  "\u4e0d\u901a\u8fc7",
  "\u672a\u901a\u8fc7"
]

const CATEGORY_CLASS_PATTERN = /(tab|menu|nav|category|list|item|panel|issue|result)/i
const ACTION_TEXT_PATTERN = /(\u4fee\u590d|\u7f16\u8f91|\u88c1\u526a|\u66ff\u6362|\u8c03\u6574|\u751f\u6210|\u5904\u7406|\u5e94\u7528|\u91cd\u65b0|\u68c0\u6d4b|\u7acb\u5373)/i
const PANEL_CLASS_PATTERN = /(modal|dialog|drawer|dropdown|popover|popup|panel|result|issue|message|notice|editor)/i

const normalizeText = (value: string | null | undefined) =>
  (value ?? "").replace(/\s+/g, " ").trim()

const sameTarget = (value: string, targetUrl: string) => {
  try {
    const left = new URL(value)
    const right = new URL(targetUrl)
    return left.origin === right.origin
      && left.pathname === right.pathname
      && left.searchParams.get("id") === right.searchParams.get("id")
  } catch {
    return value === targetUrl
  }
}

const rankPage = (page: Page, targetUrl: string) => {
  const url = page.url()
  if (!url || url === "about:blank") {
    return 0
  }
  if (sameTarget(url, targetUrl)) {
    return 100
  }
  if (TARGET_PAGE_PATTERN.test(url)) {
    return 60
  }
  return 10
}

const acquirePage = async (pages: Page[], targetUrl: string) => {
  const selected = pages
    .filter((page) => !page.isClosed())
    .map((page) => ({
      page,
      score: rankPage(page, targetUrl)
    }))
    .sort((left, right) => right.score - left.score)[0]?.page

  return selected ?? null
}

const visibleDialogCount = async (page: Page) => {
  const locator = page.locator([
    ".ant-modal:visible",
    ".ant-drawer:visible",
    ".el-dialog:visible",
    "[role='dialog']:visible",
    "[aria-modal='true']:visible",
    "[class*='dialog' i]:visible",
    "[class*='drawer' i]:visible",
    "[class*='modal' i]:visible"
  ].join(", "))
  return Math.min(await locator.count().catch(() => 0), 20)
}

const findImageCheckTrigger = async (page: Page) => {
  for (const keyword of IMAGE_CHECK_KEYWORDS) {
    const pattern = new RegExp(keyword, "i")
    const candidate = page.getByRole("button", { name: pattern }).first()
    if (await candidate.isVisible().catch(() => false)) {
      return candidate
    }
  }

  const fallback = page.locator("button, a, [role='button'], [role='menuitem']").filter({
    hasText: /\u56fe\u7247\u68c0\u6d4b|\u68c0\u6d4b\u56fe\u7247/i
  }).first()

  return await fallback.isVisible().catch(() => false) ? fallback : null
}

const inspectVisibleStateEval = new Function("input", String.raw`
  const issueKeywords = input.issueKeywords.map((item) => item.toLowerCase())
  const categoryClassPattern = new RegExp(input.categoryClassPattern, "i")
  const actionTextPattern = new RegExp(input.actionTextPattern, "i")
  const panelClassPattern = new RegExp(input.panelClassPattern, "i")
  const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim()
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false
    }
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
  }
  const toItem = (element) => {
    const rect = element.getBoundingClientRect()
    return {
      tag: element.tagName.toLowerCase(),
      text: normalize(element.textContent).slice(0, 300),
      className: typeof element.className === "string" ? element.className.slice(0, 200) : "",
      role: element.getAttribute("role"),
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  }

  const all = Array.from(document.querySelectorAll("body *")).filter((element) => isVisible(element))

  const panelCandidates = all
    .filter((element) => {
      const text = normalize(element.textContent)
      const className = typeof element.className === "string" ? element.className : ""
      const rect = element.getBoundingClientRect()
      if (!text || text.length < 8) {
        return false
      }
      if (rect.width < 180 || rect.height < 60) {
        return false
      }
      return panelClassPattern.test(className) || element.getAttribute("role") === "dialog" || rect.width > 360
    })
    .slice(0, 80)
    .map((element) => ({
      ...toItem(element),
      zIndex: window.getComputedStyle(element).zIndex
    }))

  const categoryNodes = all
    .filter((element) => {
      const text = normalize(element.textContent)
      const className = typeof element.className === "string" ? element.className : ""
      const rect = element.getBoundingClientRect()
      if (!text || text.length > 40 || text.length < 2) {
        return false
      }
      if (rect.width < 40 || rect.height < 16) {
        return false
      }
      return categoryClassPattern.test(className) || issueKeywords.some((keyword) => text.toLowerCase().includes(keyword))
    })
    .slice(0, 200)
    .map((element) => toItem(element))

  const actionNodes = all
    .filter((element) => {
      const text = normalize(element.textContent)
      if (!text || text.length > 40) {
        return false
      }
      return actionTextPattern.test(text)
    })
    .slice(0, 200)
    .map((element) => toItem(element))

  const issueNodes = all
    .filter((element) => {
      const text = normalize(element.textContent)
      if (!text || text.length > 160) {
        return false
      }
      return issueKeywords.some((keyword) => text.toLowerCase().includes(keyword))
    })
    .slice(0, 200)
    .map((element) => toItem(element))

  const bodyText = normalize(document.body?.innerText).slice(0, 6000)
  const statusTexts = issueNodes
    .map((item) => item.text)
    .filter(Boolean)
    .slice(0, 50)

  return {
    panelCandidates,
    categoryNodes,
    actionNodes,
    issueNodes,
    bodySnippet: bodyText,
    statusTexts
  }
`)

const inspectVisibleState = async (page: Page): Promise<VisibleStateInspection> => page.evaluate(inspectVisibleStateEval as never, {
  issueKeywords: ISSUE_KEYWORDS,
  categoryClassPattern: CATEGORY_CLASS_PATTERN.source,
  actionTextPattern: ACTION_TEXT_PATTERN.source,
  panelClassPattern: PANEL_CLASS_PATTERN.source
}) as Promise<VisibleStateInspection>

const main = async () => {
  const targetUrl = getArgValue("url") ?? "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453047896278"
  const profileDir = path.resolve(getArgValue("profile") ?? ".runtime/playwright/dianxiaomi-profile")
  const headed = parseBoolean(getArgValue("headed"), true)
  const keepOpen = parseBoolean(getArgValue("keep-open"), false)
  const artifactDir = path.resolve(
    getArgValue("screenshots") ?? `.runtime/image-check-inspection-${new Date().toISOString().replace(/[:.]/g, "-")}`
  )
  const selectorConfig = loadSelectorConfig(".runtime/dianxiaomi-selector-config.json")

  ensureDirectory(profileDir)
  ensureDirectory(artifactDir)

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: !headed,
    slowMo: headed ? 80 : 0,
    viewport: {
      width: 1440,
      height: 960
    }
  })

  try {
    let page = await acquirePage(context.pages(), targetUrl) ?? await context.newPage()
    page.setDefaultTimeout(20_000)

    if (!sameTarget(page.url(), targetUrl)) {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded"
      })
    }

    await waitForManualLoginIfNeeded(page)
    page = await acquirePage(context.pages(), targetUrl) ?? page
    if (!sameTarget(page.url(), targetUrl)) {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded"
      })
    }

    const targetSurface = await inspectDianxiaomiTargetSurface(page, selectorConfig)
    if (targetSurface.status !== "done") {
      await waitForPublishPage(page, selectorConfig, {
        targetUrl
      })
    }

    await page.waitForTimeout(2_000)

    const trigger = await findImageCheckTrigger(page)
    if (!trigger) {
      throw new Error("Could not find the Dianxiaomi image-check trigger on the current page.")
    }

    const beforeDialogs = await visibleDialogCount(page)
    const clickTargetText = normalizeText(await trigger.innerText().catch(() => ""))
    await trigger.scrollIntoViewIfNeeded().catch(() => undefined)
    await trigger.click({
      timeout: 5_000
    })
    await page.waitForTimeout(7_000)

    const afterDialogs = await visibleDialogCount(page)
    const inspected = await inspectVisibleState(page)
    const screenshotPath = path.join(artifactDir, "image-check-surface.png")
    await page.screenshot({
      path: screenshotPath,
      fullPage: true
    })

    const payload: InspectionPayload = {
      createdAt: new Date().toISOString(),
      targetUrl,
      pageUrl: page.url(),
      pageTitle: await page.title().catch(() => ""),
      clicked: true,
      clickTargetText: clickTargetText || null,
      signals: {
        beforeDialogs,
        afterDialogs,
        bodySnippet: inspected.bodySnippet,
        statusTexts: inspected.statusTexts
      },
      panelInfo: {
        panelCandidates: inspected.panelCandidates,
        categoryNodes: inspected.categoryNodes,
        actionNodes: inspected.actionNodes,
        issueNodes: inspected.issueNodes
      },
      screenshotPath
    }

    const outputPath = path.join(artifactDir, "image-check-inspection.json")
    writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8")
    console.log(`Image-check inspection: ${outputPath}`)
    console.log(`Screenshot: ${screenshotPath}`)
  } finally {
    if (!headed || !keepOpen) {
      await context.close().catch(() => {})
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
