import { writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type Locator, type Page } from "playwright"
import { ensureDirectory, getArgValue, parseBoolean } from "./common"

const DEFAULT_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453261437092"
const DEFAULT_PROFILE = ".runtime/dianxiaomi-real-profile"
const COLOR_SECTION_SELECTOR = ".skuAttrItem_1001"
const COLOR_ROW_SELECTOR = ".batch-table-wrap.color-table tbody tr"
const REMAP_TEXT = "重新对应变种"

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()

const isVisible = async (locator: Locator) => locator.isVisible().catch(() => false)

const collectColorRowLabels = async (page: Page) => {
  const rows = page.locator(COLOR_ROW_SELECTOR)
  const count = Math.min(await rows.count().catch(() => 0), 120)
  const labels: string[] = []

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index)
    if (!await isVisible(row)) {
      continue
    }

    const label = clean(await row.locator("td[data-column-index='0']").first().innerText().catch(() => ""))
    if (label) {
      labels.push(label)
    }
  }

  return labels
}

const findCustomColorValueLabel = async (page: Page, labelText: string) => {
  const labels = page.locator(`${COLOR_SECTION_SELECTOR} label.d-checkbox.mr-8`)
  const optionIndex = await labels.evaluateAll((nodes, target) => {
    const cleanText = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()
    const isVisibleElement = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) {
        return false
      }

      const style = window.getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
    }

    return nodes.findIndex((node) => isVisibleElement(node) && cleanText((node as HTMLElement).innerText || node.textContent) === target)
  }, labelText).catch(() => -1)

  return optionIndex >= 0 ? labels.nth(optionIndex) : null
}

const findRemapTrigger = async (page: Page) => {
  const candidates = [
    page.getByRole("button", { name: new RegExp(REMAP_TEXT, "i") }),
    page.getByRole("link", { name: new RegExp(REMAP_TEXT, "i") }),
    page.locator("button, a, [role='button'], [role='link'], span.link").filter({
      hasText: new RegExp(REMAP_TEXT, "i")
    })
  ]

  for (const locator of candidates) {
    const count = Math.min(await locator.count().catch(() => 0), 10)
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index)
      if (await isVisible(item)) {
        return item
      }
    }
  }

  return null
}

