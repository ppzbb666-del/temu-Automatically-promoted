const ROOT_ID = "temu-ai-root"

const panelState = {
  busy: false,
  collapsed: false,
  task: null,
  notice: "正在等待控制台同步任务...",
  report: [],
  scan: null,
  siteContext: null,
  pageProfile: null,
  unattended: {
    status: null,
    error: null
  },
  admission: {
    workItem: null,
    checkedAt: null
  },
  lastPageContextSignature: null
}

const FIELD_SELECTORS = {
  title: [
    'input[placeholder*="标题"]',
    'textarea[placeholder*="标题"]',
    'input[aria-label*="标题"]',
    'textarea[aria-label*="标题"]',
    'input[name*="title" i]',
    'textarea[name*="title" i]'
  ],
  price: [
    'input[placeholder*="价格"]',
    'input[placeholder*="售价"]',
    'input[aria-label*="价格"]',
    'input[name*="price" i]',
    'input[data-testid*="price" i]'
  ],
  stock: [
    'input[placeholder*="库存"]',
    'input[placeholder*="数量"]',
    'input[aria-label*="库存"]',
    'input[name*="stock" i]',
    'input[name*="quantity" i]'
  ]
}

const ATTRIBUTE_ALIASES = {
  color: ["颜色", "color"],
  power: ["功率", "供电", "power"],
  material: ["材质", "material"],
  usage: ["用途", "使用场景", "usage"],
  size: ["尺码", "规格", "size"]
}

const delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))

const getSiteContext = () => {
  const hostname = window.location.hostname
  const href = window.location.href

  if (hostname === "localhost" && href.includes("5173")) {
    return {
      platform: "local-lab",
      label: "本地调试实验室",
      mode: "simulation"
    }
  }

  if (hostname.includes("dianxiaomi.com")) {
    return {
      platform: "dianxiaomi",
      label: "店小秘工作台",
      mode: href.includes("publish") || href.includes("product") ? "listing" : "workspace"
    }
  }

  if (hostname.includes("seller.kuajingmaihuo.com")) {
    return {
      platform: "temu-official",
      label: "Temu 官方采集站点",
      mode: "collection"
    }
  }

  if (hostname.includes("seller.temu.com")) {
    return {
      platform: "temu-seller",
      label: "Temu 商家后台",
      mode: "seller"
    }
  }

  return {
    platform: "unknown",
    label: "未知页面",
    mode: "unknown"
  }
}

const inferDianxiaomiPageProfile = () => {
  const href = window.location.href.toLowerCase()
  const pageText = normalizeText(document.body?.innerText).slice(0, 6000)
  const labPage = document.querySelector("[data-lab-page]")?.getAttribute("data-lab-page")

  if (labPage === "collection-box") {
    return {
      key: "collection-box",
      label: "平台采集箱",
      suggestedActions: ["认领采集商品", "批量核价", "进入产品编辑"]
    }
  }

  if (labPage === "product-edit") {
    return {
      key: "product-edit",
      label: "产品编辑页",
      suggestedActions: ["填写标题", "填写 SKU 价格与库存", "补齐属性"]
    }
  }

  if (labPage === "listing-draft") {
    return {
      key: "listing-draft",
      label: "刊登草稿页",
      suggestedActions: ["校验刊登数据", "准备提交草稿", "上传调试快照"]
    }
  }

  const matchByKeyword = (keywords) => keywords.some((keyword) => href.includes(keyword) || pageText.includes(keyword))

  if (matchByKeyword(["采集箱", "collection box", "collect box", "platform collection"])) {
    return {
      key: "collection-box",
      label: "平台采集箱",
      suggestedActions: ["认领采集商品", "批量核价", "进入产品编辑"]
    }
  }

  if (matchByKeyword(["编辑产品", "产品编辑", "edit product", "product edit", "刊登信息"])) {
    return {
      key: "product-edit",
      label: "产品编辑页",
      suggestedActions: ["填写标题", "填写 SKU 价格与库存", "补齐属性"]
    }
  }

  if (matchByKeyword(["刊登草稿", "草稿箱", "draft listing", "draft box"])) {
    return {
      key: "listing-draft",
      label: "刊登草稿页",
      suggestedActions: ["校验刊登数据", "准备提交草稿", "上传调试快照"]
    }
  }

  if (matchByKeyword(["采集", "1688", "关键词采集", "单品采集"])) {
    return {
      key: "collection-source",
      label: "采集来源页",
      suggestedActions: ["采样页面结构", "辅助采集认领", "记录字段快照"]
    }
  }

  return {
    key: "workspace",
    label: "店小秘工作台",
    suggestedActions: ["识别当前功能页", "上传调试快照"]
  }
}

const inferTemuPageProfile = () => {
  const siteContext = getSiteContext()

  if (siteContext.platform === "temu-official") {
    return {
      key: "temu-collection",
      label: "Temu 官方采集辅助页",
      suggestedActions: ["采集字段快照", "核验价格与申报价区域"]
    }
  }

  if (siteContext.platform === "temu-seller") {
    return {
      key: "temu-seller",
      label: "Temu 商家后台辅助页",
      suggestedActions: ["核验刊登结果", "补充页面调试快照"]
    }
  }

  return {
    key: "generic",
    label: "未知业务页",
    suggestedActions: ["上传调试快照"]
  }
}

const getPageProfile = () => {
  const siteContext = getSiteContext()

  if (siteContext.platform === "dianxiaomi" || siteContext.platform === "local-lab") {
    return inferDianxiaomiPageProfile()
  }

  return inferTemuPageProfile()
}

const ensureRoot = () => {
  let root = document.getElementById(ROOT_ID)
  if (!root) {
    root = document.createElement("div")
    root.id = ROOT_ID
    document.body.appendChild(root)
  }
  return root
}

const normalizeText = (value) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase()

const normalizeStoreValue = (value) => {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim()
  return normalized || null
}

const isAllStoresValue = (value) => {
  const normalized = normalizeStoreValue(value)
  if (!normalized) {
    return false
  }

  const compact = normalized.replace(/\s+/g, "")
  return compact === "全部" || compact === "全部店铺" || compact.toLowerCase() === "all" || compact.toLowerCase() === "allstores"
}

const looksLikeStoreName = (value) => {
  const normalized = normalizeStoreValue(value)
  if (!normalized || isAllStoresValue(normalized)) {
    return false
  }

  if (normalized.length > 80) {
    return false
  }

  if (/^(店铺账号|店铺帐号|店铺|账号|站点|搜索|搜索内容|搜索类型|排序方式)$/i.test(normalized)) {
    return false
  }

  return true
}

const normalizeStoreSectionTitle = (value) => normalizeStoreValue(value).replace(/\s+/g, "")

const isStoreAccountSectionTitle = (value) => {
  const compact = normalizeStoreSectionTitle(value)
  return compact === "店铺账号:" || compact === "店铺账号" || compact === "店铺帐号:" || compact === "店铺帐号"
}

const findStoreSectionContainers = () => {
  const sections = Array.from(document.querySelectorAll(".in-screen-single"))
    .filter((section) => {
      const titleText = normalizeStoreValue(section.querySelector(".title")?.textContent)
      return Boolean(titleText) && isStoreAccountSectionTitle(titleText)
    })

  if (sections.length > 0) {
    return sections
  }

  return findStoreFilterContainers()
}

const findStoreFilterContainers = () => {
  const labelNodes = Array.from(document.querySelectorAll("label, span, div, td, th, strong"))
    .filter((element) => {
      const text = normalizeStoreValue(element.textContent)
      return Boolean(text) && /^店铺账?号[:：]?$/.test(String(text).replace(/\s+/g, ""))
    })
    .slice(0, 8)

  const containers = new Set()
  labelNodes.forEach((node) => {
    if (!(node instanceof HTMLElement)) {
      return
    }

    ;[
      node.nextElementSibling,
      node.parentElement,
      node.parentElement?.nextElementSibling,
      node.closest("tr, li, [class*='row' i], [class*='item' i], [class*='group' i], [class*='filter' i], .in-screen-single")
    ].forEach((container) => {
      if (container instanceof HTMLElement) {
        containers.add(container)
      }
    })
  })

  return Array.from(containers)
}

const collectStoreTagsFromContainer = (container) => {
  if (!(container instanceof HTMLElement)) {
    return []
  }

  return Array.from(container.querySelectorAll(".d-tag-group-item"))
    .filter((element) => element instanceof HTMLElement && isVisible(element))
    .map((element) => {
      const storeName = normalizeStoreValue(element.textContent)
      if (!looksLikeStoreName(storeName)) {
        return null
      }

      const storeId = extractShopIdFromUrl(element.getAttribute("href"))
        || normalizeStoreValue(element.getAttribute("data-shop-id") || element.getAttribute("data-store-id") || element.getAttribute("data-shopid"))
        || undefined

      return {
        storeName,
        storeId,
        element
      }
    })
    .filter(Boolean)
}

const collectStoreFilterOptions = () => {
  const optionMap = new Map()

  const containers = findStoreSectionContainers()
  containers.forEach((container) => {
    collectStoreTagsFromContainer(container).forEach((option) => {
      if (!option) {
        return
      }

      const key = (option.storeId || option.storeName).toLowerCase()
      const current = optionMap.get(key)

      if (!current || (!current.storeId && option.storeId)) {
        optionMap.set(key, option)
      }
    })
  })

  if (optionMap.size === 0) {
    findStoreFilterContainers().forEach((container) => {
      Array.from(container.querySelectorAll("a, button, span, div, li")).slice(0, 80).forEach((element) => {
        if (!(element instanceof HTMLElement) || !isVisible(element)) {
          return
        }

        const storeName = normalizeStoreValue(element.textContent)
        if (!looksLikeStoreName(storeName)) {
          return
        }

        const storeId = extractShopIdFromUrl(element.getAttribute("href"))
          || normalizeStoreValue(element.getAttribute("data-shop-id") || element.getAttribute("data-store-id") || element.getAttribute("data-shopid"))
          || undefined
        const key = (storeId || storeName).toLowerCase()
        const current = optionMap.get(key)

        if (!current || (!current.storeId && storeId)) {
          optionMap.set(key, {
            storeName,
            storeId,
            element
          })
        }
      })
    })
  }

  return Array.from(optionMap.values())
}

