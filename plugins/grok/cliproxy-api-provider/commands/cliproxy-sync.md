---
description: Force-sync CLIProxy model mappings from model-catalog.json into managed TOML + config.toml
argument-hint: "[--force] [--dry-run]"
---

Re-sync CLIProxy (`cli-proxy-api`) model catalog into:

1. `~/.agents/references/cliproxy-models.managed.toml` (external SSOT block)
2. the managed block of `~/.grok/config.toml` (composed for Grok runtime)

`context_window` values come from `~/.agents/references/model-catalog.json`,
not from hardcoded heuristics.

Run via shell:

```bash
node "${GROK_PLUGIN_ROOT}/scripts/sync-models.mjs" --force $ARGUMENTS
```

Or without the plugin root:

```bash
node ~/.grok/plugins/cliproxy-api-provider/scripts/sync-models.mjs --force
```

Then restart Grok (or open a new session) so the catalog reloads.

Edit user settings in `~/.grok/config.user.toml` (not inside the managed block).
