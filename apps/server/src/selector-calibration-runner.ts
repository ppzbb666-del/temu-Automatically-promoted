import type {
  SelectorCalibrationJob,
  SelectorCalibrationJobLog,
  SelectorCalibrationStartInput,
  SelectorCalibrationStartResult
} from "@temu-ai-ops/shared"
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"
import path from "node:path"
import { fileURLToPath } from "node:url"

const calibrationJobs = new Map<string, SelectorCalibrationJob>()
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

type CalibrationChildProcess = ChildProcessByStdio<null, Readable, Readable>

const pipeProcessLogs = (child: CalibrationChildProcess, logPath: string, errorLogPath: string) => {
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

const waitForExit = (child: CalibrationChildProcess) => new Promise<number | null>((resolve, reject) => {
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

export const startSelectorCalibration = (input: SelectorCalibrationStartInput = {}): SelectorCalibrationStartResult => {
  const repoRoot = getRepoRoot()
  const id = `selector-calibration-${timestampId()}`
  const artifactDir = input.screenshots?.trim() || `.runtime/selector-calibration/${id}`
  const logDir = path.join(repoRoot, ".runtime/logs")
  mkdirSync(logDir, {
    recursive: true
  })
  mkdirSync(path.isAbsolute(artifactDir) ? artifactDir : path.join(repoRoot, artifactDir), {
    recursive: true
  })

  const logPath = path.join(logDir, `${id}.log`)
  const errorLogPath = path.join(logDir, `${id}.err.log`)
  const snapshotScript = path.join(repoRoot, "apps/automation/src/snapshot.ts")
  const diagnosisScript = path.join(repoRoot, "apps/automation/src/snapshot-diagnose.ts")
  const snapshotArgs: string[] = []
  pushArg(snapshotArgs, "headed", input.headed ?? true)
  pushArg(snapshotArgs, "url", input.url)
  pushArg(snapshotArgs, "profile", input.profile)
  pushArg(snapshotArgs, "screenshots", artifactDir)
  pushArg(snapshotArgs, "sample-media-actions", input.sampleMediaActions)
  pushArg(snapshotArgs, "media-automation-tools", input.mediaAutomationTools?.join(","))
  const diagnosisArgs = [`--screenshots=${artifactDir}`]

  const result = {
    id,
    startedAt: new Date().toISOString(),
    command: `node ${getTsxCliPath()} ${snapshotScript} ${snapshotArgs.join(" ")} && node ${getTsxCliPath()} ${diagnosisScript} ${diagnosisArgs.join(" ")}`,
    cwd: repoRoot,
    logPath,
    errorLogPath,
    artifactDir
  }

  calibrationJobs.set(id, {
    ...result,
    status: "running",
    finishedAt: null,
    exitCode: null,
    error: null
  })

  void (async () => {
    try {
      const snapshot = runNodeScript(repoRoot, snapshotScript, snapshotArgs, logPath, errorLogPath)
      const snapshotCode = await waitForExit(snapshot)
      if (snapshotCode !== 0) {
        calibrationJobs.set(id, {
          ...calibrationJobs.get(id)!,
          status: "failed",
          finishedAt: new Date().toISOString(),
          exitCode: snapshotCode,
          error: `snapshot exited with code ${snapshotCode}`
        })
        return
      }

      const diagnosis = runNodeScript(repoRoot, diagnosisScript, diagnosisArgs, logPath, errorLogPath)
      const diagnosisCode = await waitForExit(diagnosis)
      calibrationJobs.set(id, {
        ...calibrationJobs.get(id)!,
        status: diagnosisCode === 0 ? "completed" : "failed",
        finishedAt: new Date().toISOString(),
        exitCode: diagnosisCode,
        error: diagnosisCode === 0 ? null : `diagnosis exited with code ${diagnosisCode}`
      })
    } catch (error) {
      calibrationJobs.set(id, {
        ...calibrationJobs.get(id)!,
        status: "failed",
        finishedAt: new Date().toISOString(),
        exitCode: null,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })()

  return result
}

export const listSelectorCalibrationJobs = (limit = 20): SelectorCalibrationJob[] =>
  Array.from(calibrationJobs.values())
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit)

export const getSelectorCalibrationJob = (id: string): SelectorCalibrationJob | null =>
  calibrationJobs.get(id) ?? null

export const getSelectorCalibrationJobLog = (id: string, maxChars = 4000): SelectorCalibrationJobLog | null => {
  const job = getSelectorCalibrationJob(id)
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
