"use client";

/**
 * Wondering visual-aids Phase 1 (portable Markdown directives): isolated
 * parsers + renderers. No store writes, no graph writes — pure display.
 *
 * Authoring (taught in teacher/50-demos.md):
 *   :::concept Title … :::   knowledge card
 *   :::compare … :::         switchable [A]/[B] tabs
 *   :::quiz … :::            multiple-choice (answer hidden until pick)
 *   :::cloze … :::           fill-in-the-blank ({{blank}} marker)
 *   :::order … :::           step ordering (shuffled, tap to order)
 *
 * Transport: MessageResponse pre-pass (transformWondering) rewrites each
 * ::: block into a ```wonder-<kind> fence; MarkdownCode intercepts it.
 * Fences are also authorable directly.
 */

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export type WonderKind = "concept" | "compare" | "quiz" | "cloze" | "order";

/** Split raw fence body into non-empty lines. Pure. */
function linesOf(src: string): string[] {
	return src
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.trim().length > 0);
}

// ─── concept ────────────────────────────────────────────────────────────────

export interface ConceptData {
	title: string;
	body: string[];
}

export function parseConcept(title: string, src: string): ConceptData {
	return { title: title.trim(), body: linesOf(src) };
}

export function ConceptCard({ title, body }: ConceptData) {
	return (
		<div data-testid="wonder-concept" className="group/md relative my-4 rounded-md border border-border bg-card px-4 py-3">
			{title && <p className="mb-1 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">{title}</p>}
			<div className="space-y-1 text-sm">
				{body.map((l, i) => (
					<p key={i}>{l}</p>
				))}
			</div>
		</div>
	);
}

// ─── compare ────────────────────────────────────────────────────────────────

export interface ComparePanel {
	label: string;
	lines: string[];
}

export function parseCompare(src: string): ComparePanel[] {
	const panels: ComparePanel[] = [];
	let cur: ComparePanel | null = null;
	for (const raw of src.split("\n")) {
		const l = raw.trim();
		if (!l) continue;
		const m = /^\[(.+)\]\s*$/.exec(l);
		if (m) {
			cur = { label: m[1]!.trim(), lines: [] };
			panels.push(cur);
		} else if (cur) {
			cur.lines.push(l.replace(/^[-*]\s+/, ""));
		}
	}
	return panels;
}

export function CompareTabs({ panels }: { panels: ComparePanel[] }) {
	const [tab, setTab] = useState(0);
	if (panels.length === 0) return null;
	return (
		<div data-testid="wonder-compare" className="my-4 rounded-md border border-border">
			<div className="flex gap-1 border-b border-border p-1" role="tablist">
				{panels.map((p, i) => (
					<button
						key={i}
						type="button"
						role="tab"
						aria-selected={i === tab}
						data-testid={`wonder-compare-tab-${i}`}
						onClick={() => setTab(i)}
						className={cn(
							"rounded px-2.5 py-1 text-xs",
							i === tab ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
						)}
					>
						{p.label}
					</button>
				))}
			</div>
			<ul className="space-y-1 px-4 py-3 text-sm">
				{(panels[tab]?.lines ?? []).map((l, i) => (
					<li key={i} className="list-disc list-inside">
						{l}
					</li>
				))}
			</ul>
		</div>
	);
}

// ─── quiz ───────────────────────────────────────────────────────────────────

export interface QuizData {
	question: string;
	options: string[];
	answer: number; // 0-based; -1 = unknown
}

export function parseQuiz(src: string): QuizData {
	let question = "";
	const options: string[] = [];
	let answer = -1;
	for (const raw of src.split("\n")) {
		const l = raw.trim();
		if (!l) continue;
		if (/^(q(uestion)?\s*:)/i.test(l)) question = l.replace(/^q(uestion)?\s*:\s*/i, "");
		else if (/^(a(nswer)?\s*:)/i.test(l)) {
			const n = Number.parseInt(l.replace(/^a(nswer)?\s*:\s*/i, ""), 10);
			if (Number.isFinite(n)) answer = n - 1; // authoring is 1-based
		} else if (/^[-*]\s+/.test(l)) options.push(l.replace(/^[-*]\s+/, ""));
		else if (!question) question = l;
	}
	return { question, options, answer };
}

