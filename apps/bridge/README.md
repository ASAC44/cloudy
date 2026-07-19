# Podex Codex bridge

The bridge runs beside local repositories and talks to `codex app-server` only through local stdio. Podex receives opaque workspace IDs and labels, never local paths or Codex credentials.

Requires Node.js 20+ and Codex CLI 0.144.5+ with an existing local login.

```sh
npm link
podex-bridge pair https://your-podex-api.example
podex-bridge add-workspace /path/to/repository
podex-bridge install-service
podex-bridge status
```

Use `podex-bridge run` for foreground diagnostics. `uninstall-service` removes the launchd or systemd user service; it does not delete the local bridge configuration.
