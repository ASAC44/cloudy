"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { apiFetch } from "@/lib/api";
import { revalidatePath } from "next/cache";
import type {
  AgentMemory,
  AutomationKey,
  Connection,
  PingRule,
  RuleActivity,
  RuleBuilderSession,
  TelegramAuthSession,
  CodexTarget,
  ScreenLayout,
  MascotAction,
  ScreenNavigation,
} from "@/types/api";
import type { ActionState, ConnectionInput } from "@/types/actions";

export type { ActionState, ConnectionInput } from "@/types/actions";

function value(formData: FormData, name: string) {
  return String(formData.get(name) ?? "").trim();
}

export async function claimPod(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await apiFetch("/v1/pods/claim", {
      method: "POST",
      body: JSON.stringify({
        code: value(formData, "code").toUpperCase(),
        name: value(formData, "name"),
      }),
    });
    revalidatePath("/home");
    return { success: "Pod paired." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Pairing failed" };
  }
}

export async function createPing(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const title = value(formData, "title");
    await apiFetch("/v1/requests", {
      method: "POST",
      body: JSON.stringify({
        title,
        source: value(formData, "source"),
        summary: value(formData, "summary") || title,
        details: value(formData, "details"),
        affected_context: value(formData, "affected_context"),
        risk: value(formData, "risk"),
        warnings: value(formData, "warnings")
          .split("\n")
          .map((warning) => warning.trim())
          .filter(Boolean),
        expires_in_minutes: Number(value(formData, "expires_in_minutes")),
        mock_type: value(formData, "mock_type") || undefined,
        screen: value(formData, "screen") || undefined,
      }),
    });
    revalidatePath("/home");
    revalidatePath("/demo");
    return { success: "Test Ping sent." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Ping failed" };
  }
}

export async function revokePod(formData: FormData) {
  const id = value(formData, "pod_id");
  if (!id) return;
  await apiFetch(`/v1/pods/${id}`, { method: "DELETE" });
  revalidatePath("/home");
  revalidatePath("/logs");
}

export async function savePodScreenLayout(
  podId: string,
  layout: ScreenLayout,
  revision: number,
): Promise<{ revision?: number; error?: string }> {
  try {
    const result = await apiFetch<{ screen_layout_revision: number }>(
      `/v1/pods/${podId}/screen-layout`,
      { method: "PUT", body: JSON.stringify({ layout, revision }) },
    );
    return { revision: result.screen_layout_revision };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Screen layout could not be saved" };
  }
}

export async function playMascotAction(
  podId: string,
  action: MascotAction,
): Promise<{ success?: string; error?: string }> {
  try {
    await apiFetch(`/v1/pods/${podId}/mascot-action`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    return { success: `${action[0].toUpperCase()}${action.slice(1)} queued.` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Animation could not be sent" };
  }
}

export async function navigatePodScreen(
  podId: string,
  direction: ScreenNavigation,
): Promise<{ success?: string; error?: string }> {
  try {
    await apiFetch(`/v1/pods/${podId}/screen-navigation`, {
      method: "POST",
      body: JSON.stringify({ direction }),
    });
    const messages: Record<ScreenNavigation, string> = {
      left: "Moved to the previous screen.",
      right: "Moved to the next screen.",
      up: "Opened notification details.",
      down: "Returned to the notification summary.",
      scroll_up: "Scrolled details up.",
      scroll_down: "Scrolled details down.",
    };
    return { success: messages[direction] };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Screen navigation failed" };
  }
}

export async function decidePendingPing(
  requestId: string,
  outcome: "approved" | "rejected",
): Promise<{ success?: string; error?: string }> {
  try {
    await apiFetch(`/v1/requests/${requestId}/decision`, {
      method: "POST",
      body: JSON.stringify({ outcome, idempotency_key: randomUUID() }),
    });
    revalidatePath("/home");
    revalidatePath("/demo");
    revalidatePath("/logs");
    return { success: outcome === "approved" ? "Ping approved." : "Ping rejected." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Ping decision failed" };
  }
}

export async function claimCodexBridge(_previous: ActionState, formData: FormData): Promise<ActionState> {
  try {
    await apiFetch("/v1/codex/bridges/claim", { method: "POST", body: JSON.stringify({ code: value(formData, "code").toUpperCase(), name: value(formData, "name") }) });
    revalidatePath("/codex");
    return { success: "Codex bridge connected." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Bridge pairing failed" };
  }
}

export async function revokeCodexBridge(id: string) {
  try {
    await apiFetch(`/v1/codex/bridges/${id}`, { method: "DELETE" });
    revalidatePath("/codex");
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Bridge could not be revoked" };
  }
}

export async function selectCodexTarget(input: { workspaceId: string; threadId: string | null; revision: number | null }): Promise<{ target?: CodexTarget; error?: string }> {
  try {
    const result = await apiFetch<{ target: CodexTarget }>("/v1/codex/target", { method: "PUT", body: JSON.stringify({ workspace_id: input.workspaceId, thread_id: input.threadId, revision: input.revision }) });
    revalidatePath("/codex");
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Target could not be changed" };
  }
}

export async function createCodexSession(workspaceId: string) {
  try {
    await apiFetch("/v1/codex/sessions", { method: "POST", body: JSON.stringify({ workspace_id: workspaceId }) });
    revalidatePath("/codex");
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Session could not be created" };
  }
}

export async function saveAiSettings(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await apiFetch("/v1/settings/ai", {
      method: "PUT",
      body: JSON.stringify({
        provider: value(formData, "provider"),
        base_url: value(formData, "base_url"),
        model: value(formData, "model"),
        api_key: value(formData, "api_key"),
      }),
    });
    if (value(formData, "intent") === "test") {
      await apiFetch("/v1/settings/ai/test", { method: "POST" });
    }
    revalidatePath("/settings");
    return {
      success: value(formData, "intent") === "test"
        ? "AI provider connected."
        : "AI provider settings saved.",
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Settings could not be saved",
    };
  }
}

export async function setPersonalization(enabled: boolean): Promise<{ error?: string }> {
  try {
    await apiFetch("/v1/settings/personalization", { method: "PUT", body: JSON.stringify({ enabled }) });
    revalidatePath("/configure");
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Personalization could not be updated" };
  }
}

export async function saveMemory(input: { memoryKey?: string; content: string; kind: "preference" | "writing_sample" }): Promise<{ memory?: AgentMemory; error?: string }> {
  try {
    const result = await apiFetch<{ memory: AgentMemory }>("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        scope: "user",
        memory_key: input.memoryKey ?? `${input.kind}:${crypto.randomUUID()}`,
        content: input.content,
        source: { kind: input.kind },
      }),
    });
    revalidatePath("/configure");
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Memory could not be saved" };
  }
}

