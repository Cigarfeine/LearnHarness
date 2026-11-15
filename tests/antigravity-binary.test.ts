/**
 * Antigravity binary lookup (src/agent/antigravity/binary.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { resolveAntigravityBinary } from "../src/agent/antigravity/binary.ts";

const HOME = "/home/u";

function resolveWith(executables: string[], env: Record<string, string> = {}, platform: NodeJS.Platform = "linux", homeDir = HOME) {
	const found = new Set(executables);
	return resolveAntigravityBinary({ env, platform, homeDir, isExecutable: (p) => found.has(p) });
}

test("prefers PATH hit", () => {
	const binary = resolveWith(["/usr/bin/antigravity", `${HOME}/.local/bin/antigravity`], { PATH: "/opt/x:/usr/bin" });
	assert.equal(binary, "/usr/bin/antigravity");
});

test("falls back to ~/.local/bin when PATH misses", () => {
	const binary = resolveWith([`${HOME}/.local/bin/antigravity`, "/usr/local/bin/antigravity"], { PATH: "/usr/bin" });
	assert.equal(binary, `${HOME}/.local/bin/antigravity`);
});

test("finds mise-managed antigravity install", () => {
	const misePath = `${HOME}/.local/share/mise/installs/antigravity-cli/latest/antigravity`;
	const binary = resolveWith([misePath], { PATH: "" });
	assert.equal(binary, misePath);
});

test("checks fallback list in expected order", () => {
	const all = [
		`${HOME}/.local/bin/antigravity`,
		`${HOME}/.local/share/mise/shims/antigravity`,
		`${HOME}/.local/share/mise/installs/antigravity-cli/latest/antigravity`,
		`${HOME}/.gemini/antigravity/bin/antigravity`,
		`${HOME}/.config/Antigravity/bin/antigravity`,
		`${HOME}/.npm-global/bin/antigravity`,
		`${HOME}/.nix-profile/bin/antigravity`,
		"/run/current-system/sw/bin/antigravity",
		"/opt/homebrew/bin/antigravity",
		"/usr/local/bin/antigravity",
		"/usr/bin/antigravity",
	];
	for (let i = 0; i < all.length; i++) {
		assert.equal(resolveWith(all.slice(i), { PATH: "" }), all[i]);
	}
});

test("windows finds native antigravity.exe and rejects .cmd", () => {
	const winHome = "C:\\Users\\u";
	const env = { PATH: "C:\\tools;C:\\bin", APPDATA: `${winHome}\\AppData\\Roaming`, LOCALAPPDATA: `${winHome}\\AppData\\Local` };
	assert.equal(resolveWith(["C:\\bin\\antigravity.cmd"], env, "win32", winHome), null);
	assert.equal(resolveWith(["C:\\bin\\antigravity.exe"], env, "win32", winHome), "C:\\bin\\antigravity.exe");
	assert.equal(resolveWith([`${winHome}\\.local\\bin\\antigravity.exe`], env, "win32", winHome), `${winHome}\\.local\\bin\\antigravity.exe`);
});

test("returns null when every location misses", () => {
	assert.equal(resolveWith([], { PATH: "/usr/bin:/bin" }), null);
});
