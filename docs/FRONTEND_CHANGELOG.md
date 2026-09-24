# Frontend Changelog — Agent Mesh Canvas rework

## Code preview (E2B workspace) — 2026-09-25

A full-screen **Workspace** window for any environment: browse what agents built, preview it running,
download it, and use a terminal. Backend endpoints it relies on are in `docs/API.md` → Environments.

**Where it opens from:** the new `▣ Workspace` button in the top bar (opens the selected agent's folder,
else a user environment, else the shared scratch space); "Open workspace" on environment cards and in the
environment inspector; "Files" next to each environment in the agent inspector; "Files & preview" in the
chat window header (and the environment chips there); double-clicking an environment chip on an agent card.

**What's in it** (`src/components/workspace/`):
- `WorkspaceWindow.tsx` — the window. Code / Split / Preview views, environment switcher, status bar, a
  "Start environment" screen for pending/stopped sandboxes, and a live loop (every 4s, one batched request)
  that flashes files an agent changed, reloads open tabs, and reloads the preview.
- `FileTree.tsx` — lazy explorer. Agent folders (named by node id) show the agent's name. Filter box,
  dotfile toggle, hover actions: ▶ preview (HTML files / folders), ⤓ download (file, or folder as .zip).
  Drag files onto it to upload.
- `CodeView.tsx` — tabs, syntax highlighting (highlight.js, core + common languages only), line numbers,
  image viewer, binary notice, and a quick editor (Edit → Save, Ctrl/⌘+S).
- `PreviewPane.tsx` — iframe of the running app. Ports are detected automatically; address bar for sub-paths,
  desktop/tablet/phone widths, "Live" auto-reload on file changes, open in new tab. Empty state can serve the
  current folder as a static site with one click.
- `TerminalPane.tsx` — a real terminal (xterm.js) on the existing PTY socket, cd'd into the agent's folder.
  Stays connected while hidden.
- Download: header `⤓ Download .zip` (code only, or ▾ with dependencies / just the selected folder).

**Other changes:** `EnvironmentInspector` lost its cramped file list, preview-URL box and plain-text terminal
(all now in the window) and gained a "Running servers" list. New helpers in `src/lib/files.ts` and
`src/lib/highlight.ts`; new API calls in `src/lib/api.ts` (`fetchEnvironmentFileBlob`, `fetchEnvironmentArchive`,
`writeEnvironmentFile`, `listManyEnvironmentFiles`, `listEnvironmentPorts`, `serveEnvironmentPath`).
New dependencies: `highlight.js`, `@xterm/xterm`, `@xterm/addon-fit` — run `npm install`.

---

## Canvas rework — 2026-09-17

Scope of this pass: **frontend only** (`frontend/`). No backend files were edited — backend
sections below are read-only findings for the backend dev to act on.

Date: 2026-09-17

---

## 1. What changed 9/17/2026

### `src/lib/types.ts`
- Added `EnvironmentNode`, environment-related `NodeKind`/`EdgeKind` values, and `isEnvironmentNode()`.
- Added `ToolPreset` type (for the tool preset picker in the palette).
- Added environment file-browsing and preview response types (`EnvironmentFilesResponse`, `EnvironmentFileContent`, `EnvironmentPreview`).
- Added `UsageTotals`.
- Added `default_presets` on `AgentType` and `model` on `AgentNode`.

### `src/lib/api.ts`
- Added `getToolPresets`.
- Added environment CRUD calls (create/list/get/update/start/stop/verify) and `environmentTerminalUrl()` for the terminal WebSocket.
- Extended `createToolNode` to accept `presetSlug`.
- Added `onTool` to `StreamHandlers` so the chat stream surfaces tool-call/tool-result events, not just text chunks.
- Added `getUsage` / `getProjectUsage`.
- **Fixed:** `logout()` no longer lets a failed `/auth/logout` call (e.g. an already-expired token) block local logout. It now catches that failure and always clears local tokens, so `onLoggedOut()` in `ProjectsScreen.tsx` actually fires instead of leaving the user stuck on the projects screen with an unhandled promise rejection in the console.

### `src/components/NodeCard.tsx`
- Agent cards now show equipped tools as chips directly on the card (`AttachedTool` type), matching the design.
- Fixed a drag-state bug from the initial build: native HTML5 drag-over highlighting (for dropping a tool onto an agent) was incorrectly sharing state with the pointer-based port-linking hover. Split into its own `nativeDragOver` state.
- Added environment card styling (green accent, status pill).

### `src/components/MeshCanvas.tsx`
- **Fixed:** position-save routing. Previously every node drag called the agent-only `PATCH /nodes/{id}` regardless of node kind, which 404'd/mismatched for environment nodes (`PATCH /environments/{id}` is the correct route) and silently no-op'd for tool nodes (which have no patch route at all). Added a `savePosition()` helper that routes by node kind: agent → `updateNode`, environment → `updateEnvironment`, tool → no-op (position is client-side only until a patch route exists).
- `handleTidy` and `handleUnequipTool` updated to respect the same routing; removed a dead-end `updateNode(...).catch(() => {})` call on tool nodes in `handleUnequipTool`.

