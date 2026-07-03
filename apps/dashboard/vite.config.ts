import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"

const sharedSrcPath = fileURLToPath(new URL("../../packages/shared/src", import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@temu-ai-ops/shared": sharedSrcPath
    }
  },
  server: {
    port: 5173
  }
})
