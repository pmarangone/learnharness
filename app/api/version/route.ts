/**
 * GET /api/version — the settings Version row's local build number:
 * y.base_version, y the commit count since the frozen base (plus a
 * dirty "+" for uncommitted edits). Thin transport over the store;
 * the store never throws, so neither does this route.
 */
import { readLocalVersion } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const { y, base, dirty, display } = readLocalVersion();
	return Response.json({ y, base, dirty, display });
}
