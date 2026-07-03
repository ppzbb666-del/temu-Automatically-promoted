import type {
  AutomationDryRunStartInput,
  AutomationLaunchPreset,
  AutomationLaunchPresetDeleteResult,
  AutomationLaunchPresetInput,
  AutomationLaunchPresetUpdateInput
} from "@temu-ai-ops/shared"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const getRepoRoot = () => {
  const currentFile = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(currentFile), "../../..")
}

// Honors AUTOMATION_PRESET_PATH for test/smoke isolation, matching the
// convention used by every other persisted store (PLANNER_STATE_PATH,
// QUEUE_DAEMON_STATE_PATH, the ledgers, etc.).
const getPresetPath = () =>
  process.env.AUTOMATION_PRESET_PATH ?? path.join(getRepoRoot(), ".runtime/automation-launch-presets.json")

const timestampId = () => new Date().toISOString().replace(/[:.]/g, "-")

const normalizeInput = (input: AutomationDryRunStartInput = {}): AutomationDryRunStartInput => ({
  url: input.url?.trim() || undefined,
  taskFile: input.taskFile?.trim() || undefined,
  selectorConfig: input.selectorConfig?.trim() || undefined,
  profile: input.profile?.trim() || undefined,
  screenshots: input.screenshots?.trim() || undefined,
  headed: input.headed,
  mediaAutomationMode: input.mediaAutomationMode,
  mediaAutomationTools: input.mediaAutomationTools?.map((tool) => tool.trim()).filter(Boolean),
  submitAfterSave: input.submitAfterSave,
  submitMaxAttempts: input.submitMaxAttempts
})

const readPresets = (): AutomationLaunchPreset[] => {
  const presetPath = getPresetPath()
  if (!existsSync(presetPath)) {
    return []
  }

  try {
    const parsed = JSON.parse(readFileSync(presetPath, "utf8")) as AutomationLaunchPreset[]
    return Array.isArray(parsed)
      ? parsed.map((preset) => ({
          id: preset.id,
          name: preset.name,
          input: normalizeInput(preset.input),
          createdAt: preset.createdAt,
          updatedAt: preset.updatedAt
        })).filter((preset) => preset.id && preset.name)
      : []
  } catch {
    return []
  }
}

const writePresets = (presets: AutomationLaunchPreset[]) => {
  const presetPath = getPresetPath()
  mkdirSync(path.dirname(presetPath), {
    recursive: true
  })
  writeFileSync(presetPath, JSON.stringify(presets, null, 2), "utf8")
}

export const listAutomationLaunchPresets = (): AutomationLaunchPreset[] =>
  readPresets().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

export const createAutomationLaunchPreset = (input: AutomationLaunchPresetInput): AutomationLaunchPreset => {
  const createdAt = new Date().toISOString()
  const preset: AutomationLaunchPreset = {
    id: `automation-preset-${timestampId()}-${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim(),
    input: normalizeInput(input.input),
    createdAt,
    updatedAt: createdAt
  }
  const presets = [preset, ...readPresets()]
  writePresets(presets)
  return preset
}

export const updateAutomationLaunchPreset = (
  id: string,
  input: AutomationLaunchPresetUpdateInput
): AutomationLaunchPreset | null => {
  const presets = readPresets()
  const index = presets.findIndex((preset) => preset.id === id)
  if (index < 0) {
    return null
  }

  const current = presets[index]
  const updated: AutomationLaunchPreset = {
    ...current,
    name: input.name?.trim() || current.name,
    input: input.input ? normalizeInput(input.input) : current.input,
    updatedAt: new Date().toISOString()
  }

  presets[index] = updated
  writePresets(presets)
  return updated
}

export const deleteAutomationLaunchPreset = (id: string): AutomationLaunchPresetDeleteResult | null => {
  const presets = readPresets()
  const nextPresets = presets.filter((preset) => preset.id !== id)
  if (nextPresets.length === presets.length) {
    return null
  }

  writePresets(nextPresets)
  return {
    id,
    deleted: true
  }
}
