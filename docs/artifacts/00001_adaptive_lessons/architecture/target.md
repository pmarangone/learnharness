# Target design

```text
Existing chat record: messages + plan graph + pending questions
                              |
                              v
Teacher: current problem -> one step -> question -> response -> next step
                              |
                              v
Session-scoped lesson metadata: outline, position, detours, sources
                              |
                  expand an existing plan node
```

Keep the existing plan graph as the course map. Any new lesson metadata must not make the old app reject a chat or rewrite its message history. Determine safe recovery and consistency with changes made by the older app before committing to the storage shape. A parent/child teaching relationship is distinct from a prerequisite edge.
