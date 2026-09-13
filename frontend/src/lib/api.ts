import { loadAuth, saveAuth, clearAuth } from "./auth";
import {
  AuthTokens,
  User,
  AgentType,
  Project,
  ProjectNode,
  ToolPolicy,
  Edge,
  EdgeKind,
  ToolType,
  ToolCall,
  SendChatResult,
  ResumeResult,
} from "./types";

const API_URL = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"
).replace(/\/$/, "");

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {}
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (opts.auth) {
    const stored = loadAuth();
    if (!stored) throw new ApiError(401, "Not logged in");
    headers["Authorization"] = `Bearer ${stored.access_token}`;
  }

  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // 404 means "not found, or not yours" per API.md — never assume which.
    throw new ApiError(res.status, data?.detail ?? res.statusText);
  }
  return data as T;
}

// Auth

export async function signup(email: string, password: string) {
  return request<{ message: string }>("/auth/signup", {
    method: "POST",
    body: { email, password },
  });
}

export async function login(email: string, password: string) {
  const tokens = await request<AuthTokens>("/auth/login", {
    method: "POST",
    body: { email, password },
  });
  saveAuth({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
  return tokens;
}

export async function logout() {
  try {
    await request("/auth/logout", { method: "POST", auth: true });
  } finally {
    // Discard tokens locally regardless of the request outcome — API.md
    // notes the client should do this even after a successful call.
    clearAuth();
  }
}

export async function getMe() {
  return request<User>("/auth/me", { auth: true });
}

export async function passwordReset(email: string) {
  return request<void>("/auth/password-reset", { method: "POST", body: { email } });
}

export async function googleLoginUrl(redirectTo?: string) {
  const qs = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : "";
  return request<{ url: string; provider: string }>(`/auth/login/google${qs}`);
}

// Agent types (catalog)

export async function getAgentTypes() {
  return request<AgentType[]>("/agent-types", { auth: true });
}

// Tool types (catalog)

export async function getToolTypes() {
  return request<ToolType[]>("/tool-types", { auth: true });
}

// Projects

export async function listProjects() {
  return request<Project[]>("/projects", { auth: true });
}

export async function createProject(name: string, description?: string) {
  return request<Project>("/projects", {
    method: "POST",
    auth: true,
    body: { name, description },
  });
}

export async function deleteProject(projectId: string) {
  return request<void>(`/projects/${projectId}`, { method: "DELETE", auth: true });
}

// Nodes — agents and tools are mixed together on a project's canvas,
// distinguished by `kind`.

export async function listNodes(projectId: string) {
  return request<ProjectNode[]>(`/projects/${projectId}/nodes`, { auth: true });
}

export async function createAgentNode(
  projectId: string,
  agentSlug: string,
  opts: { name?: string; position_x?: number; position_y?: number } = {}
) {
  return request<ProjectNode>(`/projects/${projectId}/nodes`, {
    method: "POST",
    auth: true,
    body: { kind: "agent", agent_slug: agentSlug, ...opts },
  });
}

export async function createToolNode(
  projectId: string,
  toolSlug: string,
  opts: {
    name?: string;
    config?: Record<string, unknown>;
    position_x?: number;
    position_y?: number;
  } = {}
) {
  return request<ProjectNode>(`/projects/${projectId}/nodes`, {
    method: "POST",
    auth: true,
    body: { kind: "tool", tool_slug: toolSlug, ...opts },
  });
}

export async function updateNode(
  projectId: string,
  nodeId: string,
  patch: Partial<{
    position_x: number;
    position_y: number;
    name: string;
    tool_policy: ToolPolicy;
  }>
) {
  return request<ProjectNode>(`/projects/${projectId}/nodes/${nodeId}`, {
    method: "PATCH",
    auth: true,
    body: patch,
  });
}

export async function deleteNode(projectId: string, nodeId: string) {
  return request<void>(`/projects/${projectId}/nodes/${nodeId}`, {
    method: "DELETE",
    auth: true,
  });
}

export async function verifyNode(projectId: string, nodeId: string) {
  return request<ProjectNode>(`/projects/${projectId}/nodes/${nodeId}/verify`, {
    method: "POST",
    auth: true,
  });
}

export async function authorizeNode(projectId: string, nodeId: string) {
  return request<{ url: string }>(
    `/projects/${projectId}/nodes/${nodeId}/authorize`,
    { method: "POST", auth: true }
  );
}

export async function listToolCalls(
  projectId: string,
  nodeId: string,
  limit?: number
) {
  const qs = limit ? `?limit=${limit}` : "";
  return request<ToolCall[]>(
    `/projects/${projectId}/nodes/${nodeId}/tool-calls${qs}`,
    { auth: true }
  );
}

// Edges — arrows between nodes. `context` shares a summary agent-to-agent;
// `tool` makes a tool node's toolset callable by an agent.

export async function listEdges(projectId: string) {
  return request<Edge[]>(`/projects/${projectId}/edges`, { auth: true });
}

export async function createEdge(
  projectId: string,
  sourceNodeId: string,
  targetNodeId: string,
  kind: EdgeKind = "context"
) {
  return request<Edge>(`/projects/${projectId}/edges`, {
    method: "POST",
    auth: true,
    body: { source_node_id: sourceNodeId, target_node_id: targetNodeId, kind },
  });
}

export async function refreshEdge(projectId: string, edgeId: string) {
  return request<Edge>(`/projects/${projectId}/edges/${edgeId}/refresh`, {
    method: "POST",
    auth: true,
  });
}

export async function deleteEdge(projectId: string, edgeId: string) {
  return request<void>(`/projects/${projectId}/edges/${edgeId}`, {
    method: "DELETE",
    auth: true,
  });
}

// Chat

export async function sendChat(
  nodeId: string,
  prompt: string,
  clientToken?: string
): Promise<SendChatResult> {
  return request<SendChatResult>("/chat", {
    method: "POST",
    auth: true,
    body: { node_id: nodeId, prompt, client_token: clientToken },
  });
}

export async function resumeChat(
  nodeId: string,
  approvals: Record<string, boolean>
): Promise<ResumeResult> {
  return request<ResumeResult>("/chat/resume", {
    method: "POST",
    auth: true,
    body: { node_id: nodeId, approvals },
  });
}

// Streaming uses POST, so the browser's built-in EventSource (GET-only)
// can't be used. This manually reads the response body as a stream and
// parses the "event: ... \ndata: ...\n\n" blocks by hand.
export interface StreamHandlers {
  onStart?: (data: any) => void;
  onChunk?: (text: string) => void;
  onDone?: (data: any) => void;
  onError?: (data: any) => void;
  // Emitted instead of onDone when a tool call needs approval; the stream
  // ends here with no `done` event, per API.md.
  onApprovalRequired?: (data: any) => void;
}

export async function streamChat(
  nodeId: string,
  prompt: string,
  clientToken: string | undefined,
  handlers: StreamHandlers
) {
  const stored = loadAuth();
  if (!stored) throw new ApiError(401, "Not logged in");

  const res = await fetch(`${API_URL}/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${stored.access_token}`,
    },
    body: JSON.stringify({ node_id: nodeId, prompt, client_token: clientToken }),
  });

  if (!res.body) throw new Error("No response body for stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by a blank line
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const lines = part.split("\n");
      let event = "message";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (event === "start") handlers.onStart?.(parsed);
      else if (event === "chunk") handlers.onChunk?.(parsed.text);
      else if (event === "done") handlers.onDone?.(parsed);
      else if (event === "error") handlers.onError?.(parsed);
      else if (event === "approval_required") handlers.onApprovalRequired?.(parsed);
    }
  }
}

export { ApiError };