const sortStoreOptions = (stores) =>
  [...stores].sort((left, right) => {
    const leftKey = (normalizeStoreValue(left.storeId) || normalizeStoreValue(left.storeName) || "").toLowerCase()
    const rightKey = (normalizeStoreValue(right.storeId) || normalizeStoreValue(right.storeName) || "").toLowerCase()
    return leftKey.localeCompare(rightKey, "zh-CN")
  })

const extractShopIdFromUrl = (value) => {
  try {
    const url = new URL(value, window.location.origin)
    const direct = normalizeStoreValue(url.searchParams.get("shopId"))
    if (direct && direct !== "-1") {
      return direct
    }
  } catch {
    // ignore invalid url
  }

  const matched = String(value ?? "").match(/(?:shopId|shopid)[=/:](-?\d+)/i)
  if (!matched?.[1] || matched[1] === "-1") {
    return null
  }
  return matched[1]
}

const scoreStoreSelectionElement = (element) => {
  if (!(element instanceof HTMLElement) || !isVisible(element)) {
    return -1
  }

  const storeName = normalizeStoreValue(element.textContent)
  if (!looksLikeStoreName(storeName)) {
    return -1
  }

  const classText = [
    element.className,
    element.parentElement?.className,
    element.getAttribute("data-state"),
    element.getAttribute("data-status")
  ].filter(Boolean).join(" ").toLowerCase()
  const style = window.getComputedStyle(element)
  const fontWeight = Number(style.fontWeight)
  const backgroundColor = style.backgroundColor?.replace(/\s+/g, "") ?? ""
  const textColor = style.color?.replace(/\s+/g, "") ?? ""
  let score = 0

  if (/(active|selected|current|cur|checked|on)/.test(classText)) {
    score += 5
  }
  if (element.getAttribute("aria-selected") === "true" || element.getAttribute("aria-pressed") === "true") {
    score += 5
  }
  if (style.cursor === "pointer") {
    score += 1
  }
  if (Number.isFinite(fontWeight) && fontWeight >= 600) {
    score += 1
  }
  if (backgroundColor && backgroundColor !== "rgba(0,0,0,0)" && backgroundColor !== "transparent") {
    score += 2
  }
  if (textColor.startsWith("rgb(255,255,255")) {
    score += 1
  }
  if (/^(A|BUTTON)$/i.test(element.tagName)) {
    score += 1
  }

  return score
}

const extractSelectedStoreCandidate = () => {
  const rankedCandidates = []
  collectStoreFilterOptions().forEach(({ storeName, storeId, element }) => {
    const score = scoreStoreSelectionElement(element)
    if (score < 2) {
      return
    }

    rankedCandidates.push({
      storeName,
      storeId: storeId ?? null,
      source: "selected-filter",
      score
    })
  })

  rankedCandidates.sort((left, right) => right.score - left.score)
  return rankedCandidates[0] ?? null
}

const collectAvailableStores = () =>
  sortStoreOptions(collectStoreFilterOptions())
    .map(({ storeId, storeName }) => ({
      storeId: storeId ?? undefined,
      storeName
    }))

const extractDominantStoreCandidateFromRows = () => {
  const counts = new Map()
  Array.from(document.querySelectorAll("table td, table span, table div, table p")).slice(0, 240).forEach((element) => {
    const text = normalizeStoreValue(element.textContent)
    const matched = text?.match(/\[([^\[\]]{2,60})\]/)
    const storeName = normalizeStoreValue(matched?.[1])
    if (!looksLikeStoreName(storeName) || /[0-9￥¥]/.test(String(storeName))) {
      return
    }

    counts.set(storeName, (counts.get(storeName) ?? 0) + 1)
  })

  const [storeName] = Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0] ?? []
  return storeName ? {
    storeName,
    storeId: null,
    source: "product-row"
  } : null
}

const collectStoreCandidates = () => {
  const candidates = []
  const pageText = document.body?.innerText ?? ""
  const titleText = document.title ?? ""

  const pushCandidate = (storeName, source, storeId = null) => {
    const normalizedStoreName = normalizeStoreValue(storeName)
    const normalizedStoreId = normalizeStoreValue(storeId)
    if (!normalizedStoreName && !normalizedStoreId) {
      return
    }

    candidates.push({
      storeName: normalizedStoreName,
      storeId: normalizedStoreId,
      source
    })
  }

  const selectedStoreCandidate = extractSelectedStoreCandidate()
  if (selectedStoreCandidate) {
    pushCandidate(selectedStoreCandidate.storeName, selectedStoreCandidate.source, selectedStoreCandidate.storeId)
  }

  const dominantStoreCandidate = extractDominantStoreCandidateFromRows()
  if (dominantStoreCandidate) {
    pushCandidate(dominantStoreCandidate.storeName, dominantStoreCandidate.source, dominantStoreCandidate.storeId)
  }

  const fromUrlShopId = extractShopIdFromUrl(window.location.href)
  if (fromUrlShopId) {
    pushCandidate(null, "page-url", fromUrlShopId)
  }

  Array.from(document.querySelectorAll("[data-shop-id], [data-store-id], [data-shopid]")).slice(0, 20).forEach((element) => {
    pushCandidate(
      element.getAttribute("data-store-name") || element.getAttribute("title") || element.textContent,
      "data-attr",
      element.getAttribute("data-shop-id") || element.getAttribute("data-store-id") || element.getAttribute("data-shopid")
    )
  })

  Array.from(document.querySelectorAll("a[href*='shopId='], a[href*='shopid='], [href*='/shop/']")).slice(0, 20).forEach((element) => {
    pushCandidate(element.textContent, "shop-link", extractShopIdFromUrl(element.getAttribute("href")))
  })

  ;[
    /店铺账号[:：]\s*([^\n]+)/i,
    /店铺[:：]\s*([^\n]+)/i,
    /账号[:：]\s*([^\n]+)/i
  ].forEach((pattern, index) => {
    const matched = pageText.match(pattern) || titleText.match(pattern)
    if (matched?.[1]) {
      pushCandidate(matched[1].split(/[|｜]/)[0], `text-pattern-${index + 1}`)
    }
  })

  Array.from(document.querySelectorAll(".d-tag-group-item, .el-tag, .ant-tag, .tag")).slice(0, 40).forEach((element) => {
    const text = normalizeStoreValue(element.textContent)
    if (!looksLikeStoreName(text)) {
      return
    }
    pushCandidate(text, "tag")
  })

  return candidates
}

const scoreStoreCandidate = (candidate) => {
  const sourceWeight = {
    "selected-filter": 50,
    "product-row": 40,
    "data-attr": 30,
    "shop-link": 20,
    tag: 10,
    "text-pattern-1": 5,
    "text-pattern-2": 4,
    "text-pattern-3": 3,
    "page-url": 1
  }

  return (sourceWeight[candidate.source] ?? 0)
    + (candidate.storeId ? 5 : 0)
    + (candidate.storeName ? 3 : 0)
}

const buildPageContextSignature = (context) => JSON.stringify({
  storeId: context?.storeId ?? "",
  storeName: context?.storeName ?? "",
  availableStores: sortStoreOptions(context?.availableStores ?? []).map((item) => `${item.storeName}::${item.storeId ?? ""}`),
  siteName: context?.siteName ?? "",
  pageUrl: context?.pageUrl ?? "",
  pageProfile: context?.pageProfile ?? ""
})

const waitForStoreContextChange = async (previousSignature, timeoutMs = 8000) => {
  const startedAt = Date.now()
  let lastContext = getCurrentPageContext()

  while (Date.now() - startedAt < timeoutMs) {
    const currentContext = getCurrentPageContext()
    if (currentContext) {
      const nextSignature = buildPageContextSignature(currentContext)
      if (nextSignature !== previousSignature) {
        return currentContext
      }
      lastContext = currentContext
    }

    await delay(250)
  }

  return lastContext
}

const inferSiteName = () => {
  const pageText = document.body?.innerText ?? ""
  const matched = pageText.match(/(?:站点|站点名称|平台站点)[:：]\s*([^\n]+)/i)
  return normalizeStoreValue(matched?.[1]?.split(/[|｜]/)[0]) || null
}

const getCurrentPageContext = () => {
  const siteContext = getSiteContext()
  if (siteContext.platform !== "dianxiaomi") {
    return null
  }

  const pageProfile = panelState.pageProfile ?? getPageProfile()
  const candidates = collectStoreCandidates()
  const bestCandidate = [...candidates].sort((left, right) => scoreStoreCandidate(right) - scoreStoreCandidate(left))[0] ?? null

  return {
    storeId: bestCandidate?.storeId || undefined,
    storeName: bestCandidate?.storeName || undefined,
    availableStores: collectAvailableStores(),
    siteName: inferSiteName() || undefined,
    pageUrl: window.location.href,
    pageTitle: document.title || undefined,
    pageProfile: pageProfile?.label || undefined,
    updatedAt: new Date().toISOString()
  }
}

