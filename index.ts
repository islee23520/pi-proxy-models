/**
 * CLIProxyAPIPlus extension for pi-coding-agent.
 *
 * Registers models served by a local/remote CLIProxyAPIPlus instance
 * (https://github.com/router-for-me/CLIProxyAPIPlus) as a single pi provider:
 *
 *   cliproxy -> every model via openai-completions (baseUrl "/v1")
 *
 * CLIProxyAPIPlus already exposes a unified OpenAI-compatible surface at
 * `/v1`, so Anthropic / Gemini / OpenAI / Kimi / GLM / Grok ids all share
 * one provider name and the openai-completions + compat block (formerly only
 * used by cliproxy-openai). Legacy provider names cliproxy-openai and
 * cliproxy-gemini are unregistered on refresh so old picker entries vanish.
 *
 * Config is read from env vars (CLIPROXY_URL, CLIPROXY_API_KEY) first, then
 * ~/.pi/agent/cliproxy.json ({ "baseUrl": "...", "apiKey": "..." }).
 *
 * A missing API key is tolerated — CLIProxyAPIPlus accepts unauthenticated
 * requests when its own `api-keys:` list is empty. A dummy placeholder key
 * is used internally to satisfy pi's provider validation in that case.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CLIProxyListModel {
	id: string;
	object?: string;
	created?: number;
	owned_by?: string;
}

interface Config {
	baseUrl: string;
	apiKey: string; // may be "" if user hasn't set one
	// Per-model context-window overrides, e.g. { "claude-opus-4-5": 1000000 }.
	// Useful when the proxy doesn't encode long-context variants in the id.
	contextOverrides: Record<string, number>;
	// Per-model maxTokens overrides (optional, same key space as contextOverrides).
	maxTokensOverrides: Record<string, number>;
}

// Compat block applied to every model. CLIProxyAPIPlus proxies to backends
// (Anthropic, OpenAI-compatible, Google) that do not accept OpenAI's `store`,
// `developer` role, or `max_completion_tokens` fields. Kimi K3 in particular
// returns "tokenization failed" when any of those are sent.
// Mirror the compat block users ship in models.json so pi emits backend-friendly
// requests. `supportsReasoningEffort` is true because K3 and similar reasoning
// models accept `reasoning_effort: low|high|max`.
interface ModelCompat {
	supportsStore: false;
	supportsDeveloperRole: false;
	supportsReasoningEffort: boolean;
	maxTokensField: "max_tokens";
	// Optional per-model map from pi effort levels to backend reasoning_effort.
	// Used when a backend (e.g. Kimi K3: low|high|max) does not accept pi's full vocabulary.
	reasoningEffortMap?: { minimal?: string; low?: string; medium?: string; high?: string; xhigh?: string };
}

/** Single provider: all CLIProxy models via openai-completions at /v1. */
const PROVIDER = {
	providerName: "cliproxy",
	api: "openai-completions" as const,
	baseSuffix: "/v1",
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: true,
		maxTokensField: "max_tokens",
	} satisfies ModelCompat,
};

/** Old multi-family provider names removed after the unified registration. */
const LEGACY_PROVIDERS = ["cliproxy-openai", "cliproxy-gemini"] as const;

/** Pure plan for registration — exported so tests can lock the single-provider contract. */
export interface RegistrationPlan {
	providerName: string;
	api: "openai-completions";
	baseSuffix: "/v1";
	compat: ModelCompat;
	legacyProviders: readonly string[];
	modelIds: string[];
}

export function planRegistration(rawModels: CLIProxyListModel[]): RegistrationPlan {
	return {
		providerName: PROVIDER.providerName,
		api: PROVIDER.api,
		baseSuffix: PROVIDER.baseSuffix,
		compat: PROVIDER.compat,
		legacyProviders: LEGACY_PROVIDERS,
		modelIds: rawModels.map((m) => m.id),
	};
}

// pi's validation requires a non-empty apiKey when `models` is set. When the
// user hasn't set one (unauthenticated local proxy), we send this placeholder;
// CLIProxyAPIPlus ignores it when its `api-keys:` list is empty.
const PLACEHOLDER_KEY = "no-key";

