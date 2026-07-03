import type {
  DianxiaomiImageCheckInspectionResult,
  DianxiaomiImageCheckJob,
  DianxiaomiImageCheckJobLog,
  DianxiaomiImageCheckStartInput,
  DianxiaomiImageCheckStartResult
} from "@temu-ai-ops/shared"
import {
  parseDianxiaomiImageCheckSummary,
  summarizeDianxiaomiImageCheckIssues
} from "@temu-ai-ops/shared"
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getDianxiaomiProductWorkItem, mergeDianxiaomiProductWorkItemSnapshot } from "./planner"

type InspectionPayload = {
  createdAt: string
  targetUrl: string
  pageUrl: string
  pageTitle: string
  clicked: boolean
  clickTargetText: string | null
  signals: {
    beforeDialogs: number
    afterDialogs: number
    bodySnippet: string
    statusTexts: string[]
  }
}

const imageCheckJobs = new Map<string, DianxiaomiImageCheckJob>()
const timestampId = () => new Date().toISOString().replace(/[:.]/g, "-")

const getRepoRoot = () => {
  const currentFile = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(currentFile), "../../..")
}

const pushArg = (args: string[], name: string, value: string | boolean | undefined) => {
  if (value === undefined || value === "") {
    return
  }

  args.push(`--${name}=${value}`)
}

const getTsxCliPath = () => {
  const repoRoot = getRepoRoot()
  const tsxCliPath = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs")
  if (!existsSync(tsxCliPath)) {
    throw new Error(`tsx CLI not found: ${tsxCliPath}`)
  }

  return tsxCliPath
}

type ImageCheckChildProcess = ChildProcessByStdio<null, Readable, Readable>

const pipeProcessLogs = (child: ImageCheckChildProcess, logPath: string, errorLogPath: string) => {
  child.stdout.pipe(createWriteStream(logPath, { flags: "a" }))
  child.stderr.pipe(createWriteStream(errorLogPath, { flags: "a" }))
}

const runNodeScript = (repoRoot: string, scriptPath: string, args: string[], logPath: string, errorLogPath: string) => {
  const child = spawn(process.execPath, [getTsxCliPath(), scriptPath, ...args], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  })
  pipeProcessLogs(child, logPath, errorLogPath)
  return child
}

const waitForExit = (child: ImageCheckChildProcess) => new Promise<number | null>((resolve, reject) => {
  child.once("exit", (code) => resolve(code))
  child.once("error", reject)
})

const readLogTail = (filePath: string, maxChars: number) => {
  if (!existsSync(filePath)) {
    return {
      text: "",
      truncated: false
    }
  }

  const size = statSync(filePath).size
  const text = readFileSync(filePath, "utf8")
  return {
    text: text.length > maxChars ? text.slice(-maxChars) : text,
    truncated: text.length > maxChars || size > Buffer.byteLength(text, "utf8")
  }
}

const readInspectionPayload = (resultPath: string): InspectionPayload | null => {
  if (!existsSync(resultPath)) {
    return null
  }

  return JSON.parse(readFileSync(resultPath, "utf8")) as InspectionPayload
}

const normalizeInspectionResult = (payload: InspectionPayload): DianxiaomiImageCheckInspectionResult => {
  const summaryText = [
    ...(payload.signals.statusTexts ?? []),
    payload.signals.bodySnippet
  ].find((item) => typeof item === "string" && item.includes("图片包含文字")) ?? ""

  const issues = parseDianxiaomiImageCheckSummary(summaryText)
  return {
    passed: issues.length === 0,
    issues,
    summary: summarizeDianxiaomiImageCheckIssues(issues),
    rawSummaryText: summaryText
  }
}

const applyImageCheckResultToWorkItem = (workItemId: string, result: DianxiaomiImageCheckInspectionResult, jobId: string) => {
  const current = getDianxiaomiProductWorkItem(workItemId)
  if (!current) {
    return null
  }

  const merged = mergeDianxiaomiProductWorkItemSnapshot(workItemId, {
    imageCheck: result.passed
      ? {
          passed: true
        }
      : {
          passed: false,
          issues: result.issues.map((issue) => ({
            category: issue.category,
            issue: issue.issue,
            detail: issue.detail
          }))
        },
    mediaToolSignals: ["image check"]
  }, `image check updated from job ${jobId}`)

  if (!merged) {
    return null
  }

  if (merged.status === "blocked" || merged.status === "edited") {
    return merged
  }
  return merged
}

