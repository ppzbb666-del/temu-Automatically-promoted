import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type Page } from "playwright"

const DEFAULT_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453261437092"
const DEFAULT_PROFILE = ".runtime/dianxiaomi-real-profile"
const DEFAULT_SCREENSHOTS = ".runtime/manual-probe-product-image-surface"

type ProbeNode = {
  tag: string
  text: string
  className: string
  left: number
  top: number
  width: number
  height: number
  parentText: string
}

type ProbeImage = {
  src: string
  width: number
  height: number
  naturalWidth: number
  naturalHeight: number
  top: number
  left: number
  parentText: string
}

type ProbeResult = {
  url: string
  pageUrl: string
  pageTitle: string
  screenshotPath: string
  controls: ProbeNode[]
  images: ProbeImage[]
  focusNodes: ProbeNode[]
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

const inspectSurfaceEval = new Function(String.raw`
  const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim()
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false
    }

    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
  }

  const controlKeywords = [
    "选择图片",
    "产品图",
    "轮播图",
    "预览图",
    "素材图",
    "从网络地址(url)选择图片",
    "网络地址(url)",
    "网络图片"
  ]

  const controls = Array.from(document.querySelectorAll("button, [role='button'], a, .ant-btn"))
    .filter((node) => visible(node))
    .map((node) => {
      const text = normalize(node.textContent)
      const parentText = normalize(node.parentElement?.textContent ?? "")
      const combined = text + " " + parentText
      if (!controlKeywords.some((keyword) => combined.includes(keyword))) {
        return null
      }

      const rect = node.getBoundingClientRect()
      return {
        tag: node.tagName.toLowerCase(),
        text: text.slice(0, 120),
        className: typeof node.className === "string" ? node.className.slice(0, 200) : "",
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        parentText: parentText.slice(0, 240)
      }
    })
    .filter(Boolean)
    .slice(0, 120)

  const images = Array.from(document.querySelectorAll("img"))
    .filter((node) => visible(node))
    .map((node) => {
      const img = node
      const rect = img.getBoundingClientRect()
      const parentText = normalize(img.parentElement?.parentElement?.textContent ?? img.parentElement?.textContent ?? "")
      if (!parentText.includes("图") && rect.top > 1400) {
        return null
      }

      return {
        src: (img.currentSrc || img.src || "").slice(0, 300),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        naturalWidth: img.naturalWidth || 0,
        naturalHeight: img.naturalHeight || 0,
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        parentText: parentText.slice(0, 240)
      }
    })
    .filter(Boolean)
    .slice(0, 160)

  const focusKeywords = [
    "autorenew",
    "1920 X 1920",
    "产品素材图",
    "素材图",
    "轮播图",
    "颜色图"
  ]

  const focusNodes = Array.from(document.querySelectorAll("body *"))
    .filter((node) => visible(node))
    .map((node) => {
      const text = normalize(node.textContent)
      if (!text || text.length > 300) {
        return null
      }

      if (!focusKeywords.some((keyword) => text.includes(keyword))) {
        return null
      }

      const rect = node.getBoundingClientRect()
      return {
        tag: node.tagName.toLowerCase(),
        text: text.slice(0, 200),
        className: typeof node.className === "string" ? node.className.slice(0, 200) : "",
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        parentText: normalize(node.parentElement?.textContent ?? "").slice(0, 240)
      }
    })
    .filter(Boolean)
    .slice(0, 120)

  return { controls, images, focusNodes }
`)

const screenshot = async (page: Page, artifactDir: string, fileName: string) => {
  const filePath = path.join(artifactDir, fileName)
  await page.screenshot({
    path: filePath,
    fullPage: true
  }).catch(() => undefined)
  return filePath
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

    const payload = await page.evaluate(inspectSurfaceEval as never) as {
      controls: ProbeNode[]
      images: ProbeImage[]
      focusNodes: ProbeNode[]
    }

    const screenshotPath = await screenshot(page, artifactDir, "product-image-surface.png")
    const result: ProbeResult = {
      url,
      pageUrl: page.url(),
      pageTitle: await page.title().catch(() => ""),
      screenshotPath,
      controls: payload.controls,
      images: payload.images,
      focusNodes: payload.focusNodes
    }

    await writeFile(
      path.join(artifactDir, "product-image-surface.json"),
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
    path.join(artifactDir, "product-image-surface-error.json"),
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }, null, 2),
    "utf8"
  )
  process.exitCode = 1
})
