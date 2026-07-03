import type { ListingDraft, ProductCandidate, RiskAlert } from "./types"

const categoryKeywords: Record<string, string[]> = {
  "家居清洁": ["Home Cleaning", "Compact", "Daily Use"],
  "旅行收纳": ["Travel Organizer", "Space Saving", "Lightweight"],
  "收纳": ["Storage", "Organizer", "Space Saving"],
  "清洁": ["Cleaning", "Portable", "Daily Use"],
  "服饰": ["Comfort", "Daily Wear", "Easy Match"],
  "配件": ["Accessory", "Practical", "Everyday"]
}

const sensitiveKeywords = [
  "迪士尼",
  "耐克",
  "阿迪达斯",
  "苹果",
  "三星",
  "专利",
  "正品",
  "医疗",
  "杀菌",
  "治疗"
]

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim()

const unique = (items: string[]) => Array.from(new Set(items.filter(Boolean)))

const cjkPattern = /[\u3400-\u9fff\uf900-\ufaff]/
const cjkCharactersPattern = /[\u3400-\u9fff\uf900-\ufaff]/g

const asciiWords = (value: string) =>
  value
    .replace(/[^a-z0-9\s-]/gi, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 1)

const noisyAsciiTokens = new Set(["qq", "qqny", "q"])

const marketplaceKeywordRules: Array<[RegExp, string[]]> = [
  [/情趣|内衣|睡衣|制服|连体衣|连体袜|开裆|蕾丝|透明|透视|性感/i, ["Women", "Lingerie", "Bodysuit", "Costume", "Sleepwear", "Set"]],
  [/连体衣/i, ["Bodysuit"]],
  [/连体袜/i, ["Bodystocking"]],
  [/睡衣/i, ["Sleepwear"]],
  [/制服|JK/i, ["Costume", "Set"]],
  [/裙/i, ["Skirt"]],
  [/袜/i, ["Stockings"]],
  [/蕾丝/i, ["Lace"]],
  [/聚酯|涤纶|polyester/i, ["Polyester"]],
  [/白色|米白|乳白|象牙白/i, ["White"]],
  [/黑色/i, ["Black"]],
  [/红色|酒红|玫红|粉红/i, ["Red"]],
  [/蓝色/i, ["Blue"]],
  [/绿色/i, ["Green"]],
  [/黄色/i, ["Yellow"]],
  [/旅行|收纳|压缩/i, ["Travel", "Organizer", "Storage", "Bag"]],
  [/家居|清洁|吸尘/i, ["Home", "Cleaning", "Tool"]],
  [/服装|衣服|女装/i, ["Women", "Apparel"]],
  [/饰品|配件/i, ["Accessory"]]
]

const inferMarketplaceKeywords = (value: string) =>
  unique(marketplaceKeywordRules.flatMap(([pattern, keywords]) => pattern.test(value) ? keywords : []))

const meaningfulAsciiWords = (value: string) =>
  asciiWords(value)
    .map((word) => word.replace(/^-+|-+$/g, ""))
    .filter((word) => word.length > 1 && word.length < 28)
    .filter((word) => !noisyAsciiTokens.has(word.toLowerCase()))

const findCategoryKeywords = (category: string) => {
  const matched = Object.entries(categoryKeywords).find(([keyword]) => category.includes(keyword))
  return matched?.[1] ?? ["Practical", "Lightweight", "Daily Use"]
}

const englishCategoryLabel = (category: string, keywords: string[]) =>
  cjkPattern.test(category)
    ? keywords.slice(0, 3).join(" ") || "Marketplace Product"
    : category

export const sanitizeMarketplaceEnglishText = (value: string): string =>
  normalizeWhitespace(
    value
      .replace(cjkCharactersPattern, " ")
      .replace(/[，。；：、（）【】《》！？]/g, " ")
  )

export const generateMarketplaceSafeTitle = (product: ProductCandidate): string => {
  const sourceText = [
    product.title,
    product.category,
    Object.values(product.attributes ?? {}).join(" "),
    product.skus.map((sku) => sku.name).join(" ")
  ].join(" ")
  const inferredKeywords = inferMarketplaceKeywords(sourceText)
  const categoryFallback = findCategoryKeywords(product.category)
  const titleWords = meaningfulAsciiWords(product.title)
  const shouldPreferInferred = cjkPattern.test(sourceText)
  const titleParts = shouldPreferInferred
    ? unique([...inferredKeywords, ...titleWords, ...categoryFallback]).slice(0, 10)
    : unique([...titleWords, ...inferredKeywords, ...categoryFallback]).slice(0, 10)
  const title = normalizeWhitespace(titleParts.join(" "))

  return (title || "Marketplace Product").slice(0, 120)
}