const isVisible = (element) => {
  if (!(element instanceof HTMLElement)) {
    return false
  }

  const style = window.getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
}

const uniqueElements = (elements) => Array.from(new Set(elements)).filter(Boolean)

const getEditableFromContainer = (container) => {
  if (!(container instanceof HTMLElement)) {
    return []
  }

  return Array.from(
    container.querySelectorAll("input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled])")
  ).filter(isVisible)
}

const findFieldsBySelectors = (selectors) => uniqueElements(
  selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).filter(isVisible))
)

const findFieldsNearKeywords = (keywords) => {
  const lowerKeywords = keywords.map((keyword) => keyword.toLowerCase())
  const labelNodes = Array.from(document.querySelectorAll("label, span, div, p, strong"))
  const matchedNodes = labelNodes.filter((node) => {
    const text = normalizeText(node.textContent)
    return lowerKeywords.some((keyword) => text.includes(keyword))
  })

  const results = []

  matchedNodes.slice(0, 32).forEach((node) => {
    const containers = [
      node.closest("label"),
      node.closest('[class*="form" i]'),
      node.closest('[class*="field" i]'),
      node.closest('[class*="item" i]'),
      node.parentElement
    ]

    containers.forEach((container) => {
      results.push(...getEditableFromContainer(container))
    })

    const sibling = node.nextElementSibling
    if (sibling instanceof HTMLElement) {
      results.push(...getEditableFromContainer(sibling))
    }
  })

  return uniqueElements(results)
}

const findEditableFields = (fieldName, extraKeywords = []) => {
  const selectorMatches = findFieldsBySelectors(FIELD_SELECTORS[fieldName] ?? [])
  const keywordMatches = findFieldsNearKeywords(extraKeywords)
  return uniqueElements([...selectorMatches, ...keywordMatches])
}

const getElementText = (element) => normalizeText(element?.textContent)

const setTextLikeValue = (element, value) => {
  element.focus()

  if (element instanceof HTMLInputElement) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
    descriptor?.set?.call(element, value)
  } else if (element instanceof HTMLTextAreaElement) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
    descriptor?.set?.call(element, value)
  }

  if ("value" in element) {
    element.value = value
  }

  element.dispatchEvent(new Event("input", { bubbles: true }))
  element.dispatchEvent(new Event("change", { bubbles: true }))
  element.dispatchEvent(new Event("blur", { bubbles: true }))
}

const setSelectValue = (element, value) => {
  const normalizedValue = normalizeText(value)
  const matchedOption = Array.from(element.options).find((option) => {
    const optionText = normalizeText(option.textContent)
    const optionValue = normalizeText(option.value)
    return optionText.includes(normalizedValue) || optionValue.includes(normalizedValue)
  })

  if (!matchedOption) {
    return false
  }

  element.value = matchedOption.value
  element.dispatchEvent(new Event("change", { bubbles: true }))
  return true
}

const formatMoney = (value) => Number(value).toFixed(2)

const updateReport = (index, payload) => {
  panelState.report[index] = {
    ...panelState.report[index],
    ...payload
  }
  renderPanel()
}

const runStep = async (title, handler) => {
  const index = panelState.report.push({
    title,
    status: "running",
    detail: "正在执行..."
  }) - 1

  renderPanel()

  try {
    const result = await handler()
    updateReport(index, {
      status: result.ok ? "done" : "failed",
      detail: result.detail
    })
    return result.ok
  } catch (error) {
    updateReport(index, {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

const scoreSkuText = (rowText, sku) => {
  const haystack = normalizeText(rowText)
  const tokens = [sku.skuName, sku.attributeSummary, ...Object.values(sku.attributes)]
    .map(normalizeText)
    .filter(Boolean)

  let score = 0

  tokens.forEach((token) => {
    if (token && haystack.includes(token)) {
      score += token.length > 1 ? 2 : 1
    }
  })

  return score
}

const collectSkuRows = () => {
  const inputCandidates = uniqueElements([
    ...findEditableFields("price", ["价格", "售价", "price"]),
    ...findEditableFields("stock", ["库存", "数量", "stock", "quantity"])
  ])

  const rowMap = new Map()

  inputCandidates.forEach((field) => {
    const row = field.closest("tr, [role='row'], [class*='sku' i], [class*='table-row' i], [class*='row' i]")
    if (!(row instanceof HTMLElement)) {
      return
    }

    const key = row
    if (!rowMap.has(key)) {
      const priceFields = uniqueElements(
        getEditableFromContainer(row).filter((element) => {
          const text = normalizeText(
            [
              element.getAttribute("placeholder"),
              element.getAttribute("aria-label"),
              element.getAttribute("name"),
              element.getAttribute("data-testid")
            ].join(" ")
          )
          return text.includes("价") || text.includes("price") || text.includes("sale")
        })
      )

      const stockFields = uniqueElements(
        getEditableFromContainer(row).filter((element) => {
          const text = normalizeText(
            [
              element.getAttribute("placeholder"),
              element.getAttribute("aria-label"),
              element.getAttribute("name"),
              element.getAttribute("data-testid")
            ].join(" ")
          )
          return text.includes("库存") || text.includes("数量") || text.includes("stock") || text.includes("quantity")
        })
      )

      rowMap.set(key, {
        row,
        text: normalizeText(row.textContent),
        priceFields: priceFields.length > 0 ? priceFields : getEditableFromContainer(row).slice(0, 1),
        stockFields: stockFields.length > 0 ? stockFields : getEditableFromContainer(row).slice(1, 2)
      })
    }
  })

  return Array.from(rowMap.values())
}

const scanPage = () => {
  panelState.siteContext = getSiteContext()
  panelState.pageProfile = getPageProfile()
  const titleFields = findEditableFields("title", ["标题", "商品标题", "title"])
  const priceFields = findEditableFields("price", ["价格", "售价", "price"])
  const stockFields = findEditableFields("stock", ["库存", "数量", "stock", "quantity"])

  const attributeMatches = Object.entries(ATTRIBUTE_ALIASES).reduce((accumulator, [key, keywords]) => {
    accumulator[key] = findFieldsNearKeywords(keywords).length
    return accumulator
  }, {})

  const skuRows = collectSkuRows()

  const result = {
    titleFieldCount: titleFields.length,
    priceFieldCount: priceFields.length,
    stockFieldCount: stockFields.length,
    skuRowCount: skuRows.length,
    attributeMatches
  }

  panelState.scan = result
  return result
}

const matchSkuRows = (task) => {
  const pageRows = collectSkuRows()
  const matches = []
  const usedRows = new Set()

  task.draft.skuPricing.forEach((sku, index) => {
    let bestRow = null
    let bestScore = -1

    pageRows.forEach((row) => {
      if (usedRows.has(row.row)) {
        return
      }

      const score = scoreSkuText(row.text, sku)
      if (score > bestScore) {
        bestScore = score
        bestRow = row
      }
    })

    if (bestRow && bestScore > 0) {
      usedRows.add(bestRow.row)
      matches.push({
        sku,
        row: bestRow,
        mode: "text-match",
        score: bestScore
      })
      return
    }

    const fallbackRow = pageRows[index]
    if (fallbackRow && !usedRows.has(fallbackRow.row)) {
      usedRows.add(fallbackRow.row)
      matches.push({
        sku,
        row: fallbackRow,
        mode: "index-fallback",
        score: 0
      })
      return
    }

    matches.push({
      sku,
      row: null,
      mode: "missing",
      score: -1
    })
  })

  return matches
}

const checkPageContext = () => {
  const scan = scanPage()

  if (scan.titleFieldCount === 0 && scan.priceFieldCount === 0 && scan.skuRowCount === 0) {
    return {
      ok: false,
      detail: "当前页面没有识别到 Temu 上品字段，请先打开商品发布页。"
    }
  }

  return {
    ok: true,
    detail: `扫描完成：标题 ${scan.titleFieldCount}，价格 ${scan.priceFieldCount}，库存 ${scan.stockFieldCount}，SKU 行 ${scan.skuRowCount}。`
  }
}

const fillTitle = async (task) => {
  const fields = findEditableFields("title", ["标题", "商品标题", "title"])
  const field = fields[0]

  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
    return {
      ok: false,
      detail: "没有找到可填写的标题字段。"
    }
  }

  setTextLikeValue(field, task.draft.listingTitle)
  await delay(150)

  return {
    ok: true,
    detail: `已填写标题：${task.draft.listingTitle}`
  }
}

const fillSkuFields = async (task) => {
  const matches = matchSkuRows(task)
  const priceFields = findEditableFields("price", ["价格", "售价", "price"])
  const stockFields = findEditableFields("stock", ["库存", "数量", "stock", "quantity"])

  if (matches.every((item) => !item.row) && priceFields.length === 0 && stockFields.length === 0) {
    return {
      ok: false,
      detail: "没有识别到 SKU 行，也没有找到独立的价格或库存字段。"
    }
  }

  let filledPriceCount = 0
  let filledStockCount = 0
  const unmatched = []

  for (const [index, match] of matches.entries()) {
    const { sku } = match
    const priceValue = formatMoney(sku.salePriceUsd)
    const stockValue = String(sku.stock)

    if (match.row) {
      const priceField = match.row.priceFields[0]
      const stockField = match.row.stockFields[0]

      if (priceField instanceof HTMLInputElement || priceField instanceof HTMLTextAreaElement) {
        setTextLikeValue(priceField, priceValue)
        filledPriceCount += 1
      }

      if (stockField instanceof HTMLInputElement || stockField instanceof HTMLTextAreaElement) {
        setTextLikeValue(stockField, stockValue)
        filledStockCount += 1
      }

      await delay(120)
    } else {
      const priceFallback = priceFields[index]
      const stockFallback = stockFields[index]

      if (priceFallback instanceof HTMLInputElement || priceFallback instanceof HTMLTextAreaElement) {
        setTextLikeValue(priceFallback, priceValue)
        filledPriceCount += 1
      }

      if (stockFallback instanceof HTMLInputElement || stockFallback instanceof HTMLTextAreaElement) {
        setTextLikeValue(stockFallback, stockValue)
        filledStockCount += 1
      }

      if (!priceFallback && !stockFallback) {
        unmatched.push(sku.skuName)
      }
    }
  }

  return {
    ok: filledPriceCount > 0 || filledStockCount > 0,
    detail: `已填写价格 ${filledPriceCount} 项，库存 ${filledStockCount} 项。${unmatched.length > 0 ? ` 未匹配 SKU：${unmatched.join("、")}。` : ""}`.trim()
  }
}

const fillAttributes = async (task) => {
  const attributeEntries = Object.entries(task.draft.attributes)
  const successKeys = []
  const missedKeys = []

  for (const [key, value] of attributeEntries) {
    const keywords = ATTRIBUTE_ALIASES[key] ?? [key]
    const candidates = findFieldsNearKeywords(keywords)
    const field = candidates[0]

    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      setTextLikeValue(field, value)
      successKeys.push(key)
      await delay(100)
      continue
    }

    if (field instanceof HTMLSelectElement) {
      const matched = setSelectValue(field, value)
      if (matched) {
        successKeys.push(key)
        await delay(100)
        continue
      }
    }

    missedKeys.push(key)
  }

  if (successKeys.length === 0) {
    return {
      ok: false,
      detail: "没有匹配到可填写的属性字段。"
    }
  }

  return {
    ok: true,
    detail: `已填写属性：${successKeys.join("、")}。${missedKeys.length > 0 ? ` 未匹配属性：${missedKeys.join("、")}。` : ""}`.trim()
  }
}

const saveDraftSafely = () => ({
  ok: true,
  detail: "当前为安全模式，未自动点击保存草稿按钮。"
})

const applyTaskToPage = async (task) => {
  if (!task) {
    return {
      ok: false,
      detail: "当前没有可执行任务。"
    }
  }

  panelState.report = []
  renderPanel()

  const results = []

  results.push(await runStep("扫描发布页字段", async () => checkPageContext()))
  results.push(await runStep("填写商品标题", async () => fillTitle(task)))
  results.push(await runStep("填写 SKU 价格与库存", async () => fillSkuFields(task)))
  results.push(await runStep("填写基础属性", async () => fillAttributes(task)))
  results.push(await runStep("保存草稿策略", async () => saveDraftSafely()))

  const successCount = results.filter(Boolean).length

  return {
    ok: successCount >= 4,
    detail: `执行完成，${successCount}/${results.length} 个步骤成功。`
  }
}

const requestActiveTask = () => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ type: "temu-ai/get-active-task" }, (response) => {
    if (chrome.runtime.lastError) {
      reject(new Error(chrome.runtime.lastError.message))
      return
    }

    if (!response?.ok) {
      reject(new Error(response?.message ?? "Unknown runtime error"))
      return
    }

    resolve(response.task ?? null)
  })
})

