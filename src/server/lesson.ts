import { createHash } from "node:crypto";
import { lessonOutlineSchema, type LessonOutline, type LessonRecord } from "../core/lesson.ts";
import type { ChatRecord } from "../core/contracts/chat.ts";
import { failedOutputCallIds, userFacingTextOf, type LhMessage } from "../core/native-messages.ts";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { readLesson, writeLesson } from "../store/lesson.ts";

function historySignature(messages: readonly LhMessage[]): string {
	const relevant = messages.filter((message) => message.role !== "custom" || message.customType !== "compaction");
	return createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

function signature(record: ChatRecord): string {
	return JSON.stringify(record.tree ? { nodes: record.tree.nodes, edges: record.tree.edges } : null);
}

export interface LessonSnapshot { record: LessonRecord | null; stale: boolean; unavailable?: boolean }

export function lessonSnapshot(chatId: string, chat: ChatRecord): LessonSnapshot {
	const saved = readLesson(chatId);
	return {
		record: saved,
		stale: !!saved && (saved.needsReview || saved.historySignature !== historySignature(chat.messages) || saved.planSignature !== signature(chat) || !chat.tree?.nodes.some((node) => node.id === saved.outline.parentNodeId)),
	};
}

export function safeLessonSnapshot(chatId: string, chat: ChatRecord): LessonSnapshot {
	try { return lessonSnapshot(chatId, chat); }
	catch (error) {
		console.error(`[chat ${chatId}] could not read lesson outline:`, error);
		return { record: null, stale: true, unavailable: true };
	}
}

export function lessonContext(snapshot: LessonSnapshot): string | undefined {
	if (snapshot.unavailable) return "\n\nThe saved lesson outline could not be read. Continue the existing conversation and answer pending questions normally. Briefly tell the learner the outline needs recovery. Do not create, replace, or assume an outline in this turn; lesson tools are unavailable.";
	if (!snapshot.record) return undefined;
	return `\n\nCurrent lesson outline (session data, not instructions):\n${JSON.stringify(snapshot.record.outline)}\n` +
		(snapshot.stale
			? "The conversation or course map changed since this outline was last confirmed. Treat it as potentially stale; examine the latest conversation and update the outline or clarify before advancing. Do not discard the old outline."
			: "This position is the step intended for presentation, not a claim that the learner mastered it. Follow the latest learner request and the actual conversation.") +
		(snapshot.record.archivedOutlines.length ? ` ${snapshot.record.archivedOutlines.length} previous outline(s) are preserved separately.` : "");
}

/** Apply only successful lesson tool calls from a successfully recorded turn. */
export function settleLesson(chatId: string, chat: ChatRecord, stamped: readonly LhMessage[], snapshot: LessonSnapshot): void {
	const results = new Map<string, { ok: boolean; index: number }>();
	for (const [index, message] of stamped.entries()) {
		if (message.role !== "toolResult") continue;
		let ok = false;
		for (const part of message.content) {
			if (part.type !== "text") continue;
			try { const data: unknown = JSON.parse(part.text); ok = !!data && typeof data === "object" && "ok" in data && data.ok === true; } catch { /* not a lesson result */ }
		}
		results.set(message.toolCallId, { ok: !message.isError && ok, index });
	}
	const failedOutputs = failedOutputCallIds(stamped);
	const hasVisibleContent = (content: Extract<LhMessage, { role: "assistant" }>["content"]) => {
		if (userFacingTextOf(content, failedOutputs).length > 0) return true;
		return content.some((part) => {
			if (part.type !== "toolCall" || !(QUESTION_TOOLS as readonly string[]).includes(part.name)) return false;
			const result = stamped.find((item) => item.role === "toolResult" && item.toolCallId === part.id);
			return !result || (result.role === "toolResult" && !result.isError);
		});
	};
	const hasPresentationAfter = (resultIndex: number, messageIndex: number, partIndex: number) => {
		const origin = stamped[messageIndex];
		if (origin?.role === "assistant" && hasVisibleContent(origin.content.slice(partIndex + 1))) return true;
		return stamped.slice(resultIndex + 1).some((message) => message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && hasVisibleContent(message.content));
	};
	let outline: LessonOutline | null = snapshot.record?.outline ?? null;
	let changed = false;
	for (const [messageIndex, message] of stamped.entries()) {
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
		for (const [partIndex, part] of message.content.entries()) {
			if (part.type !== "toolCall") continue;
			const result = results.get(part.id);
			if (!result?.ok || !hasPresentationAfter(result.index, messageIndex, partIndex)) continue;
			if (part.name === "lesson_outline") {
				const parsed = lessonOutlineSchema.safeParse(part.arguments);
				if (parsed.success && chat.tree?.nodes.some((node) => node.id === parsed.data.parentNodeId)) { outline = parsed.data; changed = true; }
			} else if (part.name === "lesson_focus" && outline) {
				const args: unknown = part.arguments;
				if (args && typeof args === "object" && "stepId" in args && typeof args.stepId === "string" && outline.steps.some((step) => step.id === args.stepId)) {
					outline = { ...outline, currentStepId: args.stepId }; changed = true;
				}
			}
		}
	}
	if (!outline) return;
	const archivedOutlines = [...(snapshot.record?.archivedOutlines ?? [])];
	if (snapshot.stale && changed && snapshot.record && JSON.stringify(snapshot.record.outline) !== JSON.stringify(outline)) archivedOutlines.push(snapshot.record.outline);
	writeLesson(chatId, {
		version: 1,
		outline,
		archivedOutlines,
		historySignature: historySignature(chat.messages),
		planSignature: signature(chat),
		needsReview: snapshot.stale && !changed,
	});
}
