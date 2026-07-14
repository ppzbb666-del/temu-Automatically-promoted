export type AppView = "daily" | "advanced" | "pod"

type NavTone = "running" | "blocked" | "idle" | "warn"

type AppNavRailProps = {
  active: AppView
  onChange: (view: AppView) => void
  statusLabel: string
  statusTone: NavTone
}

const NAV_ITEMS: { key: AppView; icon: string; label: string; hint: string }[] = [
  { key: "daily", icon: "◎", label: "日常主流程", hint: "试跑与无人值守" },
  { key: "advanced", icon: "⚙", label: "高级区", hint: "修复 / 审核 / 诊断" },
  { key: "pod", icon: "◳", label: "POD 工具", hint: "图片裂变" }
]

export function AppNavRail({ active, onChange, statusLabel, statusTone }: AppNavRailProps) {
  return (
    <aside className="app-nav-rail">
      <div className="app-nav-brand">
        <img className="app-nav-brand-logo" src="/image.png" alt="LIVELY" />
      </div>
      <nav className="app-nav-list">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={"app-nav-item " + (active === item.key ? "active" : "")}
            onClick={() => onChange(item.key)}
          >
            <span className="app-nav-icon" aria-hidden="true">{item.icon}</span>
            <span className="app-nav-text">
              <strong>{item.label}</strong>
              <span>{item.hint}</span>
            </span>
          </button>
        ))}
      </nav>
      <div className={"app-nav-status " + statusTone}>
        <span className="app-nav-status-dot" aria-hidden="true" />
        <span>{statusLabel}</span>
      </div>
    </aside>
  )
}