export function QuizBlock({ data }: { data: QuizData }) {
	const [pick, setPick] = useState<number | null>(null);
	const revealed = pick !== null;
	return (
		<div data-testid="wonder-quiz" className="my-4 rounded-md border border-border bg-card px-4 py-3">
			<p className="mb-2 text-sm font-medium">{data.question}</p>
			<div className="space-y-1.5">
				{data.options.map((o, i) => {
					const correct = revealed && i === data.answer;
					const wrong = revealed && i === pick && pick !== data.answer;
					return (
						<button
							key={i}
							type="button"
							data-testid={`wonder-quiz-opt-${i}`}
							disabled={revealed}
							onClick={() => setPick(i)}
							className={cn(
								"block w-full rounded border px-2.5 py-1.5 text-left text-sm",
								correct
									? "border-green-500 text-foreground"
									: wrong
										? "border-red-500 text-foreground"
										: "border-border text-muted-foreground hover:text-foreground",
							)}
						>
							{o}
						</button>
					);
				})}
			</div>
			{revealed && (
				<p data-testid="wonder-quiz-feedback" className="mt-2 text-xs text-muted-foreground">
					{pick === data.answer ? "Correct." : data.answer >= 0 ? `Not quite — the answer is option ${data.answer + 1}.` : "Locked in."}
				</p>
			)}
		</div>
	);
}

// ─── cloze ──────────────────────────────────────────────────────────────────

export interface ClozeData {
	text: string; // with {{blank}} marker
	answer: string;
}

export function parseCloze(src: string): ClozeData {
	let answer = "";
	const body: string[] = [];
	for (const raw of src.split("\n")) {
		const l = raw.trim();
		if (!l) continue;
		if (/^(a(nswer)?\s*:)/i.test(l)) answer = l.replace(/^a(nswer)?\s*:\s*/i, "").trim();
		else body.push(raw.trimEnd());
	}
	return { text: body.join("\n"), answer };
}

export function ClozeBlock({ data }: { data: ClozeData }) {
	const [value, setValue] = useState("");
	const [done, setDone] = useState(false);
	const ok = done && value.trim().toLowerCase() === data.answer.toLowerCase();
	const parts = data.text.split("{{blank}}");
	return (
		<div data-testid="wonder-cloze" className="my-4 rounded-md border border-border px-4 py-3">
			<p className="text-sm">
				{parts.map((p, i) => (
					<span key={i}>
						{p}
						{i < parts.length - 1 && (
							<input
								data-testid="wonder-cloze-input"
								value={value}
								disabled={done}
								onChange={(e) => setValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && value.trim()) setDone(true);
								}}
								placeholder="…"
								aria-label="Fill in the blank"
								className="mx-1 inline-block w-28 rounded border border-border bg-background px-1.5 py-0.5 text-sm"
							/>
						)}
					</span>
				))}
			</p>
			{!done ? (
				<button
					type="button"
					data-testid="wonder-cloze-check"
					disabled={!value.trim()}
					onClick={() => setDone(true)}
					className="mt-2 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
				>
					Check
				</button>
			) : (
				<p data-testid="wonder-cloze-feedback" className="mt-2 text-xs text-muted-foreground">
					{ok ? "Correct." : data.answer ? `The answer is “${data.answer}”.` : "Locked in."}
				</p>
			)}
		</div>
	);
}

// ─── order ──────────────────────────────────────────────────────────────────

export function parseOrder(src: string): string[] {
	return linesOf(src).map((l) => l.replace(/^(\d+[.)]|[-*])\s+/, ""));
}

