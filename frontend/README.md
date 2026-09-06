# Agent Mesh (frontend)

Canvas-based frontend: log in, pick/create a project, add agent nodes from the
catalog, drag them around, chat with each one.

## Local development

1. `npm install`
2. `cp .env.example .env.local` — point NEXT_PUBLIC_API_URL at localhost:8000
   (backend running locally) or the deployed Railway URL.
3. `npm run dev`
4. Open http://localhost:3000

Supabase auth on the deployed backend only allows localhost:3000 as a redirect
target right now, so keep the frontend on port 3000 during local dev.

## What's made vs. not yet

- Auth, projects, node creation/position, and chat (including the streaming
  variant) call the real backend — see src/lib/api.ts.
  
- Edges (context sharing between nodes) and tool nodes are not implemented
- Chat history does not reload after a page refresh, because there's no
  endpoint to list a conversation's past messages without sending a new one.

## Structure

- src/app/page.tsx — auth gate -> projects -> canvas
- src/components/LoginScreen.tsx, ProjectsScreen.tsx — auth + project list
- src/components/MeshCanvas.tsx — one project's canvas (palette + nodes + inspector)
- src/components/NodeCard.tsx — draggable node, PATCHes position on drop
- src/components/Inspector.tsx — chat panel, supports both /chat and /chat/stream
- src/lib/api.ts — every backend call, one function per API.md endpoint
- src/lib/types.ts, src/lib/auth.ts — shared types and token storage
