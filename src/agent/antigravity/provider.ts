import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";

import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER } from "./constants.ts";

const SHARED_MODEL_FIELDS = {
	api: ANTIGRAVITY_API,
	provider: ANTIGRAVITY_PROVIDER,
	baseUrl: "",
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
} satisfies Omit<Model<Api>, "id" | "name">;

export const ANTIGRAVITY_MODELS: readonly Model<Api>[] = [
	{ ...SHARED_MODEL_FIELDS, id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
	{ ...SHARED_MODEL_FIELDS, id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
	{ ...SHARED_MODEL_FIELDS, id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
	{ ...SHARED_MODEL_FIELDS, id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)" },
	{ ...SHARED_MODEL_FIELDS, id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
	{ ...SHARED_MODEL_FIELDS, id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];

export function createAntigravityProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>): Provider {
	return createProvider({
		id: ANTIGRAVITY_PROVIDER,
		name: "Antigravity CLI",
		auth: { apiKey: { name: "Antigravity CLI", resolve: async () => ({ auth: {}, source: "antigravity CLI" }) } },
		models: ANTIGRAVITY_MODELS,
		api: { stream: streamSimple, streamSimple },
	});
}
