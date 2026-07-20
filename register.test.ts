import { describe, expect, test } from "bun:test";
import { planRegistration } from "./index.ts";

describe("planRegistration (single cliproxy provider)", () => {
	test("puts every model under cliproxy with openai-completions + /v1", () => {
		const plan = planRegistration([
			{ id: "claude-sonnet-4-5", owned_by: "anthropic" },
			{ id: "gemini-2.5-pro", owned_by: "google" },
			{ id: "kimi-k3", owned_by: "moonshot" },
			{ id: "grok-4.5", owned_by: "xai" },
		]);

		expect(plan.providerName).toBe("cliproxy");
		expect(plan.api).toBe("openai-completions");
		expect(plan.baseSuffix).toBe("/v1");
		expect(plan.modelIds).toEqual([
			"claude-sonnet-4-5",
			"gemini-2.5-pro",
			"kimi-k3",
			"grok-4.5",
		]);
		expect(plan.legacyProviders).toEqual(["cliproxy-openai", "cliproxy-gemini"]);
		expect(plan.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
		});
	});

	test("empty model list still targets cliproxy and legacy unregisters", () => {
		const plan = planRegistration([]);
		expect(plan.providerName).toBe("cliproxy");
		expect(plan.modelIds).toEqual([]);
		expect(plan.legacyProviders).toContain("cliproxy-gemini");
		expect(plan.legacyProviders).toContain("cliproxy-openai");
	});
});
