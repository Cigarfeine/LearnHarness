/**
 * Antigravity provider catalog (src/agent/antigravity/provider.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { clampThinkingLevel, createAssistantMessageEventStream, createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import { ANTIGRAVITY_PROVIDER } from "../src/agent/antigravity/constants.ts";
import { createAntigravityProvider } from "../src/agent/antigravity/provider.ts";

function createCollection() {
	const collection = createModels();
	collection.setProvider(createAntigravityProvider(() => createAssistantMessageEventStream()));
	return collection;
}

test("lists the expected antigravity models", () => {
	const models = createCollection().getModels(ANTIGRAVITY_PROVIDER);
	assert.deepEqual(
		models.map((m) => m.id),
		[
			"gemini-3.8-flash-high",
			"gemini-3.8-flash-low",
			"gemini-4-argon-high",
			"claude-sonnet-5-5-high",
			"claude-opus-5-5-high",
			"gpt-oss-120b-medium",
		],
	);
});

test("supports low through max thinking and clamps off/minimal to low", () => {
	for (const model of createCollection().getModels(ANTIGRAVITY_PROVIDER)) {
		assert.deepEqual(getSupportedThinkingLevels(model), ["low", "medium", "high", "xhigh", "max"]);
		assert.equal(clampThinkingLevel(model, "off"), "low");
		assert.equal(clampThinkingLevel(model, "minimal"), "low");
	}
});

test("accepts text and image input", () => {
	for (const model of createCollection().getModels(ANTIGRAVITY_PROVIDER)) {
		assert.deepEqual(model.input, ["text", "image"]);
	}
});

test("every cost field is zero (CLI billing)", () => {
	for (const model of createCollection().getModels(ANTIGRAVITY_PROVIDER)) {
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	}
});

test("auth resolves as configured without any key", async () => {
	const collection = createCollection();
	assert.ok(await collection.checkAuth(ANTIGRAVITY_PROVIDER));
	assert.equal((await collection.getAvailable(ANTIGRAVITY_PROVIDER)).length, 6);
});
