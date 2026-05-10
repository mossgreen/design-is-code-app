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
