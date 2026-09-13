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
}

export interface Project {
  id: string;
  name: string;
  description?: string;
}

export type ToolPolicy = "ask" | "auto";
export type NodeKind = "agent" | "tool";
export type EdgeKind = "context" | "tool";
export type ToolNodeStatus = "ready" | "error" | "pending" | string;

export interface AgentNode {
  kind: "agent";
  id: string;
  project_id: string;
  name: string;
  agent_slug: string;
  tool_policy: ToolPolicy;
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

// A project's canvas holds both kinds mixed together; tell them apart by `kind`.
export type ProjectNode = AgentNode | ToolNode;

export function isAgentNode(n: ProjectNode): n is AgentNode {
  return n.kind === "agent";
}

export function isToolNode(n: ProjectNode): n is ToolNode {
  return n.kind === "tool";
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
