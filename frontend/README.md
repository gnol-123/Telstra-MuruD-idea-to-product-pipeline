(frontend)

## Local development

1. `npm install`
3. `npm run dev`
4. Open http://localhost:3000

## Structure

- `src/app` — Next.js App Router entry (layout, page)
- `src/components` — Workspace shell: TopNav, ChatPanel, SourcePicker, CanvasPanel
- `src/components/canvas` — the five per-tab canvas views
- `src/lib/types.ts` — shared TypeScript types
- `src/lib/mockData.ts` — placeholder data (replace with real API responses)
- `src/lib/api.ts` — fetch wrapper for the FastAPI backend (stubbed until backend endpoints exist)
