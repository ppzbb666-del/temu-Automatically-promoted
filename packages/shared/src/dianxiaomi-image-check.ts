export type DianxiaomiImageCheckIssue = {
  category: string
  issue: string
  detail?: string
  count?: number
}

export type DianxiaomiImageCheckInspectionResult = {
  passed: boolean
  issues: DianxiaomiImageCheckIssue[]
  summary: string[]
  rawSummaryText: string
}

export type DianxiaomiImageCheckStartInput = Partial<{
  workItemId: string
  url: string
  headed: boolean
  profile: string
  screenshots: string
}>

export type DianxiaomiImageCheckStartResult = {
  id: string
  workItemId: string
  startedAt: string
  command: string
  cwd: string
  logPath: string
  errorLogPath: string
  artifactDir: string
  resultPath: string
}

export type DianxiaomiImageCheckJobStatus = "running" | "completed" | "failed"

export type DianxiaomiImageCheckJob = DianxiaomiImageCheckStartResult & {
  status: DianxiaomiImageCheckJobStatus
  finishedAt: string | null
  exitCode: number | null
  error: string | null
  result: DianxiaomiImageCheckInspectionResult | null
}

export type DianxiaomiImageCheckJobLog = {
  id: string
  logPath: string
  errorLogPath: string
  stdout: string
  stderr: string
  truncated: {
    stdout: boolean
    stderr: boolean
  }
}

const IMAGE_CHECK_CATEGORY_LABELS = [
  "轮播图",
  "产品图",
  "详情图",
  "主图",
  "sku图",
  "颜色图",
  "属性图",
  "素材图",
  "carousel",
  "product image",
  "detail image",
  "main image",
  "sku image",
  "color image"
]

const IMAGE_CHECK_ISSUE_LABELS = [
  "尺寸",
  "比例",
  "宽高",
  "非英文",
  "中文",
  "文字",
  "水印",
  "模糊",
  "像素",
  "大小",
  "格式",
  "过大",
  "失效",
  "size",
  "ratio",
  "aspect",
  "watermark",
  "english",
  "language",
  "resolution",
  "format"
]

const categoryCanonicalMap: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /素材图/i, value: "产品图" },
  { pattern: /轮播图|carousel/i, value: "轮播图" },
  { pattern: /产品图|product image/i, value: "产品图" },
  { pattern: /详情图|描述图|detail image/i, value: "详情图" },
  { pattern: /主图|main image/i, value: "主图" },
  { pattern: /sku图|sku image/i, value: "sku图" },
  { pattern: /颜色图|color image/i, value: "颜色图" },
  { pattern: /属性图/i, value: "属性图" }
]

const issueCanonicalMap: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /非英语|非英文|英文|中文|文字|language|english/i, value: "非英文" },
  { pattern: /水印|watermark/i, value: "水印" },
  { pattern: /尺寸|size/i, value: "尺寸" },
  { pattern: /比例|aspect|ratio/i, value: "比例" },
  { pattern: /宽高/i, value: "宽高" },
  { pattern: /模糊/i, value: "模糊" },
  { pattern: /像素|resolution/i, value: "像素" },
  { pattern: /大小|过大/i, value: "大小" },
  { pattern: /格式|format/i, value: "格式" },
  { pattern: /失效/i, value: "失效" }
]

const normalizeText = (value: string | null | undefined) =>
  (value ?? "").replace(/\s+/g, " ").trim()

const uniqueIssues = (issues: DianxiaomiImageCheckIssue[]) => {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.category.toLowerCase()}::${issue.issue.toLowerCase()}::${(issue.detail ?? "").toLowerCase()}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

const canonicalizeCategory = (value: string) =>
  categoryCanonicalMap.find((item) => item.pattern.test(value))?.value ?? value

const canonicalizeIssue = (value: string) =>
  issueCanonicalMap.find((item) => item.pattern.test(value))?.value ?? value

export const extractDianxiaomiImageCheckIssues = (message: string): DianxiaomiImageCheckIssue[] => {
  const text = normalizeText(message)
  if (!text) {
    return []
  }

  const issues: DianxiaomiImageCheckIssue[] = []
  const lines = text
    .split(/[\n\r]+|[;；]+/)
    .map((line) => normalizeText(line))
    .filter(Boolean)

  for (const line of lines) {
    const lower = line.toLowerCase()
    const category = IMAGE_CHECK_CATEGORY_LABELS.find((label) => lower.includes(label.toLowerCase()))
    const issue = IMAGE_CHECK_ISSUE_LABELS.find((label) => lower.includes(label.toLowerCase()))
    if (category && issue) {
      issues.push({
        category: canonicalizeCategory(category),
        issue: canonicalizeIssue(issue),
        detail: line.slice(0, 240)
      })
      continue
    }

    const categoryMatch = line.match(/(轮播图|产品图|详情图|描述图|主图|sku图|颜色图|属性图|素材图)/i)
    const issueMatch = line.match(/(尺寸|比例|宽高|非英文|非英语|中文|文字|水印|模糊|像素|大小|格式|过大|失效)/i)
    if (categoryMatch && issueMatch) {
      issues.push({
        category: canonicalizeCategory(categoryMatch[1]),
        issue: canonicalizeIssue(issueMatch[1]),
        detail: line.slice(0, 240)
      })
    }
  }

  return uniqueIssues(issues)
}

export const parseDianxiaomiImageCheckSummary = (text: string): DianxiaomiImageCheckIssue[] => {
  const normalized = normalizeText(text)
  if (!normalized) {
    return []
  }

  const matches = Array.from(
    normalized.matchAll(/(图片包含文字、水印|产品图尺寸不合规|详情图尺寸不合规|描述图尺寸不合规|图片过大|图片链接失效)\s*(\d+)/g)
  )

  const issues = matches
    .map((match) => {
      const label = normalizeText(match[1])
      const count = Number.parseInt(match[2] ?? "0", 10)
      if (!Number.isFinite(count) || count <= 0) {
        return null
      }

      if (label.includes("图片包含文字") || label.includes("水印")) {
        return {
          category: "产品图",
          issue: "非英文",
          detail: label,
          count
        } satisfies DianxiaomiImageCheckIssue
      }
      if (label.includes("产品图")) {
        return {
          category: "产品图",
          issue: "尺寸",
          detail: label,
          count
        } satisfies DianxiaomiImageCheckIssue
      }
      if (label.includes("详情图") || label.includes("描述图")) {
        return {
          category: "详情图",
          issue: "尺寸",
          detail: label,
          count
        } satisfies DianxiaomiImageCheckIssue
      }
      if (label.includes("过大")) {
        return {
          category: "产品图",
          issue: "大小",
          detail: label,
          count
        } satisfies DianxiaomiImageCheckIssue
      }
      if (label.includes("失效")) {
        return {
          category: "产品图",
          issue: "失效",
          detail: label,
          count
        } satisfies DianxiaomiImageCheckIssue
      }
      return null
    })
    .filter(Boolean) as DianxiaomiImageCheckIssue[]

  return uniqueIssues(issues)
}

export const summarizeDianxiaomiImageCheckIssues = (issues: DianxiaomiImageCheckIssue[]) =>
  uniqueIssues(issues).map((issue) => {
    const suffix = typeof issue.count === "number" && issue.count > 0 ? ` x${issue.count}` : ""
    return `${issue.category} ${issue.issue}${suffix}`
  })