const requestUnattendedStatus = () => sendRuntimeMessage("temu-ai/get-unattended-status", {
  pageUrl: window.location.href
})

const refreshUnattendedStatus = async ({ render = true } = {}) => {
  try {
    const response = await requestUnattendedStatus()
    panelState.unattended = {
      status: response.status,
      error: null
    }
    if (response.status?.currentWorkItem) {
      panelState.admission = {
        workItem: response.status.currentWorkItem,
        checkedAt: response.status.checkedAt ?? new Date().toISOString()
      }
    } else if (panelState.admission.workItem?.pageUrl !== window.location.href) {
      panelState.admission = {
        workItem: null,
        checkedAt: null
      }
    }
  } catch (error) {
    panelState.unattended = {
      status: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }

  if (render) {
    renderPanel()
  }
}

const refreshTask = async () => {
  panelState.notice = "正在从本地服务获取当前任务..."
  renderPanel()

  try {
    const [task] = await Promise.all([
      requestActiveTask(),
      refreshUnattendedStatus({ render: false })
    ])
    panelState.task = task
    const scan = scanPage()
    panelState.notice = task
      ? `任务已同步。当前页面扫描到 ${scan.skuRowCount} 个 SKU 行候选，可直接尝试执行。`
      : "控制台还没有同步任务到插件。"
  } catch (error) {
    panelState.notice = error instanceof Error ? error.message : String(error)
  }

  renderPanel()
}

const renderScanSummary = () => {
  const scan = panelState.scan
  if (!scan) {
    return "<div class='meta-card'><strong>页面扫描</strong><span class='muted'>尚未扫描</span></div>"
  }

  const attributeSummary = Object.entries(scan.attributeMatches)
    .map(([key, count]) => `${key}:${count}`)
    .join(" · ")

  return `
    <div class="scan-grid">
      <div class="meta-card">
        <strong>标题字段</strong>
        <span class="muted">${scan.titleFieldCount}</span>
      </div>
      <div class="meta-card">
        <strong>SKU 行</strong>
        <span class="muted">${scan.skuRowCount}</span>
      </div>
      <div class="meta-card">
        <strong>价格字段</strong>
        <span class="muted">${scan.priceFieldCount}</span>
      </div>
      <div class="meta-card">
        <strong>库存字段</strong>
        <span class="muted">${scan.stockFieldCount}</span>
      </div>
      <div class="meta-card wide">
        <strong>属性候选</strong>
        <span class="muted">${attributeSummary || "暂无"}</span>
      </div>
    </div>
  `
}

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;")

const renderStatusRow = (label, value, tone = "neutral") => `
  <div class="status-row ${tone}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
  </div>
`

const summarizeScan = (scan) => {
  if (!scan) {
    return "未扫描"
  }

  return `标题 ${scan.titleFieldCount} / SKU ${scan.skuRowCount} / 价格 ${scan.priceFieldCount}`
}

const getDaemonLabel = (unattendedStatus) => {
  const queue = unattendedStatus?.health?.queue
  if (!queue) {
    return "未连接"
  }

  if (queue.daemonStatus === "ACTIVE") {
    return queue.running ? "运行中" : "已启动"
  }

  return "已暂停"
}

const getDaemonTone = (unattendedStatus) => {
  const queue = unattendedStatus?.health?.queue
  if (!queue) {
    return "warn"
  }

  if (queue.daemonStatus === "ACTIVE") {
    return "ok"
  }

  return "warn"
}

const getWorkItemStatusLabel = (status) => {
  const labels = {
    "ready-for-automation": "等待自动跑",
    "needs-revision": "需要改造",
    blocked: "已阻塞",
    edited: "已发布到核价"
  }

  return labels[status] ?? "未入队"
}

const getCurrentWorkItemLabel = (unattendedStatus) => {
  const workItem = unattendedStatus?.currentWorkItem
  if (!workItem) {
    return "未入队"
  }

  return getWorkItemStatusLabel(workItem.status)
}

const getCurrentWorkItemTone = (unattendedStatus) => {
  const status = unattendedStatus?.currentWorkItem?.status
  if (status === "ready-for-automation" || status === "edited") {
    return "ok"
  }
  if (status === "blocked") {
    return "bad"
  }

  return "warn"
}

const getQueueSummary = (unattendedStatus) => {
  const workItems = unattendedStatus?.health?.workItems
  if (!workItems) {
    return "未连接"
  }

  return `待跑 ${workItems.ready} / 阻塞 ${workItems.blocked}`
}

const PUBLISH_OUTCOME_ROUTE_LABELS = {
  published: "等待 Temu 核价/最终上架",
  "auto-retry": "等待安全自动重试",
  "browser-recovery": "进入故障恢复",
  "manual-budget": "计入人工步骤预算",
  "not-attempted": "尚未点击发布"
}

const getPublishOutcomeAlert = (workItem) => {
  const outcome = workItem?.publishOutcome
  if (!outcome || outcome.status === "not-attempted") {
    return null
  }

  if (outcome.status === "succeeded") {
    return `发布成功：店小秘已提交，${PUBLISH_OUTCOME_ROUTE_LABELS[outcome.route] ?? "等待后续处理"}。`
  }

  const attemptText = outcome.maxAttempts > 0 ? `（${outcome.attempts}/${outcome.maxAttempts} 次）` : ""
  const reason = outcome.failureReason || outcome.message || "未识别原因"
  return `发布失败${attemptText}：${reason}。下一步：${PUBLISH_OUTCOME_ROUTE_LABELS[outcome.route] ?? "查看高级信息"}。`
}

const ADMISSION_FIELD_LABELS = {
  title: "标题",
  description: "描述",
  image: "图片",
  sku: "SKU",
  price: "价格",
  stock: "库存",
  attribute: "属性",
  compliance: "合规"
}

const getActiveAdmissionWorkItem = (unattendedStatus, admission) =>
  admission.workItem ?? unattendedStatus?.currentWorkItem ?? null

const getAdmissionIssues = (workItem) => {
  const edits = (workItem?.suggestedEdits ?? [])
    .filter((edit) => edit.priority === "required")
    .map((edit) => ({
      id: edit.id,
      field: ADMISSION_FIELD_LABELS[edit.field] ?? edit.field,
      reason: edit.suggestedValue || edit.reason || "需要补齐"
    }))

  if (edits.length > 0) {
    return edits
  }

  return (workItem?.requirements?.checks ?? [])
    .filter((check) => check.level === "required" && !check.ok)
    .map((check) => ({
      id: check.id,
      field: "准入",
      reason: check.recommendation || check.message || "需要补齐"
    }))
}

const getAdmissionLabel = (workItem) => {
  if (!workItem) {
    return "未检查"
  }

  if (workItem.status === "ready-for-automation") {
    return "通过，等待自动跑"
  }

  if (workItem.status === "edited") {
    return "已发布到核价"
  }

  if (workItem.status === "blocked") {
    return "阻塞"
  }

  const issueCount = getAdmissionIssues(workItem).length
  return issueCount > 0 ? `未通过，缺 ${issueCount} 项` : getWorkItemStatusLabel(workItem.status)
}

const getAdmissionTone = (workItem) => {
  if (!workItem) {
    return "warn"
  }

  if (workItem.status === "ready-for-automation" || workItem.status === "edited") {
    return "ok"
  }

  if (workItem.status === "blocked") {
    return "bad"
  }

  return "warn"
}

const describeAdmissionNotice = (workItem) => {
  if (!workItem) {
    return "加入队列完成，但没有收到准入结果。"
  }

  if (workItem.status === "ready-for-automation") {
    return `已加入队列：${workItem.title}。准入通过，等待无人值守自动跑。`
  }

  const issueCount = getAdmissionIssues(workItem).length

  return issueCount > 0
    ? `已加入队列：${workItem.title}。准入未通过，缺 ${issueCount} 项，见告警。`
    : `已加入队列：${workItem.title}。当前状态：${getWorkItemStatusLabel(workItem.status)}。`
}

const renderAdmissionDetails = (workItem) => {
  if (!workItem) {
    return "<div class='admission-detail muted'>尚未加入队列或尚未返回准入结果。</div>"
  }

  const issues = getAdmissionIssues(workItem)
  if (issues.length === 0) {
    return `<div class="admission-detail ok">${escapeHtml(getAdmissionLabel(workItem))}</div>`
  }

  return `
    <div class="admission-issue-list">
      ${issues.slice(0, 8).map((issue) => `
        <div class="admission-issue">
          <strong>${escapeHtml(issue.field)}</strong>
          <span>${escapeHtml(issue.reason)}</span>
        </div>
      `).join("")}
    </div>
  `
}

const REPAIR_AUTOMATION_LABELS = {
  auto: "自动",
  assisted: "辅助",
  manual: "人工"
}

const getRepairPlanCounts = (workItem) => {
  const actions = workItem?.repairPlan?.actions ?? []

  return actions.reduce((counts, action) => {
    counts[action.automation] = (counts[action.automation] ?? 0) + 1
    return counts
  }, {
    auto: 0,
    assisted: 0,
    manual: 0
  })
}

const getRepairPlanLabel = (workItem) => {
  if (!workItem) {
    return "未生成"
  }

  if (workItem.status === "ready-for-automation" || workItem.status === "edited") {
    return "无需改造"
  }

  const repairPlan = workItem.repairPlan
  if (!repairPlan) {
    return "未生成"
  }

  const counts = getRepairPlanCounts(workItem)
  const countText = `自动 ${counts.auto} / 辅助 ${counts.assisted} / 人工 ${counts.manual}`

  if (repairPlan.status === "auto-ready" && repairPlan.canAutoRepair) {
    return `可自动处理（${counts.auto} 项）`
  }

  if (repairPlan.status === "assisted") {
    return `需辅助处理（${countText}）`
  }

  if (repairPlan.status === "manual") {
    return `需人工处理（${countText}）`
  }

  if (repairPlan.status === "blocked") {
    return `已阻塞（${countText}）`
  }

  return countText
}

const getRepairPlanTone = (workItem) => {
  if (!workItem || workItem.status === "ready-for-automation" || workItem.status === "edited") {
    return "ok"
  }

  const status = workItem.repairPlan?.status
  if (status === "auto-ready" && workItem.repairPlan?.canAutoRepair) {
    return "ok"
  }

  if (status === "blocked" || workItem.status === "blocked") {
    return "bad"
  }

  return "warn"
}

const getBackendRepairActionGate = (workItem) => {
  const gate = workItem?.repairActionGate
  if (!gate || typeof gate.defaultActionAllowed !== "boolean") {
    return null
  }

  const status = gate.status ?? workItem?.repairPlan?.status ?? "none"
  const blocked = !gate.defaultActionAllowed
  return {
    blocked,
    tone: blocked && (status === "blocked" || workItem?.status === "blocked") ? "bad" : blocked ? "warn" : getRepairPlanTone(workItem),
    message: gate.message ?? ""
  }
}

const getRepairActionGate = (workItem) => {
  if (!workItem) {
    return {
      blocked: false,
      tone: "ok",
      message: ""
    }
  }

  const backendGate = getBackendRepairActionGate(workItem)
  if (backendGate) {
    return backendGate
  }

  if (workItem.status === "ready-for-automation" || workItem.status === "edited") {
    return {
      blocked: false,
      tone: "ok",
      message: ""
    }
  }

  const repairPlan = workItem.repairPlan
  if (!repairPlan || (repairPlan.status === "auto-ready" && repairPlan.canAutoRepair)) {
    return {
      blocked: false,
      tone: getRepairPlanTone(workItem),
      message: ""
    }
  }

  const label = getRepairPlanLabel(workItem)
  const isBlocked = repairPlan.status === "blocked" || workItem.status === "blocked"
  return {
    blocked: true,
    tone: isBlocked ? "bad" : "warn",
    message: `${label}，默认无人值守动作已暂停。展开高级信息查看改造计划，处理后再进入故障恢复或重试。`
  }
}

const renderRepairPlanDetails = (workItem) => {
  const repairPlan = workItem?.repairPlan
  if (!workItem) {
    return "<div class='admission-detail muted'>尚未加入队列或尚未返回改造计划。</div>"
  }

  if (!repairPlan) {
    return `<div class="admission-detail ok">${escapeHtml(getRepairPlanLabel(workItem))}</div>`
  }

  const actions = repairPlan.actions ?? []
  const blockers = repairPlan.blockers ?? []

  return `
    <div class="repair-plan-summary ${getRepairPlanTone(workItem)}">
      <strong>${escapeHtml(getRepairPlanLabel(workItem))}</strong>
      <span>${escapeHtml(repairPlan.summary ?? "")}</span>
    </div>
    ${blockers.length > 0 ? `
      <div class="admission-issue-list">
        ${blockers.slice(0, 4).map((blocker) => `
          <div class="admission-issue">
            <strong>阻塞</strong>
            <span>${escapeHtml(blocker)}</span>
          </div>
        `).join("")}
      </div>
    ` : ""}
    ${actions.length > 0 ? `
      <div class="repair-action-list">
        ${actions.slice(0, 8).map((action) => `
          <div class="repair-action ${escapeHtml(action.automation)}">
            <strong>${escapeHtml(REPAIR_AUTOMATION_LABELS[action.automation] ?? action.automation)} · ${escapeHtml(action.label)}</strong>
            <span>${escapeHtml(action.detail)}</span>
          </div>
        `).join("")}
      </div>
    ` : ""}
  `
}

const getPanelAlerts = ({ task, riskText, scan, siteContext, unattended, admission }) => {
  const alerts = []
  const unattendedStatus = unattended.status
  const currentWorkItem = getActiveAdmissionWorkItem(unattendedStatus, admission)
  const health = unattendedStatus?.health
  const admissionIssues = getAdmissionIssues(currentWorkItem)
  const repairActionGate = getRepairActionGate(currentWorkItem)

  if (!task) {
    alerts.push("还没有同步任务，请先确认本地控制台有可执行任务。")
  }

  if (unattended.error) {
    alerts.push(`本地无人值守服务未连接：${unattended.error}`)
  }

  if (siteContext.platform !== "dianxiaomi" && siteContext.platform !== "local-lab") {
    alerts.push("当前不在店小秘商品编辑页，自动写入会受限。")
  }

  if (scan && scan.titleFieldCount === 0 && scan.priceFieldCount === 0 && scan.skuRowCount === 0) {
    alerts.push("页面没有识别到上品字段，需要重新打开正确的商品编辑页或重新校准。")
  }

  if (riskText && riskText !== "暂无风险提醒") {
    alerts.push(riskText)
  }

  if (health?.recommendation && health.recommendation.level !== "info") {
    alerts.push(`${health.recommendation.title}：${health.recommendation.action}`)
  }

  if (currentWorkItem?.failureDiagnosis?.message) {
    alerts.push(`${currentWorkItem.failureDiagnosis.message} 下一步：${currentWorkItem.failureDiagnosis.nextAction}`)
  }

  const publishOutcomeAlert = getPublishOutcomeAlert(currentWorkItem)
  if (publishOutcomeAlert) {
    alerts.push(publishOutcomeAlert)
  }

  if (currentWorkItem && currentWorkItem.status === "needs-revision") {
    admissionIssues.slice(0, 3).forEach((issue) => {
      alerts.push(`准入未通过：${issue.field} - ${issue.reason}`)
    })

    if (currentWorkItem.repairPlan) {
      alerts.push(`改造计划：${getRepairPlanLabel(currentWorkItem)}`)
    }
  }

  if (repairActionGate.blocked) {
    alerts.push(`默认动作已暂停：${repairActionGate.message}`)
  }

  if (!currentWorkItem && siteContext.platform === "dianxiaomi") {
    alerts.push("当前商品还没有进入自动队列，可点击“加入队列”。")
  }

  if (panelState.busy) {
    alerts.push("正在执行，请不要切换页面或关闭当前标签。")
  }

  return alerts
}

const renderPanel = () => {
  const root = ensureRoot()
  const task = panelState.task
  const siteContext = panelState.siteContext ?? getSiteContext()
  const pageProfile = panelState.pageProfile ?? getPageProfile()
  const riskText = task?.risks?.[0]?.message ?? "暂无风险提醒"
  const scan = panelState.scan
  const alerts = getPanelAlerts({
    task,
    riskText,
    scan,
    siteContext,
    unattended: panelState.unattended,
    admission: panelState.admission
  })
  const activeAdmissionWorkItem = getActiveAdmissionWorkItem(panelState.unattended.status, panelState.admission)
  const stepItems = (task?.steps ?? [])
    .map((step) => `<div class="step"><strong>${escapeHtml(step.title)}</strong><div>${escapeHtml(step.instruction)}</div></div>`)
    .join("")
  const reportItems = panelState.report.length > 0
    ? panelState.report.map((item) => `
        <div class="report-item ${item.status}">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.detail)}</span>
        </div>
      `).join("")
    : "<div class='report-item'><strong>尚未执行</strong><span>点击“执行自动填充”后会显示详细结果。</span></div>"
  const compactReportItems = panelState.report.length > 0
    ? panelState.report.slice(-2).map((item) => `
        <div class="report-item ${item.status}">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.detail)}</span>
        </div>
      `).join("")
    : ""
  const alertItems = alerts.length > 0
    ? alerts.map((alert) => `<div class="alert-item">${escapeHtml(alert)}</div>`).join("")
    : "<div class='alert-item ok'>暂无需要处理的告警。</div>"
  const repairActionGate = getRepairActionGate(activeAdmissionWorkItem)
  const defaultActionDisabled = panelState.busy || repairActionGate.blocked
  const collectActionLabel = activeAdmissionWorkItem ? "刷新准入" : "加入队列"
  const collectActionDisabled = panelState.busy || repairActionGate.blocked
  const pageSummary = `${siteContext.label} / ${pageProfile.label}`
  const pageTone = siteContext.platform === "dianxiaomi" ? "ok" : siteContext.platform === "local-lab" ? "warn" : "bad"
  const panelTone = panelState.busy
    ? "warn"
    : repairActionGate.blocked
      ? repairActionGate.tone
      : activeAdmissionWorkItem
        ? getAdmissionTone(activeAdmissionWorkItem)
        : getDaemonTone(panelState.unattended.status)
  const heroTitle = task?.product.title ?? activeAdmissionWorkItem?.title ?? "等待店小秘页面同步任务"
  const heroStatus = panelState.busy
    ? "正在执行"
    : repairActionGate.blocked
      ? "需先处理"
      : activeAdmissionWorkItem
        ? getAdmissionLabel(activeAdmissionWorkItem)
        : "待加入队列"
  const heroChip = panelState.busy ? "执行中" : repairActionGate.blocked ? "待处理" : "可继续"
  const nextStepText = siteContext.platform !== "dianxiaomi" && siteContext.platform !== "local-lab"
    ? "请切回店小秘商品编辑页，再让页内插件接管动作。"
    : panelState.busy
      ? "正在驱动店小秘页面执行默认流程，请保持当前商品编辑页打开。"
      : repairActionGate.blocked
        ? "当前商品已被分类为需要改造，先按店小秘图片检测或改造计划处理，再继续默认动作。"
        : !activeAdmissionWorkItem
          ? "当前页面还没进入自动队列，先点击“加入队列”，再由系统继续跑。"
          : activeAdmissionWorkItem.status === "ready-for-automation"
            ? "当前商品已通过准入，可以直接点击“执行默认动作”。"
            : activeAdmissionWorkItem.status === "edited"
              ? "当前商品已进入核价或后续阶段，继续看运行结果即可。"
              : "先刷新准入或按页面提示修正字段，再继续默认动作。"

  if (panelState.collapsed) {
    root.innerHTML = `
      <div class="temu-ai-shell collapsed">
        <button id="temu-ai-toggle" class="temu-ai-launcher ${panelTone}">
          <span>店小秘插件</span>
          <strong>${escapeHtml(heroChip)}</strong>
          <small>${escapeHtml(pageProfile.label)}</small>
        </button>
      </div>
    `

    root.querySelector("#temu-ai-toggle")?.addEventListener("click", () => {
      panelState.collapsed = false
      renderPanel()
    })
    return
  }

  root.innerHTML = `
    <div class="temu-ai-shell">
      <div class="temu-ai-panel ${panelTone}">
        <header>
          <div class="header-copy">
            <div class="header-meta">
              <span class="panel-badge">店小秘插件</span>
              <span class="panel-badge subtle">${escapeHtml(pageProfile.label)}</span>
            </div>
            <strong>${escapeHtml(heroTitle)}</strong>
            <span>${escapeHtml(pageSummary)}</span>
          </div>
          <button id="temu-ai-toggle" class="panel-toggle secondary">收起</button>
        </header>
        <div class="body">
          <div class="plugin-hero ${panelTone}">
            <div class="plugin-hero-head">
              <div>
                <label>当前页面正在做什么</label>
                <strong>${escapeHtml(heroStatus)}</strong>
              </div>
              <span class="hero-chip ${panelTone}">${escapeHtml(heroChip)}</span>
            </div>
            <p>${escapeHtml(nextStepText)}</p>
          </div>

          <div class="notice">${escapeHtml(panelState.notice)}</div>

          <div class="panel-group">
            <label>状态</label>
            ${renderStatusRow("守护进程", getDaemonLabel(panelState.unattended.status), getDaemonTone(panelState.unattended.status))}
            ${renderStatusRow("队列", getQueueSummary(panelState.unattended.status), panelState.unattended.status ? "ok" : "warn")}
            ${renderStatusRow("当前页面", pageSummary, pageTone)}
            ${renderStatusRow("当前商品", getCurrentWorkItemLabel(panelState.unattended.status), getCurrentWorkItemTone(panelState.unattended.status))}
            ${renderStatusRow("准入", getAdmissionLabel(activeAdmissionWorkItem), getAdmissionTone(activeAdmissionWorkItem))}
            ${renderStatusRow("改造", getRepairPlanLabel(activeAdmissionWorkItem), getRepairPlanTone(activeAdmissionWorkItem))}
            ${renderStatusRow("字段", summarizeScan(scan), scan ? "ok" : "warn")}
          </div>

          <div class="panel-group">
            <label>告警</label>
            <div class="alert-list">${alertItems}</div>
          </div>

          <div class="panel-group">
            <label>动作</label>
            ${repairActionGate.blocked ? `
              <div class="action-gate ${escapeHtml(repairActionGate.tone)}">
                <strong>默认动作已暂停</strong>
                <span>${escapeHtml(repairActionGate.message)}</span>
              </div>
            ` : ""}
            <div class="actions">
              <button id="temu-ai-run" ${defaultActionDisabled ? "disabled" : ""}>${panelState.busy ? "执行中..." : repairActionGate.blocked ? "先处理改造" : "执行默认动作"}</button>
              <button id="temu-ai-collect" class="secondary" ${collectActionDisabled ? "disabled" : ""}>${escapeHtml(collectActionLabel)}</button>
              <button id="temu-ai-refresh" class="secondary" ${panelState.busy ? "disabled" : ""}>刷新状态</button>
            </div>
            <div class="sub-actions">
              <button id="temu-ai-scan" class="secondary" ${panelState.busy ? "disabled" : ""}>重新扫描页面</button>
            </div>
          </div>

          ${compactReportItems ? `
            <div class="panel-group">
              <label>当前执行反馈</label>
              <div class="report-list compact">${compactReportItems}</div>
            </div>
          ` : ""}

          <details class="advanced-panel">
            <summary>高级信息</summary>
            <div class="section">
              <label>AI 标题</label>
              <div>${escapeHtml(task?.draft?.listingTitle ?? "暂无数据")}</div>
            </div>
            <div class="section">
              <label>任务与页面</label>
              <div class="mini-detail">任务：${escapeHtml(task ? "已同步" : "等待中")}</div>
              <div class="mini-detail">页面：${escapeHtml(pageSummary)}</div>
              <div class="mini-detail">SKU：${escapeHtml(String(task?.draft?.skuPricing?.length ?? 0))}</div>
            </div>
            <div class="section">
              <label>准入结果</label>
              ${renderAdmissionDetails(activeAdmissionWorkItem)}
            </div>
            <div class="section">
              <label>改造计划</label>
              ${renderRepairPlanDetails(activeAdmissionWorkItem)}
            </div>
            <div class="section">
              <label>页面扫描</label>
              ${renderScanSummary()}
            </div>
            <div class="section">
              <label>执行步骤</label>
              ${stepItems || "<div class='step'>暂无步骤</div>"}
            </div>
            <div class="section">
              <label>执行反馈</label>
              <div class="report-list">${reportItems}</div>
            </div>
            <button id="temu-ai-debug" class="secondary wide-action" ${panelState.busy ? "disabled" : ""}>上传调试快照</button>
          </details>
        </div>
      </div>
    </div>
  `

  root.querySelector("#temu-ai-toggle")?.addEventListener("click", () => {
    panelState.collapsed = true
    renderPanel()
  })

  root.querySelector("#temu-ai-refresh")?.addEventListener("click", () => {
    void refreshTask()
  })

  root.querySelector("#temu-ai-scan")?.addEventListener("click", () => {
    const scan = scanPage()
    panelState.notice = `页面重新扫描完成：SKU 行 ${scan.skuRowCount}，价格字段 ${scan.priceFieldCount}。`
    renderPanel()
  })

  root.querySelector("#temu-ai-debug")?.addEventListener("click", async () => {
    if (panelState.busy) {
      return
    }

    panelState.busy = true
    panelState.notice = "正在采样当前页面并上传调试快照..."
    renderPanel()

    try {
      const snapshot = buildDebugSnapshot(panelState.task)
      const response = await sendRuntimeMessage("temu-ai/upload-debug-snapshot", snapshot)
      panelState.notice = response?.ok
        ? `调试快照已上传，字段样本 ${snapshot.fieldSnapshots.length} 条，SKU 行 ${snapshot.skuRows.length} 条。`
        : "调试快照上传失败。"
    } catch (error) {
      panelState.notice = error instanceof Error ? error.message : String(error)
    } finally {
      panelState.busy = false
      renderPanel()
    }
  })

  root.querySelector("#temu-ai-collect")?.addEventListener("click", async () => {
    if (panelState.busy || repairActionGate.blocked) {
      return
    }

    const isRefreshingAdmission = Boolean(getActiveAdmissionWorkItem(panelState.unattended.status, panelState.admission))

    panelState.busy = true
    panelState.notice = isRefreshingAdmission
      ? "正在重新采样当前店小秘商品并刷新准入..."
      : "正在把当前店小秘商品加入上架改造队列..."
    renderPanel()

    try {
      const response = await queueCollectedProductWorkItem()
      if (response?.workItem) {
        panelState.admission = {
          workItem: response.workItem,
          checkedAt: new Date().toISOString()
        }
      }
      await refreshUnattendedStatus({ render: false })
      panelState.notice = response?.ok
        ? describeAdmissionNotice(response.workItem, { refreshed: isRefreshingAdmission })
        : isRefreshingAdmission ? "刷新准入失败。" : "加入改造队列失败。"
    } catch (error) {
      panelState.notice = error instanceof Error ? error.message : String(error)
    } finally {
      panelState.busy = false
      renderPanel()
    }
  })

  root.querySelector("#temu-ai-run")?.addEventListener("click", async () => {
    if (panelState.busy) {
      return
    }
    const latestRepairActionGate = getRepairActionGate(getActiveAdmissionWorkItem(panelState.unattended.status, panelState.admission))
    if (latestRepairActionGate.blocked) {
      panelState.notice = latestRepairActionGate.message
      renderPanel()
      return
    }

    panelState.busy = true
    panelState.notice = "正在执行默认动作，请不要频繁切换页面。"
    renderPanel()

    const result = await applyTaskToPage(panelState.task)
    chrome.runtime.sendMessage({
      type: "temu-ai/log",
      payload: result
    })

    panelState.busy = false
    panelState.notice = result.detail
    renderPanel()
  })
}

const describeFieldKind = (element) => {
  const hint = normalizeText(
    [
      element.getAttribute?.("placeholder"),
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("name"),
      element.getAttribute?.("data-testid")
    ].join(" ")
  )

  if (hint.includes("标题") || hint.includes("title")) {
    return "title"
  }
  if (hint.includes("价格") || hint.includes("售价") || hint.includes("price")) {
    return "price"
  }
  if (hint.includes("库存") || hint.includes("数量") || hint.includes("stock") || hint.includes("quantity")) {
    return "stock"
  }
  if (hint.includes("颜色") || hint.includes("尺码") || hint.includes("材质") || hint.includes("规格")) {
    return "attribute"
  }
  return "unknown"
}

const getSelectorHint = (element) => {
  const tagName = element.tagName.toLowerCase()
  const name = element.getAttribute("name")
  const placeholder = element.getAttribute("placeholder")
  const className = typeof element.className === "string" ? element.className.trim().split(/\s+/).slice(0, 2).join(".") : ""

  if (name) {
    return `${tagName}[name="${name}"]`
  }

  if (placeholder) {
    return `${tagName}[placeholder="${placeholder}"]`
  }

  if (className) {
    return `${tagName}.${className}`
  }

  return tagName
}

const inferLabelText = (element) => {
  const containers = [
    element.closest("label"),
    element.closest('[class*="form" i]'),
    element.closest('[class*="field" i]'),
    element.parentElement
  ]

  for (const container of containers) {
    const text = getElementText(container)
    if (text) {
      return text.slice(0, 120)
    }
  }

  return ""
}

const buildDebugSnapshot = (task) => {
  const scan = scanPage()
  const allFields = uniqueElements([
    ...findEditableFields("title", ["标题", "商品标题", "title"]),
    ...findEditableFields("price", ["价格", "售价", "price"]),
    ...findEditableFields("stock", ["库存", "数量", "stock", "quantity"]),
    ...Object.values(ATTRIBUTE_ALIASES).flatMap((keywords) => findFieldsNearKeywords(keywords))
  ]).slice(0, 40)

  const fieldSnapshots = allFields.map((element) => ({
    kind: describeFieldKind(element),
    selectorHint: getSelectorHint(element),
    labelText: inferLabelText(element),
    placeholder: element.getAttribute("placeholder") ?? "",
    name: element.getAttribute("name") ?? "",
    tagName: element.tagName.toLowerCase()
  }))

  const skuRows = collectSkuRows().slice(0, 20).map((row) => ({
    rowText: row.text.slice(0, 180),
    priceFieldCount: row.priceFields.length,
    stockFieldCount: row.stockFields.length,
    inputCount: getEditableFromContainer(row.row).length
  }))

  const notes = []
  if (scan.skuRowCount === 0) {
    notes.push("当前页面未识别到 SKU 行，可能还没展开规格区域。")
  }
  if (scan.priceFieldCount === 0) {
    notes.push("当前页面未识别到价格字段。")
  }
  if (scan.stockFieldCount === 0) {
    notes.push("当前页面未识别到库存字段。")
  }
  if (panelState.pageProfile?.label) {
    notes.push(`页面类型识别：${panelState.pageProfile.label}`)
  }

  return {
    id: `snapshot-${Date.now()}`,
    taskId: task?.id ?? null,
    taskTitle: task?.product?.title ?? null,
    pageUrl: window.location.href,
    pageTitle: document.title,
    createdAt: new Date().toISOString(),
    summary: {
      titleFieldCount: scan.titleFieldCount,
      priceFieldCount: scan.priceFieldCount,
      stockFieldCount: scan.stockFieldCount,
      skuRowCount: scan.skuRowCount
    },
    fieldSnapshots,
    skuRows,
    notes
  }
}

const parseNumberFromText = (value) => {
  const matched = String(value ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/)
  return matched ? Number(matched[0]) : undefined
}

const getFieldValue = (element) => {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element.value?.trim() ?? ""
  }

  return ""
}

