/**
 * Every Claude Code subprocess the bridge spawns has to be told to keep its hands
 * off state pi owns. These are silent when missing: CC compacts or writes memory
 * on its own, nothing throws, and the damage shows up in the user's ~/.claude
 * rather than in a test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { __test } = await import("../src/index.js");

describe("Claude Code child environment", () => {
	it("disables auto-compaction and claude.ai MCP servers", () => {
		assert.deepEqual(__test.CC_CHILD_ENV, {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
		});
	});

	// Claude Code cuts any MCP tool result past MAX_MCP_OUTPUT_TOKENS and tells the
	// model to page the server instead — advice that means nothing for a bridged
	// host tool, on output the host already bounded. Left unset it is CC's own
	// 25,000, which truncates ordinary reads and command output with nothing on the
	// pi side reporting it: the same silent class as the guards above.
	it("lifts Claude Code's MCP result ceiling above the host's own limits", () => {
		const env = __test.ccChildEnv(tmpdir());
		assert.equal(env.MAX_MCP_OUTPUT_TOKENS, String(__test.DEFAULT_MAX_MCP_OUTPUT_TOKENS));
		assert.ok(__test.DEFAULT_MAX_MCP_OUTPUT_TOKENS > 25_000, "a ceiling at or below CC's default would not lift anything");
		assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, "0", "the ceiling must not displace the guards");
		assert.equal(env.DISABLE_AUTO_COMPACT, "1");
	});

	it("honours a configured ceiling", () => {
		// Through the global agent dir: a project `.pi/claude-bridge.json` is
		// deliberately ignored under an OMP agent dir, so it would pass or fail
		// depending on the host running the suite.
		const agentDir = mkdtempSync(join(tmpdir(), "child-env-agent-"));
		const oldEnv = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ provider: { maxMcpOutputTokens: 4242 } }));
			assert.equal(__test.ccChildEnv(agentDir).MAX_MCP_OUTPUT_TOKENS, "4242");
		} finally {
			if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldEnv;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	// Deliberately not asserted here: that every `query()` call site spreads the
	// constant. The only way to check that from a unit test is to grep src/index.ts,
	// which fails on innocent indirection (`env: childEnv`) and would have to be
	// taught about it — a brittle test that reads as coverage. The three sites
	// calling ccChildEnv are the guard, and a fourth is a review question.
});
