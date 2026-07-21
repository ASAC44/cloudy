# Final Deployment TODO

## Verify Pi buttons and microphone steering

- [ ] Restore local DNS or use the Pi's current IP so `cloudy@cloudy.local` resolves and accepts SSH; the implementation-time probe on 2026-07-22 could not resolve the hostname.
- [ ] On the production Pi, verify each four-leg switch's internally connected pairs with a continuity meter; wire Accept to BCM GPIO5/header pin 29, Reject to BCM GPIO6/header pin 31, and both opposite pairs to GND/header pin 30 without a 3.3 V connection.
- [ ] On the production Pi Zero 2 W, wire the INMP441 left channel to 3.3 V/GND, GPIO18 SCK, GPIO19 WS, and GPIO20 SD; run `sudo sh /opt/cloudy-pod/deploy/provision-inmp441.sh --apply`, reboot when it returns status 10, and verify `arecord -l` exposes `sndrpii2scard`.
- [ ] Run `sudo sh /opt/cloudy-pod/deploy/provision-inmp441.sh --check` while speaking near the mic; confirm its mono 16 kHz/16-bit, nonzero signal, audio-group, and sub-2 MB checks pass, then listen to a sample and configure an ALSA `softvol` PCM only if measured input is too quiet.
- [ ] Reboot the Pi and verify `cloudy-pod.service` retains GPIO and audio permissions, single-button Accept/Reject taps work once, short two-button chords do nothing, and a 600 ms two-button hold records until either button is released.
- [ ] Pair a live Codex bridge, select an active conversation, dictate and approve a transcript, and verify the existing turn is steered rather than a second turn being started; repeat while idle and verify a read-only planning turn starts.

## Demo mode follow-up

- [ ] If demos need to follow a user across browsers or devices, replace the browser-local demo flag with an authenticated account preference and verify it cannot affect real automation creation.

## Complete the Cloudy production rename

- [ ] Apply `supabase/migrations/20260721000000_cloudy_rebrand.sql` on staging and production, then verify only the two `cloudy-purge-*` cron jobs remain and each still uses its original schedule and command.
- [ ] Replace every deployed `PODEX_*` environment variable with its documented `CLOUDY_*` equivalent, move Pod hosts from `/opt/podex-pod`, `/etc/podex-pod.env`, and the `podex` service account to the Cloudy paths/account, reinstall `cloudy-pod.service`, and verify API, worker, web, bridge, and Pod startup.
- [ ] Re-pair installed Codex bridges with `cloudy-bridge` after moving any needed workspace registrations out of `~/.config/podex`; remove the legacy launchd/systemd service only after the Cloudy bridge survives a restart.

## Finish SPI display and touch deployment

- [ ] Deploy the current API at a stable HTTPS URL, point the installed `/etc/cloudy-pod.env` at it, restart `cloudy-pod.service`, then reboot the Pi and verify authenticated updates resume without the development Mac running.
- [ ] Restore network access to the `minillm` Pi at `10.166.208.89`, verify the XPT2046 `T_IRQ` wire reaches GPIO17 (physical pin 11) and increments the `ads7846` interrupt counter, then sync the framebuffer/touch runtime and persist both overlays in `/boot/firmware/config.txt`.
- [ ] Launch the GitHub review demo with `/dev/fb0` and the detected ADS7846 input, calibrate swap/invert settings, and verify the cursor stays hidden while swipe-down opens details, vertical motion scrolls them, and swipe-up returns to the summary.

## Complete local verification

- [ ] Stop the active `next dev` process, run `cd apps/web && npm run build`, and verify `/home` displays the safe GitHub permission message in the production build before restarting the demo.
- [ ] After every provider smoke test below, record provider, connection mode, UTC timestamp, read result, approval result, delivery result, rejection result, and cleanup result without storing tokens or private payloads; mark a provider certified only when every applicable result is verified.

## Certify remaining connection providers

- [ ] Connect a disposable Vercel account, verify project discovery and read-only polling, and record that no Vercel write action is currently exposed.
- [ ] Connect a disposable public HTTPS Custom MCP exposing one annotated read and one non-destructive write; verify discovery, private-host rejection, Pod approval binding, duplicate suppression, one exact approved write, and cleanup of the test resource.

## Activate shared agent memory

- [ ] Apply `supabase/migrations/20260720020000_agent_memories.sql` before deploying the matching API build; verify authenticated memory create, list, scoped retrieval, soft-delete, and cross-owner isolation, then test `supabase/rollback/20260720020000_agent_memories.sql` on a disposable database.
- [ ] After the base memory migration, apply `supabase/migrations/20260720050000_reply_personalization.sql` before deploying the matching API, web, and Pod builds; verify preference/sample CRUD, disable/enable behavior, connection-scoped retrieval, concurrent correction conflict handling, stale Pod hash rejection, revised exact-reply delivery once, and cross-owner isolation, then test `supabase/rollback/20260720050000_reply_personalization.sql` on a disposable database.
- [ ] On a machine with Docker and the Supabase CLI, run `./scripts/local.sh --reset`; verify all tracked migrations apply, create a local user and memory, restart with `./scripts/local.sh`, and confirm the local data remains available.

