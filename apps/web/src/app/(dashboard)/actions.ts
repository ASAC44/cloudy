"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { apiFetch } from "@/lib/api";
import { revalidatePath } from "next/cache";
import type {
  AutomationKey,
  Connection,
  ConnectionProvider,
  PingRule,
  RuleBuilderSession,
} from "@/lib/api";

export type ActionState = { error?: string; success?: string };

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
      }),
    });
    revalidatePath("/home");
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

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}

export type ConnectionInput = {
  provider: ConnectionProvider;
  name: string;
  endpoint_url?: string;
  auth_type?: "none" | "bearer";
  token?: string;
};

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
  provider: "github" | "gmail",
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
    revalidatePath("/automations");
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Key could not be created" };
  }
}

export async function revokeAutomationKey(id: string): Promise<{ error?: string }> {
  try {
    await apiFetch(`/v1/automation-keys/${id}`, { method: "DELETE" });
    revalidatePath("/automations");
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

function ruleError(error: unknown) {
  return { error: error instanceof Error ? error.message : "Rule request failed" };
}