export async function deleteMemory(id: string): Promise<{ error?: string }> {
  try {
    await apiFetch(`/v1/memories/${id}`, { method: "DELETE" });
    revalidatePath("/configure");
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Memory could not be deleted" };
  }
}

export async function getEditableReply(id: string): Promise<{ reply?: string; payload_hash?: string; error?: string }> {
  try {
    return await apiFetch(`/v1/requests/${id}/reply`);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Reply could not be loaded" };
  }
}

export async function reviseReply(id: string, reply: string, expectedPayloadHash: string): Promise<{ payload_hash?: string; error?: string }> {
  try {
    const result = await apiFetch<{ payload_hash: string }>(`/v1/requests/${id}/reply`, {
      method: "PUT",
      body: JSON.stringify({ reply, expected_payload_hash: expectedPayloadHash }),
    });
    revalidatePath("/home");
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Reply could not be revised" };
  }
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}

type ConnectionResult = { connection?: Connection; error?: string };

export async function saveConnection(input: ConnectionInput): Promise<ConnectionResult> {
  try {
    const result = await apiFetch<{ connection: Connection }>("/v1/connections", {
      method: "POST",
      body: JSON.stringify(input),
    });
    revalidatePath("/connections");
    return result;
  } catch (error) {
    return connectionError(error);
  }
}

