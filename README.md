# Design is Code — Wizard

A small Spring Boot web app that lets you compose a sequence-diagram-driven design — participants, methods, calls, loops, creates — and emit a `.puml` file ready for the [DisC](https://github.com/mossgreen/design-is-code-plugin) Claude Code skill to turn into tests + implementation.

The wizard is intentionally thin. DisC handles project scanning, classification, test generation, and implementation. This app stays focused on **producing one valid UML sequence diagram**, with everything DisC needs (target package, well-formed call/return arrows, `<<create>>` and `loop` fragments).

## How it works

Four steps, top to bottom:

1. **User Story** — write the natural-language requirement.
2. **Designer** — define participants (interfaces with typed methods), then compose the call sequence one interaction at a time. Live SVG preview updates as you go.
3. **Review** — read-only snapshot: story, participant list, frozen diagram. The hand-off point.
4. **Generate** — pick the target Java package, name the file, save into your project's `design/` folder, and run `/design-is-code:disc <file>` from Claude Code (or click "Run it for me" to shell out automatically).

## Demo

End-to-end run — composing a design through the wizard, generating the `.puml`, and shelling out to DisC:

![Wizard end-to-end run](screenshots/run_disc_app_v1.gif)

The result of DisC consuming the generated `.puml` (tests + implementation produced):

![DisC run result](screenshots/disc_run_result.png)

## Running locally

Requires Java 21+.

```sh
./gradlew bootRun
```

Open <http://localhost:8080>. The demo seed loads with a complete invoice-generation flow (4 participants, 4 calls, 1 create, 1 loop) so you can click through end-to-end without typing anything first.

To restart cleanly if a prior run is still holding the port:

```sh
lsof -ti :8080 | xargs kill 2>/dev/null
./gradlew bootRun
```

## What gets emitted

For the seeded demo flow, the wizard produces:

```plantuml
@startuml
' @package com.example.invoice
InvoiceService -> OrderRepository : findAllByCustomerId(customerId: UUID)
InvoiceService <- OrderRepository : List<Order>
InvoiceService -> InvoiceBuilderFactory : create()
create InvoiceBuilder
InvoiceBuilderFactory --> InvoiceService : InvoiceBuilder
loop for each order in orders
  InvoiceService -> InvoiceBuilder : addLine(order: Order)
end
InvoiceService -> InvoiceBuilder : build()
InvoiceService <- InvoiceBuilder : Invoice
@enduml
```

The `' @package …` header is DisC's `target_placement` declaration — required by the `disc` skill before it will generate any code.

## Stack

- **Backend** — Spring Boot 4 (Java 21, Tomcat, Gradle).
- **Frontend** — vanilla HTML / CSS / JS. No framework, no build step. The live sequence diagram is hand-rolled SVG.
- **Backend endpoints** — `/api/scan` (project scan), `/api/design` (save `.puml`), `/api/run-disc` (shell out to `claude` CLI, stream output back).

## Prerequisites for "Run it for me"

The Step-4 "Run it for me" button shells out to:

```sh
claude --dangerously-skip-permissions -p /design-is-code:disc <file>
```

For that to work locally, you need:

- The `claude` CLI on your `PATH`.
- The [`design-is-code` plugin](https://github.com/mossgreen/design-is-code-plugin) installed in your Claude Code profile (provides the `/design-is-code:disc` slash command).

Without those, you can still copy the `.puml` and run DisC yourself anywhere `claude` is available.

## Status

Early/POC. Single-user, localhost-only. No persistence — refreshing the browser loses your work.
