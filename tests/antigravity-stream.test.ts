import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { createInitialSystemMessage, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { createAntigravityStreamFunction, formatTranscript, type RunAntigravity } from "../src/agent/antigravity/stream.ts";

const TEST_MODEL: Model<"antigravity-cli"> = {
	id: "gemini-3.8-flash-high",
	name: "Gemini 3.8 Flash (High)",
	api: "antigravity-cli",
	provider: "antigravity",
	baseUrl: "",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

function createFakeChild(onWrite: (line: string, child: { stdout: PassThrough; stderr: PassThrough; emitClose: (code: number) => void }) => void) {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const emitter = new EventEmitter() as EventEmitter & {
		stdin: PassThrough;
		stdout: PassThrough;
		stderr: PassThrough;
		killed: boolean;
		kill: () => boolean;
	};
	emitter.stdin = stdin;
	emitter.stdout = stdout;
	emitter.stderr = stderr;
	emitter.killed = false;
	emitter.kill = () => {
		emitter.killed = true;
		return true;
	};

	let buf = "";
	stdin.on("data", (chunk: Buffer | string) => {
		buf += chunk.toString();
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim()) {
				onWrite(line, {
					stdout,
					stderr,
					emitClose: (code: number) => emitter.emit("close", code),
				});
			}
		}
	});

	setImmediate(() => {
		stdout.write(JSON.stringify({ event: "init", conversation_id: "conv_1" }) + "\n");
	});

	return emitter;
}

test("formatTranscript serializes declared LearnHarness tools and trailing Tool Call Reminder", () => {
	const sys = createInitialSystemMessage("Teach calculus", [
		{
			name: "quiz",
			description: "Ask a diagnostic question",
			parameters: { type: "object", properties: { question: { type: "string" } } } as never,
		},
	]);
	const out = formatTranscript([sys!, { role: "user", content: "teach me limits", timestamp: 1 }]);
	assert.match(out, /\[System Instructions\]\nTeach calculus/);
	assert.match(out, /\[LearnHarness Tools\]/);
	assert.match(out, /"name":"quiz"/);
	assert.match(out, /\[user\]\nteach me limits/);
	assert.match(out, /\[Tool Call Reminder\]\nActive LearnHarness tools: quiz\./);

	const outNoTools = formatTranscript([{ role: "user", content: "plain chat", timestamp: 2 }]);
	assert.match(outNoTools, /\[Host CLI Tool Rules\]/);
	assert.doesNotMatch(outNoTools, /\[Tool Call Reminder\]/);
});

test("streams deltas, falls back to result.response, and parses tool_call blocks", async () => {
	const runCli: RunAntigravity = () => createFakeChild((_line, { stdout }) => {
		stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: 'Let me check.\n```tool_call\n{"name":"quiz","arguments":{"question":"What is a limit?"}}\n```', usage: { input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, total_tokens: 30 } } }) + "\n");
	}) as never;

	const streamFn = createAntigravityStreamFunction(runCli);
	const stream = streamFn(TEST_MODEL as never, normalizeContext({ systemPrompt: "Probe", messages: [{ role: "user", content: "hi", timestamp: 1 }] }));
	const final = await stream.result();
	assert.equal(final.stopReason, "toolUse");
	assert.equal(final.content[0]?.type, "text");
	assert.equal(final.content[1]?.type, "toolCall");
	if (final.content[1]?.type === "toolCall") {
		assert.equal(final.content[1].name, "quiz");
		assert.deepEqual(final.content[1].arguments, { question: "What is a limit?" });
	}
	assert.equal(final.usage.output, 20);
});

test("spawns isolated CLI processes per concurrent call and surfaces errors", async () => {
	let spawns = 0;
	const runCli: RunAntigravity = () => {
		const idx = ++spawns;
		return createFakeChild((_line, { stdout }) => {
			if (idx === 1) {
				stdout.write(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "reply-1" } }) + "\n");
				stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }) + "\n");
			} else {
				stdout.write(JSON.stringify({ event: "result", result: { status: "ERROR", error: "model unavailable" } }) + "\n");
			}
		}) as never;
	};

	const streamFn = createAntigravityStreamFunction(runCli);
	const [r1, r2] = await Promise.all([
		streamFn(TEST_MODEL as never, normalizeContext({ messages: [{ role: "user", content: "one", timestamp: 1 }] })).result(),
		streamFn(TEST_MODEL as never, normalizeContext({ messages: [{ role: "user", content: "two", timestamp: 2 }] })).result(),
	]);

	assert.equal(spawns, 2);
	assert.equal(r1.stopReason, "stop");
	assert.deepEqual(r1.content, [{ type: "text", text: "reply-1" }]);
	assert.equal(r2.stopReason, "error");
	assert.equal(r2.errorMessage, "model unavailable");
});

test("formatTranscript serializes image blocks into file attachments", () => {
	const fakePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64").toString("base64");
	const out = formatTranscript([
		{
			role: "user",
			content: [
				{ type: "text", text: "Look at this page:" },
				{ type: "image", data: fakePng, mimeType: "image/png" } as never,
			],
			timestamp: 1,
		},
	]);
	assert.match(out, /Look at this page:/);
	assert.match(out, /\[Attached Image: file:\/\/\/.*learnharness_images\/img_.*\.png \(image\/png\)\]/);
});

test("createAntigravityStreamFunction passes effort flag corresponding to reasoning", async () => {
	let capturedArgs: string[] = [];
	const runCli: RunAntigravity = (args) => {
		capturedArgs = args;
		return createFakeChild((_line, { stdout }) => {
			stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok" } }) + "\n");
		}) as never;
	};

	const streamFn = createAntigravityStreamFunction(runCli);
	await streamFn(
		TEST_MODEL as never,
		normalizeContext({ messages: [{ role: "user", content: "test", timestamp: 1 }] }),
		{ reasoning: "low" } as never
	).result();

	assert.ok(capturedArgs.includes("--effort=low"));
});

test("extracts active LearnHarness tool calls from fallback json fenced blocks", async () => {
	const sys = createInitialSystemMessage("Extract notes", [
		{
			name: "pdf_info",
			description: "Inspect PDF metadata",
			parameters: { type: "object", properties: {} } as never,
		},
	]);
	const runCli: RunAntigravity = () => createFakeChild((_line, { stdout }) => {
		stdout.write(
			JSON.stringify({
				event: "result",
				result: {
					status: "SUCCESS",
					response: '```json\n{"name":"pdf_info","arguments":{}}\n```\nExample data:\n```json\n{"name":"not_a_tool","value":42}\n```',
				},
			}) + "\n"
		);
	}) as never;

	const streamFn = createAntigravityStreamFunction(runCli);
	const final = await streamFn(
		TEST_MODEL as never,
		normalizeContext({ messages: [sys!, { role: "user", content: "read /tmp/a.pdf", timestamp: 1 }] })
	).result();

	assert.equal(final.stopReason, "toolUse");
	const toolCalls = final.content.filter((b) => b.type === "toolCall");
	assert.equal(toolCalls.length, 1);
	assert.equal(toolCalls[0]?.name, "pdf_info");
	assert.deepEqual(toolCalls[0]?.arguments, {});
});
