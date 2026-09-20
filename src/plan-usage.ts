/** Claude plan rate-limit windows, rendered for a host status line.
 *
 * The numbers come from the Agent SDK's usage control request, which Claude
 * Code answers from its own credential — the bridge never reads a token. They
 * only exist on a warm session: a query that has not yet made a request answers
 * with `rate_limits: null`, so the fetch is tied to a turn completing.
 *
 * Wording mirrors OMP's built-in `usage` segment ("5h 32% (1h 11m)") so a
 * bridge session reads the same as a native-provider one.
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

function renderWindow(label: string, window: PlanWindow, now: number, unit: "m" | "h"): string | undefined {
	const utilization = window?.utilization;
	if (typeof utilization !== "number") return undefined;
	return `${label} ${Math.round(utilization)}%${resetSuffix(window?.resets_at, now, unit)}`;
}

/** Returns undefined when no window can be reported, so the caller can clear
 *  the status rather than publish an empty one. */
export function formatPlanUsage(response: PlanUsageResponse | undefined, now = Date.now()): string | undefined {
	if (!response?.rate_limits) return undefined;
	const limits = response.rate_limits;
	const parts = [
		renderWindow("5h", limits.five_hour ?? null, now, "m"),
		renderWindow("7d", limits.seven_day ?? null, now, "h"),
		renderWindow("7d opus", limits.seven_day_opus ?? null, now, "h"),
	].filter((part): part is string => part !== undefined);
	if (parts.length === 0) return undefined;

	// Tier word for the status line: "max" -> "Max".
	const tier = response.subscription_type?.trim();
	const label = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : undefined;
	return [label, ...parts].filter(Boolean).join(" · ");
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
