import fs from "node:fs"
import path from "node:path"
import { chromium, type Locator, type Page } from "playwright"

const SOURCE_PROFILE = path.resolve(".runtime/dianxiaomi-real-profile")
const EXECUTABLE_PATH = "C:/Program Files/Google/Chrome/Application/chrome.exe"
const TARGET_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453261437108"
const CATEGORY_PATH = ["服装、鞋靴和珠宝饰品", "女士时尚", "女装", "女装长裤"]

const artifactDir = path.resolve(
  `output/playwright/probe-public-category-fallback-${new Date().toISOString().replace(/[:.]/g, "-")}`
)

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()

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
  const profilePath = path.resolve(`.runtime/dxm-public-category-fallback-${Date.now()}`)
  fs.cpSync(SOURCE_PROFILE, profilePath, { recursive: true })
  removeCopiedLocks(profilePath)
  return profilePath
}

const collectColumnsSnapshot = async (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".categories-box")).map((box, columnIndex) => ({
      columnIndex,
      labels: Array.from(box.querySelectorAll(".categories-item-name"))
        .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 80)
    }))
  )

const findExactItemInColumn = async (column: Locator, label: string) => {
  const items = column.locator(".categories-item-name")
  const count = await items.count().catch(() => 0)
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index)
    const text = clean(await item.innerText().catch(() => ""))
    if (text === label) {
      return item
    }
  }
  return null
}

const clickExactItemInColumn = async (column: Locator, label: string) => {
  const item = await findExactItemInColumn(column, label)
  if (!item) {
    return false
  }
  await item.click({
    timeout: 10_000
  })
  return true
}

const clickExactItemInLastColumnWithScroll = async (page: Page, label: string) => {
  const attempts: Array<Record<string, unknown>> = []
  let previousTop = -1

  for (let step = 0; step < 20; step += 1) {
    const columnCount = await page.locator(".categories-box").count().catch(() => 0)
    if (columnCount < 1) {
      return {
        clicked: false,
        attempts
      }
    }

    const column = page.locator(".categories-box").nth(columnCount - 1)
    const visibleLabels = await column.locator(".categories-item-name").evaluateAll((nodes) =>
      nodes.map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 60)
    ).catch(() => [] as string[])

    attempts.push({
      step,
      visibleLabels
    })

    const item = await findExactItemInColumn(column, label)
    if (item) {
      await item.click({
        timeout: 10_000
      })
      return {
        clicked: true,
        attempts
      }
    }

    const scrollState = await column.evaluate((node) => {
      const element = node as HTMLElement
      const beforeTop = element.scrollTop
      const maxTop = Math.max(0, element.scrollHeight - element.clientHeight)
      const nextTop = Math.min(maxTop, beforeTop + Math.max(160, Math.floor(element.clientHeight * 0.8)))
      element.scrollTop = nextTop
      return {
        beforeTop,
        afterTop: element.scrollTop,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight
      }
    }).catch(() => null)

    attempts[attempts.length - 1]!.scrollState = scrollState

    if (!scrollState || scrollState.afterTop === previousTop || scrollState.afterTop === scrollState.beforeTop) {
      break
    }

    previousTop = scrollState.afterTop
    await page.waitForTimeout(350)
  }

  return {
    clicked: false,
    attempts
  }
}

