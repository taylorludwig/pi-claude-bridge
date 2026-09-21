#!/usr/bin/env node

/**
 * Plan rate-limit rendering for the host status line.
 *
 * Two rows are produced together and read against each other — quota spent
 * above, window elapsed below — so the contract under test is as much the
 * layout as the numbers: every pace bar has to land in the same columns as the
 * usage bar it annotates, or the comparison the second row exists for is worse
 * than useless.
 *
 * The windows themselves arrive from an experimental SDK control request that
 * may answer with nothing, a partial set, or a window whose utilization the
 * server left null. Each of those has to read as "no claim" rather than 0%.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { formatPlanRows, fetchPlanUsage, buildBar, buildTimeBar } = await import("../src/plan-usage.js");

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const inMinutes = (n) => new Date(NOW + n * 60_000).toISOString();

/** Column where the given bar glyph run starts, in code points. */
function barColumn(line, glyph) {
	return Array.from(line).indexOf(glyph);
}

describe("formatPlanRows layout", () => {
	const rows = formatPlanRows({
		subscription_type: "max",
		rate_limits: {
			five_hour: { utilization: 15, resets_at: inMinutes(145) },
			seven_day: { utilization: 86, resets_at: inMinutes(29 * 60) },
		},
	}, { now: NOW, modelScoped: [{ name: "Fable", pct: 79 }] });

	it("gives each window a cell per hour and per day", () => {
		// A cell is a unit the window is made of: 5 hours, 7 days.
		assert.match(rows.usage, /5h [●◔◑◕○]{5} /);
		assert.match(rows.usage, /7d [●◔◑◕○]{7} /);
		assert.match(rows.usage, /Fable [●◔◑◕○]{7} /);
		assert.match(rows.pace, /5h [━╾─]{5} /);
		assert.match(rows.pace, /7d [━╾─]{7} /);
	});

	it("puts every pace bar in the same columns as the usage bar above it", () => {
		const firstBar = (line, charset) => Array.from(line).findIndex((c) => charset.test(c));
		assert.equal(
			firstBar(rows.usage.split(" · ")[1], /[●◔◑◕○]/),
			firstBar(rows.pace.split(" · ")[1], /[━╾─]/),
			"5h bar column",
		);
		// The 7d column is the one alignment actually costs something: the usage
		// cell carries a reset time the pace cell does not, so without padding
		// the second row would slide left.
		const usage7d = rows.usage.indexOf("7d ");
		const pace7d = rows.pace.indexOf("7d ");
		assert.equal(Array.from(rows.usage.slice(0, usage7d)).length, Array.from(rows.pace.slice(0, pace7d)).length);
	});

	it("pads the shorter label so the first column starts together", () => {
		const usageFirst = rows.usage.indexOf("5h ");
		const paceFirst = rows.pace.indexOf("5h ");
		assert.equal(Array.from(rows.usage.slice(0, usageFirst)).length, Array.from(rows.pace.slice(0, paceFirst)).length);
	});

	it("leaves no trailing padding on either row", () => {
		assert.equal(rows.usage, rows.usage.trimEnd());
		assert.equal(rows.pace, rows.pace.trimEnd());
	});
});

