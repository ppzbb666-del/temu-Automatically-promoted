import { useQuery } from "@tanstack/react-query"
import type { AutomationDryRunJob, AutomationFillDraftJob, AutomationFullFlowJob, AutomationRepairApplyJob, AutomationRepairPreviewJob, AutomationSaveDraftJob, AutomationSubmitListingJob, SelectorCalibrationJob, DianxiaomiAccountScanJob, DianxiaomiImageCheckJob } from "@temu-ai-ops/shared"
import { fetchAutomationDryRunJobLog, fetchAutomationFillDraftJobLog, fetchAutomationRepairApplyJobLog, fetchAutomationRepairPreviewJobLog, fetchAutomationSaveDraftJobLog, fetchAutomationSubmitListingJobLog, fetchDianxiaomiAccountScanJobLog, fetchDianxiaomiImageCheckJobLog, fetchSelectorCalibrationJobLog } from "../api"

const jobStatusClass = (status: string) => status === "completed" ? "completed" : status === "failed" ? "failed" : "partial"

function JobLogGrid({ stdout, stderr }: { stdout?: string; stderr?: string }) {
  return (
    <div className="job-log-grid">
      <pre>{stdout || "stdout empty"}</pre>
      {stderr ? <pre className="error-log">{stderr}</pre> : null}
    </div>
  )
}

function JobCardShell({
  status, startedAt, exitCode, id, logPath, artifactDir, reportStatus, error, log
}: {
  status: string
  startedAt: string
  exitCode: number | null
  id: string
  logPath?: string
  artifactDir?: string
  reportStatus?: string | null
  error?: string | null
  log?: { stdout?: string; stderr?: string } | null
}) {
  return (
    <div className={`automation-report ${jobStatusClass(status)}`}>
      <div className="report-main">
        <strong>{status}</strong>
        <span>{new Date(startedAt).toLocaleString()}</span>
        <span>{exitCode === null ? "running" : `exit ${exitCode}`}</span>
      </div>
      <div className="report-detail">
        <span>{id}</span>
        {logPath ? <span>{logPath}</span> : null}
        {artifactDir ? <span>{artifactDir}</span> : null}
        {reportStatus ? <span>report {reportStatus}</span> : null}
        {error ? <span>{error}</span> : null}
      </div>
      {log ? <JobLogGrid stdout={log.stdout} stderr={log.stderr} /> : null}
    </div>
  )
}

export function DryRunJobCard({ job }: { job: AutomationDryRunJob }) {
  const { data: log } = useQuery({
    queryKey: ["automation-dry-run-job-log", job.id],
    queryFn: () => fetchAutomationDryRunJobLog(job.id),
    refetchInterval: job.status === "running" ? 3000 : false
  })

  return (
    <JobCardShell
      status={job.status}
      startedAt={job.startedAt}
      exitCode={job.exitCode}
      id={job.id}
      logPath={job.logPath}
      artifactDir={job.artifactDir}
      reportStatus={job.reportStatus}
      error={job.error}
      log={log}
    />
  )
}

export function FillDraftJobCard({ job }: { job: AutomationFillDraftJob }) {
  const { data: log } = useQuery({
    queryKey: ["automation-fill-draft-job-log", job.id],
    queryFn: () => fetchAutomationFillDraftJobLog(job.id),
    refetchInterval: job.status === "running" ? 3000 : false
  })

  return (
    <JobCardShell
      status={job.status}
      startedAt={job.startedAt}
      exitCode={job.exitCode}
      id={job.id}
      logPath={job.logPath}
      artifactDir={job.artifactDir}
      reportStatus={job.reportStatus}
      error={job.error}
      log={log}
    />
  )
}

export function RepairPreviewJobCard({ job }: { job: AutomationRepairPreviewJob }) {
  const { data: log } = useQuery({
    queryKey: ["automation-repair-preview-job-log", job.id],
    queryFn: () => fetchAutomationRepairPreviewJobLog(job.id),
    refetchInterval: job.status === "running" ? 3000 : false
  })

  return (
    <JobCardShell
      status={job.status}
      startedAt={job.startedAt}
      exitCode={job.exitCode}
      id={job.id}
      logPath={job.logPath}
      artifactDir={job.artifactDir}
      reportStatus={job.reportStatus}
      error={job.error}
      log={log}
    />
  )
}

export function RepairApplyJobCard({ job }: { job: AutomationRepairApplyJob }) {
  const { data: log } = useQuery({
    queryKey: ["automation-repair-apply-job-log", job.id],
    queryFn: () => fetchAutomationRepairApplyJobLog(job.id),
    refetchInterval: job.status === "running" ? 3000 : false
  })

  return (
    <JobCardShell
      status={job.status}
      startedAt={job.startedAt}
      exitCode={job.exitCode}
      id={job.id}
      logPath={job.logPath}
      artifactDir={job.artifactDir}
      reportStatus={job.reportStatus}
      error={job.error}
      log={log}
    />
  )
}

