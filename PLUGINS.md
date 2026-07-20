# Dual host: pi + Grok (rust agent)

This repo ships **one catalog SSOT** and **two runtimes**:

| Surface | Artifact | Install |
|---------|----------|---------|
| **pi** (TS coding-agent) | `index.ts` extension | `pi install .` or `./scripts/install-all.sh` |
| **Grok** (rust `grok` CLI / pi-agent) | `plugins/grok/cliproxy-api-provider` | `grok plugin install ./plugins/grok/cliproxy-api-provider` or `./scripts/install-all.sh` |

## Shared SSOT

- `~/.agents/references/model-catalog.json` — context windows, reasoning, modalities
  (also at `~/.grok/references/model-catalog.json` via symlink)
- Live model **ids** always come from CLIProxy `/v1/models`

## pi path

Registers a single `cliproxy` provider (openai-completions + `/v1`) via `registerProvider`,
using `MODEL_METADATA` mirrored from the catalog.

```bash
pi install .
pi --list-models grok-4.5
pi --provider cliproxy --model grok-4.5
pi --provider cliproxy --model glm-5.2
pi --provider cliproxy --model kimi-k3
```

## Grok path

Plugin writes managed `[model.*]` tables into `~/.grok/config.toml` from the catalog
so reasoning effort + context windows work when `[endpoints] models_base_url` points at CLIProxy.

```bash
grok plugin install ./plugins/grok/cliproxy-api-provider
# ensure enabled in ~/.grok/config.user.toml:
#   [plugins]
#   enabled = ["lfg", "cliproxy-api-provider"]
node ./plugins/grok/cliproxy-api-provider/scripts/sync-models.mjs --force
```

Slash command inside Grok: `/cliproxy-sync`

## One-shot

```bash
./scripts/install-all.sh
```