// Snapshot of the last-known raw model list; used by /cliproxy-models and
// /cliproxy-status for a nice grouped view.
let lastFetched: CLIProxyListModel[] = [];
let lastCount = 0;

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function loadConfig(): Config {
	const envUrl = process.env.CLIPROXY_URL?.trim();
	const envKey = process.env.CLIPROXY_API_KEY?.trim();

	let fileBase: string | undefined;
	let fileKey: string | undefined;
	let fileContextOverrides: Record<string, number> = {};
	let fileMaxTokensOverrides: Record<string, number> = {};
	const configPath = join(homedir(), ".pi", "agent", "cliproxy.json");
	if (existsSync(configPath)) {
		try {
			const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
				baseUrl?: string;
				apiKey?: string;
				contextOverrides?: Record<string, number>;
				maxTokensOverrides?: Record<string, number>;
			};
			fileBase = parsed.baseUrl?.trim();
			fileKey = parsed.apiKey?.trim();
			if (parsed.contextOverrides && typeof parsed.contextOverrides === "object") {
				fileContextOverrides = parsed.contextOverrides;
			}
			if (parsed.maxTokensOverrides && typeof parsed.maxTokensOverrides === "object") {
				fileMaxTokensOverrides = parsed.maxTokensOverrides;
			}
		} catch (err) {
			console.warn(`[cliproxy] Failed to parse ${configPath}: ${(err as Error).message}`);
		}
	}

	let baseUrl = envUrl || fileBase || "http://localhost:8317";
	// Strip trailing slashes so we can safely append suffixes.
	baseUrl = baseUrl.replace(/\/+$/, "");

	const apiKey = envKey ?? fileKey ?? "";

	// Env-var overrides for quick one-off tweaks:
	//   CLIPROXY_CONTEXT_OVERRIDES="claude-opus-4-5=1000000,claude-sonnet-4-5=1000000"
	const contextOverrides = { ...fileContextOverrides, ...parseOverrides(process.env.CLIPROXY_CONTEXT_OVERRIDES) };
	const maxTokensOverrides = { ...fileMaxTokensOverrides, ...parseOverrides(process.env.CLIPROXY_MAX_TOKENS_OVERRIDES) };

	return { baseUrl, apiKey, contextOverrides, maxTokensOverrides };
}

