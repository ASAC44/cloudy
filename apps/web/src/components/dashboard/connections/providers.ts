import type { ConnectionProvider } from "@/types/api";
import type { ProviderDefinition } from "@/types/connections";

export type { ProviderDefinition } from "@/types/connections";

export const PROVIDERS: ProviderDefinition[] = [
  { key: "github", label: "GitHub", description: "Repositories, pull requests, and Actions through GitHub’s read-only MCP." },
  { key: "gmail", label: "Gmail", description: "Read mailbox context through Google OAuth with offline access." },
  { key: "vercel", label: "Vercel", description: "Verify an expiring Vercel access token against your account." },
  { key: "telegram", label: "Telegram", description: "Connect your personal account by QR, or use a BotFather bot." },
  { key: "linear", label: "Linear", description: "Watch and update issues, projects, and comments through Linear’s official MCP." },
  { key: "stripe", label: "Stripe", description: "Inspect Stripe and run approved actions with a restricted API key." },
  { key: "custom_mcp", label: "Custom MCP", description: "Connect any public HTTPS Streamable HTTP MCP endpoint." },
];

export function getProvider(provider: ConnectionProvider | null) {
  return PROVIDERS.find(({ key }) => key === provider);
}