const collectProbeStateEval = new Function("input", String.raw`
  const { colorSectionSelector, colorRowSelector, matchLabels, remapText } = input
  const cleanText = (value) => (value ?? "").replace(/\s+/g, " ").trim()
  const isVisibleElement = (node) => {
    if (!(node instanceof HTMLElement)) {
      return false
    }
    const style = window.getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
  }
  const elementPath = (node) => {
    const parts = []
    let current = node
    let depth = 0
    while (current && depth < 5) {
      const tag = current.tagName.toLowerCase()
      const cls = typeof current.className === "string"
        ? current.className.trim().split(/\s+/).slice(0, 2).join(".")
        : ""
      parts.push(cls ? tag + "." + cls : tag)
      current = current.parentElement
      depth += 1
    }
    return parts.join(" <- ")
  }
  const summarizeNode = (node) => ({
    tag: node.tagName.toLowerCase(),
    className: typeof node.className === "string" ? node.className : "",
    text: cleanText(node.innerText || node.textContent).slice(0, 240),
    title: cleanText(node.getAttribute("title")),
    role: cleanText(node.getAttribute("role")),
    ariaLabel: cleanText(node.getAttribute("aria-label")),
    path: elementPath(node)
  })
  const summarizeComponentChain = (node) => {
    const chain = []
    let current = node ? (node.__vueParentComponent ?? null) : null
    let depth = 0

    const summarizeEntries = (source) => {
      if (!source || typeof source !== "object") {
        return []
      }
      return Object.entries(source)
        .filter(([, value]) => Array.isArray(value) && value.length > 0 && value.length <= 200)
        .slice(0, 10)
        .map(([key, value]) => {
          const sample = value[0]
          return {
            key,
            length: value.length,
            sampleType: Array.isArray(sample) ? "array" : typeof sample,
            sampleKeys: sample && typeof sample === "object" && !Array.isArray(sample)
              ? Object.keys(sample).slice(0, 8)
              : []
          }
        })
    }

    while (current && depth < 6) {
      const typeObject = current.type && typeof current.type === "object" ? current.type : {}
      const setupState = current.setupState && typeof current.setupState === "object" ? current.setupState : {}
      const ctx = current.ctx && typeof current.ctx === "object" ? current.ctx : {}
      const methodKeys = Object.keys({ ...ctx, ...setupState })
        .filter((key) => /(remove|delete|variant|color|sku|attr|match|map|rebuild|reset)/i.test(key))
        .slice(0, 20)

      chain.push({
        depth,
        name: [cleanText(typeObject.name), cleanText(typeObject.__name)].filter(Boolean)[0] || "(anonymous)",
        ctxKeys: Object.keys(ctx).slice(0, 30),
        setupKeys: Object.keys(setupState).slice(0, 30),
        ctxArrays: summarizeEntries(ctx),
        setupArrays: summarizeEntries(setupState),
        methodKeys
      })

      current = current.parent
      depth += 1
    }

    return chain
  }

  const colorRows = Array.from(document.querySelectorAll(colorRowSelector))
    .filter((node) => isVisibleElement(node))
    .map((row, index) => {
      const cells = Array.from(row.querySelectorAll("td"))
      const labelCell = cells[0]
      const imageCell = cells[2]
      const deleteNodes = Array.from(row.querySelectorAll(".icon_delete, [class*='delete' i], [class*='remove' i]"))
        .filter((node) => isVisibleElement(node))
        .map((node) => summarizeNode(node))

      return {
        index,
        label: cleanText((labelCell && (labelCell.innerText || labelCell.textContent)) || ""),
        deleteNodeCount: deleteNodes.length,
        deleteNodes: deleteNodes.slice(0, 12),
        imageCount: imageCell ? imageCell.querySelectorAll("img").length : 0,
        rowText: cleanText(row.innerText).slice(0, 400),
        componentChain: summarizeComponentChain(row)
      }
    })

  const colorSection = document.querySelector(colorSectionSelector)
  const optionRoots = colorSection
    ? Array.from(colorSection.querySelectorAll("label, .sku-option, .d-checkbox, [role='checkbox'], input[type='checkbox']"))
    : []
  const optionStates = optionRoots
    .filter((node) => isVisibleElement(node))
    .map((node) => {
      const labelRoot = node.matches("label") ? node : node.closest("label") || node
      const input = labelRoot.querySelector("input[type='checkbox']")
      return {
        ...summarizeNode(labelRoot),
        checked: input ? input.checked : null,
        inputValue: cleanText(input ? input.value : ""),
        dataValue: cleanText(labelRoot.getAttribute("data-value")),
        parentClassName: typeof labelRoot.parentElement?.className === "string" ? labelRoot.parentElement.className : ""
      }
    })

  const colorLabelNodes = colorSection
    ? Array.from(colorSection.querySelectorAll("*"))
      .filter((node) => isVisibleElement(node))
      .map((node) => node)
      .filter((node) => {
        const text = cleanText(node.innerText || node.textContent)
        return text && text.length <= 40
      })
      .map((node) => summarizeNode(node))
    : []

  const visibleElements = Array.from(document.querySelectorAll("body *"))
    .filter((node) => isVisibleElement(node))

  const labelMatches = matchLabels.map((label) => ({
    label,
    matches: visibleElements
      .filter((node) => cleanText(node.innerText || node.textContent).includes(label))
      .slice(0, 20)
      .map((node) => summarizeNode(node))
  }))

  const remapCandidates = visibleElements
    .filter((node) => cleanText(node.innerText || node.textContent).includes(remapText))
    .slice(0, 20)
    .map((node) => summarizeNode(node))

  const dialogs = visibleElements
    .filter((node) => {
      const role = cleanText(node.getAttribute("role"))
      const className = typeof node.className === "string" ? node.className : ""
      return role === "dialog" || /modal|dialog|drawer/i.test(className)
    })
    .slice(0, 12)
    .map((node) => summarizeNode(node))

  const lastColorRow = document.querySelector(colorRowSelector + ":last-child")

    return {
      page: {
        url: location.href,
        title: document.title
      },
      colorRows,
      optionStates: optionStates.slice(0, 200),
      colorLabelNodes: colorLabelNodes.slice(0, 400),
      labelMatches,
      remapCandidates,
    dialogs,
    colorSectionText: cleanText(colorSection instanceof HTMLElement ? colorSection.innerText : "").slice(0, 3000),
    colorSectionComponentChain: summarizeComponentChain(colorSection),
    lastColorRowComponentChain: summarizeComponentChain(lastColorRow),
    bodySnippet: cleanText(document.body?.innerText).slice(0, 6000)
  }
`)

const collectProbeState = async (page: Page, matchLabels: string[]) => page.evaluate(
  collectProbeStateEval as never,
  {
    colorSectionSelector: COLOR_SECTION_SELECTOR,
    colorRowSelector: COLOR_ROW_SELECTOR,
    matchLabels,
    remapText: REMAP_TEXT
  }
)

