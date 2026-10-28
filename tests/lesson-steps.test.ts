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

test("a deeper branch preserves the map and returns to the interrupted step", async () => {
	const id = setup();
	let snap = lessonSnapshot(id, chatStore.getChat(id)!);
	let tools = lessonTools({ chatId: id, chatStore }, null);
	const first = await execute(tools, "lesson_outline", "root-call", outline);
	let stamped = [assistant("root-msg", [fauxToolCall("lesson_outline", outline, { id: "root-call" })]), result("root-ack", "lesson_outline", "root-call", first), assistant("root-text", [fauxText("Start with identity.")])];
	chatStore.saveMessages(id, stamped);
	settleLesson(id, chatStore.getChat(id)!, stamped, snap);
	const originalTree = structuredClone(chatStore.getChat(id)!.tree);
	const branch = { id: "identity-detail", parentBranchId: null, parentStepId: "identity", reason: "Understand logical identity", outline: { ...outline, problem: "What makes identity logical?", currentStepId: "identity" } };
	snap = lessonSnapshot(id, chatStore.getChat(id)!);
	tools = lessonTools({ chatId: id, chatStore }, snap.record!.outline, false, snap.record!.branches, snap.record!.activeBranchId);
	const invalid = await execute(tools, "lesson_expand", "bad-branch", { ...branch, parentStepId: "route" });
	assert.equal((invalid as { ok: boolean }).ok, false);
	const expanded = await execute(tools, "lesson_expand", "expand", branch);
	assert.equal((expanded as { ok: boolean }).ok, true);
	const retry = await execute(tools, "lesson_expand", "expand-again", branch);
	assert.equal((retry as { ok: boolean }).ok, true);
	stamped = [assistant("branch-msg", [fauxToolCall("lesson_expand", branch, { id: "expand" })]), result("branch-ack", "lesson_expand", "expand", expanded), assistant("branch-text", [fauxText("A logical identity is independent of its host.")])];
	chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, ...stamped]);
	settleLesson(id, chatStore.getChat(id)!, stamped, snap);
	let saved = readLesson(id)!;
	assert.deepEqual(chatStore.getChat(id)!.tree, originalTree);
	assert.deepEqual(saved.outline, outline);
	assert.equal(saved.branches.length, 1);
	assert.equal(saved.activeBranchId, "identity-detail");
	assert.match(lessonContext(lessonSnapshot(id, chatStore.getChat(id)!))!, /What makes identity logical/);
	snap = lessonSnapshot(id, chatStore.getChat(id)!);
	tools = lessonTools({ chatId: id, chatStore }, saved.outline, false, saved.branches, saved.activeBranchId);
	const returned = await execute(tools, "lesson_return", "return", {});
	stamped = [assistant("return-msg", [fauxToolCall("lesson_return", {}, { id: "return" })]), result("return-ack", "lesson_return", "return", returned), assistant("return-text", [fauxText("Back to the identity step.")])];
	chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, ...stamped]);
	settleLesson(id, chatStore.getChat(id)!, stamped, snap);
	saved = readLesson(id)!;
	assert.equal(saved.activeBranchId, null);
	assert.equal(saved.outline.currentStepId, "identity");
	assert.equal(saved.branches.length, 1);
	chatStore.saveTree(id, { nodes: [{ id: "other", title: "Other" }], edges: [], version: 2 });
	assert.equal(lessonSnapshot(id, chatStore.getChat(id)!).stale, true);
	assert.equal(readLesson(id)!.branches[0]!.reason, branch.reason);
});

test("nested branches resume in order and unsuccessful expansions do not persist", async () => {
	const id = setup();
	let snap = lessonSnapshot(id, chatStore.getChat(id)!);
	let tools = lessonTools({ chatId: id, chatStore }, null);
	const rootResult = await execute(tools, "lesson_outline", "r", outline);
	async function save(name: string, args: Parameters<typeof fauxToolCall>[1], callId: string, output: unknown, visible = true) {
		const stamped = [assistant(`${callId}-message`, [fauxToolCall(name, args, { id: callId })]), result(`${callId}-ack`, name, callId, output), ...(visible ? [assistant(`${callId}-text`, [fauxText("A lesson step.")])] : [])];
		chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, ...stamped]);
		settleLesson(id, chatStore.getChat(id)!, stamped, snap);
		snap = lessonSnapshot(id, chatStore.getChat(id)!);
		const saved = snap.record!;
		tools = lessonTools({ chatId: id, chatStore }, saved.outline, snap.stale, saved.branches, saved.activeBranchId);
	}
	await save("lesson_outline", outline, "r", rootResult);
	const first = { id: "first", parentBranchId: null, parentStepId: "identity", reason: "First detour", outline: { ...outline, problem: "First question" } };
	const unshown = await execute(tools, "lesson_expand", "unshown", first);
	await save("lesson_expand", first, "unshown", unshown, false);
	assert.equal(readLesson(id)!.branches.length, 0);
	const firstResult = await execute(tools, "lesson_expand", "first", first);
	await save("lesson_expand", first, "first", firstResult);
	const second = { id: "second", parentBranchId: "first", parentStepId: "identity", reason: "Second detour", outline: { ...outline, problem: "Second question" } };
	const secondResult = await execute(tools, "lesson_expand", "second", second);
	await save("lesson_expand", second, "second", secondResult);
	assert.equal(readLesson(id)!.activeBranchId, "second");
	for (const [callId, expected] of [["return-one", "first"], ["return-two", null]] as const) {
		const output = await execute(tools, "lesson_return", callId, {});
		const resumed = output as { resumeOutline: { problem: string; currentStepId: string } };
		assert.equal(resumed.resumeOutline.problem, expected === "first" ? "First question" : outline.problem);
		assert.equal(resumed.resumeOutline.currentStepId, "identity");
		await save("lesson_return", {}, callId, output);
		assert.equal(readLesson(id)!.activeBranchId, expected);
	}
	assert.equal(readLesson(id)!.branches.length, 2);
	assert.equal(readLesson(id)!.outline.currentStepId, "identity");
});