export async function editConnection(
  id: string,
  changes: Omit<ConnectionInput, "provider">,
): Promise<ConnectionResult> {
  try {
    const result = await apiFetch<{ connection: Connection }>(`/v1/connections/${id}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
    revalidatePath("/connections");
    return result;
  } catch (error) {
    return connectionError(error);
  }
}

export async function testConnection(id: string): Promise<ConnectionResult> {
  try {
    const result = await apiFetch<{ connection: Connection }>(`/v1/connections/${id}/test`, {
      method: "POST",
    });
    revalidatePath("/connections");
    return result;
  } catch (error) {
    return connectionError(error);
  }
}

export async function removeConnection(id: string): Promise<{ error?: string }> {
  try {
    await apiFetch(`/v1/connections/${id}`, { method: "DELETE" });
    revalidatePath("/connections");
    return {};
  } catch (error) {
    return connectionError(error);
  }
}

export async function startConnectionOAuth(
  provider: "github" | "gmail" | "google_calendar" | "notion",
  name: string,
  connectionId?: string,
): Promise<{ authorization_url?: string; error?: string }> {
  try {
    return await apiFetch(`/v1/connections/oauth/${provider}/start`, {
      method: "POST",
      body: JSON.stringify({ name, connection_id: connectionId }),
    });
  } catch (error) {
    return connectionError(error);
  }
}

function connectionError(error: unknown) {
  return { error: error instanceof Error ? error.message : "Connection request failed" };
}

export async function createAutomationKey(
  name: string,
): Promise<{ key?: AutomationKey; token?: string; error?: string }> {
  try {
    const result = await apiFetch<{ key: AutomationKey; token: string }>("/v1/automation-keys", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() }),
    });
    revalidatePath("/automations/n8n");
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Key could not be created" };
  }
}

export async function revokeAutomationKey(id: string): Promise<{ error?: string }> {
  try {
    await apiFetch(`/v1/automation-keys/${id}`, { method: "DELETE" });
    revalidatePath("/automations/n8n");
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Key could not be revoked" };
  }
}

type RuleSessionResult = { session?: RuleBuilderSession; error?: string };

export async function createRuleBuilderSession(ruleId?: string): Promise<RuleSessionResult> {
  try {
    return await apiFetch<{ session: RuleBuilderSession }>("/v1/rule-builder/sessions", {
      method: "POST",
      body: JSON.stringify(ruleId ? { rule_id: ruleId } : {}),
    });
  } catch (error) {
    return ruleError(error);
  }
}

export async function getRuleBuilderSession(sessionId: string): Promise<RuleSessionResult> {
  try {
    return await apiFetch<{ session: RuleBuilderSession }>(`/v1/rule-builder/sessions/${sessionId}`);
  } catch (error) {
    return ruleError(error);
  }
}

export async function sendRuleBuilderTurn(input: {
  sessionId: string;
  revision: number;
  message?: string;
  answers?: Array<{ question_id: string; value: string | string[] }>;
}): Promise<RuleSessionResult> {
  try {
    return await apiFetch<{ session: RuleBuilderSession }>(
      `/v1/rule-builder/sessions/${input.sessionId}/turns`,
      {
        method: "POST",
        body: JSON.stringify({ revision: input.revision, message: input.message, answers: input.answers }),
      },
    );
  } catch (error) {
    return ruleError(error);
  }
}

export async function commitRuleBuilderSession(
  sessionId: string,
  revision: number,
): Promise<{ committed?: boolean; rule?: PingRule; session?: RuleBuilderSession; error?: string }> {
  try {
    const result = await apiFetch<{
      committed: boolean;
      rule?: PingRule;
      session?: RuleBuilderSession;
    }>(`/v1/rule-builder/sessions/${sessionId}/commit`, {
      method: "POST",
      body: JSON.stringify({ revision }),
    });
    if (result.committed) {
      revalidatePath("/home");
      revalidatePath("/configure");
    }
    return result;
  } catch (error) {
    return ruleError(error);
  }
}

export async function deletePingRule(ruleId: string): Promise<{ error?: string }> {
  try {
    await apiFetch(`/v1/rules/${ruleId}`, { method: "DELETE" });
    revalidatePath("/configure");
    return {};
  } catch (error) {
    return ruleError(error);
  }
}

export async function updatePingRuleStatus(
  ruleId: string,
  expectedRevision: number,
  status: "active" | "paused",
): Promise<{ rule?: PingRule; error?: string }> {
  try {
    const result = await apiFetch<{ rule: PingRule }>(`/v1/rules/${ruleId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ expected_revision: expectedRevision, status }),
    });
    revalidatePath("/configure");
    revalidatePath("/home");
    return result;
  } catch (error) {
    return ruleError(error);
  }
}

export async function getPingRuleActivity(ruleId: string, cursor?: string): Promise<{ activity?: RuleActivity; error?: string }> {
  try {
    return { activity: await apiFetch<RuleActivity>(`/v1/rules/${ruleId}/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`) };
  } catch (error) {
    return ruleError(error);
  }
}

export async function beginTelegramUserAuth(name: string): Promise<{ session?: TelegramAuthSession; error?: string }> {
  try {
    return await apiFetch<{ session: TelegramAuthSession }>("/v1/connections/telegram/user-auth", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  } catch (error) {
    return ruleError(error);
  }
}

export async function getTelegramUserAuth(id: string): Promise<{ session?: TelegramAuthSession; error?: string }> {
  try {
    return await apiFetch<{ session: TelegramAuthSession }>(`/v1/connections/telegram/user-auth/${id}`);
  } catch (error) {
    return ruleError(error);
  }
}

export async function submitTelegramUserPassword(id: string, password: string): Promise<{ accepted?: boolean; error?: string }> {
  try {
    return await apiFetch<{ accepted: boolean }>(`/v1/connections/telegram/user-auth/${id}/password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  } catch (error) {
    return ruleError(error);
  }
}

export async function cancelTelegramUserAuth(id: string): Promise<{ error?: string }> {
  try {
    await apiFetch(`/v1/connections/telegram/user-auth/${id}`, { method: "DELETE" });
    return {};
  } catch (error) {
    return ruleError(error);
  }
}

function ruleError(error: unknown) {
  return { error: error instanceof Error ? error.message : "Rule request failed" };
}
