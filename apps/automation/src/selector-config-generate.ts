import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { SelectorDiagnosisReport, SelectorMediaActionSamplingTool } from "@temu-ai-ops/shared"
import { DEFAULT_SCREENSHOT_DIR, ensureDirectory, getArgValue, parseBoolean } from "./common"
import type { DianxiaomiSelectorConfig } from "./selector-config"

const getRepoRoot = () => {
  // selector-config-generate.ts lives at apps/automation/src/; go up 3 levels.
  const currentFile = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(currentFile), "../../..")
}

const findLatestDiagnosisPath = (directory: string) => {
  if (!existsSync(directory)) {
    return null
  }

  const fileName = readdirSync(directory)
    .filter((file) => /^dianxiaomi-diagnosis-.*\.json$/.test(file))
    .sort()
    .at(-1)

  return fileName ? path.join(directory, fileName) : null
}

const firstSelector = (report: SelectorDiagnosisReport, group: "fields" | "buttons", key: string) =>
  report[group][key]?.candidates[0]?.selectorHint

const MEDIA_TOOL_KEYS = ["imageTranslation", "whiteBackground", "imageEditor", "batchResize", "imageManagement"] as const
type MediaToolKey = typeof MEDIA_TOOL_KEYS[number]

// P0-D: gate media-tool selectors by sampling status. For real Dianxiaomi
// diagnoses, a tool's entry selector is only emitted if its sampler reported
// either `sampled` (dialog-based apply path) or `instant-action-recognized`
// (instant apply path). Other statuses (missing-tool, no-dialog, etc.) leave
// the selector array empty so the runtime cannot accidentally click an
// unproven entry. For non-real diagnoses (fixture / smoke), the gate is
// bypassed and every candidate selector is emitted.
const diagnosisSurfaceStatus = (report: SelectorDiagnosisReport) =>
  String((report.targetSurface?.data as Record<string, unknown> | undefined)?.surfaceStatus ?? "unknown")

const isUsableRealDianxiaomiDiagnosis = (report: SelectorDiagnosisReport) => {
  const data = (report.targetSurface?.data as Record<string, unknown> | undefined) ?? {}
  return diagnosisSurfaceStatus(report) === "real-dianxiaomi"
    && data.isDianxiaomiHost === true
    && data.isDataFixture !== true
    && report.targetSurface?.status !== "failed"
    && data.canInspect !== false
}

const isSampledOrInstant = (
  tools: SelectorMediaActionSamplingTool[] | undefined,
  key: MediaToolKey
) => tools?.some((tool) =>
  tool.configKey === key
  && (tool.status === "sampled" || tool.status === "instant-action-recognized")
) ?? false

const mediaToolSelectorForConfig = (report: SelectorDiagnosisReport, key: MediaToolKey): string[] => {
  const selector = report.mediaTools?.[key]?.candidates[0]?.selectorHint
  if (!selector) {
    return []
  }
  if (!isUsableRealDianxiaomiDiagnosis(report)) {
    return [selector]
  }
  return isSampledOrInstant(report.mediaActionSampling?.tools, key) ? [selector] : []
}

const mediaToolActionSelectorForConfig = (
  report: SelectorDiagnosisReport,
  action: "apply" | "close",
  key: MediaToolKey
): string[] => {
  const selector = report.mediaToolActions?.[action]?.[key]?.candidates[0]?.selectorHint
  if (!selector) {
    return []
  }
  if (!isUsableRealDianxiaomiDiagnosis(report)) {
    return [selector]
  }
  // Instant-action tools have no dialog → no apply/close action selectors.
  if (isSampledOrInstant(report.mediaActionSampling?.tools, key) && key === "imageTranslation") {
    // image-translation: only allow apply/close selectors if a dialog was sampled.
    const sampled = report.mediaActionSampling?.tools?.some((tool) =>
      tool.configKey === key && tool.status === "sampled"
    )
    if (!sampled) {
      return []
    }
  }
  return isSampledOrInstant(report.mediaActionSampling?.tools, key) ? [selector] : []
}

