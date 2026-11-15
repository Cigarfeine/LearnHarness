import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectAntigravityInstallation } from "../src/agent/antigravity/installation.ts";

const binary = "/fake/antigravity";

test("missing installation does not execute a command", async () => {
	assert.deepEqual(await inspectAntigravityInstallation(() => null, async () => { throw new Error("must not run"); }), {
		state: "not-found", version: null, minimumVersion: "1.0.0",
	});
});

for (const [output, state, version] of [
	["0.9.0 (Antigravity CLI)\n", "update-required", "0.9.0"],
	["1.0.0 (Google Antigravity)", "meets-minimum", "1.0.0"],
	["1.5.4 (Antigravity CLI)", "meets-minimum", "1.5.4"],
	["2.0.0", "meets-minimum", "2.0.0"],
	["0.9.999", "update-required", "0.9.999"],
	["unexpected output containing private details", "version-unchecked", null],
	["1.5.4-preview", "version-unchecked", null],
	["99999999999999999999999999.1.1", "version-unchecked", null],
] as const) test(`installation version output ${JSON.stringify(output)} gives ${state}`, async () => {
	const status = await inspectAntigravityInstallation(() => binary, async (path) => { assert.equal(path, binary); return output; });
	assert.deepEqual(status, { state, version, minimumVersion: "1.0.0" });
});

test("probe failures expose neither raw errors nor binary paths", async () => {
	const status = await inspectAntigravityInstallation(() => binary, async () => { throw new Error("timeout /private/path secret-token"); });
	assert.deepEqual(status, { state: "version-unchecked", version: null, minimumVersion: "1.0.0" });
});
