/**
 * LOCAL BUILD VERSION (owner): y.base_version — y is the commit count
 * since the frozen base, base is the package version at freeze time.
 * The freeze lands on first read, so base always means "the tree as
 * cloned"; a dirty worktree appends "+". Git missing / no repo / base
 * unresolvable degrades to y=0, never an error.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-version-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { readLocalVersion } = await import("../src/store/local-version.ts");
const { LOCAL_VERSION_FILE } = await import("../config.ts");

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixtureRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lv-repo-"));
	git(dir, "init", "-q");
	git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
	return dir;
}

describe("readLocalVersion", () => {
	// The freeze is one file per data dir — clear it so each case freezes
	// against its own fixture repo.
	beforeEach(() => {
		fs.rmSync(LOCAL_VERSION_FILE, { force: true });
	});
	it("freezes the base on first read: y=0, display 0.base", () => {
		const repo = fixtureRepo();
		const v = readLocalVersion(repo);
		assert.equal(v.y, 0);
		assert.equal(v.dirty, false);
		assert.match(v.display, /^0\.\d+\.\d+\.\d+$/);
		const frozen = JSON.parse(fs.readFileSync(LOCAL_VERSION_FILE, "utf-8")) as { baseCommit: string };
		assert.equal(frozen.baseCommit, git(repo, "rev-parse", "HEAD"));
	});

	it("counts commits since the frozen base", () => {
		const repo = fixtureRepo();
		readLocalVersion(repo);
		git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
		git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "two");
		const v = readLocalVersion(repo);
		assert.equal(v.y, 2);
		assert.match(v.display, /^2\.\d+\.\d+\.\d+$/);
	});

	it("marks a dirty worktree with +", () => {
		const repo = fixtureRepo();
		readLocalVersion(repo);
		fs.writeFileSync(path.join(repo, "scratch.txt"), "uncommitted");
		const v = readLocalVersion(repo);
		assert.equal(v.dirty, true);
		assert.match(v.display, /^0\.\d+\.\d+\.\d+\+$/);
	});

	it("a non-repo degrades to y=0, clean, never throws", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lv-plain-"));
		const v = readLocalVersion(dir);
		assert.equal(v.y, 0);
		assert.equal(v.dirty, false);
		assert.match(v.display, /^0\.\d+\.\d+\.\d+$/);
	});
});