const main = () => {
  const screenshotDir = getArgValue("screenshots") ?? process.env.SCREENSHOT_DIR ?? DEFAULT_SCREENSHOT_DIR
  const diagnosisPath = getArgValue("diagnosis") ?? findLatestDiagnosisPath(screenshotDir)
  const outputPath = getArgValue("output") ?? path.join(getRepoRoot(), ".runtime/dianxiaomi-selector-config.json")
  const requireRealDianxiaomi = parseBoolean(
    getArgValue("require-real-dianxiaomi") ?? process.env.REQUIRE_REAL_DIANXIAOMI,
    false
  )

  if (!diagnosisPath) {
    throw new Error(`No dianxiaomi diagnosis found in ${screenshotDir}. Run snapshot:diagnose first.`)
  }

  const report = JSON.parse(readFileSync(diagnosisPath, "utf8")) as SelectorDiagnosisReport
  if (requireRealDianxiaomi && !isUsableRealDianxiaomiDiagnosis(report)) {
    throw new Error(`Diagnosis is not a usable real Dianxiaomi listing edit page: ${diagnosisSurfaceStatus(report)}`)
  }
  const config: DianxiaomiSelectorConfig = {
    fields: {
      title: [firstSelector(report, "fields", "title")].filter(Boolean) as string[],
      description: [firstSelector(report, "fields", "description")].filter(Boolean) as string[],
      price: [firstSelector(report, "fields", "price")].filter(Boolean) as string[],
      stock: [firstSelector(report, "fields", "stock")].filter(Boolean) as string[],
      attribute: [firstSelector(report, "fields", "attribute")].filter(Boolean) as string[]
    },
    buttons: {
      save: [firstSelector(report, "buttons", "save")].filter(Boolean) as string[],
      submit: [firstSelector(report, "buttons", "submit")].filter(Boolean) as string[]
    },
    mediaTools: {
      imageTranslation: mediaToolSelectorForConfig(report, "imageTranslation"),
      whiteBackground: mediaToolSelectorForConfig(report, "whiteBackground"),
      imageEditor: mediaToolSelectorForConfig(report, "imageEditor"),
      batchResize: mediaToolSelectorForConfig(report, "batchResize"),
      imageManagement: mediaToolSelectorForConfig(report, "imageManagement")
    },
    mediaToolActions: {
      apply: {
        imageTranslation: mediaToolActionSelectorForConfig(report, "apply", "imageTranslation"),
        whiteBackground: mediaToolActionSelectorForConfig(report, "apply", "whiteBackground"),
        imageEditor: mediaToolActionSelectorForConfig(report, "apply", "imageEditor"),
        batchResize: mediaToolActionSelectorForConfig(report, "apply", "batchResize"),
        imageManagement: mediaToolActionSelectorForConfig(report, "apply", "imageManagement")
      },
      close: {
        imageTranslation: mediaToolActionSelectorForConfig(report, "close", "imageTranslation"),
        whiteBackground: mediaToolActionSelectorForConfig(report, "close", "whiteBackground"),
        imageEditor: mediaToolActionSelectorForConfig(report, "close", "imageEditor"),
        batchResize: mediaToolActionSelectorForConfig(report, "close", "batchResize"),
        imageManagement: mediaToolActionSelectorForConfig(report, "close", "imageManagement")
      }
    },
    skuRows: report.skuRows.ok ? ["tr, [role='row'], [class*='sku' i], [class*='table-row' i]"] : []
  }

  ensureDirectory(path.dirname(outputPath))
  writeFileSync(outputPath, JSON.stringify(config, null, 2), "utf8")

  console.log(`Diagnosis: ${diagnosisPath}`)
  console.log(`Selector config: ${outputPath}`)
  console.log(`Fields: ${Object.entries(config.fields ?? {}).map(([key, selectors]) => `${key}=${selectors?.length ? "ok" : "missing"}`).join(", ")}`)
  console.log(`Buttons: ${Object.entries(config.buttons ?? {}).map(([key, selectors]) => `${key}=${selectors?.length ? "ok" : "missing"}`).join(", ")}`)
  console.log(`Media tools: ${MEDIA_TOOL_KEYS.map((key) => {
    const status = report.mediaActionSampling?.tools.find((tool) => tool.configKey === key)?.status ?? "no-sampling"
    const emitted = config.mediaTools?.[key]?.length ? "ok" : "missing"
    return `${key}=${emitted} (${status})`
  }).join(", ")}`)
}

main()
