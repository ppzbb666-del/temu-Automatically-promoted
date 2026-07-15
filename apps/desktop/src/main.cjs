const { app, BrowserWindow, dialog } = require("electron")
const { spawn } = require("node:child_process")
const path = require("node:path")
const http = require("node:http")

const root = path.resolve(__dirname, "../../..")
let serverProcess
let dashboardProcess

function waitForServer(url, timeout = 30000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      const request = http.get(url, (response) => {
        response.resume()
        if (response.statusCode && response.statusCode < 500) return resolve()
        retry()
      })
      request.on("error", retry)
      request.setTimeout(1000, () => request.destroy())
    }
    const retry = () => {
      if (Date.now() - started > timeout) return reject(new Error("后台服务启动超时"))
      setTimeout(poll, 250)
    }
    poll()
  })
}

async function createWindow() {
  serverProcess = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev", "--workspace", "@temu-ai-ops/server"], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true
  })
  dashboardProcess = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev", "--workspace", "@temu-ai-ops/dashboard", "--", "--host", "127.0.0.1"], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true
  })
  try {
    await waitForServer("http://127.0.0.1:8787/health")
    await waitForServer("http://127.0.0.1:5173")
    const window = new BrowserWindow({ width: 1440, height: 960, webPreferences: { contextIsolation: true } })
    await window.loadURL("http://127.0.0.1:5173")
  } catch (error) {
    dialog.showErrorBox("Temu AI Ops 启动失败", error.message)
    app.quit()
  }
}

app.whenReady().then(createWindow)
app.on("before-quit", () => {
  serverProcess?.kill()
  dashboardProcess?.kill()
})
