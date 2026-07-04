// One-off operator login helper: opens a HEADED Chromium on the automation
// profile at the Dianxiaomi login page and stays open so the operator can enter
// credentials + CAPTCHA. Read-only w.r.t. products — it only navigates to the
// home/login page; the operator drives the login. Closes on Ctrl-C or when the
// browser window is closed.
import path from "node:path"
import { chromium } from "playwright"

const PROFILE_DIR = path.resolve(".runtime/playwright/dianxiaomi-profile")
const LOGIN_URL = "https://www.dianxiaomi.com/index.htm"

const main = async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chromium",
    headless: false,
    viewport: { width: 1440, height: 960 }
  })
  const page = context.pages()[0] ?? await context.newPage()
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined)
  console.log("Login browser open on the automation profile. Log in + solve CAPTCHA,")
  console.log("then CLOSE this browser window (or tell the assistant to close it).")

  // Stay alive until the browser is closed.
  await new Promise<void>((resolve) => {
    context.on("close", () => resolve())
    page.on("close", () => {
      // if the last page closes, close the context too
      if (context.pages().length === 0) {
        context.close().catch(() => undefined).finally(() => resolve())
      }
    })
  })
  console.log("Login browser closed.")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
