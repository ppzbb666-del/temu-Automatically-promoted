import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type Locator, type Page } from "playwright"

const DEFAULT_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453261437092"
const DEFAULT_PROFILE = ".runtime/playwright/dianxiaomi-profile-clone"
const DEFAULT_SCREENSHOTS = ".runtime/manual-probe-image-translation-result"

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

const isVisible = async (locator: Locator | null) => locator ? locator.isVisible().catch(() => false) : false

const firstVisible = async (locators: Locator[]) => {
  for (const locator of locators) {
    if (await locator.isVisible().catch(() => false)) {
      return locator
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
    await locator.click({ timeout: 5_000 })
    return true
  } catch {
    try {
      await locator.click({ timeout: 5_000, force: true })
      return true
    } catch {
      return false
    }
  }
}

const screenshot = async (page: Page, dir: string, fileName: string) => {
  const filePath = path.join(dir, fileName)
  await page.screenshot({
    path: filePath,
    fullPage: true
  }).catch(() => undefined)
  return filePath
}

const visibleDialogs = async (page: Page) => {
  const roots = page.locator(".ant-modal:visible, .ant-modal-wrap:visible")
  const count = await roots.count().catch(() => 0)
  const dialogs: Locator[] = []
  for (let index = 0; index < count; index += 1) {
    const locator = roots.nth(index)
    if (await locator.isVisible().catch(() => false)) {
      dialogs.push(locator)
    }
  }
  return dialogs
}

const getImageCheckDialog = async (page: Page) => {
  const dialogs = await visibleDialogs(page)
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index]
    const text = clean(await dialog.innerText().catch(() => ""))
    if (text.includes("图片检测") || text.includes("图片包含文字") || text.includes("产品图尺寸不合规")) {
      return dialog
    }
  }
  return null
}

const getTranslationDialog = async (page: Page) => {
  const dialogs = await visibleDialogs(page)
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index]
    const text = clean(await dialog.innerText().catch(() => ""))
    if (
      text.includes("图片翻译")
      || text.includes("保留原图")
      || text.includes("译图")
      || text.includes("手动调整")
      || text.includes("一键翻译")
    ) {
      return dialog
    }
  }
  return null
}

const waitForDialog = async (getter: () => Promise<Locator | null>, timeoutMs = 20_000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const dialog = await getter()
    if (dialog) {
      return dialog
    }
    await sleep(400)
  }
  return null
}

const writeHtml = async (locator: Locator, dir: string, fileName: string) => {
  const filePath = path.join(dir, fileName)
  const html = await locator.evaluate((node) => node.outerHTML).catch(() => "")
  await writeFile(filePath, html, "utf8")
  return filePath
}

const ensureCheckbox = async (root: Locator, text: string, checked: boolean) => {
  const label = root.locator("label").filter({ hasText: text }).first()
  if (!await isVisible(label)) {
    return null
  }
  const checkbox = label.locator("input[type='checkbox']").first()
  const before = await checkbox.isChecked().catch(() => false)
  if (before !== checked) {
    await clickBestEffort(label)
    await sleep(200)
  }
  return checkbox.isChecked().catch(() => before)
}

