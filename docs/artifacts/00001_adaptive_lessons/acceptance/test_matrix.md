# Test matrix

| Scenario | Expected result | Status |
| --- | --- | --- |
| Existing session with no outline | Opens normally and gains an outline only when teaching proceeds | Passed with temporary session |
| Existing session with unanswered question | Question stays answerable and continuation preserves its history | Passed with scripted server turn |
| Lesson answer, no request to pause | Explanation and next step follow | Passed with scripted model; real model behavior not yet tested |
| Learner asks for clarification | Stay on the relevant step | Pending |
| Restart and context compaction | Current outline and position survive | Passed sidecar reload and compaction test |
| Old app changes a shared session | Updated app detects or safely reconciles stale lesson metadata | Passed simulated older-app edit |
| Add a valid branch | Existing graph remains intact; branch can be taught and resumed | Passed tool, storage, nested return, and local sample map checks |
| Bad parent, cycle, repeated operation | No partial update or duplicate branch | Passed invalid parent, re-entry, and nested return; parent must already be active, preventing cycles |
| Original app opens shared session | No newer chat schema rejection | Passed with previous source on a copied chat; installed executable not checked |
| Windows packaged app | Production build, startup, and installer verified | Pending |
