import type { DianxiaomiSelectorConfig, SelectorConfigChangeRisk, SelectorConfigDiffEntry, SelectorConfigDiffResult, SelectorWorkbench } from "@temu-ai-ops/shared"

const selectorFieldKeys = ["title", "description", "price", "stock", "attribute"] as const
const selectorButtonKeys = ["save", "submit"] as const
const selectorMediaToolKeys = ["imageTranslation", "whiteBackground", "imageEditor", "batchResize", "imageManagement"] as const
const selectorMediaToolActionKeys = ["apply", "close"] as const
const requiredSelectorFields = ["title", "description", "price", "stock"] as const
const requiredSelectorButtons = ["save"] as const

export const defaultSkuRowSelector = "tr, [role='row'], [class*='sku' i], [class*='table-row' i], [class*='row' i]"

export const isFieldOrButtonSelectorItem = (
  item: SelectorWorkbench["items"][number]
): item is SelectorWorkbench["items"][number] & { group: "fields" | "buttons" } =>
  item.group === "fields" || item.group === "buttons"

export const normalizeSelectorList = (selectors: string[] | undefined) =>
  Array.from(new Set((selectors ?? []).map((selector) => selector.trim()).filter(Boolean)))

export const cloneSelectorConfig = (config: DianxiaomiSelectorConfig | null | undefined): DianxiaomiSelectorConfig => ({
  fields: Object.fromEntries(Object.entries(config?.fields ?? {}).map(([key, selectors]) => [key, normalizeSelectorList(selectors)])),
  buttons: Object.fromEntries(Object.entries(config?.buttons ?? {}).map(([key, selectors]) => [key, normalizeSelectorList(selectors)])),
  mediaTools: Object.fromEntries(Object.entries(config?.mediaTools ?? {}).map(([key, selectors]) => [key, normalizeSelectorList(selectors)])),
  mediaToolActions: Object.fromEntries(Object.entries(config?.mediaToolActions ?? {}).map(([action, tools]) => [
    action,
    Object.fromEntries(Object.entries(tools ?? {}).map(([key, selectors]) => [key, normalizeSelectorList(selectors)]))
  ])),
  skuRows: normalizeSelectorList(config?.skuRows)
})

export const createSelectorConfigDraft = (workbench: SelectorWorkbench): DianxiaomiSelectorConfig => {
  const draft = cloneSelectorConfig(workbench.config.config)

  for (const item of workbench.items.filter(isFieldOrButtonSelectorItem)) {
    const currentSelectors = normalizeSelectorList(draft[item.group][item.key])
    draft[item.group][item.key] = currentSelectors.length > 0
      ? currentSelectors
      : normalizeSelectorList([item.recommendedSelector ?? ""])
  }

  for (const item of workbench.mediaTools ?? []) {
    const currentSelectors = normalizeSelectorList(draft.mediaTools?.[item.key])
    draft.mediaTools = {
      ...draft.mediaTools,
      [item.key]: currentSelectors.length > 0
        ? currentSelectors
        : normalizeSelectorList([item.recommendedSelector ?? ""])
    }
  }

  for (const item of workbench.mediaToolActions ?? []) {
    const [action, toolKey] = item.key.split(".")
    if (!action || !toolKey) {
      continue
    }
    const currentSelectors = normalizeSelectorList(draft.mediaToolActions?.[action]?.[toolKey])
    draft.mediaToolActions = {
      ...draft.mediaToolActions,
      [action]: {
        ...(draft.mediaToolActions?.[action] ?? {}),
        [toolKey]: currentSelectors.length > 0
          ? currentSelectors
          : normalizeSelectorList([item.recommendedSelector ?? ""])
      }
    }
  }

  if (draft.skuRows.length === 0 && workbench.skuRows.diagnosisOk) {
    draft.skuRows = [defaultSkuRowSelector]
  }

  return draft
}

export const selectorOptions = (configuredSelectors: string[], candidates: Array<{ selectorHint: string }>, recommendedSelector: string | null) =>
  normalizeSelectorList([
    ...configuredSelectors,
    recommendedSelector ?? "",
    ...candidates.map((candidate) => candidate.selectorHint)
  ])

export const updateSelectorDraftItem = (
  current: DianxiaomiSelectorConfig | null,
  group: "fields" | "buttons" | "mediaTools",
  key: string,
  selector: string
): DianxiaomiSelectorConfig => {
  const next = cloneSelectorConfig(current)
  next[group] = {
    ...next[group],
    [key]: selector ? [selector] : []
  }
  return next
}

export const updateSelectorDraftMediaAction = (
  current: DianxiaomiSelectorConfig | null,
  action: string,
  toolKey: string,
  selector: string
): DianxiaomiSelectorConfig => {
  const next = cloneSelectorConfig(current)
  next.mediaToolActions = {
    ...next.mediaToolActions,
    [action]: {
      ...(next.mediaToolActions?.[action] ?? {}),
      [toolKey]: selector ? [selector] : []
    }
  }
  return next
}

export const updateSelectorDraftSkuRows = (current: DianxiaomiSelectorConfig | null, selector: string): DianxiaomiSelectorConfig => ({
  ...cloneSelectorConfig(current),
  skuRows: selector ? [selector] : []
})

const criticalSelectorEntry = (entry: SelectorConfigDiffEntry) =>
  (entry.group === "fields" && requiredSelectorFields.includes(entry.key as typeof requiredSelectorFields[number]))
    || (entry.group === "buttons" && requiredSelectorButtons.includes(entry.key as typeof requiredSelectorButtons[number]))

