import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "lh-lesson-test-"));
process.env.LH_DATA_DIR = dataDir;
const { chatStore } = await import("../src/store/chats.ts");
const { lessonTools } = await import("../src/agent/tools/lesson.ts");
const { lessonSnapshot, lessonContext, settleLesson } = await import("../src/server/lesson.ts");
const { readLesson } = await import("../src/store/lesson.ts");
const { danglingQuestionOf, newUserMessage } = await import("../src/core/native-messages.ts");
after(() => rmSync(dataDir, { recursive: true, force: true }));

const outline = {
	parentNodeId: "request",
	problem: "How does a client reach an actor?",
	steps: [
		{ id: "identity", title: "Identity", purpose: "Identify the target", sources: ["source:parser"], uncertainty: "" },
		{ id: "route", title: "Routing", purpose: "Find its host", sources: [], uncertainty: "Which retry policy?" },
	],
	currentStepId: "identity",
};
function assistant(id: string, blocks: Parameters<typeof fauxAssistantMessage>[0]): LhMessage {
	return { ...fauxAssistantMessage(blocks, { stopReason: "toolUse" }), id } as LhMessage;
}
function result(id: string, toolName: string, toolCallId: string, data: unknown): LhMessage {
	return { role: "toolResult", id, toolName, toolCallId, content: [{ type: "text", text: JSON.stringify(data) }], details: data, isError: false, timestamp: Date.now() } as LhMessage;
}
async function execute(tools: ReturnType<typeof lessonTools>, name: string, id: string, data: unknown) {
	return (await tools[name]!.execute!(id, data)).details;
}
function setup() {
	const chat = chatStore.createChat("Rivet example");
	chatStore.saveTree(chat.id, { nodes: [{ id: "request", title: "Request path" }], edges: [], version: 1 });
	return chat.id;
}

test("an older session opens without migration and a new outline settles only after a visible response", async () => {
	const id = setup();
	const oldMessages = [newUserMessage("How does the request work?")];
	chatStore.saveMessages(id, oldMessages);
	const before = chatStore.getChat(id)!;
	const snap = lessonSnapshot(id, before);
	assert.equal(snap.record, null);
	const tools = lessonTools({ chatId: id, chatStore }, null);
	const out = await execute(tools, "lesson_outline", "outline-call", outline);
	assert.equal(readLesson(id), null, "tool execution alone does not save a lesson or claim a step was shown");
	const calls = assistant("assistant-call", [fauxToolCall("lesson_outline", outline, { id: "outline-call" })]);
	const acknowledgement = result("tool-result", "lesson_outline", "outline-call", out);
	const explanation = assistant("assistant-step", [fauxText("First, a client addresses the actor by identity.")]);
	const stamped = [calls, acknowledgement, explanation];
	chatStore.saveMessages(id, [...before.messages, ...stamped]);
	settleLesson(id, chatStore.getChat(id)!, stamped, snap);
	const saved = readLesson(id)!;
	assert.deepEqual(saved.outline, outline);
	assert.equal(saved.outline.currentStepId, "identity");
	assert.equal(lessonSnapshot(id, chatStore.getChat(id)!).stale, false);
	assert.equal(chatStore.getChat(id)!.version, 1);
	assert.equal(chatStore.getChat(id)!.messages[0]!.id, oldMessages[0]!.id);
	assert.match(lessonContext(lessonSnapshot(id, chatStore.getChat(id)!))!, /Which retry policy/);
});

test("failed or incomplete tool-only turns do not move the outline", async () => {
	const id = setup();
	const before = chatStore.getChat(id)!;
	const snap = lessonSnapshot(id, before);
	const tools = lessonTools({ chatId: id, chatStore }, null);
	const bad = await execute(tools, "lesson_outline", "bad", { ...outline, parentNodeId: "missing" });
	assert.equal((bad as { ok: boolean }).ok, false);
	const good = await execute(tools, "lesson_outline", "call", outline);
	const messages = [assistant("only-call", [fauxToolCall("lesson_outline", outline, { id: "call" })]), result("only-result", "lesson_outline", "call", good)];
	chatStore.saveMessages(id, messages);
	settleLesson(id, chatStore.getChat(id)!, messages, snap);
	assert.equal(readLesson(id), null, "an outline call without a visible step does not create a saved cursor");
});