const main = async () => {
  const targetUrl = getArgValue("url") ?? DEFAULT_URL
  const profileDir = path.resolve(getArgValue("profile") ?? DEFAULT_PROFILE)
  const headed = parseBoolean(getArgValue("headed"), true)
  const artifactDir = path.resolve(
    getArgValue("artifact-dir") ?? `output/playwright/probe-color-skc-${new Date().toISOString().replace(/[:.]/g, "-")}`
  )

  ensureDirectory(profileDir)
  ensureDirectory(artifactDir)

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: !headed,
    viewport: {
      width: 1440,
      height: 960
    }
  })

  try {
    const existing = context.pages().find((page) => page.url().includes("/web/popTemu/edit"))
    const page = existing ?? await context.newPage()
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded"
    }).catch(() => undefined)
    await page.waitForTimeout(5_000)
    await page.locator(COLOR_ROW_SELECTOR).first().waitFor({
      timeout: 20_000
    })

    const initialState = await collectProbeState(page, ["浅紫格", "浅蓝格", "闪星小狗"])
    await page.screenshot({
      path: path.join(artifactDir, "01-initial.png"),
      fullPage: true
    })

    const lastRow = page.locator(COLOR_ROW_SELECTOR).last()
    if (await isVisible(lastRow)) {
      await lastRow.hover().catch(() => undefined)
      await page.waitForTimeout(600)
    }

    const afterHoverState = await collectProbeState(page, ["浅紫格", "浅蓝格", "闪星小狗"])
    await page.screenshot({
      path: path.join(artifactDir, "02-after-hover.png"),
      fullPage: true
    })

    const remapTrigger = await findRemapTrigger(page)
    let remapAction: Record<string, unknown> | null = null
    let afterRemapState: unknown = null
    let trimExperiment: Record<string, unknown> | null = null

    if (remapTrigger) {
      remapAction = {
        text: clean(await remapTrigger.innerText().catch(() => "")),
        html: clean(await remapTrigger.evaluate((node) => (node as HTMLElement).outerHTML).catch(() => ""))
      }
      await remapTrigger.click().catch(async () => {
        await remapTrigger.click({
          force: true
        }).catch(() => undefined)
      })
      await page.waitForTimeout(1_500)
      afterRemapState = await collectProbeState(page, ["浅紫格", "浅蓝格", "闪星小狗"])
      await page.screenshot({
        path: path.join(artifactDir, "03-after-remap-click.png"),
        fullPage: true
      })
    }

    const beforeTrimLabels = await collectColorRowLabels(page)
    const targetTrimLabels = beforeTrimLabels.slice(-3)
    const toggleActions: Array<Record<string, unknown>> = []

    for (const labelText of targetTrimLabels) {
      const label = await findCustomColorValueLabel(page, labelText)
      if (!label) {
        toggleActions.push({
          labelText,
          found: false
        })
        continue
      }

      const checkbox = label.locator("input[type='checkbox']").first()
      const beforeChecked = await checkbox.isChecked().catch(() => null as boolean | null)
      if (beforeChecked !== false) {
        await checkbox.setChecked(false, {
          force: true
        }).catch(async () => {
          await label.click({
            force: true
          }).catch(() => undefined)
        })
      }
      await page.waitForTimeout(600)

      toggleActions.push({
        labelText,
        found: true,
        beforeChecked,
        afterChecked: await checkbox.isChecked().catch(() => null as boolean | null)
      })
    }

    const afterToggleLabels = await collectColorRowLabels(page)
    await page.screenshot({
      path: path.join(artifactDir, "04-after-custom-toggle.png"),
      fullPage: true
    })

    let remapAfterToggleClicked = false
    const remapAfterToggle = await findRemapTrigger(page)
    if (remapAfterToggle) {
      await remapAfterToggle.click().catch(async () => {
        await remapAfterToggle.click({
          force: true
        }).catch(() => undefined)
      })
      remapAfterToggleClicked = true
      await page.waitForTimeout(1_500)
    }

    const afterToggleRemapLabels = await collectColorRowLabels(page)
    await page.screenshot({
      path: path.join(artifactDir, "05-after-custom-toggle-remap.png"),
      fullPage: true
    })

    trimExperiment = {
      targetTrimLabels,
      toggleActions,
      beforeTrimLabels,
      afterToggleLabels,
      remapAfterToggleClicked,
      afterToggleRemapLabels
    }

    const payload = {
      createdAt: new Date().toISOString(),
      artifactDir,
      targetUrl,
      profileDir,
      initialState,
      afterHoverState,
      remapAction,
      afterRemapState,
      trimExperiment
    }

    const jsonPath = path.join(artifactDir, "probe-color-skc.json")
    await writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8")
    console.log(jsonPath)
  } finally {
    await context.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
