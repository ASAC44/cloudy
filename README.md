# Podex

Podex is a handheld human-in-the-loop approval system and a monorepo with
three independently managed applications:

- `apps/web`: Next.js dashboard and its own `package.json`/lockfile.
- `apps/api`: Hono API and its own `package.json`/lockfile.
- `apps/pod`: Python 3.13 Pod runtime and its own `pyproject.toml`/virtual environment.

Keeping Python beside TypeScript is normal in a monorepo. Each application
owns its dependencies and direct commands; the root scripts only coordinate
them.

## Local development

Copy the environment examples in `apps/api` and `apps/web`, then configure the
hosted Supabase development project as described in
[`docs/pod-development.md`](docs/pod-development.md).

```sh
./scripts/setup.sh
./scripts/dev.sh
```

Run all local checks with:

```sh
./scripts/check.sh
```

The optional Linux ARM64/512 MB compatibility check requires Docker:

```sh
./scripts/check-pod-arm.sh
```

For Raspberry Pi Zero 2 W provisioning and kiosk deployment, see
[`docs/pod-deployment.md`](docs/pod-deployment.md).
