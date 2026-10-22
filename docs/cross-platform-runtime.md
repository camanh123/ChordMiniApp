# Cross-platform runtime foundation

Phase 1 records how ChordMini chooses a shell and how every shell reaches the existing analysis API. It does not add Electron, Capacitor, an installer, or a service worker.

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
| Electron, Phase 2 | Loopback Next.js standalone process | The same remote Flask URL, injected into the Node process only |
| iPad PWA, Phase 4 | The existing hosted Next.js origin | That origin's `/api/*` routes, which proxy to the remote Flask URL |

No shell receives Firebase Admin credentials, Gemini, Genius, Music.ai, or the Python URL in renderer code.

## Phase 2 — Windows Electron

Do not implement this in Phase 1. The future shell must:

- Bind the Next.js standalone server to `127.0.0.1` only. Do not bind `0.0.0.0` or a LAN address.
- Choose an ephemeral free port on that loopback interface and pass it to the server.
- Wait until `GET /api/health` succeeds before showing the window.
- On quit, stop the Node process and any `yt-dlp` or `ffmpeg` children it spawned.
- Copy `public` and `.next/static` next to the standalone `server.js`, matching the frontend Dockerfile.
- Keep `PYTHON_API_URL` in the Node process environment. Do not place it in the Electron renderer or in `NEXT_PUBLIC_*`.
- Do not ship `.env` secrets, Firebase Admin JSON, or Python model checkpoints in the Phase 2 installer. Analysis stays on the current remote Flask service.

`getLoopbackServerPlan()` in `src/runtime/packagingContract.ts` records the host and health path. It does not open a socket.

## Phase 4 — iPad PWA

Do not implement this in Phase 1. The future PWA must:

- Reuse the existing hosted Next.js site. Do not bundle a local Python or Node server on the iPad.
- Keep analysis on the existing same-origin API routes.
- Leave private audio files and authenticated API responses out of any future service worker cache.
- Treat offline AI inference as out of scope. Cached UI assets are not an analysis engine.

The manifest and service worker are unchanged in this phase. `public/sw.js` is still absent, and the service worker flag still defaults to off.