const collectImages = () => Array.from(document.querySelectorAll("img"))
  .filter(isVisible)
  .map((image) => image.currentSrc || image.src)
  .filter((src) => src && !src.startsWith("data:"))
  .slice(0, 20)

const collectImageStats = () => {
  const visibleImages = Array.from(document.querySelectorAll("img"))
    .filter(isVisible)
    .filter((image) => {
      const src = image.currentSrc || image.src
      return src && !src.startsWith("data:")
    })
    .slice(0, 50)

  const knownSizes = visibleImages
    .map((image) => ({
      width: image.naturalWidth || Math.round(image.getBoundingClientRect().width),
      height: image.naturalHeight || Math.round(image.getBoundingClientRect().height)
    }))
    .filter((size) => size.width > 0 && size.height > 0)

  if (knownSizes.length === 0) {
    return {
      minWidthPx: 0,
      minHeightPx: 0,
      maxWidthPx: 0,
      maxHeightPx: 0,
      unknownDimensionCount: visibleImages.length
    }
  }

  return {
    minWidthPx: Math.min(...knownSizes.map((size) => size.width)),
    minHeightPx: Math.min(...knownSizes.map((size) => size.height)),
    maxWidthPx: Math.max(...knownSizes.map((size) => size.width)),
    maxHeightPx: Math.max(...knownSizes.map((size) => size.height)),
    unknownDimensionCount: Math.max(0, visibleImages.length - knownSizes.length)
  }
}

