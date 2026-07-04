import { existsSync, mkdirSync, readFileSync } from "node:fs"
import type { Locator, Page } from "playwright"
import type { PublishTask } from "@temu-ai-ops/shared"

export type Platform = "dianxiaomi" | "temu"
export type MediaAutomationMode = "plan-only" | "unattended-open" | "unattended-apply"
export type RepairMode = "preview" | "apply"

export type RunnerOptions = {
  platform: Platform
  targetUrl: string
  taskApiUrl: string
  taskFile?: string
  repairPlanFile?: string
  profileDir: string
  headed: boolean
  keepOpen: boolean
  slowMo: number
  saveDraft: boolean
  submit: boolean
  review: boolean
  dryRun: boolean
  repairMode: RepairMode
  screenshotDir: string
  selectorConfig?: string
  mediaAutomationMode: MediaAutomationMode
  mediaAutomationTools: string[]
  skipDraftFill: boolean
  sampleMediaActions: boolean
  submitMaxAttempts: number
}

export const DEFAULT_DIANXIAOMI_URL = "https://www.dianxiaomi.com/"
export const DEFAULT_TEMU_URL = "https://seller.temu.com/"
export const DEFAULT_TASK_API_URL = "http://localhost:8787/tasks/active?requireApproved=true"
export const DEFAULT_SCREENSHOT_DIR = "output/playwright"
export const DEFAULT_UNATTENDED_MEDIA_AUTOMATION_TOOLS = ["image-translation", "batch-resize"]
export const EDITABLE_SELECTOR = "input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit']):not([type='file']):not([disabled]), textarea:not([disabled]), [contenteditable='true']"

export const ensureDirectory = (directory: string) => {
  mkdirSync(directory, {
    recursive: true
  })
}

export const normalizeText = (value: string | null | undefined) =>
  (value ?? "").replace(/\s+/g, " ").trim().toLowerCase()

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) {
    return fallback
  }

  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase())
}

// OOM mitigation (layer 1): fullPage screenshots of a several-hundred-SKU edit
// page can be tens of thousands of pixels tall and are the single largest
// per-capture memory spike in the render process. Default to viewport-only
// captures; calibration/debugging can opt back in with
// UNATTENDED_FULLPAGE_SCREENSHOTS=true. Evidence still preserved, just not a
// full-page bitmap. See docs/oom-mitigation-plan.md layer 1.
export const unattendedFullPageScreenshots = (): boolean =>
  parseBoolean(process.env.UNATTENDED_FULLPAGE_SCREENSHOTS, false)


const parseMediaAutomationMode = (value: string | undefined): MediaAutomationMode => {
  if (value === "unattended-open" || value === "unattended-apply") {
    return value
  }

  return "plan-only"
}

const parseRepairMode = (value: string | undefined): RepairMode => value === "apply" ? "apply" : "preview"

const parseStringList = (value: string | undefined) =>
  (value ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)

const resolveMediaAutomationTools = (mode: MediaAutomationMode, tools: string[]) => {
  if (tools.length > 0) {
    return tools
  }

  return mode === "unattended-apply" ? [...DEFAULT_UNATTENDED_MEDIA_AUTOMATION_TOOLS] : []
}

const parsePositiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.max(1, Math.min(10, Math.floor(parsed)))
}

export const getArgValue = (name: string) => {
  const prefix = `--${name}=`
  const matched = process.argv.find((item) => item.startsWith(prefix))
  return matched?.slice(prefix.length)
}

export const parsePlatform = (value: string | undefined): Platform => {
  if (value === "temu") {
    return "temu"
  }

  return "dianxiaomi"
}

