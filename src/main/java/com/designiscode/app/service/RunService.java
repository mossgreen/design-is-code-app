package com.designiscode.app.service;

import com.designiscode.app.dto.RunRequest;
import com.designiscode.app.dto.ValidateRequest;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;

import static com.designiscode.app.service.JsonEvents.event;
import static com.designiscode.app.service.JsonEvents.rawLine;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Spawns a `claude --output-format stream-json --verbose -p ...` subprocess
 * for the DisC slash command, parses each stdout line into a wizard-friendly
 * NDJSON event ({@link StreamJsonMapper}), and streams those events back
 * over a {@link ResponseBodyEmitter}.
 *
 * <p>The reader loop always emits a terminal {@code done} or {@code cancelled}
 * event so the frontend can re-enable the Run button regardless of how the
 * process exits (clean / error / spawn failure / cancel).
 */
@Service
public class RunService {

    private static final String DISC_SLASH_COMMAND = "/design-is-code:disc";
    private static final int READER_BUFFER_BYTES = 1 << 16;  // 64 KB

    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final StreamJsonMapper streamJsonMapper;
    private final CancelRegistry cancelRegistry;

    public RunService(StreamJsonMapper streamJsonMapper, CancelRegistry cancelRegistry) {
        this.streamJsonMapper = streamJsonMapper;
        this.cancelRegistry = cancelRegistry;
    }

    public void run(RunRequest request, ResponseBodyEmitter emitter) {
        if (request == null || request.projectPath() == null || request.projectPath().isBlank()) {
            emitErrorAndComplete(emitter, "projectPath is required");
            return;
        }
        if (request.filePath() == null || request.filePath().isBlank()) {
            emitErrorAndComplete(emitter, "filePath is required");
            return;
        }

        Path projectRoot = Paths.get(request.projectPath()).toAbsolutePath().normalize();
        if (!Files.isDirectory(projectRoot)) {
            emitErrorAndComplete(emitter, "project path is not a directory: " + projectRoot);
            return;
        }

        String relPath = request.filePath().trim();
        Path resolved = projectRoot.resolve(relPath).normalize();
        if (!resolved.startsWith(projectRoot) || !Files.exists(resolved)) {
            emitErrorAndComplete(emitter, "puml file not found at " + resolved);
            return;
        }

        String runId = UUID.randomUUID().toString();
        // Tell the client its runId up-front so a Cancel click can route to the
        // right process. The mapper later emits its own "start" event when the
        // CLI's `system/init` line lands; that's intentional — meta vs. lifecycle.
        emit(emitter, "{\"event\":\"runId\",\"runId\":\"" + runId + "\"}");

        String slashCommand = DISC_SLASH_COMMAND + " " + relPath;
        List<String> cmd = new ArrayList<>(List.of(
                "claude",
                "--dangerously-skip-permissions",
                "--output-format", "stream-json",
                "--verbose"
        ));
        Models.appendIfValid(cmd, request.model());
        cmd.add("-p");
        cmd.add(slashCommand);

        executor.submit(() -> runProcess(runId, cmd, projectRoot.toFile(), emitter));
    }

    private void runProcess(String runId, List<String> cmd, File workingDir, ResponseBodyEmitter emitter) {
        ProcessResult result = streamProcess(runId, cmd, workingDir, emitter);
        try {
            if (result.terminalError() != null) {
                emit(emitter, event("done", "exit", -1, "error", result.terminalError()));
            } else {
                emit(emitter, event("done", "exit", result.exit()));
            }
        } finally {
            try {
                emitter.complete();
            } catch (Exception ignored) {
                // emitter may already be in a terminal state; nothing more to do.
            }
        }
    }