const collectMediaToolSignals = () => {
  const text = document.body?.innerText ?? ""
  const signals = [
    ["图片翻译", "image translation"],
    ["翻译图片", "image translation"],
    ["翻译", "translation"],
    ["白底", "white background"],
    ["白底图", "white background"],
    ["小秘美图", "Xiaomi image editor"],
    ["美图", "image editor"],
    ["图片管理", "image management"],
    ["批量改大小", "batch resize"],
    ["改大小", "resize"],
    ["图片空间", "image space"]
  ]

  return Array.from(new Set(signals
    .filter(([keyword]) => text.includes(keyword))
    .map(([, signal]) => signal)))
}

const collectAttributeText = () => {
  const pageText = document.body?.innerText ?? ""
  const attributes = {}
  const patterns = [
    ["color", /(?:颜色|顏色|color)[:：\s]+([^\n;；,，]+)/i],
    ["size", /(?:尺码|尺寸|规格|size)[:：\s]+([^\n;；,，]+)/i],
    ["material", /(?:材质|材料|material)[:：\s]+([^\n;；,，]+)/i],
    ["brand", /(?:品牌|brand)[:：\s]+([^\n;；,，]+)/i]
  ]

  patterns.forEach(([key, pattern]) => {
    const matched = pageText.match(pattern)
    if (matched?.[1]) {
      attributes[key] = matched[1].trim().slice(0, 80)
    }
  })

  return attributes
}

