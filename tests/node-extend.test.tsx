/**
 * Node-extend (owner): a graph node's detail card offers "Extend in new
 * session" — the pick joins the home composer's selection (never
 * duplicated) and the composer prefills with "name: statement" ONLY when
 * its draft is empty (a typed draft is never clobbered). Sending still
 * rides the graphContext creation seam, so the new session starts clear.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { mergeNodePick, NodeDetailCardBody } from "../components/graph-view.tsx";
import { nodeExtendPrefill } from "../components/opening-prompt.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	host?.remove();
	host = null;
});

const NODE = { id: "n_1", name: "Idempotency keys", statement: "A key identifies the business operation." };

describe("mergeNodePick — the extend pick joins once, never twice", () => {
	it("adds an absent node", () => {
		assert.deepEqual(mergeNodePick([], NODE), [NODE]);
	});

	it("keeps the set identical when the node is already picked", () => {
		const picks = [{ ...NODE }, { id: "n_2", name: "Other", statement: "Else." }];
		const next = mergeNodePick(picks, { ...NODE });
		assert.equal(next.length, 2);
		assert.ok(next.filter((p) => p.id === NODE.id).length === 1);
	});
});

describe("nodeExtendPrefill — the composer draft wins over the node", () => {
	it("empty draft prefills with name + statement", () => {
		assert.equal(nodeExtendPrefill("", NODE), "Idempotency keys: A key identifies the business operation.");
		assert.equal(nodeExtendPrefill("   ", NODE), "Idempotency keys: A key identifies the business operation.");
	});

	it("a typed draft is left untouched", () => {
		assert.equal(nodeExtendPrefill("my own question", NODE), "my own question");
	});
});

describe("NodeDetailCardBody — the extend button", () => {
	async function mount(onExtend?: (node: typeof NODE) => void) {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root!.render(
				<NodeDetailCardBody
					node={NODE}
					sources={[{ id: "f1", label: "notes/import.md" }]}
					onExtend={onExtend}
				/>,
			);
		});
		return host!;
	}

	it("clicking extend reports the node once", async () => {
		const seen: unknown[] = [];
		const el = await mount((n) => {
			seen.push(n);
		});
		const button = el.querySelector<HTMLElement>('[data-testid="node-extend-session"]');
		assert.ok(button, "the extend button renders on the card");
		await act(async () => {
			button.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
		});
		assert.deepEqual(seen, [NODE]);
	});

	it("no handler, no button — the card stays as it was", async () => {
		const el = await mount(undefined);
		assert.equal(el.querySelector('[data-testid="node-extend-session"]'), null);
		assert.ok(el.textContent?.includes(NODE.name));
	});
});
