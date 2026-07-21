export const MOCK_NOTIFICATIONS = {
  general: {
    label: "General", source: "Cloudy monitor · Production", title: "Checkout latency crossed its SLO",
    summary: "P95 latency has stayed above 1.2 seconds for 8 minutes after the latest deploy.",
    details: "Acknowledge and assign the incident to the on-call engineer, or reject to leave it unassigned.",
    context: "production / checkout-api", risk: "medium", warnings: "Customer checkout is slower than normal.",
  },
  github: {
    label: "GitHub", source: "GitHub · cloudy/api", title: "#482 · Add payment retry backoff",
    summary: "12 checks passed and 2 reviewers approved a bounded retry change with a feature-flag rollback.",
    details: "Squash-merge feature/payment-retries into main at the reviewed commit.",
    context: "cloudy/api · feature/payment-retries → main", risk: "medium", warnings: "Monitor duplicate-charge alerts for one hour.",
  },
  deployment: {
    label: "Deployment", source: "Vercel · Production", title: "Rollback checkout-web canary",
    summary: "The new canary is returning 4.8% errors. Cloudy recommends rolling back to the last healthy deployment.",
    details: "Deployment dpl_9Qk2 reached 10% production traffic six minutes ago. Its error rate is 4.8%, compared with the 0.3% baseline, while checkout conversion is down 7%. Approve to route traffic back to healthy deployment dpl_7Xm4 and preserve the failed canary for investigation. Reject to keep the canary active without changing traffic.",
    context: "cloudy-web · production · iad1", risk: "high", warnings: "Rollback ends sessions created only on the canary build.",
  },
  gmail: {
    label: "Gmail", source: "Gmail · aniketyadav982@gmail.com", title: "Reply about tomorrow’s project review",
    summary: "Aniket asked to move tomorrow’s review to 3:30 PM; a reply and updated invite are drafted.",
    details: "Aniket is travelling from the client workshop and asked to move tomorrow’s project review from 2:00 PM to 3:30 PM. The drafted reply confirms the new time, notes that the agenda is unchanged, and says an updated calendar invite has been sent. Approve to send that exact reply and update the invite; reject to discard both without contacting Aniket.",
    context: "Thread · Tomorrow’s project review", risk: "low", warnings: "",
  },
  codex: {
    label: "Codex", source: "Codex · cloudy workspace", title: "Review plan · Workspace roles migration",
    summary: "Add admin, editor, and viewer roles with a transactional backfill, permission updates, and reversible rollback.",
    details: "Review the workspace_members backfill, RLS policy changes, API authorization updates, rollback, and concurrency checks. Approve the plan, reject it, or hold both Pod buttons to dictate a revision.",
    context: "cloudy · /repos/podex · workspace_members", risk: "medium", warnings: "Changes membership data and row-level security policies.",
  },
} as const;

export type MockNotificationType = keyof typeof MOCK_NOTIFICATIONS;
export type MockScreen = "left" | "down" | "right";
