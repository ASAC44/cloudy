# Final Deployment TODO

## Activate automation approvals

- [ ] Apply `supabase/migrations/20260719050000_automations.sql` to the production Supabase project.
- [ ] Set `PODEX_PUBLIC_API_URL` to the production HTTPS API origin.
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
