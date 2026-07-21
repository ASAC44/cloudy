export type ScreenDirection = "left" | "right" | "down";
export type ScreenLayout = Record<ScreenDirection, string[]>;
export type MascotAction = "blink" | "yawn" | "sleep" | "jump";
export type ScreenNavigation = "left" | "right" | "up" | "down" | "scroll_up" | "scroll_down";

export type ScreenItem = {
  id: string;
  name: string;
  provider: ConnectionProvider | "codex";
  status: "ready" | "disconnected" | "attention";
  detail: string;
};

export type Pod = {
  id: string;
  name: string;
  paired_at: string;
  last_seen_at: string | null;
  screen_layout: ScreenLayout;
  screen_layout_revision: number;
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
  editable_reply?: boolean;
};

export type AgentMemory = {
  id: string;
  scope: "user" | "workspace" | "provider";
  scope_id: string | null;
  provider: ConnectionProvider | null;
  memory_key: string;
  content: string;
  source: Record<string, unknown>;
  created_at: string;
  updated_at: string;
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
  personalization_enabled: boolean;
  updated_at: string;
};

export type CodexBridge = { id: string; name: string; version: string | null; last_error: string | null; paired_at: string; last_seen_at: string | null; online?: boolean };
export type CodexWorkspace = { id: string; bridge_id: string; local_id: string; label: string; available: boolean; updated_at: string };
export type CodexThread = { id: string; workspace_id: string; codex_thread_id: string; title: string; status: "idle" | "planning" | "waiting" | "implementing" | "testing" | "completed" | "error"; milestone: string; final_summary: string; last_error: string | null; updated_at: string };
export type CodexTarget = { workspace_id: string; thread_id: string | null; revision: number; updated_at: string };
export type CodexOverview = { bridges: CodexBridge[]; workspaces: CodexWorkspace[]; threads: CodexThread[]; target: CodexTarget | null; voice_ready: boolean };

export type ConnectionProvider =
  | "github"
  | "gmail"
  | "google_calendar"
  | "vercel"
  | "telegram"
  | "linear"
  | "stripe"
  | "notion"
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
  capability_safety: "verified_read" | "verified_write" | "unannotated";
  definition: Record<string, unknown>;
  context_bindings?: Array<Record<string, unknown>>;
  action?: Record<string, unknown> | null;
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
  capability_safety: "verified_read" | "verified_write" | "unannotated";
  definition: Record<string, unknown>;
  schema_version: 1 | 2;
  status: "active" | "paused" | "needs_attention";
  action_connection_id: string | null;
  action_capability_id: string | null;
  action_capability_name: string | null;
  action_capability_schema_hash: string | null;
  activated_at: string | null;
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
  runtime: null | {
    baseline_completed: boolean;
    next_run_at: string;
    consecutive_failures: number;
    schema_drift: boolean;
    last_error: string | null;
    last_run_at: string | null;
    last_event_at: string | null;
  };
};

export type TelegramAuthSession = {
  id: string;
  status: "pending_qr" | "waiting_2fa" | "connected" | "failed" | "cancelled" | "expired";
  connection_name: string;
  qr_data_url?: string | null;
  qr_expires_at: string | null;
  password_hint: string | null;
  connection_id: string | null;
  last_error: string | null;
  expires_at: string;
};

export type RuleActivity = {
  events: Array<{ id: string; status: string; occurred_at: string; resolved_at: string | null; last_error: string | null }>;
  runs: Array<{ id: string; stage: string; outcome: string; error_code: string | null; error_message: string | null; duration_ms: number | null; created_at: string }>;
  next_cursor: string | null;
};