const buildCollectionQuality = ({ title, images, skus }) => {
  const checks = [
    {
      id: "title",
      ok: Boolean(title && title.trim().length >= 4),
      message: title ? "title captured" : "title missing"
    },
    {
      id: "images",
      ok: images.length > 0,
      message: images.length > 0 ? `${images.length} images captured` : "images missing"
    },
    {
      id: "skus",
      ok: skus.length > 0,
      message: skus.length > 0 ? `${skus.length} sku rows captured` : "sku rows missing"
    },
    {
      id: "price",
      ok: skus.some((sku) => typeof sku.priceCny === "number" && sku.priceCny > 0),
      message: skus.some((sku) => typeof sku.priceCny === "number" && sku.priceCny > 0) ? "price captured" : "price missing"
    },
    {
      id: "stock",
      ok: skus.some((sku) => typeof sku.stock === "number"),
      message: skus.some((sku) => typeof sku.stock === "number") ? "stock captured" : "stock missing"
    }
  ]
  const score = Math.round((checks.filter((check) => check.ok).length / checks.length) * 100)

  return {
    status: score >= 80 ? "ready" : score >= 50 ? "partial" : "poor",
    score,
    checks
  }
}

const buildCollectedProduct = () => {
  const scan = scanPage()
  const titleField = findEditableFields("title", ["标题", "商品标题", "title"])[0]
  const title = getFieldValue(titleField) || document.querySelector("h1")?.textContent?.trim() || document.title || "Dianxiaomi collected product"
  const skuRows = collectSkuRows()
  const skus = skuRows.map((row, index) => {
    const priceValue = row.priceFields.map(getFieldValue).find(Boolean) || row.text
    const stockValue = row.stockFields.map(getFieldValue).find(Boolean) || row.text
    const rowText = row.text || `SKU ${index + 1}`

    return {
      skuName: rowText.slice(0, 80) || `SKU ${index + 1}`,
      priceCny: parseNumberFromText(priceValue),
      stock: Math.max(0, Math.floor(parseNumberFromText(stockValue) ?? 0)),
      attributes: {},
      rowText: rowText.slice(0, 240)
    }
  })

  if (skus.length === 0) {
    const priceField = findEditableFields("price", ["价格", "售价", "price"])[0]
    const stockField = findEditableFields("stock", ["库存", "数量", "stock", "quantity"])[0]
    skus.push({
      skuName: "默认规格",
      priceCny: parseNumberFromText(getFieldValue(priceField)),
      stock: Math.max(0, Math.floor(parseNumberFromText(getFieldValue(stockField)) ?? 0)),
      attributes: {},
      rowText: ""
    })
  }

  const images = collectImages()
  const quality = buildCollectionQuality({
    title,
    images,
    skus
  })

  return {
    id: `dxm-collected-${Date.now()}`,
    pageUrl: window.location.href,
    pageTitle: document.title,
    collectedAt: new Date().toISOString(),
    quality,
    title: title.slice(0, 180),
    category: panelState.pageProfile?.label || "Dianxiaomi collected",
    sourceUrl: window.location.href,
    images,
    attributes: collectAttributeText(),
    skus,
    rawTextSample: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 2000),
    notes: [
      `page profile: ${panelState.pageProfile?.label ?? "unknown"}`,
      `fields title ${scan.titleFieldCount}, price ${scan.priceFieldCount}, stock ${scan.stockFieldCount}, sku rows ${scan.skuRowCount}`
    ]
  }
}

