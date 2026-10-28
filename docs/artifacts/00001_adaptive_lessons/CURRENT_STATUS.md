# Current status

- Task 1: LANDED (2026-10-28; commit containing WI-01). The lesson sidecar, teaching instructions, and continuation flow are implemented. Focused tests and a scripted server entry point pass. A copied existing chat and the previous source version were checked for format compatibility.
- Task 2: BACKLOG.
- Installer: pending. Tell the learner before starting the rebuild.

Limits: The scripted provider does not prove how a real model follows the instructions. The original installed executable has not been exercised. If the app exits after saving a reply but before saving lesson metadata, the reply survives but the outline can be absent or stale; the next lesson must be reconciled from the transcript. The existing course map derives its position from question calls, so an explanation with no question does not move the displayed course position. Task 2 must address presentation of the active lesson without claiming mastery.
