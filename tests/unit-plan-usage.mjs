#!/usr/bin/env node

/**
 * Plan rate-limit rendering for the host status line.
 *
 * The windows arrive from an experimental SDK control request that may answer
 * with nothing, with a partial set, or with a window whose utilization the
 * server left null. Each of those has to read as "no claim" rather than as 0%,
 * and the reset wording has to match OMP's built-in `usage` segment so a bridge
 * session and a native-provider session read the same.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { formatPlanUsage, fetchPlanUsage } = await import("../src/plan-usage.js");

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const inMinutes = (n) => new Date(NOW + n * 60_000).toISOString();

describe("formatPlanUsage", () => {
	it("renders tier and both windows the way OMP's usage segment words them", () => {
		const text = formatPlanUsage({
			subscription_type: "max",
			rate_limits: {
				five_hour: { utilization: 4, resets_at: inMinutes(131) },
				seven_day: { utilization: 85, resets_at: inMinutes(30 * 60) },
			},
		}, NOW);
		assert.equal(text, "Max · 5h 4% (2h 11m) · 7d 85% (1d 6h)");
	});

	it("reports nothing at all when the session is cold", () => {
		// A query that has not made a request answers rate_limits: null even
		// though rate_limits_available is true. Publishing "0%" there would be a
		// lie about quota.
		assert.equal(formatPlanUsage({ subscription_type: "max", rate_limits_available: true, rate_limits: null }, NOW), undefined);
		assert.equal(formatPlanUsage(undefined, NOW), undefined);
	});

	it("omits a window the server did not score, rather than calling it 0%", () => {
		const text = formatPlanUsage({
			subscription_type: "pro",
			rate_limits: {
				five_hour: { utilization: null, resets_at: inMinutes(10) },
				seven_day: { utilization: 12, resets_at: inMinutes(60) },
			},
		}, NOW);
		assert.equal(text, "Pro · 7d 12% (1h)");
	});

	it("drops the whole status when no window is scored", () => {
		const text = formatPlanUsage({
			subscription_type: "max",
			rate_limits: { five_hour: { utilization: null, resets_at: inMinutes(10) } },
		}, NOW);
		assert.equal(text, undefined);
	});

	it("keeps a scored window that carries no reset time", () => {
		const text = formatPlanUsage({ subscription_type: null, rate_limits: { five_hour: { utilization: 50 } } }, NOW);
		assert.equal(text, "5h 50%");
	});

	it("floors an elapsed window at zero instead of counting backwards", () => {
		const text = formatPlanUsage({ rate_limits: { five_hour: { utilization: 99, resets_at: inMinutes(-90) } } }, NOW);
		assert.equal(text, "5h 99% (0m)");
	});

	it("words each unit boundary as the native segment does", () => {
		const fiveHour = (minutes) => formatPlanUsage({ rate_limits: { five_hour: { utilization: 1, resets_at: inMinutes(minutes) } } }, NOW);
		assert.equal(fiveHour(59), "5h 1% (59m)");
		assert.equal(fiveHour(60), "5h 1% (1h)");
		assert.equal(fiveHour(91), "5h 1% (1h 31m)");

		const sevenDay = (hours) => formatPlanUsage({ rate_limits: { seven_day: { utilization: 1, resets_at: inMinutes(hours * 60) } } }, NOW);
		assert.equal(sevenDay(23), "7d 1% (23h)");
		assert.equal(sevenDay(24), "7d 1% (1d)");
		assert.equal(sevenDay(30), "7d 1% (1d 6h)");
	});

	it("reports the per-model Opus window when the plan carries one", () => {
		const text = formatPlanUsage({
			subscription_type: "max",
			rate_limits: {
				seven_day: { utilization: 85, resets_at: inMinutes(60) },
				seven_day_opus: { utilization: 78, resets_at: inMinutes(60) },
			},
		}, NOW);
		assert.equal(text, "Max · 7d 85% (1h) · 7d opus 78% (1h)");
	});
});

describe("fetchPlanUsage", () => {
	it("gives up quietly when the SDK has renamed or dropped the unstable method", async () => {
		// The SDK documents that this method's name will change when it
		// stabilizes, so its absence is a normal outcome and must not throw.
		assert.equal(await fetchPlanUsage({}), undefined);
		assert.equal(await fetchPlanUsage(null), undefined);
	});

	it("swallows a control-request failure", async () => {
		const q = {
			usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
				throw new Error("ProcessTransport is not ready for writing");
			},
		};
		assert.equal(await fetchPlanUsage(q), undefined);
	});

	it("asks for the rate limits without the local transcript scan", async () => {
		let seen;
		const q = {
			usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (opts) => {
				seen = opts;
				return { subscription_type: "max", rate_limits: null };
			},
		};
		await fetchPlanUsage(q);
		assert.deepEqual(seen, { skipBehaviors: true });
	});
});