test("a pending question survives, and an older app's later edit marks an outline stale", async () => {
	const id = setup();
	const before = chatStore.getChat(id)!;
	const snap = lessonSnapshot(id, before);
	const tools = lessonTools({ chatId: id, chatStore }, null);
	const out = await execute(tools, "lesson_outline", "outline", outline);
	const call = assistant("outline-message", [fauxToolCall("lesson_outline", outline, { id: "outline" })]);
	const ack = result("ack", "lesson_outline", "outline", out);
	const question = assistant("question-message", [fauxText("The actor has a logical identity."), fauxToolCall("quiz", { question: "Why?", nodeId: "request", type: "check" }, { id: "pending-question" })]);
	const messages = [call, ack, question];
	chatStore.saveMessages(id, messages);
	settleLesson(id, chatStore.getChat(id)!, messages, snap);
	assert.equal(danglingQuestionOf(chatStore.getChat(id)!.messages)?.toolCallId, "pending-question");
	const oldAppAdded = newUserMessage("Can you explain identity again?");
	chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, oldAppAdded]);
	const stale = lessonSnapshot(id, chatStore.getChat(id)!);
	assert.equal(stale.stale, true);
	assert.match(lessonContext(stale)!, /potentially stale/);
	const staleTools = lessonTools({ chatId: id, chatStore }, stale.record!.outline, true);
	const refused = await execute(staleTools, "lesson_focus", "focus", { stepId: "route" });
	assert.equal((refused as { ok: boolean }).ok, false);
	assert.equal(readLesson(id)!.outline.currentStepId, "identity", "the saved outline remains available");
});

