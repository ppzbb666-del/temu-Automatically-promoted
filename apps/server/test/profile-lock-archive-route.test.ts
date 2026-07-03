import { strict as assert } from "node:assert"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

type ArchiveReadiness = {
  status: "ready" | "blocked" | "idle"
  profilePath: string | null
  archiveDirectory: string | null
  readyItems: Array<{
    fileName: string
    archiveTarget: string
  }>
  blockedItems: unknown[]
}

type ArchiveResult = {
  status: "archived" | "blocked" | "idle"
  profilePath: string | null
  archiveDirectory: string | null
  archivedItems: Array<{
    fileName: string
    archiveTarget: string
  }>
  blockedItems: unknown[]
  message: string
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const testRoot = path.join(
  tmpdir(),
  `temu-ai-ops-profile-lock-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
)
const port = 19_500 + Math.floor(Math.random() * 1_000)
const baseUrl = `http://127.0.0.1:${port}`
const profileLockLedgerPath = path.join(testRoot, "profile-lock-ledger.json")

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init)
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} failed: ${response.status} ${body}`)
  }

  return body ? JSON.parse(body) as T : undefined as T
}

const startServer = () => {
  const tsxCliPath = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs")
  assert(existsSync(tsxCliPath), `tsx CLI not found: ${tsxCliPath}`)

  return spawn(process.execPath, [tsxCliPath, path.join(repoRoot, "apps/server/src/index.ts")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      QUEUE_DAEMON_STATE_PATH: path.join(testRoot, "queue-daemon-state.json"),
      RECOVERY_RUN_HISTORY_PATH: path.join(testRoot, "recovery-runs.json"),
      MANUAL_BUDGET_PROOF_LEDGER_PATH: path.join(testRoot, "manual-budget-proof-ledger.json"),
      MANUAL_BUDGET_TRIAL_HISTORY_PATH: path.join(testRoot, "manual-budget-trials.json"),
      PROFILE_LOCK_LEDGER_PATH: profileLockLedgerPath,
      PLANNER_STATE_PATH: path.join(testRoot, "planner-state.json"),
      TASK_EXPORT_HISTORY_PATH: path.join(testRoot, "automation-task-exports.json"),
      SELECTOR_DIAGNOSIS_DIRS: path.join(testRoot, "selector-diagnoses")
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  })
}

const stopServer = async (server: ChildProcessWithoutNullStreams) => {
  if (server.exitCode !== null || server.signalCode !== null) {
    return
  }

  server.kill()
  await new Promise<void>((resolve) => {
    server.once("exit", () => resolve())
    setTimeout(resolve, 3_000)
  })
}

const waitForHealth = async (server: ChildProcessWithoutNullStreams, logs: string[]) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`server exited before health check passed: ${logs.join("\n")}`)
    }

    try {
      await requestJson(`${baseUrl}/health`)
      return
    } catch {
      await sleep(200)
    }
  }

  throw new Error(`server did not become healthy at ${baseUrl}: ${logs.join("\n")}`)
}

rmSync(testRoot, { recursive: true, force: true })
mkdirSync(testRoot, { recursive: true })

const server = startServer()
const logs: string[] = []
server.stdout.on("data", (chunk) => logs.push(String(chunk)))
server.stderr.on("data", (chunk) => logs.push(String(chunk)))

try {
  await waitForHealth(server, logs)

  const blockedArchive = await requestJson<ArchiveResult>(`${baseUrl}/automation/profile-locks/archive`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: "{}"
  })
  assert.equal(blockedArchive.status, "blocked", "archive route should block when no profile is configured")
  assert.equal(blockedArchive.profilePath, null, "blocked archive route should not invent a profile path")

  const profilePath = path.join(testRoot, "\u5e97\u5c0f\u79d8-profile-lock", "chrome-profile")
  mkdirSync(profilePath, { recursive: true })
  const lockPath = path.join(profilePath, "SingletonLock")
  writeFileSync(lockPath, "stale route fixture lock", "utf8")
  const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000)
  utimesSync(lockPath, staleTime, staleTime)

  const query = new URLSearchParams({
    profile: profilePath,
    limit: "1"
  })
  const readiness = await requestJson<ArchiveReadiness>(`${baseUrl}/automation/profile-locks/archive-readiness?${query}`)
  assert.equal(readiness.status, "ready", "HTTP archive readiness should preserve profile query input")
  assert.equal(readiness.profilePath, profilePath, "HTTP readiness should preserve UTF-8 profile paths")
  assert.equal(readiness.readyItems.length, 1, "HTTP readiness should expose the stale lock")
  assert.equal(readiness.readyItems[0]?.fileName, "SingletonLock", "HTTP readiness should name the stale lock")
  assert(existsSync(lockPath), "HTTP readiness must not move the stale lock")

  const archive = await requestJson<ArchiveResult>(`${baseUrl}/automation/profile-locks/archive`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      profile: profilePath,
      limit: 1
    })
  })
  assert.equal(archive.status, "archived", `HTTP archive should move stale locks: ${archive.message}`)
  assert.equal(archive.profilePath, profilePath, "HTTP archive should preserve UTF-8 profile paths")
  assert.equal(archive.archivedItems.length, 1, "HTTP archive should return the archived lock")
  assert.equal(archive.archivedItems[0]?.fileName, "SingletonLock", "HTTP archive should name the archived lock")
  assert(!existsSync(lockPath), "HTTP archive should move the original lock file")
  assert(existsSync(archive.archivedItems[0]?.archiveTarget ?? ""), "HTTP archive should create the archive target")

  const afterArchive = await requestJson<ArchiveReadiness>(`${baseUrl}/automation/profile-locks/archive-readiness?${query}`)
  assert.equal(afterArchive.status, "idle", "HTTP archive should leave the profile archive-idle")
  assert.equal(afterArchive.readyItems.length, 0, "HTTP archive should clear ready archive items after moving the lock")
  assert.equal(afterArchive.blockedItems.length, 0, "HTTP archive should not leave blocked items after a clean move")

  const ledger = JSON.parse(readFileSync(profileLockLedgerPath, "utf8")) as {
    entries: Array<{ action: string; profilePath: string; fileName: string }>
  }
  assert(
    ledger.entries.some((entry) =>
      entry.action === "archived-stale-lock"
      && entry.profilePath === profilePath
      && entry.fileName === "SingletonLock"
    ),
    "HTTP archive should persist an archived-stale-lock audit entry"
  )
} finally {
  await stopServer(server)
}

console.log("profile lock archive route tests passed")
