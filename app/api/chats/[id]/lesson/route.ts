import { getChat, safeLessonSnapshot } from "@/src/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	const snapshot = safeLessonSnapshot(id, chat);
	return Response.json({ lesson: snapshot.record, stale: snapshot.stale, orphanedBranchIds: snapshot.orphanedBranchIds ?? [], unavailable: !!snapshot.unavailable });
}
