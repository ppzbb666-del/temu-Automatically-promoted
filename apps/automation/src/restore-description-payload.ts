import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { crc32 } from "node:zlib"
import { chromium } from "playwright"
import { ensureDirectory, getArgValue, waitForManualLoginIfNeeded } from "./common"

const DEFAULT_PRODUCT_ID = "161406453261437092"
const DEFAULT_PROFILE_DIR = ".runtime/dianxiaomi-real-profile"
const DEFAULT_BASE_PAYLOAD_PATH = "output/playwright/capture-save-zip-2026-06-22-a/unzipped/choiceSave.txt"
const DEFAULT_DESCRIPTION_SOURCE_PATH = "output/playwright/probe-edit-json-postsave-2026-06-22-a/edit.json.raw.txt"
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

type DescriptionSummary = {
  moduleCount: number
  firstUrl: string | null
  lastUrl: string | null
}

type RestoreSummary = {
  createdAt: string
  productId: string
  pageUrl: string
  profileDir: string
  basePayloadPath: string
  descriptionSourcePath: string
  artifactDir: string
  targetDescription: DescriptionSummary
  response: {
    code: number | null
    msg: string | null
    success: boolean
  }
  verification: DescriptionSummary
  artifactPaths: {
    choiceSavePath: string
    zipPath: string
    summaryPath: string
  }
}

const parseJsonFile = <T>(filePath: string): T =>
  JSON.parse(readFileSync(filePath, "utf8")) as T

const resolveRepoPath = (value: string) =>
  path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value)

const normalizeUrl = (value: unknown) => {
  const text = typeof value === "string" ? value.trim() : ""
  return text.length > 0 ? text : null
}

const parseDescriptionModules = (rawDescription: string) => {
  const parsed = JSON.parse(rawDescription) as Array<{
    contentList?: Array<{
      imgUrl?: string
    }>
  }>

  if (!Array.isArray(parsed)) {
    throw new Error("Description payload is not a JSON array.")
  }

  return parsed
}

const summarizeDescription = (rawDescription: string): DescriptionSummary => {
  const modules = parseDescriptionModules(rawDescription)
  const urls = modules
    .flatMap((module) => module.contentList ?? [])
    .map((item) => normalizeUrl(item.imgUrl))
    .filter((value): value is string => Boolean(value))

  return {
    moduleCount: modules.length,
    firstUrl: urls[0] ?? null,
    lastUrl: urls[urls.length - 1] ?? null
  }
}

const extractDescriptionFromUnknown = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }

    if (trimmed.startsWith("[")) {
      parseDescriptionModules(trimmed)
      return trimmed
    }

    return null
  }

  if (!value || typeof value !== "object") {
    return null
  }

  const record = value as Record<string, unknown>
  return extractDescriptionFromUnknown(record.description)
    ?? extractDescriptionFromUnknown(record.product)
    ?? extractDescriptionFromUnknown(record.data)
}

const loadDescriptionString = (filePath: string) => {
  const raw = readFileSync(filePath, "utf8").trim()
  if (!raw) {
    throw new Error(`Description source file is empty: ${filePath}`)
  }

  if (raw.startsWith("[")) {
    parseDescriptionModules(raw)
    return raw
  }

  const parsed = JSON.parse(raw) as unknown
  const description = extractDescriptionFromUnknown(parsed)
  if (!description) {
    throw new Error(`Could not extract a description field from: ${filePath}`)
  }

  return description
}

const getProductId = (pageUrl: string, explicitProductId: string | undefined) => {
  const trimmedProductId = explicitProductId?.trim()
  if (trimmedProductId) {
    return trimmedProductId
  }

  const parsed = new URL(pageUrl)
  return parsed.searchParams.get("id")?.trim() || DEFAULT_PRODUCT_ID
}

const buildStoredZip = (entryName: string, entryContent: Buffer) => {
  const nameBuffer = Buffer.from(entryName, "utf8")
  const crc = crc32(entryContent) >>> 0

  const localHeader = Buffer.alloc(30)
  let offset = 0
  localHeader.writeUInt32LE(0x04034b50, offset); offset += 4
  localHeader.writeUInt16LE(20, offset); offset += 2
  localHeader.writeUInt16LE(0, offset); offset += 2
  localHeader.writeUInt16LE(0, offset); offset += 2
  localHeader.writeUInt16LE(0, offset); offset += 2
  localHeader.writeUInt16LE(0, offset); offset += 2
  localHeader.writeUInt32LE(crc, offset); offset += 4
  localHeader.writeUInt32LE(entryContent.length, offset); offset += 4
  localHeader.writeUInt32LE(entryContent.length, offset); offset += 4
  localHeader.writeUInt16LE(nameBuffer.length, offset); offset += 2
  localHeader.writeUInt16LE(0, offset)

  const centralHeader = Buffer.alloc(46)
  offset = 0
  centralHeader.writeUInt32LE(0x02014b50, offset); offset += 4
  centralHeader.writeUInt16LE(20, offset); offset += 2
  centralHeader.writeUInt16LE(20, offset); offset += 2
  centralHeader.writeUInt16LE(0, offset); offset += 2
  centralHeader.writeUInt16LE(0, offset); offset += 2
  centralHeader.writeUInt16LE(0, offset); offset += 2
  centralHeader.writeUInt16LE(0, offset); offset += 2
  centralHeader.writeUInt32LE(crc, offset); offset += 4
  centralHeader.writeUInt32LE(entryContent.length, offset); offset += 4
  centralHeader.writeUInt32LE(entryContent.length, offset); offset += 4
  centralHeader.writeUInt16LE(nameBuffer.length, offset); offset += 2
  centralHeader.writeUInt16LE(0, offset); offset += 2
  centralHeader.writeUInt16LE(0, offset); offset += 2
  centralHeader.writeUInt16LE(0, offset); offset += 2
  centralHeader.writeUInt16LE(0, offset); offset += 2
  centralHeader.writeUInt32LE(0, offset); offset += 4
  centralHeader.writeUInt32LE(0, offset)

  const centralDirectory = Buffer.concat([centralHeader, nameBuffer])
  const localFileRecord = Buffer.concat([localHeader, nameBuffer, entryContent])

  const endOfCentralDirectory = Buffer.alloc(22)
  offset = 0
  endOfCentralDirectory.writeUInt32LE(0x06054b50, offset); offset += 4
  endOfCentralDirectory.writeUInt16LE(0, offset); offset += 2
  endOfCentralDirectory.writeUInt16LE(0, offset); offset += 2
  endOfCentralDirectory.writeUInt16LE(1, offset); offset += 2
  endOfCentralDirectory.writeUInt16LE(1, offset); offset += 2
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, offset); offset += 4
  endOfCentralDirectory.writeUInt32LE(localFileRecord.length, offset); offset += 4
  endOfCentralDirectory.writeUInt16LE(0, offset)

  return Buffer.concat([localFileRecord, centralDirectory, endOfCentralDirectory])
}

