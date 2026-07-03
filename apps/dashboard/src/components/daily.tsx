import type { DianxiaomiProductWorkItem } from "@temu-ai-ops/shared"

export function DailyMetric({
  label,
  value,
  detail,
  tone
}: {
  label: string
  value: string
  detail?: string
  tone: "good" | "warn" | "bad" | "neutral"
}) {
  return (
    <div className={`daily-metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  )
}

export function DailyWorkItemList({
  items,
  emptyText,
  onRetryAfterFix,
  retryingItemId,
  retryError
}: {
  items: DianxiaomiProductWorkItem[]
  emptyText: string
  onRetryAfterFix?: (id: string) => void
  retryingItemId?: string
  retryError?: string | null
}) {
  if (items.length === 0) {
    return <div className="daily-empty">{emptyText}</div>
  }

  const renderWorkItem = (item: DianxiaomiProductWorkItem) => {
    const diagnosis = item.failureDiagnosis
    const detail = diagnosis?.nextAction ?? item.notes.at(-1) ?? item.suggestedEdits[0]?.reason ?? "waiting for automation"
    const repairPlan = item.repairPlan
    const repairTargets = repairPlan?.actions
      .map((action) => action.target)
      .filter((target): target is string => Boolean(target))
      .slice(0, 3)
      .join(" / ")
    const repairWriters = repairPlan?.actions
      .map((action) => action.payload?.writer)
      .filter((writer): writer is NonNullable<typeof writer> => Boolean(writer))
      .slice(0, 2)
      .join(" + ")
    const canRetryAfterFix = item.status === "blocked"
      && Boolean(diagnosis)
      && (diagnosis?.retryable || diagnosis?.autoRetryRecommended)
      && ["media-processing", "publish-validation", "browser-profile", "task-file"].includes(diagnosis?.category ?? "")
      && item.requirements.summary.ready
    const isRetrying = retryingItemId === item.id

    return (
      <div key={item.id} className="daily-work-item">
        <strong>{item.title}</strong>
        <span>{item.status} / {new Date(item.updatedAt).toLocaleString()}</span>
        {diagnosis ? (
          <span className={`daily-failure-pill ${diagnosis.autoRetryRecommended ? "retry" : diagnosis.retryable ? "manual" : "blocked"}`}>
            {diagnosis.category} / {diagnosis.autoRetryRecommended ? "can auto retry" : diagnosis.retryable ? "fix then retry" : "manual check"}
          </span>
        ) : null}
        <small>{detail}</small>
        {repairPlan ? (
          <div className={`daily-repair-plan ${repairPlan.status}`}>
            <span>{repairPlan.status} / {repairPlan.canAutoRepair ? "auto repair" : repairPlan.canRetryAfterRepair ? "retry after fix" : "manual first"}</span>
            <small>{[repairPlan.summary, repairTargets ? `target ${repairTargets}` : "", repairWriters ? `writer ${repairWriters}` : ""].filter(Boolean).join(" -> ")}</small>
          </div>
        ) : null}
        {onRetryAfterFix && canRetryAfterFix ? (
          <button
            className="ghost-button small-button daily-retry-button"
            onClick={() => onRetryAfterFix(item.id)}
            disabled={isRetrying}
          >
            {isRetrying ? "重试准备中..." : "修复后重试"}
          </button>
        ) : null}
        {retryError && isRetrying ? <small className="daily-work-item-error">{retryError}</small> : null}
      </div>
    )
  }

  return (
    <div className="daily-work-item-list">
      {items.slice(0, 6).map(renderWorkItem)}
    </div>
  )
}
