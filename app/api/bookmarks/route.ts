import { addBookmark, deleteBookmark, listBookmarks } from "@/src/store/bookmarks";
import { getChat } from "@/src/server";

export function GET() {
	return Response.json({ bookmarks: listBookmarks() });
}

export async function POST(request: Request) {
	const body: unknown = await request.json().catch(() => null);
	if (!body || typeof body !== "object") return Response.json({ error: "Invalid bookmark" }, { status: 400 });
	const input = body as Record<string, unknown>;
	if (typeof input.chatId !== "string" || typeof input.messageId !== "string" || !input.messageId || typeof input.text !== "string" || !input.text.trim() || input.text.length > 10000) {
		return Response.json({ error: "Select up to 10,000 characters from a message." }, { status: 400 });
	}
	if (!getChat(input.chatId)) return Response.json({ error: "Session not found" }, { status: 404 });
	return Response.json({ bookmark: addBookmark({ chatId: input.chatId, messageId: input.messageId, text: input.text.trim() }) }, { status: 201 });
}

export async function DELETE(request: Request) {
	const id = new URL(request.url).searchParams.get("id") ?? "";
	return deleteBookmark(id) ? Response.json({ ok: true }) : Response.json({ error: "Bookmark not found" }, { status: 404 });
}
