import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type JsonObject,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
	type Tool,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

import { externalCliEnv } from "../../core/auth-env.ts";
import { getAntigravityBinary } from "./binary.ts";
import { AntigravityError } from "./constants.ts";

export type RunAntigravity = (
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }
) => ChildProcessWithoutNullStreams | Promise<ChildProcessWithoutNullStreams | null> | null;

export const defaultRunAntigravity: RunAntigravity = (args, options) => {
	const binary = getAntigravityBinary();
	if (!binary) return null;
	return spawn(binary, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: "pipe",
	});
};

function formatToolsSection(tools: readonly Tool[]): string {
	if (tools.length === 0) {
		return [
			"[Host CLI Tool Rules]",
			"No LearnHarness tools are active for this turn.",
			"Do NOT call any of your built-in CLI/workspace tools (such as run_command, view_file, read_file, list_dir, find_by_name, grep_search, ask_question, finish, etc.). Answer directly in plain text/Markdown.",
		].join("\n");
	}

	const toolDefs = tools.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.parameters,
	}));

	return [
		"[LearnHarness Tools]",
		"You are running inside LearnHarness. Ignore your built-in host CLI tools (such as run_command, view_file, read_file, list_dir, find_by_name, grep_search, ask_question, finish, etc.) — they are blocked in headless mode and LearnHarness cannot observe them.",
		"Whenever you need to invoke a LearnHarness tool, output one or more fenced tool_call JSON blocks and then STOP your message immediately so LearnHarness can execute them and send back [tool result] messages:",
		"```tool_call",
		'{"name": "<tool_name>", "arguments": { ... }}',
		"```",
		"Available LearnHarness tools:",
		JSON.stringify(toolDefs),
	].join("\n");
}

function mimeToExtension(mimeType: string): string {
	switch (mimeType.toLowerCase()) {
		case "image/png":
			return "png";
		case "image/jpeg":
		case "image/jpg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return "png";
	}
}

function saveImageToDisk(data: string, mimeType: string): string | null {
	try {
		const dir = join(tmpdir(), "learnharness_images");
		mkdirSync(dir, { recursive: true });
		const ext = mimeToExtension(mimeType);
		const filePath = join(dir, `img_${Date.now()}_${nanoid(6)}.${ext}`);
		const buffer = Buffer.from(data, "base64");
		writeFileSync(filePath, buffer);
		return filePath;
	} catch {
		return null;
	}
}

function formatContentBlock(block: { type: string; text?: string; data?: string; mimeType?: string }): string {
	if (block.type === "text" && typeof block.text === "string") {
		return block.text;
	}
	if (block.type === "image" && typeof block.data === "string") {
		const filePath = saveImageToDisk(block.data, block.mimeType || "image/png");
		if (filePath) {
			return `[Attached Image: file://${filePath} (${block.mimeType || "image/png"})]`;
		}
		return `[Attached Image (${block.mimeType || "image/png"})]`;
	}
	return "";
}

function getMergedTools(messages: Message[], extraTools: readonly Tool[] = []): Tool[] {
	const transcriptTools = getCurrentTools(messages);
	return extraTools.length > 0
		? [...transcriptTools, ...extraTools.filter((t) => !transcriptTools.some((existing) => existing.name === t.name))]
		: [...transcriptTools];
}

export function formatTranscript(messages: Message[], extraTools: readonly Tool[] = []): string {
	const lines: string[] = [];
	const system = getCurrentSystemPrompt(messages);
	if (system) {
		lines.push(`[System Instructions]\n${system}`);
	}

	const mergedTools = getMergedTools(messages, extraTools);
	lines.push(formatToolsSection(mergedTools));

	for (const msg of messages) {
		if (msg.role === "system") continue;
		if (msg.role === "user") {
			const text = typeof msg.content === "string"
				? msg.content
				: msg.content.map(formatContentBlock).filter(Boolean).join("\n");
			lines.push(`[user]\n${text}`);
		} else if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "text") {
					lines.push(`[assistant]\n${block.text}`);
				} else if (block.type === "toolCall") {
					lines.push(`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`);
				}
			}
		} else if (msg.role === "toolResult") {
			const label = msg.isError ? `[tool result ${msg.toolName} error]` : `[tool result ${msg.toolName}]`;
			const text = typeof msg.content === "string"
				? msg.content
				: msg.content.map(formatContentBlock).filter(Boolean).join("\n");
			lines.push(`${label}\n${text}`);
		}
	}

	if (mergedTools.length > 0) {
		const toolNames = mergedTools.map((t) => t.name).join(", ");
		lines.push(
			[
				"[Tool Call Reminder]",
				`Active LearnHarness tools: ${toolNames}.`,
				"CRITICAL: Never invoke built-in host CLI tools (such as run_command, read_file, view_file, list_dir, find_by_name, grep_search, ask_question, or finish). Even when given a local file path or PDF path, you MUST use the active LearnHarness tools above by outputting a fenced ```tool_call JSON block and stopping immediately.",
			].join("\n")
		);
	}

	return lines.join("\n\n");
}

