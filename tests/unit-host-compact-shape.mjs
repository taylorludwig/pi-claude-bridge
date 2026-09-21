#!/usr/bin/env node

/**
 * Compaction must reach the host's isolation seam, whichever host is running.
 *
 * Both hosts export `compact`, with different positional signatures, and both take
 * the other's arguments without complaint:
 *
 *   pi  (preparation, model, apiKey, headers, customInstructions, signal,
 *        thinkingLevel, streamFn, env, retry, callbacks, sessionId)
 *   OMP (preparation, model, apiKey, customInstructions, signal, options)
 *
 * Calling pi's shape on OMP put `customInstructions` in the signal slot and dropped
 * `streamFn` past the end of the parameter list, so the summarizer fell back to the
 * default completion — the registered provider — carrying OMP's own summarization
 * system prompt. Nothing recorded that prompt at `before_agent_start`, so the
 * prompt-capture resolver threw, the takeover reported the throw, and every
 * compaction was cancelled ("no capture for this 484-char system prompt").
 *
 * These drive the adapter with a recording stand-in for each host. The assertion is
 * the seam: an isolation function must arrive where that host reads one.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");

const model = { id: "claude-opus-5", baseUrl: "claude-bridge" };
const preparation = { messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false };
const result = { summary: "s", firstKeptEntryId: "e1", tokensBefore: 10, details: {} };

function recorder() {
	const calls = [];
	const fn = (...args) => {
		calls.push(args);
		return Promise.resolve(result);
	};
	return { fn, calls };
}

describe("host compact shape detection", () => {
	it("recognizes the installed host", () => {
		assert.notEqual(
			__test.hostCompactShape,
			"unknown",
			"an unrecognized host declines the takeover, and its own summarizer then routes through this provider",
		);
	});

	it("reads OMP's six-parameter compact as OMP", () => {
		const shape = __test.detectCompactShape({
			compact: (_prep, _model, _key, _instructions, _signal, _options) => {},
			getOpenAiRemoteCompactionPayload: () => {},
		});
		assert.equal(shape, "omp");
	});

	it("refuses to guess when the arity is short and the OMP marker is absent", () => {
		const shape = __test.detectCompactShape({ compact: (_a, _b, _c, _d, _e, _f) => {} });
		assert.equal(shape, "unknown", "guessing wrong silently drops the isolation seam");
	});
});

describe("host compact invocation", () => {
	it("gives OMP its seam, in OMP's argument order", async () => {
		const { fn, calls } = recorder();
		const signal = new AbortController().signal;
		await __test.callHostCompact(fn, "omp", preparation, model, "focus on the matcher", signal);

		assert.equal(calls.length, 1);
		const [prep, gotModel, apiKey, instructions, gotSignal, options] = calls[0];
		assert.equal(prep, preparation);
		assert.equal(gotModel, model);
		assert.equal(apiKey, undefined);
		assert.equal(instructions, "focus on the matcher", "instructions must not land in the signal slot");
		assert.equal(gotSignal, signal, "an abort must still cancel the summary");
		assert.equal(typeof options?.completeImpl, "function", "OMP summarizes through options.completeImpl; without it the live provider is used");
	});

	it("gives pi its seam, in pi's argument order", async () => {
		const { fn, calls } = recorder();
		const signal = new AbortController().signal;
		await __test.callHostCompact(fn, "pi", preparation, model, "focus on the matcher", signal);

		const args = calls[0];
		assert.equal(args[0], preparation);
		assert.equal(args[1], model);
		assert.equal(args[4], "focus on the matcher");
		assert.equal(args[5], signal);
		assert.equal(typeof args[7], "function", "pi summarizes through the 8th positional streamFn");
	});
});
