import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { chromium, type BrowserContext, type Page } from "playwright"
import type { DianxiaomiRepairPreviewFile } from "@temu-ai-ops/shared"
import {
  ensureDirectory,
  getOptions,
  loadTask,
  unattendedFullPageScreenshots,
  waitForManualLoginIfNeeded,
  type RunnerOptions
} from "./common"
import {
  type AutomationStepResult,
  applyRepairPlan,
  fillDraft,
  normalizeDescriptionImageModules,
  fillSkuImageLinks,
  inspectRepairPlanPreview,
  inspectPublishSurface,
  planMediaProcessing,
  saveOrSubmit,
  waitForPublishPage
} from "./adapters/dianxiaomi-adapter"
import { loadSelectorConfig } from "./selector-config"

const captureArtifacts = async (page: Page, screenshotDir: string, name: string) => {
  ensureDirectory(screenshotDir)
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const screenshotPath = path.join(screenshotDir, `${name}-${timestamp}.png`)
  await page.screenshot({
    path: screenshotPath,
    fullPage: unattendedFullPageScreenshots()
  })
  console.log(`Saved screenshot: ${screenshotPath}`)
  return screenshotPath
}

type ExecutionReport = {
  id: string
  taskId: string
  taskTitle: string
  platform: string
  pageUrl: string
  pageTitle: string
  status: "completed" | "partial" | "failed"
  createdAt: string
  screenshotPath: string
  steps: AutomationStepResult[]
}

const NON_BLOCKING_FAILURE_STEPS = new Set([
  "media-processing-plan",
  // Deleting an invalid description image module is best-effort cosmetic cleanup
  // of the description body; it is not a Dianxiaomi save precondition (the hard
  // gate is the SKU "每色3图" variant images). A failure here must not drop the
  // fill report to "partial" and stop the full-flow from reaching save-draft.
  "normalize-description-image-modules"
])

const getReportStatus = (steps: AutomationStepResult[]): ExecutionReport["status"] => {
  const failedCount = steps.filter((step) =>
    step.status === "failed" && !NON_BLOCKING_FAILURE_STEPS.has(step.id)
  ).length
  const doneCount = steps.filter((step) => step.status === "done").length

  if (failedCount === 0 && doneCount > 0) {
    return "completed"
  }

  if (doneCount > 0) {
    return "partial"
  }

  return "failed"
}

const saveExecutionReport = (options: RunnerOptions, report: ExecutionReport) => {
  ensureDirectory(options.screenshotDir)
  const reportPath = path.join(options.screenshotDir, `${report.id}.json`)
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8")
  console.log(`Saved execution report: ${reportPath}`)
  return reportPath
}

const loadRepairPreviewFile = (repairPlanFile: string): DianxiaomiRepairPreviewFile => {
  const absolutePath = path.isAbsolute(repairPlanFile) ? repairPlanFile : path.resolve(repairPlanFile)
  if (!existsSync(absolutePath)) {
    throw new Error(`repair plan file does not exist: ${repairPlanFile}`)
  }

  const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as DianxiaomiRepairPreviewFile
  if (!parsed.workItemId || !parsed.repairPlan?.actions) {
    throw new Error(`repair plan file is invalid: ${repairPlanFile}`)
  }

  return parsed
}

