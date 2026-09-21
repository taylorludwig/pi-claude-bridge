/** Claude plan rate-limit windows, rendered for a host status line.
 *
 * The numbers come from the Agent SDK's usage control request, which Claude
 * Code answers from its own credential — the bridge never reads a token. They
 * only exist on a warm session: a query that has not yet made a request answers
 * with `rate_limits: null`, so the fetch is tied to a turn completing.
 *
 * Two rows are produced together, not separately, because the point of the
 * second is to be read against the first: quota spent above, window elapsed
 * below, each bar directly under its own. That only works if both rows are laid
 * out in one pass — see `formatPlanRows`.
 */

export type PlanWindow = { utilization?: number | null; resets_at?: string | null } | null;

export type PlanRateLimits = {
	five_hour?: PlanWindow;
	seven_day?: PlanWindow;
	seven_day_opus?: PlanWindow;
} | null;

export type PlanUsageResponse = {
	subscription_type?: string | null;
	rate_limits_available?: boolean;
	rate_limits?: PlanRateLimits;
};

/** One cell per hour of the five-hour window, per day of the seven-day one, so
 *  a cell is a unit the window is actually made of. */
const FIVE_HOUR_CELLS = 5;
const SEVEN_DAY_CELLS = 7;

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

/** Minutes, as OMP's segment words them: 45m, 1h, 1h 11m. */
function humanizeMinutes(minutes: number): string {
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Hours, as OMP's segment words them: 5h, 2d, 2d 4h. */
function humanizeHours(hours: number): string {
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	const rest = hours % 24;
	return rest > 0 ? `${days}d ${rest}h` : `${days}d`;
}

function resetSuffix(resetsAt: string | null | undefined, now: number, unit: "m" | "h"): string {
	if (!resetsAt) return "";
	const at = Date.parse(resetsAt);
	if (Number.isNaN(at)) return "";
	const remainingMs = Math.max(0, at - now);
	const text = unit === "m"
		? humanizeMinutes(Math.round(remainingMs / 60_000))
		: humanizeHours(Math.round(remainingMs / 3_600_000));
	return ` (${text})`;
}

/** Quarter-resolution usage bar, carrying over two honesty properties from the
 *  Claude Code status-line script this mirrors: any nonzero usage draws
 *  something, and counting quarters stops a whole-cell bar from rounding 27%
 *  down to a bar that reads 20%. */
export function buildBar(percent: number, width: number): string {
	if (width <= 0) return "";
	const clamped = Math.min(100, Math.max(0, percent));
	const quarters = Math.round((clamped * width * 4) / 100);
	let full = Math.floor(quarters / 4);
	let part = quarters % 4;
	if (clamped > 0 && full === 0 && part === 0) part = 1;
	if (full >= width) {
		full = width;
		part = 0;
	}
	const partial = ["", "\u25D4", "\u25D1", "\u25D5"][part];
	const empty = width - full - (part > 0 ? 1 : 0);
	return `${"\u25CF".repeat(full)}${partial}${"\u25CB".repeat(empty)}`;
}

/** Half-resolution elapsed bar. Deliberately a different glyph set from the
 *  usage bar above it: it measures a different quantity — how far through the
 *  window the clock is, not how much quota is spent — and should not read as
 *  the same thing at a glance. */
export function buildTimeBar(percent: number, width: number): string {
	if (width <= 0) return "";
	const clamped = Math.min(100, Math.max(0, percent));
	const halves = Math.round((clamped * width * 2) / 100);
	let full = Math.floor(halves / 2);
	let part = halves % 2;
	if (clamped > 0 && full === 0 && part === 0) part = 1;
	if (full >= width) {
		full = width;
		part = 0;
	}
	const empty = width - full - part;
	return `${"\u2501".repeat(full)}${part > 0 ? "\u257E" : ""}${"\u2500".repeat(empty)}`;
}

/** How far through a rate-limit window the clock is, 0-100, or undefined when
 *  the window did not say when it resets. */
function elapsedPercent(resetsAt: string | null | undefined, now: number, windowMs: number): number | undefined {
	if (!resetsAt) return undefined;
	const at = Date.parse(resetsAt);
	if (Number.isNaN(at)) return undefined;
	const remainingMs = Math.min(windowMs, Math.max(0, at - now));
	return ((windowMs - remainingMs) / windowMs) * 100;
}

export type PlanUsageOptions = {
	now?: number;
	/** Cells per bar. Unset gives each window a cell per hour or per day;
	 *  a number forces that width on every bar; 0 renders percentages only. */
	barWidth?: number;
	/** Per-model weekly buckets, which the SDK response does not carry. */
	modelScoped?: { name: string; pct: number }[];
	/** Drop the pace row. */
	showPace?: boolean;
};

export type PlanRows = { usage?: string; pace?: string };

type WindowSpec = {
	label: string;
	window: PlanWindow;
	/** Width when the caller did not force one. */
	cells: number;
	windowMs: number;
	unit: "m" | "h";
};

/** Code points, not UTF-16 units: every glyph used here is one code point, and
 *  padding is what keeps the two rows' bars in the same columns. */
function displayWidth(text: string): number {
	return Array.from(text).length;
}

/** OMP normalizes an extension status before rendering it, and that includes
 *  collapsing every run of ASCII spaces to one — which would undo the column
 *  padding entirely. U+2007 FIGURE SPACE is a space that survives, and is a
 *  digit width wide, which is what these columns are mostly made of. */
const PAD_SPACE = "\u2007";

function pad(text: string, width: number): string {
	return text + PAD_SPACE.repeat(Math.max(0, width - displayWidth(text)));
}

/** Lay the two rows out together: pad the labels to a common width, then each
 *  column to the wider of its two cells, so every pace bar lands directly under
 *  the usage bar it annotates. Columns the pace row does not reach (the
 *  per-model buckets) are left as they are. */
function alignRows(
	usageLabel: string | undefined,
	usageCols: string[],
	paceLabel: string | undefined,
	paceCols: string[],
): PlanRows {
	const labelWidth = Math.max(displayWidth(usageLabel ?? ""), displayWidth(paceLabel ?? ""));
	const shared = Math.min(usageCols.length, paceCols.length);
	for (let i = 0; i < shared; i++) {
		const width = Math.max(displayWidth(usageCols[i]), displayWidth(paceCols[i]));
		usageCols[i] = pad(usageCols[i], width);
		paceCols[i] = pad(paceCols[i], width);
	}
	const join = (label: string | undefined, cols: string[]): string | undefined => {
		if (cols.length === 0) return undefined;
		// Once either row carries a label, both reserve that column — a row that
		// skipped it would start its first bar one label to the left.
		const head = labelWidth > 0 ? [pad(label ?? "", labelWidth)] : [];
		return [...head, ...cols].join(" \u00B7 ").trimEnd();
	};
	return { usage: join(usageLabel, usageCols), pace: join(paceLabel, paceCols) };
}

/** Both status rows, laid out against each other.
 *
 *  `usage` is undefined when no window can be reported, so the caller clears
 *  the status rather than publishing an empty one; `pace` is undefined when no
 *  window dated its reset, or when the caller switched it off. */
export function formatPlanRows(response: PlanUsageResponse | undefined, options: PlanUsageOptions = {}): PlanRows {
	const { now = Date.now(), barWidth, modelScoped = [], showPace = true } = options;
	const limits = response?.rate_limits;

	const specs: WindowSpec[] = limits
		? [
			{ label: "5h", window: limits.five_hour ?? null, cells: FIVE_HOUR_CELLS, windowMs: FIVE_HOUR_MS, unit: "m" },
			{ label: "7d", window: limits.seven_day ?? null, cells: SEVEN_DAY_CELLS, windowMs: SEVEN_DAY_MS, unit: "h" },
			{ label: "7d opus", window: limits.seven_day_opus ?? null, cells: SEVEN_DAY_CELLS, windowMs: SEVEN_DAY_MS, unit: "h" },
		]
		: [];

	const usageCols: string[] = [];
	const paceCols: string[] = [];
	for (const spec of specs) {
		const width = barWidth ?? spec.cells;
		const utilization = spec.window?.utilization;
		const elapsed = elapsedPercent(spec.window?.resets_at, now, spec.windowMs);

		// A window with no number is no claim, not zero — it is dropped from the
		// usage row. Its pace column goes too, so the rows cannot shear apart.
		if (typeof utilization !== "number") continue;
		const bar = buildBar(utilization, width);
		usageCols.push(`${spec.label} ${bar ? `${bar} ` : ""}${Math.round(utilization)}%${resetSuffix(spec.window?.resets_at, now, spec.unit)}`);

		// A window that never dated its reset has no pace to report. It still
		// holds its column, blank: dropping it would slide every later pace bar
		// under the wrong usage bar, which is the one thing this row must not do.
		if (!showPace) continue;
		if (elapsed === undefined) {
			paceCols.push("");
			continue;
		}
		const shown = Math.round(elapsed);
		const timeBar = buildTimeBar(elapsed, width);
		// The delta is the whole point of the row: quota spent minus window
		// elapsed. Positive means the quota is burning faster than the window
		// refills it, which is the judgement the two bars exist to support.
		const drift = Math.round(utilization) - shown;
		paceCols.push(`${spec.label} ${timeBar ? `${timeBar} ` : ""}${shown}% (${drift > 0 ? "+" : ""}${drift})`);
	}

	// The per-model rows share the seven-day reset the row above already
	// carries, so they show the bucket and its number and nothing more.
	for (const scoped of modelScoped) {
		const bar = buildBar(scoped.pct, barWidth ?? SEVEN_DAY_CELLS);
		usageCols.push(`${scoped.name} ${bar ? `${bar} ` : ""}${Math.round(scoped.pct)}%`);
	}

	if (usageCols.length === 0) return {};

	// Tier word for the status line: "max" -> "Max".
	const tier = response?.subscription_type?.trim();
	const usageLabel = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : undefined;
	// All-blank means no window dated its reset: there is nothing to pace.
	const hasPace = paceCols.some((col) => col !== "");
	return alignRows(usageLabel, usageCols, hasPace ? "pace" : undefined, hasPace ? paceCols : []);
}

const USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

/** Ask a live query for the plan windows.
 *
 * The SDK marks this method unstable and says the name will change when it is
 * stabilized, so absence is a normal outcome, not an error: feature-detect and
 * give up quietly rather than let a status-line nicety break a turn. */
export async function fetchPlanUsage(sdkQuery: unknown): Promise<PlanUsageResponse | undefined> {
	if (!sdkQuery || typeof sdkQuery !== "object") return undefined;
	const method = (sdkQuery as Record<string, unknown>)[USAGE_METHOD];
	if (typeof method !== "function") return undefined;
	try {
		const call = method as (opts: { skipBehaviors: boolean }) => Promise<PlanUsageResponse>;
		return await call.call(sdkQuery, { skipBehaviors: true });
	} catch {
		return undefined;
	}
}
