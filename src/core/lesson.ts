import { z } from "zod";

const slug = z.string().regex(/^[a-z0-9_-]+$/).max(100);
export const lessonStepSchema = z.object({
	id: slug,
	title: z.string().trim().min(1).max(200),
	purpose: z.string().trim().min(1).max(1000),
	sources: z.array(z.string().trim().min(1).max(1000)).max(12),
	uncertainty: z.string().max(1000),
});
export const lessonOutlineSchema = z.object({
	parentNodeId: slug,
	problem: z.string().trim().min(1).max(2000),
	steps: z.array(lessonStepSchema).min(1).max(30),
	currentStepId: slug,
}).superRefine((outline, ctx) => {
	const ids = outline.steps.map((step) => step.id);
	if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Step IDs must be unique." });
	if (!ids.includes(outline.currentStepId)) ctx.addIssue({ code: "custom", message: "The current step must be in the outline." });
	if (JSON.stringify(outline).length > 8000) ctx.addIssue({ code: "custom", message: "The lesson outline must be at most 8,000 characters." });
});
export type LessonOutline = z.infer<typeof lessonOutlineSchema>;
export const lessonRecordSchema = z.object({
	version: z.literal(1),
	outline: lessonOutlineSchema,
	archivedOutlines: z.array(lessonOutlineSchema).max(100).default([]),
	historySignature: z.string(),
	planSignature: z.string(),
	needsReview: z.boolean(),
});
export type LessonRecord = z.infer<typeof lessonRecordSchema>;
