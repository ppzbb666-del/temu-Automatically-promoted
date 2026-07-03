import type { Dispatch, SetStateAction } from "react"
import type { AutomationPreflightReport, AutomationUnattendedStartupCheck } from "@temu-ai-ops/shared"

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {}

export function TargetSurfaceSummary({ step }: { step?: { data?: Record<string, unknown>; detail?: string; status?: string } }) {
  if (!step?.data) {
    return null
  }

  const data = step.data
  const readiness = asRecord(data.fieldReadiness)
  const status = String(data.surfaceStatus ?? "unknown")
  const canWrite = data.canWrite === true
  const canInspect = data.canInspect === true

  return (
    <div className={`target-surface-summary ${canWrite ? "ready" : "blocked"}`}>
      <strong>target surface: {status}</strong>
      <span>{canWrite ? "write allowed" : canInspect ? "inspect only" : "blocked"}</span>
      <span>{String(data.pageTitle ?? data.pageUrl ?? "")}</span>
      <span>{String(data.pageUrl ?? "")}</span>
      <div className="target-surface-grid">
        <span>host {data.isDianxiaomiHost === true ? "dianxiaomi" : "not dianxiaomi"}</span>
        <span>fixture {data.isDataFixture === true ? "yes" : "no"}</span>
        <span>title {String(readiness.title ?? 0)}</span>
        <span>sku rows {String(readiness.skuRows ?? 0)}</span>
        <span>media tools {String(readiness.mediaTools ?? 0)}</span>
        <span>editable {String(readiness.editableFields ?? 0)}</span>
      </div>
      {step.status === "failed" ? <span>{step.detail}</span> : null}
    </div>
  )
}

export function AutomationPreflightCard({ report }: { report: AutomationPreflightReport }) {
  const statusClass = report.overallStatus === "ready" ? "completed" : report.overallStatus === "blocked" ? "failed" : "partial"
  const latestJobSummary = [
    report.latestJobs.dryRun ? `dry-run ${report.latestJobs.dryRun.status}` : "dry-run none",
    report.latestJobs.repairPreview ? `repair-preview ${report.latestJobs.repairPreview.status}` : "repair-preview none",
    report.latestJobs.repairApply ? `repair-apply ${report.latestJobs.repairApply.status}` : "repair-apply none",
    report.latestJobs.fillDraft ? `fill-draft ${report.latestJobs.fillDraft.status}` : "fill-draft none",
    report.latestJobs.saveDraft ? `save-draft ${report.latestJobs.saveDraft.status}` : "save-draft none",
    report.latestJobs.submitListing ? `submit-listing ${report.latestJobs.submitListing.status}` : "submit-listing none"
  ]
  const targetSurfaceStep = report.latestReport?.steps.find((step) => step.id === "target-surface")

  return (
    <div className={`automation-report automation-preflight ${statusClass}`}>
      <div className="report-main">
        <strong>automation preflight</strong>
        <span>{report.overallStatus}</span>
        <span>recommended: {report.recommendedMode ?? "none"}</span>
        <span>ready modes: {report.readyModes.length > 0 ? report.readyModes.join(", ") : "none"}</span>
      </div>
      <div className="report-detail">
        <span>checked {new Date(report.checkedAt).toLocaleString()}</span>
        <span>target {report.targetFingerprint.slice(0, 12)}</span>
        {report.activeTask ? <span>active task {report.activeTask.id} / {report.activeTask.status}</span> : null}
        {report.latestReport ? <span>latest report {report.latestReport.status}: {report.latestReport.id}</span> : null}
        <TargetSurfaceSummary step={targetSurfaceStep} />
        <div className="automation-preflight-checks">
          {report.checks.map((check) => (
            <div key={check.id} className={`automation-preflight-check ${check.status}`}>
              <span>{check.label}</span>
              <strong>{check.status}</strong>
              <p>{check.message}</p>
              {check.details?.slice(0, 3).map((detail) => <small key={detail}>{detail}</small>)}
            </div>
          ))}
        </div>
        <div className="automation-preflight-jobs">
          {latestJobSummary.map((item) => <span key={item}>{item}</span>)}
        </div>
      </div>
    </div>
  )
}

