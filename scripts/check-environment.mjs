import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import process from "node:process"

const run = (command, args) => execFileSync(command, args, { stdio: "inherit", shell: process.platform === "win32" })

const major = Number.parseInt(process.versions.node.split(".")[0], 10)
if (major < 20) {
  console.error(`[environment] Node.js 20+ is required; found ${process.version}`)
  process.exit(1)
}

console.log(`[environment] Node.js ${process.version} detected`)

try {
  // Playwright's browser executable is not installed by npm install.
  const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (browserPath && existsSync(browserPath)) {
    console.log(`[environment] PLAYWRIGHT_BROWSERS_PATH exists: ${browserPath}`)
  }
  run(process.platform === "win32" ? "npx.cmd" : "npx", ["playwright", "install", "chromium"])
  console.log("[environment] Playwright Chromium is ready")
} catch (error) {
  console.error("[environment] Failed to install Playwright Chromium.")
  console.error("[environment] Run `npx playwright install chromium` and retry.")
  process.exit(error?.status || 1)
}
