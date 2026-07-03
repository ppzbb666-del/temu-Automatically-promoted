// Aggregates the dashboard's "daily mode" derivations into a single hook.
// Replaces the inline block (App.tsx L1698–L1860) with a single call site.

import type {
  AutomationFullFlowJob,
  AutomationQueueDaemonHealth,
  AutomationQueueDaemonState,
  AutomationQueueRunStartResult,
  AutomationUnattendedStartupCheck,
  DianxiaomiProductWorkItem
} from "@temu-ai-ops/shared"

import {
  canRunBrowserRecovery,
  getAutomaticPassRate,
  getDailyTrialGate,
  getErrorMessage,
  getManualTriggerStats,
  type DailyAlert
} from "./dashboard-helpers"

export const useDailyDashboard = (input: {
  automationQueueRuns: AutomationQueueRunStartResult[]
  automationFullFlowJobs: AutomationFullFlowJob[]
  dianxiaomiProductWorkItems: DianxiaomiProductWorkItem[]
  automationQueueDaemon: AutomationQueueDaemonState | null | undefined
  automationQueueDaemonHealth: AutomationQueueDaemonHealth | null | undefined
  automationUnattendedStartupCheck: AutomationUnattendedStartupCheck | null | undefined
  backendConnectionError: unknown
}) => {
  const {
    automationQueueRuns,
    automationFullFlowJobs,
    dianxiaomiProductWorkItems,
    automationQueueDaemon,
    automationQueueDaemonHealth,
    automationUnattendedStartupCheck,
    backendConnectionError
  } = input

  const readyWorkItems = dianxiaomiProductWorkItems.filter((item) => item.status === "ready-for-automation")
  const blockedWorkItems = dianxiaomiProductWorkItems.filter((item) => item.status === "blocked")
  const browserRecoveryCandidateCount = blockedWorkItems.filter((item) => canRunBrowserRecovery(item)).length
  const directSafeRetryCandidateCount = automationQueueDaemonHealth?.workItems.autoRetryCandidates ?? 0
  const releasedBrowserRecoveryCandidateCount = automationQueueDaemonHealth?.workItems.releasedBrowserRecoveryCandidates ?? 0
  const displayedBrowserRecoveryCandidateCount = automationQueueDaemonHealth
    ? automationQueueDaemonHealth.workItems.browserRecoveryCandidates + releasedBrowserRecoveryCandidateCount
    : browserRecoveryCandidateCount
  const pausedBrowserRecoveryCandidateCount = automationQueueDaemonHealth?.workItems.pausedBrowserRecoveryCandidates ?? 0
  const startupCalibrationCheck = automationUnattendedStartupCheck?.checks.find((item) => item.id === "real-dianxiaomi-calibration")
  const startupBlockingChecks = automationUnattendedStartupCheck?.checks.filter((item) => item.status === "block") ?? []
  const startupWarningChecks = automationUnattendedStartupCheck?.checks.filter((item) => item.status === "warning") ?? []
  const primaryStartupProblem = startupBlockingChecks[0] ?? startupWarningChecks[0] ?? startupCalibrationCheck ?? null

  const dailyBackendOffline = Boolean(backendConnectionError)
  const dailyBackendOfflineMessage = `服务未连接：${backendConnectionError ? getErrorMessage(backendConnectionError) : "无法读取后端状态"}。先启动后端服务后再试跑。`
  const dailyTrialGate = getDailyTrialGate(automationQueueRuns, automationFullFlowJobs, dianxiaomiProductWorkItems)
  const dailyStartupCanStart = !dailyBackendOffline && Boolean(automationUnattendedStartupCheck?.canStart) && automationQueueDaemon?.status !== "ACTIVE"
  const dailyCanStart = dailyStartupCanStart && dailyTrialGate.status === "passed"
  const dailyAutomaticPass = getAutomaticPassRate(automationFullFlowJobs, automationQueueRuns, dianxiaomiProductWorkItems)
  const dailyManualTriggers = getManualTriggerStats(dianxiaomiProductWorkItems)
  const dailyAutomaticPassTone: "neutral" | "good" | "warn" | "bad" = dailyAutomaticPass.rate === null
    ? "neutral"
    : dailyAutomaticPass.rate >= 0.9
      ? "good"
      : dailyAutomaticPass.rate >= 0.75
        ? "warn"
        : "bad"
  const dailyManualTriggerTone: "good" | "warn" | "bad" = dailyManualTriggers.average <= 0.15
    ? "good"
    : dailyManualTriggers.average <= 0.5
      ? "warn"
      : "bad"
  const operatorAction = automationUnattendedStartupCheck?.recommendedAction
    ?? automationQueueDaemonHealth?.alerts[0]?.action
    ?? "Open Dianxiaomi, collect products, then start unattended mode."
  const dailyModeLabel: string = automationQueueDaemon?.status === "ACTIVE"
    ? "自动运行中"
    : dailyBackendOffline
      ? "服务未连接"
    : automationUnattendedStartupCheck?.status === "blocked"
      ? "需要处理"
      : dailyTrialGate.status === "passed"
        ? "可以启动"
        : dailyTrialGate.status === "running"
          ? "试跑验收中"
          : dailyTrialGate.status === "failed"
            ? "试跑未通过"
            : "先试跑"
  const dailyModeTone: "running" | "blocked" | "idle" | "warn" = automationQueueDaemon?.status === "ACTIVE"
    ? "running"
    : dailyBackendOffline || automationUnattendedStartupCheck?.status === "blocked" || dailyTrialGate.status === "failed"
      ? "blocked"
      : dailyTrialGate.status === "passed"
        ? "idle"
        : "warn"
  const dailyTrialTone: "good" | "bad" | "warn" = dailyTrialGate.status === "passed" ? "good" : dailyTrialGate.status === "failed" ? "bad" : "warn"
  const dailyTrialLabel: string = dailyTrialGate.status === "passed"
    ? "已通过"
    : dailyTrialGate.status === "running"
      ? "验收中"
      : dailyTrialGate.status === "failed"
        ? "未通过"
        : "待试跑"
  const dailyActionTitle: string = automationQueueDaemon?.status === "ACTIVE"
    ? "系统正在自动处理店小秘待发布商品"
    : dailyBackendOffline
      ? "后端服务未连接"
    : automationUnattendedStartupCheck?.status === "blocked"
      ? "还不能无人值守启动"
      : dailyTrialGate.status === "passed"
        ? "可以启动无人值守"
        : "先完成小批量试跑"
  const dailyActionDetail: string = dailyBackendOffline
    ? dailyBackendOfflineMessage
    : automationUnattendedStartupCheck?.status === "blocked"
    ? operatorAction
    : dailyTrialGate.status === "passed"
      ? operatorAction
      : dailyTrialGate.message
  const repeatedRecoveryAlert = automationQueueDaemonHealth?.alerts.find((alert) => alert.id === "repeated-recovery-failures")
  const validationTriageAlert = automationQueueDaemonHealth?.alerts.find((alert) => alert.id === "manual-budget-validation-triage")
  const firstManualBudgetItem = automationQueueDaemonHealth?.manualBudget?.publishOutcomes?.[0] ?? null
  const publishFailureSummary = automationQueueDaemonHealth?.workItems.publishFailed
    ? {
        failed: automationQueueDaemonHealth.workItems.publishFailed,
        recovery: automationQueueDaemonHealth.workItems.publishRecoveryCandidates,
        manualBudget: automationQueueDaemonHealth.workItems.publishManualBudget,
        firstManualBudgetItem
      }
    : null
  const dailyAlerts: DailyAlert[] = [
    dailyBackendOffline ? {
      id: "backend-offline",
      title: "后端服务未连接",
      message: dailyBackendOfflineMessage,
      tone: "bad"
    } : null,
    repeatedRecoveryAlert ? {
      id: repeatedRecoveryAlert.id,
      title: "自动恢复重复失败",
      message: `${repeatedRecoveryAlert.message} ${repeatedRecoveryAlert.action}`,
      tone: repeatedRecoveryAlert.level === "block" ? "bad" : "warn"
    } : null,
    validationTriageAlert ? {
      id: validationTriageAlert.id,
      title: "验证失败已分流",
      message: validationTriageAlert.action,
      tone: validationTriageAlert.level === "block" ? "bad" : "warn"
    } : null,
    publishFailureSummary ? {
      id: "publish-outcome-failures",
      title: "店小秘发布结果待处理",
      message: `${publishFailureSummary.failed} 个商品发布失败；${publishFailureSummary.recovery} 个可进入恢复/重试，${publishFailureSummary.manualBudget} 个计入人工步骤预算。${publishFailureSummary.firstManualBudgetItem ? `首项：${publishFailureSummary.firstManualBudgetItem.title}；${publishFailureSummary.firstManualBudgetItem.operatorAction}` : ""}`,
      tone: publishFailureSummary.manualBudget > 0 ? "bad" : "warn"
    } : null,
    ...startupBlockingChecks.slice(0, 2).map((item) => ({
      id: `startup-block-${item.id}`,
      title: item.label,
      message: item.message,
      tone: "bad" as const
    })),
    ...startupWarningChecks.slice(0, 2).map((item) => ({
      id: `startup-warning-${item.id}`,
      title: item.label,
      message: item.message,
      tone: "warn" as const
    })),
    blockedWorkItems.length > 0 ? {
      id: "blocked-work-items",
      title: "失败商品等待恢复",
      message: `${blockedWorkItems.length} 个商品未自动通过；这些故障处理不计入日常主指标。`,
      tone: "bad"
    } : null,
    dailyTrialGate.status === "failed" ? {
      id: "trial-failed",
      title: dailyTrialGate.recovery.title,
      message: dailyTrialGate.recovery.message,
      tone: dailyTrialGate.recovery.tone
    } : null
  ].filter((item): item is DailyAlert => Boolean(item))

  return {
    readyWorkItems,
    blockedWorkItems,
    browserRecoveryCandidateCount,
    directSafeRetryCandidateCount,
    releasedBrowserRecoveryCandidateCount,
    displayedBrowserRecoveryCandidateCount,
    pausedBrowserRecoveryCandidateCount,
    startupCalibrationCheck,
    startupBlockingChecks,
    startupWarningChecks,
    primaryStartupProblem,
    dailyBackendOffline,
    dailyBackendOfflineMessage,
    dailyTrialGate,
    dailyStartupCanStart,
    dailyCanStart,
    dailyAutomaticPass,
    dailyManualTriggers,
    dailyAutomaticPassTone,
    dailyManualTriggerTone,
    operatorAction,
    dailyModeLabel,
    dailyModeTone,
    dailyTrialTone,
    dailyTrialLabel,
    dailyActionTitle,
    dailyActionDetail,
    repeatedRecoveryAlert,
    validationTriageAlert,
    firstManualBudgetItem,
    publishFailureSummary,
    dailyAlerts
  }
}
