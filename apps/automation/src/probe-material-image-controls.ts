import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type Locator, type Page } from "playwright"

const DEFAULT_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453261437092"
const DEFAULT_PROFILE = ".runtime/dianxiaomi-real-profile"
const DEFAULT_SCREENSHOTS = "output/playwright/probe-material-image-controls"

type VisibleNode = {
  tag: string
  text: string
  className: string
  title: string | null
  role: string | null
  left: number
  top: number
  width: number
  height: number
}

type SurfaceSnapshot = {
  materialImage: {
    src: string | null
    naturalWidth: number
    naturalHeight: number
  } | null
  dialogs: VisibleNode[]
  dropdowns: VisibleNode[]
  menus: VisibleNode[]
  buttons: VisibleNode[]
  inputs: VisibleNode[]
  bodyText: string
}

type ProbeAttempt = {
  control: string
  found: boolean
  clicked: boolean
  before: SurfaceSnapshot
  after: SurfaceSnapshot
  screenshotPath: string
}

type ProbeResult = {
  url: string
  pageUrl: string
  pageTitle: string
  attempts: ProbeAttempt[]
}

const CONTROL_SELECTORS: Record<string, string> = {
  "material-action": ".material-img-module .icon-operate.filter-sortable",
  "material-refresh": ".material-img-module .attach-icons[title]",
  "material-image": ".material-img-module .img-out"
}

const getArgValue = (name: string) => {
  const prefix = `--${name}=`
  const direct = process.argv.find((arg) => arg.startsWith(prefix))
  if (direct) {
    return direct.slice(prefix.length)
  }

  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0) {
    return process.argv[index + 1]
  }

  return undefined
}

const normalizeText = (value: string | null | undefined) =>
  (value ?? "").replace(/\s+/g, " ").trim()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const isVisible = async (locator: Locator | null) =>
  locator ? locator.isVisible().catch(() => false) : false

const firstVisible = async (locators: Locator[]) => {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0)
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index)
      if (await item.isVisible().catch(() => false)) {
        return item
      }
    }
  }

  return null
}

const clickBestEffort = async (locator: Locator | null) => {
  if (!locator) {
    return false
  }

  await locator.scrollIntoViewIfNeeded().catch(() => undefined)

  try {
    await locator.click({
      timeout: 5_000
    })
    return true
  } catch {
    try {
      await locator.click({
        timeout: 5_000,
        force: true
      })
      return true
    } catch {
      return false
    }
  }
}

const screenshot = async (page: Page, artifactDir: string, fileName: string) => {
  const filePath = path.join(artifactDir, fileName)
  await page.screenshot({
    path: filePath,
    fullPage: true
  }).catch(() => undefined)
  return filePath
}

const collectVisibleNodes = async (page: Page, selector: string, limit = 30) =>
  page.locator(selector).evaluateAll((nodes, maxCount) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()
    const visible = (element: Element) => {
      if (!(element instanceof HTMLElement)) {
        return false
      }

      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
    }

    return nodes
      .filter((node) => visible(node))
      .slice(0, maxCount)
      .map((node) => {
        const element = node as HTMLElement
        const rect = element.getBoundingClientRect()
        return {
          tag: element.tagName.toLowerCase(),
          text: normalize(element.textContent).slice(0, 300),
          className: typeof element.className === "string" ? element.className.slice(0, 200) : "",
          title: element.getAttribute("title"),
          role: element.getAttribute("role"),
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      })
  }, limit).catch(() => [] as VisibleNode[])

