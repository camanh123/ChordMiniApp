# Cross-platform runtime foundation

Phase 1 records how ChordMini chooses a shell and how every shell reaches the existing analysis API. Phase 2A adds the Electron window that hosts the existing Next.js server. This document does not add Capacitor, an installer, or a service worker.

## Runtime contract

`AppRuntime` is `web`, `electron`, or `pwa`.

| Input | Server render and first client paint | After hydration |
| --- | --- | --- |
| Unset, `web`, or any other value | `web` | `electron` when the user agent contains `Electron`; otherwise `pwa` when the display mode is `standalone`, `minimal-ui`, or `fullscreen`, or when iOS `navigator.standalone` is true; otherwise `web` |
| `electron` | `electron` | `electron` |
| `pwa` | `pwa` | `pwa` |

`getHydrationSafeRuntime()` never reads `window`, `document`, or `matchMedia`. `useAppRuntime()` starts from that value and calls `resolveRuntimeAfterHydration(window)` only inside an effect. Display-mode detection therefore cannot disagree with the server HTML.

Set `NEXT_PUBLIC_APP_RUNTIME` only when a shell must be pinned. Leave it as `web` or unset for the hosted site so an installed iPad PWA can refine to `pwa` after load.

## Backend connectivity

Browser and Electron renderer code keep calling the existing same-origin routes (`/api/detect-beats`, `/api/recognize-chords`, and the other handlers in `src/config/api.ts`). Those handlers are the only code that reads `PYTHON_API_URL`.

`/api/config` continues to publish `NEXT_PUBLIC_*` values. It withholds `PYTHON_API_URL`, `SONGFORMER_API_URL`, `SHEETSAGE_API_URL`, service-account JSON, secrets, and private keys even if a name is prefixed with `NEXT_PUBLIC_`. Firebase web config and the public YouTube key stay available because the current client already uses them.

`classifyPythonBackend()` is server-only. A missing URL or a loopback host (`localhost`, `127.0.0.1`, `::1`) is `loopback-fallback`. That class is the local development default. It is not a deployed Flask service. Only an explicit `http` or `https` URL with a non-loopback host is `remote`.

| Platform | Who serves the UI | Who runs Flask |
| --- | --- | --- |
| Web | Hosted Next.js | The private `PYTHON_API_URL` configured on that server |
| Electron, Phase 2A | Loopback Next.js standalone process | The same remote Flask URL, injected into the Node process only when it is already configured |
| iPad PWA, Phase 4 | The existing hosted Next.js origin | That origin's `/api/*` routes, which proxy to the remote Flask URL |

No shell receives Firebase Admin credentials, Gemini, Genius, Music.ai, or the Python URL in renderer code.

## Phase 2 — Windows Electron

Phase 2A adds the Electron shell. Phase 2B packages that shell as an unsigned Windows x64 NSIS installer. It does not add offline analysis or automatic updates.

The shell entry is `electron/main.cjs`. `npm run desktop:compile` writes `electron/dist`, and `npm run desktop` launches that main process. There is no preload script. The window is created with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and `webSecurity: true`.

The main process starts `.next/standalone/server.js` as a child. `HOSTNAME` is forced to `127.0.0.1` and `PORT` is an ephemeral loopback port. The port is reserved with an exclusive listen and then released; a process that wins the race cannot satisfy the readiness proof. The window opens only after `GET /api/desktop/ready` returns a proof of `sha256(ready token + ":" + nonce)`. `/api/health` still proxies to Flask, so a missing analysis backend does not block the window. `getLoopbackServerPlan()` still records `/api/health` as the Flask probe from Phase 1.

On quit, Linux sends `SIGTERM` and then `SIGKILL` to the owned process group. Windows uses `taskkill /PID <pid> /T /F`. The shell refuses to signal pid 1 or its own pid. A second launch quits and asks the first instance to focus its window.

Before static files are served, `public` and `.next/static` are copied next to the standalone server. The copy skips `.env` files and any `python_backend` directory. `PYTHON_API_URL` is forwarded only in the Node child environment when it is already set. Startup failures are shown in a dialog and appended to `desktop.log` after secret values are redacted.

Desktop mode (`CHORDMINI_DESKTOP_MODE=1`) rejects a Host other than `127.0.0.1`, `Sec-Fetch-Site` values other than `none` or `same-origin`, and an `Origin` that is not the exact loopback origin. Document navigations set an HttpOnly `SameSite=Strict` cookie. Other routes require that cookie. `/api/desktop/ready` is the exception and relies on the proof header. The production website leaves this gate bypassed. A non-browser process on the same machine can still open a TCP connection to the loopback port; it does not receive the cookie or the ready token.

### Windows CI

`.github/workflows/windows-electron.yml` runs on `windows-latest`. It installs dependencies, builds the standalone server, compiles the Electron main process, runs the desktop Jest suite, and launches the installed Windows Electron executable through Playwright. The job uploads `windows-electron-artifacts`, including the window screenshots and a redacted `report.json`.

A passing Linux process-lifecycle test is not a Windows pass. The acceptance script exits 2 on any other operating system. YouTube playback and ffmpeg.wasm transcoding stay unverified unless that Windows report says they were exercised. The page keeps `Cross-Origin-Embedder-Policy: unsafe-none` so YouTube frames can load; that header leaves `crossOriginIsolated` false, which blocks the multithreaded ffmpeg.wasm core.

## Phase 2B — Windows installer

`.github/workflows/windows-installer.yml` builds an unsigned NSIS x64 installer with electron-builder. The installer contains the Electron shell and the Next.js standalone server. The packaged server runs through `ELECTRON_RUN_AS_NODE`, so the installed app does not need a separate Node.js or Python installation. Automatic updates are disabled. The build does not publish a GitHub Release.

The packaged server path is `resources/standalone/server.js`. Development still prepares `.next/standalone` from the repository. `CHORDMINI_DESKTOP_PID_FILE` writes a pid only when `CHORDMINI_DESKTOP_ACCEPTANCE=1` and the path is absolute. A normal installation does not set that flag.

## Phase 4 — iPad PWA

Do not implement this in Phase 1. The future PWA must:

- Reuse the existing hosted Next.js site. Do not bundle a local Python or Node server on the iPad.
- Keep analysis on the existing same-origin API routes.
- Leave private audio files and authenticated API responses out of any future service worker cache.
- Treat offline AI inference as out of scope. Cached UI assets are not an analysis engine.

The manifest and service worker are unchanged in this phase. `public/sw.js` is still absent, and the service worker flag still defaults to off.