export const getOptions = (): RunnerOptions => {
  const platform = parsePlatform(getArgValue("platform") ?? process.env.PLATFORM)
  const defaultUrl = platform === "dianxiaomi" ? DEFAULT_DIANXIAOMI_URL : DEFAULT_TEMU_URL
  const defaultProfileDir = `.runtime/playwright/${platform}-profile`
  const mediaAutomationMode = parseMediaAutomationMode(getArgValue("media-automation-mode") ?? process.env.MEDIA_AUTOMATION_MODE)
  const mediaAutomationTools = resolveMediaAutomationTools(
    mediaAutomationMode,
    parseStringList(getArgValue("media-automation-tools") ?? process.env.MEDIA_AUTOMATION_TOOLS)
  )

  return {
    platform,
    targetUrl: getArgValue("url") ?? process.env.TEMU_TARGET_URL ?? defaultUrl,
    taskApiUrl: getArgValue("task-api") ?? process.env.TEMU_TASK_API_URL ?? DEFAULT_TASK_API_URL,
    taskFile: getArgValue("task-file") ?? process.env.TEMU_TASK_FILE,
    repairPlanFile: getArgValue("repair-plan-file") ?? process.env.DIANXIAOMI_REPAIR_PLAN_FILE,
    profileDir: getArgValue("profile") ?? process.env.TEMU_PROFILE_DIR ?? defaultProfileDir,
    headed: parseBoolean(getArgValue("headed") ?? process.env.HEADED, true),
    keepOpen: parseBoolean(getArgValue("keep-open") ?? process.env.KEEP_OPEN, false),
    slowMo: Number(getArgValue("slow-mo") ?? process.env.SLOW_MO ?? 80),
    saveDraft: parseBoolean(getArgValue("save-draft") ?? process.env.SAVE_DRAFT, true),
    submit: parseBoolean(getArgValue("submit") ?? process.env.SUBMIT, false),
    review: parseBoolean(getArgValue("review") ?? process.env.REVIEW, false),
    dryRun: parseBoolean(getArgValue("dry-run") ?? process.env.DRY_RUN, false),
    repairMode: parseRepairMode(getArgValue("repair-mode") ?? process.env.DIANXIAOMI_REPAIR_MODE),
    screenshotDir: getArgValue("screenshots") ?? process.env.SCREENSHOT_DIR ?? DEFAULT_SCREENSHOT_DIR,
    selectorConfig: getArgValue("selector-config") ?? process.env.SELECTOR_CONFIG ?? ".runtime/dianxiaomi-selector-config.json",
    mediaAutomationMode,
    mediaAutomationTools,
    skipDraftFill: parseBoolean(getArgValue("skip-draft-fill") ?? process.env.SKIP_DRAFT_FILL, false),
    sampleMediaActions: parseBoolean(getArgValue("sample-media-actions") ?? process.env.SAMPLE_MEDIA_ACTIONS, false),
    submitMaxAttempts: parsePositiveInteger(getArgValue("submit-max-attempts") ?? process.env.SUBMIT_MAX_ATTEMPTS, 3)
  }
}

export const firstVisible = async (locators: Locator[]) => {
  for (const locator of locators) {
    const count = await locator.count()

    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index)
      if (await item.isVisible().catch(() => false)) {
        return item
      }
    }
  }

  return null
}

export const loadTaskFromFile = (taskFile: string): PublishTask => {
  if (!existsSync(taskFile)) {
    throw new Error(`任务文件不存在：${taskFile}`)
  }

  return JSON.parse(readFileSync(taskFile, "utf8")) as PublishTask
}

export const fetchActiveTask = async (taskApiUrl: string): Promise<PublishTask> => {
  const response = await fetch(taskApiUrl)

  if (!response.ok) {
    throw new Error(`读取任务失败：${response.status} ${response.statusText}`)
  }

  return response.json() as Promise<PublishTask>
}

export const loadTask = async (options: RunnerOptions) => {
  if (options.taskFile) {
    return loadTaskFromFile(options.taskFile)
  }

  return fetchActiveTask(options.taskApiUrl)
}

type ManualLoginSurfaceInspection = {
  shouldWaitForManualLogin: boolean
  reason: string
  currentUrl: string
}

