export interface User {
  id: string;
  email: string;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: User;
}

export interface AgentType {
  id: string;
  slug: string;
  name: string;
  default_presets?: string[];
}

export interface Project {
  id: string;
  name: string;
  description?: string;
}

export type ToolPolicy = "ask" | "auto";
export type NodeKind = "agent" | "tool" | "environment";
export type EdgeKind = "context" | "tool" | "environment";
export type ToolNodeStatus = "ready" | "error" | "pending" | string;
export type EnvironmentStatus = "pending" | "provisioning" | "ready" | "stopped" | "error" | string;

export interface AgentNode {
  kind: "agent";
  id: string;
  project_id: string;
  name: string;
  agent_slug: string;
  tool_policy: ToolPolicy;
  model?: string;
  position_x?: number;
  position_y?: number;
}

export interface ToolNode {
  kind: "tool";
  id: string;
  project_id: string;
  name: string;
  tool_slug: string;
  config: Record<string, unknown>;
  status: ToolNodeStatus;
  status_detail: string | null;
  secrets_set: string[];
  position_x?: number;
  position_y?: number;
}

// A "real sandbox" node: shell + filesystem + a URL for whatever gets
// served on a port. See API.md's Environments section. Every project also
// gets one automatically (role: "scratch"); ones created from the UI are
// role: "user".
export interface EnvironmentNode {
  kind: "environment";
  id: string;
  project_id: string;
  name: string;
  runtime: string; // "e2b"
  role: "user" | "scratch";
  status: EnvironmentStatus;
  status_detail: string | null;
  tool_policy: ToolPolicy;
  position_x?: number;
  position_y?: number;
  sandbox_id: string | null;
  template: string;
  idle_timeout_s: number;
  preview_ports: number[];
  description?: string | null;
}

// A project's canvas holds all three kinds mixed together; tell them apart
// by `kind`.
export type ProjectNode = AgentNode | ToolNode | EnvironmentNode;

export function isAgentNode(n: ProjectNode): n is AgentNode {
  return n.kind === "agent";
}

export function isToolNode(n: ProjectNode): n is ToolNode {
  return n.kind === "tool";
}

export function isEnvironmentNode(n: ProjectNode): n is EnvironmentNode {
  return n.kind === "environment";
}

export interface Edge {
  id: string;
  source_node_id: string;
  target_node_id: string;
  kind: EdgeKind;
  is_stale: boolean;
  messages_behind: number | null;
  summarised_through_seq: number | null;
  summary_updated_at: string | null;
}

export interface ToolTypeField {
  key: string;
  label: string;
  type: string; // "text" | "password" | ...
  required?: boolean;
  help?: string;
}

export interface ToolTypeConfigSchema {
  default_url?: string;
  fields: ToolTypeField[];
}

export type ToolAuthKind = "token" | "oauth2";

export interface ToolType {
  id: string;
  slug: string;
  name: string;
  description: string;
  config_schema: ToolTypeConfigSchema;
  secret_fields: string[];
  auth_kind: ToolAuthKind;
}

// A ready-to-instantiate tool or skill — names the tool_slug it
// instantiates and the config copied onto a node created from it.
// This is what an agent type's `default_presets` refers to by slug.
export interface ToolPreset {
  id: string;
  slug: string;
  name: string;
  description: string;
  tool_slug: string;
  config: Record<string, unknown>;
}

export type ToolCallStatus = "pending_approval" | "running" | "ok" | "error" | "denied";

export interface ToolCall {
  id: string;
  project_id: string;
  conversation_id: string;
  agent_node_id: string;
  tool_node_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  result: string | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  seq: number;
  status: "complete" | "failed" | "pending";
  created_at: string;
}

export interface ChatResponse {
  node_id: string;
  conversation_id: string;
  output: string;
  user_message: ChatMessage;
  assistant_message: ChatMessage;
}

export interface PendingToolCall {
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface ApprovalRequiredResponse {
  paused: true;
  node_id: string;
  conversation_id: string;
  pending_calls: PendingToolCall[];
}

export type SendChatResult = ChatResponse | ApprovalRequiredResponse;

export function isApprovalRequired(
  r: SendChatResult | ResumeResult
): r is ApprovalRequiredResponse {
  return (r as ApprovalRequiredResponse).paused === true;
}

export interface ResumeResponse {
  node_id: string;
  conversation_id: string;
  output: string;
  assistant_message: ChatMessage;
}

export type ResumeResult = ResumeResponse | ApprovalRequiredResponse;

// -------------------- Environments: files & preview --------------------

export interface EnvironmentFileEntry {
  name: string;
  type: "dir" | "file" | "symlink";
  path: string;
  size: number;
}

export interface EnvironmentFilesResponse {
  path: string;
  entries: EnvironmentFileEntry[];
}

export interface EnvironmentFileContent {
  path: string;
  content: string;
  truncated: boolean;
}

export interface EnvironmentPreview {
  port: number;
  url: string;
}

// -------------------- Usage --------------------

export interface UsageByModel {
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  requests: number;
  message_count: number;
}

export interface UsageTotals {
  project_id: string | null;
  by_model: UsageByModel[];
  input_tokens: number;
  output_tokens: number;
  message_count: number;
}
