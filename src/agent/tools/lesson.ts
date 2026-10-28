import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { lessonBranchSchema, lessonOutlineSchema, sameBranchDefinition, type LessonBranch, type LessonOutline } from "../../core/lesson.ts";
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
const expandInput = Type.Object({
	id: slug,
	parentBranchId: Type.Union([slug, Type.Null()]),
	parentStepId: slug,
	reason: Type.String({ minLength: 1, maxLength: 1000 }),
	outline: outlineInput,
});
const returnInput = Type.Object({});

export function lessonTools(ctx: PlanToolContext, existing: LessonOutline | null, stale = false, existingBranches: LessonBranch[] = [], existingActiveBranchId: string | null = null): Record<string, AgentTool<any>> {
	let root = existing;
	let branches = [...existingBranches];
	let activeBranchId = existingActiveBranchId;
	const current = () => activeBranchId ? branches.find((branch) => branch.id === activeBranchId)?.outline ?? null : root;
	const setCurrent = (outline: LessonOutline) => {
		if (activeBranchId) branches = branches.map((branch) => branch.id === activeBranchId ? { ...branch, outline } : branch);
		else root = outline;
	};
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
				if (activeBranchId && parsed.data.parentNodeId !== root?.parentNodeId) return { ok: false, error: "A branch must retain the original course-map parent." };
				setCurrent(parsed.data);
				needsReview = false;
				return { ok: true, outline: parsed.data, reminder: "Present one step only. The outline is saved after this response is recorded." };
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
				const draft = current();
				if (!draft?.steps.some((step) => step.id === stepId)) return { ok: false, error: "Choose a step from the current lesson outline." };
				const record = ctx.chatStore.getChat(ctx.chatId);
				if (!record?.tree?.nodes.some((node) => node.id === draft?.parentNodeId)) return { ok: false, error: "The outline's parent node is no longer in the course map. Reconcile the outline first." };
				setCurrent({ ...draft, currentStepId: stepId });
				return { ok: true, currentStepId: stepId };
			}),
		},
		lesson_expand: {
			name: "lesson_expand",
			label: "lesson_expand",
			description: "Explore a learner's question by adding an ordered branch to the current lesson step without replacing the course map. Use the current active branch ID as parentBranchId, or null at the root. Keep the same course-map parentNodeId in the branch outline. Enter the branch and present one step. Reuse the same ID on a retry; a conflicting duplicate is rejected. Return with lesson_return when the learner is ready.",
			parameters: expandInput,
			executionMode: "sequential",
			execute: serverExecute("lesson_expand", expandInput, async (input) => {
				if (needsReview) return { ok: false, error: "The lesson is stale; reconcile it before expanding." };
				const parsed = lessonBranchSchema.safeParse(input);
				if (!parsed.success) return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join("; ") };
				const previous = branches.find((branch) => branch.id === input.id);
				if (previous && activeBranchId === input.id && sameBranchDefinition(previous, parsed.data)) return { ok: true, branch: previous, reminder: "This branch already exists." };
				const parent = current();
				if (!parent || input.parentBranchId !== activeBranchId || parent.currentStepId !== input.parentStepId) return { ok: false, error: "Expand the current step in the current lesson or active branch." };
				if (input.outline.parentNodeId !== parent.parentNodeId || !ctx.chatStore.getChat(ctx.chatId)?.tree?.nodes.some((node) => node.id === parent.parentNodeId)) return { ok: false, error: "The original course-map parent is missing or does not match." };
				if (previous && !sameBranchDefinition(previous, parsed.data)) return { ok: false, error: "That branch ID is already in use." };
				if (!previous && branches.length >= 50) return { ok: false, error: "This lesson has reached its branch limit." };
				if (!previous) branches = [...branches, parsed.data];
				activeBranchId = input.id;
				return { ok: true, branch: previous ?? parsed.data, reminder: "Present one branch step and return to the interrupted lesson when appropriate." };
			}),
		},
		lesson_return: {
			name: "lesson_return",
			label: "lesson_return",
			description: "Leave the active branch and resume its preserved parent lesson or branch at the interrupted step. Respect the learner's current direction.",
			parameters: returnInput,
			executionMode: "sequential",
			execute: serverExecute("lesson_return", returnInput, async () => {
				const branch = branches.find((item) => item.id === activeBranchId);
				if (!branch) return { ok: false, error: "There is no active branch to leave." };
				activeBranchId = branch.parentBranchId;
				return { ok: true, activeBranchId, resumeStepId: branch.parentStepId, resumeOutline: current(), ...(needsReview ? { reminder: "The lesson still needs reconciliation; review it and use lesson_outline for a valid course node before advancing." } : {}) };
			}),
		},
	};
}