const main = async () => {
  const targetUrl = getArgValue("url") ?? DEFAULT_URL
  const profileDir = path.resolve(getArgValue("profile") ?? DEFAULT_PROFILE)
  const artifactDir = path.resolve(getArgValue("screenshots") ?? DEFAULT_SCREENSHOTS)
  await mkdir(artifactDir, { recursive: true })

  const result: Record<string, unknown> = {
    url: targetUrl,
    profileDir,
    steps: [] as Array<Record<string, unknown>>
  }

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: {
      width: 1440,
      height: 960
    }
  })

  try {
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined)
    await page.waitForTimeout(4_000)
    ;(result.steps as Array<Record<string, unknown>>).push({
      stage: "initial",
      screenshot: await screenshot(page, artifactDir, "00-initial.png")
    })

    const imageCheckButton = await firstVisible([
      page.getByRole("button", { name: /图片检测/ }),
      page.locator("button, a, [role='button']").filter({ hasText: "图片检测" }).first()
    ])
    ;(result.steps as Array<Record<string, unknown>>).push({
      stage: "click-image-check",
      clicked: await clickBestEffort(imageCheckButton)
    })

    const imageCheckDialog = await waitForDialog(() => getImageCheckDialog(page), 20_000)
    if (!imageCheckDialog) {
      throw new Error("image check dialog did not open")
    }

    await screenshot(page, artifactDir, "01-image-check-open.png")
    await writeHtml(imageCheckDialog, artifactDir, "01-image-check-open.html")

    const category = imageCheckDialog.locator(".img-test-items li").filter({ hasText: "图片包含文字" }).first()
    ;(result.steps as Array<Record<string, unknown>>).push({
      stage: "click-category",
      clicked: await clickBestEffort(category),
      text: clean(await category.innerText().catch(() => ""))
    })
    await page.waitForTimeout(1_000)

    const labels = imageCheckDialog.locator(".img-test-details-list label.image-checkbox")
    const labelCount = Math.min(await labels.count().catch(() => 0), 8)
    const checkedRows: Array<Record<string, unknown>> = []
    for (let index = 0; index < labelCount; index += 1) {
      const label = labels.nth(index)
      if (!await isVisible(label)) {
        continue
      }
      const checkbox = label.locator("input[type='checkbox']").first()
      const before = await checkbox.isChecked().catch(() => false)
      if (!before) {
        await checkbox.check({ force: true }).catch(async () => {
          await clickBestEffort(label)
        })
      }
      checkedRows.push({
        index,
        text: clean(await label.innerText().catch(() => "")),
        after: await checkbox.isChecked().catch(() => false)
      })
    }
    ;(result.steps as Array<Record<string, unknown>>).push({
      stage: "checked-rows",
      checkedRows
    })

    const batchButton = await firstVisible([
      imageCheckDialog.getByRole("button", { name: /批量操作/ }),
      imageCheckDialog.locator("button, a, [role='button']").filter({ hasText: "批量操作" }).first()
    ])
    await clickBestEffort(batchButton)
    await page.waitForTimeout(700)
    const translateMenu = await firstVisible([
      page.getByRole("menuitem", { name: /图片翻译/ }),
      page.locator(".ant-dropdown-menu-item, [role='menuitem']").filter({ hasText: "图片翻译" }).first()
    ])
    ;(result.steps as Array<Record<string, unknown>>).push({
      stage: "choose-translation",
      clicked: await clickBestEffort(translateMenu)
    })

    const translationDialog = await waitForDialog(() => getTranslationDialog(page), 15_000)
    if (!translationDialog) {
      throw new Error("translation dialog did not open")
    }

    await screenshot(page, artifactDir, "02-translation-dialog.png")
    await writeHtml(translationDialog, artifactDir, "02-translation-dialog.html")

    ;(result.steps as Array<Record<string, unknown>>).push({
      stage: "prepare-translation",
      selectAll: await ensureCheckbox(translationDialog, "选择全部", true),
      quickTranslate: await ensureCheckbox(translationDialog, "快速翻译", false),
      text: clean(await translationDialog.innerText().catch(() => ""))
    })

    const startTranslate = await firstVisible([
      translationDialog.getByRole("button", { name: /一键翻译|快速翻译|翻译/ }),
      translationDialog.locator("button, a, [role='button']").filter({ hasText: /一键翻译|快速翻译|翻译/ }).first()
    ])
    ;(result.steps as Array<Record<string, unknown>>).push({
      stage: "start-translation",
      clicked: await clickBestEffort(startTranslate)
    })
    await page.waitForTimeout(1_200)

    const direction = await firstVisible([
      page.getByRole("menuitem", { name: /中文.*英文/ }),
      page.locator(".ant-dropdown-menu-item, [role='menuitem']").filter({ hasText: /中文.*英文/ }).first()
    ])
    ;(result.steps as Array<Record<string, unknown>>).push({
      stage: "choose-direction",
      clicked: await clickBestEffort(direction),
      text: direction ? clean(await direction.innerText().catch(() => "")) : ""
    })

    const resultDialog = await waitForDialog(async () => {
      const dialog = await getTranslationDialog(page)
      if (!dialog) {
        return null
      }
      const text = clean(await dialog.innerText().catch(() => ""))
      return text.includes("保留原图") || text.includes("译图") || text.includes("手动调整")
        ? dialog
        : null
    }, 180_000)

    if (!resultDialog) {
      throw new Error("translation result dialog did not appear")
    }

    const resultText = clean(await resultDialog.innerText().catch(() => ""))
    const interactiveTexts = await resultDialog.locator("button, a, [role='button'], label, span, div")
      .evaluateAll((nodes) => nodes
        .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
        .filter((text) => Boolean(text) && text.length <= 40))
      .catch(() => [] as string[])

    ;(result.steps as Array<Record<string, unknown>>).push({
      stage: "translation-result-dialog",
      text: resultText,
      interactiveTexts
    })

    await screenshot(page, artifactDir, "03-translation-result-dialog.png")
    await writeHtml(resultDialog, artifactDir, "03-translation-result-dialog.html")
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    await writeFile(path.join(artifactDir, "probe-result.json"), JSON.stringify(result, null, 2), "utf8")
    await context.close().catch(() => undefined)
  }
}

main().catch(async (error) => {
  const artifactDir = path.resolve(getArgValue("screenshots") ?? DEFAULT_SCREENSHOTS)
  await mkdir(artifactDir, { recursive: true }).catch(() => undefined)
  await writeFile(path.join(artifactDir, "probe-result.json"), JSON.stringify({
    error: error instanceof Error ? error.message : String(error)
  }, null, 2), "utf8")
  process.exitCode = 1
})
