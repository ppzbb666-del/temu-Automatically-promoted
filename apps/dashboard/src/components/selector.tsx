import { useState, type Dispatch, type SetStateAction } from "react"
import type { DianxiaomiSelectorConfig, SelectorConfigDiffResult, SelectorConfigVersion, SelectorWorkbench } from "@temu-ai-ops/shared"
import { TargetSurfaceSummary } from "./preflight"
import {
  buildSelectorConfigDiffPreview,
  createSelectorConfigDraft,
  defaultSkuRowSelector,
  isFieldOrButtonSelectorItem,
  selectorDiffChangeCount,
  selectorOptions,
  updateSelectorDraftItem,
  updateSelectorDraftMediaAction,
  updateSelectorDraftSkuRows
} from "../lib/selector-config"

export function SelectorConfigDiffPreview({
  title,
  diff,
  maxEntries
}: {
  title: string
  diff: SelectorConfigDiffResult
  maxEntries: number
}) {
  const changedEntries = diff.entries.filter((entry) => entry.status !== "unchanged")
  const visibleEntries = changedEntries.slice(0, maxEntries)
  const hiddenCount = Math.max(0, changedEntries.length - visibleEntries.length)

  return (
    <div className={`selector-diff-preview ${diff.blocked ? "blocked" : diff.requiresConfirmation ? "confirm" : ""}`}>
      <div className="selector-diff-summary">
        <strong>{title}</strong>
        <span>{changedEntries.length === 0 ? "no changes" : `${changedEntries.length} changes`}</span>
        <span>add {diff.summary.addedCount}</span>
        <span>change {diff.summary.changedCount}</span>
        <span>remove {diff.summary.removedCount}</span>
        {diff.summary.blockRiskCount > 0 ? <span>blocked {diff.summary.blockRiskCount}</span> : null}
        {diff.summary.confirmRiskCount > 0 ? <span>confirm {diff.summary.confirmRiskCount}</span> : null}
      </div>
      {diff.risks.length > 0 ? (
        <div className="selector-risk-list">
          {diff.risks.map((risk) => (
            <span key={risk.id} className={risk.level}>{risk.level}: {risk.message}</span>
          ))}
        </div>
      ) : null}
      {visibleEntries.length > 0 ? (
        <div className="selector-diff-list">
          {visibleEntries.map((entry) => (
            <div key={`${entry.group}-${entry.key}`} className={`selector-diff-entry ${entry.status}`}>
              <span>{entry.group}.{entry.key}</span>
              <small>{entry.status}</small>
              {entry.addedSelectors.length > 0 ? <code>+ {entry.addedSelectors.join(" | ")}</code> : null}
              {entry.removedSelectors.length > 0 ? <code>- {entry.removedSelectors.join(" | ")}</code> : null}
            </div>
          ))}
          {hiddenCount > 0 ? <span className="selector-diff-more">+{hiddenCount} more changes</span> : null}
        </div>
      ) : (
        <p>current selector config already matches this version</p>
      )}
    </div>
  )
}

type SelectorWorkbenchCardProps = {
  workbench: SelectorWorkbench
  draft: DianxiaomiSelectorConfig | null
  setDraft: Dispatch<SetStateAction<DianxiaomiSelectorConfig | null>>
  versions: SelectorConfigVersion[]
  onSave: (config: DianxiaomiSelectorConfig, confirmDangerousChanges: boolean) => void
  onRestore: (id: string, confirmDangerousChanges: boolean) => void
  isSaving: boolean
  isRestoring: boolean
}

