// Typed client for the gateway's REST API. Same origin, cookie session; no tokens in JS.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (HTTP ${res.status})`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export type Role = "admin" | "member";
export type ServerStatus = "connected" | "unreachable" | "disabled" | "unknown";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface Meta {
  mcpUrl: string;
  publicUrl: string;
  chat: { enabled: boolean; model: string | null };
  storeTimezone: string;
  toolNameFormat: string;
}

export interface Server {
  id: string;
  slug: string;
  name: string;
  description: string;
  url: string;
  enabled: boolean;
  status: ServerStatus;
  statusDetail: string | null;
  lastCheckedAt: string | null;
  lastConnectedAt: string | null;
  latencyMs: number | null;
  toolCount: number;
  auth: { type: "none" | "bearer" | "header"; headerName: string | null; hasCredential: boolean };
  toolsUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema & { description?: string; enum?: unknown[]; default?: unknown }>;
  required?: string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: JsonSchema;
  [k: string]: unknown;
}

export interface ToolInfo {
  name: string;
  upstreamName: string;
  title: string | null;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean | null;
  adminOnly: boolean;
  server: { id: string; slug: string; name: string; status: ServerStatus };
}

export interface ServerDetail {
  server: Server;
  tools: Array<Omit<ToolInfo, "server">>;
}

export interface AuditItem {
  id: string;
  created_at: string;
  user_id: string | null;
  user_email: string | null;
  api_key_id: string | null;
  source: "mcp" | "chat";
  server_slug: string | null;
  tool: string;
  upstream_tool: string | null;
  duration_ms: number;
  outcome: "success" | "error" | "denied";
  error: string | null;
}

export interface Overview {
  scope: "team" | "self";
  servers: { total: number; connected: number; unreachable: number; disabled: number; unknown: number; list: Server[] };
  tools: number;
  last24h: {
    calls: number;
    failures: number;
    users: number;
    perServer: Array<{ server: string; calls: number; failures: number; avg_ms: number; p95_ms: number }>;
  };
  recentFailures: AuditItem[];
  recentCalls: AuditItem[];
}

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: "invited" | "active" | "disabled";
  created_at: string;
  last_login_at: string | null;
  invite_expires_at: string | null;
  active_keys: number;
  last_activity_at: string | null;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  user_id: string;
  user_email: string;
  user_name: string;
  created_by_email: string | null;
}

export interface ChatStep {
  tool: string;
  server: string;
  args: unknown;
  ok: boolean;
  durationMs: number;
  preview: string;
}

export interface ChatResponse {
  reply: string;
  steps: ChatStep[];
  model: string;
  toolMode: "direct" | "search";
}