test("lesson map adds containment without changing prerequisite edges", async () => {
	const { lessonMapView } = await import("../src/core/lesson-map.ts");
	const tree = { version: 1, nodes: [{ id: "request", title: "Requests" }, { id: "later", title: "Later" }], edges: [{ from: "request", to: "later" }] };
	const lesson = { version: 1 as const, outline, archivedOutlines: [], branches: [{ id: "identity-detail", parentBranchId: null, parentStepId: "identity", reason: "Explore identity", outline: { ...outline, problem: "What is identity?" } }], activeBranchId: "identity-detail", historySignature: "", planSignature: "", needsReview: false };
	const before = structuredClone(tree);
	const view = lessonMapView(tree, lesson);
	assert.deepEqual(tree, before);
	assert.deepEqual(view.edges[0], { from: "request", to: "later" });
	assert.ok(view.edges.some((edge) => edge.kind === "contains" && edge.from === ":lesson:root:request:identity" && edge.to === ":lesson:heading:identity-detail"));
	assert.equal(view.currentStep, ":lesson:branch:identity-detail:identity");
});

test("moving to another course node preserves the previous outline and branch", async () => {
	const { lessonMapView } = await import("../src/core/lesson-map.ts");
	const id = setup();
	chatStore.saveTree(id, { nodes: [{ id: "request", title: "Request" }, { id: "failure", title: "Failure" }], edges: [{ from: "request", to: "failure" }], version: 1 });
	let snap = lessonSnapshot(id, chatStore.getChat(id)!);
	let tools = lessonTools({ chatId: id, chatStore }, null);
	async function save(name: string, args: Parameters<typeof fauxToolCall>[1], idSuffix: string) {
		const output = await execute(tools, name, idSuffix, args);
		assert.equal((output as { ok: boolean }).ok, true);
		const stamped = [assistant(`${idSuffix}-message`, [fauxToolCall(name, args, { id: idSuffix })]), result(`${idSuffix}-ack`, name, idSuffix, output), assistant(`${idSuffix}-text`, [fauxText("A step is presented.")])];
		chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, ...stamped]);
		settleLesson(id, chatStore.getChat(id)!, stamped, snap);
		snap = lessonSnapshot(id, chatStore.getChat(id)!);
		const saved = snap.record!;
		tools = lessonTools({ chatId: id, chatStore }, saved.outline, snap.stale, saved.branches, saved.activeBranchId);
	}
	await save("lesson_outline", outline, "initial");
	const branch = { id: "detail", parentBranchId: null, parentStepId: "identity", reason: "Understand identity", outline: { ...outline, problem: "How is identity chosen?" } };
	await save("lesson_expand", branch, "expand-detail");
	await save("lesson_return", {}, "return-detail");
	await save("lesson_outline", { ...outline, parentNodeId: "failure", problem: "What happens on failure?" }, "new-topic");
	assert.equal(snap.stale, false);
	assert.deepEqual(snap.record!.archivedOutlines, [outline]);
	assert.equal(snap.record!.branches[0]!.id, "detail");
	const view = lessonMapView(chatStore.getChat(id)!.tree!, snap.record);
	assert.ok(view.edges.some((edge) => edge.to === ":lesson:heading:detail"));
	assert.equal(view.currentStep, ":lesson:root:failure:identity");
});

