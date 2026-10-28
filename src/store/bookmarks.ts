import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import type { Bookmark } from "../core/bookmarks.ts";

const directory = path.join(PATHS.data, "bookmarks");

export function listBookmarks(): Bookmark[] {
	let files: string[];
	try { files = fs.readdirSync(directory); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return files.filter((file) => /^[0-9a-f-]{36}\.json$/.test(file)).flatMap((file) => {
		try {
			const value: unknown = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
			if (!value || typeof value !== "object") return [];
			const item = value as Record<string, unknown>;
			if (typeof item.id !== "string" || `${item.id}.json` !== file || typeof item.chatId !== "string" || typeof item.messageId !== "string" || typeof item.text !== "string" || typeof item.createdAt !== "string") return [];
			return [{ id: item.id, chatId: item.chatId, messageId: item.messageId, text: item.text, createdAt: item.createdAt }];
		} catch { return []; }
	}).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function addBookmark(input: Pick<Bookmark, "chatId" | "messageId" | "text">): Bookmark {
	const bookmark = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, `${bookmark.id}.json`), JSON.stringify(bookmark), { encoding: "utf8", flag: "wx" });
	return bookmark;
}

export function deleteBookmark(id: string): boolean {
	if (!/^[0-9a-f-]{36}$/.test(id)) return false;
	try { fs.unlinkSync(path.join(directory, `${id}.json`)); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
