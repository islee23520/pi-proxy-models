# pi-proxy-models

A [pi-coding-agent](https://github.com/badlogic/pi-mono) extension that exposes
[CLIProxyAPIPlus](https://github.com/router-for-me/CLIProxyAPIPlus) models to
`pi`'s model picker through CLIProxy's unified OpenAI-compatible `/v1` surface.

That means you can `/login` to Claude Code, Gemini CLI, OpenAI Codex, GitHub
Copilot, Kiro, GLM, etc. inside CLIProxyAPIPlus once, and then consume all of
those subscriptions from `pi` under a single provider name.

## One provider

CLIProxyAPIPlus already unifies every backend behind OpenAI Chat Completions at
`/v1`, so this extension registers **one** provider for every discovered model:

| Provider   | Models                         | pi API               | base path  |
| ---------- | ------------------------------ | -------------------- | ---------- |
| `cliproxy` | Claude, Gemini, OpenAI, Grok, GLM, Kimi, … | `openai-completions` | `<url>/v1` |

Each model carries a shared compat block (`supportsStore: false`,
`supportsDeveloperRole: false`, `maxTokensField: "max_tokens"`,
`supportsReasoningEffort: true`) so backends that reject OpenAI-only fields
(e.g. Kimi K3) still tokenize cleanly.

Legacy names `cliproxy-openai` and `cliproxy-gemini` are unregistered on load
and on `/cliproxy-refresh`.

## Install

> Requires a running CLIProxyAPIPlus instance. See
> [the upstream README](https://github.com/router-for-me/CLIProxyAPIPlus) for
> Docker/`docker-compose` setup.

Drop the single file into pi's global extension directory:

```bash
# from this repo
mkdir -p ~/.pi/agent/extensions/cliproxy
ln -sf "$(pwd)/index.ts" ~/.pi/agent/extensions/cliproxy/index.ts
```

or copy instead of symlinking if you prefer:

```bash
mkdir -p ~/.pi/agent/extensions/cliproxy
cp index.ts ~/.pi/agent/extensions/cliproxy/index.ts
```

For quick one-shot testing without installing:

```bash
pi -e ./index.ts
```

## Configure

The extension reads its config in this order (first match wins):

1. Environment variables `CLIPROXY_URL` and `CLIPROXY_API_KEY`
2. `~/.pi/agent/cliproxy.json`:
   ```json
   {
     "baseUrl": "http://localhost:8317"  # example,
     "apiKey": "your-api-key"
   }
   ```
3. No default — `baseUrl` must be set via env or config file

A missing/empty API key is **tolerated** — the extension passes a placeholder
downstream. CLIProxyAPIPlus accepts any value when its own `api-keys:` list is
empty. When `api-keys:` is populated, set `CLIPROXY_API_KEY` to one of those
values.

Examples:

```bash
# Env-based (remote proxy with auth)
export CLIPROXY_URL=https://my-proxy.example.com
export CLIPROXY_API_KEY=abc123
pi

# File-based (persistent local config)
cat > ~/.pi/agent/cliproxy.json <<EOF
{ "baseUrl": "http://localhost:8317"  # example, "apiKey": "dev-key" }
EOF
pi
```

## Usage

Start `pi` and pick a model with `Ctrl+P` or `/model`:

```
cliproxy/claude-sonnet-4-5
cliproxy/claude-opus-4-5
cliproxy/gemini-2.5-pro
cliproxy/gpt-5-codex
cliproxy/kimi-k3
...
```

Or via flag:

```bash
pi --provider cliproxy --model claude-sonnet-4-5
pi --provider cliproxy --model gemini-2.5-pro
pi --provider cliproxy --model gpt-4o
pi --provider cliproxy --model kimi-k3
```

### Slash commands

| Command             | Description                                              |
| ------------------- | -------------------------------------------------------- |
| `/cliproxy-status`  | Ping the proxy, show model count + auth info             |
| `/cliproxy-models`  | List all discovered models grouped by `owned_by`         |
| `/cliproxy-refresh` | Re-fetch the model list and re-register all providers    |

### Listing models from the CLI

```bash
pi --list-models cliproxy   # every model the proxy serves
```

## Behaviour notes

- **Model metadata** (`contextWindow`, `maxTokens`, `reasoning`, image input)
  is inferred from the model ID; costs are set to `0` because upstream accounts
  are paid via subscription, not tokens.
- **Startup resilience** — if the proxy is unreachable at launch, the
  extension still loads with a small static fallback list and warns the user.
  Run `/cliproxy-refresh` once the proxy is back online.
- **No Bearer header is added by pi** — each native SDK sends its own auth
  (Anthropic `x-api-key`, OpenAI `Authorization: Bearer`, Google
  `x-goog-api-key`) using the configured key.

## Troubleshooting

**`CLIProxy unreachable`** — verify the proxy is listening:
```bash
curl -s http://localhost:8317/v1/models  # example endpoint | jq '.data | length'
```

**`302 Found` / `unauthorized` from Gemini or OpenAI** — CLIProxyAPIPlus is
forwarding to the upstream API with an unauthenticated token. Check that you
have an account linked for that provider in your proxy's `auths/` directory,
or set a valid key that matches the proxy's `api-keys:` list.

**Models don't appear after starting CLIProxy** — run `/cliproxy-refresh` in a
running pi session, or restart pi.

## License

MIT

## Grok / rust pi agent

This package also ships a **Grok plugin** (for the rust `grok` CLI) that keeps
`~/.grok/config.toml` model mappings synced from the same catalog SSOT.

See [PLUGINS.md](./PLUGINS.md) and run:

```bash
./scripts/install-all.sh
```