const LOGIN_TEXT_HINTS = ["登录", "请登录", "login", "sign in", "验证码", "captcha"]
const LOGIN_ACTION_HINTS = ["登录", "立即登录", "去登录", "login", "log in", "sign in"]
const EDIT_SURFACE_HINTS = ["商品", "标题", "价格", "库存", "刊登", "sku", "price", "stock", "title", "publish"]
const inspectManualLoginSurfaceEval = new Function("input", `
  const normalize = (value) => (value ?? "").replace(/\\s+/g, " ").trim().toLowerCase()
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false
    }

    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
  }

  const titleText = normalize(document.title)
  const bodyText = normalize(document.body?.innerText)
  const combinedText = \`\${titleText} \${bodyText}\`.trim()
  const passwordInputVisible = Array.from(document.querySelectorAll("input[type='password']")).some((element) => isVisible(element))
  const captchaVisible = Array.from(
    document.querySelectorAll(
      "input[name*='captcha' i], input[id*='captcha' i], img[src*='captcha' i], iframe[src*='captcha' i], [class*='captcha' i], [id*='captcha' i]"
    )
  ).some((element) => isVisible(element))
  const loginKeywordDetected = input.loginTextHints.some((hint) => combinedText.includes(hint))
  const loginActionVisible = Array.from(
    document.querySelectorAll("button, a, [role='button'], input[type='submit'], input[type='button']")
  ).some((element) => {
    if (!isVisible(element)) {
      return false
    }

    const rawText = element instanceof HTMLInputElement ? element.value : element.textContent
    const text = normalize(rawText)
    return input.loginActionHints.some((hint) => text.includes(hint))
  })
  const pathname = window.location.pathname.toLowerCase()
  const search = window.location.search.toLowerCase()
  const host = window.location.hostname.toLowerCase()
  const likelyAuthUrl = /(?:^|\\/)(login|signin|sign-in|auth)(?:\\/|$)/i.test(pathname)
    || /(?:^|[?&])(login|signin)=/i.test(search)
  const likelyEditUrl = /\\/web\\/poptemu\\/edit\\b/i.test(pathname)
    || /\\/(product|listing|goods|item)\\/edit\\b/i.test(pathname)
  const visibleEditableCount = Array.from(document.querySelectorAll(input.editableSelector)).filter((element) => isVisible(element)).length
  const editSurfaceSignal = input.editSurfaceHints.some((hint) => combinedText.includes(hint))
  const helpHost = host.startsWith("help.")
  const shouldWaitForManualLogin = Boolean(
    passwordInputVisible
    || captchaVisible
    || likelyAuthUrl
    || ((loginKeywordDetected || loginActionVisible) && !likelyEditUrl && !editSurfaceSignal && visibleEditableCount < 3 && !helpHost)
  )
  const reasonParts = []
  if (passwordInputVisible) {
    reasonParts.push("password input visible")
  }
  if (captchaVisible) {
    reasonParts.push("captcha control visible")
  }
  if (likelyAuthUrl) {
    reasonParts.push(\`auth url: \${pathname}\${search}\`)
  }
  if (loginKeywordDetected) {
    reasonParts.push("login keywords detected")
  }
  if (loginActionVisible) {
    reasonParts.push("login action visible")
  }
  if (likelyEditUrl) {
    reasonParts.push("edit url detected")
  }
  if (editSurfaceSignal) {
    reasonParts.push("listing edit text detected")
  }
  if (visibleEditableCount >= 3) {
    reasonParts.push(\`editable fields visible: \${visibleEditableCount}\`)
  }
  if (helpHost) {
    reasonParts.push("help host")
  }

  return {
    shouldWaitForManualLogin,
    reason: reasonParts.join("; ") || "no login surface signals",
    currentUrl: window.location.href
  }
`)

export const inspectManualLoginSurface = async (page: Page): Promise<ManualLoginSurfaceInspection> =>
  page.evaluate(
    inspectManualLoginSurfaceEval as never,
    {
      loginTextHints: LOGIN_TEXT_HINTS.map((hint) => hint.toLowerCase()),
      loginActionHints: LOGIN_ACTION_HINTS.map((hint) => hint.toLowerCase()),
      editSurfaceHints: EDIT_SURFACE_HINTS.map((hint) => hint.toLowerCase()),
      editableSelector: EDITABLE_SELECTOR
    }
  )

export const waitForManualLoginIfNeeded = async (page: Page) => {
  let inspection = await inspectManualLoginSurface(page).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (/Target page, context or browser has been closed/i.test(message)) {
      return null
    }
    throw error
  })

  if (!inspection?.shouldWaitForManualLogin) {
    return
  }

  console.log(`检测到可能需要登录。请在打开的浏览器中手动完成登录，脚本会等待页面离开登录状态。当前页面：${inspection.currentUrl}`)
  const deadline = Date.now() + 5 * 60 * 1000

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (page.isClosed()) {
      console.warn("Login page was replaced during authentication; recovering on the current browser page.")
      return
    }

    inspection = await inspectManualLoginSurface(page).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (/Target page, context or browser has been closed/i.test(message)) {
        return null
      }
      throw error
    })

    if (!inspection) {
      console.warn("Login page was replaced during authentication; recovering on the current browser page.")
      return
    }

    if (!inspection.shouldWaitForManualLogin) {
      return
    }
  }

  throw new Error(`Timed out waiting for manual login to finish: ${inspection.reason}`)
}
