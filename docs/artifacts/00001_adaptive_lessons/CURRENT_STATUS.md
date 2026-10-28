# Current status

- Task 1: LANDED (2026-10-28; b52a77c). The lesson sidecar, teaching instructions, and continuation flow are implemented. Focused tests and a scripted server entry point pass. A copied existing chat and the previous source version were checked for format compatibility.
- Task 2: LANDED (2026-10-28; 43a8d41). Branch tools and map are implemented. Unit tests cover nesting, return, re-entry, missing parents, and preservation. A local sample chat displayed a branch after reload; desktop and narrow previews were inspected.
- Installer: built from 43a8d41 on Windows on 2026-10-28. The packaged server booted against isolated data and responded on 127.0.0.1. The installer and application are unsigned; the installer and GUI were not launched. SHA-256: 51ff9c4b1c90253e2e09b942af447dbeb305acad4f34a83b5b1fd15b3655963d.

Limits: The scripted provider does not prove how a real model follows the instructions. The original installed executable has not been exercised. If the app exits after saving a reply but before saving lesson metadata, the reply survives but the outline can be absent or stale; the next lesson must be reconciled from the transcript. The plan popup displays the saved lesson step without treating it as proof of understanding.
