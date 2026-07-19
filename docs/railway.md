# Deploy Podex on Railway

Podex is an isolated monorepo with two Railway services. Railway uses the
`railway.json` in each app for build, start, healthcheck, and watch
settings. No Dockerfile or YAML is needed.

## Deploy from GitHub

1. Push this repository to GitHub and choose **Deploy from GitHub repo** in a
   new Railway project.
2. Accept Railway's detected `web` and `api` services. If it does not detect
   both, add the same GitHub repository twice and use the manual settings
   below.
3. Add the variables listed below, then deploy the staged changes.
4. In the `web` service, open **Settings → Networking** and select
   **Generate Domain**.
5. Configure that domain in Supabase using [auth-setup.md](./auth-setup.md).

### Manual service settings

| Service | Root directory | Railway config file |
| --- | --- | --- |
| `web` | `/apps/web` | `/apps/web/railway.json` |
| `api` | `/apps/api` | `/apps/api/railway.json` |

Railway's config-file path does not inherit the root directory, so keep the
config paths absolute as shown.

## Variables

Add these in each service's **Variables** tab. Do not commit their real values.

### `web`

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
```

### `api`

```dotenv
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SECRET_KEY=sb_secret_your_server_only_key
CONNECTION_ENCRYPTION_KEY=your-32-byte-base64-key
PODEX_PUBLIC_API_URL=https://your-api-domain.example
PODEX_WEB_URL=https://your-web-domain.example
GITHUB_CLIENT_ID=optional-github-oauth-client-id
GITHUB_CLIENT_SECRET=optional-github-oauth-client-secret
GOOGLE_CLIENT_ID=optional-google-oauth-client-id
GOOGLE_CLIENT_SECRET=optional-google-oauth-client-secret
```

Generate `CONNECTION_ENCRYPTION_KEY` once with `openssl rand -base64 32` and
retain it across deploys. GitHub and Google values are optional until those
providers are enabled.

Also set `PODEX_API_URL` on `web` to the API's public Railway domain. The
`NEXT_PUBLIC_*` values are embedded during `next build`, so redeploy `web`
after changing them. `PORT` is injected by Railway and must not be set
manually.

## Public access

The web service needs a public domain. The API only needs one when a browser,
Pod, webhook provider, or other external client must call it; generate an
API domain from its Networking settings at that point. Railway private domains
work only between services in the same project and environment.

## Verify

- Open the web domain and sign in.
- Open the API root URL, if public; it should return
  `{"name":"podex-api","status":"ok"}`.
- Check the latest deployment details: both services should report a passing
  `/` healthcheck.

Railway references: [monorepos](https://docs.railway.com/deployments/monorepo),
[config as code](https://docs.railway.com/config-as-code/reference),
[Next.js](https://docs.railway.com/guides/nextjs), and
[healthchecks](https://docs.railway.com/deployments/healthchecks).
