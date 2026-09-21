#!/usr/bin/env node

/**
 * Per-model weekly buckets, borrowed from Claude Code's status-line cache.
 *
 * The cache belongs to another program, so every read is defensive: it may be
 * absent, half-written, or hours old. A stale number is worse than no number
 * here — the whole point of the row is to say how much quota is left right now.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
	defaultModelUsageCachePath,
	readModelScopedUsage,
	requestModelUsageRefresh,
	resetModelUsageRefreshThrottle,
	DEFAULT_MODEL_USAGE_MAX_AGE_SEC,
} = await import("../src/model-scoped-usage.js");

const NOW = 1_790_000_000_000;

function withCache(contents, run) {
	const dir = mkdtempSync(join(tmpdir(), "claude-bridge-usage-"));
	const path = join(dir, "statusline-usage.json");
	if (contents !== undefined) writeFileSync(path, contents);
	try {
		return run(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const cacheFor = (rows, ageSec = 0) =>
	JSON.stringify({ fetched_at: NOW / 1000 - ageSec, scoped: rows });

describe("readModelScopedUsage", () => {
	it("reads the rows the upstream script normalized", () => {
		withCache(cacheFor([{ name: "Fable", pct: 78, resets_at: 1_790_056_800 }]), (path) => {
			assert.deepEqual(readModelScopedUsage(path, NOW), [
				{ name: "Fable", pct: 78, resetsAt: 1_790_056_800 },
			]);
		});
	});

	it("drops rows once the cache passes its age ceiling", () => {
		const rows = [{ name: "Fable", pct: 78 }];
		withCache(cacheFor(rows, DEFAULT_MODEL_USAGE_MAX_AGE_SEC - 1), (path) => {
			assert.equal(readModelScopedUsage(path, NOW)?.length, 1, "just inside the window still reports");
		});
		withCache(cacheFor(rows, DEFAULT_MODEL_USAGE_MAX_AGE_SEC + 1), (path) => {
			assert.equal(readModelScopedUsage(path, NOW), undefined, "past it reports nothing");
		});
	});

	it("honors a caller's tighter age ceiling", () => {
		withCache(cacheFor([{ name: "Fable", pct: 78 }], 600), (path) => {
			assert.equal(readModelScopedUsage(path, NOW, 300), undefined);
			assert.equal(readModelScopedUsage(path, NOW, 900)?.length, 1);
		});
	});

	it("treats a missing, truncated, or foreign-shaped cache as no data", () => {
		assert.equal(readModelScopedUsage(join(tmpdir(), "definitely-absent.json"), NOW), undefined);
		withCache('{"fetched_at": 179000', (path) => {
			assert.equal(readModelScopedUsage(path, NOW), undefined, "half-written file");
		});
		withCache(JSON.stringify({ scoped: [{ name: "Fable", pct: 78 }] }), (path) => {
			assert.equal(readModelScopedUsage(path, NOW), undefined, "no fetched_at to age against");
		});
		withCache(JSON.stringify({ fetched_at: NOW / 1000, scoped: "Fable" }), (path) => {
			assert.equal(readModelScopedUsage(path, NOW), undefined, "scoped is not a list");
		});
	});

	it("skips individual rows that carry no usable number", () => {
		const rows = [
			{ name: "Fable", pct: 78 },
			{ name: "", pct: 10 },
			{ name: "Opus", pct: null },
			{ pct: 5 },
			null,
		];
		withCache(cacheFor(rows), (path) => {
			assert.deepEqual(readModelScopedUsage(path, NOW), [{ name: "Fable", pct: 78, resetsAt: undefined }]);
		});
	});

	it("reports nothing when every row was skipped", () => {
		withCache(cacheFor([{ name: "Opus", pct: null }]), (path) => {
			assert.equal(readModelScopedUsage(path, NOW), undefined);
		});
	});
});

describe("defaultModelUsageCachePath", () => {
	it("keys the filename the way the upstream script does", () => {
		// POSIX cksum of the config dir. Verified against `cksum` on the real
		// path: /tmp/claude-<uid>/statusline-usage-1075097141.json
		const path = defaultModelUsageCachePath({ CLAUDE_CONFIG_DIR: "/Users/taylor/.claude" });
		assert.match(path, /\/statusline-usage-1075097141\.json$/);
	});

	it("follows CLAUDE_CONFIG_DIR to a different cache", () => {
		const a = defaultModelUsageCachePath({ CLAUDE_CONFIG_DIR: "/Users/taylor/.claude" });
		const b = defaultModelUsageCachePath({ CLAUDE_CONFIG_DIR: "/Users/taylor/.claude-work" });
		assert.notEqual(a, b);
	});
});

describe("requestModelUsageRefresh", () => {
	it("does nothing without a configured command", () => {
		resetModelUsageRefreshThrottle();
		assert.equal(requestModelUsageRefresh(undefined), false);
	});

	it("spawns once, then throttles until the interval passes", () => {
		resetModelUsageRefreshThrottle();
		assert.equal(requestModelUsageRefresh("true", 60_000, NOW), true);
		assert.equal(requestModelUsageRefresh("true", 60_000, NOW + 59_000), false, "a status line renders far more often than a quota moves");
		assert.equal(requestModelUsageRefresh("true", 60_000, NOW + 61_000), true);
	});
});
