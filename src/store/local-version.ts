/**
 * LOCAL BUILD VERSION (owner): y.base_version for the settings Version
 * row — y is the commit count since the frozen base, base the package
 * version at freeze time. The freeze lands in data/local-version.json
 * (config.LOCAL_VERSION_FILE) on FIRST read, so base always means "the
 * tree as cloned"; repo edits can never move it. A dirty worktree
 * appends "+". Git missing / not a repo / base unresolvable degrades to
 * y=0, clean — never throws (the row must always render something).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import packageMetadata from "../../package.json" with { type: "json" };
import { LOCAL_VERSION_FILE, ROOT } from "../../config.ts";

export interface LocalVersion {
	/** Commits since the frozen base (0 when git cannot tell). */
	y: number;
	/** The frozen package version ("the tree as cloned"). */
	base: string;
	/** Uncommitted changes present (false when git cannot tell). */
	dirty: boolean;
	/** The row text: "y.base", dirty appends "+". */
	display: string;
}

interface FrozenBase {
	baseCommit: string | null;
	baseVersion: string;
}

/** One git call, trimmed stdout — null on ANY failure (no repo, no git,
 *  unknown revision, shallow graft). Callers degrade, never throw. */
function git(repoRoot: string, ...args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			cwd: repoRoot,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		return null;
	}
}

function sanitizeFrozen(raw: unknown): FrozenBase | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { baseCommit, baseVersion } = raw as Record<string, unknown>;
	if (typeof baseVersion !== "string" || baseVersion === "") return null;
	if (baseCommit !== null && typeof baseCommit !== "string") return null;
	return { baseCommit, baseVersion };
}

/** Read the freeze, writing it on first read (HEAD + package version).
 *  A corrupt file refreezes — a stale base is worse than a fresh one. */
function readFrozenBase(repoRoot: string): FrozenBase {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(LOCAL_VERSION_FILE, "utf-8"));
	} catch {
		parsed = null;
	}
	const frozen = sanitizeFrozen(parsed);
	if (frozen) return frozen;
	const fresh: FrozenBase = {
		baseCommit: git(repoRoot, "rev-parse", "HEAD"),
		baseVersion: typeof packageMetadata.version === "string" ? packageMetadata.version : "unknown",
	};
	fs.mkdirSync(path.dirname(LOCAL_VERSION_FILE), { recursive: true });
	fs.writeFileSync(LOCAL_VERSION_FILE, JSON.stringify(fresh, null, "\t"), "utf-8");
	return fresh;
}

export function readLocalVersion(repoRoot: string = ROOT): LocalVersion {
	const { baseCommit, baseVersion } = readFrozenBase(repoRoot);
	let y = 0;
	if (baseCommit) {
		const count = git(repoRoot, "rev-list", "--count", `${baseCommit}..HEAD`);
		const n = count === null ? NaN : Number(count);
		if (Number.isInteger(n) && n >= 0) y = n;
	}
	const status = git(repoRoot, "status", "--porcelain");
	const dirty = status !== null && status !== "";
	return { y, base: baseVersion, dirty, display: `${y}.${baseVersion}${dirty ? "+" : ""}` };
}
