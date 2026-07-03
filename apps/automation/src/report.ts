import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { DEFAULT_SCREENSHOT_DIR, getArgValue } from "./common"

type ReportStep = {
  id: string
  label: string
  status: "done" | "failed" | "skipped"
  detail: string
}

type ExecutionReport = {
  id: string
  taskId: string
  taskTitle: string
  platform: string
  pageUrl: string
  status: "completed" | "partial" | "failed"
  createdAt: string
  screenshotPath: string
  steps: ReportStep[]
}

const reportDir = getArgValue("dir") ?? process.env.REPORT_DIR ?? DEFAULT_SCREENSHOT_DIR
const limit = Number(getArgValue("limit") ?? process.env.LIMIT ?? 10)

const loadReports = () => {
  if (!existsSync(reportDir)) {
    return []
  }

  return readdirSync(reportDir)
    .filter((fileName) => /^dianxiaomi-(run|error)-.*\.json$/.test(fileName))
    .map((fileName) => {
      const filePath = path.join(reportDir, fileName)
      const report = JSON.parse(readFileSync(filePath, "utf8")) as ExecutionReport
      return {
        filePath,
        report
      }
    })
    .sort((left, right) => right.report.createdAt.localeCompare(left.report.createdAt))
}

const main = () => {
  const reports = loadReports().slice(0, limit)

  if (reports.length === 0) {
    console.log(`没有找到执行报告：${reportDir}`)
    return
  }

  reports.forEach(({ filePath, report }) => {
    const failedSteps = report.steps.filter((step) => step.status === "failed")
    const doneCount = report.steps.filter((step) => step.status === "done").length

    console.log(`[${report.status}] ${report.createdAt} ${report.taskId} ${report.taskTitle}`)
    console.log(`  页面：${report.pageUrl}`)
    console.log(`  步骤：done=${doneCount}, failed=${failedSteps.length}, total=${report.steps.length}`)
    console.log(`  报告：${filePath}`)
    console.log(`  截图：${report.screenshotPath}`)

    if (failedSteps.length > 0) {
      console.log("  失败：")
      failedSteps.forEach((step) => {
        console.log(`    - ${step.label}: ${step.detail}`)
      })
    }
  })
}

main()
