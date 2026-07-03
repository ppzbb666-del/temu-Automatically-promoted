import { Fragment, useMemo, useState } from "react"
import type { AutomationManualStepBudgetTrialProposal, AutomationManualStepBudgetTrialRequestResult, AutomationProfileLockArchiveReadiness, AutomationQueueDaemonHealth, AutomationQueueDaemonState, AutomationQueueRunStartResult, AutomationRecoveryRun } from "@temu-ai-ops/shared"

type ManualProofConfidenceFilter = "all" | "measured" | "estimated" | "weak"

const manualProofConfidenceFilters: Array<{
  value: ManualProofConfidenceFilter
  label: string
}> = [
  { value: "all", label: "All" },
  { value: "measured", label: "Measured" },
  { value: "estimated", label: "Estimated" },
  { value: "weak", label: "Weak" }
]

export function QueueRunCard({ run }: { run: AutomationQueueRunStartResult }) {
  const statusClass = run.skipped > 0 ? "partial" : "completed"

  return (
    <div className={`automation-report ${statusClass}`}>
      <div className="report-main">
        <strong>queue run</strong>
        <span>{new Date(run.startedAt).toLocaleString()}</span>
        <span>queued {run.queued} / skipped {run.skipped}</span>
      </div>
      <div className="report-detail">
        <span>{run.id}</span>
        <span>limit {run.limit}</span>
        {run.autoRetryReleasedIds.length > 0 ? <span>released recovery {run.autoRetryReleasedIds.length}</span> : null}
        {run.flowJobIds.map((id) => <span key={id}>flow {id}</span>)}
        {run.skippedItems.map((item) => <span key={item.workItemId}>{item.workItemId}: {item.reason}</span>)}
      </div>
    </div>
  )
}

export function RecoveryRunCard({ run }: { run: AutomationRecoveryRun }) {
  const statusClass = run.status === "completed" && run.failed === 0 ? "completed" : run.status === "failed" ? "failed" : "partial"

  return (
    <div className={`automation-report ${statusClass}`}>
      <div className="report-main">
        <strong>recovery run {run.status}</strong>
        <span>{new Date(run.startedAt).toLocaleString()}</span>
        <span>queued {run.queued}</span>
        <span>completed {run.completed}</span>
        <span>failed {run.failed}</span>
        <span>skipped {run.skipped}</span>
      </div>
      <div className="report-detail">
        <span>{run.id}</span>
        <span>policy {run.input.recoveryPolicy ?? "normal"}</span>
        {run.finishedAt ? <span>finished {new Date(run.finishedAt).toLocaleString()}</span> : <span>running</span>}
        {run.items.slice(0, 6).map((item) => (
          <span key={item.workItemId}>
            {item.status} / {item.workItemId}: {item.reason ?? item.fullFlowJobId ?? item.repairApplyJobId ?? item.repairPreviewJobId ?? "pending"}
          </span>
        ))}
      </div>
    </div>
  )
}

