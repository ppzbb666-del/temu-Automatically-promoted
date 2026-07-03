import type { ProductCandidate, PublishTask } from "./types"

const buildAttributeSummary = (attributes: Record<string, string>) =>
  Object.entries(attributes)
    .map(([, value]) => value)
    .join(" / ")

export const mockProducts: ProductCandidate[] = [
  {
    id: "prod-wireless-cleaner-01",
    source: "1688",
    sourceUrl: "https://detail.1688.com/mock-product",
    title: "无线便携桌面吸尘器",
    category: "家居清洁",
    supplierPriceCny: 18.5,
    estimatedDomesticShippingCny: 2.8,
    estimatedWeightKg: 0.36,
    images: [
      "https://images.example.com/cleaner-1.jpg",
      "https://images.example.com/cleaner-2.jpg"
    ],
    attributes: {
      color: "白色",
      power: "USB 充电"
    },
    skus: [
      {
        skuId: "sku-white",
        name: "白色标准款",
        costCny: 18.5,
        stock: 120,
        attributes: {
          color: "白色"
        }
      },
      {
        skuId: "sku-green",
        name: "绿色标准款",
        costCny: 19.3,
        stock: 96,
        attributes: {
          color: "绿色"
        }
      }
    ]
  },
  {
    id: "prod-storage-bag-02",
    source: "manual",
    title: "旅行衣物压缩收纳袋",
    category: "旅行收纳",
    supplierPriceCny: 12.9,
    estimatedDomesticShippingCny: 1.6,
    estimatedWeightKg: 0.22,
    images: [
      "https://images.example.com/bag-1.jpg"
    ],
    attributes: {
      material: "尼龙",
      usage: "旅行收纳"
    },
    skus: [
      {
        skuId: "sku-gray-m",
        name: "灰色 M 码",
        costCny: 12.9,
        stock: 260,
        attributes: {
          color: "灰色",
          size: "M"
        }
      },
      {
        skuId: "sku-gray-l",
        name: "灰色 L 码",
        costCny: 13.6,
        stock: 188,
        attributes: {
          color: "灰色",
          size: "L"
        }
      }
    ]
  }
]

export const createMockTask = (product: ProductCandidate): PublishTask => {
  const logisticsUsd = Number((product.estimatedWeightKg * 3.2).toFixed(2))
  const platformFeeUsd = 0.78
  const supplierCostUsd = Number(((product.supplierPriceCny + product.estimatedDomesticShippingCny) / 7.2).toFixed(2))
  const floorPriceUsd = Number((supplierCostUsd + logisticsUsd + platformFeeUsd).toFixed(2))
  const suggestedPriceUsd = Number((floorPriceUsd * 1.55).toFixed(2))

  return {
    id: `task-${product.id}`,
    product,
    pricing: {
      productId: product.id,
      suggestedPriceUsd,
      floorPriceUsd,
      targetMarginRate: 0.28,
      estimatedPlatformFeeUsd: platformFeeUsd,
      estimatedLogisticsUsd: logisticsUsd,
      rationale: [
        "基于供应价、国内运费和预估重量进行成本核算",
        "保留平台手续费与促销让利空间",
        "优先控制入门售价，提高点击和转化"
      ]
    },
    draft: {
      productId: product.id,
      listingTitle: `${product.title} Portable Home Helper for Daily Use`,
      sellingPoints: [
        "轻巧便携，适合日常收纳或清洁场景",
        "高频需求品类，适合低门槛快速上新",
        "多 SKU 启动，便于测试点击和转化"
      ],
      description: `这是一款面向 ${product.category} 场景的轻量商品，主打便携、易用和高频使用需求。`,
      categoryPath: [
        "Home & Kitchen",
        product.category
      ],
      attributes: product.attributes,
      skuPricing: product.skus.map((sku) => ({
        skuId: sku.skuId,
        skuName: sku.name,
        salePriceUsd: suggestedPriceUsd,
        stock: sku.stock,
        attributes: sku.attributes,
        attributeSummary: buildAttributeSummary(sku.attributes)
      }))
    },
    steps: [
      {
        id: "step-open-page",
        title: "打开 Temu 发布页",
        instruction: "检测当前页面是否为商品发布页面，如果不是则提示跳转",
        status: "pending"
      },
      {
        id: "step-fill-title",
        title: "填写标题",
        instruction: "将 AI 生成的标题填写到标题输入框",
        targetField: "title",
        status: "pending"
      },
      {
        id: "step-fill-price",
        title: "填写价格",
        instruction: "将建议售价填写到 SKU 价格区块",
        targetField: "price",
        status: "pending"
      },
      {
        id: "step-fill-stock",
        title: "填写库存",
        instruction: "将 SKU 库存同步到 Temu 库存输入区块",
        targetField: "stock",
        status: "pending"
      },
      {
        id: "step-fill-attributes",
        title: "填写属性",
        instruction: "按类目模板映射基础属性",
        targetField: "attributes",
        status: "pending"
      },
      {
        id: "step-save-draft",
        title: "保存草稿",
        instruction: "默认保存草稿，不直接最终提交",
        status: "pending"
      }
    ],
    risks: [
      {
        id: "risk-dom-change",
        level: "medium",
        message: "Temu 页面字段可能变化，需要保留人工复核"
      }
    ],
    status: "planned",
    updatedAt: new Date().toISOString()
  }
}
