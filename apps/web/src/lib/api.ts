import "server-only";

import { createClient } from "@/lib/supabase/server";

export type Pod = {
  id: string;
  name: string;
  paired_at: string;
  last_seen_at: string | null;
  online?: boolean;
};

export type ApprovalRequest = {
  id: string;
  title: string;
  source: string;
  summary: string;
  risk: "low" | "medium" | "high";
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  created_at: string;
  decided_at: string | null;
};

export type AutomationKey = {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export type AiSettings = {
  provider: "openai" | "cerebras" | "openrouter" | "anthropic" | "custom";
  base_url: string;
  model: string;
  has_api_key: boolean;
  updated_at: string;
};

export type ConnectionProvider =
  | "github"
  | "gmail"
  | "vercel"
  | "telegram"
  | "custom_mcp";

export type Connection = {
  id: string;
  name: string;
  provider: ConnectionProvider;
  protocol: "mcp" | "rest";
  endpoint_url: string;
  auth_type: "oauth" | "bearer" | "none";
  status: "untested" | "connected" | "failed";
  account_label: string | null;
  last_error: string | null;
  last_tested_at: string | null;
  created_at: string;
  updated_at: string;
};

export type RuleQuestion = {
  id: string;
  prompt: string;
  kind: "single_select" | "multi_select" | "text";
  options: Array<{ value: string; label: string; description: string }>;
};

export type RuleDraft = {
  title: string;
  intent_summary: string;
  source_connection_id: string;
  capability_id: string;
  capability_name: string;
  capability_schema_hash: string;
  capability_safety: "verified_read" | "unannotated";
  definition: Record<string, unknown>;
  ready: boolean;
};

export type RuleBuilderReply = {
  phase: "needs_input" | "needs_connection" | "review" | "error";
  message: string;
  questions: RuleQuestion[];
  connection_requirement: null | {
    provider: ConnectionProvider | "other";
    label: string;
    reason: string;
  };
  draft: RuleDraft;
};

export type RuleBuilderSession = {
  id: string;
  editing_rule_id: string | null;
  completed_rule_id: string | null;
  status: "open" | "completed";
  revision: number;
  expires_at: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  reply: RuleBuilderReply;
  capability_count: number;
};

export type PingRule = {
  id: string;
  destination_pod_id: string;
  source_connection_id: string;
  title: string;
  intent_summary: string;
  capability_id: string;
  capability_name: string;
  capability_schema_hash: string;
  capability_safety: "verified_read" | "unannotated";
  definition: Record<string, unknown>;
  schema_version: 1;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type PingRuleSummary = Omit<PingRule, "definition"> & {
  source: {
    name: string;
    provider: ConnectionProvider;
    account_label: string | null;
    status: "untested" | "connected" | "failed";
  };
  destination: { name: string; available: boolean };
};

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session has expired. Sign in again.");

  const response = await fetch(
    `${process.env.PODEX_API_URL ?? "http://localhost:3001"}${path}`,
    {
      ...init,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    },
  );
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Podex API request failed");
  return body as T;
}
