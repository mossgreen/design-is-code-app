---
id: update-mode-binding
title: update-mode binding
why: changing an existing class must anchor to it — an unbound SUT means the proposal was designed blind to the code it will overwrite
applies-when: the story names an existing catalog type as the thing being changed, or a current code flow is provided
severity: must
assertion: when the story names an existing catalog type as the thing being changed (e.g. "Update X", "change X", "X now …"), the root participant keeps that exact name AND sets `existingFqn` to the catalog FQN; its entry-method signature matches the catalog; every call listed in a provided current flow appears in the design unless an AC row requires changing that specific call
---

The wizard supports two modes and the story tells you which one you are in:

- **CREATE** (greenfield): nothing exists; propose freely.
- **UPDATE** (brownfield): the story names an existing class as the thing
  being changed. This rule governs UPDATE.

In UPDATE mode:

1. **The named class IS the root participant.** Keep its exact name and set
   `existingFqn` to its catalog FQN. Do not invent a parallel class, do not
   rename, do not leave it unbound. (Entities already follow this; the SUT
   and collaborators must too.)
2. **The entry signature is a public contract — keep it.** The entry method's
   name and parameters come from the catalog, not from your redesign. Changing
   them breaks every existing caller.
3. **The current flow is inventory, not inspiration.** When a derived flow is
   provided, every call in it must reappear in your design unless an
   acceptance-criteria row explicitly requires changing that call. An
   orchestrator is regenerated wholesale from the design: an omitted guard,
   load, or save is not "simplified away" — it is deleted from working code.
4. **Collaborators bind too.** A flow participant that exists in the catalog
   carries its `existingFqn`; leaves stay sacred and are reused, not
   recreated.

The most common failure this rule exists to stop: a variance ticket restates
only the rows that vary (correct), and the analysis then designs only what
the rows mention — dropping the guard and the loading that the ticket never
questioned. The AC is the delta; the flow is the baseline; the design is
baseline + delta, never delta alone.
