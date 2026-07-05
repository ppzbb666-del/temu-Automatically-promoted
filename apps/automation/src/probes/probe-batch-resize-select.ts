// Read-only diagnostic: the batch-resize apply fails with 请选择要更改尺寸的图片
// even though prepareBatchResizeDialog reports selectAllChecked:true. Hypothesis:
// switching to 自定义比例调整 / 1:1 / 图片宽 re-renders the dialog and clears the
// 选择全部 checkbox and/or the 变化至 value. This probe reproduces the prep
// sequence and re-reads (value input + select-all checked state) after EACH step
// so we see exactly what clears and when. Never clicks 生成JPG (no write).
// Usage: tsx src/probes/probe-batch-resize-select.ts [--url=...] [--profile=...]
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type Locator, type Page } from "playwright"
import { getArgValue, waitForManualLoginIfNeeded } from "../common"
import { inspectDianxiaomiTargetSurface, waitForPublishPage } from "../adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "../selector-config"

const DEFAULT_URL = "https://www.dianxiaomi.com/web/popTemu/edit?id=161406453047896984"
const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim()

const firstVisible = async (locators: Locator[]) => {
  for (const l of locators) {
    const c = Math.min(await l.count().catch(() => 0), 20)
    for (let i = 0; i < c; i += 1) { const it = l.nth(i); if (await it.isVisible().catch(() => false)) return it }
  }
  return null
}

const readState = async (dialog: Locator) => {
  // value input
  const valueInput = await firstVisible([
    dialog.locator("input[name='valueW']"),
    dialog.locator("input.ant-input"),
    dialog.locator("input[type='text']")
  ])
  const value = valueInput ? clean(await valueInput.inputValue().catch(() => "")) : "(no input)"
  // select-all checkbox state
  const selAllLabel = dialog.locator("label, .ant-checkbox-wrapper").filter({ hasText: /选择全部/ }).first()
  const selAllBox = selAllLabel.locator("input[type='checkbox']").first()
  const selAllChecked = (await selAllBox.count().catch(() => 0)) > 0
    ? await selAllBox.isChecked().catch(() => null)
    : "(no checkbox)"
  // selected count text (e.g. 已选中：N)
  const dtext = clean(await dialog.innerText().catch(() => ""))
  const selCount = dtext.match(/已选中[：:]\s*(\d+)/)?.[1] ?? dtext.match(/选中\s*(\d+)/)?.[1] ?? "?"
  const modeSel = clean(await dialog.locator(".ant-select").first().innerText().catch(() => ""))
  return { mode: modeSel, value, selAllChecked, selCountText: selCount }
}

const selectAntOptionByText = async (page: Page, select: Locator, optionRe: RegExp) => {
  await select.click().catch(() => undefined)
  await page.waitForTimeout(400)
  const opt = page.locator(".ant-select-dropdown:visible .ant-select-item-option, .ant-select-dropdown:visible li").filter({ hasText: optionRe }).first()
  if (await opt.isVisible().catch(() => false)) { await opt.click().catch(() => undefined); await page.waitForTimeout(500); return true }
  await page.keyboard.press("Escape").catch(() => undefined)
  return false
}