const diffSelectorList = (
  group: SelectorConfigDiffEntry["group"],
  key: string,
  currentSelectors: string[],
  nextSelectors: string[]
): SelectorConfigDiffEntry => {
  const addedSelectors = nextSelectors.filter((selector) => !currentSelectors.includes(selector))
  const removedSelectors = currentSelectors.filter((selector) => !nextSelectors.includes(selector))
  const unchangedSelectors = nextSelectors.filter((selector) => currentSelectors.includes(selector))
  const status: SelectorConfigDiffEntry["status"] =
    addedSelectors.length === 0 && removedSelectors.length === 0 ? "unchanged"
      : currentSelectors.length === 0 && nextSelectors.length > 0 ? "added"
        : currentSelectors.length > 0 && nextSelectors.length === 0 ? "removed"
          : "changed"

  return {
    group,
    key,
    status,
    currentSelectors,
    nextSelectors,
    addedSelectors,
    removedSelectors,
    unchangedSelectors
  }
}

const buildSelectorConfigChangeRisks = (entries: SelectorConfigDiffEntry[]): SelectorConfigChangeRisk[] =>
  entries.flatMap<SelectorConfigChangeRisk>((entry) => {
    if (!criticalSelectorEntry(entry) || entry.status === "unchanged") {
      return []
    }

    if (entry.nextSelectors.length === 0) {
      return [{
        id: `selector-${entry.group}-${entry.key}-blocked-empty`,
        level: "block" as const,
        group: entry.group,
        key: entry.key,
        message: `critical selector would be empty: ${entry.group}.${entry.key}`,
        currentSelectors: entry.currentSelectors,
        nextSelectors: entry.nextSelectors,
        addedSelectors: entry.addedSelectors,
        removedSelectors: entry.removedSelectors
      }]
    }

    if (entry.removedSelectors.length > 0 || entry.addedSelectors.length > 0) {
      return [{
        id: `selector-${entry.group}-${entry.key}-confirm-change`,
        level: "confirm" as const,
        group: entry.group,
        key: entry.key,
        message: `critical selector will change: ${entry.group}.${entry.key}`,
        currentSelectors: entry.currentSelectors,
        nextSelectors: entry.nextSelectors,
        addedSelectors: entry.addedSelectors,
        removedSelectors: entry.removedSelectors
      }]
    }

    return []
  })

export const buildSelectorConfigDiffPreview = (
  currentConfig: DianxiaomiSelectorConfig | null | undefined,
  nextConfig: DianxiaomiSelectorConfig,
  configPath = "",
  currentExists = Boolean(currentConfig)
): SelectorConfigDiffResult => {
  const current = cloneSelectorConfig(currentConfig)
  const next = cloneSelectorConfig(nextConfig)
  const fieldKeys = Array.from(new Set([...selectorFieldKeys, ...Object.keys(current.fields), ...Object.keys(next.fields)]))
  const buttonKeys = Array.from(new Set([...selectorButtonKeys, ...Object.keys(current.buttons), ...Object.keys(next.buttons)]))
  const mediaToolKeys = Array.from(new Set([
    ...selectorMediaToolKeys,
    ...Object.keys(current.mediaTools ?? {}),
    ...Object.keys(next.mediaTools ?? {})
  ]))
  const mediaToolActionKeys = Array.from(new Set([
    ...selectorMediaToolActionKeys,
    ...Object.keys(current.mediaToolActions ?? {}),
    ...Object.keys(next.mediaToolActions ?? {})
  ])).flatMap((action) => Array.from(new Set([
    ...selectorMediaToolKeys,
    ...Object.keys(current.mediaToolActions?.[action] ?? {}),
    ...Object.keys(next.mediaToolActions?.[action] ?? {})
  ])).map((tool) => ({
    key: `${action}.${tool}`,
    currentSelectors: current.mediaToolActions?.[action]?.[tool] ?? [],
    nextSelectors: next.mediaToolActions?.[action]?.[tool] ?? []
  })))
  const entries = [
    ...fieldKeys.map((key) => diffSelectorList("fields", key, current.fields[key] ?? [], next.fields[key] ?? [])),
    ...buttonKeys.map((key) => diffSelectorList("buttons", key, current.buttons[key] ?? [], next.buttons[key] ?? [])),
    ...mediaToolKeys.map((key) => diffSelectorList("mediaTools", key, current.mediaTools?.[key] ?? [], next.mediaTools?.[key] ?? [])),
    ...mediaToolActionKeys.map((item) => diffSelectorList("mediaToolActions", item.key, item.currentSelectors, item.nextSelectors)),
    diffSelectorList("skuRows", "skuRows", current.skuRows, next.skuRows)
  ]
  const risks = buildSelectorConfigChangeRisks(entries)

  return {
    checkedAt: new Date().toISOString(),
    configPath,
    currentExists,
    entries,
    risks,
    requiresConfirmation: risks.some((risk) => risk.level === "confirm"),
    blocked: risks.some((risk) => risk.level === "block"),
    summary: {
      totalCount: entries.length,
      changedCount: entries.filter((entry) => entry.status === "changed").length,
      addedCount: entries.filter((entry) => entry.status === "added").length,
      removedCount: entries.filter((entry) => entry.status === "removed").length,
      unchangedCount: entries.filter((entry) => entry.status === "unchanged").length,
      confirmRiskCount: risks.filter((risk) => risk.level === "confirm").length,
      blockRiskCount: risks.filter((risk) => risk.level === "block").length
    }
  }
}

export const selectorDiffChangeCount = (diff: SelectorConfigDiffResult) =>
  diff.summary.changedCount + diff.summary.addedCount + diff.summary.removedCount