export function QueueDaemonCard({ state }: { state: AutomationQueueDaemonState }) {
  const statusClass = state.status === "ACTIVE"
    ? state.consecutiveFailures > 0 ? "partial" : "completed"
    : state.lastError ? "failed" : "partial"

  return (
    <div className={`automation-report ${statusClass}`}>
      <div className="report-main">
        <strong>queue daemon {state.status.toLowerCase()}</strong>
        <span>{state.running ? "tick running" : "idle"}</span>
        <span>every {state.intervalSeconds}s</span>
        <span>failures {state.consecutiveFailures}/{state.maxConsecutiveFailures}</span>
      </div>
      <div className="report-detail">
        {state.nextRunAt ? <span>next {new Date(state.nextRunAt).toLocaleString()}</span> : null}
        {state.lastStartedAt ? <span>last start {new Date(state.lastStartedAt).toLocaleString()}</span> : null}
        {state.lastFinishedAt ? <span>last finish {new Date(state.lastFinishedAt).toLocaleString()}</span> : null}
        {state.lastQueueRunId ? <span>queue {state.lastQueueRunId}</span> : null}
        {state.lastRecoveryRunId ? <span>recovery {state.lastRecoveryRunId}</span> : null}
        {state.lastError ? <span>{state.lastError}</span> : null}
        <span>limit {state.input.limit ?? 5}</span>
        <span>submit after save {state.input.submitAfterSave ? "on" : "off"}</span>
        <span>submit attempts {state.input.submitMaxAttempts ?? 3}</span>
        <span>tracked flows {state.trackedFlowJobIds.length}</span>
        <span>resolved flows {state.resolvedFlowJobIds.length}</span>
      </div>
      {state.flowOutcomes.length > 0 ? (
        <div className="automation-preflight-jobs">
          {state.flowOutcomes.slice(0, 5).map((outcome) => (
            <span key={outcome.flowJobId}>
              {outcome.status} / {outcome.workItemId}: {outcome.error ?? outcome.note} / {new Date(outcome.resolvedAt).toLocaleTimeString()}
            </span>
          ))}
        </div>
      ) : null}
      {state.ticks.length > 0 ? (
        <div className="automation-preflight-jobs">
          {state.ticks.slice(0, 5).map((tick) => (
            <span key={tick.id}>
              {tick.status} / {tick.category}: {tick.reason ?? tick.error ?? "done"}{tick.recoveryRun ? ` / recovery ${tick.recoveryRun.id}` : ""}{tick.manualBudgetValidationRun ? ` / validation ${tick.manualBudgetValidationRun.id}` : ""}{tick.flowOutcomes.length > 0 ? ` / recovered ${tick.flowOutcomes.length}` : ""} / {new Date(tick.startedAt).toLocaleTimeString()}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function QueueDaemonHealthCard({
  health,
  profileLockArchiveReadiness,
  manualBudgetTrials = [],
  manualBudgetTrialPending = false,
  profileLockArchivePending = false,
  onStartManualBudgetTrial,
  onStartNextManualBudgetValidation,
  onArchiveStaleProfileLocks
}: {
  health: AutomationQueueDaemonHealth
  profileLockArchiveReadiness?: AutomationProfileLockArchiveReadiness
  manualBudgetTrials?: AutomationManualStepBudgetTrialRequestResult[]
  manualBudgetTrialPending?: boolean
  profileLockArchivePending?: boolean
  onStartManualBudgetTrial?: (proposal: AutomationManualStepBudgetTrialProposal) => void
  onStartNextManualBudgetValidation?: () => void
  onArchiveStaleProfileLocks?: () => void
}) {
  const statusClass = health.status === "healthy" ? "completed" : health.status === "blocked" ? "failed" : "partial"
  const manualBudgetReleases = health.manualBudget.releases ?? []
  const manualBudgetReplacementQueue = health.manualBudget.replacementQueue ?? []
  const manualBudgetProofs = health.manualBudget.proofs ?? []
  const manualBudgetTrialProposals = health.manualBudget.trialProposals ?? []
  const manualBudgetValidationClosure = health.manualBudget.validationClosure ?? {
    status: "idle",
    message: "no manual-step validation requests have been recorded",
    total: 0,
    running: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    latestTrialId: null,
    latestCandidateKey: null,
    latestStatus: null,
    latestUpdatedAt: null,
    latestMessage: null,
    latestProofRecordId: null,
    latestMeasurement: null,
    failureTriage: {
      status: "none",
      category: null,
      route: "none",
      reason: null,
      nextAction: "No validation failure needs triage.",
      recoverable: false,
      countsAsManualBudget: false,
      trialId: null,
      candidateKey: null,
      workItemIds: []
    },
    rerunPolicy: {
      status: "not-needed",
      route: "none",
      sourceTrialId: null,
      retryTrialId: null,
      candidateKey: null,
      attemptsUsed: 0,
      maxAttempts: 1,
      prerequisiteStatus: "none",
      prerequisiteCompletedAt: null,
      reason: "No validation rerun is needed.",
      nextAction: "Continue normal queue processing.",
      workItemIds: []
    }
  }
  const manualBudgetValidationRerunPolicy = manualBudgetValidationClosure.rerunPolicy
  const runningManualBudgetTrials = manualBudgetTrials.filter((trial) => trial.outcome.status === "running").length
  const passedManualBudgetTrials = manualBudgetTrials.filter((trial) => trial.outcome.status === "passed").length
  const failedManualBudgetTrials = manualBudgetTrials.filter((trial) => trial.outcome.status === "failed").length
  const [manualProofConfidenceFilter, setManualProofConfidenceFilter] = useState<ManualProofConfidenceFilter>("all")
  const manualProofConfidenceCounts = useMemo(() => {
    const counts: Record<ManualProofConfidenceFilter, number> = {
      all: manualBudgetReplacementQueue.length,
      measured: 0,
      estimated: 0,
      weak: 0
    }
    for (const candidate of manualBudgetReplacementQueue) {
      counts[candidate.proofGate.confidence] += 1
    }
    return counts
  }, [manualBudgetReplacementQueue])
  const filteredManualBudgetReplacementQueue = manualBudgetReplacementQueue.filter((candidate) =>
    manualProofConfidenceFilter === "all" || candidate.proofGate.confidence === manualProofConfidenceFilter
  )
  const filteredManualBudgetProofs = manualBudgetProofs.filter((proof) =>
    manualProofConfidenceFilter === "all" || proof.confidence === manualProofConfidenceFilter
  )
  const filteredManualBudgetTrialProposals = manualBudgetTrialProposals.filter((proposal) =>
    manualProofConfidenceFilter === "all" || proposal.proofConfidence === manualProofConfidenceFilter
  )

  return (
    <div className={`automation-report queue-health ${statusClass}`}>
      <div className="report-main">
        <strong>queue health {health.status}</strong>
        <span>{new Date(health.checkedAt).toLocaleString()}</span>
        <span>{health.queue.daemonStatus.toLowerCase()}</span>
        <span>ready {health.workItems.ready}</span>
        <span>blocked {health.workItems.blocked}</span>
        <span>safe retry {health.workItems.autoRetryCandidates}</span>
        <span>browser recovery {health.workItems.browserRecoveryCandidates}</span>
        <span>released retry {health.workItems.releasedBrowserRecoveryCandidates}</span>
        <span>paused recovery {health.workItems.pausedBrowserRecoveryCandidates}</span>
      </div>
      <div className="report-detail">
        <span>profile {health.profile.path ?? "not configured"}</span>
        <span>profile exists {health.profile.exists ? "yes" : "no"}</span>
        <span>locks {health.profile.lockFiles.length}</span>
        <span>stale locks {health.profile.staleLockFiles.length}</span>
        <span>lock audit {health.profile.lockAudit.ignored} ignored / {health.profile.lockAudit.archived} archived</span>
        <span>failures {health.queue.consecutiveFailures}/{health.queue.maxConsecutiveFailures}</span>
        <span>tracked {health.flows.tracked} / unresolved {health.flows.unresolved}</span>
        <span>recent failed flows {health.flows.recentFailures}</span>
        <span>audit entries {health.audit.recent.length}</span>
        <span>recovery history {health.recovery.history}</span>
        <span>repeated recovery {health.recovery.repeatedFailures.length}</span>
        <span>recovery releases {health.recovery.releases.length}</span>
        <span>released retry batch {health.recovery.releasedRetryBatch.maxItemsPerTick}/tick</span>
        <span>released retry outcomes {health.recovery.releasedRetryOutcomes.length}</span>
        <span>manual budget {health.manualBudget.total}</span>
        <span>manual releases {manualBudgetReleases.length}</span>
        <span>manual replacements {manualBudgetReplacementQueue.length}</span>
        <span>bounded trials {manualBudgetTrialProposals.length}</span>
        <span>trial requests {manualBudgetTrials.length}</span>
        <span>validation {manualBudgetValidationClosure.status}</span>
        <span>manual proofs {manualBudgetProofs.length}</span>
        {health.queue.lastFailedCategory ? <span>last category {health.queue.lastFailedCategory}</span> : null}
        {health.queue.lastError ? <span>{health.queue.lastError}</span> : null}
      </div>
      <div className="queue-health-alerts">
        <div className={health.recommendation.level}>
          <strong>{health.recommendation.title}</strong>
          <span>{health.recommendation.detail}</span>
          <span>{health.recommendation.action}</span>
        </div>
      </div>
      <div className="manual-proof-filter">
        <div className="manual-proof-filter-summary">
          <strong>Proof Confidence</strong>
          <span>{filteredManualBudgetReplacementQueue.length}/{manualBudgetReplacementQueue.length} replacements</span>
          <span>{filteredManualBudgetTrialProposals.length}/{manualBudgetTrialProposals.length} trials</span>
          <span>{filteredManualBudgetProofs.length}/{manualBudgetProofs.length} proofs</span>
        </div>
        <div className="manual-proof-filter-buttons" role="group" aria-label="Proof confidence filter">
          {manualProofConfidenceFilters.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={`manual-proof-filter-button ${manualProofConfidenceFilter === filter.value ? "active" : ""}`}
              onClick={() => setManualProofConfidenceFilter(filter.value)}
            >
              {filter.label} {manualProofConfidenceCounts[filter.value]}
            </button>
          ))}
        </div>
      </div>
      <div className="queue-health-grid">
        <div>
          <strong>Work items</strong>
          <span>total {health.workItems.total}</span>
          <span>ready {health.workItems.ready}</span>
          <span>safe retry {health.workItems.autoRetryCandidates}</span>
          <span>browser recovery {health.workItems.browserRecoveryCandidates}</span>
          <span>released retry {health.workItems.releasedBrowserRecoveryCandidates}</span>
          <span>paused recovery {health.workItems.pausedBrowserRecoveryCandidates}</span>
          <span>publish failed {health.workItems.publishFailed}</span>
          <span>publish recovery {health.workItems.publishRecoveryCandidates}</span>
          <span>publish manual budget {health.workItems.publishManualBudget}</span>
          <span>needs revision {health.workItems.needsRevision}</span>
          <span>edited {health.workItems.edited}</span>
        </div>
        <div>
          <strong>Manual Step Budget</strong>
          <span>total {health.manualBudget.total}</span>
          {health.manualBudget.publishOutcomes.slice(0, 3).map((item) => (
            <span key={`manual-budget-${item.workItemId}`}>
              {item.workItemId}: {item.reason} / action {item.operatorAction} / release {item.releaseCondition}
            </span>
          ))}
          {health.manualBudget.total === 0 ? <span>none</span> : null}
          {manualBudgetReleases.slice(0, 3).map((release) => (
            <span key={`manual-budget-release-${release.workItemId}-${release.releaseEventAt}`}>
              released {release.workItemId}: {release.releaseType} / {release.reason} / {release.note || "no note"}
            </span>
          ))}
          {manualBudgetReleases.length > 0 ? <span>releases {manualBudgetReleases.length}</span> : null}
        </div>
        <div>
          <strong>Replacement Queue</strong>
          {filteredManualBudgetReplacementQueue.slice(0, 3).map((candidate) => (
            <span key={`manual-budget-replacement-${candidate.key}`}>
              {candidate.activeCount} active / {candidate.releasedCount} released: {candidate.reason} / plan {candidate.replacementPlan} / proof {candidate.proofGate.status}+{candidate.proofGate.confidence}{candidate.proofGate.proofRecordId ? ` (${candidate.proofGate.proofRecordId})` : ""} / evidence {candidate.proofGate.evidence}
            </span>
          ))}
          {manualBudgetReplacementQueue.length === 0 ? <span>none</span> : null}
          {manualBudgetReplacementQueue.length > 0 && filteredManualBudgetReplacementQueue.length === 0 ? <span>none for selected confidence</span> : null}
        </div>
        <div>
          <strong>Manual Proof Ledger</strong>
          {filteredManualBudgetProofs.slice(0, 3).map((proof) => (
            <span key={`manual-budget-proof-${proof.id}`}>
              {proof.status}+{proof.confidence}: {proof.candidateKey} / trial {proof.trial.status} / click {proof.clickReductionPerProduct.toFixed(2)} / decision {proof.decisionReductionPerProduct.toFixed(2)}{proof.automationMeasurement ? ` / measured ${proof.automationMeasurement.browserClicks} clicks, ${proof.automationMeasurement.browserActions} actions, ${proof.automationMeasurement.reportCount} reports` : ""} / {proof.evidence}
            </span>
          ))}
          {manualBudgetProofs.length === 0 ? <span>none</span> : null}
          {manualBudgetProofs.length > 0 && filteredManualBudgetProofs.length === 0 ? <span>none for selected confidence</span> : null}
        </div>
        <div>
          <strong>Validation Closure</strong>
          <span>{manualBudgetValidationClosure.status}: {manualBudgetValidationClosure.message}</span>
          <span>
            total {manualBudgetValidationClosure.total} / running {manualBudgetValidationClosure.running} / passed {manualBudgetValidationClosure.passed} / failed {manualBudgetValidationClosure.failed} / blocked {manualBudgetValidationClosure.blocked}
          </span>
          {manualBudgetValidationClosure.latestTrialId ? (
            <span>
              latest {manualBudgetValidationClosure.latestStatus}: {manualBudgetValidationClosure.latestCandidateKey} / {manualBudgetValidationClosure.latestTrialId} / updated {manualBudgetValidationClosure.latestUpdatedAt ? new Date(manualBudgetValidationClosure.latestUpdatedAt).toLocaleString() : "unknown"}
            </span>
          ) : null}
          {manualBudgetValidationClosure.latestMessage ? <span>{manualBudgetValidationClosure.latestMessage}</span> : null}
          {manualBudgetValidationClosure.latestProofRecordId ? <span>proof {manualBudgetValidationClosure.latestProofRecordId}</span> : null}
          <span>
            rerun {manualBudgetValidationRerunPolicy.status} / route {manualBudgetValidationRerunPolicy.route} / attempts {manualBudgetValidationRerunPolicy.attemptsUsed}/{manualBudgetValidationRerunPolicy.maxAttempts}
          </span>
          <span>
            prerequisite {manualBudgetValidationRerunPolicy.prerequisiteStatus}{manualBudgetValidationRerunPolicy.prerequisiteCompletedAt ? ` / completed ${new Date(manualBudgetValidationRerunPolicy.prerequisiteCompletedAt).toLocaleString()}` : ""}
          </span>
          {manualBudgetValidationRerunPolicy.sourceTrialId || manualBudgetValidationRerunPolicy.retryTrialId ? (
            <span>
              source {manualBudgetValidationRerunPolicy.sourceTrialId ?? "none"} / retry {manualBudgetValidationRerunPolicy.retryTrialId ?? "none"}
            </span>
          ) : null}
          {manualBudgetValidationRerunPolicy.reason ? <span>rerun reason {manualBudgetValidationRerunPolicy.reason}</span> : null}
          <span>rerun next {manualBudgetValidationRerunPolicy.nextAction}</span>
          {manualBudgetValidationRerunPolicy.workItemIds.length > 0 ? (
            <span>rerun items {manualBudgetValidationRerunPolicy.workItemIds.join(", ")}</span>
          ) : null}
          <span>
            triage {manualBudgetValidationClosure.failureTriage.status} / route {manualBudgetValidationClosure.failureTriage.route} / category {manualBudgetValidationClosure.failureTriage.category ?? "none"}
          </span>
          {manualBudgetValidationClosure.failureTriage.reason ? <span>reason {manualBudgetValidationClosure.failureTriage.reason}</span> : null}
          <span>next {manualBudgetValidationClosure.failureTriage.nextAction}</span>
          {manualBudgetValidationClosure.failureTriage.workItemIds.length > 0 ? (
            <span>items {manualBudgetValidationClosure.failureTriage.workItemIds.join(", ")}</span>
          ) : null}
          {manualBudgetValidationClosure.latestMeasurement ? (
            <span>
              measured {manualBudgetValidationClosure.latestMeasurement.browserClicks} clicks, {manualBudgetValidationClosure.latestMeasurement.browserActions} actions, {manualBudgetValidationClosure.latestMeasurement.reportCount} reports
            </span>
          ) : null}
        </div>
        <div>
          <strong>Bounded Trial Proposals</strong>
          {onStartNextManualBudgetValidation ? (
            <button
              type="button"
              className="ghost-button small-button"
              onClick={onStartNextManualBudgetValidation}
              disabled={manualBudgetTrialPending || manualBudgetTrialProposals.length === 0}
            >
              {manualBudgetTrialPending ? "requesting validation..." : "run next held validation"}
            </button>
          ) : null}
          {filteredManualBudgetTrialProposals.slice(0, 2).map((proposal) => (
            <Fragment key={`manual-budget-trial-${proposal.candidateKey}`}>
              <span>
                trial {proposal.trialSize}: {proposal.reason} / readiness {proposal.readinessStatus} / execution {proposal.executionReady ? "ready" : "blocked"} / proof {proposal.proofRecordId} / measured {proposal.measuredBrowserClicks} clicks, {proposal.measuredBrowserActions} actions, {proposal.measuredReportCount} reports
              </span>
              <span>scope {proposal.trialScope}</span>
              <span>checks {proposal.readinessChecks.map((check) => `${check.status}:${check.label}`).join(" / ")}</span>
              {proposal.rollbackAcknowledgementRequired ? <span>rollback acknowledgement required before execution</span> : null}
              <span>accept {proposal.acceptanceCriteria.join(" / ")}</span>
              <span>rollback {proposal.rollbackCriteria.join(" / ")}</span>
              {proposal.sampleWorkItemIds.length > 0 ? (
                <span>samples {proposal.sampleWorkItemIds.join(", ")}</span>
              ) : null}
              {onStartManualBudgetTrial ? (
                <button
                  type="button"
                  className="ghost-button small-button"
                  onClick={() => onStartManualBudgetTrial(proposal)}
                  disabled={manualBudgetTrialPending}
                >
                  {manualBudgetTrialPending ? "requesting trial..." : "ack rollback + request trial"}
                </button>
              ) : null}
            </Fragment>
          ))}
          {manualBudgetTrialProposals.length === 0 ? <span>none</span> : null}
          {manualBudgetTrialProposals.length > 0 && filteredManualBudgetTrialProposals.length === 0 ? <span>none for selected confidence</span> : null}
        </div>
        <div>
          <strong>Bounded Trial Requests</strong>
          <span>running {runningManualBudgetTrials} / passed {passedManualBudgetTrials} / failed {failedManualBudgetTrials}</span>
          {manualBudgetTrials.slice(0, 4).map((trial) => (
            <Fragment key={`manual-budget-trial-request-${trial.id}`}>
              <span>
                {trial.outcome.status}: {trial.candidateKey} / flows {trial.flowJobIds.length} / skipped {trial.skippedItems.length} / updated {new Date(trial.updatedAt).toLocaleString()}
              </span>
              <span>{trial.outcome.message}</span>
              {trial.outcome.proofRecordId ? <span>proof {trial.outcome.proofRecordId}</span> : null}
              {trial.outcome.automationMeasurement ? (
                <span>
                  measured {trial.outcome.automationMeasurement.browserClicks} clicks, {trial.outcome.automationMeasurement.browserActions} actions, {trial.outcome.automationMeasurement.reportCount} reports
                </span>
              ) : null}
              {trial.outcome.flowOutcomes.slice(0, 3).map((outcome) => (
                <span key={`trial-flow-${trial.id}-${outcome.flowJobId}`}>
                  flow {outcome.status}: {outcome.workItemId ?? outcome.flowJobId}{outcome.failureReason ? ` / ${outcome.failureReason}` : ""}
                </span>
              ))}
            </Fragment>
          ))}
          {manualBudgetTrials.length === 0 ? <span>none</span> : null}
        </div>
        <div>
          <strong>Profile</strong>
          <span>{health.profile.path ?? "no path"}</span>
          {health.profile.lockFiles.length > 0 ? <span>active locks {health.profile.lockFiles.join(", ")}</span> : <span>no active lock files</span>}
          {health.profile.staleLockFiles.length > 0 ? <span>stale locks {health.profile.staleLockFiles.join(", ")}</span> : null}
          <span>lock audit ignored {health.profile.lockAudit.ignored} / archived {health.profile.lockAudit.archived}</span>
          {health.profile.lockAudit.recent.slice(0, 3).map((entry) => (
            <span key={entry.id}>
              {entry.action}: {entry.fileName} / age {entry.ageMinutes ?? "unknown"} min / threshold {entry.staleThresholdMinutes} min / next {entry.nextAction}
            </span>
          ))}
          {health.profile.lockAudit.recent.length === 0 ? <span>no profile lock audit entries</span> : null}
          {profileLockArchiveReadiness ? (
            <Fragment>
              <span>archive readiness {profileLockArchiveReadiness.status}: {profileLockArchiveReadiness.message}</span>
              <span>archive directory {profileLockArchiveReadiness.archiveDirectory ?? "none"}</span>
              <span>archive ready {profileLockArchiveReadiness.readyItems.length} / blocked {profileLockArchiveReadiness.blockedItems.length}</span>
              {onArchiveStaleProfileLocks ? (
                <button
                  type="button"
                  className="ghost-button small-button"
                  onClick={onArchiveStaleProfileLocks}
                  disabled={profileLockArchivePending || profileLockArchiveReadiness.status !== "ready" || profileLockArchiveReadiness.readyItems.length === 0}
                >
                  {profileLockArchivePending ? "archiving stale locks..." : "archive stale locks"}
                </button>
              ) : null}
              {[...profileLockArchiveReadiness.readyItems, ...profileLockArchiveReadiness.blockedItems].slice(0, 3).map((item) => (
                <span key={`profile-lock-archive-${item.fileName}-${item.archiveTarget}`}>
                  {item.ready ? "ready" : "blocked"} {item.fileName} / age {item.ageMinutes ?? "unknown"} min / target {item.archiveTarget} / {item.reason}
                </span>
              ))}
            </Fragment>
          ) : null}
        </div>
        <div>
          <strong>Released Retry Policy</strong>
          <span>policy {health.recovery.releasedRetryBatch.policy}</span>
          <span>pending {health.recovery.releasedRetryBatch.pendingCount}</span>
          <span>max per tick {health.recovery.releasedRetryBatch.maxItemsPerTick}</span>
          <span>normal recovery held {health.recovery.releasedRetryBatch.normalRecoveryHeld ? "yes" : "no"}</span>
          <span>next {health.recovery.releasedRetryBatch.nextWorkItemIds.join(", ") || "none"}</span>
        </div>
      </div>
      <div className="queue-health-alerts">
        {health.alerts.map((alert) => (
          <div key={alert.id} className={alert.level}>
            <strong>{alert.message}</strong>
            <span>{alert.action}</span>
          </div>
        ))}
      </div>
      {health.audit.recent.length > 0 ? (
        <div className="queue-health-issues">
          {health.audit.recent.slice(0, 5).map((entry) => (
            <span key={entry.tickId} className={entry.countsAsFailure ? "warning" : "info"}>
              audit {entry.decision}: {entry.subject} / {entry.reason} / next {entry.nextAction}
            </span>
          ))}
        </div>
      ) : null}
      {health.recovery.repeatedFailures.length > 0 ? (
        <div className="queue-health-issues">
          {health.recovery.paused.map((pause) => (
            <span key={`paused-${pause.key}`} className="warning">
              paused {pause.kind}: {pause.workItemId ?? pause.repairAction} / {pause.releaseReason}
            </span>
          ))}
          {health.recovery.repeatedFailures.map((failure) => (
            <span key={failure.key} className="warning">
              recovery {failure.kind} x{failure.count}: {failure.workItemId ?? failure.repairAction} / {failure.latestReason ?? "no reason"}
            </span>
          ))}
        </div>
      ) : null}
      {health.recovery.releases.length > 0 ? (
        <div className="queue-health-issues">
          {health.recovery.releases.slice(0, 5).map((release) => (
            <span key={`release-${release.key}-${release.releaseEventAt}`} className="info">
              released {release.kind}: {release.workItemId ?? release.repairAction} / {release.releaseType} / {release.releaseReason}
            </span>
          ))}
        </div>
      ) : null}
      {health.recovery.releasedRetryCandidates.length > 0 ? (
        <div className="queue-health-issues">
          {health.recovery.releasedRetryCandidates.slice(0, 5).map((candidate) => (
            <span key={`released-retry-${candidate.workItemId}`} className="warning">
              released retry {candidate.workItemId}: {candidate.title} / {candidate.releaseReason}
            </span>
          ))}
        </div>
      ) : null}
      {health.recovery.releasedRetryOutcomes.length > 0 ? (
        <div className="queue-health-issues">
          {health.recovery.releasedRetryOutcomes.slice(0, 5).map((outcome) => (
            <span
              key={`released-retry-outcome-${outcome.runId}-${outcome.workItemId}`}
              className={outcome.nextState === "completed" ? "info" : outcome.nextState === "repaused" ? "warning" : "info"}
            >
              released retry outcome {outcome.nextState}: {outcome.workItemId} / {outcome.status} / {outcome.reason ?? outcome.nextAction}
            </span>
          ))}
        </div>
      ) : null}
      {health.issues.length > 0 ? (
        <div className="queue-health-issues">
          {health.issues.map((issue) => (
            <span key={issue.id} className={issue.level}>{issue.level}: {issue.message}</span>
          ))}
        </div>
      ) : (
        <div className="queue-health-issues">
          <span className="info">info: no queue health issues detected</span>
        </div>
      )}
    </div>
  )
}