/** Deterministic shuffle (seeded) so server/static and client agree. */
function shuffled<T>(arr: T[]): T[] {
	const out = [...arr];
	let s = 0x9e3779b9;
	const rnd = () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return ((s >>> 0) % 1000) / 1000;
	};
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

export function OrderBlock({ steps }: { steps: string[] }) {
	const order = useMemo(() => shuffled(steps.map((_, i) => i)), [steps]);
	const [picked, setPicked] = useState<number[]>([]);
	const [done, setDone] = useState(false);
	const remaining = order.filter((i) => !picked.includes(i));
	const correct = done && picked.every((v, i) => v === i) && picked.length === steps.length;
	return (
		<div data-testid="wonder-order" className="my-4 rounded-md border border-border px-4 py-3">
			<p className="mb-2 text-xs text-muted-foreground">Tap the steps in order.</p>
			<div className="space-y-1.5">
				{remaining.map((si) => (
					<button
						key={si}
						type="button"
						data-testid={`wonder-order-pick-${si}`}
						disabled={done}
						onClick={() => setPicked((p) => [...p, si])}
						className="block w-full rounded border border-border px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:text-foreground"
					>
						{steps[si]}
					</button>
				))}
			</div>
			{picked.length > 0 && (
				<ol className="mt-2 space-y-1">
					{picked.map((si, pos) => (
						<li key={pos} data-testid={`wonder-order-placed-${pos}`} className="text-sm">
							<span className="mr-1.5 font-mono text-xs text-muted-foreground">{pos + 1}.</span>
							{steps[si]}
							<button
								type="button"
								aria-label="Undo last"
								disabled={done}
								onClick={() => !done && setPicked((p) => p.slice(0, -1))}
								className="ml-2 text-xs text-muted-foreground underline disabled:opacity-40"
							>
								undo
							</button>
						</li>
					))}
				</ol>
			)}
			{picked.length === steps.length && !done && (
				<button
					type="button"
					data-testid="wonder-order-check"
					onClick={() => setDone(true)}
					className="mt-2 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
				>
					Check order
				</button>
			)}
			{done && (
				<p data-testid="wonder-order-feedback" className="mt-2 text-xs text-muted-foreground">
					{correct ? "Correct order." : "Not quite — try again next time."}
				</p>
			)}
		</div>
	);
}

// ─── transport: ::: blocks → fences ─────────────────────────────────────────

/**
 * Rewrite portable ::: directives into ```wonder-<kind> fences so the
 * existing code-fence path (no remark-directive plugin needed) carries
 * them. Pure string → string; fences and inline code are barriers.
 * Closing `:::` on its own line; title rides the opening line.
 */
const DIRECTIVE_RE = /^ {0,3}:::(concept|compare|quiz|cloze|order)([^\n]*)\n([\s\S]*?)\n {0,3}:::[ \t]*$/gm;

export function transformWondering(md: string): string {
	// Skip when no directive marker is present (cheap path for prose).
	if (!md.includes(":::")) return md;
	// Protect fenced code: split on fences, transform only prose spans.
	const parts = md.split(/(```[\s\S]*?```)/g);
	for (let i = 0; i < parts.length; i += 2) {
		parts[i] = parts[i]!.replace(DIRECTIVE_RE, (_m, kind: string, title: string, body: string) => {
			const t = (title as string).trim();
			return `\`\`\`wonder-${kind}${t ? ` ${t}` : ""}\n${(body as string).trim()}\n\`\`\``;
		});
	}
	return parts.join("");
}

/** Parse a wonder fence header: `wonder-<kind>[ title]`. Pure. */
export function parseWonderHeader(info: string): { kind: WonderKind; title: string } | null {
	const m = /^wonder-(concept|compare|quiz|cloze|order)(?:\s+(.*))?$/.exec(info.trim());
	if (!m) return null;
	return { kind: m[1] as WonderKind, title: (m[2] ?? "").trim() };
}
