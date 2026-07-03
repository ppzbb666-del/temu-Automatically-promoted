import type { AutomationSourceBucket, DianxiaomiAccountScanJob, DianxiaomiAccountScanLink } from "@temu-ai-ops/shared"

type AccountScanPoolProps = {
  job: DianxiaomiAccountScanJob
  selectedLinkIds: string[]
  selectedStoreFilter: string
  selectedBucketFilter: "all" | AutomationSourceBucket
  existingEditUrlSet: Set<string>
  onToggleLink: (linkId: string) => void
  onToggleVisible: (links: DianxiaomiAccountScanLink[]) => void
  onStoreFilterChange: (value: string) => void
  onBucketFilterChange: (value: "all" | AutomationSourceBucket) => void
}

const bucketLabelMap: Record<AutomationSourceBucket, string> = {
  "collection-box": "采集箱",
  "pending-publish": "待发布",
  "listing-draft": "草稿"
}

const statusLabel = (exists: boolean) => exists ? "已在队列" : "待导入"

export function DianxiaomiAccountScanPool({
  job,
  selectedLinkIds,
  selectedStoreFilter,
  selectedBucketFilter,
  existingEditUrlSet,
  onToggleLink,
  onToggleVisible,
  onStoreFilterChange,
  onBucketFilterChange
}: AccountScanPoolProps) {
  if (!job.result) {
    return null
  }

  const allLinks = job.result.stores.flatMap((store) => store.links)
  const storeOptions = Array.from(new Map(
    job.result.stores.map((store) => [
      `${store.shopId ?? "none"}::${store.storeName}`,
      {
        value: `${store.shopId ?? "none"}::${store.storeName}`,
        label: store.shopId ? `${store.storeName} (${store.shopId})` : store.storeName
      }
    ])
  ).values())
  const visibleLinks = allLinks.filter((link) => {
    if (selectedStoreFilter !== "all" && `${link.shopId ?? "none"}::${link.storeName}` !== selectedStoreFilter) {
      return false
    }
    if (selectedBucketFilter !== "all" && link.sourceBucket !== selectedBucketFilter) {
      return false
    }
    return true
  })
  const selectedVisibleCount = visibleLinks.filter((link) => selectedLinkIds.includes(link.id)).length
  const importedVisibleCount = visibleLinks.filter((link) => existingEditUrlSet.has(link.editUrl.trim().toLowerCase())).length

  return (
    <div className="account-scan-pool">
      <div className="account-scan-pool-head">
        <div className="account-scan-pool-summary">
          <strong>商品池</strong>
          <span>可见 {visibleLinks.length} / 总计 {allLinks.length}，已选 {selectedVisibleCount}，已入队 {importedVisibleCount}</span>
        </div>
        <div className="account-scan-pool-filters">
          <label>
            <span>店铺</span>
            <select value={selectedStoreFilter} onChange={(event) => onStoreFilterChange(event.target.value)}>
              <option value="all">全部店铺</option>
              {storeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>分类</span>
            <select value={selectedBucketFilter} onChange={(event) => onBucketFilterChange(event.target.value as "all" | AutomationSourceBucket)}>
              <option value="all">全部分类</option>
              <option value="collection-box">采集箱</option>
              <option value="pending-publish">待发布</option>
              <option value="listing-draft">草稿</option>
            </select>
          </label>
        </div>
      </div>
      <div className="account-scan-pool-actions">
        <button
          className="ghost-button small-button"
          type="button"
          onClick={() => onToggleVisible(visibleLinks)}
          disabled={visibleLinks.length === 0}
        >
          {selectedVisibleCount === visibleLinks.length && visibleLinks.length > 0 ? "取消当前筛选" : "全选当前筛选"}
        </button>
      </div>
      {visibleLinks.length > 0 ? (
        <div className="account-scan-link-list">
          {visibleLinks.slice(0, 300).map((link) => {
            const inQueue = existingEditUrlSet.has(link.editUrl.trim().toLowerCase())
            const checked = selectedLinkIds.includes(link.id)
            return (
              <label key={link.id} className={`account-scan-link-item ${inQueue ? "imported" : ""}`}>
                <input type="checkbox" checked={checked} onChange={() => onToggleLink(link.id)} />
                <div className="account-scan-link-main">
                  <strong>{link.title || "未命名商品"}</strong>
                  <span>{link.storeName}{link.shopId ? ` (${link.shopId})` : ""}</span>
                  <span>{bucketLabelMap[link.sourceBucket]} / {statusLabel(inQueue)}</span>
                  <span>{link.editUrl}</span>
                </div>
              </label>
            )
          })}
        </div>
      ) : (
        <div className="empty-report">当前筛选下没有可用链接</div>
      )}
    </div>
  )
}
