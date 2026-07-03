import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type Locator, type Page } from "playwright"

const targetUrl = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453047896278"
const profileDir = path.resolve(".runtime/playwright/dianxiaomi-profile-clone")
const artifactDir = path.resolve(".runtime/manual-probe-image-check-save")

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type ProbeSample = {
  selector: string
  text: string
}

type ProbeResult = {
  page?: {
    url: string
    title: string
  }
  steps: Array<Record<string, unknown>>
  error?: string
}

const isVisible = async (locator: Locator) => locator.isVisible().catch(() => false)

const firstVisible = async (locators: Locator[]) => {
  for (const locator of locators) {
    if (await isVisible(locator)) {
      return locator
    }
  }

  return null
}

const clickByKeywords = async (root: Page | Locator, keywords: string[]) => {
  for (const keyword of keywords) {
    const pattern = new RegExp(keyword, "i")
    const locator = await firstVisible([
      root.getByRole("button", { name: pattern }),
      root.getByRole("menuitem", { name: pattern }),
      root.getByRole("link", { name: pattern }),
      root.locator("button, a, [role='button'], [role='menuitem']").filter({ hasText: pattern }).first(),
      root.locator(`[title*="${keyword}" i], [aria-label*="${keyword}" i]`).first()
    ])

    if (!locator) {
      continue
    }

    await locator.scrollIntoViewIfNeeded().catch(() => undefined)
    await locator.click({ timeout: 5_000 }).catch(async () => {
      await locator.click({ timeout: 5_000, force: true }).catch(() => undefined)
    })

    return {
      keyword,
      text: clean(await locator.innerText().catch(() => ""))
    }
  }

  return null
}

const screenshot = async (page: Page, fileName: string) => {
  const filePath = path.join(artifactDir, fileName)
  await page.screenshot({
    path: filePath,
    fullPage: true
  }).catch(() => undefined)
  return filePath
}

const waitForImageCheckDialog = async (page: Page, timeoutMs = 20_000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const dialog = page.locator(".img-test:visible").last()
    if (await isVisible(dialog)) {
      return dialog
    }
    await sleep(300)
  }

  return null
}

const collectSamples = async (page: Page): Promise<ProbeSample[]> => {
  const selectors = [
    ".ant-message",
    ".ant-notification",
    "[role='alert']",
    "[aria-live]",
    ".ant-modal:visible"
  ]
  const samples: ProbeSample[] = []

  for (const selector of selectors) {
    const locator = page.locator(selector)
    const count = Math.min(await locator.count().catch(() => 0), 6)
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index)
      if (!await isVisible(item)) {
        continue
      }
      const text = clean(await item.innerText().catch(() => ""))
      if (!text) {
        continue
      }
      samples.push({
        selector,
        text: text.slice(0, 400)
      })
    }
  }

  return samples
}

const summarizeImageCheck = async (dialog: Locator | null) => {
  if (!dialog) {
    return null
  }

  const categories = dialog.locator(".img-test-items li")
  const categoryCount = Math.min(await categories.count().catch(() => 0), 8)
  const categoryTexts: string[] = []
  for (let index = 0; index < categoryCount; index += 1) {
    const item = categories.nth(index)
    if (!await isVisible(item)) {
      continue
    }
    categoryTexts.push(clean(await item.innerText().catch(() => "")))
  }

  const cards = dialog.locator(".img-test-details-list .single-image, .img-test-details-list label.image-checkbox")
  const cardCount = Math.min(await cards.count().catch(() => 0), 12)
  const cardTexts: string[] = []
  for (let index = 0; index < cardCount; index += 1) {
    const item = cards.nth(index)
    if (!await isVisible(item)) {
      continue
    }
    cardTexts.push(clean(await item.innerText().catch(() => "")))
  }

  return {
    text: clean(await dialog.innerText().catch(() => "")).slice(0, 1000),
    categories: categoryTexts,
    cards: cardTexts
  }
}

