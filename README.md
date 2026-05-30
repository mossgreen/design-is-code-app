# DisC Studio

DisC Studio is the design step in front of [DisC](https://github.com/mossgreen/design-is-code-plugin). You give it user story and acceptance criteria; it gives back an editable sequence-diagram design. Hand the design off to DisC and you get working Java/Spring code with TDD style tests.

## Demo

End-to-end: composing a design in DisC Studio, generating the `.puml`, and shelling out to DisC.

![DisC Studio end-to-end run](screenshots/run_disc_app_v1.gif)

DisC's output — tests and implementation produced from the `.puml`:

![DisC run result](screenshots/disc_run_result.png)

## What you need

### 1. Java 17 or newer · required

DisC Studio runs on Spring Boot 4. Java 17 LTS is the minimum; 21 LTS works too. Older JDKs fail at startup with `UnsupportedClassVersionError`.

Check what you have:
```sh
java -version
```

Install if needed:
- [SDKMAN](https://sdkman.io/) (macOS / Linux / WSL) — `sdk install java 17-tem`
- [Adoptium / Temurin](https://adoptium.net/temurin/releases/?version=17) — direct downloads for macOS, Windows, and Linux (`.msi` installer on Windows)

After install, make sure `java -version` resolves on your PATH (the Temurin installer does this on Windows; on macOS/Linux SDKMAN handles it).

### 2. Claude Code CLI · required

The Studio shells out to the `claude` CLI on Step 2 (Design) — one Analyze click chains three LLM calls: decompose acceptance criteria into participants, compose the call sequence, and validate the design against the codegen plugin. Step 4 shells out again when you click **Run it for me** to do the actual code generation. Without Claude Code on your PATH, Step 2 fails immediately with `claude CLI not found on PATH`.

Install from [claude.com/product/claude-code](https://www.claude.com/product/claude-code). After install, sign in once with `claude` and run `claude --version` to confirm it's on PATH.

This is separate from your Anthropic API key — Claude Code uses your interactive session, not a raw key.

### 3. A Java/Spring project to save designs into · required

DisC Studio writes the `.puml` and any `.decision.md` sidecars into your project's `design/` folder, alongside the source code being designed. It also reads the project's package layout to suggest target packages on Step 4.

**Don't have one to try against?** Clone [Spring Petclinic](https://github.com/spring-projects/spring-petclinic) — the canonical Spring sample app, ~Java 17, builds out of the box. Point the Studio at the clone and design new features into it:
```sh
git clone https://github.com/spring-projects/spring-petclinic.git
```

### 4. A modern browser · required

Chrome, Firefox, Safari, or Edge. The UI is a single-page web app on `localhost:8080`. No browser extensions or plugins required.

## Quick start — run from a Release

The redistributable is a single fat jar. Same command on every platform.

1. Download `disc-studio-<version>.jar` from the [latest Release](https://github.com/mossgreen/design-is-code-app/releases/latest).

2. Run the app from any directory.

   **macOS / Linux** (Terminal):
   ```sh
   java -jar disc-studio-0.5.0.jar
   ```

   **Windows** (PowerShell or Command Prompt):
   ```powershell
   java -jar disc-studio-0.5.0.jar
   ```
   If `java` isn't recognised, your JDK isn't on PATH — re-run the Temurin installer with "Set JAVA_HOME / Add to PATH" checked, or open a new terminal so PATH changes take effect.

3. Open <http://localhost:8080> in any browser. Click the **Connect project** chip in the header and paste the absolute path to your Java project — e.g. `/Users/you/projects/your-app` on macOS/Linux, `C:\Users\you\projects\your-app` on Windows.

4. Walk through the four wizard steps — write the user story + acceptance criteria, review the analyzed participants, refine the sequence, and save. The `.puml` (and any `.decision.md` sidecars) land in your project's `design/` folder.

Stop the app with `Ctrl-C` in the terminal.

### Port already in use

By default the app binds `:8080`. To run on a different port:
```sh
java -jar disc-studio-0.5.0.jar --server.port=8090
```

## How it works

Four steps, top to bottom:

1. **Connect** — pick the target Java project folder; the Studio scans it so existing types can be reused in the design.
2. **Design** — write the user story + acceptance criteria, then click **Analyze**. Claude Code decomposes them into participants, entities, and a call sequence. Edit any of it inline; the live SVG preview updates as you go.
3. **Sign-off** — read-only snapshot of the story, participants, and frozen diagram. The hand-off point.
4. **Generate** — pick the target Java package, name the file, save into your project's `design/` folder, and click **Run it for me** to run the DisC codegen plugin — or copy the slash command and run it yourself from Claude Code.

## Run from source

Clone the repo:
```sh
git clone https://github.com/mossgreen/design-is-code-app.git
cd design-is-code-app
```

### From the terminal (any platform)

Gradle wrapper is bundled — no separate Gradle install needed.

**macOS / Linux:**
```sh
./gradlew bootRun
```

**Windows** (PowerShell or Command Prompt):
```powershell
.\gradlew.bat bootRun
```

Then open <http://localhost:8080>.

### From an IDE

**IntelliJ IDEA** (Community or Ultimate)
1. `File → Open…` and select the cloned `design-is-code-app` folder. IDEA detects the Gradle project and imports it.
2. Wait for the Gradle sync to finish (status bar at the bottom).
3. Open `src/main/java/com/designiscode/app/DesignIsCodeApplication.java` and click the green ▶ next to `public class DesignIsCodeApplication`. IDEA creates a Spring Boot run configuration and starts the app.
4. Watch the Run console for `Started DesignIsCodeApplication`, then open <http://localhost:8080>.

**Visual Studio Code**
1. Install the [Extension Pack for Java](https://marketplace.visualstudio.com/items?itemName=vscjava.vscode-java-pack) and the [Spring Boot Extension Pack](https://marketplace.visualstudio.com/items?itemName=vmware.vscode-boot-dev-pack).
2. `File → Open Folder…` → pick `design-is-code-app`. VS Code imports the Gradle project.
3. Open `DesignIsCodeApplication.java`, hit `Run` above the `main` method (or use the "Spring Boot Dashboard" panel).

### Build the redistributable jar

```sh
./gradlew bootJar        # macOS / Linux
.\gradlew.bat bootJar    # Windows
# Output: build/libs/disc-studio-<version>.jar
```

### Stack & layout

Spring Boot 4 / Java 17 / vanilla HTML+CSS+JS / hand-rolled SVG. No frontend build step — `src/main/resources/static/` is served as-is.

### Tests

```sh
./gradlew test           # Java unit tests
```

**E2E** (Playwright against a running app) lives in [`e2e/`](e2e/). Start the app in one terminal, then:
```sh
cd e2e
npm install
npx playwright install chromium
npx playwright test
```

**Releasing:** see [RELEASE.md](RELEASE.md).

## Status

MVP. Single-user, localhost-only. No persistence — refreshing the browser loses your work.
