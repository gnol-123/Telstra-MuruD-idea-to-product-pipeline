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

export interface AgentNode {
  id: string;
  project_id: string;
  name: string;
  agent_slug: string;
  tool_policy: ToolPolicy;
  // position_x/position_y
  position_x?: number;
  position_y?: number;
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
