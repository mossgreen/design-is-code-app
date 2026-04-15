# Design is Code App — TODO

## Step 0: Project Path
- [ ] Text field for user to paste the absolute path of the project
- [ ] Backend scans the path for service files, entities, etc.
- [ ] Later: replace with git repo connection or file picker

## Step 1: User Story
- [ ] Scan project file names from connected codebase
- [ ] Based on matching, show existing services as suggestions
- [ ] Allow user to select, add new, or delete selections
- [ ] Free text input for the user story itself

## Step 2: Entry Point
- [ ] Show services discovered in Step 1 as options
- [ ] Allow user to pick one or create new
- [ ] This is the `component_under_test`
- [ ] Method: allow user to type a method name OR describe what it does (system generates name from description)
- [ ] Return type: define as abstraction (interface) first — consistent with participant naming rule

## Step 3: Collaborators (the core design step)
- [ ] Based on Step 2 answer, show each collaborator as a list item
- [ ] List should be reorderable (drag to change call order)
- [ ] Each row represents one interaction, laid out left to right:
  - **Abstraction** — the interface name (e.g., `OrderRepository`)
  - **Implementation** — explicit name or tick "Default" (e.g., `DefaultOrderRepository`)
  - **Method** — what it does (e.g., `save`)
  - **Input** — what goes in (e.g., `order : Order`)
  - **Return** — what comes back (e.g., `savedOrder : Order`)
- [ ] Allow add new row, delete row
- [ ] Should support marking branches (alt/else) and exceptions

## Step 4: Flow Preview
- [ ] Render the list from Step 3 as a visual sequence diagram
- [ ] Show participants at top, arrows between them
- [ ] Read-only visualisation — edits happen in Step 3
- [ ] Team review / sign-off happens here

## Step 5: Generate
- [ ] Serialize the design to structured JSON
- [ ] Feed to DisC engine (backend)
- [ ] Show generated tests + implementation
- [ ] Option to export / push to repo

## Open Questions
- Step 1 codebase scanning: build now or later? (needs git repo connection)
- Step 3 branch/exception UX: how to represent visually in a list?
- Step 4 rendering: plain HTML/CSS or use a diagram library?
- Team sign-off workflow: comments, approvals — what's MVP?
