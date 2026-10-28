import assert from "node:assert/strict";
import { test } from "node:test";
import { appearanceVars, resolveAppearance } from "../components/settings/appearance.tsx";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";

test("lesson width can be saved, restored, and applied to the reading column", () => {
	const parsed = parseAppearanceSettingsBody({ readingWidth: 60, proseFontSize: 18 });
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const stored = sanitizeUserSettings({ version: 1, appearance: parsed.settings });
	assert.equal(stored?.appearance?.readingWidth, 60);
	assert.equal(stored?.appearance?.proseFontSize, 18);
	assert.equal(appearanceVars(resolveAppearance(stored?.appearance))["--lh-reading-width"], "60%");
	assert.equal(appearanceVars(resolveAppearance(undefined))["--lh-reading-width"], "100%");
});

test("lesson width rejects invalid values at the settings boundary", () => {
	for (const value of [39, 101, 60.5, "60"]) {
		assert.equal(parseAppearanceSettingsBody({ readingWidth: value }).ok, false);
	}
});
