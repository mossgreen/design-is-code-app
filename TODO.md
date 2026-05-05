# Design is Code App — TODO

The app's only output is **one valid UML sequence diagram** that DisC consumes.
DisC itself handles project scanning, CREATE/UPDATE detection, classification, test generation and implementation. This wizard stays thin.

## Helper: Connect project (optional)
- [x] Backend scan endpoint — walks `src/main/java/**/*.java`, returns classes, interfaces, data types, methods
- [x] "Connect project" chip in the header — path input + scan
- [ ] Future: replace path paste with git repo connection or file picker
- [ ] Scan result powers autocomplete in Step 2 (class + type datalist) and Step 3 (collaborators)
- Rule: the chip is **never a gate**. Empty means user types freely; reuse is optional, not required (aligns with DisC supporting CREATE and UPDATE equally).

## Step 1: User Story
- [x] Textarea for natural-language user story
- [ ] Multimodal icons (voice / image / video) shown disabled — roadmap signal only

## Step 2: Entry Point
- [x] Class input with scan-powered typeahead, story-keyword boost
- [x] Package (autofills from scan match)
- [x] Method name + method picks from existing class
- [x] Parameters list
- [x] Return type (datalist of primitives + scanned types)
- [ ] Post-MVP: allow the user to describe the method in natural language and have the system propose a name

## Step 3: Collaborators (the core design step)
- [ ] One row = one call arrow. Each row captures:
  - **Callee** — `Abstraction` or `Implementation : Abstraction` (colon-split per DisC participant naming)
  - **Method**
  - **Input** — e.g. `order : Order`
  - **Return** — e.g. `savedOrder : Order` (absence = no return arrow)
- [ ] Add / remove rows
- [ ] Reorder via ↑ / ↓ buttons (drag-drop is post-MVP)
- [ ] Autocomplete callee from scan (interfaces first, then classes)
- [ ] Post-MVP: fragment markers (`alt`, `loop`, `throws`) — defer until the row model is stable

## Step 4: Preview
- [ ] Render the entry + arrows as a minimalist sequence diagram
- [ ] Participants row at top (derived from entry + unique callees)
- [ ] Read-only — edits go back to Step 3
- [ ] Post-MVP: team review / sign-off

## Step 5: Generate
- [ ] Emit the design as structured JSON matching DisC's expected sequence-diagram shape
- [ ] Show the JSON + a copy button (MVP)
- [ ] Post-MVP: POST to backend → backend runs the DisC skill → stream back tests + implementation
- [ ] Post-MVP: export / push to repo

## Open questions
- Step 3 fragments (alt / loop / throws): how to represent visually without cluttering the row? (open)
- Step 4 rendering: hand-built HTML/CSS vs. a diagram library? (MVP = HTML/CSS)
- Backend-to-DisC handoff: shell out to the `claude` CLI with a crafted prompt, or expose an HTTP wrapper around the skill? (post-MVP decision)


## manual entered

in step 4, if we identify a participiant is not in an interaction, it's a leaf node, then we need to let user to decide, is it pure function. if it's pure function, then we need to provide a decision table.  