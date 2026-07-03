import type { ProductCandidate } from "@temu-ai-ops/shared"
import { readSheet } from "read-excel-file/node"

type ExcelCell = string | number | boolean | Date | null
type CsvRow = Record<string, string>

export const CSV_IMPORT_TEMPLATE = `productId,title,category,supplierPriceCny,estimatedDomesticShippingCny,estimatedWeightKg,skuId,skuName,stock,attributes,sourceUrl,images
bag-001,便携收纳包,旅行收纳,12.9,1.6,0.22,bag-001-gray-m,灰色 M,100,颜色:灰色;尺码:M,https://detail.1688.com/example,https://images.example.com/bag-1.jpg
bag-001,便携收纳包,旅行收纳,13.6,1.6,0.24,bag-001-gray-l,灰色 L,80,颜色:灰色;尺码:L,https://detail.1688.com/example,https://images.example.com/bag-1.jpg`

const splitCsvLine = (line: string) => {
  const cells: string[] = []
  let current = ""
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]

    if (char === '"' && next === '"') {
      current += '"'
      index += 1
      continue
    }

    if (char === '"') {
      quoted = !quoted
      continue
    }

    if (char === "," && !quoted) {
      cells.push(current.trim())
      current = ""
      continue
    }

    current += char
  }

  cells.push(current.trim())
  return cells
}

const parseCsvRows = (csvText: string): CsvRow[] => {
  const lines = csvText
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const [headerLine, ...bodyLines] = lines
  if (!headerLine) {
    return []
  }

  const headers = splitCsvLine(headerLine).map((header) => header.trim())

  return bodyLines.map((line) => {
    const cells = splitCsvLine(line)
    return headers.reduce<CsvRow>((row, header, index) => {
      row[header] = cells[index] ?? ""
      return row
    }, {})
  })
}

const firstValue = (row: CsvRow, keys: string[]) => {
  for (const key of keys) {
    const value = row[key]
    if (value) {
      return value.trim()
    }
  }

  return ""
}

const toNumber = (value: string, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)

const parseAttributes = (value: string) => {
  if (!value) {
    return {}
  }

  return value.split(/[;；]/).reduce<Record<string, string>>((attributes, pair) => {
    const [key, ...rest] = pair.split(/[:：=]/)
    const normalizedKey = key?.trim()
    const normalizedValue = rest.join(":").trim()

    if (normalizedKey && normalizedValue) {
      attributes[normalizedKey] = normalizedValue
    }

    return attributes
  }, {})
}

export const parseProductsFromCsv = (csvText: string) => {
  const rows = parseCsvRows(csvText)
  const productMap = new Map<string, ProductCandidate>()
  const seenSkuIds = new Set<string>()
  const warnings: string[] = []
  let skippedRows = 0

  rows.forEach((row, index) => {
    const rowNumber = index + 2
    const title = firstValue(row, ["title", "商品标题", "产品标题", "名称"])
    if (!title) {
      skippedRows += 1
      warnings.push(`第 ${rowNumber} 行缺少商品标题，已跳过`)
      return
    }

    const productId = firstValue(row, ["productId", "商品ID", "产品ID"]) || `csv-${slugify(title)}`
    const skuName = firstValue(row, ["skuName", "SKU名称", "规格", "变体"]) || "默认规格"
    const skuId = firstValue(row, ["skuId", "SKUID", "SKU ID"]) || `${productId}-${slugify(skuName) || "default"}`
    const category = firstValue(row, ["category", "类目", "分类"]) || "未分类"
    const supplierPriceRaw = firstValue(row, ["supplierPriceCny", "成本价", "采购价", "供货价"])
    const stockRaw = firstValue(row, ["stock", "库存", "数量"])
    const supplierPriceCny = toNumber(supplierPriceRaw, 0)
    const shippingCny = toNumber(firstValue(row, ["estimatedDomesticShippingCny", "国内运费", "运费"]), 0)
    const weightKg = toNumber(firstValue(row, ["estimatedWeightKg", "重量kg", "重量"]), 0.2)
    const stock = Math.max(0, Math.floor(toNumber(stockRaw, 0)))
    const sourceUrl = firstValue(row, ["sourceUrl", "链接", "1688链接"])
    const images = firstValue(row, ["images", "图片", "图片链接"])
      .split(/[;；|]/)
      .map((item) => item.trim())
      .filter(Boolean)
    const attributes = {
      ...parseAttributes(firstValue(row, ["attributes", "属性"])),
      ...parseAttributes(firstValue(row, ["skuAttributes", "SKU属性"]))
    }

    if (!supplierPriceRaw || supplierPriceCny <= 0) {
      warnings.push(`第 ${rowNumber} 行 ${skuName} 缺少有效成本价，已按 0 处理`)
    }

    if (!stockRaw || stock <= 0) {
      warnings.push(`第 ${rowNumber} 行 ${skuName} 缺少有效库存，已按 0 处理`)
    }

    if (seenSkuIds.has(skuId)) {
      warnings.push(`第 ${rowNumber} 行 SKU ID 重复：${skuId}`)
    }
    seenSkuIds.add(skuId)

    const product = productMap.get(productId) ?? {
      id: productId,
      source: "csv",
      sourceUrl: sourceUrl || undefined,
      title,
      category,
      supplierPriceCny,
      estimatedDomesticShippingCny: shippingCny,
      estimatedWeightKg: weightKg,
      images,
      attributes,
      skus: []
    }

    product.skus.push({
      skuId,
      name: skuName,
      costCny: supplierPriceCny,
      stock,
      attributes
    })

    productMap.set(productId, product)
  })

  return {
    products: Array.from(productMap.values()),
    skippedRows,
    warnings
  }
}

const csvEscape = (value: unknown) => {
  const text = String(value ?? "")
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }

  return text
}

export const excelBufferToCsv = async (buffer: Buffer) => {
  const rows = await readSheet<ExcelCell>(buffer, 1)
  if (rows.length === 0) {
    throw new Error("Excel 文件没有可读取的工作表")
  }

  return rows
    .filter((row) => row.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== ""))
    .map((row) => row.map(csvEscape).join(","))
    .join("\n")
}