const main = async () => {
  const targetUrl = getArgValue("url") ?? DEFAULT_URL
  const profileDir = path.resolve(getArgValue("profile") ?? ".runtime/playwright/dianxiaomi-profile")
  const selectorConfig = loadSelectorConfig(getArgValue("selector-config") ?? ".runtime/dianxiaomi-selector-config.json")
  const artifactDir = path.resolve(getArgValue("artifact-dir") ?? `.runtime/probe-batch-resize-select-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  await mkdir(artifactDir, { recursive: true })

  const context = await chromium.launchPersistentContext(profileDir, { channel: "chromium", headless: true, viewport: { width: 1440, height: 960 } })
  const steps: Array<Record<string, unknown>> = []
  try {
    const page = context.pages().find((p) => !p.isClosed()) ?? await context.newPage()
    page.setDefaultTimeout(20_000)
    if (page.url() !== targetUrl) await page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined)
    await waitForManualLoginIfNeeded(page)
    await waitForPublishPage(page, selectorConfig, { targetUrl })
    await inspectDianxiaomiTargetSurface(page, selectorConfig)
    await page.waitForTimeout(3_000)

    // open 编辑图片 → 批量改图片尺寸
    const trigger = page.locator(".img-module a, .img-module button, .img-module .ant-dropdown-trigger").filter({ hasText: /编辑图片|crop/i }).first()
    await trigger.scrollIntoViewIfNeeded().catch(() => undefined)
    await trigger.click().catch(() => undefined)
    await page.waitForTimeout(800)
    const item = page.locator(".ant-dropdown li, .ant-dropdown-menu li, [class*='dropdown'] li").filter({ hasText: "批量改图片尺寸" }).first()
    await item.click().catch(() => undefined)
    await page.waitForTimeout(1600)
    const dialog = page.locator(".ant-modal-content:visible").last()

    steps.push({ step: "0-opened", ...(await readState(dialog)) })

    // Step A: tick select-all FIRST (before mode switch)
    const selAllLabelA = dialog.locator("label, .ant-checkbox-wrapper").filter({ hasText: /选择全部/ }).first()
    await selAllLabelA.click().catch(() => undefined); await page.waitForTimeout(500)
    steps.push({ step: "A-selectAll-first", ...(await readState(dialog)) })

    // Step B: switch mode to 自定义比例调整
    await selectAntOptionByText(page, dialog.locator(".ant-select").first(), /自定义比例/)
    steps.push({ step: "B-after-custom-mode", ...(await readState(dialog)) })

    // Step C: switch ratio select (保持原图比例) to 1:1
    const ratioSel = dialog.locator(".ant-select").filter({ has: page.locator(".ant-select-selection-item[title='保持原图比例']") }).first()
    const ratioTarget = (await ratioSel.count().catch(() => 0)) > 0 ? ratioSel : dialog.locator(".ant-select").nth(2)
    await selectAntOptionByText(page, ratioTarget, /1\s*[:：]\s*1/)
    steps.push({ step: "C-after-ratio-1to1", ...(await readState(dialog)) })

    // Step D: fill value 变化至 = 1785
    const valueInput = await firstVisible([dialog.locator("input[name='valueW']"), dialog.locator("input.ant-input"), dialog.locator("input[type='text']")])
    if (valueInput) { await valueInput.fill("1785").catch(() => undefined); await page.waitForTimeout(400) }
    steps.push({ step: "D-after-fill-value", ...(await readState(dialog)) })

    // Step E: re-tick select-all LAST (after all switches)
    await selAllLabelA.click().catch(() => undefined); await page.waitForTimeout(400)
    // if that unchecked it, click once more to ensure checked
    const box = selAllLabelA.locator("input[type='checkbox']").first()
    if ((await box.isChecked().catch(() => false)) === false) { await selAllLabelA.click().catch(() => undefined); await page.waitForTimeout(300) }
    steps.push({ step: "E-selectAll-last", ...(await readState(dialog)) })

    await page.screenshot({ path: path.join(artifactDir, "final.png") }).catch(() => undefined)
    // close without applying
    const close = await firstVisible([dialog.locator(".ant-modal-close"), page.getByText(/取消|关闭/).first()])
    if (close) await close.click().catch(() => undefined)

    await writeFile(path.join(artifactDir, "probe-batch-resize-select.json"), JSON.stringify({ createdAt: new Date().toISOString(), targetUrl, steps }, null, 2), "utf8")
    console.log(path.join(artifactDir, "probe-batch-resize-select.json"))
  } finally {
    await context.close().catch(() => undefined)
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : String(e)); process.exitCode = 1 })
