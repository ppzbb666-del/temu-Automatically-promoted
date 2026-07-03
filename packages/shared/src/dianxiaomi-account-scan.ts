import type { AutomationSourceBucket } from "./types"

export type DianxiaomiAccountScanLink = {
  id: string
  shopId: string | null
  storeName: string
  sourceBucket: AutomationSourceBucket
  title: string
  editUrl: string
  sourceUrl: string | null
  siteLabel: string | null
  sourcePlatform: string | null
  categoryId?: string | null
  fullCid?: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type DianxiaomiAccountScanStore = {
  shopId: string | null
  storeName: string
  bucketCounts: Partial<Record<AutomationSourceBucket, number>>
  links: DianxiaomiAccountScanLink[]
}

export type DianxiaomiAccountScanResult = {
  scannedAt: string
  profile: string
  sourceBuckets: AutomationSourceBucket[]
  stores: DianxiaomiAccountScanStore[]
  totals: {
    storeCount: number
    linkCount: number
    bucketCounts: Partial<Record<AutomationSourceBucket, number>>
  }
  warnings: string[]
}

export type DianxiaomiAccountScanStartInput = Partial<{
  headed: boolean
  profile: string
  screenshots: string
  sourceBuckets: AutomationSourceBucket[]
  maxPages: number
  storeId: string
  storeName: string
}>

export type DianxiaomiAccountScanStartResult = {
  id: string
  startedAt: string
  command: string
  cwd: string
  logPath: string
  errorLogPath: string
  artifactDir: string
  resultPath: string
}

export type DianxiaomiAccountScanJobStatus = "running" | "completed" | "failed"

export type DianxiaomiAccountScanJob = DianxiaomiAccountScanStartResult & {
  status: DianxiaomiAccountScanJobStatus
  finishedAt: string | null
  exitCode: number | null
  error: string | null
  result: DianxiaomiAccountScanResult | null
}

export type DianxiaomiAccountScanJobLog = {
  id: string
  logPath: string
  errorLogPath: string
  stdout: string
  stderr: string
  truncated: {
    stdout: boolean
    stderr: boolean
  }
}

export type DianxiaomiAccountScanImportInput = {
  linkIds?: string[]
  editUrls?: string[]
  storeId?: string
  storeName?: string
  sourceBuckets?: AutomationSourceBucket[]
}

export type DianxiaomiAccountScanImportResult = {
  jobId: string
  importedAt: string
  requested: number
  importedCount: number
  readyCount: number
  needsRevisionCount: number
  importedWorkItemIds: string[]
  skipped: Array<{
    id: string
    reason: string
  }>
}