const parsePageUrl = (value: string) => {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

const isDianxiaomiHost = (host: string) => /(^|\.)dianxiaomi\.(com|cn)$/i.test(host)

const isDianxiaomiHelpPage = (page: Page) => {
  const parts = parsePageUrl(page.url())
  return Boolean(parts) && /^help\./i.test(parts!.hostname) && isDianxiaomiHost(parts!.hostname)
}

const isRealDianxiaomiEditTargetUrl = (value: string) => {
  const parts = parsePageUrl(value)
  if (!parts || !isDianxiaomiHost(parts.hostname)) {
    return false
  }

  if (/^help\./i.test(parts.hostname)) {
    return false
  }

  const pathname = parts.pathname.toLowerCase()
  return pathname === "/web/poptemu/edit" || /\/(product|listing|goods|item)\/edit\b/i.test(parts.pathname)
}

const isNonHelpDianxiaomiUrl = (value: string) => {
  const parts = parsePageUrl(value)
  return Boolean(parts) && isDianxiaomiHost(parts!.hostname) && !/^help\./i.test(parts!.hostname)
}

const getDianxiaomiEditPageKey = (value: string) => {
  const parts = parsePageUrl(value)
  if (!parts || !isDianxiaomiHost(parts.hostname) || parts.pathname !== "/web/popTemu/edit") {
    return null
  }

  const itemId = parts.searchParams.get("id")?.trim()
  return itemId
    ? `${parts.hostname.toLowerCase()}${parts.pathname}?id=${itemId}`
    : `${parts.hostname.toLowerCase()}${parts.pathname}`
}

const isSameDianxiaomiEditPage = (left: string, right: string) => {
  const leftKey = getDianxiaomiEditPageKey(left)
  const rightKey = getDianxiaomiEditPageKey(right)

  if (leftKey && rightKey) {
    return leftKey === rightKey
  }

  return left === right
}

const rankAutomationPage = (page: Page, targetUrl: string) => {
  const url = page.url()

  if (!url || url === "about:blank") {
    return 5
  }

  if (isSameDianxiaomiEditPage(url, targetUrl)) {
    return 100
  }

  if (getDianxiaomiEditPageKey(url)) {
    return 80
  }

  if (isDianxiaomiHelpPage(page)) {
    return -10
  }

  const parts = parsePageUrl(url)
  if (parts && isDianxiaomiHost(parts.hostname)) {
    return 30
  }

  return 0
}

const closeIrrelevantHelpPages = async (context: BrowserContext, activePage: Page) => {
  for (const page of context.pages()) {
    if (page === activePage || page.isClosed() || !isDianxiaomiHelpPage(page)) {
      continue
    }

    await page.close().catch(() => {})
  }
}

const acquireAutomationPage = async (context: BrowserContext, targetUrl: string) => {
  const selected = context.pages()
    .filter((page) => !page.isClosed())
    .map((page) => ({
      page,
      score: rankAutomationPage(page, targetUrl)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.page

  const page = selected ?? await context.newPage()
  page.setDefaultTimeout(15_000)

  await closeIrrelevantHelpPages(context, page)

  const currentUrl = page.url()
  const canNavigateToTarget = isRealDianxiaomiEditTargetUrl(targetUrl)
  if (canNavigateToTarget && (!currentUrl || currentUrl === "about:blank" || !isSameDianxiaomiEditPage(currentUrl, targetUrl))) {
    console.log(`Opening target page: ${targetUrl}`)
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded"
    })
  } else if (!currentUrl || currentUrl === "about:blank") {
    console.log(`Opening local or fixture target page: ${targetUrl}`)
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded"
    }).catch(() => {})
  } else if (!canNavigateToTarget) {
    console.log(`Target URL is not a real Dianxiaomi edit page, reusing current browser page: ${targetUrl}`)
  } else {
    console.log(`Reusing existing product page: ${currentUrl}`)
  }

  await page.bringToFront().catch(() => {})
  return page
}

const safeCaptureArtifacts = async (page: Page, screenshotDir: string, name: string) => {
  try {
    return await captureArtifacts(page, screenshotDir, name)
  } catch (error) {
    console.warn(`Could not capture screenshot "${name}": ${error instanceof Error ? error.message : String(error)}`)
    return ""
  }
}

