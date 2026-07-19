import type { ConnectionProvider } from "@/lib/api";

export type ProviderDefinition = {
  key: ConnectionProvider;
  label: string;
  description: string;
};

export const PROVIDERS: ProviderDefinition[] = [
  { key: "github", label: "GitHub", description: "Repositories, pull requests, and Actions through GitHub’s read-only MCP." },
  { key: "gmail", label: "Gmail", description: "Read mailbox context through Google OAuth with offline access." },
  { key: "vercel", label: "Vercel", description: "Verify an expiring Vercel access token against your account." },
  { key: "telegram", label: "Telegram", description: "Connect a bot created with BotFather and verify its identity." },
  { key: "custom_mcp", label: "Custom MCP", description: "Connect any public HTTPS Streamable HTTP MCP endpoint." },
];

export function getProvider(provider: ConnectionProvider | null) {
  return PROVIDERS.find(({ key }) => key === provider);
}
