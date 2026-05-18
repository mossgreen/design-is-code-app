package com.designiscode.app.service;

import com.designiscode.app.dto.RunRequest;
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
import java.util.Set;
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

    // Allowlist of model IDs the wizard may request. Anything else is dropped
    // and we fall back to Claude Code's configured default — never pass an
    // unvalidated string to the subprocess.
    private static final Set<String> ALLOWED_MODELS = Set.of(
            "claude-sonnet-4-6",
            "claude-opus-4-7",
            "claude-haiku-4-5"
    );

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
        String requestedModel = request.model();
        if (requestedModel != null && ALLOWED_MODELS.contains(requestedModel)) {
            cmd.add("--model");
            cmd.add(requestedModel);
        }
        cmd.add("-p");
        cmd.add(slashCommand);

        executor.submit(() -> runProcess(runId, cmd, projectRoot.toFile(), emitter));
    }

    private void runProcess(String runId, List<String> cmd, File workingDir, ResponseBodyEmitter emitter) {
        // Echo the invocation so the user can see what was actually run. The
        // wizard's raw-output panel renders these as plain lines.
        emit(emitter, rawLine("$ cd " + workingDir.getAbsolutePath()));
        emit(emitter, rawLine("$ " + String.join(" ", cmd)));

        Process process = null;
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
            // Single guarantee: every run emits one terminal event, then completes
            // the emitter. Without this, the wizard's "Running…" state can wedge.
            try {
                if (terminalError != null) {
                    emit(emitter, event("done", "exit", -1, "error", terminalError));
                } else {
                    // exit==0 normal; exit!=0 the agent itself reported a failure.
                    emit(emitter, event("done", "exit", exit));
                }
            } finally {
                try {
                    emitter.complete();
                } catch (Exception ignored) {
                    // emitter may already be in a terminal state; nothing more to do.
                }
            }
        }
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
        String requestedModel = request.model();
        if (requestedModel != null && ALLOWED_MODELS.contains(requestedModel)) {
            cmd.add("--model");
            cmd.add(requestedModel);
        }
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