export function SelectorWorkbenchCard({
  workbench,
  draft,
  setDraft,
  versions,
  onSave,
  onRestore,
  isSaving,
  isRestoring
}: SelectorWorkbenchCardProps) {
  const [confirmedDraftSignature, setConfirmedDraftSignature] = useState("")
  const [confirmedRestoreId, setConfirmedRestoreId] = useState("")
  const statusClass = workbench.validation.valid && workbench.summary.staleCount === 0 ? "completed" : "partial"
  const skuStatusClass = workbench.skuRows.status === "ready" ? "completed" : workbench.skuRows.status === "missing-candidate" ? "failed" : "partial"
  const effectiveDraft = draft ?? createSelectorConfigDraft(workbench)
  const draftSignature = JSON.stringify(effectiveDraft)
  const skuRowOptions = selectorOptions(workbench.skuRows.configuredSelectors, [], workbench.skuRows.diagnosisOk ? defaultSkuRowSelector : null)
  const draftDiff = buildSelectorConfigDiffPreview(
    workbench.config.config,
    effectiveDraft,
    workbench.config.configPath,
    workbench.config.exists
  )
  const draftChangeCount = selectorDiffChangeCount(draftDiff)
  const draftConfirmed = confirmedDraftSignature === draftSignature
  const saveButtonLabel = isSaving
    ? "saving..."
    : draftDiff.blocked
      ? "blocked"
      : draftChangeCount === 0
        ? "no changes"
        : draftDiff.requiresConfirmation && !draftConfirmed
          ? "review risks"
          : draftDiff.requiresConfirmation
            ? "confirm save"
            : "save selector config"

  const handleSave = () => {
    if (draftDiff.blocked || draftChangeCount === 0) {
      return
    }

    if (draftDiff.requiresConfirmation && !draftConfirmed) {
      setConfirmedDraftSignature(draftSignature)
      return
    }

    onSave(effectiveDraft, draftDiff.requiresConfirmation)
  }

  return (
    <div className="report-list">
      <div className={`automation-report ${statusClass}`}>
        <div className="report-main">
          <strong>selector workbench</strong>
          <span>{new Date(workbench.checkedAt).toLocaleString()}</span>
          <span>required {workbench.summary.requiredReadyCount}/{workbench.summary.requiredCount}</span>
          <span>missing {workbench.summary.missingRequiredCount} / stale {workbench.summary.staleCount}</span>
        </div>
        <div className="report-detail">
          {workbench.diagnosis ? (
            <>
              <span>{workbench.diagnosis.pageTitle || workbench.diagnosis.pageUrl}</span>
              <span>{workbench.diagnosis.diagnosisPath}</span>
              <span>fields {workbench.diagnosis.summary.fieldCount} / buttons {workbench.diagnosis.summary.buttonCount} / media tools {workbench.diagnosis.summary.mediaToolCount ?? 0} / sku rows {workbench.diagnosis.summary.skuRowCount}</span>
              <TargetSurfaceSummary step={workbench.diagnosis.targetSurface} />
            </>
          ) : (
            <span>no diagnosis found</span>
          )}
          <span>configured selectors {workbench.summary.configuredSelectorCount}</span>
          <span>candidates {workbench.summary.candidateCount}</span>
        </div>
        <SelectorConfigDiffPreview title="draft diff preview" diff={draftDiff} maxEntries={5} />
        <div className="selector-action-row">
          <button
            className="ghost-button small-button"
            onClick={() => setDraft(createSelectorConfigDraft(workbench))}
            disabled={isSaving || isRestoring}
          >
            reset draft
          </button>
          <button
            className="primary-button small-button"
            onClick={handleSave}
            disabled={isSaving || isRestoring || draftChangeCount === 0 || draftDiff.blocked}
          >
            {saveButtonLabel}
          </button>
        </div>
      </div>
      {workbench.items.filter(isFieldOrButtonSelectorItem).map((item) => {
        const itemClass = item.status === "ready" ? "completed" : item.status === "missing-config" || item.status === "missing-candidate" ? "failed" : "partial"
        const options = selectorOptions(item.configuredSelectors, item.candidates, item.recommendedSelector)
        const selectedSelector = effectiveDraft[item.group][item.key]?.[0] ?? ""
        return (
          <div key={`${item.group}-${item.key}`} className={`automation-report ${itemClass}`}>
            <div className="report-main">
              <strong>{item.group}.{item.key}</strong>
              <span>{item.required ? "required" : "optional"}</span>
              <span>{item.status}</span>
            </div>
            <div className="report-detail">
              <label className="selector-choice">
                <span>selected</span>
                <select
                  value={selectedSelector}
                  onChange={(event) => setDraft((current) => updateSelectorDraftItem(
                    current ?? effectiveDraft,
                    item.group,
                    item.key,
                    event.target.value
                  ))}
                >
                  <option value="">none</option>
                  {options.map((selector) => (
                    <option key={`${item.group}-${item.key}-${selector}`} value={selector}>{selector}</option>
                  ))}
                </select>
              </label>
              <span>recommended: {item.recommendedSelector ?? "none"}</span>
              <span>configured: {item.configuredSelectors.length > 0 ? item.configuredSelectors.join(" | ") : "none"}</span>
              {item.candidates.slice(0, 3).map((candidate) => (
                <span key={`${item.group}-${item.key}-${candidate.selectorHint}`}>score {candidate.score}: {candidate.selectorHint}</span>
              ))}
            </div>
          </div>
        )
      })}
      {(workbench.mediaTools ?? []).map((item) => {
        const group = "mediaTools" as const
        const itemClass = item.status === "ready" ? "completed" : item.status === "stale" ? "partial" : "partial"
        const options = selectorOptions(item.configuredSelectors, item.candidates, item.recommendedSelector)
        const selectedSelector = effectiveDraft.mediaTools?.[item.key]?.[0] ?? ""
        return (
          <div key={`${group}-${item.key}`} className={`automation-report ${itemClass}`}>
            <div className="report-main">
              <strong>{group}.{item.key}</strong>
              <span>{item.required ? "required" : "optional"}</span>
              <span>{item.status}</span>
            </div>
            <div className="report-detail">
              <label className="selector-choice">
                <span>selected</span>
                <select
                  value={selectedSelector}
                  onChange={(event) => setDraft((current) => updateSelectorDraftItem(
                    current ?? effectiveDraft,
                    group,
                    item.key,
                    event.target.value
                  ))}
                >
                  <option value="">none</option>
                  {options.map((selector) => (
                    <option key={`${group}-${item.key}-${selector}`} value={selector}>{selector}</option>
                  ))}
                </select>
              </label>
              <span>recommended: {item.recommendedSelector ?? "none"}</span>
              <span>configured: {item.configuredSelectors.length > 0 ? item.configuredSelectors.join(" | ") : "none"}</span>
              {item.candidates.slice(0, 3).map((candidate) => (
                <span key={`${group}-${item.key}-${candidate.selectorHint}`}>score {candidate.score}: {candidate.selectorHint}</span>
              ))}
            </div>
          </div>
        )
      })}
      {(workbench.mediaToolActions ?? []).map((item) => {
        const itemClass = item.status === "ready" ? "completed" : item.status === "stale" ? "partial" : "partial"
        const options = selectorOptions(item.configuredSelectors, item.candidates, item.recommendedSelector)
        const [action, toolKey] = item.key.split(".")
        const selectedSelector = effectiveDraft.mediaToolActions?.[action]?.[toolKey]?.[0] ?? ""
        return (
          <div key={`${item.group}-${item.key}`} className={`automation-report ${itemClass}`}>
            <div className="report-main">
              <strong>{item.group}.{item.key}</strong>
              <span>{item.required ? "required" : "optional"}</span>
              <span>{item.status}</span>
            </div>
            <div className="report-detail">
              <label className="selector-choice">
                <span>selected</span>
                <select
                  value={selectedSelector}
                  onChange={(event) => setDraft((current) => updateSelectorDraftMediaAction(
                    current ?? effectiveDraft,
                    action,
                    toolKey,
                    event.target.value
                  ))}
                >
                  <option value="">none</option>
                  {options.map((selector) => (
                    <option key={`${item.group}-${item.key}-${selector}`} value={selector}>{selector}</option>
                  ))}
                </select>
              </label>
              <span>recommended: {item.recommendedSelector ?? "none"}</span>
              <span>configured: {item.configuredSelectors.length > 0 ? item.configuredSelectors.join(" | ") : "none"}</span>
              {item.candidates.slice(0, 3).map((candidate) => (
                <span key={`${item.group}-${item.key}-${candidate.selectorHint}`}>score {candidate.score}: {candidate.selectorHint}</span>
              ))}
            </div>
          </div>
        )
      })}
      <div className={`automation-report ${skuStatusClass}`}>
        <div className="report-main">
          <strong>sku rows</strong>
          <span>{workbench.skuRows.status}</span>
          <span>diagnosis rows {workbench.skuRows.diagnosisCount}</span>
        </div>
        <div className="report-detail">
          <label className="selector-choice">
            <span>selected</span>
            <select
              value={effectiveDraft.skuRows[0] ?? ""}
              onChange={(event) => setDraft((current) => updateSelectorDraftSkuRows(current ?? effectiveDraft, event.target.value))}
            >
              <option value="">none</option>
              {skuRowOptions.map((selector) => (
                <option key={`sku-row-${selector}`} value={selector}>{selector}</option>
              ))}
            </select>
          </label>
          <span>configured: {workbench.skuRows.configuredSelectors.length > 0 ? workbench.skuRows.configuredSelectors.join(" | ") : "none"}</span>
          {workbench.skuRows.samples.slice(0, 3).map((sample, index) => (
            <span key={`${index}-${sample.rowText}`}>{sample.inputCount} inputs: {sample.rowText}</span>
          ))}
        </div>
      </div>
      <div className="draft-history selector-version-history">
        <strong>selector config versions</strong>
        {versions.length > 0 ? (
          <div className="draft-version-list">
            {versions.slice(0, 6).map((version) => {
              const versionDiff = buildSelectorConfigDiffPreview(
                workbench.config.config,
                version.config,
                workbench.config.configPath,
                workbench.config.exists
              )
              const versionChangeCount = selectorDiffChangeCount(versionDiff)
              const versionConfirmed = confirmedRestoreId === version.id
              const restoreButtonLabel = isRestoring
                ? "restoring..."
                : versionDiff.blocked
                  ? "blocked"
                  : versionChangeCount === 0
                    ? "current"
                    : versionDiff.requiresConfirmation && !versionConfirmed
                      ? "review risks"
                      : versionDiff.requiresConfirmation
                        ? "confirm restore"
                        : "restore"
              const handleRestore = () => {
                if (versionDiff.blocked || versionChangeCount === 0) {
                  return
                }

                if (versionDiff.requiresConfirmation && !versionConfirmed) {
                  setConfirmedRestoreId(version.id)
                  return
                }

                onRestore(version.id, versionDiff.requiresConfirmation)
              }
              return (
                <div key={version.id} className="draft-version-item selector-version-item">
                  <div>
                    <span>{new Date(version.createdAt).toLocaleString()}</span>
                    <small>{version.note || version.id}</small>
                    <small>{version.backupPath}</small>
                    <SelectorConfigDiffPreview title="restore diff preview" diff={versionDiff} maxEntries={3} />
                  </div>
                  <button
                    className="ghost-button small-button"
                    onClick={handleRestore}
                    disabled={isSaving || isRestoring || versionChangeCount === 0 || versionDiff.blocked}
                  >
                    {restoreButtonLabel}
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="empty-report">no selector config versions</div>
        )}
      </div>
    </div>
  )
}
