// Committed source for the extension panel test fixture.
//
// The Playwright check (check-panel-fixture.mjs) drives the real content script
// (../src/content.js) inside a plain page. content.js has no test hooks — it
// bootstraps synchronously on load and talks to the extension background solely
// through chrome.runtime.sendMessage. This fixture is that missing environment:
// it stubs `chrome`, reads ?repairPlan / ?publishOutcome from the URL, and
// returns a synthesized work item from the `upload-product-work-item` response,
// which is what the `加入队列` click consumes and renders.
//
// The generated HTML lives under .runtime/ui-fixtures/ (gitignored). This
// generator is committed so a fresh checkout can always reproduce it — the test
// writes it out before serving. Keep the synthesized shapes in sync with
// content.js: getRepairPlanLabel / getRepairActionGate / getPublishOutcomeAlert.

// Per-mode repairPlan + backend repairActionGate. status is always
// "needs-revision" so content.js reaches the repair branch and pushes the
// compact `改造计划：…` alert. The gate `message` must be verbatim — content.js
// renders the backend gate message as-is.
const WORK_ITEMS = {
  "auto-ready": {
    title: "Fixture 商品",
    status: "needs-revision",
    repairPlan: {
      status: "auto-ready",
      canAutoRepair: true,
      summary: "可自动处理，默认动作允许继续。",
      actions: [
        { automation: "auto", label: "媒体处理", detail: "自动执行图片翻译、尺寸整理和白底处理。" },
        { automation: "auto", label: "属性补齐", detail: "自动补齐颜色、材质等已知商品属性。" }
      ],
      blockers: []
    },
    repairActionGate: {
      defaultActionAllowed: true,
      status: "auto-ready",
      message: "后端门禁：可自动处理，默认动作允许继续。"
    }
  },
  assisted: {
    title: "Fixture 商品",
    status: "needs-revision",
    repairPlan: {
      status: "assisted",
      canAutoRepair: false,
      summary: "需辅助处理。",
      actions: [
        { automation: "auto", label: "媒体处理", detail: "自动执行图片翻译、尺寸整理和白底处理。" },
        { automation: "assisted", label: "属性确认", detail: "需要员工确认缺失属性值后再交给自动化填写。" }
      ],
      blockers: []
    },
    repairActionGate: {
      defaultActionAllowed: false,
      status: "assisted",
      message: "后端门禁：需辅助处理，默认动作暂停。展开高级信息查看改造计划。"
    }
  },
  manual: {
    title: "Fixture 商品",
    status: "needs-revision",
    repairPlan: {
      status: "manual",
      canAutoRepair: false,
      summary: "需人工处理。",
      actions: [
        { automation: "manual", label: "人工处理", detail: "需要人工处理登录、验证码或平台风控后才能继续。" }
      ],
      blockers: []
    },
    repairActionGate: {
      defaultActionAllowed: false,
      status: "manual",
      message: "后端门禁：需人工处理，默认动作暂停。展开高级信息查看改造计划。"
    }
  },
  blocked: {
    title: "Fixture 商品",
    status: "needs-revision",
    repairPlan: {
      status: "blocked",
      canAutoRepair: false,
      summary: "已阻塞。",
      actions: [
        { automation: "manual", label: "人工处理", detail: "需要人工处理登录、验证码或平台风控后才能继续。" }
      ],
      blockers: ["登录、验证码或错误页面阻塞自动化"]
    },
    repairActionGate: {
      defaultActionAllowed: false,
      status: "blocked",
      message: "后端门禁：已阻塞，默认动作暂停。展开高级信息查看改造计划。"
    }
  }
}

// publishOutcome=failed rides on the auto-ready work item and yields the compact
// `发布失败（2/3 次）：…。下一步：进入故障恢复。` alert (getPublishOutcomeAlert).
const FAILED_PUBLISH_OUTCOME = {
  status: "failed",
  attempts: 2,
  maxAttempts: 3,
  failureReason: "missing required attribute Color",
  route: "browser-recovery"
}

// `contentScriptUrl` / `contentCssUrl` are server-absolute paths (served from
// repoRoot by the fixture server), e.g. /apps/extension/src/content.js.
export const renderPanelFixtureHtml = ({ contentScriptUrl, contentCssUrl }) => `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Temu AI Panel Fixture</title>
    <link rel="stylesheet" href="${contentCssUrl}" />
    <script>
      // Mock harness: must be defined BEFORE content.js loads, because content.js
      // registers chrome.runtime.onMessage and calls renderPanel()/refreshTask()
      // synchronously at the bottom of the file.
      (function () {
        var params = new URLSearchParams(window.location.search)
        var repairMode = params.get("repairPlan") || "auto-ready"
        var publishOutcome = params.get("publishOutcome")

        var WORK_ITEMS = ${JSON.stringify(WORK_ITEMS)}
        var FAILED_PUBLISH_OUTCOME = ${JSON.stringify(FAILED_PUBLISH_OUTCOME)}

        function buildWorkItem() {
          var base = WORK_ITEMS[repairMode] || WORK_ITEMS["auto-ready"]
          // deep clone so each response is independent
          var item = JSON.parse(JSON.stringify(base))
          // content.js's refreshUnattendedStatus (which re-runs after the 加入队列
          // click) clears the stored admission work item unless its pageUrl
          // matches the current location. Stamp it so the injected item survives.
          item.pageUrl = window.location.href
          if (publishOutcome === "failed") {
            item.publishOutcome = JSON.parse(JSON.stringify(FAILED_PUBLISH_OUTCOME))
          }
          return item
        }

        function respondFor(message) {
          var type = message && message.type
          switch (type) {
            case "temu-ai/get-active-task":
              return { ok: true, task: null }
            case "temu-ai/get-unattended-status":
              // currentWorkItem null keeps the 加入队列 button labeled correctly
              // and the initial 改造 row at "未生成".
              return { ok: true, status: { currentWorkItem: null, health: null, checkedAt: null } }
            case "temu-ai/upload-page-context":
              return { ok: true }
            case "temu-ai/upload-collected-product":
              return { ok: true, product: { id: "col-fixture-1" } }
            case "temu-ai/upload-product-work-item":
              // THE injection channel: this work item drives every post-click
              // assertion (改造 row, tone, gate, alerts).
              return { ok: true, workItem: buildWorkItem() }
            case "temu-ai/switch-dianxiaomi-store":
              return { ok: true }
            default:
              return { ok: true }
          }
        }

        var listeners = []
        window.chrome = {
          runtime: {
            // read as undefined in every sendMessage callback
            lastError: undefined,
            sendMessage: function (message, callback) {
              var response = respondFor(message)
              if (typeof callback === "function") {
                // async to match real chrome behavior
                setTimeout(function () {
                  callback(response)
                }, 0)
              }
              return undefined
            },
            onMessage: {
              addListener: function (fn) {
                listeners.push(fn)
              },
              removeListener: function () {}
            }
          }
        }
      })()
    </script>
  </head>
  <body>
    <script src="${contentScriptUrl}"></script>
  </body>
</html>
`