const fetchVerifiedDescription = async (requestContext: Awaited<ReturnType<typeof chromium.launchPersistentContext>>["request"], productId: string) => {
  const response = await requestContext.get(`https://www.dianxiaomi.com/api/popTemuProduct/edit.json?id=${productId}`)
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`Verification request failed: ${response.status()} ${response.statusText()} ${text.slice(0, 400)}`)
  }

  const payload = JSON.parse(text) as {
    code?: number
    data?: {
      product?: {
        description?: string
      }
      description?: string
    }
  }

  const rawDescription = extractDescriptionFromUnknown(payload.data) ?? extractDescriptionFromUnknown(payload)
  if (!rawDescription) {
    throw new Error("Verification response did not contain a description field.")
  }

  return summarizeDescription(rawDescription)
}

const main = async () => {
  const pageUrl = getArgValue("url") ?? `https://www.dianxiaomi.com/web/popTemu/edit?id=${DEFAULT_PRODUCT_ID}`
  const productId = getProductId(pageUrl, getArgValue("product-id"))
  const profileDir = resolveRepoPath(getArgValue("profile") ?? DEFAULT_PROFILE_DIR)
  const basePayloadPath = resolveRepoPath(getArgValue("base-payload") ?? DEFAULT_BASE_PAYLOAD_PATH)
  const descriptionSourcePath = resolveRepoPath(getArgValue("description-source") ?? DEFAULT_DESCRIPTION_SOURCE_PATH)
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const artifactDir = resolveRepoPath(getArgValue("artifacts") ?? `output/playwright/restore-description-script-${timestamp}`)

  ensureDirectory(profileDir)
  ensureDirectory(artifactDir)

  const basePayload = parseJsonFile<Record<string, unknown>>(basePayloadPath)
  const targetDescription = loadDescriptionString(descriptionSourcePath)
  const targetSummary = summarizeDescription(targetDescription)

  const updatedPayload = {
    ...basePayload,
    description: targetDescription,
    id: productId,
    op: 1
  }

  const choiceSavePath = path.join(artifactDir, "choiceSave.txt")
  const zipPath = path.join(artifactDir, "restore-description.zip")
  const summaryPath = path.join(artifactDir, "restore-summary.json")
  const payloadBuffer = Buffer.from(JSON.stringify(updatedPayload), "utf8")
  const zipBuffer = buildStoredZip("choiceSave.txt", payloadBuffer)

  writeFileSync(choiceSavePath, payloadBuffer)
  writeFileSync(zipPath, zipBuffer)

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: {
      width: 1440,
      height: 960
    }
  })

  try {
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded"
    }).catch(() => undefined)
    await waitForManualLoginIfNeeded(page)

    const response = await context.request.post("https://www.dianxiaomi.com/api/popTemuProduct/add3f8c2a97.json", {
      multipart: {
        file: {
          name: "blob",
          mimeType: "application/zip",
          buffer: zipBuffer
        },
        op: "1"
      }
    })
    const responseText = await response.text()
    const responsePayload = JSON.parse(responseText) as {
      code?: number
      msg?: string
    }

    if (!response.ok || responsePayload.code !== 0) {
      throw new Error(`Restore request failed: ${response.status()} ${response.statusText()} ${responseText.slice(0, 500)}`)
    }

    const verification = await fetchVerifiedDescription(context.request, productId)
    const summary: RestoreSummary = {
      createdAt: new Date().toISOString(),
      productId,
      pageUrl,
      profileDir,
      basePayloadPath,
      descriptionSourcePath,
      artifactDir,
      targetDescription: targetSummary,
      response: {
        code: responsePayload.code ?? null,
        msg: responsePayload.msg ?? null,
        success: true
      },
      verification,
      artifactPaths: {
        choiceSavePath,
        zipPath,
        summaryPath
      }
    }

    writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8")
    console.log(`Description restore submitted for product ${productId}.`)
    console.log(`Verified description modules: ${verification.moduleCount}.`)
    console.log(`Artifacts: ${summaryPath}`)
  } finally {
    await context.close().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