test("a scripted teaching session presents a step, accepts an answer, and records the next step", async () => {
	process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
	const { createFauxCore } = await import("@earendil-works/pi-ai");
	const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
	const { jobStore } = await import("../src/store/jobs.ts");
	const { createTeacherTools } = await import("../src/agent/tools.ts");
	const { sendToUserTool } = await import("../src/agent/tools/send-to-user.ts");
	const { handleChatRequest } = await import("../src/server/chat-handler.ts");
	const { runningTurn } = await import("../src/server/turn-runs.ts");
	const { buildAnswer, normalizeOptions, resolveCorrect } = await import("../src/core/question-core.ts");
	const id = setup();
	chatStore.saveSettings(id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveMessages(id, [
		assistant("probe-call-msg", [fauxToolCall("probe_done", {}, { id: "probe-completed" })]),
		result("probe-result", "probe_done", "probe-completed", { ok: true }),
	]);
	const quiz1 = { question: "What identifies the actor?", options: [{ label: "Its key" }, { label: "Its IP" }], correctAnswer: "Its key", explanation: "The key identifies it.", type: "check", nodeId: "request" };
	const quiz2 = { ...quiz1, question: "Where does the request go next?" };
	let outlineRole = "";
	const faux = createFauxCore({});
	faux.setResponses([
		() => fauxAssistantMessage([
			fauxToolCall("lesson_outline", outline, { id: "new-outline" }),
			fauxToolCall("send_to_user", { message: "Step one: identify the actor." }, { id: "send-one" }),
			fauxToolCall("quiz", quiz1, { id: "question-one" }),
		], { stopReason: "toolUse" }),
		(context) => {
			const matching = context.messages.find((message) => JSON.stringify(message).includes("Current lesson outline"));
			outlineRole = matching?.role ?? "";
			return fauxAssistantMessage([
				fauxToolCall("lesson_focus", { stepId: "route" }, { id: "focus-route" }),
				fauxToolCall("send_to_user", { message: "That is right. Step two: route the request." }, { id: "send-two" }),
				fauxToolCall("quiz", quiz2, { id: "question-two" }),
			], { stopReason: "toolUse" });
		},
	]);
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const factory: Parameters<typeof handleChatRequest>[1] = (opts) => {
		const ctx = { chatId: id, chatStore, jobStore, spawn: () => {}, lessonOutline: lessonSnapshot(id, chatStore.getChat(id)!).record?.outline ?? null };
		return createTeacherAgent(ctx, { ...opts, engine, tools: { ...createTeacherTools(ctx), send_to_user: sendToUserTool } });
	};
	async function turn(input: unknown) {
		const response = await handleChatRequest(new Request("http://test/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: id, input }) }), factory);
		assert.equal(response.status, 200, await response.text());
		const current = runningTurn(id);
		if (current) await new Response(current.subscribe()).text();
	}
	await turn({ type: "text", text: "Teach the request path one step at a time." });
	assert.equal(readLesson(id)?.outline.currentStepId, "identity");
	assert.equal(danglingQuestionOf(chatStore.getChat(id)!.messages)?.toolCallId, "question-one");
	const options = normalizeOptions(quiz1.options);
	const answer = buildAnswer({ id: "question-one", kind: "quiz", question: quiz1.question, mode: "single-select", options, correctIndices: resolveCorrect(quiz1.correctAnswer, options).indices, explanation: quiz1.explanation, createdAt: new Date().toISOString() }, { values: ["Its key"] });
	await turn({ type: "answer", toolCallId: "question-one", answer });
	assert.equal(readLesson(id)?.outline.currentStepId, "route");
	assert.equal(outlineRole, "user", "lesson data is supplied below system priority");
	assert.equal(danglingQuestionOf(chatStore.getChat(id)!.messages)?.toolCallId, "question-two");
	const transcript = JSON.stringify(chatStore.getChat(id)!.messages);
	assert.match(transcript, /Step one: identify the actor/);
	assert.match(transcript, /Step two: route the request/);
	assert.equal(lessonSnapshot(id, chatStore.getChat(id)!).stale, false);
});


test("a failed response after changing focus does not claim the next step was presented", async () => {
	const id = setup();
	let snapshot = lessonSnapshot(id, chatStore.getChat(id)!);
	let tools = lessonTools({ chatId: id, chatStore }, null);
	const firstResult = await execute(tools, "lesson_outline", "first-outline", outline);
	const first = [assistant("first-call", [fauxToolCall("lesson_outline", outline, { id: "first-outline" })]), result("first-result", "lesson_outline", "first-outline", firstResult), assistant("first-text", [fauxText("Step one.")])];
	chatStore.saveMessages(id, first);
	settleLesson(id, chatStore.getChat(id)!, first, snapshot);
	snapshot = lessonSnapshot(id, chatStore.getChat(id)!);
	tools = lessonTools({ chatId: id, chatStore }, snapshot.record!.outline);
	const focusResult = await execute(tools, "lesson_focus", "focus-two", { stepId: "route" });
	const before = assistant("preface", [fauxText("Now I will move on.")]);
	const call = assistant("focus-call", [fauxToolCall("lesson_focus", { stepId: "route" }, { id: "focus-two" })]);
	const ack = result("focus-result", "lesson_focus", "focus-two", focusResult);
	const failed = { ...fauxAssistantMessage([fauxText("Incomplete output")], { stopReason: "error" }), id: "failed" } as LhMessage;
	const stamped = [before, call, ack, failed];
	chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, ...stamped]);
	settleLesson(id, chatStore.getChat(id)!, stamped, snapshot);
	assert.equal(readLesson(id)!.outline.currentStepId, "identity");
});

test("stale outlines are preserved when their parent is replaced", async () => {
	const id = setup();
	const initial = chatStore.getChat(id)!;
	const tools = lessonTools({ chatId: id, chatStore }, null);
	const ack = await execute(tools, "lesson_outline", "first", outline);
	const first = [assistant("call-1", [fauxToolCall("lesson_outline", outline, { id: "first" })]), result("result-1", "lesson_outline", "first", ack), assistant("text-1", [fauxText("First step.")])];
	chatStore.saveMessages(id, first);
	settleLesson(id, chatStore.getChat(id)!, first, lessonSnapshot(id, initial));
	chatStore.saveTree(id, { nodes: [{ id: "other", title: "New topic" }], edges: [], version: 1 });
	const snapshot = lessonSnapshot(id, chatStore.getChat(id)!);
	assert.equal(snapshot.stale, true);
	const updated = { ...outline, parentNodeId: "other", problem: "A different problem" };
	const nextTools = lessonTools({ chatId: id, chatStore }, snapshot.record!.outline, true);
	const nextAck = await execute(nextTools, "lesson_outline", "second", updated);
	const second = [assistant("call-2", [fauxToolCall("lesson_outline", updated, { id: "second" })]), result("result-2", "lesson_outline", "second", nextAck), assistant("text-2", [fauxText("Another topic.")])];
	chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, ...second]);
	settleLesson(id, chatStore.getChat(id)!, second, snapshot);
	assert.deepEqual(readLesson(id)!.archivedOutlines, [outline]);
	assert.equal(readLesson(id)!.outline.parentNodeId, "other");
});