## Activate Pod screen layout sync

- [ ] Apply `supabase/migrations/20260720010000_pod_screen_layout.sql` before deploying the matching API, web, and Pod builds; verify existing Pods receive the default layout and retain pairing.
- [ ] Before applying `supabase/migrations/20260720030000_single_feed_screens.sql`, export any screen containing multiple feeds because the migration intentionally keeps only the first feed in each slot; deploy the API, web, and Pod builds together, then verify Screen 2 is default, incoming notifications open their assigned screen, and swipe-down/up moves between summary/details.
- [ ] Run `supabase/rollback/20260720030000_single_feed_screens.sql` on a disposable database and verify it safely widens each screen back to six feeds; note that rollback cannot reconstruct assignments trimmed during the forward migration.
- [ ] Apply `supabase/migrations/20260721020000_multi_feed_screens.sql` with the matching API, web, and Pod builds; attach GitHub and Gmail to one screen, verify both route there without grouping, then verify every screen without an active Ping shows Cloudy's ambient animation immediately.
- [ ] Run `supabase/rollback/20260721020000_multi_feed_screens.sql` on a disposable database; verify it refuses while any screen has multiple feeds, then reduce every screen to one feed or fewer and verify rollback succeeds without data loss.
- [ ] If `apps/api/.state/cloudy.sqlite` contains customized local layouts, record them before applying the migration, re-save them from the dashboard afterward, and verify the revision starts from the persisted Supabase value.
- [ ] Preserve the current local Pod `e86a829d-37f8-487e-ae43-7fb1c7ba70ea` revision-3 legacy layout before its first directional save, then verify it starts from the GitHub-left, Gmail-right, Codex-down default without losing pairing.
- [ ] Attach and reorder apps across Swipe left, Swipe right, and Swipe down in staging; verify autosave survives reload, then confirm the paired Pod applies each layout within one polling interval and rejects a stale revision without overwriting newer changes.
- [ ] On Raspberry Pi hardware, choose and wire a display-overlay `led_pin` that does not conflict with the INMP441 GPIOs, verify the driver exposes `/sys/class/backlight/<device>`, grant `cloudy-pod.service` write access, set `CLOUDY_BACKLIGHT`, and verify physical brightness plus ALSA `Master` volume persist after reboot.
- [ ] Run `supabase/rollback/20260720010000_pod_screen_layout.sql` on a disposable database and verify the previous API build can still list, poll, and revoke Pods.

## Activate Linear and Stripe MCP connections

- [ ] Apply `supabase/migrations/20260720000000_linear_stripe_connections.sql` on staging before deploying the matching API build; verify existing provider connections remain readable.
- [ ] Connect a disposable Linear workspace key and a restricted Stripe sandbox key, verify tool discovery and a read-only Ping, then approve one reversible write from each provider and confirm the exact payload executes once.
- [ ] Attempt `supabase/rollback/20260720000000_linear_stripe_connections.sql` while a Linear or Stripe connection exists and verify it refuses without changing data; remove the disposable connections and verify rollback succeeds.

## Activate Google Calendar connections

- [ ] Enable the Google Calendar API, add `/v1/connections/oauth/google_calendar/callback` to the production Google OAuth client, and approve `calendar.events` plus `calendar.calendarlist.readonly` on the consent screen.
- [ ] Apply `supabase/migrations/20260720040000_google_calendar_connections.sql` before deploying the matching API, web, worker, and Pod builds; connect a disposable calendar and verify bounded event reads, one approved event creation, and one etag-guarded update.
- [ ] Verify a rejected approval creates no event, a stale etag cannot overwrite a changed event, and rollback refuses while a Calendar connection, memory, OAuth state, or Pod screen assignment remains.
- [ ] After deployment, run a disposable Gmail meeting-request workflow with complete dates and duration, a conflicting Calendar event, missing scheduling details, rejected approval, expired approval, and one approved exact reply; verify three real conflict-free slots are proposed and no unapproved or duplicate Gmail send occurs.

## Activate Gmail reply approvals

- [ ] Reconnect one disposable Gmail demo account with the new `gmail.send` scope, then verify a hash-bound `email_reply_v1` approval sends the exact reply once while reject, expiry, payload changes, and ambiguous delivery send nothing.

## Activate Telegram bot webhooks