export function SaveDraftJobCard({ job }: { job: AutomationSaveDraftJob }) {
  const { data: log } = useQuery({
    queryKey: ["automation-save-draft-job-log", job.id],
    queryFn: () => fetchAutomationSaveDraftJobLog(job.id),
    refetchInterval: job.status === "running" ? 3000 : false
  })

  return (
    <JobCardShell
      status={job.status}
      startedAt={job.startedAt}
      exitCode={job.exitCode}
      id={job.id}
      logPath={job.logPath}
      artifactDir={job.artifactDir}
      reportStatus={job.reportStatus}
      error={job.error}
      log={log}
    />
  )
}

export function SubmitListingJobCard({ job }: { job: AutomationSubmitListingJob }) {
  const { data: log } = useQuery({
    queryKey: ["automation-submit-listing-job-log", job.id],
    queryFn: () => fetchAutomationSubmitListingJobLog(job.id),
    refetchInterval: job.status === "running" ? 3000 : false
  })

  return (
    <JobCardShell
      status={job.status}
      startedAt={job.startedAt}
      exitCode={job.exitCode}
      id={job.id}
      logPath={job.logPath}
      artifactDir={job.artifactDir}
      reportStatus={job.reportStatus}
      error={job.error}
      log={log}
    />
  )
}

export function FullFlowJobCard({ job }: { job: AutomationFullFlowJob }) {
  const statusClass = jobStatusClass(job.status)

  return (
    <div className={`automation-report ${statusClass}`}>
      <div className="report-main">
        <strong>full flow {job.status}</strong>
        <span>{new Date(job.startedAt).toLocaleString()}</span>
        <span>{job.finishedAt ? new Date(job.finishedAt).toLocaleString() : "running"}</span>
      </div>
      <div className="report-detail">
        <span>{job.id}</span>
        <span>{job.artifactDir}</span>
        <span>{job.targetFingerprint.slice(0, 12)}</span>
        {job.error ? <span>{job.error}</span> : null}
        {job.stages.map((stage) => (
          <span key={stage.name}>
            {stage.name}: {stage.status}{stage.reportStatus ? ` / ${stage.reportStatus}` : ""}{stage.jobId ? ` / ${stage.jobId}` : ""}
          </span>
        ))}
      </div>
    </div>
  )
}

export function SelectorCalibrationJobCard({ job }: { job: SelectorCalibrationJob }) {
  const { data: log } = useQuery({
    queryKey: ["selector-calibration-job-log", job.id],
    queryFn: () => fetchSelectorCalibrationJobLog(job.id),
    refetchInterval: job.status === "running" ? 3000 : false
  })

  return (
    <JobCardShell
      status={job.status}
      startedAt={job.startedAt}
      exitCode={job.exitCode}
      id={job.id}
      logPath={job.logPath}
      artifactDir={job.artifactDir}
      error={job.error}
      log={log}
    />
  )
}

export function DianxiaomiAccountScanJobCard({ job }: { job: DianxiaomiAccountScanJob }) {
  const { data: log } = useQuery({
    queryKey: ["dianxiaomi-account-scan-job-log", job.id],
    queryFn: () => fetchDianxiaomiAccountScanJobLog(job.id),
    refetchInterval: job.status === "running" ? 3000 : false
  })

  return (
    <div className={`automation-report ${jobStatusClass(job.status)}`}>
      <div className="report-main">
        <strong>account scan {job.status}</strong>
        <span>{new Date(job.startedAt).toLocaleString()}</span>
        <span>{job.exitCode === null ? "running" : `exit ${job.exitCode}`}</span>
      </div>
      <div className="report-detail">
        <span>{job.id}</span>
        <span>{job.artifactDir}</span>
        {job.result ? <span>stores {job.result.totals.storeCount} / links {job.result.totals.linkCount}</span> : null}
        {job.error ? <span>{job.error}</span> : null}
        {job.result?.stores.slice(0, 3).map((store) => (
          <span key={`${store.storeName}-${store.shopId ?? "none"}`}>
            {store.storeName}: {store.links.length}
          </span>
        ))}
      </div>
      {job.result?.warnings?.length ? (
        <div className="account-scan-warning-list">
          {job.result.warnings.map((warning) => <span key={warning}>{warning}</span>)}
        </div>
      ) : null}
      {log ? <JobLogGrid stdout={log.stdout} stderr={log.stderr} /> : null}
    </div>
  )
}

export function DianxiaomiImageCheckJobCard({ job }: { job: DianxiaomiImageCheckJob }) {
  const { data: log } = useQuery({
    queryKey: ["dianxiaomi-image-check-job-log", job.id],
    queryFn: () => fetchDianxiaomiImageCheckJobLog(job.id),
    refetchInterval: job.status === "running" ? 3000 : false
  })

  return (
    <div className={`automation-report ${jobStatusClass(job.status)}`}>
      <div className="report-main">
        <strong>image check {job.status}</strong>
        <span>{new Date(job.startedAt).toLocaleString()}</span>
        <span>{job.exitCode === null ? "running" : `exit ${job.exitCode}`}</span>
      </div>
      <div className="report-detail">
        <span>{job.id}</span>
        <span>{job.artifactDir}</span>
        <span>{job.workItemId}</span>
        {job.result ? <span>{job.result.passed ? "passed" : job.result.summary.join(" / ")}</span> : null}
        {job.error ? <span>{job.error}</span> : null}
      </div>
      {log ? <JobLogGrid stdout={log.stdout} stderr={log.stderr} /> : null}
    </div>
  )
}
