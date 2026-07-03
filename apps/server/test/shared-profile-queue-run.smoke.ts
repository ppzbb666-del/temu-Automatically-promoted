import { strict as assert } from "node:assert"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer } from "node:net"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"

type DianxiaomiProductWorkItem = {
  id: string
  status: string
}

type QueueRunStartResult = {
  id: string
  queued: number
  skipped: number
  flowJobIds: string[]
  skippedItems: Array<{
    workItemId: string
    reason: string
  }>
}

type FullFlowJob = {
  id: string
  status: "running" | "completed" | "failed"
  finishedAt: string | null
  error: string | null
  stages: Array<{
    name: "dry-run" | "fill-draft" | "save-draft" | "submit-listing"
    status: "pending" | "running" | "completed" | "failed" | "skipped"
    startedAt: string | null
    jobId: string | null
  }>
}

type JobLog = {
  stdout: string
  stderr: string
}

const repoRoot = path.resolve(process.cwd(), "../..")
const resolvePort = async () => {
  if (process.env.SMOKE_PORT) {
    return Number(process.env.SMOKE_PORT)
  }

  const server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("shared-profile smoke test could not resolve a free TCP port"))
        return
      }
      resolve(address.port)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  return port
}

const port = await resolvePort()
const baseUrl = `http://127.0.0.1:${port}`
const runId = new Date().toISOString().replace(/[:.]/g, "-")
const smokeRoot = `.runtime/shared-profile-queue-run-smoke/${runId}`
const fixturePath = path.join(repoRoot, ".runtime/dianxiaomi-dry-run-fixture.html")
const selectorConfig = ".runtime/dianxiaomi-selector-config.json"
const selectorConfigPath = path.join(repoRoot, selectorConfig)
const plannerStatePath = path.join(repoRoot, smokeRoot, "planner-state.json")

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init)
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} failed: ${response.status} ${body}`)
  }

  return body ? JSON.parse(body) as T : undefined as T
}

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await requestJson(`${baseUrl}/health`)
      return
    } catch {
      await sleep(250)
    }
  }

  throw new Error(`server did not become healthy at ${baseUrl}`)
}

const waitForFullFlowJob = async (id: string) => {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const job = await requestJson<FullFlowJob>(`${baseUrl}/automation/full-flow/jobs/${id}`)
    if (job.status !== "running") {
      return job
    }
    await sleep(1000)
  }

  throw new Error(`full-flow job timed out: ${id}`)
}

const startServer = () => {
  const tsxCliPath = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs")
  assert(existsSync(tsxCliPath), `tsx CLI not found: ${tsxCliPath}`)

  return spawn(process.execPath, [tsxCliPath, path.join(repoRoot, "apps/server/src/index.ts")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      PLANNER_STATE_PATH: plannerStatePath,
      QUEUE_DAEMON_STATE_PATH: path.join(repoRoot, smokeRoot, "queue-daemon-state.json"),
      TASK_EXPORT_HISTORY_PATH: path.join(repoRoot, smokeRoot, "automation-task-exports.json"),
      SELECTOR_DIAGNOSIS_DIRS: path.join(repoRoot, smokeRoot),
      ALLOW_DIANXIAOMI_SMOKE_URLS: "true"
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
    setTimeout(resolve, 5000)
  })
}

const main = async () => {
  assert(existsSync(fixturePath), `fixture not found: ${fixturePath}`)
  assert(existsSync(selectorConfigPath), `selector config not found: ${selectorConfigPath}`)

  const fixtureHtml = readFileSync(fixturePath, "utf8")
  const fixtureUrl = `data:text/html;charset=utf-8,${encodeURIComponent(fixtureHtml)}`
  const profilePath = path.join(repoRoot, smokeRoot, "shared-profile")
  const screenshots = `${smokeRoot}/queue-run`
  const scopedStoreId = `shared-profile-store-${runId}`
  const scopedStoreName = `Shared Profile Store ${runId}`
  mkdirSync(profilePath, { recursive: true })
  mkdirSync(path.join(repoRoot, screenshots), { recursive: true })

  const server = startServer()
  let serverStdout = ""
  let serverStderr = ""
  server.stdout.on("data", (chunk: Buffer) => {
    serverStdout += chunk.toString("utf8")
  })
  server.stderr.on("data", (chunk: Buffer) => {
    serverStderr += chunk.toString("utf8")
  })

  try {
    await waitForHealth()

    const createdItems = await Promise.all([0, 1, 2].map((index) =>
      requestJson<DianxiaomiProductWorkItem>(`${baseUrl}/dianxiaomi/product-work-items`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id: `shared-profile-queue-run-work-item-${runId}-${index}`,
          storeId: scopedStoreId,
          storeName: scopedStoreName,
          pageUrl: `${fixtureUrl}#shared-profile-${index}`,
          pageTitle: `Shared profile queue-run fixture ${index}`,
          title: `Shared profile queue-run item ${index}`,
          rawTextSample: "Shared profile queue-run fixture with SKU, price, stock, and image tools",
          notes: ["shared-profile smoke"],
          snapshot: {
            hasTitle: true,
            imageCount: 2,
            skuCount: 1,
            priceFieldCount: 1,
            stockFieldCount: 1,
            attributeKeys: ["color"],
            imageStats: {
              minWidthPx: 1000,
              minHeightPx: 1000,
              maxWidthPx: 1200,
              maxHeightPx: 1200,
              unknownDimensionCount: 0
            },
            mediaToolSignals: ["image translation", "image editor", "batch resize"]
          },
          status: "ready-for-automation"
        })
      })
    ))
    assert(createdItems.every((item) => item.status === "ready-for-automation"), "shared-profile queue-run fixtures should start ready")

    const queueRun = await requestJson<QueueRunStartResult>(`${baseUrl}/automation/queue-run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        headed: false,
        profile: `${smokeRoot}/shared-profile`,
        screenshots,
        selectorConfig,
        mediaAutomationMode: "unattended-apply",
        mediaAutomationTools: ["image-translation"],
        storeId: scopedStoreId,
        storeName: scopedStoreName,
        limit: 3
      })
    })

    assert.equal(queueRun.queued, 3, `queue-run should start all three scoped items. skipped: ${JSON.stringify(queueRun.skippedItems)}`)
    assert.equal(queueRun.flowJobIds.length, 3, "queue-run should return three full-flow job ids")

    const jobs = await Promise.all(queueRun.flowJobIds.map((id) => waitForFullFlowJob(id)))
    assert(
      jobs.every((job) => job.status !== "running"),
      `shared-profile queue-run should reach a terminal state without hanging. jobs: ${JSON.stringify(jobs.map((job) => ({ id: job.id, status: job.status, error: job.error })))}
server stderr:
${serverStderr}`
    )

    const collisionPattern = /launchPersistentContext|Target page, context or browser has been closed/i
    for (const job of jobs) {
      const dryRunStage = job.stages.find((stage) => stage.name === "dry-run")
      assert(dryRunStage?.jobId, `shared-profile queue-run should record dry-run job id for ${job.id}`)
      const dryRunLog = await requestJson<JobLog>(`${baseUrl}/automation/dry-run/jobs/${dryRunStage.jobId}/logs?maxChars=4000`)
      assert(
        !collisionPattern.test(`${job.error ?? ""}\n${dryRunLog.stderr}`),
        `shared-profile queue-run should not fail with a persistent-profile collision. job=${job.id} error=${job.error ?? "none"} stderr=${dryRunLog.stderr}`
      )
    }

    for (let index = 0; index < jobs.length - 1; index += 1) {
      const current = jobs[index]
      const next = jobs[index + 1]
      const currentFinishedAt = current.finishedAt
      const nextDryRunStartedAt = next.stages.find((stage) => stage.name === "dry-run")?.startedAt ?? null
      assert(currentFinishedAt, "serialized queue-run should record current job completion time")
      assert(nextDryRunStartedAt, "serialized queue-run should record next dry-run start time")
      assert(
        Date.parse(nextDryRunStartedAt) >= Date.parse(currentFinishedAt),
        `shared-profile queue-run should serialize dry-run starts. current=${current.id} next=${next.id}`
      )
    }

    console.log("shared profile queue-run smoke passed")
  } finally {
    await stopServer(server)
  }
}

await main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