function parseOverrides(raw: string | undefined): Record<string, number> {
	if (!raw) return {};
	const out: Record<string, number> = {};
	for (const pair of raw.split(",")) {
		const [k, v] = pair.split("=").map((s) => s.trim());
		if (!k || !v) continue;
		const n = Number(v);
		if (Number.isFinite(n) && n > 0) out[k] = n;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

async function fetchModels(cfg: Config): Promise<CLIProxyListModel[]> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

	const res = await fetch(`${cfg.baseUrl}/v1/models`, {
		headers,
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} ${res.statusText}`);
	}
	const data = (await res.json()) as { data?: CLIProxyListModel[] };
	if (!data?.data || !Array.isArray(data.data)) {
		throw new Error("Unexpected /v1/models response shape");
	}
	return data.data;
}

// ---------------------------------------------------------------------------
// Model metadata inference
// ---------------------------------------------------------------------------

interface ModelMetadata { reasoning: boolean; input: ("text" | "image")[]; contextWindow: number; maxTokens: number; }

// ---------------------------------------------------------------------------
// MODEL_METADATA policy
// ---------------------------------------------------------------------------
// Authoritative sources, in priority order:
//
// 1. Model LIST (which ids exist) — from the live CLIProxyAPIPlus `/v1/models`
//    endpoint. Reconcile with:
//      curl -s -H "Authorization: Bearer $CLIPROXY_API_KEY" $CLIPROXY_URL/v1/models
//    (or `/cliproxy-models` from inside pi). Every id the proxy serves MUST
//    have an explicit entry below.
//
// 2. contextWindow — from each model's OFFICIAL VENDOR DOCS. The proxy's
//    `context_window` field in ~/.grok/config.toml is NOT authoritative — it is
//    a hardcoded heuristic in the cliproxy-api-provider plugin's sync-models.mjs
//    that applies a blanket 200k cap to Claude/Kimi/GLM (understating
//    long-context models like claude-opus-4-6, kimi-k3, glm-5.2) and overstates
//    grok-4.x. Always cite the vendor docs page in the commit message when
//    changing a contextWindow. Sources used:
//      - Anthropic: https://platform.claude.com/docs/en/docs/about-claude/models/overview
//      - Google:    https://ai.google.dev/gemini-api/docs/gemini-3
//      - xAI:       https://docs.x.ai/developers/models/<model-id>
//      - Kimi:      https://platform.kimi.ai/docs/models
//      - Z.ai:      https://docs.z.ai/guides/llm/<model>.md
//
// 3. reasoning — from the proxy's `supports_reasoning_effort` flag (mirrored
//    in ~/.grok/config.toml). The proxy's flag reflects what the backend
//    actually accepts, so it is authoritative for runtime behavior and wins
//    over vendor docs when they conflict (e.g. grok-build-0.1's docs page
//    lists "Reasoning: Yes" but the proxy rejects reasoning_effort, so we set
//    reasoning=false to avoid sending a rejected parameter).
//
// 4. input (text vs text+image) and maxTokens — from official vendor docs.
//    For models with no public docs page (internal/proprietary ids like
//    codex-auto-review, gpt-5.6-sol/terra/luna, grok-composer, grok-imagine-*),
//    historical catalog values are retained unchanged rather than guessed.
//
// 5. When the proxy and vendor docs conflict on contextWindow, vendor docs
//    win (field 2). On reasoning, the proxy wins (field 3).
//
// inferLimits/inferReasoning/inferImageInput below are FALLBACKS for ids not
// yet listed here; any model the proxy serves should eventually get an explicit
// entry.
const MODEL_METADATA: Record<string, ModelMetadata> = {
	"claude-opus-4-6-thinking": { reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000 },
	"claude-sonnet-4-6": { reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000 },
	"gemini-3-flash": { reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 },
	"gemini-3-flash-agent": { reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 },
	"gemini-3.1-flash-image": { reasoning: false, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 },
	"gemini-3.1-flash-lite": { reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 },
	"gemini-3.1-pro-low": { reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 },
	"gemini-3.5-flash-extra-low": { reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 },
	"gemini-3.5-flash-low": { reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 },
	"gemini-pro-agent": { reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 },
	"kimi-k2": { reasoning: false, input: ["text"], contextWindow: 131_072, maxTokens: 16_384 },
	"kimi-k2-thinking": { reasoning: true, input: ["text"], contextWindow: 262_144, maxTokens: 262_144 },
	"kimi-k2.5": { reasoning: true, input: ["text", "image"], contextWindow: 262_144, maxTokens: 262_144 },
	"kimi-k2.6": { reasoning: true, input: ["text", "image"], contextWindow: 262_144, maxTokens: 262_144 },
	"kimi-k2.7-code": { reasoning: true, input: ["text", "image"], contextWindow: 262_144, maxTokens: 262_144 },
	"kimi-k2.7-code-highspeed": { reasoning: true, input: ["text", "image"], contextWindow: 262_144, maxTokens: 262_144 },
	"kimi-k3": { reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 131_072 },
	"grok-3-mini": { reasoning: true, input: ["text"], contextWindow: 131_072, maxTokens: 131_072 },
	"grok-3-mini-fast": { reasoning: true, input: ["text"], contextWindow: 131_072, maxTokens: 131_072 },
	"grok-4.20-0309-non-reasoning": { reasoning: false, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 1_000_000 },
	"grok-4.20-0309-reasoning": { reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 1_000_000 },
	"grok-4.20-multi-agent-0309": { reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 1_000_000 },
	"grok-4.3": { reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 1_000_000 },
	"grok-4.5": { reasoning: true, input: ["text", "image"], contextWindow: 500_000, maxTokens: 500_000 },
	"grok-build-0.1": { reasoning: false, input: ["text", "image"], contextWindow: 256_000, maxTokens: 256_000 },
	"grok-composer-2.5-fast": { reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
	"grok-imagine-image": { reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
	"grok-imagine-image-quality": { reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
	"grok-imagine-video": { reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
	"grok-imagine-video-1.5-preview": { reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
	"codex-auto-review": { reasoning: true, input: ["text"], contextWindow: 272_000, maxTokens: 128_000 },
	"gpt-5.3-codex-spark": { reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 32_000 },
	"gpt-5.4": { reasoning: true, input: ["text", "image"], contextWindow: 272_000, maxTokens: 128_000 },
	"gpt-5.4-mini": { reasoning: true, input: ["text", "image"], contextWindow: 400_000, maxTokens: 128_000 },
	"gpt-5.5": { reasoning: true, input: ["text", "image"], contextWindow: 272_000, maxTokens: 128_000 },
	"gpt-5.6-luna": { reasoning: true, input: ["text", "image"], contextWindow: 272_000, maxTokens: 128_000 },
	"gpt-5.6-sol": { reasoning: true, input: ["text", "image"], contextWindow: 272_000, maxTokens: 128_000 },
	"gpt-5.6-terra": { reasoning: true, input: ["text", "image"], contextWindow: 272_000, maxTokens: 128_000 },
	"gpt-oss-120b-medium": { reasoning: true, input: ["text"], contextWindow: 131_072, maxTokens: 32_768 },
	"gpt-image-1.5": { reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
	"gpt-image-2": { reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
	"glm-4.5": { reasoning: true, input: ["text"], contextWindow: 131_072, maxTokens: 98_304 },
	"glm-4.5-air": { reasoning: true, input: ["text"], contextWindow: 131_072, maxTokens: 98_304 },
	"glm-4.6": { reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 131_072 },
	"glm-4.7": { reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 131_072 },
	"glm-5": { reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 131_072 },
	"glm-5-turbo": { reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 131_072 },
	"glm-5.1": { reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 131_072 },
	"glm-5.2": { reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000 },
	"glm-5v-turbo": { reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 131_072 },
	"z-ai/glm-5.2-ultrafast": { reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000 },
};

function inferReasoning(id: string): boolean {
	const l = id.toLowerCase();
	// Per the MODEL_METADATA policy, reasoning follows the proxy's
	// supports_reasoning_effort flag where known; otherwise infer from the id.
	// Kimi base (kimi-k2) is non-reasoning per Kimi docs; -thinking/-k2.5+ reason.
	if (l === "kimi-k2") return false;
	if (l.includes("kimi-k2-thinking") || l.includes("kimi-k2.5") || l.includes("kimi-k2.6") || l.includes("kimi-k2.7") || l.includes("kimi-k3")) return true;
	if (l.includes("kimi-k2")) return false;
	return (
		l.includes("claude") ||
		l.includes("gemini") ||
		/\bo1\b|\bo3\b|\bo4\b/.test(l) ||
		l.includes("gpt-5") ||
		l.includes("thinking") ||
		l.includes("reasoning") ||
		l.includes("glm-4") ||
		l.includes("glm-5")
	);
}

function inferImageInput(id: string): boolean {
	const l = id.toLowerCase();
	if (l.includes("kimi-k2.5") || l.includes("kimi-k2.6") || l.includes("kimi-k2.7") || l.includes("kimi-k3")) return true;
	if (l.includes("kimi-k2")) return false;
	return (
		l.includes("claude") ||
		l.includes("gemini") ||
		l.includes("gpt-4o") ||
		l.includes("gpt-4.") ||
		l.includes("gpt-5") ||
		l.includes("4o")
	);
}

function inferLimits(id: string): { contextWindow: number; maxTokens: number } {
	const l = id.toLowerCase();
	// Context windows below are sourced from each family's OFFICIAL vendor docs
	// (see MODEL_METADATA policy). Values not confirmed by docs retain their
	// historical catalog defaults. The proxy's reported context_window is NOT
	// used here — it applies a blanket 200k cap that understates long-context
	// models (Claude/Kimi-k3/GLM-5.2) and is unreliable.
	if (l.includes("kimi-k3")) return { contextWindow: 1_048_576, maxTokens: 131_072 };
	if (l.includes("kimi-k2.7") || l.includes("kimi-k2.6") || l.includes("kimi-k2.5") || l.includes("kimi-k2-thinking")) return { contextWindow: 262_144, maxTokens: 262_144 };
	if (l.includes("kimi-k2")) return { contextWindow: 131_072, maxTokens: 16_384 };
	if (l.includes("claude")) return { contextWindow: 1_000_000, maxTokens: 128_000 };
	if (l.includes("gemini-2.5") || l.includes("gemini-3")) return { contextWindow: 1_048_576, maxTokens: 65_536 };
	if (l.includes("gemini")) return { contextWindow: 1_048_576, maxTokens: 8_192 };
	if (l.includes("grok-4.20") || l.includes("grok-4.3")) return { contextWindow: 1_000_000, maxTokens: 1_000_000 };
	if (l.includes("grok-4.5")) return { contextWindow: 500_000, maxTokens: 500_000 };
	if (l.includes("grok-build")) return { contextWindow: 256_000, maxTokens: 256_000 };
	if (l.includes("grok")) return { contextWindow: 131_072, maxTokens: 8_192 };
	if (l.includes("glm-5.2")) return { contextWindow: 1_000_000, maxTokens: 128_000 };
	if (l.includes("glm-4.6") || l.includes("glm-4.7") || l.includes("glm-5")) return { contextWindow: 200_000, maxTokens: 131_072 };
	if (l.includes("glm-4.5")) return { contextWindow: 131_072, maxTokens: 98_304 };
	if (l.includes("glm")) return { contextWindow: 200_000, maxTokens: 131_072 };
	if (l.includes("gpt-5")) return { contextWindow: 272_000, maxTokens: 128_000 };
	if (l.includes("gpt-4.1")) return { contextWindow: 1_000_000, maxTokens: 32_768 };
	if (l.includes("gpt-4o")) return { contextWindow: 128_000, maxTokens: 16_384 };
	if (l.includes("o1") || l.includes("o3") || l.includes("o4")) return { contextWindow: 200_000, maxTokens: 100_000 };
	if (l.includes("kiro")) return { contextWindow: 200_000, maxTokens: 64_000 };
	if (l.includes("qwen") || l.includes("codex")) return { contextWindow: 128_000, maxTokens: 8_192 };
	return { contextWindow: 128_000, maxTokens: 8_192 };
}

interface PiModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0 };
	contextWindow: number;
	maxTokens: number;
	compat: ModelCompat;
}

/** Resolve metadata for a model id: MODEL_METADATA table first, infer* fallback. Exported for tests. */
export function resolveModelMetadata(id: string): ModelMetadata {
	const hit = MODEL_METADATA[id];
	if (hit) return hit;
	const limits = inferLimits(id);
	return {
		reasoning: inferReasoning(id),
		input: inferImageInput(id) ? ["text", "image"] : ["text"],
		contextWindow: limits.contextWindow,
		maxTokens: limits.maxTokens,
	};
}

export function toProviderModel(m: CLIProxyListModel, cfg: Config): PiModelConfig {
	const meta = resolveModelMetadata(m.id);
	const contextWindow = cfg.contextOverrides[m.id] ?? meta.contextWindow;
	const maxTokens = cfg.maxTokensOverrides[m.id] ?? meta.maxTokens;
	// Kimi K3 accepts only reasoning_effort: low | high | max (default max).
	// Map pi's effort vocabulary onto Kimi's so /effort xhigh -> max, etc.
	let compat: ModelCompat = PROVIDER.compat;
	if (m.id.toLowerCase() === "kimi-k3") {
		compat = {
			...PROVIDER.compat,
			reasoningEffortMap: { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max" },
		};
	}
	return {
		id: m.id,
		name: m.owned_by ? `${m.id} (${m.owned_by})` : m.id,
		reasoning: meta.reasoning,
		input: meta.input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		compat,
	};
}

// ---------------------------------------------------------------------------
// Fallback model list (used when the proxy is unreachable at startup)
// ---------------------------------------------------------------------------

function fallbackModels(): CLIProxyListModel[] {
	return [
		{ id: "claude-opus-4-5", owned_by: "anthropic" },
		{ id: "claude-sonnet-4-5", owned_by: "anthropic" },
		{ id: "gemini-2.5-pro", owned_by: "google" },
		{ id: "gemini-2.5-flash", owned_by: "google" },
		{ id: "gpt-5-codex", owned_by: "openai" },
		{ id: "gpt-4o", owned_by: "openai" },
		{ id: "gpt-4o-mini", owned_by: "openai" },
		{ id: "grok-4.5", owned_by: "xai" },
		{ id: "grok-4.3", owned_by: "xai" },
		{ id: "glm-5.2", owned_by: "zai" },
		{ id: "z-ai/glm-5.2-ultrafast", owned_by: "zai" },
		{ id: "glm-5v-turbo", owned_by: "zai" },
		{ id: "kimi-k3", owned_by: "moonshot" },
	];
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

function registerFamilies(pi: ExtensionAPI, cfg: Config, rawModels: CLIProxyListModel[]): number {
	const plan = planRegistration(rawModels);
	const models = rawModels.map((m) => toProviderModel(m, cfg));

	// Drop legacy multi-family provider names so the picker only shows cliproxy/*.
	for (const name of plan.legacyProviders) {
		try {
			pi.unregisterProvider(name);
		} catch {
			/* no-op if not registered */
		}
	}

	// The apiKey pi receives; we never set authHeader so pi won't add its own
	// Bearer header — the underlying SDK sends auth natively using this value.
	// CLIProxyAPIPlus accepts any value when its `api-keys:` is empty, so a
	// placeholder works for unauthenticated setups.
	const effectiveKey = cfg.apiKey || PLACEHOLDER_KEY;

	if (models.length === 0) {
		try {
			pi.unregisterProvider(plan.providerName);
		} catch {
			/* no-op if not registered */
		}
		return 0;
	}

	pi.registerProvider(plan.providerName, {
		baseUrl: cfg.baseUrl + plan.baseSuffix,
		apiKey: effectiveKey,
		api: plan.api,
		models,
	});

	return models.length;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function notify(ctx: ExtensionContext | ExtensionCommandContext, msg: string, kind: "info" | "success" | "error" | "warning" = "info") {
	if ((ctx as ExtensionContext).hasUI) {
		(ctx as ExtensionContext).ui.notify(msg, kind as any);
	} else {
		// Headless: map to a sensible stream.
		if (kind === "error") console.error(`[cliproxy] ${msg}`);
		else console.log(`[cliproxy] ${msg}`);
	}
}

function groupByOwner(models: CLIProxyListModel[]): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const m of models) {
		const owner = m.owned_by || "unknown";
		(out[owner] ||= []).push(m.id);
	}
	for (const owner of Object.keys(out)) out[owner].sort();
	return out;
}

function registerCommands(pi: ExtensionAPI, cfg: Config) {
	pi.registerCommand("cliproxy-status", {
		description: "Ping CLIProxyAPIPlus and report model count",
		handler: async (_args, ctx) => {
			try {
				const models = await fetchModels(cfg);
				lastFetched = models;
				lastCount = models.length;
				const auth = cfg.apiKey ? "with API key" : "no API key";
				notify(ctx, `CLIProxy OK — ${models.length} models @ ${cfg.baseUrl} (${auth})`, "success");
				if (!ctx.hasUI) {
					const grouped = groupByOwner(models);
					for (const [owner, ids] of Object.entries(grouped)) {
						console.log(`  ${owner}: ${ids.join(", ")}`);
					}
				}
			} catch (err) {
				notify(ctx, `CLIProxy error: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("cliproxy-models", {
		description: "List all available CLIProxyAPIPlus models grouped by owner",
		handler: async (_args, ctx) => {
			try {
				const models = await fetchModels(cfg);
				lastFetched = models;
				lastCount = models.length;
				const grouped = groupByOwner(models);
				const lines = Object.entries(grouped)
					.map(([owner, ids]) => `${owner}:\n  ${ids.join("\n  ")}`)
					.join("\n\n");
				if (ctx.hasUI) {
					ctx.ui.notify(`${models.length} models (see console for full list)`, "info");
					console.log(`\nCLIProxy models:\n${lines}\n`);
				} else {
					console.log(`CLIProxy models:\n${lines}`);
				}
			} catch (err) {
				notify(ctx, `CLIProxy models failed: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("cliproxy-refresh", {
		description: "Re-fetch the CLIProxyAPIPlus model list and re-register providers",
		handler: async (_args, ctx) => {
			try {
				const models = await fetchModels(cfg);
				lastFetched = models;
				lastCount = models.length;
				const total = registerFamilies(pi, cfg, models);
				notify(ctx, `CLIProxy: refreshed ${total} models under ${PROVIDER.providerName}`, "success");
			} catch (err) {
				notify(ctx, `CLIProxy refresh failed: ${(err as Error).message}`, "error");
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI): Promise<void> {
	const cfg = loadConfig();
	let initError: string | undefined;

	let models: CLIProxyListModel[];
	try {
		models = await fetchModels(cfg);
	} catch (err) {
		initError = (err as Error).message;
		console.warn(
			`[cliproxy] Could not reach CLIProxyAPIPlus at ${cfg.baseUrl}: ${initError}. ` +
				`Using fallback model list; run /cliproxy-refresh once the proxy is up.`,
		);
		models = fallbackModels();
	}

	lastFetched = models;
	lastCount = models.length;

	registerFamilies(pi, cfg, models);
	registerCommands(pi, cfg);

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (initError) {
			ctx.ui.notify(
				`CLIProxy unreachable (${initError}). Loaded ${lastCount} fallback models — /cliproxy-refresh to retry.`,
				"warning",
			);
		} else {
			ctx.ui.notify(`CLIProxy: ${lastCount} models available`, "info");
		}
	});
}
