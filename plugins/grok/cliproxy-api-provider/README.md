# CLIProxyAPIProvider

Keeps Grok model mappings synced to a local
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (cli-proxy-api-plus)
OpenAI-compatible gateway — **without** treating `~/.grok/config.toml` as the
source of truth for model specs.

## Layout (safer split)

| Path | Role |
|------|------|
| `~/.agents/references/model-catalog.json` | **SSOT** for `contextWindow` / vendor specs (edit this) |
| `~/.agents/references/cliproxy-models.managed.toml` | Generated managed model block (do not hand-edit) |
| `~/.grok/references/*` | Symlinks → `~/.agents/references/*` |
| `~/.grok/config.user.toml` | Your real settings (ui, plugins, mcp, …) |
| `~/.grok/config.toml` | **Composed** file Grok reads: user + managed block |

Grok does **not** support TOML `include`, so `config.toml` must still contain
the `[model.*]` tables. The plugin regenerates them from the catalog + live
`/v1/models` list and injects them between markers.

## Why

When Grok is pointed at CLIProxy via `[endpoints] models_base_url`, the remote
`/v1/models` list has **no** `supports_reasoning_effort` / `context_window`
metadata. Without explicit `[model.*]` overrides, Grok treats every model as
non-reasoning (`/effort` fails) and uses the wrong auto-compact window.

Older versions wrote a huge managed block only into `config.toml` and used
hardcoded window heuristics (often wrong). Now:

1. Live model **ids** come from CLIProxy `/v1/models`
2. **`context_window`** comes from `model-catalog.json` (vendor-docs verified)
3. Output is written to `cliproxy-models.managed.toml` and composed into `config.toml`

## What it writes

### External managed file

`~/.agents/references/cliproxy-models.managed.toml`

### Inside `config.toml` (between markers)

```text
# >>> CLIProxyAPIProvider managed begin
... contents of cliproxy-models.managed.toml ...
# >>> CLIProxyAPIProvider managed end
```

For each CLIProxy model id:

| Field | Source |
|-------|--------|
| `base_url` | plugin config / `CLIPROXY_BASE_URL` |
| `env_key` | plugin config (`XAI_API_KEY`) |
| `context_window` | **`model-catalog.json`** (heuristic fallback only if missing) |
| `supports_reasoning_effort` | family rules + catalog `reasoning` |
| `reasoning_effort` / `reasoning_efforts` | family defaults |

Also sets:

- `[endpoints] models_base_url`
- `[models] default` / `web_search` / `default_reasoning_effort`
- `[subagents.models] sisyphus` pin
- `[model.grok-build]` alias → `grok-build-0.1`

## Install / enable

Plugin lives at `~/.grok/plugins/cliproxy-api-provider` (user scope, auto-trusted).

Enable in `~/.grok/config.user.toml` (preferred) or the composed `config.toml`:

```toml
[plugins]
enabled = ["lfg", "cliproxy-api-provider"]
```

Restart Grok. The SessionStart hook runs the sync.

## Manual sync

```bash
node ~/.grok/plugins/cliproxy-api-provider/scripts/sync-models.mjs --force
node ~/.grok/plugins/cliproxy-api-provider/scripts/sync-models.mjs --dry-run
```

## Config

Optional overrides (first found wins):

1. `~/.grok/plugin-data/cliproxy-api-provider/config.json`
2. `~/.grok/plugins/cliproxy-api-provider/config.json`

```json
{
  "baseUrl": "http://127.0.0.1:8317/v1"  # example,
  "defaultModel": "grok-4.5",
  "webSearch": "grok-4.20-multi-agent-0309",
  "defaultReasoningEffort": "high",
  "envKey": "XAI_API_KEY",
  "catalogPath": "~/.agents/references/model-catalog.json",
  "managedTomlPath": "~/.agents/references/cliproxy-models.managed.toml",
  "userConfigPath": "~/.grok/config.user.toml"
}
```

Env:

| Variable | Effect |
|----------|--------|
| `CLIPROXY_BASE_URL` | Override gateway base URL |
| `XAI_API_KEY` | Bearer token for CLIProxy (must match `api-keys`) |
| `GROK_CONFIG` | Alternate path to composed `config.toml` |
| `GROK_USER_CONFIG` | Alternate path to user settings TOML |
| `MODEL_CATALOG` | Alternate path to `model-catalog.json` |
| `CLIPROXY_MANAGED_TOML` | Alternate path for managed models TOML |

## Editing guide

| Want to change… | Edit… |
|-----------------|--------|
| UI / plugins / MCP | `~/.grok/config.user.toml`, then re-run sync (or restart) |
| Default model / web_search | plugin `config.json`, then `--force` sync |
| A model's true context window | `~/.agents/references/model-catalog.json`, then `--force` sync |
| Model list | live CLIProxy `/v1/models` (auto on next sync) |

**Do not** hand-edit the managed block inside `config.toml` or
`cliproxy-models.managed.toml` — the next sync overwrites them.

## Safety

- Only rewrites the managed block (+ external managed file).
- Takes a timestamped backup: `config.toml.cliproxy-backup-<iso>`.
- If CLIProxy is down, the hook **skips** (exit 0) and leaves config alone.
- Caches catalog fingerprint under `plugin-data` to avoid needless writes.
