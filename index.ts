import { contentText, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TITLE_PROMPT } from "./prompt.ts";

const MAX_PROMPT_CHARS = 2000;
const MAX_TITLE_CHARS = 100;
const MAX_RETITLE_INPUT_CHARS = 8000;
const RECENT_HEADER = "\n\nRecent conversation:\n";

/** Bounded so a slow or unreachable provider cannot stall the end of the first turn. */
const GENERATION_TIMEOUT_MS = 15000;

/** Sessions already handled, so later turns in the same run never regenerate a title. */
const handledSessions = new Set<string>();

/** First user prompt captured in `before_agent_start`, consumed by the matching `agent_end`. */
const pendingPrompts = new Map<string, string>();

export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType !== "user") return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (handledSessions.has(sessionId) || pendingPrompts.has(sessionId)) return;
		if (pi.getSessionName()) return;
		// A resumed or continuing session already carries a user message on the active branch;
		// the prompt for the run that is starting is appended after this event fires.
		if (ctx.sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user")) return;
		pendingPrompts.set(sessionId, event.prompt);
	});

	pi.on("agent_end", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const prompt = pendingPrompts.get(sessionId);
		if (prompt === undefined) return;
		pendingPrompts.delete(sessionId);
		handledSessions.add(sessionId);

		const title = await generateTitle(ctx, normalizeInput(prompt, MAX_PROMPT_CHARS));
		if (!title) return;
		// The user or another extension may have named the session while the model call ran.
		if (pi.getSessionName()) return;
		pi.setSessionName(title);
	});

	pi.on("session_shutdown", () => {
		handledSessions.clear();
		pendingPrompts.clear();
	});

	pi.registerCommand("retitle", {
		description: "Regenerate the session title from the conversation",
		handler: async (args, ctx) => {
			const input = buildRetitleInput(ctx, args);
			if (!input) {
				ctx.ui.notify("Nothing to generate a title from yet.", "warning");
				return;
			}
			const title = await generateTitle(ctx, input);
			if (!title) {
				ctx.ui.notify("Could not generate a session title.", "warning");
				return;
			}
			// Overwriting is the point of /retitle, so this path has no existing-name guard.
			pi.setSessionName(title);
			ctx.ui.notify(`Session title: ${title}`, "info");
		},
	});
}

/** Collapse whitespace and clip to `maxChars`; keeps model input bounded and single-line safe. */
function normalizeInput(text: string, maxChars: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > maxChars ? collapsed.slice(0, maxChars) : collapsed;
}

/** Ask the session's current model for a title. Returns "" on any failure; the caller keeps the fallback. */
async function generateTitle(ctx: ExtensionContext, input: string): Promise<string> {
	// ctx.signal is absent or already settling at agent_end, so bound the nested call ourselves.
	const signal = AbortSignal.timeout(GENERATION_TIMEOUT_MS);
	// "off" is not a member of ThinkingLevel, so "minimal" is the lowest effort the type allows.
	const title = await streamTitle(ctx, input, { reasoning: "minimal", signal });
	if (title) return title;
	// Some providers reject low reasoning-effort values, so retry once with the option dropped.
	return streamTitle(ctx, input, { signal });
}

async function streamTitle(ctx: ExtensionContext, input: string, options: ModelsSimpleStreamOptions): Promise<string> {
	const model = ctx.model;
	if (!model) return "";
	try {
		const message = await ctx.modelRegistry
			.streamSimple(
				model,
				{
					systemPrompt: TITLE_PROMPT,
					messages: [{ role: "user", content: input, timestamp: Date.now() }],
				},
				options,
			)
			.result();
		if (message.stopReason === "error" || message.stopReason === "aborted") return "";
		return cleanTitle(contentText(message.content));
	} catch {
		return "";
	}
}

/** Model output is free-form: keep the first non-empty line, without quotes or a "Title:" prefix. */
function cleanTitle(raw: string): string {
	for (const line of raw.split("\n")) {
		const title = unquote(unquote(line.trim()).replace(/^title\s*:\s*/i, ""));
		if (!title) continue;
		return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 3)}...` : title;
	}
	return "";
}

function unquote(value: string): string {
	return value
		.replace(/^["'`\u201c\u201d\u2018\u2019]+/, "")
		.replace(/["'`\u201c\u201d\u2018\u2019]+$/, "")
		.trim();
}

/** OpenCode-style re-titling input: the original request plus the tail of the recent conversation. */
function buildRetitleInput(ctx: ExtensionContext, hint: string): string {
	const turns: string[] = [];
	let firstUserMessage: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "user") {
			const text = contentText(entry.message.content);
			if (firstUserMessage === undefined) {
				firstUserMessage = text;
				continue;
			}
			turns.push(`User: ${normalizeInput(text, MAX_PROMPT_CHARS)}`);
		} else if (entry.message.role === "assistant") {
			const text = normalizeInput(contentText(entry.message.content), MAX_PROMPT_CHARS);
			if (text) turns.push(`Assistant: ${text}`);
		}
	}
	if (!firstUserMessage) return "";

	const header = `Original request:\n${normalizeInput(firstUserMessage, MAX_PROMPT_CHARS)}`;
	const instruction = hint.trim() ? `\n\nTitle instruction: ${normalizeInput(hint, MAX_PROMPT_CHARS)}` : "";
	let used = header.length + instruction.length;

	// Keep the original request and the newest turns: drop from the front until the blob fits.
	const recent: string[] = [];
	for (let i = turns.length - 1; i >= 0; i--) {
		used += turns[i].length + 1;
		if (used > MAX_RETITLE_INPUT_CHARS) break;
		recent.unshift(turns[i]);
	}

	return recent.length ? `${header}${RECENT_HEADER}${recent.join("\n")}${instruction}` : `${header}${instruction}`;
}
