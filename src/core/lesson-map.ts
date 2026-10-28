import type { LessonRecord } from "./lesson.ts";
import type { PlanNode, PlanNodeStatus, PlanTree } from "./contracts/plan.ts";

export interface LessonMapEdge { from: string; to: string; kind?: "contains" }
export interface LessonMapView {
	nodes: PlanNode[];
	edges: LessonMapEdge[];
	currentStep: string | null;
	stepIds: ReadonlySet<string>;
}

/** Add presentation-only containment links. The saved prerequisite map is untouched. */
export function lessonMapView(tree: PlanTree, lesson: LessonRecord | null): LessonMapView {
	const nodes = [...tree.nodes];
	const edges: LessonMapEdge[] = [...tree.edges];
	const stepIds = new Set<string>();
	if (!lesson) return { nodes, edges, currentStep: null, stepIds };
	const stepId = (course: string, branch: string | null, id: string) => branch ? `:lesson:branch:${branch}:${id}` : `:lesson:root:${course}:${id}`;
	const appendSteps = (parentId: string, branchId: string | null, outline: LessonRecord["outline"]) => {
		outline.steps.forEach((step, index) => {
			const id = stepId(outline.parentNodeId, branchId, step.id);
			stepIds.add(id);
			nodes.push({ id, title: `${index + 1}. ${step.title}` });
			edges.push({ from: parentId, to: id, kind: "contains" });
		});
	};
	const roots = new Map([...lesson.archivedOutlines, lesson.outline].map((outline) => [outline.parentNodeId, outline]));
	const courseAnchor = (courseId: string) => {
		if (tree.nodes.some((node) => node.id === courseId)) return courseId;
		const id = `:lesson:removed:${courseId}`;
		if (!stepIds.has(id)) {
			stepIds.add(id);
			nodes.push({ id, title: `Removed topic: ${courseId}` });
		}
		return id;
	};
	for (const [courseId, outline] of roots) appendSteps(courseAnchor(courseId), null, outline);
	for (const branch of lesson.branches) {
		let parent = stepId(branch.outline.parentNodeId, branch.parentBranchId, branch.parentStepId);
		if (!stepIds.has(parent)) {
			parent = `:lesson:removed-step:${branch.id}`;
			stepIds.add(parent);
			nodes.push({ id: parent, title: `Removed step: ${branch.parentStepId}` });
			edges.push({ from: courseAnchor(branch.outline.parentNodeId), to: parent, kind: "contains" });
		}
		const branchNode = `:lesson:heading:${branch.id}`;
		nodes.push({ id: branchNode, title: branch.outline.problem.length > 120 ? `${branch.outline.problem.slice(0, 117)}...` : branch.outline.problem });
		stepIds.add(branchNode);
		edges.push({ from: parent, to: branchNode, kind: "contains" });
		appendSteps(branchNode, branch.id, branch.outline);
	}
	const active = lesson.activeBranchId ? lesson.branches.find((branch) => branch.id === lesson.activeBranchId)?.outline : lesson.outline;
	const currentStep = active ? stepId(active.parentNodeId, lesson.activeBranchId, active.currentStepId) : null;
	return { nodes, edges, currentStep: currentStep && stepIds.has(currentStep) ? currentStep : null, stepIds };
}

export function lessonMapStatus(id: string, view: LessonMapView, courseStatus: (id: string) => PlanNodeStatus): PlanNodeStatus {
	if (view.stepIds.has(id)) return id === view.currentStep ? "current" : "upcoming";
	return courseStatus(id);
}