export function UnattendedStartupCheckCard({ check }: { check: AutomationUnattendedStartupCheck }) {
  const statusClass = check.status === "ready" ? "completed" : check.status === "blocked" ? "failed" : "partial"
  const calibrationCheck = check.checks.find((item) => item.id === "real-dianxiaomi-calibration")

  return (
    <div className={`automation-report unattended-startup ${statusClass}`}>
      <div className="report-main">
        <strong>unattended startup {check.status}</strong>
        <span>{check.canStart ? "can start" : "blocked"}</span>
        <span>{new Date(check.checkedAt).toLocaleString()}</span>
        <span>ready {check.health.workItems.ready}</span>
        <span>blocked {check.health.workItems.blocked}</span>
      </div>
      <div className="report-detail">
        <span>{check.recommendedAction}</span>
        <span>mode {check.normalizedInput.mediaAutomationMode ?? "unattended-apply"}</span>
        <span>submit after save {check.normalizedInput.submitAfterSave ? "on" : "off"}</span>
        <span>attempts {check.normalizedInput.submitMaxAttempts ?? 3}</span>
        <span>profile {check.health.profile.path ?? "not configured"}</span>
      </div>
      {calibrationCheck ? (
        <div className={`startup-calibration-banner ${calibrationCheck.status}`}>
          <strong>real Dianxiaomi calibration: {calibrationCheck.status}</strong>
          <span>{calibrationCheck.message}</span>
          {calibrationCheck.details?.slice(0, 3).map((detail) => <small key={detail}>{detail}</small>)}
        </div>
      ) : null}
      <div className="automation-preflight-checks">
        {check.checks.map((item) => (
          <div key={item.id} className={`automation-preflight-check ${item.status}`}>
            <span>{item.status}</span>
            <strong>{item.label}</strong>
            <p>{item.message}</p>
            {item.details?.slice(0, 4).map((detail) => <small key={detail}>{detail}</small>)}
          </div>
        ))}
      </div>
      <div className="startup-runbook">
        {check.runbook.map((item) => <span key={item}>{item}</span>)}
      </div>
    </div>
  )
}

export function AutomationRunConfirmation({
  report,
  writeModeConfirmed,
  setWriteModeConfirmed
}: {
  report: AutomationPreflightReport
  writeModeConfirmed: boolean
  setWriteModeConfirmed: Dispatch<SetStateAction<boolean>>
}) {
  const taskSourceCheck = report.checks.find((check) => check.id === "task-source" || check.id === "publish-check")
  const selectorCheck = report.checks.find((check) => check.id === "selector-validation")
  const repairPreviewReady = report.readiness.repairPreview?.ready ?? false
  const repairApplyReady = report.readiness.repairApply?.ready ?? false
  const writeModeReady = report.readiness.fillDraft.ready || report.readiness.saveDraft.ready || report.readiness.submitListing.ready
  const summaryItems = [
    {
      label: "Task",
      status: taskSourceCheck?.status ?? "block",
      detail: taskSourceCheck?.message ?? "task source loading"
    },
    {
      label: "Selectors",
      status: selectorCheck?.status ?? "block",
      detail: selectorCheck?.message ?? "selector validation loading"
    },
    {
      label: "Dry-run",
      status: report.readiness.dryRun.ready ? "pass" : "block",
      detail: report.readiness.dryRun.reason
    },
    {
      label: "Repair preview",
      status: repairPreviewReady ? "pass" : "warning",
      detail: `fault recovery only: ${report.readiness.repairPreview?.reason ?? "no repair plan selected"}`
    },
    {
      label: "Repair apply",
      status: repairApplyReady ? "pass" : "warning",
      detail: `fault recovery only: ${report.readiness.repairApply?.reason ?? "no repair plan selected"}`
    },
    {
      label: "Write modes",
      status: writeModeReady ? "pass" : "block",
      detail: writeModeReady ? "fill/save/submit gate is ready for this target" : report.readiness.fillDraft.reason
    },
    {
      label: "Submit",
      status: report.readiness.submitListing.ready ? "pass" : "block",
      detail: report.readiness.submitListing.reason
    }
  ] as const

  return (
    <div className={`run-confirmation ${report.overallStatus}`}>
      <div className="run-confirmation-head">
        <div>
          <strong>run confirmation</strong>
          <span>{report.overallStatus} / target {report.targetFingerprint.slice(0, 12)}</span>
        </div>
        <span>{report.recommendedMode ? `next ${report.recommendedMode}` : "no mode ready"}</span>
      </div>
      <div className="run-confirmation-grid">
        {summaryItems.map((item) => (
          <div key={item.label} className={`run-confirmation-item ${item.status}`}>
            <strong>{item.label}</strong>
            <span>{item.status}</span>
            <p>{item.detail}</p>
          </div>
        ))}
      </div>
      <label className={`write-confirmation ${writeModeConfirmed ? "confirmed" : ""}`}>
        <input
          type="checkbox"
          checked={writeModeConfirmed}
          onChange={(event) => setWriteModeConfirmed(event.target.checked)}
        />
        <span>I checked the task file, selectors, target fingerprint, and staged reports before writing or submitting in Dianxiaomi.</span>
      </label>
    </div>
  )
}
