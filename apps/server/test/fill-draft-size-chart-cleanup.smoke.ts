import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

type StepStatus = "done" | "failed" | "skipped"

type ExecutionStep = {
  id: string
  status: StepStatus
  detail: string
  data?: Record<string, unknown>
}

type ExecutionReport = {
  status: "completed" | "partial" | "failed"
  steps: ExecutionStep[]
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const runId = new Date().toISOString().replace(/[:.]/g, "-")
const fixturePath = path.join(repoRoot, ".runtime/dianxiaomi-dry-run-fixture.html")
const taskFile = path.join(repoRoot, ".runtime/dianxiaomi-dry-run-task.json")
const selectorConfig = path.join(repoRoot, ".runtime/dianxiaomi-selector-config.json")
const artifactDir = path.join(repoRoot, `.runtime/fill-draft-size-chart-cleanup-smoke/${runId}`)
const profileDir = path.join(repoRoot, `.runtime/playwright/fill-draft-size-chart-cleanup-smoke-profile/${runId}`)

const latestReport = (directory: string) => {
  const reports = readdirSync(directory)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => path.join(directory, fileName))
    .sort((left, right) => right.localeCompare(left))

  assert(reports[0], `no execution report found in ${directory}`)
  return JSON.parse(readFileSync(reports[0], "utf8")) as ExecutionReport
}

const run = async () => {
  assert(existsSync(fixturePath), `fixture file missing: ${fixturePath}`)
  assert(existsSync(taskFile), `task file missing: ${taskFile}`)
  assert(existsSync(selectorConfig), `selector config missing: ${selectorConfig}`)

  mkdirSync(artifactDir, {
    recursive: true
  })
  mkdirSync(profileDir, {
    recursive: true
  })

  const fixtureHtml = readFileSync(fixturePath, "utf8")
  const fixtureUrl = `data:text/html;charset=utf-8,${encodeURIComponent(fixtureHtml)}#size-chart-template-missing`
  const tsxCliPath = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs")
  const automationEntry = path.join(repoRoot, "apps/automation/src/temu-publish.ts")
  assert(existsSync(tsxCliPath), `tsx CLI not found: ${tsxCliPath}`)
  assert(existsSync(automationEntry), `automation entry not found: ${automationEntry}`)

  const child = spawn(process.execPath, [
    tsxCliPath,
    automationEntry,
    "--platform=dianxiaomi",
    `--url=${fixtureUrl}`,
    `--task-file=${taskFile}`,
    `--profile=${profileDir}`,
    "--headed=false",
    "--keep-open=false",
    "--slow-mo=0",
    "--dry-run=false",
    "--review=true",
    "--save-draft=false",
    "--submit=false",
    `--screenshots=${artifactDir}`,
    `--selector-config=${selectorConfig}`
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  })

  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code))
  })

  assert.equal(exitCode, 0, `fill-draft size chart cleanup smoke should exit cleanly.\nstdout:\n${stdout}\nstderr:\n${stderr}`)

  const report = latestReport(artifactDir)
  const sizeChartStep = report.steps.find((step) => step.id === "normalize-size-chart")
  const mediaSafety = report.steps.find((step) => step.id === "media-processing-safety")
  const mediaPlan = report.steps.find((step) => step.id === "media-processing-plan")
  const reviewHold = report.steps.find((step) => step.id === "review-hold")

  assert.equal(report.status, "completed", "fill-draft size chart cleanup should not leave a partial report")
  assert(sizeChartStep, "fill-draft size chart cleanup should report normalize-size-chart")
  assert.equal(sizeChartStep?.status, "skipped", "size chart cleanup should skip when no reusable template exists")
  assert.match(sizeChartStep?.detail ?? "", /closed/i, "size chart cleanup should close the modal before skipping")

  assert(mediaSafety, "fill-draft size chart cleanup should report media-processing-safety")
  assert.equal(mediaSafety?.status, "done", "media-processing-safety should recover after size chart cleanup")
  assert.equal(mediaSafety?.data?.guardStatus, "manual-ready", "media-processing-safety should return to manual-ready")
  assert.equal(mediaSafety?.data?.manualConfirmationRequired, true, "media-processing-safety should still require manual confirmation")
  assert.equal(mediaSafety?.data?.pageState?.visibleDialogCount, 0, "size chart cleanup should not leave visible dialogs behind")

  assert(mediaPlan, "fill-draft size chart cleanup should report media-processing-plan")
  assert.equal(mediaPlan?.status, "skipped", "media-processing-plan should stay non-blocking in plan-only mode")
  assert.equal(mediaPlan?.data?.guardStatus, "manual-ready", "media-processing-plan should stay manual-ready after cleanup")
  assert.equal(mediaPlan?.data?.pageState?.visibleDialogCount, 0, "media-processing-plan should observe a clean page after cleanup")

  assert(reviewHold, "fill-draft size chart cleanup should stop at review hold")
  assert.equal(reviewHold?.status, "skipped", "review hold should remain a skipped stop marker")

  console.log(`fill-draft size chart cleanup smoke passed: ${artifactDir}`)
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
