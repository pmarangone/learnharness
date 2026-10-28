import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { lessonOutlineSchema, type LessonOutline } from "../../core/lesson.ts";
import { serverExecute } from "../tool-execute.ts";
import type { PlanToolContext } from "./plan.ts";

const slug = Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9_-]+$" });
const outlineInput = Type.Object({
	parentNodeId: slug,
	problem: Type.String({ minLength: 1, maxLength: 2000 }),
	steps: Type.Array(Type.Object({
		id: slug,
		title: Type.String({ minLength: 1, maxLength: 200 }),
		purpose: Type.String({ minLength: 1, maxLength: 1000 }),
		sources: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 12 }),
		uncertainty: Type.String({ maxLength: 1000 }),
	}), { minItems: 1, maxItems: 30 }),
	currentStepId: slug,
});
const focusInput = Type.Object({ stepId: slug });

export function lessonTools(ctx: PlanToolContext, existing: LessonOutline | null, stale = false): Record<string, AgentTool<any>> {
	let draft = existing;
	let needsReview = stale;
	return {
		lesson_outline: {
			name: "lesson_outline",
			label: "lesson_outline",
			description: "Draft the ordered steps for the current course-map node. Include the concrete problem, purpose, sources and uncertainties; do not invent sources. Select the next step to present. The draft is saved only when this response is successfully recorded. To explore a different topic, keep its course node as parent. This does not mark anything learned.",
			parameters: outlineInput,
			executionMode: "sequential",
			execute: serverExecute("lesson_outline", outlineInput, async (input) => {
				const parsed = lessonOutlineSchema.safeParse(input);
				if (!parsed.success) return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join("; ") };
				const record = ctx.chatStore.getChat(ctx.chatId);
				if (!record?.tree?.nodes.some((node) => node.id === parsed.data.parentNodeId)) return { ok: false, error: "The parent node must exist in the current course map." };
				draft = parsed.data;
				needsReview = false;
				return { ok: true, outline: draft, reminder: "Present one step only. The outline is saved after this response is recorded." };
			}),
		},
		lesson_focus: {
			name: "lesson_focus",
			label: "lesson_focus",
			description: "Set the lesson step you intend to present in this response. Use after answering or when moving to a step. This is a presentation position, not proof of learning; it is saved only when this response is successfully recorded.",
			parameters: focusInput,
			executionMode: "sequential",
			execute: serverExecute("lesson_focus", focusInput, async ({ stepId }) => {
				if (needsReview) return { ok: false, error: "The prior outline is stale. Review the conversation and update it with lesson_outline first." };
				if (!draft?.steps.some((step) => step.id === stepId)) return { ok: false, error: "Choose a step from the current lesson outline." };
				const record = ctx.chatStore.getChat(ctx.chatId);
				if (!record?.tree?.nodes.some((node) => node.id === draft?.parentNodeId)) return { ok: false, error: "The outline's parent node is no longer in the course map. Reconcile the outline first." };
				draft = { ...draft, currentStepId: stepId };
				return { ok: true, currentStepId: stepId };
			}),
		},
	};
}
