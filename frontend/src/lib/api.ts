import { TabId } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// Maps each tab to its backend agent endpoint.
// Needs adjustment to the backend in the future. placeholders at the moment backend/app/routers
const ENDPOINTS: Record<TabId, string> = {
  "Project Idea": "/idea",
  "Market Research": "/research",
  Slides: "/slides",
  "UI Design": "/design",
  Code: "/code",
};

export interface AgentRequest {
  message: string;
}

// TODO: wire this up once the backend endpoints exist.
// Currently a stub 
export async function sendToAgent(tab: TabId, req: AgentRequest) {
  const res = await fetch(`${API_URL}${ENDPOINTS[tab]}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`Agent call failed: ${res.status}`);
  }
  return res.json();
}
