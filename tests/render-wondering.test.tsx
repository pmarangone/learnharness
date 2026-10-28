/**
 * Wondering Phase 1 directives: portable ::: blocks → interactive cards.
 * Static HTML via react-dom/server (no DOM); pure parser unit tests.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import {
	parseCloze,
	parseCompare,
	parseConcept,
	parseOrder,
	parseQuiz,
	parseWonderHeader,
	transformWondering,
} from "../components/wondering.tsx";

function render(md: string): string {
	return renderToStaticMarkup(<MessageResponse mode="static">{md}</MessageResponse>);
}

describe("wondering transport (pure)", () => {
	it("rewrites :::concept into a wonder fence, leaves prose and fences alone", () => {
		const out = transformWondering("Hi\n\n:::concept Weight\nA strength number.\n:::\n\nBye");
		assert.ok(out.includes("```wonder-concept Weight"), "directive becomes a fence");
		assert.ok(out.includes("A strength number."), "body preserved");
		assert.ok(!out.includes(":::"), "no marker leaks");
		const fenced = transformWondering("```js\n:::concept x\n```");
		assert.ok(fenced.includes(":::concept x"), "fenced code is a barrier");
		assert.ok(!out.includes("```wonder-concept Weight\n```wonder"), "single fence only");
	});

	it("parses wonder fence headers", () => {
		assert.deepEqual(parseWonderHeader("wonder-concept Weight"), { kind: "concept", title: "Weight" });
		assert.deepEqual(parseWonderHeader("wonder-quiz"), { kind: "quiz", title: "" });
		assert.equal(parseWonderHeader("js"), null);
	});

	it("parses each directive body", () => {
		assert.deepEqual(parseConcept("Weight", "A number.\nAnalogy: exams."), {
			title: "Weight",
			body: ["A number.", "Analogy: exams."],
		});
		assert.deepEqual(parseCompare("[Before]\n- Random\n[After]\n- Tuned"), [
			{ label: "Before", lines: ["Random"] },
			{ label: "After", lines: ["Tuned"] },
		]);
		assert.deepEqual(parseQuiz("Q: What changes?\n- Data\n- Weights\nA: 2"), {
			question: "What changes?",
			options: ["Data", "Weights"],
			answer: 1,
		});
		assert.deepEqual(parseCloze("Weights {{blank}} update.\nA: all"), {
			text: "Weights {{blank}} update.",
			answer: "all",
		});
		assert.deepEqual(parseOrder("1. Input\n2. Predict\n3. Update"), ["Input", "Predict", "Update"]);
	});
});

describe("wondering render", () => {
	it("concept card mounts, title + body present", () => {
		const html = render(":::concept Weight\nA strength number.\n:::");
		assert.ok(html.includes('data-testid="wonder-concept"'), "card mounts");
		assert.ok(html.includes("Weight"), "title present");
		assert.ok(html.includes("A strength number."), "body present");
	});

	it("compare tabs mount with both labels, first panel visible", () => {
		const html = render(":::compare\n[Before]\n- Random\n[After]\n- Tuned\n:::");
		assert.ok(html.includes('data-testid="wonder-compare"'), "tabs mount");
		assert.ok(html.includes("Before") && html.includes("After"), "both labels present");
		assert.ok(html.includes("Random"), "first panel lines render");
	});

	it("quiz shows question + options, answer hidden until picked", () => {
		const html = render(":::quiz\nQ: What changes?\n- Data\n- Weights\nA: 2\n:::");
		assert.ok(html.includes('data-testid="wonder-quiz"'), "quiz mounts");
		assert.ok(html.includes("What changes?"), "question present");
		assert.ok(html.includes("Weights"), "options present");
		assert.ok(!html.includes("Correct."), "no feedback before interaction");
	});

	it("cloze shows input, cloze/order never leak the answer as visible feedback", () => {
		const cloze = render("Fill {{blank}} here.\n\n:::cloze\nLoss {{blank}} falls.\nA: fast\n:::");
		assert.ok(cloze.includes('data-testid="wonder-cloze"'), "cloze mounts");
		const order = render(":::order\n1. Input\n2. Predict\n:::");
		assert.ok(order.includes('data-testid="wonder-order"'), "order mounts");
		assert.ok(order.includes("Tap the steps in order."), "instructions present");
	});

	it("GFM tables/images/mermaid paths are untouched", () => {
		const table = render("| A | B |\n| --- | --- |\n| 1 | 2 |");
		assert.ok(table.includes('data-testid="md-table"'), "tables keep the prose path");
		const mermaid = render("```mermaid\ngraph TD\nA --> B\n```");
		assert.ok(mermaid.includes('data-testid="md-mermaid"'), "mermaid keeps the app-owned path");
	});
});
