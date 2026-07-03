const categoryKeywords = {
    "家居清洁": ["Home Cleaning", "Compact", "Daily Use"],
    "旅行收纳": ["Travel Organizer", "Space Saving", "Lightweight"],
    "收纳": ["Storage", "Organizer", "Space Saving"],
    "清洁": ["Cleaning", "Portable", "Daily Use"],
    "服饰": ["Comfort", "Daily Wear", "Easy Match"],
    "配件": ["Accessory", "Practical", "Everyday"]
};
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
];
const normalizeWhitespace = (value) => value.replace(/\s+/g, " ").trim();
const unique = (items) => Array.from(new Set(items.filter(Boolean)));
const asciiWords = (value) => value
    .replace(/[^a-z0-9\s-]/gi, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 1);
const findCategoryKeywords = (category) => {
    const matched = Object.entries(categoryKeywords).find(([keyword]) => category.includes(keyword));
    return matched?.[1] ?? ["Practical", "Lightweight", "Daily Use"];
};
const inferAttributes = (product) => {
    const skuAttributes = product.skus.reduce((attributes, sku) => ({
        ...attributes,
        ...sku.attributes
    }), {});
    const inferred = {
        ...product.attributes,
        ...skuAttributes
    };
    if (!inferred.usage) {
        inferred.usage = product.category;
    }
    if (!inferred.package) {
        inferred.package = "单件装";
    }
    if (!inferred.source) {
        inferred.source = product.source;
    }
    return inferred;
};
const buildAttributeSummary = (attributes) => Object.entries(attributes)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" / ");
export const generateListingDraft = (product) => {
    const attributes = inferAttributes(product);
    const keywords = findCategoryKeywords(product.category);
    const skuNames = product.skus.map((sku) => sku.name).join(", ");
    const titleWords = asciiWords(product.title);
    const titleBase = titleWords.length > 0 ? titleWords.join(" ") : keywords.join(" ");
    const listingTitle = normalizeWhitespace(`${titleBase} ${keywords.slice(0, 2).join(" ")} for Temu`);
    const totalStock = product.skus.reduce((total, sku) => total + sku.stock, 0);
    return {
        productId: product.id,
        listingTitle: listingTitle.slice(0, 120),
        sellingPoints: unique([
            `${keywords[0]} design for ${product.category}`,
            `Multiple SKU options: ${skuNames || "Default"}`,
            `Lightweight ${product.estimatedWeightKg} kg item for low-friction shipping`,
            `Ready stock estimate: ${totalStock} units`
        ]),
        description: normalizeWhitespace(`${product.title} is prepared for the ${product.category} category. ` +
            `It focuses on practical daily use, simple SKU selection, and clear attributes for marketplace listing. ` +
            `Review images, compliance wording, and final category mapping before publishing.`),
        categoryPath: [
            "Temu",
            product.category
        ],
        attributes,
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
    };
};
export const generateContentRisks = (product, draft) => {
    const searchableText = [
        product.title,
        product.category,
        draft.listingTitle,
        draft.description,
        ...draft.sellingPoints
    ].join(" ");
    const matchedSensitiveKeywords = sensitiveKeywords.filter((keyword) => searchableText.includes(keyword));
    const risks = [];
    if (matchedSensitiveKeywords.length > 0) {
        risks.push({
            id: "risk-sensitive-keywords",
            level: "high",
            message: `疑似敏感词或品牌词：${matchedSensitiveKeywords.join("、")}，发布前必须人工复核`
        });
    }
    if (product.images.length === 0) {
        risks.push({
            id: "risk-missing-images",
            level: "high",
            message: "商品缺少图片链接，不能进入自动发布"
        });
    }
    if (Object.keys(draft.attributes).length < 3) {
        risks.push({
            id: "risk-thin-attributes",
            level: "medium",
            message: "商品属性较少，建议补充材质、尺寸、颜色或适用场景"
        });
    }
    if (draft.listingTitle.length > 120) {
        risks.push({
            id: "risk-title-too-long",
            level: "medium",
            message: "刊登标题过长，可能需要按平台限制压缩"
        });
    }
    return risks;
};
