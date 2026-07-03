import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { DEFAULT_SCREENSHOT_DIR, ensureDirectory, getArgValue, normalizeText } from "./common"

type SnapshotField = {
  tagName: string
  type: string
  name: string
  placeholder: string
  ariaLabel: string
  valuePreview: string
  selectorHint: string
  labelText?: string
  columnHeaderText?: string
  contextText?: string
  nearbyText: string
}

type SnapshotButton = {
  text: string
  type: string
  ariaLabel?: string
  title?: string
  selectorHint: string
  nearbyText?: string
  dialogSelectorHint?: string
  dialogLabel?: string
  dialogText?: string
}

type SnapshotSkuRow = {
  rowText: string
  inputCount: number
}

type DianxiaomiSnapshot = {
  pageUrl: string
  pageTitle: string
  createdAt: string
  targetSurface?: {
    id: string
    status: "done" | "failed" | "skipped"
    detail: string
    data?: Record<string, unknown>
  }
  fields: SnapshotField[]
  buttons: SnapshotButton[]
  skuRows: SnapshotSkuRow[]
}

type Candidate = {
  selectorHint: string
  score: number
  text: string
}

const FIELD_KEYWORDS = {
  title: ["商品标题", "产品标题", "刊登标题", "平台标题", "标题", "title"],
  description: ["商品描述", "产品描述", "详情描述", "刊登描述", "描述", "description", "details"],
  price: ["申报价", "建议售价", "刊登价", "销售价", "售价", "价格", "price", "sale price"],
  stock: ["库存", "刊登库存", "可售库存", "数量", "stock", "quantity", "available"],
  attribute: ["产品属性", "商品属性", "平台属性", "规格", "变体", "属性", "attribute", "variation", "specification"]
} as const

const BUTTON_KEYWORDS = {
  save: ["保存草稿", "保存", "暂存", "save draft", "save"],
  submit: ["发布", "提交", "立即刊登", "submit", "publish"]
} as const

const scoreText = (text: string, keywords: readonly string[]) => {
  const normalized = normalizeText(text)
  return keywords.reduce((score, keyword) => {
    const normalizedKeyword = normalizeText(keyword)
    return score + (normalized.includes(normalizedKeyword) ? Math.max(normalizedKeyword.length, 1) : 0)
  }, 0)
}

const MEDIA_TOOL_KEYWORDS = {
  imageTranslation: ["图片翻译", "翻译图片", "image translation", "translate image", "translate"],
  whiteBackground: ["图片白底", "白底图", "白底", "white background", "remove background"],
  imageEditor: ["小秘美图", "美图", "图片编辑", "编辑图片", "批量编辑", "image editor", "edit image"],
  batchResize: ["批量改图片尺寸", "批量改大小", "改大小", "图片大小", "图片尺寸", "resize", "batch resize"],
  imageManagement: ["图片检测", "检测图片", "图片管理", "图片空间", "image management", "image space"]
} as const

const MEDIA_TOOL_ACTION_KEYWORDS = {
  apply: ["\u786e\u5b9a", "\u5e94\u7528", "\u4fdd\u5b58", "\u5f00\u59cb", "\u5b8c\u6210", "confirm", "apply", "save", "start", "use selected", "translate", "resize"],
  close: ["\u5173\u95ed", "\u8fd4\u56de", "\u53d6\u6d88", "\u5b8c\u6210", "close", "back", "return", "cancel", "done", "finish"]
} as const

const fieldSearchText = (field: SnapshotField) => [
  field.labelText ?? "",
  field.columnHeaderText ?? "",
  field.contextText ?? "",
  field.name,
  field.placeholder,
  field.ariaLabel,
  field.selectorHint,
  field.nearbyText,
  field.valuePreview
].join(" ")

const buttonSearchText = (button: SnapshotButton) => [
  button.text,
  button.type,
  button.ariaLabel ?? "",
  button.title ?? "",
  button.selectorHint,
  button.nearbyText ?? ""
].join(" ")

