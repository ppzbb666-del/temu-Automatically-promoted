import type { AutomationTaskSnapshotDiffResult } from "@temu-ai-ops/shared"

export function TaskSnapshotDiffPreview({
  diff,
  maxEntries,
  isRepairing,
  onRepair
}: {
  diff: AutomationTaskSnapshotDiffResult
  maxEntries: number
  isRepairing: boolean
  onRepair: () => void
}) {
  const changedEntries = diff.entries.filter((entry) => entry.status !== "unchanged")
  const visibleEntries = changedEntries.slice(0, maxEntries)
  const hiddenCount = Math.max(0, changedEntries.length - visibleEntries.length)

  return (
    <div className={`task-snapshot-diff ${diff.summary.stale ? "stale" : "fresh"}`}>
      <div className="selector-diff-summary">
        <strong>task snapshot diff</strong>
        <span>{diff.summary.stale ? `${changedEntries.length} changes` : "snapshot current"}</span>
        <span>add {diff.summary.addedCount}</span>
        <span>change {diff.summary.changedCount}</span>
        <span>remove {diff.summary.removedCount}</span>
        {diff.summary.stale ? (
          <button
            className="ghost-button small-button"
            onClick={onRepair}
            disabled={isRepairing}
          >
            {isRepairing ? "refreshing..." : "refresh task file"}
          </button>
        ) : null}
      </div>
      <div className="task-snapshot-meta">
        <span>export {diff.export.exportId}</span>
        <span>{diff.export.taskFile}</span>
        <span>snapshot {diff.snapshotTask.status} / {new Date(diff.snapshotTask.updatedAt).toLocaleString()}</span>
        <span>current {diff.currentTask.status} / {new Date(diff.currentTask.updatedAt).toLocaleString()}</span>
      </div>
      {visibleEntries.length > 0 ? (
        <div className="selector-diff-list">
          {visibleEntries.map((entry) => (
            <div key={entry.id} className={`task-snapshot-entry ${entry.status}`}>
              <span>{entry.label}</span>
              <small>{entry.path} / {entry.status}</small>
              <code>snapshot: {entry.snapshotDisplay}</code>
              <code>current: {entry.currentDisplay}</code>
            </div>
          ))}
          {hiddenCount > 0 ? <span className="selector-diff-more">+{hiddenCount} more changes</span> : null}
        </div>
      ) : (
        <p>current task matches the exported automation file</p>
      )}
    </div>
  )
}
