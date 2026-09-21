// User-facing extension config. Loaded once at extension registration from
// the active host's global agent dir. Pi also supports project overrides.
// OMP project overrides stay disabled until its extension API exposes the
// project-trust decision, so an untrusted repository cannot replace the
// Claude executable or enable native Claude hooks.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export type ClaudeSettingSource = "user" | "project" | "local";

export interface Config {
	/** Date (YYYY-MM-DD) the one-time startup notice was shown. Written by the extension, not the user. */
	startupNoticeShown?: string;
	askClaude?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		defaultIsolated?: boolean;
		allowFullMode?: boolean;
		appendSkills?: boolean;
	};
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		strictMcpConfig?: boolean;
		autoMemoryEnabled?: boolean;
		pathToClaudeCodeExecutable?: string;
		// Subscription plan tier. Setting to "max" enables Opus 4.6 at 1M context
		plan?: "pro" | "max";
		// Set to true to opt into metered 1M context usage ("extra usage" in
		// Anthropic billing). Enables Sonnet 4.6 [1m] on every plan and Opus 4.6
		// [1m] on Pro.
		longContextExtraUsage?: boolean;
		// Model ids (e.g. "claude-future-9") whose declared 1M context Claude Code
		// does not actually serve; pins them to the bare id at 200K.
		forceTwoHundredK?: string[];
		settingSources?: ClaudeSettingSource[];
	};
	/** The plan-usage readout published to the host status line. */
	statusUsage?: {
		// Cells per usage bar; 0 renders percentages without bars.
		barWidth?: number;
		// Cache file holding per-model weekly buckets, as written by Claude
		// Code's own status-line script. Defaults to that script's path.
		modelCachePath?: string;
		// Stop reporting per-model buckets once the cache is this old.
		modelMaxAgeSec?: number;
		// Shell command that refreshes the cache above; spawned detached and
		// throttled when the cache is stale. It, not the bridge, holds the
		// credential that endpoint needs.
		modelRefreshCommand?: string;
	};
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function claudeCodeSettings(provider: Config["provider"] = {}): { autoMemoryEnabled: boolean } {
	return { autoMemoryEnabled: provider.autoMemoryEnabled ?? false };
}

export function globalConfigPath(): string {
	return join(getAgentDir(), "claude-bridge.json");
}

export function isOmpAgentDir(agentDir: string): boolean {
	return agentDir.split(/[\\/]/).includes(".omp");
}

export function claudeCodeSettingSources(
	provider: Config["provider"] = {},
	agentDir = getAgentDir(),
): ClaudeSettingSource[] | undefined {
	return provider.settingSources ?? (isOmpAgentDir(agentDir) ? [] : undefined);
}

/** Record today's date in the global config so the startup notice shows once, preserving every
 *  other field. Returns the config path for display either way.
 *
 *  Parses directly rather than through tryParseJson, which reports an unparseable file as `{}`:
 *  spreading that would replace a user's whole config with just this marker the first time they
 *  leave a trailing comma in it. Losing the notice is the cheaper failure, so the write is
 *  skipped and the notice simply shows again next session. */
export function markStartupNoticeShown(): string {
	const path = globalConfigPath();
	let existing: Partial<Config> = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf-8"));
		} catch (e) {
			console.error(`claude-bridge: leaving ${path} alone, it does not parse: ${e}`);
			return path;
		}
	}
	// en-CA renders YYYY-MM-DD in local time; toISOString() would report UTC.
	const next = { ...existing, startupNoticeShown: new Date().toLocaleDateString("en-CA") };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	return path;
}

export function loadConfig(cwd: string): Config {
	const agentDir = getAgentDir();
	const global = tryParseJson(join(agentDir, "claude-bridge.json"));
	const project = isOmpAgentDir(agentDir)
		? {}
		: tryParseJson(join(cwd, ".pi", "claude-bridge.json"));
	return {
		startupNoticeShown: project.startupNoticeShown ?? global.startupNoticeShown,
		askClaude: { ...global.askClaude, ...project.askClaude },
		provider: { ...global.provider, ...project.provider },
		statusUsage: { ...global.statusUsage, ...project.statusUsage },
	};
}