test("a corrupt sidecar does not block an existing pending answer or overwrite the damaged file", async () => {
	process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
	const { createFauxCore } = await import("@earendil-works/pi-ai");
	const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
	const { handleChatRequest } = await import("../src/server/chat-handler.ts");
	const { runningTurn } = await import("../src/server/turn-runs.ts");
	const { buildAnswer, normalizeOptions, resolveCorrect } = await import("../src/core/question-core.ts");
	const id = setup();
	chatStore.saveSettings(id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const quiz = { question: "What identifies the actor?", options: [{ label: "Its key" }, { label: "Its IP" }], correctAnswer: "Its key", explanation: "The key identifies it.", type: "check", nodeId: "request" };
	chatStore.saveMessages(id, [assistant("probe-call", [fauxToolCall("probe_done", {}, { id: "probe-done" })]), result("probe-ack", "probe_done", "probe-done", { ok: true }), assistant("existing-question", [fauxToolCall("quiz", quiz, { id: "pending" })])]);
	const file = path.join(dataDir, "lesson-outlines", `${id}.json`);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, "{damaged");
	const faux = createFauxCore({});
	faux.setResponses([() => fauxAssistantMessage([fauxText("The answer is right; the lesson outline needs recovery.")])]);
	const options = normalizeOptions(quiz.options);
	const answer = buildAnswer({ id: "pending", kind: "quiz", question: quiz.question, mode: "single-select", options, correctIndices: resolveCorrect(quiz.correctAnswer, options).indices, explanation: quiz.explanation, createdAt: new Date().toISOString() }, { values: ["Its key"] });
	let captured = "";
	const response = await handleChatRequest(new Request("http://test/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: id, input: { type: "answer", toolCallId: "pending", answer } }) }), (opts) => {
		captured = opts.lessonContext ?? "";
		return createTeacherAgent(undefined, { ...opts, engine: { model: faux.getModel(), streamFn: faux.streamSimple } });
	});
	assert.equal(response.status, 200);
	const current = runningTurn(id);
	if (current) await new Response(current.subscribe()).text();
	assert.match(captured, /outline could not be read/);
	assert.equal(readFileSync(file, "utf8"), "{damaged");
	assert.equal(danglingQuestionOf(chatStore.getChat(id)!.messages), null);
});

test("learner-facing tool output advances a step, but a failed output does not", async () => {
	for (const shouldFail of [false, true]) {
		const id = setup();
		const chat = chatStore.getChat(id)!;
		const snapshot = lessonSnapshot(id, chat);
		const tools = lessonTools({ chatId: id, chatStore }, null);
		const ack = await execute(tools, "lesson_outline", "outline-send", outline);
		const call = assistant("outline-msg", [fauxToolCall("lesson_outline", outline, { id: "outline-send" })]);
		const output = assistant("send-msg", [fauxToolCall("send_to_user", { message: "First, identify the actor." }, { id: "send" })]);
		const outputResult = { ...result("send-result", "send_to_user", "send", { ok: !shouldFail }), isError: shouldFail } as LhMessage;
		const stamped = [call, result("outline-ack", "lesson_outline", "outline-send", ack), output, outputResult];
		chatStore.saveMessages(id, stamped);
		settleLesson(id, chatStore.getChat(id)!, stamped, snapshot);
		assert.equal(readLesson(id)?.outline.currentStepId ?? null, shouldFail ? null : "identity");
	}
});

test("lesson outlines have a bounded total size and context is counted in compaction estimates", async () => {
	const id = setup();
	const tools = lessonTools({ chatId: id, chatStore }, null);
	const huge = { ...outline, steps: [{ ...outline.steps[0], sources: Array.from({ length: 12 }, (_, i) => `${i}${"x".repeat(900)}`) }] };
	const out = await execute(tools, "lesson_outline", "huge", huge) as { ok: boolean; error?: string };
	assert.equal(out.ok, false);
	assert.match(out.error!, /8,000/);
	const { projectedContextTokens } = await import("../src/server/compaction.ts");
	assert.equal(projectedContextTokens([], 10, 25), projectedContextTokens([], 10) + 25);
});

test("compaction keeps the lesson outline available to the next turn", async () => {
	const { ensureCompacted } = await import("../src/server/compaction.ts");
	const { activeCompactionOf } = await import("../src/core/index.ts");
	const id = setup();
	const messages = Array.from({ length: 4 }, (_, i) => newUserMessage(`Earlier discussion ${i}: ${"x".repeat(100_000)}`));
	chatStore.saveMessages(id, messages);
	const snapshot = lessonSnapshot(id, chatStore.getChat(id)!);
	const tools = lessonTools({ chatId: id, chatStore }, null);
	const output = await execute(tools, "lesson_outline", "compact-outline", outline);
	const stamped = [assistant("compact-call", [fauxToolCall("lesson_outline", outline, { id: "compact-outline" })]), result("compact-result", "lesson_outline", "compact-outline", output), assistant("compact-text", [fauxText("Step one.")])];
	chatStore.saveMessages(id, [...messages, ...stamped]);
	settleLesson(id, chatStore.getChat(id)!, stamped, snapshot);
	await ensureCompacted({
		chatStore,
		engine: { model: { provider: "faux", id: "test", contextWindow: 1_000_000 } } as never,
		modelId: "faux:test", kind: "teach", thresholdTokens: 40_000, systemPromptTokens: 100,
		summarize: async () => ({ summary: "Earlier conversation.", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
	}, id);
	const compacted = chatStore.getChat(id)!;
	assert.ok(activeCompactionOf(compacted.messages));
	const after = lessonSnapshot(id, compacted);
	assert.equal(after.stale, false);
	assert.deepEqual(after.record?.outline, outline);
	assert.match(lessonContext(after)!, /Which retry policy/);
});