test("a removed course parent does not trap the learner in a stale branch", async () => {
	const id = setup();
	let snap = lessonSnapshot(id, chatStore.getChat(id)!);
	let tools = lessonTools({ chatId: id, chatStore }, null);
	async function save(name: string, args: Parameters<typeof fauxToolCall>[1], callId: string) {
		const output = await execute(tools, name, callId, args);
		assert.equal((output as { ok: boolean }).ok, true);
		const stamped = [assistant(`${callId}-msg`, [fauxToolCall(name, args, { id: callId })]), result(`${callId}-ack`, name, callId, output), assistant(`${callId}-text`, [fauxText("Continue after reviewing the map.")])];
		chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, ...stamped]);
		settleLesson(id, chatStore.getChat(id)!, stamped, snap);
		snap = lessonSnapshot(id, chatStore.getChat(id)!);
		const saved = snap.record!;
		tools = lessonTools({ chatId: id, chatStore }, saved.outline, snap.stale, saved.branches, saved.activeBranchId);
	}
	await save("lesson_outline", outline, "before-removal");
	const branch = { id: "detour", parentBranchId: null, parentStepId: "identity", reason: "Explore identity", outline: { ...outline, problem: "Identity details" } };
	await save("lesson_expand", branch, "detour-call");
	chatStore.saveTree(id, { nodes: [{ id: "new-node", title: "New node" }], edges: [], version: 2 });
	snap = lessonSnapshot(id, chatStore.getChat(id)!);
	assert.equal(snap.stale, true);
	tools = lessonTools({ chatId: id, chatStore }, snap.record!.outline, true, snap.record!.branches, snap.record!.activeBranchId);
	await save("lesson_return", {}, "leave-stale");
	assert.equal(snap.stale, true);
	await save("lesson_outline", { ...outline, parentNodeId: "new-node" }, "reconcile");
	assert.equal(snap.stale, false);
	assert.equal(snap.record!.branches[0]!.reason, "Explore identity");
	assert.equal(snap.record!.archivedOutlines[0]!.parentNodeId, "request");
	assert.deepEqual(snap.orphanedBranchIds, ["detour"]);
	const { lessonMapView } = await import("../src/core/lesson-map.ts");
	const visible = lessonMapView(chatStore.getChat(id)!.tree!, snap.record);
	assert.ok(visible.nodes.some((node) => node.id === ":lesson:removed:request"));
	assert.ok(visible.nodes.some((node) => node.id === ":lesson:heading:detour"));
});

test("returning from a stale branch does not silently clear the review flag", async () => {
	const id = setup();
	let snap = lessonSnapshot(id, chatStore.getChat(id)!);
	let tools = lessonTools({ chatId: id, chatStore }, null);
	async function save(name: string, args: Parameters<typeof fauxToolCall>[1], callId: string) {
		const output = await execute(tools, name, callId, args);
		assert.equal((output as { ok: boolean }).ok, true);
		const stamped = [assistant(`${callId}-msg`, [fauxToolCall(name, args, { id: callId })]), result(`${callId}-ack`, name, callId, output), assistant(`${callId}-text`, [fauxText("Continuing.")])];
		chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, ...stamped]);
		settleLesson(id, chatStore.getChat(id)!, stamped, snap);
		snap = lessonSnapshot(id, chatStore.getChat(id)!);
		const saved = snap.record!;
		tools = lessonTools({ chatId: id, chatStore }, saved.outline, snap.stale, saved.branches, saved.activeBranchId);
	}
	await save("lesson_outline", outline, "root-stale");
	await save("lesson_expand", { id: "detour", parentBranchId: null, parentStepId: "identity", reason: "Explore identity", outline: { ...outline, problem: "Identity details" } }, "branch-stale");
	chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, newUserMessage("An older app added a message.")]);
	snap = lessonSnapshot(id, chatStore.getChat(id)!);
	assert.equal(snap.stale, true);
	tools = lessonTools({ chatId: id, chatStore }, snap.record!.outline, true, snap.record!.branches, snap.record!.activeBranchId);
	await save("lesson_return", {}, "return-stale");
	assert.equal(snap.stale, true);
	assert.equal(snap.record!.needsReview, true);
	await save("lesson_outline", outline, "reviewed-outline");
	assert.equal(snap.stale, false);
});

test("re-entering a saved branch returns its last position without duplicating it", async () => {
	const id = setup();
	const branch = { id: "detour", parentBranchId: null, parentStepId: "identity", reason: "Explore identity", outline: { ...outline, problem: "Identity details" } };
	const advanced = { ...branch, outline: { ...branch.outline, currentStepId: "route" } };
	const tools = lessonTools({ chatId: id, chatStore }, outline, false, [advanced], null);
	const output = await execute(tools, "lesson_expand", "resume", branch) as { ok: boolean; branch: typeof advanced };
	assert.equal(output.ok, true);
	assert.equal(output.branch.outline.currentStepId, "route");
	const conflict = await execute(tools, "lesson_expand", "conflict", { ...branch, reason: "Different branch" }) as { ok: boolean };
	assert.equal(conflict.ok, false);
});

test("a successful lesson outline signals teaching even without a quiz", async () => {
	const { phaseAt3, phaseAt3Lh } = await import("../src/core/phases.ts");
	const view = [{ parts: [{ type: "tool-probe_done", state: "output-available", output: { ok: true } }] }, { parts: [{ type: "tool-lesson_outline", state: "output-available", output: { ok: true } }] }];
	assert.equal(phaseAt3(view), "teach");
	const native = [assistant("probe-phase", [fauxToolCall("probe_done", {}, { id: "probe-phase-call" })]), result("probe-phase-result", "probe_done", "probe-phase-call", { ok: true }), assistant("outline-phase", [fauxToolCall("lesson_outline", outline, { id: "outline-phase-call" })]), result("outline-phase-result", "lesson_outline", "outline-phase-call", { ok: true })];
	assert.equal(phaseAt3Lh(native), "teach");
});