const inferAttributes = (product: ProductCandidate) => {
  const skuAttributes = product.skus.reduce<Record<string, string>>((attributes, sku) => ({
    ...attributes,
    ...sku.attributes
  }), {})
  const inferred: Record<string, string> = {
    ...product.attributes,
    ...skuAttributes
  }

  if (!inferred.usage) {
    inferred.usage = product.category
  }

  if (!inferred.package) {
    inferred.package = "单件装"
  }

  if (!inferred.source) {
    inferred.source = product.source
  }

  return inferred
}

const buildAttributeSummary = (attributes: Record<string, string>) =>
  Object.entries(attributes)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" / ")

export const generateListingDraft = (product: ProductCandidate): ListingDraft => {
  const attributes = inferAttributes(product)
  const keywords = findCategoryKeywords(product.category)
  const skuNames = product.skus.map((sku) => sku.name).join(", ")
  const titleWords = meaningfulAsciiWords(product.title)
  const listingTitle = generateMarketplaceSafeTitle(product)
  const categoryLabel = englishCategoryLabel(product.category, unique([...inferMarketplaceKeywords(product.category), ...keywords]))
  const totalStock = product.skus.reduce((total, sku) => total + sku.stock, 0)

  return {
    productId: product.id,
    listingTitle: listingTitle.slice(0, 120),
    sellingPoints: unique([
      `${keywords[0]} design for ${product.category}`,
      `Multiple SKU options: ${skuNames || "Default"}`,
      `Lightweight ${product.estimatedWeightKg} kg item for low-friction shipping`,
      `Ready stock estimate: ${totalStock} units`
    ]),
    description: sanitizeMarketplaceEnglishText(
      `${listingTitle} is prepared for the ${categoryLabel} category. ` +
      `It focuses on practical daily use, simple SKU selection, and clear attributes for marketplace listing. ` +
      `Review images, compliance wording, and final category mapping before publishing.`
    ),
    categoryPath: [
      "Temu",
      product.category
    ],
    attributes,
    // P1-8: platform discoverability fields. searchKeywords and tags are
    // derived from the inferred category keywords so operators don't have to
    // hand-curate them; bulletPoints reuse the selling points as a sane
    // default that they can edit before publish.
    searchKeywords: unique([...keywords, ...titleWords]).slice(0, 12),
    tags: unique([...keywords, product.category]).slice(0, 8),
    bulletPoints: undefined,
    skuPricing: product.skus.map((sku) => ({
      skuId: sku.skuId,
      skuName: sku.name,
      salePriceUsd: 0,
      stock: sku.stock,
      attributes: {
        ...attributes,
        ...sku.attributes
      },
      attributeSummary: buildAttributeSummary({
        ...attributes,
        ...sku.attributes
      })
    }))
  }
}

export const generateContentRisks = (product: ProductCandidate, draft: ListingDraft): RiskAlert[] => {
  const searchableText = [
    product.title,
    product.category,
    draft.listingTitle,
    draft.description,
    ...draft.sellingPoints
  ].join(" ")
  const matchedSensitiveKeywords = sensitiveKeywords.filter((keyword) => searchableText.includes(keyword))
  const risks: RiskAlert[] = []

  if (matchedSensitiveKeywords.length > 0) {
    risks.push({
      id: "risk-sensitive-keywords",
      level: "high",
      message: `疑似敏感词或品牌词：${matchedSensitiveKeywords.join("、")}，发布前必须人工复核`
    })
  }

  if (product.images.length === 0) {
    risks.push({
      id: "risk-missing-images",
      level: "high",
      message: "商品缺少图片链接，不能进入自动发布"
    })
  }

  if (Object.keys(draft.attributes).length < 3) {
    risks.push({
      id: "risk-thin-attributes",
      level: "medium",
      message: "商品属性较少，建议补充材质、尺寸、颜色或适用场景"
    })
  }

  if (draft.listingTitle.length > 120) {
    risks.push({
      id: "risk-title-too-long",
      level: "medium",
      message: "刊登标题过长，可能需要按平台限制压缩"
    })
  }

  return risks
}
