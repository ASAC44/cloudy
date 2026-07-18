# Podex Tech Stack

## Hardware

- Raspberry Pi Zero 2 W
- 2.8-inch touchscreen
- Approve button
- Reject button
- Microphone
- Wi-Fi
- No speaker

The exact display driver and interface depend on the selected screen controller.

## Device

- **OS:** Raspberry Pi OS Lite 64-bit
- **Language:** Python 3
- **Interface:** pygame-ce with SDL2 and FreeType text rendering
- **Display driver:** Manufacturer driver for the selected screen controller
- **Touch:** SDL2 finger events
- **Buttons:** gpiozero
- **Audio recording:** ALSA
- **Process management:** systemd
- **Communication:** HTTPS

The device runs directly into a fullscreen text interface without loading a desktop. It polls for pending requests every 2–3 seconds. Requests remain stored on the server, so temporary disconnections do not lose decisions. Realtime messaging can replace polling if latency or scale requires it.

### Device interaction

- Show the action title, source, short summary, status, and queue position first.
- Swipe up to scroll through details.
- Swipe down to return toward the summary.
- Use touch only for reading and scrolling.
- Use the physical buttons exclusively for Approve and Reject.
- Hold both buttons to record a dictated response.
- Show the next request only after the current request is resolved.

### Responsiveness

- Keep display and touch handling separate from network and microphone work.
- Pre-wrap and cache text when a request arrives.
- Redraw only changed screen regions, especially on an SPI display.
- Make scrolling follow the finger with light inertia.
- Use 150–200 ms transitions and target 30 FPS while moving.
- Show button feedback immediately, then confirm the server result.
- Cache the active request locally so reconnecting does not blank the screen.

## Website and API

- **Dashboard:** Next.js App Router
- **Backend:** Hono on Node.js
- **Language:** TypeScript
- **Styling:** Tailwind CSS
- **Dashboard hosting:** Vercel
- **Backend hosting:** One Docker-compatible service

Next.js provides the dashboard only. Hono is the single backend for device communication, OAuth callbacks, webhooks, MCP access, OpenAI calls, approval state changes, and action execution. Keep it as one service; do not split integrations into separate microservices.

## Data and Authentication

- **Database:** Supabase Postgres
- **User authentication:** Supabase Auth
- **Authorization:** Postgres Row-Level Security
- **Realtime, if needed:** Supabase Broadcast

Supabase is the canonical system of record for users, devices, integrations, pending approvals, exact action payloads, decisions, and audit logs. OAuth credentials stay server-side and are encrypted before storage.

## Context and Memory

- **Derived context engine:** Cognee
- **Purpose:** Cross-service relationships, projects, commitments, communication preferences, and similar approved decisions
- **Deployment:** Separate Python/Docker service called only by the Hono backend
- **Models:** `gpt-5-nano` and `text-embedding-3-small`

Cognee enriches decisions but is not a source of live truth. Hono reads changing facts directly from Gmail, Google Calendar, GitHub, and other connected services before each decision. Live data overrides remembered context.

Cognee does not store credentials, manage the approval queue, execute actions, or replace Supabase. Start with one Cognee deployment; add a dedicated graph database only if measured query needs require it.

## OpenAI

- **SDK:** Official OpenAI JavaScript SDK, used only by the server
- **Text API:** Responses API
- **Text model:** `gpt-5-nano`
- **Embeddings:** `text-embedding-3-small`
- **Dictation:** `gpt-4o-mini-transcribe`
- **Output format:** Structured Outputs with a strict JSON Schema

The default model converts incoming workflow data into a compact decision brief containing:

- Title
- Summary
- Details
- Affected people, services, or data
- Risk level
- Warnings
- Recommendation and reason

Use `gpt-5-nano` for decision briefs, extraction, classification, recommendations, and personalized drafts. It supports function calling and Structured Outputs while keeping latency and API cost low. Use one text model for the MVP; consider a larger model only if measured approval and correction rates show that nano is insufficient for a specific task.

The model may summarize and recommend, but it never approves or executes an action. High-risk actions rely on explicit user approval and strict validation, not a larger model.

Authoritative values such as recipients, amounts, repository names, permissions, and callback targets come from the original integration payload. AI-generated text must not replace or modify those values.

Keep the OpenAI API key on the server. The Raspberry Pi sends requests through the Podex API and never receives the key.

## Dictation

The Pi records audio while both buttons are held and uploads it to the Podex API. The server transcribes it with `gpt-4o-mini-transcribe`. The device shows the transcript for confirmation before submitting it. Use uploaded recordings for the MVP; live Realtime transcription is unnecessary for short push-to-talk responses.

## Integration Flow

1. An agent or workflow sends a decision request to the Hono API.
2. Hono preserves the original action and reads current facts from connected services.
3. Hono retrieves relevant relationships, preferences, and prior decisions from Cognee.
4. OpenAI creates a structured brief or personalized draft from both inputs.
5. Hono stores the exact request and generated brief in Supabase.
6. The keychain fetches and displays the request.
7. The user approves, rejects, or dictates a correction.
8. Hono records the decision and executes the approved action or calls the workflow callback.
9. Only the final approved or corrected outcome is added to learned context.

For n8n, the workflow sends its decision data and resume URL to Podex, then waits for Podex to return the result.

## Security

- Pair devices with a one-time code.
- Give every device a revocable, scoped token.
- Sign integration requests.
- Keep integration credentials on the server, never on the device.
- Allow each request to transition from pending only once.
- Require idempotency keys to prevent duplicate execution.
- Bind every decision to the exact action displayed.
- Record an audit log of requests, decisions, and callback results.

## Initial Architecture

```text
Next.js dashboard ───────┐
Agent / n8n / MCP ──────┼──> Hono API ──> Live service APIs
Podex device ────────────┘       |  |
                                |  └──> Cognee context
                                |
                         OpenAI + Supabase
                                |
                         Approved action only
```

Use one Hono backend, one dashboard, Supabase, and one Cognee deployment for the MVP. Do not add MQTT, Redis, a job queue, or additional services until the current design has a measured limitation.

## References

- [OpenAI model selection](https://developers.openai.com/api/docs/models)
- [GPT-5 nano](https://developers.openai.com/api/docs/models/gpt-5-nano)
- [Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Speech to text](https://developers.openai.com/api/docs/guides/speech-to-text)
- [pygame-ce touch events](https://pyga.me/docs/ref/event.html)
- [Hono on Node.js](https://hono.dev/docs/getting-started/nodejs)
- [Hono validation](https://hono.dev/docs/guides/validation)
- [Cognee architecture](https://docs.cognee.ai/core-concepts/architecture)
- [Cognee LLM providers](https://docs.cognee.ai/setup-configuration/llm-providers)