describe("formatPlanRows content", () => {
	it("reports the gap as time on the window's own scale, signed so hot reads positive", () => {
		// 5h window with 2h25m left is 52% elapsed against 15% spent: 37 points
		// cool, which on a five-hour window is 1h51m of slack.
		// 7d window with 1d5h left is 83% elapsed against 86% spent: 3 points
		// hot, which on a seven-day window is about 5 hours.
		const rows = formatPlanRows({
			rate_limits: {
				five_hour: { utilization: 15, resets_at: inMinutes(145) },
				seven_day: { utilization: 86, resets_at: inMinutes(29 * 60) },
			},
		}, { now: NOW, barWidth: 0 });
		assert.equal(rows.usage, "\u2007\u2007\u2007\u2007 · 5h 15% (2h 25m)\u2007 · 7d 86% (1d 5h)");
		assert.equal(rows.pace, "pace · 5h 52% (-1h 51m) · 7d 83% (+5h)");
	});

	it("scales the same percentage gap differently for each window", () => {
		// Ten points is half an hour of a five-hour window and seventeen hours of
		// a seven-day one. Reporting both as "10" was the thing worth fixing.
		const rows = formatPlanRows({
			rate_limits: {
				five_hour: { utilization: 60, resets_at: inMinutes(150) },
				seven_day: { utilization: 60, resets_at: inMinutes(84 * 60) },
			},
		}, { now: NOW, barWidth: 0 });
		assert.match(rows.pace, /5h 50% \(\+30m\)/);
		assert.match(rows.pace, /7d 50% \(\+17h\)/);
	});

	it("reports nothing at all when the session is cold", () => {
		// A query that has not made a request answers rate_limits: null even
		// though rate_limits_available is true. Publishing "0%" would be a lie
		// about quota.
		assert.deepEqual(formatPlanRows({ subscription_type: "max", rate_limits_available: true, rate_limits: null }, { now: NOW }), {});
		assert.deepEqual(formatPlanRows(undefined, { now: NOW }), {});
	});

	it("omits a window the server did not score, rather than calling it 0%", () => {
		const rows = formatPlanRows({
			subscription_type: "pro",
			rate_limits: {
				five_hour: { utilization: null, resets_at: inMinutes(10) },
				seven_day: { utilization: 12, resets_at: inMinutes(60) },
			},
		}, { now: NOW, barWidth: 0 });
		assert.equal(rows.usage, "Pro\u2007 · 7d 12% (1h)");
		assert.equal(rows.pace, "pace · 7d 99% (-6d 2h)");
	});

	it("holds a blank pace column for a window that never dated its reset", () => {
		// Dropping the column outright would slide the 7d pace bar under the 5h
		// usage bar — the one failure this row must not have.
		const rows = formatPlanRows({
			rate_limits: {
				five_hour: { utilization: 15 },
				seven_day: { utilization: 86, resets_at: inMinutes(29 * 60) },
			},
		}, { now: NOW, barWidth: 0 });
		assert.equal(rows.usage, "\u2007\u2007\u2007\u2007 · 5h 15% · 7d 86% (1d 5h)");
		assert.equal(rows.pace, "pace · \u2007\u2007\u2007\u2007\u2007\u2007 · 7d 83% (+5h)");
	});

	it("drops the pace row when no window dated its reset", () => {
		const rows = formatPlanRows({ rate_limits: { five_hour: { utilization: 15 } } }, { now: NOW, barWidth: 0 });
		assert.equal(rows.usage, "5h 15%");
		assert.equal(rows.pace, undefined);
	});

	it("drops the pace row on request, leaving the usage row alone", () => {
		const rows = formatPlanRows({
			rate_limits: { five_hour: { utilization: 15, resets_at: inMinutes(145) } },
		}, { now: NOW, barWidth: 0, showPace: false });
		assert.equal(rows.usage, "5h 15% (2h 25m)");
		assert.equal(rows.pace, undefined);
	});

	it("still reports per-model buckets when the SDK gave no windows at all", () => {
		const rows = formatPlanRows({ subscription_type: "max", rate_limits: null }, {
			now: NOW,
			barWidth: 0,
			modelScoped: [{ name: "Fable", pct: 79 }],
		});
		// A cold session has no windows, but the cached bucket is independent of
		// them and is still worth showing.
		assert.equal(rows.usage, "Max · Fable 79%");
		assert.equal(rows.pace, undefined);
	});

	it("words each unit boundary as OMP's native segment does", () => {
		// showPace off: this case is about the reset wording, and the pace label
		// would otherwise reserve a column in front of it.
		const fiveHour = (minutes) => formatPlanRows({ rate_limits: { five_hour: { utilization: 1, resets_at: inMinutes(minutes) } } }, { now: NOW, barWidth: 0, showPace: false }).usage;
		assert.equal(fiveHour(59), "5h 1% (59m)");
		assert.equal(fiveHour(60), "5h 1% (1h)");
		assert.equal(fiveHour(91), "5h 1% (1h 31m)");

		const sevenDay = (hours) => formatPlanRows({ rate_limits: { seven_day: { utilization: 1, resets_at: inMinutes(hours * 60) } } }, { now: NOW, barWidth: 0, showPace: false }).usage;
		assert.equal(sevenDay(23), "7d 1% (23h)");
		assert.equal(sevenDay(24), "7d 1% (1d)");
		assert.equal(sevenDay(30), "7d 1% (1d 6h)");
	});

	it("clamps a reset already past and one further out than the window", () => {
		const past = formatPlanRows({ rate_limits: { five_hour: { utilization: 99, resets_at: inMinutes(-60) } } }, { now: NOW, barWidth: 0 });
		assert.equal(past.pace, "pace · 5h 100% (-3m)");
		const skewed = formatPlanRows({ rate_limits: { five_hour: { utilization: 0, resets_at: inMinutes(600) } } }, { now: NOW, barWidth: 0 });
		assert.equal(skewed.pace, "pace · 5h 0% (0m)");
	});

	it("forces one width on every bar when the caller names one", () => {
		const rows = formatPlanRows({
			rate_limits: {
				five_hour: { utilization: 50, resets_at: inMinutes(150) },
				seven_day: { utilization: 50, resets_at: inMinutes(84 * 60) },
			},
		}, { now: NOW, barWidth: 3 });
		assert.match(rows.usage, /5h [●◔◑◕○]{3} .*7d [●◔◑◕○]{3} /);
		assert.match(rows.pace, /5h [━╾─]{3} .*7d [━╾─]{3} /);
	});
});

describe("buildBar", () => {
	it("draws something for any nonzero usage, so a live window never reads as idle", () => {
		assert.equal(buildBar(0, 5), "○○○○○");
		assert.equal(buildBar(1, 5), "◔○○○○");
	});

	it("keeps a partial cell until the bar genuinely reaches the end", () => {
		assert.equal(buildBar(97, 10), "●●●●●●●●●◕");
		assert.equal(buildBar(100, 10), "●●●●●●●●●●");
	});

	it("counts quarters, so a bar cannot round down into a lie", () => {
		// Whole cells at width 10 would floor 27% to two cells and read as 20%.
		assert.equal(buildBar(27, 10), "●●◕○○○○○○○");
	});

	it("clamps out-of-range input instead of drawing past the ends", () => {
		assert.equal(buildBar(-10, 4), "○○○○");
		assert.equal(buildBar(140, 4), "●●●●");
	});

	it("renders nothing when bars are switched off", () => {
		assert.equal(buildBar(50, 0), "");
	});
});

describe("buildTimeBar", () => {
	it("uses a different glyph set from the usage bar above it", () => {
		// The two bars measure different quantities; reading as the same thing
		// at a glance is the failure this guards.
		assert.equal(buildTimeBar(50, 4), "━━──");
		assert.equal(buildBar(50, 4).includes("━"), false);
	});

	it("draws something for any elapsed time and fills only at the end", () => {
		assert.equal(buildTimeBar(0, 4), "────");
		assert.equal(buildTimeBar(1, 4), "╾───");
		assert.equal(buildTimeBar(100, 4), "━━━━");
	});

	it("keeps half-cell resolution", () => {
		assert.equal(buildTimeBar(62, 4), "━━╾─");
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