const main = async () => {
  await mkdir(artifactDir, { recursive: true })

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: {
      width: 1440,
      height: 960
    }
  })

  const result: ProbeResult = {
    steps: []
  }

  try {
    const existing = context.pages().find((page) => page.url().includes("/web/popTemu/edit?id=161406453047896278"))
    const page = existing ?? await context.newPage()
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined)
    await page.waitForTimeout(3_000)

    result.page = {
      url: page.url(),
      title: await page.title().catch(() => "")
    }
    result.steps.push({
      stage: "initial",
      screenshot: await screenshot(page, "00-initial.png")
    })

    result.steps.push({
      stage: "click-image-check",
      click: await clickByKeywords(page, ["图片检测", "检测图片"]),
      screenshot: await screenshot(page, "01-after-click-image-check.png")
    })

    const imageCheckDialog = await waitForImageCheckDialog(page, 25_000)
    result.steps.push({
      stage: "image-check-open",
      opened: Boolean(imageCheckDialog),
      summary: await summarizeImageCheck(imageCheckDialog),
      samples: await collectSamples(page),
      screenshot: await screenshot(page, "02-image-check-open.png")
    })
    if (!imageCheckDialog) {
      throw new Error("image check dialog did not open")
    }

    const category = imageCheckDialog.locator(".img-test-items li").filter({ hasText: /图片包含文字|水印/i }).first()
    result.steps.push({
      stage: "select-category",
      visible: await isVisible(category),
      text: clean(await category.innerText().catch(() => ""))
    })
    if (await isVisible(category)) {
      await category.click({ timeout: 5_000 }).catch(async () => {
        await category.click({ timeout: 5_000, force: true }).catch(() => undefined)
      })
      await sleep(1_000)
    }

    const labels = imageCheckDialog.locator(".img-test-details-list label.image-checkbox")
    const labelCount = Math.min(await labels.count().catch(() => 0), 12)
    const selected: Array<Record<string, unknown>> = []
    for (let index = 0; index < labelCount; index += 1) {
      const label = labels.nth(index)
      if (!await isVisible(label)) {
        continue
      }
      const checkbox = label.locator("input[type='checkbox']").first()
      const checkedBefore = await checkbox.isChecked().catch(() => false)
      if (!checkedBefore) {
        await checkbox.check({ force: true }).catch(async () => {
          await label.click({ force: true }).catch(() => undefined)
        })
      }
      selected.push({
        text: clean(await label.innerText().catch(() => "")),
        checkedBefore,
        checkedAfter: await checkbox.isChecked().catch(() => false)
      })
    }
    result.steps.push({
      stage: "selected-images",
      selected,
      summary: await summarizeImageCheck(imageCheckDialog),
      screenshot: await screenshot(page, "03-selected-images.png")
    })

    result.steps.push({
      stage: "open-translation",
      batchClick: await clickByKeywords(imageCheckDialog, ["批量操作", "batch"]),
      screenshot: await screenshot(page, "04-after-click-batch.png")
    })
    await sleep(700)
    result.steps.push({
      stage: "choose-translation",
      menuClick: await clickByKeywords(page, ["图片翻译", "翻译图片"]),
      samples: await collectSamples(page),
      screenshot: await screenshot(page, "05-after-choose-translation.png")
    })

    let translationDialog: Locator | null = null
    const translationStartedAt = Date.now()
    while (Date.now() - translationStartedAt < 12_000) {
      const dialogs = page.locator(".ant-modal:visible")
      const count = Math.min(await dialogs.count().catch(() => 0), 12)
      for (let index = count - 1; index >= 0; index -= 1) {
        const dialog = dialogs.nth(index)
        const text = clean(await dialog.innerText().catch(() => ""))
        if (/图片翻译|选择全部|快速翻译|一键翻译|保留原图|手动调整/i.test(text)) {
          translationDialog = dialog
          break
        }
      }
      if (translationDialog) {
        break
      }
      await sleep(400)
    }

    result.steps.push({
      stage: "translation-dialog-open",
      opened: Boolean(translationDialog),
      text: translationDialog ? clean(await translationDialog.innerText().catch(() => "")).slice(0, 1000) : "",
      screenshot: await screenshot(page, "06-translation-dialog-open.png")
    })
    if (!translationDialog) {
      throw new Error("translation dialog did not open")
    }

    const selectAll = translationDialog.locator("label").filter({ hasText: /选择全部/i }).first()
    if (await isVisible(selectAll)) {
      const checkbox = selectAll.locator("input[type='checkbox']").first()
      const checked = await checkbox.isChecked().catch(() => false)
      if (!checked) {
        await selectAll.click({ force: true }).catch(() => undefined)
      }
    }
    const quickTranslate = translationDialog.locator("label").filter({ hasText: /快速翻译/i }).first()
    if (await isVisible(quickTranslate)) {
      const checkbox = quickTranslate.locator("input[type='checkbox']").first()
      const checked = await checkbox.isChecked().catch(() => false)
      if (checked) {
        await quickTranslate.click({ force: true }).catch(() => undefined)
      }
    }

    result.steps.push({
      stage: "trigger-translation-menu",
      click: await clickByKeywords(translationDialog, ["一键翻译", "快速翻译", "开始翻译", "确认"]),
      screenshot: await screenshot(page, "07-trigger-translation.png")
    })
    await sleep(800)

    result.steps.push({
      stage: "choose-translation-direction",
      click: await clickByKeywords(page, ["中文→英文", "中文 → 英文", "中文->英文", "中文 -> 英文", "中文到英文", "中译英"]),
      screenshot: await screenshot(page, "07b-choose-translation-direction.png")
    })

    let confirmation: Record<string, unknown> | null = null
    let resultDialogText = ""
    const resultStartedAt = Date.now()
    while (Date.now() - resultStartedAt < 120_000) {
      const dialogs = page.locator(".ant-modal:visible")
      const count = Math.min(await dialogs.count().catch(() => 0), 12)
      for (let index = count - 1; index >= 0; index -= 1) {
        const dialog = dialogs.nth(index)
        const text = clean(await dialog.innerText().catch(() => ""))
        if (/翻译完成|手动调整|保留原图|确认/i.test(text)) {
          resultDialogText = text.slice(0, 1000)
          const click = await clickByKeywords(dialog, ["确认", "完成", "使用", "应用", "保存"])
          if (click) {
            confirmation = click
          }
          break
        }
      }
      if (confirmation) {
        break
      }
      await sleep(1_000)
    }

    result.steps.push({
      stage: "translation-result",
      confirmation,
      resultDialogText,
      samples: await collectSamples(page),
      screenshot: await screenshot(page, "08-translation-result.png")
    })

    const imageCheckAfterTranslation = await waitForImageCheckDialog(page, 10_000)
    result.steps.push({
      stage: "back-to-image-check",
      opened: Boolean(imageCheckAfterTranslation),
      summary: await summarizeImageCheck(imageCheckAfterTranslation),
      samples: await collectSamples(page),
      screenshot: await screenshot(page, "09-back-to-image-check.png")
    })
    if (!imageCheckAfterTranslation) {
      throw new Error("image check dialog missing after translation")
    }

    result.steps.push({
      stage: "click-save",
      click: await clickByKeywords(imageCheckAfterTranslation, ["保存", "应用", "确认"]),
      screenshot: await screenshot(page, "10-click-save.png")
    })

    const saveObservations: Array<Record<string, unknown>> = []
    const saveStartedAt = Date.now()
    while (Date.now() - saveStartedAt < 15_000) {
      const currentDialog = await waitForImageCheckDialog(page, 500)
      saveObservations.push({
        elapsedMs: Date.now() - saveStartedAt,
        imageCheckOpen: Boolean(currentDialog),
        modalCount: await page.locator(".ant-modal:visible").count().catch(() => 0),
        samples: await collectSamples(page),
        summary: await summarizeImageCheck(currentDialog)
      })
      if (!currentDialog) {
        break
      }
      await sleep(1_000)
    }
    result.steps.push({
      stage: "after-save",
      observations: saveObservations,
      screenshot: await screenshot(page, "11-after-save.png")
    })
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    await writeFile(path.join(artifactDir, "probe-result.json"), JSON.stringify(result, null, 2), "utf8")
    await context.close().catch(() => undefined)
  }
}

main().catch(async (error) => {
  const result: ProbeResult = {
    steps: [],
    error: error instanceof Error ? error.message : String(error)
  }
  await mkdir(artifactDir, { recursive: true }).catch(() => undefined)
  await writeFile(path.join(artifactDir, "probe-result.json"), JSON.stringify(result, null, 2), "utf8")
  process.exitCode = 1
})
