/**
 * Translate pi's transcript-shaped provider input into the prompt/tools fields used by
 * the bridge's downstream consumers.
 *
 * System messages carry the base prompt and tool set plus later section patches and tool
 * deltas. pi-ai replays that state, but preserves section replay order. Prompt capture
 * keys come from pi's canonical section builder, so a deleted and re-added section must
 * be ranked back into canonical order before the bridge performs its exact-key lookup.
 *
 * OMP's pi-ai is a fork on its own version line and ships none of the three replay
 * helpers, so importing them by name fails the module link outright ("Export named
 * 'contentText' not found") and the extension does not load at all. They are read off
 * the namespace instead and fall back to the replay this module vendored before
 * upstream adopted them. Which side answers is not cosmetic: the rendered prompt has
 * to be byte-identical to that host's own `ctx.getSystemPrompt()`, or prompt capture's
 * exact-key lookup throws on a legitimate turn.
 */
import * as piAi from "@earendil-works/pi-ai";
import type { Context, SystemMessage, Tool } from "@earendil-works/pi-ai";

/** Anything with a role — lets us test `role === "system"` without tripping TS2367. */
type Roled = { role?: string };

type TranscriptSystemMessage = SystemMessage & {
	sections?: Record<string, string | null>;
	toolsAdded?: Tool[];
	toolsRemoved?: { name: string }[];
};

type ReplayHelpers = {
	contentText?: (content: SystemMessage["content"]) => string;
	getCurrentSystemMessage?: (messages: readonly Roled[]) => SystemMessage | undefined;
	getCurrentTools?: (messages: readonly Roled[]) => Tool[];
};
const hostPiAi = piAi as ReplayHelpers;

/** Render message content as text (pi-ai `contentText`). */
function vendoredContentText(content: SystemMessage["content"]): string {
	if (typeof content === "string") return content;
	return (content as { type: string; text: string }[])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function contentText(content: SystemMessage["content"]): string {
	return hostPiAi.contentText ? hostPiAi.contentText(content) : vendoredContentText(content);
}

/** pi's canonical built-in section order; custom sections follow their replay position. */
const SECTION_RANK = new Map<string, number>([
	["preamble", 0], ["tools", 1], ["rules", 2], ["docs", 3], ["addendum", 4],
	["project_context", 5], ["skills", 6], ["cwd", 7],
]);

/**
 * The map's entries, stably sorted by canonical rank. A name absent from the rank table
 * inherits its replayed predecessor's rank, so an already-canonical replay remains
 * unchanged and custom sections retain their position.
 */
function stableRanked(sections: Map<string, string>, ranks: Map<string, number>): Map<string, string> {
	let predecessorRank = -1;
	const ranked = [...sections].map(([name, value]) => {
		const rank = ranks.get(name) ?? predecessorRank;
		predecessorRank = rank;
		return { name, value, rank };
	});
	ranked.sort((a, b) => a.rank - b.rank);
	return new Map(ranked.map(({ name, value }) => [name, value]));
}

/** Render replayed system state in the same section order as pi's prompt builder. */
function canonicalSystemPrompt(message: SystemMessage | undefined): string | undefined {
	if (!message) return undefined;
	const sections = new Map<string, string>(
		Object.entries(message.sections ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
	);
	const parts = [contentText(message.content), ...stableRanked(sections, SECTION_RANK).values()]
		.filter((part) => part.length > 0);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Replay transcript system messages into the 0.85 fields they replaced.
 *
 * The vendored fold mirrors pi-ai's `getCurrentSystemMessage` + `getCurrentTools`:
 * content pieces concatenate in message order, sections merge by name (a later value
 * replaces an earlier one, `null` deletes), tools resolve in first-declaration order
 * with removals applied.
 */
export function vendoredReplay(messages: readonly Roled[]): { systemPrompt: string | undefined; tools: Tool[] | undefined } {
	const content: string[] = [];
	const sections = new Map<string, string>();
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		const system = message as TranscriptSystemMessage;
		const text = contentText(system.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(system.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
		for (const removed of system.toolsRemoved ?? []) tools.delete(removed.name);
		for (const added of system.toolsAdded ?? []) tools.set(added.name, added);
	}
	const parts = [...content, ...stableRanked(sections, SECTION_RANK).values()].filter((part) => part.length > 0);
	return {
		systemPrompt: parts.length > 0 ? parts.join("\n\n") : undefined,
		tools: tools.size > 0 ? [...tools.values()] : undefined,
	};
}

function replaySystemState(messages: readonly Roled[]): { systemPrompt: string | undefined; tools: Tool[] | undefined } {
	if (!hostPiAi.getCurrentSystemMessage || !hostPiAi.getCurrentTools) return vendoredReplay(messages);
	const tools = hostPiAi.getCurrentTools(messages);
	return {
		systemPrompt: canonicalSystemPrompt(hostPiAi.getCurrentSystemMessage(messages)),
		tools: tools.length > 0 ? tools : undefined,
	};
}

/**
 * Restore the prompt and tools fields expected by the bridge and remove prompt-state
 * messages from conversation history. Contexts without system messages are returned
 * unchanged because systemless one-off calls already use the bridge-compatible shape.
 */
export function toBridgeContext(context: Context): Context {
	if (!context.messages.some((message) => message.role === "system")) return context;
	const { systemPrompt, tools } = replaySystemState(context.messages);
	return {
		...context,
		systemPrompt,
		tools,
		messages: nonSystemMessages(context.messages),
	};
}

/** `messages` with every prompt-state system message removed from conversation history. */
export function nonSystemMessages<T extends { role: string }>(messages: readonly T[]): T[] {
	return messages.filter((message) => message.role !== "system");
}