    /**
     * Spawn the plugin subprocess and pump its stdout (parsed via
     * {@link StreamJsonMapper}) into the supplied emitter. Does <b>not</b>
     * emit a terminal {@code done} event or close the emitter — the caller
     * decides how to finalise.
     */
    ProcessResult streamProcess(String runId, List<String> cmd, File workingDir, ResponseBodyEmitter emitter) {
        emit(emitter, rawLine("$ cd " + workingDir.getAbsolutePath()));
        emit(emitter, rawLine("$ " + String.join(" ", cmd)));

        Process process;
        int exit = -1;
        String terminalError = null;

        try {
            ProcessBuilder pb = new ProcessBuilder(cmd)
                    .directory(workingDir)
                    .redirectErrorStream(true)
                    .redirectInput(new File("/dev/null"));
            process = pb.start();
            cancelRegistry.register(runId, process);

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8),
                    READER_BUFFER_BYTES)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    for (String event : streamJsonMapper.mapLine(line)) {
                        emit(emitter, event);
                    }
                }
            }

            exit = process.waitFor();
        } catch (IOException e) {
            String hint = e.getMessage() != null && e.getMessage().contains("No such file")
                    ? " — is the `claude` CLI installed and on PATH?"
                    : "";
            terminalError = e.getMessage() + hint;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            terminalError = "interrupted";
        } catch (Exception e) {
            terminalError = e.getMessage();
        } finally {
            cancelRegistry.unregister(runId);
        }
        return new ProcessResult(exit, terminalError);
    }

    /** Result of one plugin invocation. {@code terminalError} is non-null
     *  only when the JVM-side launch/read/wait failed; a non-zero
     *  {@code exit} with null error means the plugin itself reported a
     *  failure but the launch was clean. */
    record ProcessResult(int exit, String terminalError) {}

    /** Builds the {@code claude --output-format stream-json --verbose -p
     *  /design-is-code:disc <relPath>} command, validating model and
     *  paths the same way {@link #run} does. */
    List<String> buildDiscCommand(String relPath, String requestedModel) {
        String slashCommand = DISC_SLASH_COMMAND + " " + relPath;
        List<String> cmd = new ArrayList<>(List.of(
                "claude",
                "--dangerously-skip-permissions",
                "--output-format", "stream-json",
                "--verbose"
        ));
        Models.appendIfValid(cmd, requestedModel);
        cmd.add("-p");
        cmd.add(slashCommand);
        return cmd;
    }

    /** Cancels a registered run by destroying the process. Idempotent. */
    public boolean cancel(String runId) {
        if (runId == null || runId.isBlank()) return false;
        return cancelRegistry.cancel(runId);
    }

    /**
     * Plan mode — runs the DisC plugin with the `--plan` flag (introduced
     * in plugin v0.6.0). The plugin walks Steps 1–6 internally and emits a
     * single JSON envelope to stdout in place of Steps 7/8 (no files
     * written). This method returns the parsed envelope; the caller passes
     * it through to the client.
     *
     * <p>One-shot, synchronous. No streaming, no NDJSON, no run-id — plan
     * mode is short-lived and cancelling it has no point (it doesn't
     * mutate the filesystem). The output should be a few KB at most.
     *
     * <p>Buffer cap protects against an infinite stdout from a broken
     * plugin: we abandon the process and throw if the output exceeds
     * {@link #PLAN_MAX_BYTES}.
     */
    public java.util.Map<String, Object> plan(RunRequest request) throws java.io.IOException, InterruptedException {
        if (request == null || request.projectPath() == null || request.projectPath().isBlank()) {
            throw new IllegalArgumentException("projectPath is required");
        }
        if (request.filePath() == null || request.filePath().isBlank()) {
            throw new IllegalArgumentException("filePath is required");
        }

        Path projectRoot = Paths.get(request.projectPath()).toAbsolutePath().normalize();
        if (!Files.isDirectory(projectRoot)) {
            throw new IllegalArgumentException("project path is not a directory: " + projectRoot);
        }

        String relPath = request.filePath().trim();
        Path resolved = projectRoot.resolve(relPath).normalize();
        if (!resolved.startsWith(projectRoot) || !Files.exists(resolved)) {
            throw new IllegalArgumentException("puml file not found at " + resolved);
        }

        String slashCommand = DISC_SLASH_COMMAND + " " + relPath + " --plan";
        List<String> cmd = new ArrayList<>(List.of(
                "claude",
                "--dangerously-skip-permissions"
        ));
        Models.appendIfValid(cmd, request.model());
        cmd.add("-p");
        cmd.add(slashCommand);

        ProcessBuilder pb = new ProcessBuilder(cmd)
                .directory(projectRoot.toFile())
                .redirectErrorStream(true)
                .redirectInput(new File("/dev/null"));

        Process process;
        try {
            process = pb.start();
        } catch (java.io.IOException e) {
            String msg = e.getMessage() == null ? "" : e.getMessage();
            if (msg.contains("No such file") || msg.contains("error=2")) {
                throw new java.io.IOException("`claude` CLI not found on PATH. Install Claude Code and try again.", e);
            }
            throw e;
        }

        StringBuilder buf = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8),
                READER_BUFFER_BYTES)) {
            String line;
            while ((line = reader.readLine()) != null) {
                buf.append(line).append('\n');
                if (buf.length() > PLAN_MAX_BYTES) {
                    process.destroyForcibly();
                    throw new java.io.IOException("plan output exceeded " + PLAN_MAX_BYTES + " bytes — aborting");
                }
            }
        }
        boolean exited = process.waitFor(PLAN_TIMEOUT_SECONDS, java.util.concurrent.TimeUnit.SECONDS);
        if (!exited) {
            process.destroyForcibly();
            throw new java.io.IOException("plan timed out after " + PLAN_TIMEOUT_SECONDS + "s");
        }
        int exit = process.exitValue();
        String stdout = buf.toString();
        if (exit != 0) {
            throw new java.io.IOException("claude exited " + exit + " in plan mode: " + truncate(stdout, 500));
        }

        String body = stripFences(stdout);
        try {
            //noinspection unchecked
            return planJson.readValue(body, java.util.Map.class);
        } catch (tools.jackson.core.JacksonException e) {
            throw new java.io.IOException("plugin did not return valid JSON in plan mode. First 500 chars: " + truncate(body, 500), e);
        }
    }

    /**
     * Validate mode — runs the DisC plugin with the {@code --validate-only}
     * flag. The plugin walks Step 1 only (refusal-grade contract checks) and
     * exits. On pass it emits {@code {"ok": true}}; on refusal it emits the
     * same {@code #### REFUSAL — STOP} markdown the user sees from a normal
     * run. The wizard renders that markdown verbatim — no parsing of refusal
     * content, no rule mirroring on the wizard side.
     *
     * <p>Unlike {@link #plan}, the design is not yet saved to the project.
     * The caller hands us the rendered {@code .puml} text inline; we write
     * it to a temp file inside {@code projectPath/.disc-tmp/} so the plugin
     * still sees real project context (CWD for language-profile pick-up and
     * FQN resolution), then clean up afterwards.
     *
     * <p>Returns:
     * <ul>
     *   <li>{@code {refused: false}} — plugin's Step 1 passed</li>
     *   <li>{@code {refused: true, message: <markdown>}} — plugin's Step 1
     *       refused; message is the raw markdown block</li>
     *   <li>{@code {refused: false, error: <hint>}} — transport failure
     *       (process couldn't start, timed out, etc.). Treated as soft pass:
     *       we don't block the user on our own inability to preflight; the
     *       eventual Step 4 Run will surface real generator errors.</li>
     * </ul>
     */
    public java.util.Map<String, Object> validate(ValidateRequest req)
            throws java.io.IOException, InterruptedException {
        if (req == null || req.projectPath() == null || req.projectPath().isBlank()) {
            throw new IllegalArgumentException("projectPath is required");
        }
        if (req.puml() == null || req.puml().isBlank()) {
            throw new IllegalArgumentException("puml is required");
        }

        Path projectRoot = Paths.get(req.projectPath()).toAbsolutePath().normalize();
        if (!Files.isDirectory(projectRoot)) {
            throw new IllegalArgumentException("project path is not a directory: " + projectRoot);
        }

        // Temp file inside the project so the plugin's CWD-based context
        // (language profile, FQN scan) works. .disc-tmp is project-local and
        // user-visible; we clean up the file but not the directory (cheap to
        // keep around between calls).
        Path tmpDir = projectRoot.resolve(".disc-tmp");
        Files.createDirectories(tmpDir);
        Path tmpFile = Files.createTempFile(tmpDir, "validate-", ".puml");
        List<Path> staged = new ArrayList<>();

        try {
            Files.writeString(tmpFile, req.puml(), StandardCharsets.UTF_8);
            // Step 1 pairs a decision table to its leaf by filename, next to the
            // .puml. Without them the plugin judged the design as if every leaf
            // were unspecified, so a sidecar could disagree with the diagram and
            // validate would still pass.
            staged.addAll(stageSidecars(tmpDir, req.sidecars()));
            Path relPath = projectRoot.relativize(tmpFile);

            String slashCommand = DISC_SLASH_COMMAND + " " + relPath.toString() + " --validate-only";
            List<String> cmd = new ArrayList<>(List.of(
                    "claude",
                    "--dangerously-skip-permissions"
            ));
            Models.appendIfValid(cmd, req.model());
            cmd.add("-p");
            cmd.add(slashCommand);

            ProcessBuilder pb = new ProcessBuilder(cmd)
                    .directory(projectRoot.toFile())
                    .redirectErrorStream(true)
                    .redirectInput(new File("/dev/null"));

            Process process;
            try {
                process = pb.start();
            } catch (java.io.IOException e) {
                String msg = e.getMessage() == null ? "" : e.getMessage();
                if (msg.contains("No such file") || msg.contains("error=2")) {
                    // Transport failure — soft pass with diagnostic hint.
                    return java.util.Map.of(
                            "refused", false,
                            "error", "`claude` CLI not found on PATH"
                    );
                }
                throw e;
            }

            StringBuilder buf = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8),
                    READER_BUFFER_BYTES)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    buf.append(line).append('\n');
                    if (buf.length() > PLAN_MAX_BYTES) {
                        process.destroyForcibly();
                        return java.util.Map.of(
                                "refused", false,
                                "error", "validate output exceeded " + PLAN_MAX_BYTES + " bytes"
                        );
                    }
                }
            }
            boolean exited = process.waitFor(VALIDATE_TIMEOUT_SECONDS, java.util.concurrent.TimeUnit.SECONDS);
            if (!exited) {
                process.destroyForcibly();
                return java.util.Map.of(
                        "refused", false,
                        "error", "validate timed out after " + VALIDATE_TIMEOUT_SECONDS + "s"
                );
            }

            String stdout = stripFences(buf.toString()).trim();

            // Three shapes possible from the plugin: {"ok": true} JSON,
            // REFUSAL markdown, or noise. Try JSON pass first.
            if (stdout.startsWith("{") && stdout.contains("\"ok\"")) {
                try {
                    @SuppressWarnings("unchecked")
                    java.util.Map<String, Object> parsed = planJson.readValue(stdout, java.util.Map.class);
                    if (Boolean.TRUE.equals(parsed.get("ok"))) {
                        return java.util.Map.of("refused", false);
                    }
                } catch (tools.jackson.core.JacksonException ignored) {
                    // Fall through to refusal detection.
                }
            }

            if (looksLikeRefusal(stdout)) {
                return java.util.Map.of(
                        "refused", true,
                        "message", stdout
                );
            }

            // Neither a clean pass nor an identifiable refusal — soft pass
            // with a diagnostic so the frontend can show it if it wants.
            return java.util.Map.of(
                    "refused", false,
                    "error", "validate returned unexpected output: " + truncate(stdout, 200)
            );
        } finally {
            try {
                Files.deleteIfExists(tmpFile);
            } catch (java.io.IOException ignored) {
                // Best-effort cleanup; leftover .disc-tmp/validate-*.puml is
                // harmless and gitignorable.
            }
            for (Path p : staged) {
                try {
                    Files.deleteIfExists(p);
                } catch (java.io.IOException ignored) {
                    // same: best effort
                }
            }
        }
    }

    /**
     * Writes decision-table sidecars beside the temp {@code .puml} so Step 1 sees
     * the same design the reviewer did, and returns what it wrote so the caller
     * can clean up.
     *
     * <p>File names are taken from the client but treated as untrusted: anything
     * with a path separator or a parent reference is dropped rather than allowed
     * to escape {@code .disc-tmp}.
     */
    static List<Path> stageSidecars(Path tmpDir, java.util.Map<String, String> sidecars)
            throws java.io.IOException {
        List<Path> written = new ArrayList<>();
        if (sidecars == null || sidecars.isEmpty()) return written;
        for (java.util.Map.Entry<String, String> e : sidecars.entrySet()) {
            String name = e.getKey();
            if (name == null || name.isBlank() || e.getValue() == null) continue;
            if (name.contains("/") || name.contains("\\") || name.contains("..")) continue;
            Path target = tmpDir.resolve(name).normalize();
            if (!target.getParent().equals(tmpDir)) continue;
            Files.writeString(target, e.getValue(), StandardCharsets.UTF_8);
            written.add(target);
        }
        return written;
    }

    /** Validate is Step-1 only — should finish in seconds. Cap at 60s. */
    private static final long VALIDATE_TIMEOUT_SECONDS = 60;

    /** One regex to identify the plugin's refusal output. The plugin's SKILL.md
     *  uses these stable markers; matching either is sufficient. The wizard
     *  never parses *what* the refusal says — just whether one happened. */
    private static boolean looksLikeRefusal(String stdout) {
        if (stdout == null || stdout.isEmpty()) return false;
        return stdout.contains("REFUSAL — STOP") || stdout.contains("#### REFUSAL");
    }

    /** Hard cap on plan-mode stdout. The envelope should be a few KB; 256 KB
     *  is generous. Anything more means a broken plugin. */
    private static final int PLAN_MAX_BYTES = 256 * 1024;

    /** Plan mode is expected to complete in seconds, not the minutes a real
     *  run might take. Cap at 2 minutes to fail fast on plugin hangs. */
    private static final long PLAN_TIMEOUT_SECONDS = 120;

    private final tools.jackson.databind.ObjectMapper planJson =
            tools.jackson.databind.json.JsonMapper.builder().build();

    private static String stripFences(String text) {
        String t = text.trim();
        if (t.startsWith("```")) {
            int firstNewline = t.indexOf('\n');
            if (firstNewline > 0) t = t.substring(firstNewline + 1);
            int endFence = t.lastIndexOf("```");
            if (endFence >= 0) t = t.substring(0, endFence);
        }
        return t.trim();
    }

    private static String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }

    // --- emit helpers ---

    private void emit(ResponseBodyEmitter emitter, String chunk) {
        try {
            // Each event is one NDJSON line. Trailing newline keeps the client's
            // line-splitting trivial.
            emitter.send(chunk + "\n");
        } catch (IOException ignored) {
            // Client likely disconnected. Nothing actionable here — the reader
            // loop will see EOF when the process exits.
        }
    }

    private void emitErrorAndComplete(ResponseBodyEmitter emitter, String message) {
        emit(emitter, event("done", "exit", -1, "error", message));
        try {
            emitter.complete();
        } catch (Exception ignored) {
        }
    }

    // JSON helpers moved to JsonEvents; see static imports at top.
}