const collectSnapshot = async (page: Page): Promise<SurfaceSnapshot> => {
  const materialImage = await page.locator(".material-img-module img").first().evaluate((node) => {
    const image = node as HTMLImageElement | null
    if (!image) {
      return null
    }

    return {
      src: image.currentSrc || image.src || null,
      naturalWidth: image.naturalWidth || 0,
      naturalHeight: image.naturalHeight || 0
    }
  }).catch(() => null)

  return {
    materialImage,
    dialogs: await collectVisibleNodes(page, ".ant-modal:visible, [role='dialog']:visible, .ant-drawer:visible", 10),
    dropdowns: await collectVisibleNodes(page, ".ant-dropdown:visible, .ant-popover:visible, .ant-tooltip:visible", 10),
    menus: await collectVisibleNodes(page, ".ant-dropdown-menu:visible .ant-dropdown-menu-item, [role='menu']:visible [role='menuitem']", 20),
    buttons: await collectVisibleNodes(page, "button:visible, a:visible, [role='button']:visible", 40),
    inputs: await collectVisibleNodes(page, "input:visible, textarea:visible", 20),
    bodyText: normalizeText(await page.locator("body").innerText().catch(() => "")).slice(0, 4000)
  }
}

const closeTransientLayers = async (page: Page) => {
  await page.keyboard.press("Escape").catch(() => undefined)
  await sleep(400)

  const closeButton = await firstVisible([
    page.locator(".ant-modal-close:visible"),
    page.locator(".ant-drawer-close:visible"),
    page.locator("button").filter({ hasText: /\u5173\u95ed|\u53d6\u6d88|close|cancel/i }),
    page.locator("a, [role='button']").filter({ hasText: /\u5173\u95ed|\u53d6\u6d88|close|cancel/i })
  ])

  if (await isVisible(closeButton)) {
    await clickBestEffort(closeButton)
    await sleep(500)
  }
}

const runAttempt = async (
  page: Page,
  artifactDir: string,
  control: string,
  selector: string
): Promise<ProbeAttempt> => {
  await closeTransientLayers(page)
  const locator = page.locator(selector).first()
  const found = await locator.count().catch(() => 0) > 0 && await locator.isVisible().catch(() => false)
  const before = await collectSnapshot(page)
  const clicked = found ? await clickBestEffort(locator) : false
  await sleep(1_500)
  const after = await collectSnapshot(page)
  const screenshotPath = await screenshot(page, artifactDir, `${control}.png`)

  await writeFile(
    path.join(artifactDir, `${control}.json`),
    JSON.stringify({
      control,
      selector,
      found,
      clicked,
      before,
      after,
      screenshotPath
    }, null, 2),
    "utf8"
  )

  return {
    control,
    found,
    clicked,
    before,
    after,
    screenshotPath
  }
}

const main = async () => {
  const url = getArgValue("url") ?? DEFAULT_URL
  const profileDir = path.resolve(getArgValue("profile") ?? DEFAULT_PROFILE)
  const artifactDir = path.resolve(getArgValue("screenshots") ?? DEFAULT_SCREENSHOTS)
  await mkdir(artifactDir, { recursive: true })

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: {
      width: 1440,
      height: 960
    }
  })

  try {
    const page = context.pages().find((item) => item.url().includes("/web/popTemu/edit?id=")) ?? await context.newPage()
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined)
    await page.waitForTimeout(4_000)

    const attempts: ProbeAttempt[] = []

    for (const [control, selector] of Object.entries(CONTROL_SELECTORS)) {
      attempts.push(await runAttempt(page, artifactDir, control, selector))
    }

    const result: ProbeResult = {
      url,
      pageUrl: page.url(),
      pageTitle: await page.title().catch(() => ""),
      attempts
    }

    await writeFile(
      path.join(artifactDir, "probe-result.json"),
      JSON.stringify(result, null, 2),
      "utf8"
    )
  } finally {
    await context.close().catch(() => undefined)
  }
}

main().catch(async (error) => {
  const artifactDir = path.resolve(getArgValue("screenshots") ?? DEFAULT_SCREENSHOTS)
  await mkdir(artifactDir, { recursive: true }).catch(() => undefined)
  await writeFile(
    path.join(artifactDir, "probe-result.json"),
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }, null, 2),
    "utf8"
  )
  process.exitCode = 1
})
