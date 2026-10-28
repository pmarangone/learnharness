"use client";

import { useEffect, useState } from "react";
import { BookmarkIcon } from "lucide-react";

interface SelectionBookmark { text: string; messageId: string; x: number; y: number }

export function BookmarkSelection({ chatId, scopeRef }: { chatId: string; scopeRef: React.RefObject<HTMLDivElement | null> }) {
	const [selection, setSelection] = useState<SelectionBookmark | null>(null);
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		const update = () => {
			const selected = window.getSelection();
			if (!selected || selected.isCollapsed || !selected.rangeCount) { setSelection(null); return; }
			const range = selected.getRangeAt(0);
			const start = range.startContainer.parentElement?.closest<HTMLElement>("[data-source-message-id]");
			const end = range.endContainer.parentElement?.closest<HTMLElement>("[data-source-message-id]");
			const text = selected.toString().trim();
			if (!start || start !== end || !scopeRef.current?.contains(start) || !start.dataset.sourceMessageId || !text) { setSelection(null); return; }
			const rect = range.getBoundingClientRect();
			setError("");
			setSelection({ text, messageId: start.dataset.sourceMessageId, x: Math.max(70, Math.min(window.innerWidth - 70, rect.left + rect.width / 2)), y: Math.max(12, rect.top - 42) });
		};
		document.addEventListener("selectionchange", update);
		window.addEventListener("scroll", update, true);
		return () => { document.removeEventListener("selectionchange", update); window.removeEventListener("scroll", update, true); };
	}, [scopeRef]);

	if (!selection) return null;
	return <div className="fixed z-50 -translate-x-1/2 rounded-md border border-border bg-popover p-1 shadow-lg" style={{ left: selection.x, top: selection.y }}>
		<button type="button" aria-label="Bookmark selected text" disabled={saving} onMouseDown={(event) => event.preventDefault()} onClick={async () => {
			setSaving(true);
			try {
				const response = await fetch("/api/bookmarks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, messageId: selection.messageId, text: selection.text }) });
				if (!response.ok) throw new Error("Could not save bookmark");
				window.dispatchEvent(new Event("lh:bookmarks-changed"));
				window.getSelection()?.removeAllRanges();
				setSelection(null);
			} catch { setError("Could not save bookmark"); }
			finally { setSaving(false); }
		}} className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"><BookmarkIcon className="size-3.5" /> Bookmark</button>
		{error && <p role="alert" className="px-2 text-xs text-destructive">{error}</p>}
	</div>;
}