export const startDianxiaomiImageCheck = (input: DianxiaomiImageCheckStartInput): DianxiaomiImageCheckStartResult => {
  const workItemId = input.workItemId?.trim() ?? ""
  const workItem = workItemId ? getDianxiaomiProductWorkItem(workItemId) : null
  const targetUrl = input.url?.trim() || workItem?.pageUrl?.trim() || ""
  if (!workItemId || !workItem) {
    throw new Error("dianxiaomi product work item not found")
  }
  if (!targetUrl) {
    throw new Error("dianxiaomi image check requires a work item URL")
  }

  const repoRoot = getRepoRoot()
  const id = `dianxiaomi-image-check-${timestampId()}`
  const artifactDir = input.screenshots?.trim() || `.runtime/dianxiaomi-image-check/${id}`
  const absoluteArtifactDir = path.isAbsolute(artifactDir) ? artifactDir : path.join(repoRoot, artifactDir)
  const resultPath = path.join(absoluteArtifactDir, "image-check-inspection.json")
  const logDir = path.join(repoRoot, ".runtime/logs")
  mkdirSync(logDir, { recursive: true })
  mkdirSync(absoluteArtifactDir, { recursive: true })

  const logPath = path.join(logDir, `${id}.log`)
  const errorLogPath = path.join(logDir, `${id}.err.log`)
  const scriptPath = path.join(repoRoot, "apps/automation/src/inspect-image-check.ts")
  const args: string[] = []
  pushArg(args, "url", targetUrl)
  pushArg(args, "headed", input.headed)
  pushArg(args, "profile", input.profile)
  pushArg(args, "screenshots", artifactDir)

  const result = {
    id,
    workItemId,
    startedAt: new Date().toISOString(),
    command: `node ${getTsxCliPath()} ${scriptPath} ${args.join(" ")}`.trim(),
    cwd: repoRoot,
    logPath,
    errorLogPath,
    artifactDir,
    resultPath
  }

  imageCheckJobs.set(id, {
    ...result,
    status: "running",
    finishedAt: null,
    exitCode: null,
    error: null,
    result: null
  })

  void (async () => {
    try {
      const child = runNodeScript(repoRoot, scriptPath, args, logPath, errorLogPath)
      const exitCode = await waitForExit(child)
      const normalizedResult = exitCode === 0
        ? normalizeInspectionResult(readInspectionPayload(resultPath) ?? {
            createdAt: new Date().toISOString(),
            targetUrl,
            pageUrl: targetUrl,
            pageTitle: "",
            clicked: false,
            clickTargetText: null,
            signals: {
              beforeDialogs: 0,
              afterDialogs: 0,
              bodySnippet: "",
              statusTexts: []
            }
          })
        : null

      if (exitCode === 0 && normalizedResult) {
        applyImageCheckResultToWorkItem(workItemId, normalizedResult, id)
      }

      imageCheckJobs.set(id, {
        ...imageCheckJobs.get(id)!,
        status: exitCode === 0 ? "completed" : "failed",
        finishedAt: new Date().toISOString(),
        exitCode,
        error: exitCode === 0 ? null : `image check exited with code ${exitCode}`,
        result: normalizedResult
      })
    } catch (error) {
      imageCheckJobs.set(id, {
        ...imageCheckJobs.get(id)!,
        status: "failed",
        finishedAt: new Date().toISOString(),
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
        result: null
      })
    }
  })()

  return result
}

export const listDianxiaomiImageCheckJobs = (limit = 20): DianxiaomiImageCheckJob[] =>
  Array.from(imageCheckJobs.values())
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit)

export const getDianxiaomiImageCheckJob = (id: string): DianxiaomiImageCheckJob | null =>
  imageCheckJobs.get(id) ?? null

export const getDianxiaomiImageCheckJobLog = (id: string, maxChars = 4000): DianxiaomiImageCheckJobLog | null => {
  const job = getDianxiaomiImageCheckJob(id)
  if (!job) {
    return null
  }

  const stdout = readLogTail(job.logPath, maxChars)
  const stderr = readLogTail(job.errorLogPath, maxChars)
  return {
    id,
    logPath: job.logPath,
    errorLogPath: job.errorLogPath,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: {
      stdout: stdout.truncated,
      stderr: stderr.truncated
    }
  }
}
