// 启动前加载 .env（如果存在）。用 Node 24 内置的 process.loadEnvFile，零依赖。
// 必须在任何读取 env 的模块（如 planner.ts 在 import 期读 LLM_* / 路径变量）之前执行，
// 因此本文件被 index.ts 以 side-effect 形式最先 import。
// 已在进程环境里显式设置的变量优先，不被 .env 覆盖（loadEnvFile 只填充缺失的键）。
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
// 候选：仓库根、server 子包目录、当前工作目录 —— 取第一个存在的。
const candidates = [
  path.resolve(here, "../../../.env"),
  path.resolve(here, "../.env"),
  path.resolve(process.cwd(), ".env")
]

for (const candidate of candidates) {
  if (existsSync(candidate)) {
    try {
      process.loadEnvFile(candidate)
    } catch {
      // 解析失败不应阻断启动；缺配置时下游会各自回退（如 LLM 回退规则草稿）。
    }
    break
  }
}
