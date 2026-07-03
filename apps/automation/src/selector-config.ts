import { existsSync, readFileSync } from "node:fs"
import type { Locator, Page } from "playwright"
import { firstVisible } from "./common"
import type { FieldKind } from "./adapters/dianxiaomi-adapter"

export type DianxiaomiSelectorConfig = {
  fields?: Partial<Record<FieldKind, string[]>>
  buttons?: Partial<Record<"save" | "submit", string[]>>
  mediaTools?: Partial<Record<"imageTranslation" | "whiteBackground" | "imageEditor" | "batchResize" | "imageManagement", string[]>>
  mediaToolActions?: Partial<Record<"apply" | "close", Partial<Record<"imageTranslation" | "whiteBackground" | "imageEditor" | "batchResize" | "imageManagement", string[]>>>>
  skuRows?: string[]
}

const normalizeSelectorList = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : []

export const loadSelectorConfig = (configPath: string | undefined): DianxiaomiSelectorConfig => {
  if (!configPath || !existsSync(configPath)) {
    return {}
  }

  const raw = JSON.parse(readFileSync(configPath, "utf8")) as DianxiaomiSelectorConfig
  return {
    fields: {
      title: normalizeSelectorList(raw.fields?.title),
      description: normalizeSelectorList(raw.fields?.description),
      price: normalizeSelectorList(raw.fields?.price),
      stock: normalizeSelectorList(raw.fields?.stock),
      attribute: normalizeSelectorList(raw.fields?.attribute)
    },
    buttons: {
      save: normalizeSelectorList(raw.buttons?.save),
      submit: normalizeSelectorList(raw.buttons?.submit)
    },
    mediaTools: {
      imageTranslation: normalizeSelectorList(raw.mediaTools?.imageTranslation),
      whiteBackground: normalizeSelectorList(raw.mediaTools?.whiteBackground),
      imageEditor: normalizeSelectorList(raw.mediaTools?.imageEditor),
      batchResize: normalizeSelectorList(raw.mediaTools?.batchResize),
      imageManagement: normalizeSelectorList(raw.mediaTools?.imageManagement)
    },
    mediaToolActions: {
      apply: {
        imageTranslation: normalizeSelectorList(raw.mediaToolActions?.apply?.imageTranslation),
        whiteBackground: normalizeSelectorList(raw.mediaToolActions?.apply?.whiteBackground),
        imageEditor: normalizeSelectorList(raw.mediaToolActions?.apply?.imageEditor),
        batchResize: normalizeSelectorList(raw.mediaToolActions?.apply?.batchResize),
        imageManagement: normalizeSelectorList(raw.mediaToolActions?.apply?.imageManagement)
      },
      close: {
        imageTranslation: normalizeSelectorList(raw.mediaToolActions?.close?.imageTranslation),
        whiteBackground: normalizeSelectorList(raw.mediaToolActions?.close?.whiteBackground),
        imageEditor: normalizeSelectorList(raw.mediaToolActions?.close?.imageEditor),
        batchResize: normalizeSelectorList(raw.mediaToolActions?.close?.batchResize),
        imageManagement: normalizeSelectorList(raw.mediaToolActions?.close?.imageManagement)
      }
    },
    skuRows: normalizeSelectorList(raw.skuRows)
  }
}

export const findByConfiguredSelectors = async (page: Page, selectors: string[] | undefined): Promise<Locator | null> => {
  if (!selectors?.length) {
    return null
  }

  return firstVisible(selectors.map((selector) => page.locator(selector)))
}
