# Browser Extension Build

The browser extension is a Chrome Manifest V3 extension used by the local automation system on Dianxiaomi, Temu seller pages, and the local dashboard.

## Build

Run this from the project root:

```bash
npm run build --workspace @temu-ai-ops/extension
```

The build writes the loadable extension to:

```text
apps/extension/dist
```

## What The Build Checks

- `manifest.json` is valid JSON and uses Manifest V3.
- The manifest defines a background service worker and at least one content script.
- Every JS/CSS/HTML file referenced by the manifest exists.
- `src/background.js`, `src/content.js`, and `src/panel.js` pass Node syntax checks.
- `manifest.json`, `src`, and optional `assets` are copied into `apps/extension/dist`.
- `apps/extension/dist/build-info.json` records build time, extension version, load path, and validated files.

## Validate Without Building

Run this from the project root:

```bash
npm test --workspace @temu-ai-ops/extension
```

This runs the same manifest and syntax validation without writing `apps/extension/dist`. It is also included when running `npm test --workspaces --if-present`.

## Load In Chrome Or Edge

1. Build the extension.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable developer mode.
4. Choose load unpacked extension.
5. Select:

```text
apps/extension/dist
```

## Runtime Requirements

- Local server must be running on `http://localhost:8787`.
- Dashboard is normally available at `http://localhost:5173`.
- Dianxiaomi and Temu login/CAPTCHA/platform risk checks are not bypassed by this extension.
- Temu pricing confirmation and final listing approval remain manual.
