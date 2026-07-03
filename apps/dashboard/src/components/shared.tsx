import type { ReactNode } from "react"

export function ImportResult({ result, prefix }: { result: { importedProducts: number; importedTasks: number; warnings: string[] }; prefix: string }) {
  return (
    <div className="import-result">
      <p>{prefix} 已导入 {result.importedProducts} 个商品，生成 {result.importedTasks} 个任务</p>
      {result.warnings.length > 0 ? <div className="import-warnings">{result.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div> : null}
    </div>
  )
}

export function SummaryCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="summary-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  )
}

export function InfoBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="info-block">
      <label>{label}</label>
      {typeof children === "string" ? <p>{children}</p> : children}
    </div>
  )
}
