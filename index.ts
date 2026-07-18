/**
 * CLIProxyAPIPlus extension for pi-coding-agent.
 *
 * Registers models served by a local/remote CLIProxyAPIPlus instance
 * (https://github.com/router-for-me/CLIProxyAPIPlus) as pi providers.
 *
 * Because pi locks one baseUrl per provider but the Anthropic / OpenAI /
 * Gemini SDKs each expect different path prefixes, this extension registers
 * up to three providers and partitions discovered models by family:
 *
 *   cliproxy        -> Claude/Anthropic models via anthropic-messages  (baseUrl "/")
 *   cliproxy-openai -> OpenAI/Codex/Copilot/etc.  via openai-completions (baseUrl "/v1")
 *   cliproxy-gemini -> Gemini/Google models      via google-generative-ai (baseUrl "/v1beta")
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

type Family = "anthropic" | "openai" | "gemini";

type Api = "anthropic-messages" | "openai-completions" | "google-generative-ai";

// Compat block applied to every model registered under a family. CLIProxyAPIPlus
// proxies to backends (Anthropic, OpenAI-compatible, Google) that do not accept
// OpenAI's `store`, `developer` role, or `max_completion_tokens` fields. Kimi K3
// in particular returns "tokenization failed" when any of those are sent.
// Mirror the compat block users ship in models.json so pi emits backend-friendly
// requests. `supportsReasoningEffort` is true for the openai family because K3
// and similar reasoning models accept `reasoning_effort: low|high|max`.
interface FamilyCompat {
	supportsStore: false;
	supportsDeveloperRole: false;
	supportsReasoningEffort: boolean;
	maxTokensField: "max_tokens";
}

interface FamilySpec {
	family: Family;
	providerName: string;
	api: Api;
	baseSuffix: string; // appended to cfg.baseUrl
	compat: FamilyCompat;
}

const FAMILIES: Record<Family, FamilySpec> = {
	anthropic: {
		family: "anthropic",
		providerName: "cliproxy",
		api: "anthropic-messages",
		baseSuffix: "",
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
	},
	openai: {
		family: "openai",
		providerName: "cliproxy-openai",
		api: "openai-completions",
		baseSuffix: "/v1",
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens" },
	},
	gemini: {
		family: "gemini",
		providerName: "cliproxy-gemini",
		api: "google-generative-ai",
		baseSuffix: "/v1beta",
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
	},
};

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
// Model classification + metadata inference
// ---------------------------------------------------------------------------

function classifyFamily(m: CLIProxyListModel): Family {
	const id = m.id.toLowerCase();
	const owner = (m.owned_by ?? "").toLowerCase();

	if (owner.includes("anthropic") || id.includes("claude")) return "anthropic";
	if (owner.includes("google") || owner.includes("gemini") || id.includes("gemini")) return "gemini";
	return "openai";
}

interface ModelMetadata { reasoning: boolean; input: ("text" | "image")[]; contextWindow: number; maxTokens: number; }

// Explicit per-model metadata for models served by CLIProxyAPIPlus. Sourced from
// each model's official docs (e.g. https://www.kimi.com/code/docs/en/kimi-code/models
// for Kimi K3: 1M context, low/high/max reasoning_effort, text+image input).
// inferLimits/inferReasoning/inferImageInput remain as fallbacks for ids not listed here.
const MODEL_METADATA: Record<string, ModelMetadata> = {
	"claude-opus-4-6-thinking": { reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000 },
	"claude-sonnet-4-6": { reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000 },
	"gemini-3-flash": { reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 },
	"gemini-3-flash-agent": { reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 },
	"gemini-3.1-flash-image": { reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 },
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
	"grok-4.20-0309-non-reasoning": { reasoning: false, input: ["text", "image"], contextWindow: 2_000_000, maxTokens: 2_000_000 },
	"grok-4.20-0309-reasoning": { reasoning: true, input: ["text", "image"], contextWindow: 2_000_000, maxTokens: 2_000_000 },
	"grok-4.20-multi-agent-0309": { reasoning: true, input: ["text", "image"], contextWindow: 2_000_000, maxTokens: 2_000_000 },
	"grok-4.3": { reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 30_000 },
	"grok-4.5": { reasoning: true, input: ["text", "image"], contextWindow: 500_000, maxTokens: 500_000 },
	"grok-build-0.1": { reasoning: true, input: ["text", "image"], contextWindow: 256_000, maxTokens: 256_000 },
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
	"glm-4.6": { reasoning: true, input: ["text"], contextWindow: 204_800, maxTokens: 131_072 },
	"glm-4.7": { reasoning: true, input: ["text"], contextWindow: 204_800, maxTokens: 131_072 },
	"glm-5": { reasoning: true, input: ["text"], contextWindow: 202_752, maxTokens: 131_072 },
	"glm-5-turbo": { reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 131_072 },
	"glm-5.1": { reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 131_072 },
	"glm-5.2": { reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 131_072 },
	"glm-5v-turbo": { reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 131_072 },
	"z-ai/glm-5.2-ultrafast": { reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 131_072 },
};

function inferReasoning(id: string): boolean {
	const l = id.toLowerCase();
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
	if (l.includes("kimi-k3")) return { contextWindow: 1_048_576, maxTokens: 131_072 };
	if (l.includes("kimi-k2.7") || l.includes("kimi-k2.6") || l.includes("kimi-k2.5") || l.includes("kimi-k2-thinking")) return { contextWindow: 262_144, maxTokens: 262_144 };
	if (l.includes("kimi-k2")) return { contextWindow: 131_072, maxTokens: 16_384 };
	if (l.includes("claude-opus")) return { contextWindow: 200_000, maxTokens: 32_000 };
	if (l.includes("claude")) return { contextWindow: 200_000, maxTokens: 64_000 };
	if (l.includes("gemini-2.5") || l.includes("gemini-3")) return { contextWindow: 1_000_000, maxTokens: 65_536 };
	if (l.includes("gemini")) return { contextWindow: 1_000_000, maxTokens: 8_192 };
	if (l.includes("gpt-5")) return { contextWindow: 400_000, maxTokens: 16_384 };
	if (l.includes("gpt-4.1")) return { contextWindow: 1_000_000, maxTokens: 32_768 };
	if (l.includes("gpt-4o")) return { contextWindow: 128_000, maxTokens: 16_384 };
	if (l.includes("o1") || l.includes("o3") || l.includes("o4")) return { contextWindow: 200_000, maxTokens: 100_000 };
	if (l.includes("kiro")) return { contextWindow: 200_000, maxTokens: 64_000 };
	if (l.includes("glm")) return { contextWindow: 200_000, maxTokens: 16_384 };
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
	compat: FamilyCompat;
}

function toProviderModel(m: CLIProxyListModel, cfg: Config, compat: FamilyCompat): PiModelConfig {
	const inferred = inferLimits(m.id);
	const contextWindow = cfg.contextOverrides[m.id] ?? inferred.contextWindow;
	const maxTokens = cfg.maxTokensOverrides[m.id] ?? inferred.maxTokens;
	return {
		id: m.id,
		name: m.owned_by ? `${m.id} (${m.owned_by})` : m.id,
		reasoning: inferReasoning(m.id),
		input: inferImageInput(m.id) ? ["text", "image"] : ["text"],
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
	];
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

function registerFamilies(pi: ExtensionAPI, cfg: Config, rawModels: CLIProxyListModel[]): number {
	// Partition models by family.
	const buckets: Record<Family, PiModelConfig[]> = {
		anthropic: [],
		openai: [],
		gemini: [],
	};
	for (const m of rawModels) {
		const family = classifyFamily(m);
		buckets[family].push(toProviderModel(m, cfg, FAMILIES[family].compat));
	}

	// The apiKey pi receives; we never set authHeader so pi won't add its own
	// Bearer header — the underlying SDK (Anthropic/OpenAI/Google) sends auth
	// natively using this value. CLIProxyAPIPlus accepts any value when its
	// `api-keys:` is empty, so a placeholder works for unauthenticated setups.
	const effectiveKey = cfg.apiKey || PLACEHOLDER_KEY;

	let total = 0;
	for (const family of Object.keys(buckets) as Family[]) {
		const spec = FAMILIES[family];
		const models = buckets[family];
		if (models.length === 0) {
			// Nothing to register for this family. Unregister any stale
			// registration from a previous refresh.
			try {
				pi.unregisterProvider(spec.providerName);
			} catch {
				/* no-op if not registered */
			}
			continue;
		}

		pi.registerProvider(spec.providerName, {
			baseUrl: cfg.baseUrl + spec.baseSuffix,
			apiKey: effectiveKey,
			api: spec.api,
			models,
		});
		total += models.length;
	}

	return total;
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
				notify(ctx, `CLIProxy: refreshed ${total} models across ${new Set(models.map(classifyFamily)).size} providers`, "success");
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