- [ ] Add a Telegram application ID and hash from `my.telegram.org` to `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in `apps/api/.env`, restart `./start.sh`, then connect a disposable personal account and verify QR login plus one generated-response approval. The narrow SQLite fallback does not store Telegram connections, so this test also needs the configured Supabase project and migrations.
- [ ] Deploy the matching API before retesting every existing Telegram bot connection so `setWebhook` points to the production `PODEX_PUBLIC_API_URL`; send duplicate webhook deliveries and verify one rule event, reject one reply, approve one reply, then disconnect the bot and confirm `deleteWebhook` succeeds.
- [ ] In staging, send a multi-turn Telegram DM, approve one reply, restart the API, and verify the next draft uses the prior delivered exchange; reject a draft and verify its text is excluded, then verify a second chat cannot see the first chat's context.

## Deploy Codex bridge schema safely

- [ ] Apply `supabase/migrations/20260719070000_codex_sessions.sql` on staging before deploying the Codex bridge API.
- [ ] Verify cross-owner workspace/thread IDs are rejected and a failed bridge sync leaves no partial snapshot.
- [ ] Run `supabase/rollback/20260719070000_codex_sessions.sql` on a disposable database, then verify ordinary Pod approvals still resolve and expire correctly.
- [ ] Install the bridge user service on one macOS and one Linux staging machine, pair each bridge, add a disposable repository, and verify restart recovery plus mode-`0600` config permissions.
- [ ] Configure the production dashboard AI settings with the official `https://api.openai.com/v1` endpoint and an encrypted OpenAI key before enabling Pod voice.
- [ ] Run the opt-in real Codex smoke flow in a disposable repository: dictate → revise plan → approve → approve a scoped permission → verify final summary and repository changes.

## Apply atomic connection writes

- [ ] Apply `supabase/migrations/20260719060000_atomic_connection_writes.sql` before deploying the matching API build.
- [ ] On staging, force failures during connection creation, update, and OAuth credential refresh; verify each transaction rolls back both `connections` and `connection_secrets`.
- [ ] Run the rollback migration on a disposable database and verify the prior API build still handles connection create, update, and test operations.

## Activate automation approvals

- [ ] Apply `supabase/migrations/20260719050000_automations.sql` to the production Supabase project.
- [ ] Set `CLOUDY_PUBLIC_API_URL` to the production HTTPS API origin.
- [ ] Restart the API and web dashboard after the migration and environment changes, and deploy the dedicated Railway `worker` service from `/apps/api/railway.worker.json` with the same Supabase and encryption variables as the API.
- [ ] Import `/examples/cloudy-n8n-approval.json` into the target n8n instance and configure a public HTTPS `WEBHOOK_URL` plus `N8N_PROXY_HOPS=1` on every execution process; private and localhost callback URLs are intentionally rejected.
- [ ] Run the imported workflow through a live create → Pod decision → callback resume test and verify approved reaches only the approved branch while rejected, expired, cancelled, and Wait timeout reach only the safe-stop branch.

## Conditional automation extensions

- [ ] Add signed callbacks or configurable callback authentication before integrations that cannot treat the callback URL as a bearer secret.
- [ ] Add MCP approval tools and provider-specific SDKs only when a real consumer requires them.

## Activate Notion MCP

- [ ] Create a public Notion OAuth connection and configure `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET` in the API environment.
- [ ] Register `${PODEX_PUBLIC_API_URL}/v1/connections/oauth/notion/callback` as an allowed Notion OAuth redirect URI.
- [ ] Apply `supabase/migrations/20260721000000_notion_connections.sql` before deploying the matching API build.
- [ ] Connect a staging Notion workspace, verify tool discovery and workspace labeling, then approve one read and one write action through the Pod.
- [ ] Verify production Notion OAuth, token refresh/reconnection, screen assignment, and rollback safety before marking this section complete.

## Activate GitHub PR approval and merge

- [ ] Apply `supabase/migrations/20260719080000_dynamic_ping_engine.sql` on staging before starting the API runtime; verify `next_attempt_at` claim ordering and run `supabase/rollback/20260719080000_dynamic_ping_engine.sql` on a disposable database.
- [ ] Deploy one guarded `apps/api` Hono process with `CLOUDY_WORKER_ID`, the production Supabase credentials, connection encryption key, public API URL, and web URL; Telegram credentials are optional for GitHub-only deployments.
- [ ] Reconnect a staging GitHub OAuth account with repository access and Contents write permission, then confirm repository discovery is limited to repositories that account can access.
- [ ] In a disposable GitHub repository, activate a rule over one repository, let the first poll establish its baseline, then push a new commit and verify the ready PR appears on its assigned Pod screen within the next 60-second poll.
- [ ] Push a new commit while its earlier approval is pending; verify the old request becomes superseded and the new head SHA creates exactly one new approval.
- [ ] Approve the replacement request on the Pod and verify rule activity first shows “merge queued,” then confirms only the reviewed SHA was merged with the selected squash/rebase/merge method.
- [ ] Remove merge permission and separately simulate an uncertain GitHub response; verify permission failures mark the rule Needs attention and ambiguous outcomes pause it without issuing a second merge.
- [ ] Verify production logs, traces, and error reporting never contain OAuth tokens, PR source patches, encrypted presentation payloads, or GitHub response bodies.