const buttonDirectSearchText = (button: SnapshotButton) => [
  button.text,
  button.type,
  button.ariaLabel ?? "",
  button.title ?? "",
  button.selectorHint
].join(" ")

const buttonDialogSearchText = (button: SnapshotButton) => [
  button.dialogLabel ?? "",
  button.dialogText ?? ""
].join(" ")

const topCandidates = <T extends { selectorHint: string }>(
  items: T[],
  keywords: readonly string[],
  getText: (item: T) => string
): Candidate[] =>
  items
    .map((item) => ({
      selectorHint: item.selectorHint,
      score: scoreText(getText(item), keywords),
      text: getText(item).replace(/\s+/g, " ").trim().slice(0, 180)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)

const topButtonCandidates = (
  buttons: SnapshotButton[],
  keywords: readonly string[]
): Candidate[] =>
  buttons
    .map((button) => {
      const directText = buttonDirectSearchText(button)
      const nearbyText = button.nearbyText ?? ""
      return {
        selectorHint: button.selectorHint,
        score: scoreText(directText, keywords) * 3 + scoreText(nearbyText, keywords),
        text: buttonSearchText(button).replace(/\s+/g, " ").trim().slice(0, 180)
      }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)

const topMediaActionCandidates = (
  buttons: SnapshotButton[],
  toolKeywords: readonly string[],
  actionKeywords: readonly string[]
): Candidate[] =>
  buttons
    .filter((button) => button.dialogSelectorHint)
    .map((button) => {
      const directText = buttonDirectSearchText(button)
      const dialogText = buttonDialogSearchText(button)
      return {
        selectorHint: button.selectorHint,
        score: scoreText(dialogText, toolKeywords) * 4 + scoreText(directText, actionKeywords) * 3,
        text: buttonSearchText(button).replace(/\s+/g, " ").trim().slice(0, 180)
      }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)

const findLatestSnapshotPath = (directory: string) => {
  if (!existsSync(directory)) {
    return null
  }

  const fileName = readdirSync(directory)
    .filter((file) => /^dianxiaomi-snapshot-.*\.json$/.test(file))
    .sort()
    .at(-1)

  return fileName ? path.join(directory, fileName) : null
}

const loadSnapshot = (snapshotPath: string): DianxiaomiSnapshot =>
  JSON.parse(readFileSync(snapshotPath, "utf8")) as DianxiaomiSnapshot

const diagnoseSnapshot = (snapshot: DianxiaomiSnapshot) => {
  const fields = Object.fromEntries(
    Object.entries(FIELD_KEYWORDS).map(([kind, keywords]) => {
      const candidates = topCandidates(snapshot.fields, keywords, fieldSearchText)
      const descriptionRecognizedAsPreview = kind === "description"
        && candidates.length === 0
        && Number((snapshot.targetSurface?.data?.fieldReadiness as Record<string, unknown> | undefined)?.description ?? 0) > 0

      return [
        kind,
        {
          ok: candidates.length > 0 || descriptionRecognizedAsPreview,
          candidates
        }
      ]
    })
  )

  const buttons = Object.fromEntries(
    Object.entries(BUTTON_KEYWORDS).map(([kind, keywords]) => [
      kind,
      {
        ok: topButtonCandidates(snapshot.buttons, keywords).length > 0,
        candidates: topButtonCandidates(snapshot.buttons, keywords)
      }
    ])
  )

  const mediaTools = Object.fromEntries(
    Object.entries(MEDIA_TOOL_KEYWORDS).map(([kind, keywords]) => [
      kind,
      {
        ok: topButtonCandidates(snapshot.buttons, keywords).length > 0,
        candidates: topButtonCandidates(snapshot.buttons, keywords)
      }
    ])
  )

  const mediaToolActions = Object.fromEntries(
    Object.entries(MEDIA_TOOL_ACTION_KEYWORDS).map(([action, actionKeywords]) => [
      action,
      Object.fromEntries(
        Object.entries(MEDIA_TOOL_KEYWORDS).map(([kind, toolKeywords]) => {
          const candidates = topMediaActionCandidates(snapshot.buttons, toolKeywords, actionKeywords)
          return [
            kind,
            {
              ok: candidates.length > 0,
              candidates
            }
          ]
        })
      )
    ])
  )

  const skuRows = {
    ok: snapshot.skuRows.length > 0,
    count: snapshot.skuRows.length,
    samples: snapshot.skuRows.slice(0, 5)
  }

  const targetSurfaceReady = snapshot.targetSurface?.data?.canInspect !== false && snapshot.targetSurface?.status !== "failed"
  const requiredOk = Boolean(
    targetSurfaceReady &&
    fields.title?.ok &&
    (fields.price?.ok || skuRows.ok) &&
    (fields.stock?.ok || skuRows.ok) &&
    buttons.save?.ok
  )

  return {
    pageUrl: snapshot.pageUrl,
    pageTitle: snapshot.pageTitle,
    createdAt: snapshot.createdAt,
    requiredOk,
    targetSurface: snapshot.targetSurface,
    summary: {
      fieldCount: snapshot.fields.length,
      buttonCount: snapshot.buttons.length,
      mediaToolCount: Object.values(mediaTools).filter((tool) => tool.ok).length,
      skuRowCount: snapshot.skuRows.length
    },
    fields,
    buttons,
    mediaTools,
    mediaToolActions,
    skuRows
  }
}

const main = () => {
  const screenshotDir = getArgValue("screenshots") ?? process.env.SCREENSHOT_DIR ?? DEFAULT_SCREENSHOT_DIR
  const snapshotPath = getArgValue("snapshot") ?? findLatestSnapshotPath(screenshotDir)

  if (!snapshotPath) {
    throw new Error(`No dianxiaomi snapshot found in ${screenshotDir}. Run npm run snapshot --workspace @temu-ai-ops/automation first.`)
  }

  const snapshot = loadSnapshot(snapshotPath)
  const diagnosis = diagnoseSnapshot(snapshot)
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const outputPath = path.join(screenshotDir, `dianxiaomi-diagnosis-${timestamp}.json`)
  ensureDirectory(screenshotDir)
  writeFileSync(outputPath, JSON.stringify(diagnosis, null, 2), "utf8")

  console.log(`Snapshot: ${snapshotPath}`)
  console.log(`Diagnosis: ${outputPath}`)
  console.log(`Target surface: ${diagnosis.targetSurface?.data?.surfaceStatus ?? "unknown"} / ${diagnosis.targetSurface?.status ?? "missing"}`)
  console.log(`Required fields ready: ${diagnosis.requiredOk ? "yes" : "no"}`)
  console.log(`Fields: ${Object.entries(diagnosis.fields).map(([kind, result]) => `${kind}=${result.ok ? "ok" : "missing"}`).join(", ")}`)
  console.log(`Buttons: ${Object.entries(diagnosis.buttons).map(([kind, result]) => `${kind}=${result.ok ? "ok" : "missing"}`).join(", ")}`)
  console.log(`Media tools: ${Object.entries(diagnosis.mediaTools).map(([kind, result]) => `${kind}=${result.ok ? "ok" : "missing"}`).join(", ")}`)
  console.log(`Media apply actions: ${Object.entries(diagnosis.mediaToolActions.apply).map(([kind, result]) => `${kind}=${result.ok ? "ok" : "missing"}`).join(", ")}`)
  console.log(`Media close actions: ${Object.entries(diagnosis.mediaToolActions.close).map(([kind, result]) => `${kind}=${result.ok ? "ok" : "missing"}`).join(", ")}`)
  console.log(`SKU rows: ${diagnosis.skuRows.count}`)
}

main()
