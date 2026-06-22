import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_DIANXIAOMI_URL, getArgValue, parseBoolean } from "./common"

const timestampId = () => new Date().toISOString().replace(/[:.]/g, "-")

const getRepoRoot = () => {
  const currentFile = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(currentFile), "../../..")
}

const getTsxCliPath = (repoRoot: string) => {
  const tsxCliPath = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs")
  if (!existsSync(tsxCliPath)) {
    throw new Error(`tsx CLI not found: ${tsxCliPath}`)
  }

  return tsxCliPath
}

const parseStringList = (value: string | undefined) =>
  (value ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)

const pushArg = (args: string[], name: string, value: string | boolean | undefined) => {
  if (value === undefined || value === "") {
    return
  }

  args.push(`--${name}=${value}`)
}

const runScript = async (repoRoot: string, tsxCliPath: string, scriptPath: string, args: string[]) => {
  console.log(`\n> ${path.relative(repoRoot, scriptPath)} ${args.join(" ")}`)
  const child = spawn(process.execPath, [tsxCliPath, scriptPath, ...args], {
    cwd: repoRoot,
    env: process.env,
    windowsHide: true,
    stdio: "inherit"
  })

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("exit", (code) => resolve(code))
    child.once("error", reject)
  })

  if (exitCode !== 0) {
    throw new Error(`${path.basename(scriptPath)} exited with code ${exitCode}`)
  }
}

const main = async () => {
  const repoRoot = getRepoRoot()
  const tsxCliPath = getTsxCliPath(repoRoot)
  const artifactDir = getArgValue("screenshots")
    ?? process.env.SCREENSHOT_DIR
    ?? `.runtime/selector-calibration/real-${timestampId()}`
  const targetUrl = getArgValue("url") ?? process.env.TEMU_TARGET_URL ?? DEFAULT_DIANXIAOMI_URL
  const profile = getArgValue("profile") ?? process.env.TEMU_PROFILE_DIR ?? ".runtime/playwright/dianxiaomi-profile"
  const headed = parseBoolean(getArgValue("headed") ?? process.env.HEADED, false)
  const keepOpen = parseBoolean(getArgValue("keep-open") ?? process.env.KEEP_OPEN, false)
  const sampleMediaActions = parseBoolean(
    getArgValue("sample-media-actions") ?? process.env.SAMPLE_MEDIA_ACTIONS,
    true
  )
  const mediaAutomationTools = parseStringList(
    getArgValue("media-automation-tools") ?? process.env.MEDIA_AUTOMATION_TOOLS
  )
  const outputPath = getArgValue("output")
    ?? getArgValue("selector-config")
    ?? process.env.SELECTOR_CONFIG
    ?? ".runtime/dianxiaomi-selector-config.json"

  const snapshotArgs: string[] = []
  pushArg(snapshotArgs, "url", targetUrl)
  pushArg(snapshotArgs, "profile", profile)
  pushArg(snapshotArgs, "screenshots", artifactDir)
  pushArg(snapshotArgs, "headed", headed)
  pushArg(snapshotArgs, "keep-open", keepOpen)
  pushArg(snapshotArgs, "sample-media-actions", sampleMediaActions)
  pushArg(snapshotArgs, "media-automation-tools", mediaAutomationTools.join(","))

  const diagnosisArgs = [`--screenshots=${artifactDir}`]
  const generateArgs = [
    `--screenshots=${artifactDir}`,
    `--output=${outputPath}`,
    "--require-real-dianxiaomi=true"
  ]

  await runScript(repoRoot, tsxCliPath, path.join(repoRoot, "apps/automation/src/snapshot.ts"), snapshotArgs)
  await runScript(repoRoot, tsxCliPath, path.join(repoRoot, "apps/automation/src/snapshot-diagnose.ts"), diagnosisArgs)
  await runScript(repoRoot, tsxCliPath, path.join(repoRoot, "apps/automation/src/selector-config-generate.ts"), generateArgs)

  console.log(`\nReal Dianxiaomi calibration completed.`)
  console.log(`Artifacts: ${artifactDir}`)
  console.log(`Selector config: ${outputPath}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
