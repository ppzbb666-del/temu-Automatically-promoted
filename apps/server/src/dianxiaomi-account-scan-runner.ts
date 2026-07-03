import type {
  DianxiaomiAccountScanJob,
  DianxiaomiAccountScanJobLog,
  DianxiaomiAccountScanLink,
  DianxiaomiAccountScanResult,
  DianxiaomiAccountScanStartInput,
  DianxiaomiAccountScanStartResult
} from "@temu-ai-ops/shared"
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"
import path from "node:path"
import { fileURLToPath } from "node:url"

const accountScanJobs = new Map<string, DianxiaomiAccountScanJob>()
const timestampId = () => new Date().toISOString().replace(/[:.]/g, "-")

const getRepoRoot = () => {
  const currentFile = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(currentFile), "../../..")
}

const pushArg = (args: string[], name: string, value: string | boolean | number | undefined) => {
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

type ScanChildProcess = ChildProcessByStdio<null, Readable, Readable>

const pipeProcessLogs = (child: ScanChildProcess, logPath: string, errorLogPath: string) => {
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

const waitForExit = (child: ScanChildProcess) => new Promise<number | null>((resolve, reject) => {
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

const readResult = (resultPath: string): DianxiaomiAccountScanResult | null => {
  if (!existsSync(resultPath)) {
    return null
  }

  return JSON.parse(readFileSync(resultPath, "utf8")) as DianxiaomiAccountScanResult
}

export const startDianxiaomiAccountScan = (input: DianxiaomiAccountScanStartInput = {}): DianxiaomiAccountScanStartResult => {
  const repoRoot = getRepoRoot()
  const id = `dianxiaomi-account-scan-${timestampId()}`
  const artifactDir = input.screenshots?.trim() || `.runtime/dianxiaomi-account-scan/${id}`
  const resultPath = path.join(path.isAbsolute(artifactDir) ? artifactDir : path.join(repoRoot, artifactDir), "dianxiaomi-account-scan.result.json")
  const logDir = path.join(repoRoot, ".runtime/logs")
  mkdirSync(logDir, {
    recursive: true
  })
  mkdirSync(path.isAbsolute(artifactDir) ? artifactDir : path.join(repoRoot, artifactDir), {
    recursive: true
  })

  const logPath = path.join(logDir, `${id}.log`)
  const errorLogPath = path.join(logDir, `${id}.err.log`)
  const scriptPath = path.join(repoRoot, "apps/automation/src/dianxiaomi-account-scan.ts")
  const args: string[] = []
  pushArg(args, "headed", input.headed)
  pushArg(args, "profile", input.profile)
  pushArg(args, "screenshots", artifactDir)
  pushArg(args, "source-buckets", input.sourceBuckets?.join(","))
  pushArg(args, "max-pages", input.maxPages)
  pushArg(args, "store-id", input.storeId)
  pushArg(args, "store-name", input.storeName)

  const result = {
    id,
    startedAt: new Date().toISOString(),
    command: `node ${getTsxCliPath()} ${scriptPath} ${args.join(" ")}`.trim(),
    cwd: repoRoot,
    logPath,
    errorLogPath,
    artifactDir,
    resultPath
  }

  accountScanJobs.set(id, {
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
      accountScanJobs.set(id, {
        ...accountScanJobs.get(id)!,
        status: exitCode === 0 ? "completed" : "failed",
        finishedAt: new Date().toISOString(),
        exitCode,
        error: exitCode === 0 ? null : `account scan exited with code ${exitCode}`,
        result: exitCode === 0 ? readResult(resultPath) : null
      })
    } catch (error) {
      accountScanJobs.set(id, {
        ...accountScanJobs.get(id)!,
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

export const listDianxiaomiAccountScanJobs = (limit = 20): DianxiaomiAccountScanJob[] =>
  Array.from(accountScanJobs.values())
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit)

export const getDianxiaomiAccountScanJob = (id: string): DianxiaomiAccountScanJob | null =>
  accountScanJobs.get(id) ?? null

export const getDianxiaomiAccountScanJobLog = (id: string, maxChars = 4000): DianxiaomiAccountScanJobLog | null => {
  const job = getDianxiaomiAccountScanJob(id)
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

export const listDianxiaomiAccountScanLinks = (jobId: string): DianxiaomiAccountScanLink[] => {
  const job = getDianxiaomiAccountScanJob(jobId)
  if (!job?.result) {
    return []
  }

  return job.result.stores.flatMap((store) => store.links)
}