const buildProductWorkItem = () => {
  const scan = scanPage()
  const titleField = findEditableFields("title", ["鏍囬", "鍟嗗搧鏍囬", "title"])[0]
  const title = getFieldValue(titleField) || document.querySelector("h1")?.textContent?.trim() || document.title || "Dianxiaomi product"
  const attributes = collectAttributeText()
  const images = collectImages()
  const skuRows = collectSkuRows()

  return {
    id: `dxm-work-${Date.now()}`,
    source: "dianxiaomi",
    pageUrl: window.location.href,
    pageTitle: document.title,
    pageProfile: panelState.pageProfile?.label || "Dianxiaomi product",
    title: title.slice(0, 180),
    rawTextSample: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 2000),
    notes: [
      "Source product remains in Dianxiaomi; this item tracks required edits before Temu listing.",
      `page profile: ${panelState.pageProfile?.label ?? "unknown"}`,
      `fields title ${scan.titleFieldCount}, price ${scan.priceFieldCount}, stock ${scan.stockFieldCount}, sku rows ${scan.skuRowCount}`
    ],
    snapshot: {
      hasTitle: Boolean(title.trim()),
      imageCount: images.length,
      skuCount: skuRows.length,
      priceFieldCount: scan.priceFieldCount,
      stockFieldCount: scan.stockFieldCount,
      attributeKeys: Object.keys(attributes),
      imageStats: collectImageStats(),
      mediaToolSignals: collectMediaToolSignals()
    }
  }
}

const queueCollectedProductWorkItem = async () => {
  const collectedProduct = buildCollectedProduct()
  const collectedResponse = await sendRuntimeMessage("temu-ai/upload-collected-product", collectedProduct)
  const workItem = buildProductWorkItem()

  if (collectedResponse?.product?.id) {
    workItem.collectedProductId = collectedResponse.product.id
  }

  const workItemResponse = await sendRuntimeMessage("temu-ai/upload-product-work-item", workItem)
  return {
    ok: Boolean(workItemResponse?.ok),
    collectedProduct: collectedResponse?.product ?? null,
    workItem: workItemResponse?.workItem ?? null
  }
}

const sendRuntimeMessage = (type, payload) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ type, payload }, (response) => {
    if (chrome.runtime.lastError) {
      reject(new Error(chrome.runtime.lastError.message))
      return
    }

    if (response?.ok === false) {
      reject(new Error(response.message ?? "Runtime request failed"))
      return
    }

    resolve(response)
  })
})

const switchDianxiaomiStore = async ({ storeId, storeName }) => {
  const siteContext = getSiteContext()
  if (siteContext.platform !== "dianxiaomi") {
    return {
      ok: false,
      message: "当前页不是店小秘页面"
    }
  }

  const normalizedTargetStoreName = normalizeStoreValue(storeName)
  const normalizedTargetStoreId = normalizeStoreValue(storeId)
  if (!normalizedTargetStoreName && !normalizedTargetStoreId) {
    return {
      ok: false,
      message: "缺少店铺信息"
    }
  }

  const currentContext = getCurrentPageContext()
  const alreadySelected = (normalizedTargetStoreId && currentContext?.storeId === normalizedTargetStoreId)
    || (normalizedTargetStoreName && normalizeText(currentContext?.storeName) === normalizeText(normalizedTargetStoreName))
  if (alreadySelected) {
    return {
      ok: true,
      changed: false,
      context: currentContext
    }
  }

  const matchedOption = collectStoreFilterOptions().find((option) =>
    (normalizedTargetStoreId && option.storeId === normalizedTargetStoreId)
    || (normalizedTargetStoreName && normalizeText(option.storeName) === normalizeText(normalizedTargetStoreName))
  )

  if (!matchedOption?.element) {
    return {
      ok: false,
      message: `未找到店铺：${normalizedTargetStoreName || normalizedTargetStoreId}`
    }
  }

  const previousSignature = buildPageContextSignature(currentContext)
  matchedOption.element.scrollIntoView({ block: "center", inline: "center" })
  matchedOption.element.click()
  const switchedContext = await waitForStoreContextChange(previousSignature)
  panelState.lastPageContextSignature = null
  const syncResponse = await syncCurrentPageContext({ force: true })
  await refreshTask()

  return {
    ok: true,
    changed: true,
    context: syncResponse?.context ?? switchedContext ?? getCurrentPageContext()
  }
}

const syncCurrentPageContext = async ({ force = false } = {}) => {
  const context = getCurrentPageContext()
  if (!context) {
    return null
  }

  const signature = buildPageContextSignature(context)

  if (!force && panelState.lastPageContextSignature === signature) {
    return null
  }

  panelState.lastPageContextSignature = signature
  try {
    return await sendRuntimeMessage("temu-ai/upload-page-context", context)
  } catch (error) {
    console.warn("[Temu AI Plugin] page context sync failed", error)
    return null
  }
}

renderPanel()
panelState.scan = scanPage()
void syncCurrentPageContext({ force: true })
void refreshTask()
window.setInterval(() => {
  void refreshUnattendedStatus()
}, 30000)
window.setInterval(() => {
  void syncCurrentPageContext()
}, 5000)
window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return
  }

  if (event.data?.type !== "temu-ai/dashboard-command") {
    return
  }

  if (event.data?.payload?.action !== "switch-dianxiaomi-store") {
    return
  }

  void sendRuntimeMessage("temu-ai/switch-dianxiaomi-store", event.data.payload)
    .then((result) => {
      window.postMessage({
        type: "temu-ai/dashboard-command-result",
        payload: {
          action: event.data.payload.action,
          result: {
            ok: true,
            ...(result?.result ?? {}),
            payload: event.data.payload
          }
        }
      }, window.location.origin)
    })
    .catch((error) => {
      window.postMessage({
        type: "temu-ai/dashboard-command-result",
        payload: {
          action: event.data.payload.action,
          result: {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
            payload: event.data.payload
          }
        }
      }, window.location.origin)
    })
})
window.addEventListener("hashchange", () => {
  void syncCurrentPageContext({ force: true })
})
window.addEventListener("popstate", () => {
  void syncCurrentPageContext({ force: true })
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "temu-ai/switch-dianxiaomi-store") {
    return false
  }

  switchDianxiaomiStore(message.payload ?? {})
    .then((result) => {
      sendResponse({
        ok: result.ok,
        changed: result.changed ?? false,
        context: result.context ?? null,
        message: result.message
      })
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      })
    })

  return true
})
