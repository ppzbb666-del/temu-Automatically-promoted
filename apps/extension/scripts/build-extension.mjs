import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const extensionRoot = path.resolve(scriptDir, "..")
const distDir = path.join(extensionRoot, "dist")
const manifestPath = path.join(extensionRoot, "manifest.json")
const srcDir = path.join(extensionRoot, "src")
const assetsDir = path.join(extensionRoot, "assets")
const checkOnly = process.argv.includes("--check")

const requiredSourceFiles = [
  "manifest.json",
  "src/background.js",
  "src/content.js",
  "src/content.css",
  "src/panel.html",
  "src/panel.css",
  "src/panel.js"
]

const fail = (message) => {
  throw new Error(`[extension-build] ${message}`)
}

const assertFileExists = (relativePath, root = extensionRoot) => {
  const absolutePath = path.join(root, relativePath)
  if (!existsSync(absolutePath)) {
    fail(`Missing required file: ${relativePath}`)
  }
}

const collectManifestFiles = (manifest) => {
  const files = new Set()

  if (manifest.background?.service_worker) {
    files.add(manifest.background.service_worker)
  }

  for (const script of manifest.content_scripts ?? []) {
    for (const jsFile of script.js ?? []) {
      files.add(jsFile)
    }
    for (const cssFile of script.css ?? []) {
      files.add(cssFile)
    }
  }

  for (const resource of manifest.web_accessible_resources ?? []) {
    for (const resourceFile of resource.resources ?? []) {
      files.add(resourceFile)
    }
  }

  for (const key of ["default_popup", "default_icon"]) {
    const value = manifest.action?.[key]
    if (typeof value === "string") {
      files.add(value)
    }
    if (value && typeof value === "object") {
      Object.values(value).forEach((file) => files.add(file))
    }
  }

  return Array.from(files)
}

const validateManifestShape = (manifest) => {
  if (manifest.manifest_version !== 3) {
    fail("manifest_version must be 3")
  }

  if (!manifest.name || !manifest.version) {
    fail("manifest must include name and version")
  }

  if (!manifest.background?.service_worker) {
    fail("manifest must define background.service_worker")
  }

  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) {
    fail("manifest must define at least one content script")
  }

  for (const [index, script] of manifest.content_scripts.entries()) {
    if (!Array.isArray(script.matches) || script.matches.length === 0) {
      fail(`content_scripts[${index}] must define matches`)
    }
    if (!Array.isArray(script.js) || script.js.length === 0) {
      fail(`content_scripts[${index}] must define js files`)
    }
  }
}

const runSyntaxChecks = () => {
  const jsFiles = [
    "src/background.js",
    "src/content.js",
    "src/panel.js"
  ]

  for (const jsFile of jsFiles) {
    execFileSync(process.execPath, ["--check", path.join(extensionRoot, jsFile)], {
      stdio: "pipe"
    })
  }
}

const copyBuildFiles = async () => {
  await rm(distDir, {
    recursive: true,
    force: true
  })
  await mkdir(distDir, {
    recursive: true
  })
  await cp(manifestPath, path.join(distDir, "manifest.json"))
  await cp(srcDir, path.join(distDir, "src"), {
    recursive: true
  })

  if (existsSync(assetsDir)) {
    await cp(assetsDir, path.join(distDir, "assets"), {
      recursive: true
    })
  }
}

const writeBuildInfo = async (manifest) => {
  const buildInfo = {
    builtAt: new Date().toISOString(),
    name: manifest.name,
    version: manifest.version,
    loadPath: distDir.replaceAll("\\", "/"),
    validatedFiles: collectManifestFiles(manifest).sort()
  }

  await writeFile(
    path.join(distDir, "build-info.json"),
    `${JSON.stringify(buildInfo, null, 2)}\n`,
    "utf8"
  )
}

for (const file of requiredSourceFiles) {
  assertFileExists(file)
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
validateManifestShape(manifest)

for (const file of collectManifestFiles(manifest)) {
  assertFileExists(file)
}

runSyntaxChecks()

if (!checkOnly) {
  await copyBuildFiles()

  for (const file of collectManifestFiles(manifest)) {
    assertFileExists(file, distDir)
  }

  await writeBuildInfo(manifest)
}

console.log(checkOnly
  ? "Extension source validation passed"
  : `Extension build ready: ${path.relative(process.cwd(), distDir)}`)
