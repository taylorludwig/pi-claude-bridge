#!/usr/bin/env node

/**
 * Provider registration across module instances (issue #91's foreground failure,
 * plus oh-my-pi#9024).
 *
 * The first bridge instance registers the claude-bridge provider at activation
 * and pins its stream fn globally, because the custom-api registry is keyed by
 * api name alone and one stream fn necessarily serves every live session.
 *
 * A later instance — a subagent session that loaded this module fresh — must
 * re-register at activation, because OMP's extension loader sweeps this module
 * path's custom-api entry on every load and would otherwise leave the running
 * parent with a provider record whose handler is gone. That re-registration
 * carries the PINNED stream fn, never the fresh instance's own, so the parent's
 * in-flight query state survives. It then decides at session_start whether its
 * own session registry also needs the provider: hosts that pass the parent's
 * registry down already have it, while hosts that give the child its own need it
 * registered or every claude-bridge/* dispatch fails with "Model not found".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const PROVIDER_ID = "claude-bridge";

const { default: activate } = await import("../src/index.js");

function activateWithMockPi(activateFn, options = {}) {
	// pi appends handlers (a later bridge instance registers two session_start
	// handlers: clearSession + deferred registration), so the mock does too.
	const handlers = new Map();
	const registered = [];
	(activateFn ?? activate)({
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerProvider: (name, config) => registered.push({ name, config }),
		registerTool: () => {},
	});
	const emit = (event, ...args) => {
		for (const handler of handlers.get(event) ?? []) handler(...args);
	};
	return { handlers, registered, emit };
}

function registryWith(provider) {
	return { getProvider: (id) => (id === provider ? { name: provider } : undefined) };
}

describe("provider registration across module instances", () => {
	let pinnedStreamSimple;

	it("first instance registers at activation and pins its stream fn", () => {
		const { registered } = activateWithMockPi();
		assert.equal(registered.length, 1, "exactly one activation-time registration");
		assert.equal(registered[0].name, PROVIDER_ID);
		pinnedStreamSimple = registered[0].config.streamSimple;
		assert.ok(pinnedStreamSimple, "the first registration carries a stream fn");
	});

	it("later instance heals the swept registration with the pinned stream fn (oh-my-pi#9024)", async () => {
		const { default: activateFresh } = await import("../src/index.js?own-registry-child");
		const { registered, emit } = activateWithMockPi(activateFresh);
		assert.equal(registered.length, 1, "the later instance re-registers at activation");
		assert.equal(
			registered[0].config.streamSimple,
			pinnedStreamSimple,
			"reuses the pinned stream fn rather than its own empty-state one",
		);

		// #91: a host that gives the child its own registry still needs the
		// provider registered into that registry at session_start.
		emit("session_start", {}, { modelRegistry: registryWith("other-provider") });
		assert.equal(registered.length, 2, "session_start registers into the child's own registry");
		assert.equal(registered[1].name, PROVIDER_ID);
	});

	it("later instance does not re-register when the registry already has the provider", async () => {
		const { default: activateFresh } = await import("../src/index.js?shared-registry-child");
		const { registered, emit } = activateWithMockPi(activateFresh);
		const afterActivation = registered.length;

		// Host passed the parent's registry down: the provider is already there.
		emit("session_start", {}, { modelRegistry: registryWith(PROVIDER_ID) });
		assert.equal(registered.length, afterActivation, "no overwrite of the parent's registration");

		// Repeated session starts stay idempotent.
		emit("session_start", {}, { modelRegistry: registryWith(PROVIDER_ID) });
		assert.equal(registered.length, afterActivation, "still no registration on a later session_start");
	});
});
