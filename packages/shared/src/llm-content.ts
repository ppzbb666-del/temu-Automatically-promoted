import type { ListingDraft, ProductCandidate } from "./types"
import { sanitizeMarketplaceEnglishText } from "./content"

/**
 * 真实大模型接入层。
 *
 * 设计约束（见 docs/content-generation.md 与 CLAUDE.md §8）：
 * - 未配置 `LLM_API_KEY` 时，行为必须与纯规则生成完全一致 —— 无人值守主流程
 *   不能因为"想接大模型但没配好"而中断。
 * - 任何网络/超时/解析/字段错误都必须优雅回退到传入的规则草稿，**绝不抛异常**。
 * - 零新依赖：用 Node 内置 `fetch` 直连 OpenAI 兼容的 `/chat/completions`，
 *   一套代码适配 DeepSeek / Qwen / OpenAI / 本地 vLLM 等。
 *
 * 只让模型接管 `listingTitle` / `sellingPoints` / `description` 三项文案；
 * 定价、SKU、attributes、categoryPath、searchKeywords 等仍由既有确定性逻辑决定。
 */

export type LlmConfig = {
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs: number
  /**
   * 采样温度。**默认 undefined = 不发送该字段** —— 较新的模型（如 claude-sonnet-5）
   * 会对 `temperature` 报 HTTP 400 "deprecated for this model"。文案生成不依赖它，
   * 需要时用 `LLM_TEMPERATURE` 显式开启（老的 OpenAI 兼容模型才需要）。
   */
  temperature?: number
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_MODEL = "gpt-4o-mini"
const DEFAULT_TIMEOUT_MS = 20000

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "")

/** 从环境变量读取配置；没有 `LLM_API_KEY` 返回 null（视为未启用）。 */
export const readLlmConfig = (): LlmConfig | null => {
  const apiKey = process.env.LLM_API_KEY?.trim()
  if (!apiKey) {
    return null
  }
  const parsedTimeout = Number(process.env.LLM_TIMEOUT_MS)
  const parsedTemperature = Number(process.env.LLM_TEMPERATURE)
  return {
    apiKey,
    baseUrl: trimTrailingSlash(process.env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL),
    model: process.env.LLM_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS,
    // 只有显式设置了 LLM_TEMPERATURE 才发送；否则不带该字段（兼容新模型）。
    temperature: Number.isFinite(parsedTemperature) ? parsedTemperature : undefined
  }
}

/** LLM 是否已配置（有可用 API key）。 */
export const isLlmConfigured = (): boolean => readLlmConfig() !== null

export type LlmDraftEnhancement = {
  draft: ListingDraft
  usedLlm: boolean
  fallbackReason?: string
}

const SYSTEM_PROMPT = [
  "You are an e-commerce copywriter producing Temu marketplace listing content in ENGLISH only.",
  "Rules you MUST follow:",
  "- Output valid JSON only, matching: {\"title\": string, \"sellingPoints\": string[], \"description\": string}.",
  "- title: <= 120 characters, concise, keyword-rich, no ALL-CAPS shouting.",
  "- sellingPoints: 3 to 4 short benefit bullets.",
  "- description: 2-4 sentences, factual and compliant.",
  "- Do NOT invent certifications, medical/health/sanitizing/antibacterial claims, superlatives you cannot prove, or any brand names (e.g. Nike, Apple, Disney).",
  "- Do NOT use Chinese characters; English only.",
  "- Base the copy strictly on the product data provided."
].join("\n")

const buildUserPrompt = (product: ProductCandidate, baseDraft: ListingDraft): string => {
  const skuNames = product.skus.map((sku) => sku.name).filter(Boolean)
  const payload = {
    title: product.title,
    category: product.category,
    attributes: product.attributes,
    skus: skuNames,
    estimatedWeightKg: product.estimatedWeightKg,
    ruleBasedTitle: baseDraft.listingTitle,
    ruleBasedKeywords: baseDraft.searchKeywords ?? []
  }
  return [
    "Product data (rewrite into compliant English marketplace copy):",
    JSON.stringify(payload, null, 2),
    "",
    "Return ONLY the JSON object described in the system prompt."
  ].join("\n")
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null } }>
}

const extractMessageContent = (data: unknown): string | null => {
  const response = data as ChatCompletionResponse
  const content = response.choices?.[0]?.message?.content
  return typeof content === "string" ? content : null
}

/**
 * 部分模型（或被 markdown 包裹时）返回 ```json ... ``` 或前后带解释文字，
 * 这里做最宽松的解析：先直接 parse，失败再抠出第一个 `{...}`。
 */
const parseLooseJson = (raw: string): unknown => {
  const trimmed = raw.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1))
    }
    throw new Error("no JSON object found in model output")
  }
}

type ParsedDraftCopy = {
  title: string
  sellingPoints: string[]
  description: string
}

const coerceDraftCopy = (parsed: unknown): ParsedDraftCopy => {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("model output is not an object")
  }
  const record = parsed as Record<string, unknown>
  const title = typeof record.title === "string" ? record.title.trim() : ""
  const description = typeof record.description === "string" ? record.description.trim() : ""
  const rawPoints = Array.isArray(record.sellingPoints) ? record.sellingPoints : []
  const sellingPoints = rawPoints
    .filter((point): point is string => typeof point === "string")
    .map((point) => point.trim())
    .filter(Boolean)

  if (!title) {
    throw new Error("model output missing title")
  }
  if (sellingPoints.length === 0) {
    throw new Error("model output missing sellingPoints")
  }
  if (!description) {
    throw new Error("model output missing description")
  }
  return { title, sellingPoints, description }
}

/**
 * 在已经建好的规则草稿之上，用大模型覆写文案三字段。
 * 未配置或任何失败都会原样回退 `baseDraft`，永不抛。
 */
export const enhanceListingDraftWithLlm = async (
  product: ProductCandidate,
  baseDraft: ListingDraft
): Promise<LlmDraftEnhancement> => {
  const config = readLlmConfig()
  if (!config) {
    return { draft: baseDraft, usedLlm: false }
  }

  try {
    const requestBody: Record<string, unknown> = {
      model: config.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(product, baseDraft) }
      ]
    }
    // 仅在显式配置时发送 temperature（新模型如 claude-sonnet-5 对它报 400）。
    if (config.temperature !== undefined) {
      requestBody.temperature = config.temperature
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(config.timeoutMs)
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      return {
        draft: baseDraft,
        usedLlm: false,
        fallbackReason: `LLM HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`
      }
    }

    const rawContent = extractMessageContent(await response.json())
    if (!rawContent) {
      return { draft: baseDraft, usedLlm: false, fallbackReason: "LLM returned empty content" }
    }

    const copy = coerceDraftCopy(parseLooseJson(rawContent))

    // 复用既有清洗/裁剪逻辑，保证与规则草稿相同的合规约束。
    const listingTitle = sanitizeMarketplaceEnglishText(copy.title).slice(0, 120)
    const description = sanitizeMarketplaceEnglishText(copy.description)
    const sellingPoints = copy.sellingPoints
      .map((point) => sanitizeMarketplaceEnglishText(point))
      .filter(Boolean)
      .slice(0, 4)

    if (!listingTitle || !description || sellingPoints.length === 0) {
      return {
        draft: baseDraft,
        usedLlm: false,
        fallbackReason: "LLM output empty after sanitization"
      }
    }

    return {
      draft: {
        ...baseDraft,
        listingTitle,
        sellingPoints,
        description
      },
      usedLlm: true
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { draft: baseDraft, usedLlm: false, fallbackReason: `LLM call failed: ${reason}` }
  }
}
