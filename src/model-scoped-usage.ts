/** Per-model weekly buckets ("Weekly · Fable"), read from a status-line cache.
 *
 * Claude Code's usage control request answers with the five-hour and seven-day
 * windows but leaves `model_scoped` empty (measured on CC 2.1.278, Max plan,
 * on Opus and Fable turns alike). The server does have the row — it is
 * `kind: "weekly_scoped"` on `/api/oauth/usage` — but reaching it needs the
 * OAuth token, and holding that token is exactly what routing through Claude
 * Code avoids.
 *
 * So this reads, never fetches. Claude Code's own status-line script already
 * polls that endpoint and caches the normalized rows; the bridge borrows the
 * result. When the cache goes stale (nothing has rendered a Claude Code status
 * line for a while), the row is dropped rather than shown at a stale value. A
 * configured refresh command is spawned to let that script — which owns the
 * credential — bring its own cache forward.
 */

import { spawn } from "child_process";
import { readFileSync } from "fs";
import { homedir, userInfo } from "os";
import { join } from "path";

export type ModelScopedWindow = { name: string; pct: number; resetsAt?: number };

/** Six hours, matching the ceiling the upstream script puts on its own cache. */
export const DEFAULT_MODEL_USAGE_MAX_AGE_SEC = 21_600;

/** POSIX cksum (CRC-32, polynomial 0x04C11DB7, length folded in), which is what
 *  the upstream script keys its cache filename on. */
function posixCksum(bytes: Uint8Array): number {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i << 24;
		for (let k = 0; k < 8; k++) c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
		table[i] = c >>> 0;
	}
	let crc = 0;
	for (const byte of bytes) crc = ((crc << 8) ^ table[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
	for (let len = bytes.length; len > 0; len >>>= 8) {
		crc = ((crc << 8) ^ table[((crc >>> 24) ^ (len & 0xff)) & 0xff]) >>> 0;
	}
	return (~crc) >>> 0;
}

/** Where the upstream status-line script writes its cache: the config dir's
 *  cksum under a uid-scoped temp dir. */
export function defaultModelUsageCachePath(env: NodeJS.ProcessEnv = process.env): string {
	const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
	const key = posixCksum(Buffer.from(configDir));
	return join("/tmp", `claude-${userInfo().uid}`, `statusline-usage-${key}.json`);
}

export type ModelUsageCache = { fetched_at?: number; scoped?: unknown };

/** Rows from a cache file, or undefined when it is missing, unreadable,
 *  malformed, or older than `maxAgeSec`. Every one of those is ordinary. */
export function readModelScopedUsage(
	path: string,
	now = Date.now(),
	maxAgeSec = DEFAULT_MODEL_USAGE_MAX_AGE_SEC,
): ModelScopedWindow[] | undefined {
	let parsed: ModelUsageCache;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as ModelUsageCache;
	} catch {
		return undefined;
	}
	const fetchedAt = parsed?.fetched_at;
	if (typeof fetchedAt !== "number") return undefined;
	if (now / 1000 - fetchedAt > maxAgeSec) return undefined;
	if (!Array.isArray(parsed.scoped)) return undefined;

	const rows: ModelScopedWindow[] = [];
	for (const entry of parsed.scoped) {
		if (!entry || typeof entry !== "object") continue;
		const row = entry as { name?: unknown; pct?: unknown; resets_at?: unknown };
		if (typeof row.name !== "string" || !row.name) continue;
		if (typeof row.pct !== "number") continue;
		rows.push({
			name: row.name,
			pct: row.pct,
			resetsAt: typeof row.resets_at === "number" ? row.resets_at : undefined,
		});
	}
	return rows.length > 0 ? rows : undefined;
}

let lastRefreshAt = 0;

/** Ask the configured command to refresh the cache it owns. Detached and
 *  throttled: a status line renders far more often than a quota moves, and a
 *  spawn per turn would be a stampede for a number that changes by the hour. */
export function requestModelUsageRefresh(command: string | undefined, minIntervalMs = 60_000, now = Date.now()): boolean {
	if (!command) return false;
	if (now - lastRefreshAt < minIntervalMs) return false;
	lastRefreshAt = now;
	try {
		const child = spawn(command, { shell: true, detached: true, stdio: "ignore" });
		child.unref();
		return true;
	} catch {
		return false;
	}
}

/** Test seam: the throttle is module state, so a suite that exercises it needs
 *  a way back to a known point. */
export function resetModelUsageRefreshThrottle(): void {
	lastRefreshAt = 0;
}
