import { describe, expect, test } from "bun:test";
import { resolveModelMetadata, toProviderModel } from "./index.ts";

describe("resolveModelMetadata (MODEL_METADATA SSoT)", () => {
	test("grok-4.5 matches xAI docs + catalog: reasoning, image, 500k", () => {
		const m = resolveModelMetadata("grok-4.5");
		expect(m.reasoning).toBe(true);
		expect(m.input).toEqual(["text", "image"]);
		expect(m.contextWindow).toBe(500_000);
		expect(m.maxTokens).toBe(500_000);
	});

	test("unknown id falls back to infer* without throwing", () => {
		const m = resolveModelMetadata("totally-unknown-model-xyz");
		expect(m.contextWindow).toBeGreaterThan(0);
		expect(m.maxTokens).toBeGreaterThan(0);
		expect(m.input.includes("text")).toBe(true);
	});

	test("grok-4.3 stays at 1M reasoning+image from table", () => {
		const m = resolveModelMetadata("grok-4.3");
		expect(m.reasoning).toBe(true);
		expect(m.input).toEqual(["text", "image"]);
		expect(m.contextWindow).toBe(1_000_000);
		expect(m.maxTokens).toBe(1_000_000);
	});

	test("glm-5.2: 1M context, reasoning, text-only from table", () => {
		const m = resolveModelMetadata("glm-5.2");
		expect(m.reasoning).toBe(true);
		expect(m.input).toEqual(["text"]);
		expect(m.contextWindow).toBe(1_000_000);
		expect(m.maxTokens).toBe(128_000);
	});

	test("z-ai/glm-5.2-ultrafast shares glm-5.2 1M specs", () => {
		const m = resolveModelMetadata("z-ai/glm-5.2-ultrafast");
		expect(m.reasoning).toBe(true);
		expect(m.input).toEqual(["text"]);
		expect(m.contextWindow).toBe(1_000_000);
		expect(m.maxTokens).toBe(128_000);
	});

	test("glm-5v-turbo multimodal 200k", () => {
		const m = resolveModelMetadata("glm-5v-turbo");
		expect(m.reasoning).toBe(true);
		expect(m.input).toEqual(["text", "image"]);
		expect(m.contextWindow).toBe(200_000);
		expect(m.maxTokens).toBe(131_072);
	});

	test("kimi-k3: 1M native context, reasoning, image", () => {
		const m = resolveModelMetadata("kimi-k3");
		expect(m.reasoning).toBe(true);
		expect(m.input).toEqual(["text", "image"]);
		expect(m.contextWindow).toBe(1_048_576);
		expect(m.maxTokens).toBe(131_072);
	});

	test("kimi-k3 compat carries reasoningEffortMap low|high|max", () => {
		const model = toProviderModel(
			{ id: "kimi-k3", owned_by: "moonshot" },
			{ baseUrl: "http://x", apiKey: "k", contextOverrides: {}, maxTokensOverrides: {} },
		);
		expect(model.compat.reasoningEffortMap).toEqual({ minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max" });
	});

});