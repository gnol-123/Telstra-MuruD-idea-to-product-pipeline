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
  EnvironmentPort,
  EnvironmentPreviewEntry,
  ServeResult,
  EnvironmentFileWrite,
  UsageTotals,
  ChatMessage,
  CancelChatResponse,
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

// Supabase access tokens last an hour. Swapping the refresh token for a new
// pair keeps a session alive as long as it stays in use, instead of dying
// mid-task. Shared so concurrent 401s trigger one refresh, not a stampede.
let refreshInFlight: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const stored = loadAuth();
  if (!stored?.refresh_token) throw new ApiError(401, "Not logged in");

  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: stored.refresh_token }),
      });
      if (!res.ok) {
        // The refresh token is dead too, so there is no session to save.
        clearAuth();
        throw new ApiError(401, "Session expired. Log in again.");
      }
      const tokens = (await res.json()) as AuthTokens;
      saveAuth({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
      return tokens.access_token;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

// The current access token, refreshed first if the stored one has expired.
// Every authenticated call goes through this, including the SSE and
// WebSocket paths that build their own headers.
export async function authToken(): Promise<string> {
  const stored = loadAuth();
  if (!stored) throw new ApiError(401, "Not logged in");
  return isExpired(stored.access_token) ? refreshAccessToken() : stored.access_token;
}

// Reads `exp` out of the JWT payload. Treats an unparseable token as expired
// so a malformed value refreshes rather than wedging the session.
function isExpired(token: string, skewSeconds = 60): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (typeof payload.exp !== "number") return true;
    return Date.now() / 1000 >= payload.exp - skewSeconds;
  } catch {
    return true;
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {}
): Promise<T> {
  const send = async (token?: string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return fetch(`${API_URL}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  };

  let res = await send(opts.auth ? await authToken() : undefined);

  // A 401 despite a fresh-looking token: the server rejected it anyway
  // (revoked, or clocks disagree). One refresh and one retry, then give up.
  if (res.status === 401 && opts.auth) {
    res = await send(await refreshAccessToken());
  }

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
    // Raw fetch, not request(): refreshing a session we are about to throw
    // away just to say goodbye is wasted work.
    const stored = loadAuth();
    if (stored) {
      await fetch(`${API_URL}/auth/logout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${stored.access_token}`,
        },
      });
    }
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

// Model names the provider serves, for the chat's model picker.
export async function listModels() {
  return request<string[]>("/models", { auth: true });
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

// An agent node's transcript. Used to hydrate the chat panel from the
// backend on first open, since the frontend otherwise only keeps messages
// in memory for the life of the tab — see Inspector.tsx's ChatState.
export async function listNodeMessages(
  projectId: string,
  nodeId: string,
  afterSeq?: number
) {
  const qs = afterSeq != null ? `?after_seq=${afterSeq}` : "";
  return request<ChatMessage[]>(
    `/projects/${projectId}/nodes/${nodeId}/messages${qs}`,
    { auth: true }
  );
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

// Returns every id the backend removed: the node plus any tools it orphaned.
export async function deleteNode(projectId: string, nodeId: string) {
  return request<{ deleted_node_ids: string[] }>(`/projects/${projectId}/nodes/${nodeId}`, {
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

// -------------------- Code preview: raw bytes, ports, serving --------------------

// fetch() with the same bearer-token + one-refresh-and-retry contract as
// request(), for the endpoints that return or take raw bytes rather than
// JSON. Throws ApiError with the backend's `detail` on a non-2xx.
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = async (token: string) =>
    fetch(`${API_URL}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  let res = await send(await authToken());
  if (res.status === 401) res = await send(await refreshAccessToken());
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data?.detail ?? res.statusText);
  }
  return res;
}

function envPath(projectId: string, nodeId: string, rest: string) {
  return `/projects/${projectId}/environments/${nodeId}${rest}`;
}

// One file's raw bytes — images in the viewer, and downloads.
export async function fetchEnvironmentFileBlob(projectId: string, nodeId: string, path: string) {
  const res = await authedFetch(
    envPath(projectId, nodeId, `/files/download?path=${encodeURIComponent(path)}`)
  );
  return res.blob();
}

// A directory as a .zip, built inside the sandbox. Dependency folders
// (node_modules, .git, .venv...) are left out unless asked for.
export async function fetchEnvironmentArchive(
  projectId: string,
  nodeId: string,
  path: string,
  includeDependencies = false
) {
  const qs = `?path=${encodeURIComponent(path)}${includeDependencies ? "&include_dependencies=true" : ""}`;
  const res = await authedFetch(envPath(projectId, nodeId, `/files/archive${qs}`));
  return res.blob();
}

// Upload, or save an edited file. Raw body, so any file type round-trips.
export async function writeEnvironmentFile(
  projectId: string,
  nodeId: string,
  path: string,
  body: Blob | string
) {
  const res = await authedFetch(envPath(projectId, nodeId, `/files?path=${encodeURIComponent(path)}`), {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body,
  });
  return (await res.json()) as EnvironmentFileWrite;
}

// Several folders in one request — the code preview's live refresh. A
// folder that's gone reports `error` instead of failing the batch.
export async function listManyEnvironmentFiles(projectId: string, nodeId: string, paths: string[]) {
  return request<{ listings: { path: string; entries: EnvironmentFilesResponse["entries"] | null; error: string | null }[] }>(
    envPath(projectId, nodeId, "/files/list"),
    { method: "POST", auth: true, body: { paths } }
  );
}

export async function listEnvironmentPorts(projectId: string, nodeId: string) {
  return request<{ ports: EnvironmentPort[] }>(envPath(projectId, nodeId, "/ports"), { auth: true });
}

// Published previews plus any other listening port.
export async function listEnvironmentPreviews(projectId: string, nodeId: string) {
  return request<{ previews: EnvironmentPreviewEntry[] }>(envPath(projectId, nodeId, "/previews"), { auth: true });
}

// Start (or reuse) a static server on a directory — or on a file's
// directory, in which case open_url points straight at the file.
export async function serveEnvironmentPath(projectId: string, nodeId: string, path: string) {
  return request<ServeResult>(envPath(projectId, nodeId, "/serve"), {
    method: "POST",
    auth: true,
    body: { path },
  });
}

// The terminal is a raw WebSocket, not a JSON endpoint — browsers can't set
// a bearer header on a socket, so the token travels in the query string.
// This just builds the URL; the terminal component owns the socket itself.
export async function environmentTerminalUrl(
  projectId: string,
  nodeId: string,
  cols: number,
  rows: number
) {
  const wsBase = API_URL.replace(/^http/, "ws");
  // A socket authenticates once at connect, so a token that expires a minute
  // later takes the terminal down with it. Refresh before dialling.
  const token = encodeURIComponent(await authToken());
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

// Shared by streamChat (POST /chat/stream) and attachChat (GET /chat/attach)
// — both return the identical "event: ...\ndata: ...\n\n" SSE shape per
// API.md, so the parsing loop only needs to exist once. Per the
// rt-stream-checkpoint change, `error` is no longer terminal: a `done`
// carrying the final (possibly `status: "failed"`) assistant_message always
// follows it, so this keeps reading until the response body itself ends
// rather than stopping at the first `error`.
async function consumeSSE(res: Response, handlers: StreamHandlers) {
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

export async function streamChat(
  nodeId: string,
  prompt: string,
  clientToken: string | undefined,
  handlers: StreamHandlers
) {
  const res = await fetch(`${API_URL}/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await authToken()}`,
    },
    body: JSON.stringify({ node_id: nodeId, prompt, client_token: clientToken }),
  });

  await consumeSSE(res, handlers);
}

// Re-joins a turn that's still running on this node — after a reload, or
// from a second tab. Returns `false` (no HTTP call was left hanging) when
// the backend reports 204 "nothing running", so the caller can fall back to
// treating the conversation as idle instead of waiting on a stream that will
// never emit anything.
export async function attachChat(nodeId: string, handlers: StreamHandlers): Promise<boolean> {
  const res = await fetch(`${API_URL}/chat/attach?node_id=${encodeURIComponent(nodeId)}`, {
    headers: { Authorization: `Bearer ${await authToken()}` },
  });

  if (res.status === 204) return false;
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data?.detail ?? res.statusText);
  }
  await consumeSSE(res, handlers);
  return true;
}

// Stops a turn in flight (streamed, non-streamed, or parked on an approval).
// Nothing is deleted — the partial reply is kept and finalises with
// status: "cancelled". 409 means there was nothing running to stop, which a
// caller can usually treat as "already finished" rather than a real error.
export async function cancelChat(nodeId: string) {
  return request<CancelChatResponse>("/chat/cancel", {
    method: "POST",
    auth: true,
    body: { node_id: nodeId },
  });
}

// Usage

export async function getUsage() {
  return request<UsageTotals>("/usage", { auth: true });
}

export async function getProjectUsage(projectId: string) {
  return request<UsageTotals>(`/projects/${projectId}/usage`, { auth: true });
}

export { ApiError };
