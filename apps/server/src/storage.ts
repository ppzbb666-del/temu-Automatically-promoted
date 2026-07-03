import type {
  DianxiaomiCollectedProduct,
  DianxiaomiPageContext,
  DianxiaomiListingRequirementRules,
  DianxiaomiProductWorkItem,
  PricingRules,
  ProductCandidate,
  PublishTask
} from "@temu-ai-ops/shared"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"

export type PersistedPlannerState = {
  products: ProductCandidate[]
  tasks: PublishTask[]
  dianxiaomiCollectedProducts?: DianxiaomiCollectedProduct[]
  dianxiaomiProductWorkItems?: DianxiaomiProductWorkItem[]
  dianxiaomiPageContext?: DianxiaomiPageContext | null
  dianxiaomiRequirementRules?: DianxiaomiListingRequirementRules
  activeTaskId: string | null
  pricingRules?: PricingRules
  savedAt: string
}

const getRepoRoot = () => {
  const currentFile = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(currentFile), "../../..")
}

// The legacy JSON state path. Still honored via PLANNER_STATE_PATH so test
// isolation (which sets that env var to a per-test directory) keeps working.
const getLegacyJsonPath = () =>
  process.env.PLANNER_STATE_PATH ?? path.join(getRepoRoot(), ".runtime/data/planner-state.json")

// The SQLite database lives beside the legacy path, in the same (isolated)
// directory, but with a .sqlite suffix. We derive rather than reuse the exact
// path so we never try to open a legacy JSON file as a database.
const getDbPath = () => {
  const legacy = getLegacyJsonPath()
  return legacy.endsWith(".json") ? `${legacy.slice(0, -".json".length)}.sqlite` : `${legacy}.sqlite`
}

const STATE_KEY = "state"

let db: DatabaseSync | null = null

const getDb = (): DatabaseSync => {
  if (db) {
    return db
  }
  const dbPath = getDbPath()
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const database = new DatabaseSync(dbPath)
  // WAL: crash-safe and allows concurrent reads while a write is in flight.
  database.exec("PRAGMA journal_mode = WAL")
  database.exec("CREATE TABLE IF NOT EXISTS planner_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  db = database
  return database
}

// P2-3 (carried over from the JSON backend): tolerate a corrupt/partial state
// rather than crashing the server on startup. SQLite gives us atomic writes, so
// a half-written row can't happen; but a manually-edited or foreign value could
// still fail to parse, and we'd rather boot empty than not at all.
const parseStateValue = (value: string): PersistedPlannerState | null => {
  try {
    return JSON.parse(value) as PersistedPlannerState
  } catch (error) {
    console.warn(
      `planner state row is unreadable, starting from empty state: ${error instanceof Error ? error.message : String(error)}`
    )
    return null
  }
}

// One-time migration: if the DB has no state row yet but a legacy JSON state
// file exists (from a JSON-backend deployment or an existing test fixture),
// read it in and persist it to SQLite so historical state is not lost. Runs
// once — after the first save the DB row exists and the JSON file is ignored.
const migrateLegacyJsonState = (): PersistedPlannerState | null => {
  const legacyPath = getLegacyJsonPath()
  if (!existsSync(legacyPath)) {
    return null
  }
  let legacyState: PersistedPlannerState | null = null
  try {
    legacyState = JSON.parse(readFileSync(legacyPath, "utf8")) as PersistedPlannerState
  } catch (error) {
    console.warn(
      `legacy planner state file is unreadable, skipping migration: ${error instanceof Error ? error.message : String(error)}`
    )
    return null
  }
  writeState(legacyState)
  return legacyState
}

const writeState = (state: PersistedPlannerState) => {
  getDb()
    .prepare("INSERT INTO planner_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(STATE_KEY, JSON.stringify(state))
}

export const loadPlannerState = (): PersistedPlannerState | null => {
  const row = getDb().prepare("SELECT value FROM planner_kv WHERE key = ?").get(STATE_KEY) as
    | { value: string }
    | undefined
  if (row) {
    return parseStateValue(row.value)
  }
  return migrateLegacyJsonState()
}

export const savePlannerState = (state: Omit<PersistedPlannerState, "savedAt">) => {
  writeState({
    ...state,
    savedAt: new Date().toISOString()
  } as PersistedPlannerState)
}