### `src/components/Palette.tsx`
- Rebuilt with Agents / Tools / Environments tabs and a preset sub-list under Tools, matching the uploaded design.
- **Fixed (CSS):** the tab pill (Agents/Tools/Env) had no visible border/background, so it blended into the page — the theme's `border` token is `rgba(255,255,255,0.09)`, nearly invisible on the near-black top bar. Gave the pill a visible border and a lightened background.
- **Fixed (CSS, layout bug):** the tab pill was wider than the fixed 150px column it sat in, so it overflowed past the vertical divider line, making the divider visually cut through the "Env" label. Widened the column (150px → 196px) so the pill fits before the divider.

### `src/components/Inspector.tsx`
- Added `EnvironmentInspector` (status, file browser, preview link) and `TerminalPanel` (xterm-style view wired to the terminal WebSocket).
- Threaded `onUnequipTool` through so tool chips can be removed from an agent card.
- Added handling for the stream's `onTool` events (shows tool calls live as they happen).
- **Fixed:** the chat error handler assumed `data.message` existed and fell back to the literal string `"stream error"` when it didn't. It now falls back through `data.message → data.detail → data.error → data.reason → JSON.stringify(data)` before a descriptive default — this matters because the backend's actual SSE error payload key is `error` (`{"error": str(exc)}`), which the old code never read.

### `src/components/ToolConfigModal.tsx`
- Added `attachToAgentId` prop and auto-creates the tool→agent edge on submit when a tool is dropped directly onto an agent card.

### `src/components/EdgeLayer.tsx`
- Suppressed rendering of `tool`-kind edges as canvas lines (tools now show as chips on the card instead, per the design).
- Added green styling for `environment`-kind edges.

All of the above were validated with `npx tsc --noEmit` (clean) and `npx next build` (clean) before being written back.

---

## 2. What's still not working

### Orchestrator "stream error" on `/chat/stream` — unresolved
Reported repeatedly during testing; root cause **not yet confirmed**. Ruled out so far:
- **E2B/environment layer** — confirmed working via a direct terminal test (real shell output over the WebSocket).
- **Expired Supabase token** — was the leading hypothesis (tokens expire after 1h, no refresh logic in the frontend, and a literal "Invalid or expired token" error had been seen elsewhere). Retested with a fresh login — the stream error still occurs, so this is **not** the cause.

Read-only findings from the backend that narrow it further:
- `backend/app/workflows.py`, `stream_turn()` → `drive()`: the exception from a failed turn is caught, turned into `str(exc)`, sent to the frontend as the SSE `error` event, and written into the `messages` table row (`status='failed'`, `error=<string>`) — but it is **never logged server-side** (no `log.exception` call on that path). So **Railway's log stream will not show this failure.**
- The fastest way to get the real error: open Supabase → Table Editor → `messages` table → sort by `created_at` desc (or filter `status = eq.failed`) → read the `error` column on the latest failed row. That's the exact exception string, guaranteed, regardless of whether the frontend fix above has been picked up in the browser yet.
- `backend/app/config.py`: `llm_provider` defaults to `"ollama"`, and `ollama_api_key` defaults to an empty string with **no validation anywhere** that it's actually set. If that key is missing or wrong on the Railway deployment, every orchestrator turn would fail immediately — this is the leading unconfirmed hypothesis. Worth checking Railway's environment variables for `OLLAMA_API_KEY`.

**Next step:** pull the `error` string from the `messages` table and match it against `config.py`'s settings — that will confirm or rule out the Ollama key theory in one look.

### Known UI gap (not fixed, just flagged)
- In `AgentInspector`, the "Environments" / "Tools" list items are not clickable to select/navigate to that node — only the chips on the `NodeCard` itself are. Not requested as a fix, noting it for later.

### Frontend has no 401 auto-refresh
- Tokens expire after 1 hour (Supabase default) and the frontend does not retry with a refreshed token on a 401. Not fixed — only `logout()`'s failure-handling was fixed, not added retry/refresh logic. Worth a ticket if long sessions are common.

---

## 3. Notes for the backend dev (read-only observations, not applied)

- `backend/app/routers/environments.py`, `_environment_config()`: `preview_ports` is validated on environment creation (max 10 ports) but the `GET /{node_id}/preview?port=` endpoint itself doesn't check the requested port against `preview_ports` — any port 1–65535 is accepted regardless of what was configured. Might be intentional (informational field only) or might be a gap — flagging since I didn't read `assembly.py`/`sandboxes.py` to rule out enforcement elsewhere.
- Same file: the terminal WebSocket (`/{node_id}/terminal`) opens a real PTY (`sandbox.pty.create`) — a genuine interactive shell in the E2B sandbox, separate from the agent's own `run_command`/`read_file`/`write_file`/`list_files` toolset. Both act on the same sandbox and filesystem.