const clickModalFooterButton = async (page: Page, label: string) => {
  const buttons = page.locator(".ant-modal-footer button")
  const count = await buttons.count().catch(() => 0)
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index)
    const text = clean(await button.innerText().catch(() => ""))
    if (text !== label) {
      continue
    }

    await button.click({
      timeout: 10_000
    })
    return true
  }
  return false
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

  const events: Array<Record<string, unknown>> = []

  try {
    const page = await context.newPage()
    page.on("request", (request) => {
      if (/popTemuCategory|popTemuProduct/i.test(request.url())) {
        events.push({
          type: "request",
          url: request.url(),
          method: request.method(),
          postData: request.postData() ?? ""
        })
      }
    })
    page.on("response", async (response) => {
      if (/popTemuCategory|popTemuProduct/i.test(response.url())) {
        let body = ""
        try {
          body = (await response.text()).slice(0, 4_000)
        } catch {
          body = ""
        }

        events.push({
          type: "response",
          url: response.url(),
          status: response.status(),
          body
        })
      }
    })

    await page.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    })
    await page.waitForTimeout(3_000)

    await page.getByRole("button", { name: "选择分类" }).click()
    await page.waitForTimeout(1_200)

    const clickedPath: string[] = []
    const snapshots: Array<Record<string, unknown>> = []

    for (let columnIndex = 0; columnIndex < CATEGORY_PATH.length - 1; columnIndex += 1) {
      const label = CATEGORY_PATH[columnIndex]!
      snapshots.push({
        step: label,
        columns: await collectColumnsSnapshot(page)
      })

      const column = page.locator(".categories-box").nth(columnIndex)
      const clicked = await clickExactItemInColumn(column, label)
      if (!clicked) {
        const outputPath = path.join(artifactDir, "result.json")
        fs.writeFileSync(outputPath, JSON.stringify({
          artifactDir,
          clickedPath,
          failedLabel: label,
          snapshots,
          events
        }, null, 2), "utf8")
        throw new Error(`category path label not found: ${label}`)
      }

      clickedPath.push(label)
      await page.waitForTimeout(900)
    }

    const lastLabel = CATEGORY_PATH[CATEGORY_PATH.length - 1]!
    const lastColumnResult = await clickExactItemInLastColumnWithScroll(page, lastLabel)
    snapshots.push({
      step: lastLabel,
      lastColumnResult
    })
    if (!lastColumnResult.clicked) {
      const outputPath = path.join(artifactDir, "result.json")
      fs.writeFileSync(outputPath, JSON.stringify({
        artifactDir,
        clickedPath,
        failedLabel: lastLabel,
        snapshots,
        events
      }, null, 2), "utf8")
      throw new Error(`category path label not found: ${lastLabel}`)
    }

    clickedPath.push(lastLabel)

    await page.screenshot({
      path: path.join(artifactDir, "01-after-path-clicks.png"),
      fullPage: true
    })

    const chose = await clickModalFooterButton(page, "选择")
    if (!chose) {
      const outputPath = path.join(artifactDir, "result.json")
      fs.writeFileSync(outputPath, JSON.stringify({
        artifactDir,
        clickedPath,
        failedLabel: "选择",
        snapshots,
        events
      }, null, 2), "utf8")
      throw new Error("modal choose button not found")
    }
    await page.waitForTimeout(3_000)

    await page.screenshot({
      path: path.join(artifactDir, "02-after-choose.png"),
      fullPage: true
    })

    const bodyText = clean(await page.locator("body").innerText().catch(() => ""))
    const productId = new URL(page.url()).searchParams.get("id")?.trim() ?? ""
    const editResponse = await context.request.get(`https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${productId}`)
    const editPayload = JSON.parse(await editResponse.text()) as {
      data?: {
        product?: Record<string, unknown>
      }
    }
    const product = editPayload.data?.product ?? {}
    const categoryFields: Record<string, unknown> = {}
    for (const key of Object.keys(product).filter((item) => /cat|category|cid|class|shopId|siteId|nodePath|fullCid/i.test(item)).sort()) {
      categoryFields[key] = product[key]
    }

    const categorySectionExcerpt =
      bodyText.includes("产品分类") && bodyText.includes("产品属性")
        ? bodyText.slice(bodyText.indexOf("产品分类"), bodyText.indexOf("产品属性"))
        : bodyText.slice(0, 800)

    const result = {
      artifactDir,
      clickedPath,
      snapshots,
      bodyHasMissingCategory: bodyText.includes("未选择分类"),
      categorySectionExcerpt,
      categoryFields,
      events
    }

    const outputPath = path.join(artifactDir, "result.json")
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8")
    console.log(outputPath)
  } finally {
    await context.close().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
