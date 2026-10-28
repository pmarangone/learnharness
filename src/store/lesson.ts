import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import { lessonRecordSchema, type LessonRecord } from "../core/lesson.ts";

function lessonFile(chatId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error("Invalid session ID");
	return path.join(PATHS.data, "lesson-outlines", `${chatId}.json`);
}

export function readLesson(chatId: string): LessonRecord | null {
	let raw: string;
	try { raw = fs.readFileSync(lessonFile(chatId), "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	return lessonRecordSchema.parse(JSON.parse(raw));
}

export function writeLesson(chatId: string, record: LessonRecord): void {
	const file = lessonFile(chatId);
	const data = lessonRecordSchema.parse(record);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx" });
		fs.renameSync(temporary, file);
	} finally {
		try { fs.unlinkSync(temporary); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

export function deleteLesson(chatId: string): void {
	try { fs.unlinkSync(lessonFile(chatId)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
