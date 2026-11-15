import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after, type TestContext } from "node:test";

const testData = mkdtempSync(join(tmpdir(), "lh-cli-opt-in-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));

const { SETTINGS_FILE } = await import("../config.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { parseAntigravitySettingsBody } = await import("../src/server/settings-body.ts");
const { antigravityAvailable, antigravityEnabled } = await import("../src/server/antigravity-config.ts");
const { antigravityInstallationResponse } = await import("../src/server/antigravity.ts");
const { modelCatalog, validateModelsSettings } = await import("../src/server/model-catalog.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");

function setup(t: TestContext) {
	const previous = readSettings();
	const path = process.env.PATH;
	const dir = mkdtempSync(join(tmpdir(), "antigravity-opt-in-"));
	// Never executed: only installation discovery observes this marker.
	writeFileSync(join(dir, process.platform === "win32" ? "antigravity.exe" : "antigravity"), "", { mode: 0o755 });
	process.env.PATH = `${dir}${delimiter}${path ?? ""}`;
	t.after(() => {
		if (previous) writeSettings(previous); else rmSync(SETTINGS_FILE, { force: true });
		if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
	});
	writeSettings({ version: 1 });
}

async function save(body: unknown) {
	return PUT(new Request("http://test/api/settings/antigravity", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		{ params: Promise.resolve({ section: "antigravity" }) });
}

test("opt-in parses strictly and malformed stored values never enable the CLI", () => {
	assert.deepEqual(parseAntigravitySettingsBody({}), { ok: true, settings: {} });
	assert.deepEqual(parseAntigravitySettingsBody({ enabled: true, ignored: true }), { ok: true, settings: { enabled: true } });
	assert.deepEqual(parseAntigravitySettingsBody({ enabled: false }), { ok: true, settings: { enabled: false } });
	for (const raw of [true, null, [], "on", { enabled: "true" }, { enabled: 1 }]) assert.equal(parseAntigravitySettingsBody(raw).ok, false);
	for (const raw of [null, [], true, "on", { enabled: "true" }, { enabled: 1 }]) {
		assert.notEqual(sanitizeUserSettings({ version: 1, antigravity: raw })?.antigravity?.enabled, true);
	}
	assert.equal(sanitizeUserSettings({ version: 1 })?.antigravity, undefined);
});

test("default off even with an installed binary; section writes toggle availability but preserve saved model pins and unrelated settings", async (t) => {
	setup(t);
	const models = { strong: { model: { provider: "antigravity", id: "gemini-3.8-flash-high" } } };
	writeSettings({ version: 1, models, graph: { enabled: false }, futureSection: { keep: 1 } });
	assert.equal(antigravityEnabled(), false);
	assert.equal(antigravityAvailable(), false);
	assert.equal(providerKeyPresent("antigravity"), false);
	assert(!modelCatalog().models.some((m) => m.provider === "antigravity"));

	assert.equal((await save({ enabled: true })).status, 200);
	assert.equal(antigravityEnabled(), true);
	assert.equal(antigravityAvailable(), true);
	assert.equal(modelCatalog().models.filter((m) => m.provider === "antigravity").length, 6);

	assert.equal((await save({ enabled: false })).status, 200);
	assert.equal(antigravityAvailable(), false);
	assert(!modelCatalog().models.some((m) => m.provider === "antigravity"));
	assert.deepEqual(readSettings()?.models, models);
	assert.deepEqual(readSettings()?.graph, { enabled: false });
	assert.deepEqual(readSettings()?.futureSection, { keep: 1 });
	assert.equal(validateModelsSettings(models, models).ok, true, "saved unavailable pins remain repairable, not silently removed");
	assert.equal((await save({ enabled: "true" })).status, 400);
	assert.equal(antigravityEnabled(), false);
	assert.equal((await save({})).status, 200);
	assert.equal(antigravityEnabled(), false);
});

test("off cannot launch a version probe even through an otherwise authorized HTTP request", async (t) => {
	setup(t);
	const request = new Request("http://test/api/antigravity", { headers: { "x-learnharness-antigravity": "1" } });
	const response = await antigravityInstallationResponse(request, async () => assert.fail("disabled CLI must not execute"));
	assert.equal(response.status, 403);
});
