# Cloudy Codex bridge

The bridge runs beside local repositories and talks to `codex app-server` only through local stdio. Cloudy receives opaque workspace IDs and labels, never local paths or Codex credentials.

Requires Node.js 20+ and Codex CLI 0.144.5+ with an existing local login.

```sh
npm link
cloudy-bridge pair https://your-cloudy-api.example
cloudy-bridge add-workspace /path/to/repository
cloudy-bridge install-service
cloudy-bridge status
```

Use `cloudy-bridge run` for foreground diagnostics. `uninstall-service` removes the launchd or systemd user service; it does not delete the local bridge configuration.
