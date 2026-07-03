import { DailyMetric } from "./daily"

type DailyAlert = { id: string; tone: string; title: string; message: string }
type DailyStartupCheck = { status: string; message: string }
type DailyTrialStat = { label: string; value: string; tone: string }
type DailyTrialRecovery = { tone: string; title: string; message: string; actions: string[] }
type DailyTrialGate = {
  status: string
  message: string
  details: DailyTrialStat[]
  recovery: DailyTrialRecovery
  failures: string[]
}
type DailyLatestTick = { category: string; reason?: string | null; error?: string | null } | null
type DailyLatestJob = { status: string; error?: string | null; id: string } | null

export type DailyMainData = {
  modeTone: string
  modeLabel: string
  automaticPass: { rate: number | null; completed: number; finished: number }
  automaticPassTone: "good" | "warn" | "bad" | "neutral"
  manualTriggers: { productCount: number; average: number; triggerCount: number }
  manualTriggerTone: "good" | "warn" | "bad" | "neutral"
  readyWorkItemsCount: number
  backendOffline: boolean
  unattendedStartupCheck: { status: string } | null | undefined
  trialLabel: string
  alerts: DailyAlert[]
  actionTitle: string
  actionDetail: string
  daemonStatus: string | null | undefined
  trialGate: DailyTrialGate
  startupBlockingChecks: Array<{ id: string; status: string; label: string; message: string }>
  startupWarningChecks: Array<{ id: string; status: string; label: string; message: string }>
  startupCalibrationCheck: DailyStartupCheck | null
  latestTick: DailyLatestTick
  latestJob: DailyLatestJob
  showDetails: boolean
  daemonMessage: string
  queueRunMessage: string
  calibrationMessage: string
}

export type DailyMainActions = {
  canStart: boolean
  startupCanStart: boolean
  defaultQueueDaemonInput: unknown
  trialQueueRunInput: unknown
  selectorCalibrationInput: unknown
  isStarting: boolean
  isPausing: boolean
  isRunningTrial: boolean
  isCalibrating: boolean
  isTicking: boolean
  onStartDaemon: () => void
  onPauseDaemon: () => void
  onRunTrial: () => void
  onCalibrate: () => void
  onCalibrateHeaded: () => void
  onTickOnce: () => void
  onToggleDetails: () => void
  onEnterAdvanced: () => void
}

