#!/usr/bin/env node

/**
 * The on-disk copy of the last plan reading.
 *
 * It exists so a session can show its usage rows before running a turn: the
 * windows only come from a warm query, and asking a cold one would mean sending
 * a real request — spending quota to display quota.
 *
 * What it must never do is present a number about a window that has since
 * rolled over. `resets_at` is absolute, so a reset in the past means the cached
 * utilization belongs to a window that no longer exists, and the clock alone
 * cannot catch that: a reading taken two minutes before a five-hour reset is
 * fresh by age and wrong by content.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
	readCachedPlanUsage,
	writeCachedPlanUsage,
	DEFAULT_PLAN_CACHE_MAX_AGE_SEC,
} = await import("../src/plan-usage.js");

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const inMinutes = (n) => new Date(NOW + n * 60_000).toISOString();

/** A reader over a literal, so these tests touch no filesystem. */
const reader = (contents) => () => {
	if (contents === undefined) throw new Error("ENOENT");
	return contents;
};
const cacheOf = (rateLimits, ageSec = 0, tier = "max") =>
	JSON.stringify({
		fetched_at: NOW / 1000 - ageSec,
		response: { subscription_type: tier, rate_limits: rateLimits },
	});

describe("readCachedPlanUsage", () => {
	it("returns the windows still running, with the tier", () => {
		const cache = cacheOf({
			five_hour: { utilization: 21, resets_at: inMinutes(100) },
			seven_day: { utilization: 88, resets_at: inMinutes(29 * 60) },
		}, 120);
		const got = readCachedPlanUsage("ignored", reader(cache), NOW);
		assert.equal(got.subscription_type, "max");
		assert.equal(got.rate_limits.five_hour.utilization, 21);
		assert.equal(got.rate_limits.seven_day.utilization, 88);
	});

	it("drops a window whose reset has passed, keeping the one that has not", () => {
		// The five-hour window rolled over while the session was closed: its 21%
		// describes a window that no longer exists.
		const cache = cacheOf({
			five_hour: { utilization: 21, resets_at: inMinutes(-5) },
			seven_day: { utilization: 88, resets_at: inMinutes(29 * 60) },
		});
		const got = readCachedPlanUsage("ignored", reader(cache), NOW);
		assert.equal(got.rate_limits.five_hour, undefined);
		assert.equal(got.rate_limits.seven_day.utilization, 88);
	});

	it("reports nothing when every window has rolled over", () => {
		const cache = cacheOf({ five_hour: { utilization: 21, resets_at: inMinutes(-5) } });
		assert.equal(readCachedPlanUsage("ignored", reader(cache), NOW), undefined);
	});

	it("drops a window that cannot be placed in time at all", () => {
		const cache = cacheOf({
			five_hour: { utilization: 21 },
			seven_day: { utilization: 88, resets_at: "not a date" },
		});
		assert.equal(readCachedPlanUsage("ignored", reader(cache), NOW), undefined);
	});

	it("stops reporting past the age ceiling", () => {
		const live = { seven_day: { utilization: 88, resets_at: inMinutes(60 * 24 * 30) } };
		assert.ok(readCachedPlanUsage("ignored", reader(cacheOf(live, DEFAULT_PLAN_CACHE_MAX_AGE_SEC - 1)), NOW));
		assert.equal(readCachedPlanUsage("ignored", reader(cacheOf(live, DEFAULT_PLAN_CACHE_MAX_AGE_SEC + 1)), NOW), undefined);
	});

	it("treats a missing, truncated or foreign file as no data", () => {
		assert.equal(readCachedPlanUsage("ignored", reader(undefined), NOW), undefined);
		assert.equal(readCachedPlanUsage("ignored", reader('{"fetched_at": 17900'), NOW), undefined);
		assert.equal(readCachedPlanUsage("ignored", reader('{"response":{"rate_limits":{}}}'), NOW), undefined);
		assert.equal(readCachedPlanUsage("ignored", reader(JSON.stringify({ fetched_at: NOW / 1000 })), NOW), undefined);
	});
});

describe("writeCachedPlanUsage", () => {
	it("round-trips a reading through its own reader", () => {
		let written;
		writeCachedPlanUsage("p", (_p, c) => { written = c; }, {
			subscription_type: "max",
			rate_limits: { seven_day: { utilization: 88, resets_at: inMinutes(600) } },
		}, NOW);
		const got = readCachedPlanUsage("p", () => written, NOW);
		assert.equal(got.rate_limits.seven_day.utilization, 88);
		assert.equal(got.subscription_type, "max");
	});

	it("writes nothing when the query had no windows to report", () => {
		// A cold session answers rate_limits: null. Persisting that would
		// overwrite a good reading with an absence.
		let called = false;
		const mark = () => { called = true; };
		writeCachedPlanUsage("p", mark, { subscription_type: "max", rate_limits: null }, NOW);
		writeCachedPlanUsage("p", mark, undefined, NOW);
		assert.equal(called, false);
	});

	it("swallows a write failure", () => {
		assert.doesNotThrow(() => writeCachedPlanUsage("p", () => { throw new Error("EROFS"); }, {
			rate_limits: { seven_day: { utilization: 1, resets_at: inMinutes(600) } },
		}, NOW));
	});
});
