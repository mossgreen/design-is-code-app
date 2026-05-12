# DisC Studio

The companion editor for the [DisC](https://github.com/mossgreen/design-is-code-plugin) methodology. Compose a sequence-diagram-driven design — participants, methods, decision tables, calls, loops, creates — and emit the `.puml` (plus any `.decision.md` sidecars) that DisC consumes to generate tests and implementation.

DisC Studio is intentionally thin: DisC owns codegen; the Studio owns design authoring.

## Quick start

Requires **Java 21 or newer** (`java -version` to check; install via [SDKMAN](https://sdkman.io/) `sdk install java 21-tem` or [Adoptium](https://adoptium.net/temurin/releases/?version=21)).

1. Download `disc-studio-<version>.jar` from the [latest Release](https://github.com/mossgreen/design-is-code-app/releases/latest).
2. Run it:

   ```sh
   java -jar disc-studio-0.4.1.jar
   ```

3. Open <http://localhost:8080> and click **Load simple demo** to see the editor end-to-end.

That's it. `Ctrl-C` in the terminal stops the app.

## Demo

End-to-end run — composing a design in DisC Studio, generating the `.puml`, and shelling out to DisC:

![DisC Studio end-to-end run](screenshots/run_disc_app_v1.gif)

The result of DisC consuming the generated `.puml` (tests + implementation produced):

![DisC run result](screenshots/disc_run_result.png)

## How it works

Four steps, top to bottom:

1. **User Story** — write the natural-language requirement.
2. **Designer** — define participants (interfaces with typed methods), then compose the call sequence one interaction at a time. Live SVG preview updates as you go.
3. **Review** — read-only snapshot: story, participant list, frozen diagram. The hand-off point.
4. **Generate** — pick the target Java package, name the file, save into your project's `design/` folder, and run `/design-is-code:disc <file>` from Claude Code (or click "Run it for me" to shell out automatically).

## "Run it for me" — optional

The Step-4 "Run it for me" button shells out to:

```sh
claude --dangerously-skip-permissions -p /design-is-code:disc <file>
```

…and streams the CLI's output back into the app. It requires the [`claude` CLI](https://docs.claude.com/en/docs/claude-code) on your `PATH` and the [`design-is-code` plugin](https://github.com/mossgreen/design-is-code-plugin) installed in your Claude Code profile. Without those, the rest of the editor still works — copy the `.puml` and run DisC manually wherever the CLI is available.

## Development

Build and run from source:

```sh
./gradlew bootRun
```

Then open <http://localhost:8080>. To produce the redistributable jar:

```sh
./gradlew bootJar
# build/libs/disc-studio-<version>.jar
```

**Stack:** Spring Boot 4 / Java 21 / vanilla HTML+CSS+JS / hand-rolled SVG. No frontend build step.

**E2E tests** live in [`e2e/`](e2e/) (Playwright against a running app). Start the app in one terminal, then in another: `cd e2e && npm install && npx playwright install chromium && npx playwright test`.

## Releasing

See [RELEASE.md](RELEASE.md) — version bump, tag, GitHub Release, jar attachment, all in one screen of copy-paste commands.

## Status

Early/POC. Single-user, localhost-only. No persistence — refreshing the browser loses your work.
