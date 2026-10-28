import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { ChatGPTRequestCycle } from "../src/agent/chatgpt-request-cycle.ts";
import { runPiTurn } from "../src/server/pi/ui-stream.ts";

function scenario(replies: Array<{ stopReason: string; content: Array<{ type: string; text?: string }> }>) {
	let calls = 0;
	const listeners: Array<(event: AgentEvent) => void> = [];
	const state: { messages: unknown[] } = { messages: [] };
	const agent = {
		state,
		subscribe(listener: (event: AgentEvent) => void) { listeners.push(listener); return () => {}; },
		async continue() {
			await Promise.resolve();
			const response = { role: "assistant", ...replies[calls++] };
			state.messages.push(response);
			for (const listener of listeners) {
				listener({ type: "message_end", message: response } as AgentEvent);
				listener({ type: "agent_end", messages: [] } as AgentEvent);
			}
		},
		abort() {},
	} as unknown as Agent;
	const cycle = {
		bindRelease() {},
		hold(event: AgentEvent) { return event.type === "agent_end"; },
		get deniedBeforeDispatch() { return false; },
		finishNativeCycle() { return { action: "settle", messages: [] }; },
	} as unknown as ChatGPTRequestCycle;
	let saved: unknown[] = [];
	const handle = runPiTurn({ agent, requestCycle: cycle, retryEmptyAnswer: true, onFinish(messages) { saved = messages; } });
	return { handle, state, calls: () => calls, saved: () => saved };
}

test("an empty answer response is retried once and the lesson continues", async () => {
	const s = scenario([
		{ stopReason: "stop", content: [{ type: "text", text: "" }] },
		{ stopReason: "stop", content: [{ type: "text", text: "Here is the next step." }] },
	]);
	const wire = await new Response(s.handle.subscribe()).text();
	assert.equal(s.calls(), 2);
	assert.match(wire, /Here is the next step/);
	assert(s.saved().some((message) => (message as { customType?: string }).customType === "answer-continuation"));
});

test("two empty responses stop with an error rather than retry forever", async () => {
	const empty = { stopReason: "stop", content: [{ type: "text", text: "" }] };
	const s = scenario([empty, empty]);
	const wire = await new Response(s.handle.subscribe()).text();
	assert.equal(s.calls(), 2);
	assert.match(wire, /model returned an empty response/);
});

test("a question tool call is not mistaken for an empty response", async () => {
	const s = scenario([{ stopReason: "toolUse", content: [{ type: "toolCall" }] }]);
	await new Response(s.handle.subscribe()).text();
	assert.equal(s.calls(), 1);
});
