import { test } from "node:test";
import assert from "node:assert/strict";
import { chatGPTModels } from "../src/agent/chatgpt-bridge.ts";
import { refreshConnectionCatalog } from "../src/server/model-catalog.ts";

test("a connected account offering Terra receives a usable catalog entry", async () => {
	process.env.LH_DESKTOP_SERVER = "1";
	process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: { id: string; op: string }, callback: () => void) => {
		callback();
		queueMicrotask(() => (process.emit as (name: string, value: unknown) => boolean)("message", {
			channel: "lh:chatgpt", id: message.id, op: message.op, ok: true,
			value: {
				epoch: 1, authorityRevision: 1, revision: 1, accountId: "A",
				status: { available: true, pending: false, allowBackgroundUse: true, activeId: "A", accounts: [{ id: "A", connected: true, planEnabled: true }], error: null },
				models: [{ id: "gpt-6.1-terra", name: "GPT-6.1 Terra" }],
			},
		}));
		return true;
	} });
	await refreshConnectionCatalog("chatgpt");
	const terra = chatGPTModels().find((model) => model.id === "gpt-6.1-terra");
	assert.equal(terra?.provider, "chatgpt");
	assert.equal(terra?.api, "openai-responses");
	assert.equal(terra?.contextWindow, 272000);
	assert.equal(terra?.thinkingLevelMap?.medium, "medium");
});