const TOOL_CALL_REGEX = /```tool_call\s*\n?([\s\S]*?)\s*\n?```/g;
const JSON_BLOCK_REGEX = /```json\s*\n?([\s\S]*?)\s*\n?```/g;

function parseToolCallJson(
	rawJson: string,
	allowedToolNames?: ReadonlySet<string>,
	requireAllowed = false
): ToolCall | null {
	try {
		const parsed = JSON.parse(rawJson) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		if (typeof parsed.name !== "string" || parsed.name.length === 0) return null;
		if (requireAllowed && (!allowedToolNames || !allowedToolNames.has(parsed.name))) return null;
		if (requireAllowed && !("arguments" in parsed) && !("args" in parsed)) return null;
		const rawArgs = parsed.arguments ?? parsed.args ?? {};
		const args: JsonObject = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
			? (rawArgs as JsonObject)
			: {};
		return {
			type: "toolCall",
			id: `call_${nanoid(12)}`,
			name: parsed.name,
			arguments: args,
		};
	} catch {
		return null;
	}
}

function collectToolCalls(
	text: string,
	regex: RegExp,
	allowedToolNames: ReadonlySet<string> | undefined,
	requireAllowed: boolean
): { cleanText: string; toolCalls: ToolCall[] } {
	const toolCalls: ToolCall[] = [];
	let cleanText = text;
	for (const match of text.matchAll(regex)) {
		const rawJson = match[1]?.trim();
		if (!rawJson) continue;
		const call = parseToolCallJson(rawJson, allowedToolNames, requireAllowed);
		if (call) {
			toolCalls.push(call);
			cleanText = cleanText.replace(match[0], "").trim();
		}
	}
	return { cleanText, toolCalls };
}

function extractToolCalls(text: string, allowedToolNames?: ReadonlySet<string>): { cleanText: string; toolCalls: ToolCall[] } {
	const primary = collectToolCalls(text, TOOL_CALL_REGEX, allowedToolNames, false);
	const fallback = collectToolCalls(primary.cleanText, JSON_BLOCK_REGEX, allowedToolNames, true);
	return {
		cleanText: fallback.cleanText,
		toolCalls: [...primary.toolCalls, ...fallback.toolCalls],
	};
}

function toAntigravityEffort(reasoning?: string): string {
	if (!reasoning || reasoning === "off" || reasoning === "minimal" || reasoning === "low") {
		return "low";
	}
	if (reasoning === "medium") return "medium";
	if (reasoning === "high") return "high";
	if (reasoning === "xhigh") return "xhigh";
	if (reasoning === "max") return "max";
	return "low";
}

