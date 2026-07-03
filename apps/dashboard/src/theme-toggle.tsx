import { useEffect, useState } from "react"

type Theme = "light" | "dark"

const STORAGE_KEY = "temu-dashboard-theme"

const readInitialTheme = (): Theme => {
  const attr = document.documentElement.getAttribute("data-theme")
  if (attr === "light" || attr === "dark") {
    return attr
  }
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (stored === "light" || stored === "dark") {
    return stored
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

const applyTheme = (theme: Theme) => {
  document.documentElement.setAttribute("data-theme", theme)
  window.localStorage.setItem(STORAGE_KEY, theme)
}

/** Self-contained floating control; does not touch the App tree. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readInitialTheme)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const next = theme === "dark" ? "light" : "dark"
  const isDark = theme === "dark"

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setTheme(next)}
      aria-label={`切换到${next === "dark" ? "深色" : "浅色"}模式`}
      title={`切换到${next === "dark" ? "深色" : "浅色"}模式`}
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        {isDark ? (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        )}
      </span>
      {isDark ? "浅色" : "深色"}
    </button>
  )
}
