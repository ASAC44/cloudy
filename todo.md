# Final Deployment TODO

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

## Activate shared agent memory

- [ ] Apply `supabase/migrations/20260720020000_agent_memories.sql` before deploying the matching API build; verify authenticated memory create, list, scoped retrieval, soft-delete, and cross-owner isolation, then test `supabase/rollback/20260720020000_agent_memories.sql` on a disposable database.

## Activate Pod screen layout sync

- [ ] Apply `supabase/migrations/20260720010000_pod_screen_layout.sql` before deploying the matching API, web, and Pod builds; verify existing Pods receive the default layout and retain pairing.
- [ ] Before applying `supabase/migrations/20260720030000_single_feed_screens.sql`, export any screen containing multiple feeds because the migration intentionally keeps only the first feed in each slot; deploy the API, web, and Pod builds together, then verify Screen 2 is default, incoming notifications open their assigned screen, and swipe-down/up moves between summary/details.
- [ ] Run `supabase/rollback/20260720030000_single_feed_screens.sql` on a disposable database and verify it safely widens each screen back to six feeds; note that rollback cannot reconstruct assignments trimmed during the forward migration.
- [ ] Apply `supabase/migrations/20260721020000_multi_feed_screens.sql` with the matching API, web, and Pod builds; attach GitHub and Gmail to one screen, verify both route there without grouping, then verify every screen without an active Ping shows Cloudy's ambient animation immediately.
- [ ] Run `supabase/rollback/20260721020000_multi_feed_screens.sql` on a disposable database; verify it refuses while any screen has multiple feeds, then reduce every screen to one feed or fewer and verify rollback succeeds without data loss.
- [ ] If `apps/api/.state/cloudy.sqlite` contains customized local layouts, record them before applying the migration, re-save them from the dashboard afterward, and verify the revision starts from the persisted Supabase value.
- [ ] Preserve the current local Pod `e86a829d-37f8-487e-ae43-7fb1c7ba70ea` revision-3 legacy layout before its first directional save, then verify it starts from the GitHub-left, Gmail-right, Codex-down default without losing pairing.
- [ ] Attach and reorder apps across Swipe left, Swipe right, and Swipe down in staging; verify autosave survives reload, then confirm the paired Pod applies each layout within one polling interval and rejects a stale revision without overwriting newer changes.
- [ ] On Raspberry Pi hardware, replace Quick Settings software dimming with the approved display-backlight control and verify ALSA `Master` volume changes plus local persistence after reboot; add restart and unpair actions only with confirmation and recovery testing.
- [ ] Run `supabase/rollback/20260720010000_pod_screen_layout.sql` on a disposable database and verify the previous API build can still list, poll, and revoke Pods.

## Activate Linear and Stripe MCP connections

- [ ] Apply `supabase/migrations/20260720000000_linear_stripe_connections.sql` on staging before deploying the matching API build; verify existing provider connections remain readable.
- [ ] Connect a disposable Linear workspace key and a restricted Stripe sandbox key, verify tool discovery and a read-only Ping, then approve one reversible write from each provider and confirm the exact payload executes once.
- [ ] Attempt `supabase/rollback/20260720000000_linear_stripe_connections.sql` while a Linear or Stripe connection exists and verify it refuses without changing data; remove the disposable connections and verify rollback succeeds.

## Activate Gmail reply approvals

- [ ] Reconnect one disposable Gmail demo account with the new `gmail.send` scope, then verify a hash-bound `email_reply_v1` approval sends the exact reply once while reject, expiry, payload changes, and ambiguous delivery send nothing.

## Deploy Codex bridge schema safely

- [ ] Apply `supabase/migrations/20260719070000_codex_sessions.sql` on staging before deploying the Codex bridge API.
- [ ] Verify cross-owner workspace/thread IDs are rejected and a failed bridge sync leaves no partial snapshot.
- [ ] Run `supabase/rollback/20260719070000_codex_sessions.sql` on a disposable database, then verify ordinary Pod approvals still resolve and expire correctly.
- [ ] Install the bridge user service on one macOS and one Linux staging machine, pair each bridge, add a disposable repository, and verify restart recovery plus mode-`0600` config permissions.
- [ ] Configure the production dashboard AI settings with the official `https://api.openai.com/v1` endpoint and an encrypted OpenAI key before enabling Pod voice.
- [ ] Install and verify `arecord` on the production Pod, then confirm its microphone produces mono 16 kHz/16-bit PCM WAV recordings under the 2 MB limit.
- [ ] Run the opt-in real Codex smoke flow in a disposable repository: dictate → revise plan → approve → approve a scoped permission → verify final summary and repository changes.

## Apply atomic connection writes

- [ ] Apply `supabase/migrations/20260719060000_atomic_connection_writes.sql` before deploying the matching API build.
- [ ] On staging, force failures during connection creation, update, and OAuth credential refresh; verify each transaction rolls back both `connections` and `connection_secrets`.
- [ ] Run the rollback migration on a disposable database and verify the prior API build still handles connection create, update, and test operations.

## Activate automation approvals

- [ ] Apply `supabase/migrations/20260719050000_automations.sql` to the production Supabase project.
- [ ] Set `CLOUDY_PUBLIC_API_URL` to the production HTTPS API origin.
- [ ] Restart the API and web dashboard after the migration and environment changes.
- [ ] Configure n8n with a public HTTPS `WEBHOOK_URL`; private and localhost callback URLs are intentionally rejected.
- [ ] Run a live create → Pod decision → callback resume test and verify approved, rejected, expired, and cancelled outcomes.

## General automation support

- [ ] Replace the n8n-only setup copy with generic API documentation plus an n8n recipe.
- [ ] Publish examples for Zapier and Make.
- [ ] Publish examples for CI/CD pipelines and GitHub Actions.
- [ ] Publish Python, JavaScript, and shell examples for internal tools and custom applications.
- [ ] Publish an AI-agent approval example.
- [ ] Publish a deployment/infrastructure approval example.
- [ ] Add signed callbacks or configurable callback authentication before integrations that cannot treat the callback URL as a bearer secret.
- [ ] Add MCP approval tools and provider-specific SDKs only when a real consumer requires them.

## Activate GitHub PR approval and merge

- [ ] Apply `supabase/migrations/20260719080000_dynamic_ping_engine.sql` on staging before starting the API runtime; verify `next_attempt_at` claim ordering and run `supabase/rollback/20260719080000_dynamic_ping_engine.sql` on a disposable database.
- [ ] Deploy one guarded `apps/api` Hono process with `CLOUDY_WORKER_ID`, the production Supabase credentials, connection encryption key, public API URL, and web URL; Telegram credentials are optional for GitHub-only deployments.
- [ ] Reconnect a staging GitHub OAuth account with repository access and Contents write permission, then confirm repository discovery is limited to repositories that account can access.
- [ ] In a disposable GitHub repository, activate a rule over one repository and verify an already-ready PR appears on the Pod within the first 60-second poll.
- [ ] Push a new commit while its earlier approval is pending; verify the old request becomes superseded and the new head SHA creates exactly one new approval.
- [ ] Approve the replacement request on the Pod and verify rule activity first shows “merge queued,” then confirms only the reviewed SHA was merged with the selected squash/rebase/merge method.
- [ ] Remove merge permission and separately simulate an uncertain GitHub response; verify permission failures mark the rule Needs attention and ambiguous outcomes pause it without issuing a second merge.
- [ ] Verify production logs, traces, and error reporting never contain OAuth tokens, PR source patches, encrypted presentation payloads, or GitHub response bodies.