export function DailyMain({ data, actions }: { data: DailyMainData; actions: DailyMainActions }) {
  const startButtonLabel = actions.isStarting
    ? "正在启动..."
    : data.daemonStatus === "ACTIVE"
      ? "运行中"
      : data.trialGate.status === "passed"
        ? "开始无人值守"
        : "等待试跑通过"

  return (
    <main className="daily-workspace">
      <section className={`daily-console ${data.modeTone}`}>
        <div className="daily-console-head">
          <div>
            <p className="eyebrow">Default Entry</p>
            <h1>无人值守主流程</h1>
            <p>唯一默认入口：只处理店小秘已采集商品，自动修改、处理图片、保存并点发布；Temu 核价和最终上架保留人工确认。</p>
          </div>
          <strong className={`daily-mode-badge ${data.modeTone}`}>{data.modeLabel}</strong>
        </div>

        <div className="daily-section">
          <div className="daily-section-head">
            <strong>状态</strong>
            <span>主指标只统计无人值守主流程</span>
          </div>
          <div className="daily-status-strip main-kpis">
            <DailyMetric
              label="自动通过率"
              value={data.automaticPass.rate === null ? "--" : `${Math.round(data.automaticPass.rate * 100)}%`}
              detail={data.automaticPass.finished > 0 ? `${data.automaticPass.completed}/${data.automaticPass.finished} completed` : "等待自动任务完成"}
              tone={data.automaticPassTone}
            />
            <DailyMetric
              label="单品人工触发"
              value={data.manualTriggers.productCount > 0 ? data.manualTriggers.average.toFixed(2) : "0.00"}
              detail={`${data.manualTriggers.triggerCount}/${data.manualTriggers.productCount} triggers/products`}
              tone={data.manualTriggerTone}
            />
            <DailyMetric
              label="待处理队列"
              value={String(data.readyWorkItemsCount)}
              detail="ready 商品"
              tone={data.readyWorkItemsCount > 0 ? "good" : "neutral"}
            />
            <DailyMetric
              label="启动检查"
              value={data.backendOffline ? "离线" : data.unattendedStartupCheck?.status ?? "检查中"}
              detail={data.trialLabel}
              tone={data.backendOffline || data.unattendedStartupCheck?.status === "blocked" ? "bad" : data.unattendedStartupCheck?.status === "ready" ? "good" : "warn"}
            />
          </div>
        </div>

        <div className="daily-section">
          <div className="daily-section-head">
            <strong>告警</strong>
            <span>{data.alerts.length > 0 ? `${data.alerts.length} 条` : "无阻断"}</span>
          </div>
          {data.alerts.length > 0 ? (
            <div className="daily-alert-list">
              {data.alerts.slice(0, 4).map((alert) => (
                <div key={alert.id} className={`daily-alert ${alert.tone}`}>
                  <strong>{alert.title}</strong>
                  <span>{alert.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="daily-alert empty">
              <strong>可以按流程运行</strong>
              <span>当前没有需要员工判断的默认流程告警。</span>
            </div>
          )}
        </div>

        <div className="daily-section">
          <div className="daily-section-head">
            <strong>动作</strong>
            <span>{data.actionTitle}</span>
          </div>
          <div className={`daily-action-state ${data.modeTone}`}>
            <strong>{data.actionTitle}</strong>
            <p>{data.actionDetail}</p>
          </div>
          <div className="daily-console-actions">
            <button
              className="primary-button"
              onClick={() => actions.onStartDaemon()}
              disabled={actions.isStarting || !actions.canStart}
            >
              {startButtonLabel}
            </button>
            <button
              className="ghost-button"
              onClick={() => actions.onPauseDaemon()}
              disabled={actions.isPausing || data.daemonStatus !== "ACTIVE"}
            >
              {actions.isPausing ? "正在暂停..." : "暂停"}
            </button>
            <button
              className="ghost-button"
              onClick={() => actions.onRunTrial()}
              disabled={actions.isRunningTrial || !actions.startupCanStart}
            >
              {actions.isRunningTrial ? "试跑中..." : "小批量试跑"}
            </button>
            <button
              className="ghost-button"
              onClick={() => actions.onCalibrate()}
              disabled={actions.isCalibrating || data.backendOffline}
            >
              {actions.isCalibrating ? "校准中..." : "生产校准"}
            </button>
            <button className="ghost-button" onClick={() => actions.onToggleDetails()}>
              {data.showDetails ? "收起验收" : "验收明细"}
            </button>
            <button className="ghost-button" onClick={() => actions.onEnterAdvanced()}>
              高级区
            </button>
          </div>
          <div className="daily-mini-feed compact">
            <div>
              <strong>最近运行</strong>
              <span>{data.latestTick ? `${data.latestTick.category}: ${data.latestTick.reason ?? data.latestTick.error ?? "无异常"}` : "暂无自动轮询"}</span>
            </div>
            <div>
              <strong>最近任务</strong>
              <span>{data.latestJob ? `${data.latestJob.status}: ${data.latestJob.error ?? data.latestJob.id}` : "暂无自动任务"}</span>
            </div>
          </div>
          {data.daemonMessage ? <p className="daily-message">{data.daemonMessage}</p> : null}
          {data.queueRunMessage ? <p className="daily-message">{data.queueRunMessage}</p> : null}
          {data.calibrationMessage ? <p className="daily-message">{data.calibrationMessage}</p> : null}
        </div>
      </section>

      {data.showDetails ? (
        <section className="daily-grid daily-validation-grid">
          <article className="daily-panel">
            <div className="daily-panel-head">
              <strong>启动验收</strong>
              <span>{data.startupBlockingChecks.length} blocked / {data.startupWarningChecks.length} warning</span>
            </div>
            <div className="daily-check-list">
              {data.startupCalibrationCheck ? (
                <div className={`daily-check ${data.startupCalibrationCheck.status}`}>
                  <strong>真实店小秘页面校准</strong>
                  <span>{data.startupCalibrationCheck.message}</span>
                </div>
              ) : null}
              {data.startupBlockingChecks
                .filter((item) => item.id !== "real-dianxiaomi-calibration")
                .slice(0, 4)
                .map((item) => (
                  <div key={item.id} className={`daily-check ${item.status}`}>
                    <strong>{item.label}</strong>
                    <span>{item.message}</span>
                  </div>
                ))}
              {data.startupBlockingChecks.length === 0 && data.startupWarningChecks.length === 0 ? (
                <div className="daily-check pass">
                  <strong>启动条件正常</strong>
                  <span>可以启动无人值守队列。</span>
                </div>
              ) : null}
            </div>
            <div className="daily-mode-actions compact">
              <button
                className="ghost-button small-button"
                onClick={() => actions.onCalibrateHeaded()}
                disabled={actions.isCalibrating}
              >
                {actions.isCalibrating ? "校准中..." : "打开页面校准"}
              </button>
              <button
                className="ghost-button small-button"
                onClick={() => actions.onTickOnce()}
                disabled={actions.isTicking || data.daemonStatus !== "ACTIVE"}
              >
                {actions.isTicking ? "运行中..." : "立即检查一次"}
              </button>
            </div>
          </article>

          <article className="daily-panel">
            <div className="daily-panel-head">
              <strong>小批量试跑</strong>
              <span>{data.trialLabel}</span>
            </div>
            <p className={`daily-message daily-trial-gate ${data.trialGate.status}`}>{data.trialGate.message}</p>
            <div className="daily-trial-summary">
              {data.trialGate.details.map((item) => (
                <div key={item.label} className={`daily-trial-stat ${item.tone}`}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>
            <div className={`daily-trial-recovery ${data.trialGate.recovery.tone}`}>
              <div>
                <strong>{data.trialGate.recovery.title}</strong>
                <span>{data.trialGate.recovery.message}</span>
              </div>
              <div className="daily-trial-actions">
                {data.trialGate.recovery.actions.map((action) => <span key={action}>{action}</span>)}
              </div>
            </div>
            {data.trialGate.failures.length > 0 ? (
              <div className="daily-trial-failures">
                {data.trialGate.failures.map((failure) => <span key={failure}>{failure}</span>)}
              </div>
            ) : null}
          </article>
        </section>
      ) : null}
    </main>
  )
}
