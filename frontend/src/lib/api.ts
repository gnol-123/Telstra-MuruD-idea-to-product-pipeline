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
  ToolPreset,
  ToolCall,
  SendChatResult,
  ResumeResult,
  EnvironmentFilesResponse,
  EnvironmentFileContent,
  EnvironmentPreview,
  UsageTotals,
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
  } catch {
    // A dead or already-expired token means the server call was never going
    // to succeed anyway — that is not a reason to keep the user signed in
    // locally, so swallow it and fall through to clearAuth() below.
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

// Tool types (catalog) and presets (ready-to-instantiate tools/skills)

export async function getToolTypes() {
  return request<ToolType[]>("/tool-types", { auth: true });
}

export async function getToolPresets() {
  return request<ToolPreset[]>("/tool-presets", { auth: true });
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

// Nodes — agents, tools and environments are mixed together on a
// project's canvas, distinguished by `kind`.

export async function listNodes(projectId: string) {
  return request<ProjectNode[]>(`/projects/${projectId}/nodes`, { auth: true });
}

export async function createAgentNode(
  projectId: string,
  agentSlug: string,
  opts: { name?: string; position_x?: number; position_y?: number; tool_policy?: ToolPolicy } = {}
) {
  return request<ProjectNode>(`/projects/${projectId}/nodes`, {
    method: "POST",
    auth: true,
    body: { kind: "agent", agent_slug: agentSlug, ...opts },
  });
}

export async function createToolNode(
  projectId: string,
  opts: {
    toolSlug?: string;
    presetSlug?: string;
    name?: string;
    config?: Record<string, unknown>;
    position_x?: number;
    position_y?: number;
  } = {}
) {
  return request<ProjectNode>(`/projects/${projectId}/nodes`, {
    method: "POST",
    auth: true,
    body: {
      kind: "tool",
      tool_slug: opts.toolSlug,
      preset_slug: opts.presetSlug,
      name: opts.name,
      config: opts.config,
      position_x: opts.position_x,
      position_y: opts.position_y,
    },
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
    model: string;
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

// Environments — a real sandbox (shell, filesystem, preview URL). These
// use their own PATCH/verify routes rather than the generic node ones,
// per API.md: "kind='agent' -> here, kind='environment' -> its own route."

export async function createEnvironmentNode(
  projectId: string,
  opts: {
    name?: string;
    position_x?: number;
    position_y?: number;
    template?: string;
    idle_timeout_s?: number;
    preview_ports?: number[];
    description?: string;
  } = {}
) {
  const config: Record<string, unknown> = {};
  if (opts.template) config.template = opts.template;
  if (opts.idle_timeout_s) config.idle_timeout_s = opts.idle_timeout_s;
  if (opts.preview_ports) config.preview_ports = opts.preview_ports;
  if (opts.description) config.description = opts.description;

  return request<ProjectNode>(`/projects/${projectId}/nodes`, {
    method: "POST",
    auth: true,
    body: {
      kind: "environment",
      name: opts.name,
      position_x: opts.position_x,
      position_y: opts.position_y,
      config,
    },
  });
}

export async function getEnvironment(projectId: string, nodeId: string) {
  return request<ProjectNode>(`/projects/${projectId}/environments/${nodeId}`, {
    auth: true,
  });
}

export async function updateEnvironment(
  projectId: string,
  nodeId: string,
  patch: Partial<{ name: string; tool_policy: ToolPolicy; position_x: number; position_y: number }>
) {
  return request<ProjectNode>(`/projects/${projectId}/environments/${nodeId}`, {
    method: "PATCH",
    auth: true,
    body: patch,
  });
}

export async function startEnvironment(projectId: string, nodeId: string) {
  return request<ProjectNode>(`/projects/${projectId}/environments/${nodeId}/start`, {
    method: "POST",
    auth: true,
  });
}

export async function stopEnvironment(projectId: string, nodeId: string) {
  return request<ProjectNode>(`/projects/${projectId}/environments/${nodeId}/stop`, {
    method: "POST",
    auth: true,
  });
}

export async function verifyEnvironment(projectId: string, nodeId: string) {
  return request<ProjectNode>(`/projects/${projectId}/environments/${nodeId}/verify`, {
    method: "POST",
    auth: true,
  });
}

export async function listEnvironmentFiles(
  projectId: string,
  nodeId: string,
  path?: string
) {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  return request<EnvironmentFilesResponse>(
    `/projects/${projectId}/environments/${nodeId}/files${qs}`,
    { auth: true }
  );
}

export async function readEnvironmentFile(
  projectId: string,
  nodeId: string,
  path: string
) {
  return request<EnvironmentFileContent>(
    `/projects/${projectId}/environments/${nodeId}/files/content?path=${encodeURIComponent(path)}`,
    { auth: true }
  );
}

export async function getEnvironmentPreview(
  projectId: string,
  nodeId: string,
  port: number
) {
  return request<EnvironmentPreview>(
    `/projects/${projectId}/environments/${nodeId}/preview?port=${port}`,
    { auth: true }
  );
}

// The terminal is a raw WebSocket, not a JSON endpoint — browsers can't set
// a bearer header on a socket, so the token travels in the query string.
// This just builds the URL; the terminal component owns the socket itself.
export function environmentTerminalUrl(
  projectId: string,
  nodeId: string,
  cols: number,
  rows: number
) {
  const stored = loadAuth();
  if (!stored) throw new ApiError(401, "Not logged in");
  const wsBase = API_URL.replace(/^http/, "ws");
  const token = encodeURIComponent(stored.access_token);
  return `${wsBase}/projects/${projectId}/environments/${nodeId}/terminal?token=${token}&cols=${cols}&rows=${rows}`;
}

// Edges — arrows between nodes. `context` shares a summary agent-to-agent;
// `tool` makes a tool node's toolset callable by an agent; `environment`
// gives an agent a sandbox to execute in. All three follow the same
// draw/list/delete shape; only `context` supports /refresh.

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
  // `event: tool` — carries {name, args} when a tool/sub-agent is called
  // and {name, result_head} when it returns. Surfaced separately from
  // onChunk so the UI can render it as a distinct "checkpoint" in the
  // transcript rather than mixing it into the assistant's prose.
  onTool?: (data: any) => void;
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
      else if (event === "tool") handlers.onTool?.(parsed);
    }
  }
}

// Usage

export async function getUsage() {
  return request<UsageTotals>("/usage", { auth: true });
}

export async function getProjectUsage(projectId: string) {
  return request<UsageTotals>(`/projects/${projectId}/usage`, { auth: true });
}

export { ApiError };