export function createAntigravityStreamFunction(
	runCli: RunAntigravity = defaultRunAntigravity
): StreamFunction<Api, SimpleStreamOptions> {
	return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
		const stream = createAssistantMessageEventStream();
		const messages = context.messages;
		const extraTools = (context as TranscriptContext & { tools?: Tool[] }).tools ?? [];
		const allowedToolNames = new Set(getMergedTools(messages, extraTools).map((t) => t.name));

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		const execute = async () => {
			if (options?.signal?.aborted) {
				output.stopReason = "aborted";
				stream.end(output);
				return;
			}

			const reasoning = (options as { reasoning?: string } | undefined)?.reasoning;
			const effort = toAntigravityEffort(reasoning);

			// Spawn an isolated process per turn: LearnHarness runs chat turns and background
			// extraction/auditor jobs concurrently on the same model ID, so sharing one child
			// process interleaves stdin/stdout streams and locks the CLI trajectory DB.
			const args = [
				"--input-format=stream-json",
				"--output-format=stream-json",
				`--model=${model.id}`,
				`--effort=${effort}`,
				"--disable-slash-commands",
				"--print=",
			];

			const child = await runCli(args, {
				cwd: tmpdir(),
				env: { ...externalCliEnv() },
				signal: options?.signal,
			});

			if (!child) {
				output.stopReason = "error";
				output.errorMessage = AntigravityError.StartupFailed;
				output.content = [{ type: "text", text: AntigravityError.StartupFailed }];
				stream.end(output);
				return;
			}

			let accumulatedText = "";
			let streamStarted = false;
			let isResolved = false;
			let promptSent = false;
			const stderrChunks: string[] = [];

			const cleanupChild = () => {
				if (!child.killed) {
					try {
						child.stdin.end();
					} catch {
						// Ignore closed stdin
					}
					child.kill("SIGTERM");
				}
			};

			const rl = createInterface({ input: child.stdout });

			const appendDelta = (delta: string) => {
				if (!delta) return;
				if (!streamStarted) {
					streamStarted = true;
					stream.push({ type: "start", partial: output });
				}
				accumulatedText += delta;
				output.content = [{ type: "text", text: accumulatedText }];
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta,
					partial: output,
				});
			};

			const finishTurn = (stopReason: "stop" | "toolUse" | "error" | "aborted", errorDetail?: string) => {
				if (isResolved) return;
				isResolved = true;
				options?.signal?.removeEventListener("abort", abortHandler);
				rl.close();
				cleanupChild();

				const { cleanText, toolCalls } = extractToolCalls(accumulatedText, allowedToolNames);
				if (toolCalls.length > 0 && stopReason !== "error" && stopReason !== "aborted") {
					output.content = [
						...(cleanText ? [{ type: "text" as const, text: cleanText }] : []),
						...toolCalls,
					];
					output.stopReason = "toolUse";
					stream.end(output);
					return;
				}

				if (stopReason === "error") {
					const message = errorDetail || accumulatedText.trim() || stderrChunks.join("").trim() || "Antigravity CLI turn failed";
					output.errorMessage = message;
					output.content = [{ type: "text", text: message }];
					output.stopReason = "error";
					stream.end(output);
					return;
				}

				output.content = [{ type: "text", text: accumulatedText }];
				output.stopReason = stopReason;
				stream.end(output);
			};

			const abortHandler = () => {
				finishTurn("aborted");
			};
			options?.signal?.addEventListener("abort", abortHandler, { once: true });

			const sendPrompt = () => {
				if (promptSent) return;
				promptSent = true;
				const prompt = formatTranscript(messages, extraTools);
				const inputMsg = JSON.stringify({
					event: "user",
					message: { content: prompt },
				}) + "\n";
				child.stdin.write(inputMsg);
			};

			child.stderr.on("data", (chunk: Buffer | string) => {
				stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
			});

			rl.on("line", (line) => {
				const trimmed = line.trim();
				if (!trimmed) return;

				try {
					const data = JSON.parse(trimmed) as {
						event?: string;
						step_update?: { step_type?: string; text_delta?: string; text?: string; state?: string };
						result?: {
							status?: string;
							response?: string;
							error?: string;
							usage?: {
								input_tokens?: number;
								output_tokens?: number;
								cache_read_tokens?: number;
								total_tokens?: number;
							};
						};
					};

					if (data.event === "init") {
						sendPrompt();
						return;
					}

					if (data.event === "step_update" && data.step_update) {
						const su = data.step_update;
						if (su.step_type === "agent_response" && typeof su.text_delta === "string" && su.text_delta) {
							appendDelta(su.text_delta);
						}
						return;
					}

					if (data.event === "result" && data.result) {
						const res = data.result;
						if (res.usage) {
							output.usage = {
								input: res.usage.input_tokens ?? 0,
								output: res.usage.output_tokens ?? 0,
								cacheRead: res.usage.cache_read_tokens ?? 0,
								cacheWrite: 0,
								totalTokens: res.usage.total_tokens ?? 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							};
						}
						// Fallback when Antigravity returns the final text only in result.response
						if (!accumulatedText && typeof res.response === "string" && res.response.trim()) {
							appendDelta(res.response);
						}
						if (res.status === "ERROR") {
							finishTurn("error", res.error || undefined);
						} else {
							finishTurn("stop");
						}
					}
				} catch {
					// Ignore non-JSON stderr/log lines mixed into stdout unless the turn errors
					if (!trimmed.startsWith("{") && /^error:\s*/i.test(trimmed)) {
						stderrChunks.push(trimmed);
					}
				}
			});

			child.on("error", (err) => {
				finishTurn("error", `Antigravity error: ${err.message}`);
			});

			child.on("close", (code) => {
				if (!isResolved) {
					finishTurn(code === 0 ? "stop" : "error");
				}
			});
		};

		void execute();
		return stream;
	};
}

export const streamAntigravity = createAntigravityStreamFunction();