const runDianxiaomiFlow = async (context: BrowserContext, options: RunnerOptions) => {
  const task = await loadTask(options)
  const repairPreview = options.repairPlanFile ? loadRepairPreviewFile(options.repairPlanFile) : null
  const selectorConfig = loadSelectorConfig(options.selectorConfig)
  console.log(`Loaded task: ${task.id} - ${task.product.title}`)

  let page = await acquireAutomationPage(context, options.targetUrl)
  const steps: AutomationStepResult[] = []

  // P2-1: browser crash / disconnect detection. A chromium OOM or a killed
  // browser process otherwise surfaces as an opaque Playwright timeout much
  // later. We record the first crash signal here so the catch block can
  // label the failure as a browser crash instead of a generic timeout, and
  // so callers (queue daemon recovery classification) can route it to
  // browser-profile recovery rather than retrying blindly.
  let browserCrashReason: string | null = null
  const markBrowserCrash = (reason: string) => {
    if (!browserCrashReason) {
      browserCrashReason = reason
      console.warn(`Browser crash/disconnect detected: ${reason}`)
    }
  }
  context.on("close", () => markBrowserCrash("browser context closed unexpectedly (possible chromium crash or OOM)"))
  context.browser()?.on("disconnected", () => markBrowserCrash("browser process disconnected (possible chromium crash or OOM)"))
  page.on("crash", () => markBrowserCrash("page crashed (possible chromium tab OOM)"))

  try {
    await waitForManualLoginIfNeeded(page)
    // The Dianxiaomi login flow can replace the original page or bounce to a
    // help/workspace tab. Re-acquire the best live page before proceeding.
    page = await acquireAutomationPage(context, options.targetUrl)
    await waitForPublishPage(page, selectorConfig, {
      waitForManualNavigation: !options.dryRun,
      targetUrl: options.targetUrl
    })

    if (repairPreview) {
      if (options.repairMode === "apply") {
        steps.push(...await applyRepairPlan(page, task.draft, repairPreview.repairPlan, selectorConfig, options))
      } else {
        steps.push(...await inspectRepairPlanPreview(page, task.draft, repairPreview.repairPlan, selectorConfig))
      }
    } else if (options.dryRun) {
      steps.push(...await inspectPublishSurface(page, task.draft, selectorConfig, options))
    } else {
      if (!options.skipDraftFill) {
        steps.push(...await fillDraft(page, task.draft, task.product.images, selectorConfig, options))
      }
      const writeBlocked = steps.some((step) =>
        step.id.startsWith("write-blocked-")
        && step.status === "failed"
      )
      if (!writeBlocked) {
        if (options.submit && options.skipDraftFill) {
          if (task.product.images.length > 0) {
            steps.push(await fillSkuImageLinks(page, task.product.images))
            steps.push(await normalizeDescriptionImageModules(page, task.product.images))
          } else {
            // Page-reference work items carry no task images; the SKU images
            // were already recovered from edit.json and verified during the
            // fill/save stages. Re-running the strict replacement with an
            // empty list can only fail and poison the submit-stage report.
            steps.push({
              id: "fill-sku-image-links",
              label: "Fill SKU image links",
              status: "skipped",
              detail: "Task carries no product images; keeping the SKU images already applied during fill/save stages"
            })
            steps.push({
              id: "normalize-description-image-modules",
              label: "Normalize description image modules",
              status: "skipped",
              detail: "Task carries no product images"
            })
          }
        }
        if (
          options.submit
          && options.skipDraftFill
          && (options.mediaAutomationMode === "unattended-open" || options.mediaAutomationMode === "unattended-apply")
        ) {
          const mediaProcessingPlan = await planMediaProcessing(page, selectorConfig, options)
          steps.push(mediaProcessingPlan)
          console.log(`save-or-submit stage: media processing plan completed (${mediaProcessingPlan.status})`)
          if (options.mediaAutomationMode === "unattended-apply" && mediaProcessingPlan.status === "failed") {
            steps.push({
              id: "write-blocked-media-processing",
              label: "Write blocked",
              status: "failed",
              detail: "Submit was blocked because Dianxiaomi media processing did not complete in unattended mode",
              data: mediaProcessingPlan.data
            })
          }
        }
      }
      const mediaWriteBlocked = steps.some((step) =>
        step.id === "write-blocked-media-processing"
        && step.status === "failed"
      )
      if (!writeBlocked && !mediaWriteBlocked) {
        steps.push(await saveOrSubmit(page, options))
      }
    }

    const runKind = repairPreview
      ? options.repairMode === "apply" ? "repair-apply" : "repair-preview"
      : options.dryRun ? "dry-run" : "run"
    const screenshotPath = await safeCaptureArtifacts(
      page,
      options.screenshotDir,
      runKind === "repair-apply"
        ? "dianxiaomi-repair-apply"
        : runKind === "repair-preview"
          ? "dianxiaomi-repair-preview"
          : runKind === "dry-run"
            ? "dianxiaomi-dry-run"
            : "dianxiaomi-filled"
    )
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")

    saveExecutionReport(options, {
      id: `dianxiaomi-${runKind}-${timestamp}`,
      taskId: task.id,
      taskTitle: task.product.title,
      platform: options.platform,
      pageUrl: page.url(),
      pageTitle: await page.title().catch(() => ""),
      status: getReportStatus(steps),
      createdAt: new Date().toISOString(),
      screenshotPath,
      steps
    })
  } catch (error) {
    const screenshotPath = await safeCaptureArtifacts(page, options.screenshotDir, "dianxiaomi-error")
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    // P2-1: if a browser crash/disconnect was detected, prefer that as the
    // failure reason — the raw error is usually a downstream Playwright
    // timeout that hides the real cause.
    const rawMessage = error instanceof Error ? error.message : String(error)
    const message = browserCrashReason
      ? `${browserCrashReason}; underlying error: ${rawMessage}`
      : rawMessage

    steps.push({
      id: browserCrashReason ? "browser-crash" : "runtime-error",
      label: browserCrashReason ? "Browser crash" : "Runtime error",
      status: "failed",
      detail: message
    })

    saveExecutionReport(options, {
      id: `dianxiaomi-error-${timestamp}`,
      taskId: task.id,
      taskTitle: task.product.title,
      platform: options.platform,
      pageUrl: page.url(),
      pageTitle: await page.title().catch(() => ""),
      status: "failed",
      createdAt: new Date().toISOString(),
      screenshotPath,
      steps
    })

    throw error
  }
}

const main = async () => {
  const options = getOptions()
  ensureDirectory(options.profileDir)
  ensureDirectory(options.screenshotDir)

  if (options.platform !== "dianxiaomi") {
    throw new Error("This runner currently supports only Dianxiaomi.")
  }

  const context = await chromium.launchPersistentContext(options.profileDir, {
    headless: !options.headed,
    slowMo: options.slowMo,
    viewport: {
      width: 1440,
      height: 960
    }
  })

  try {
    await runDianxiaomiFlow(context, options)
  } finally {
    if (!options.headed || !options.keepOpen) {
      await context.close()
    } else {
      console.log("Headed mode keeps the browser open for inspection.")
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
