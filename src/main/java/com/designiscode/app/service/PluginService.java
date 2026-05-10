package com.designiscode.app.service;

import com.designiscode.app.dto.PluginStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import static com.designiscode.app.service.JsonEvents.event;
import static com.designiscode.app.service.JsonEvents.rawLine;

/**
 * Detects whether the design-is-code Claude Code plugin is installed and, on
 * request, drives the install via the {@code claude plugin …} CLI subcommands.
 *
 * <p>Source of truth for install status is
 * {@code ~/.claude/plugins/installed_plugins.json}, schema v2 — that file is
 * keyed by {@code <plugin>@<owner>-<repo>} and records the install path,
 * version, and timestamp.
 */
@Service
public class PluginService {

    /** Canonical install key for the design-is-code plugin. */
    public static final String PLUGIN_KEY = "design-is-code@mossgreen-design-is-code";

    /** GitHub repo for the marketplace ({@code claude plugin marketplace add <this>}). */
    public static final String MARKETPLACE_REPO = "mossgreen/design-is-code-plugin";

    /** Plugin-id form Claude expects for {@code claude plugin install <this>}. */
    public static final String PLUGIN_ID = "design-is-code@mossgreen-design-is-code";

    private static final Path INSTALLED_PLUGINS_JSON =
            Paths.get(System.getProperty("user.home"), ".claude", "plugins", "installed_plugins.json");

    private final ObjectMapper mapper = JsonMapper.builder().build();
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final CancelRegistry cancelRegistry;

    public PluginService(CancelRegistry cancelRegistry) {
        this.cancelRegistry = cancelRegistry;
    }

    // ---- status ----

    public PluginStatus status() {
        if (!Files.isReadable(INSTALLED_PLUGINS_JSON)) return PluginStatus.missing();
        try {
            JsonNode root = mapper.readTree(INSTALLED_PLUGINS_JSON.toFile());
            JsonNode entries = root.path("plugins").path(PLUGIN_KEY);
            if (!entries.isArray() || entries.isEmpty()) return PluginStatus.missing();
            // installed_plugins.json holds an array per key (one entry per scope).
            // Pick the first installed entry — the wizard doesn't care about scope.
            JsonNode entry = entries.get(0);
            String version = textOrNull(entry, "version");
            String installPath = textOrNull(entry, "installPath");
            if (version == null) return PluginStatus.missing();
            return new PluginStatus(true, version, installPath);
        } catch (JacksonException e) {
            return PluginStatus.missing();
        }
    }

    // ---- install ----

    /**
     * Streams the plugin install in two steps (marketplace add → install) over
     * the supplied emitter. Always emits a terminal {@code done} event,
     * regardless of how the subprocess exits.
     */
    public void install(ResponseBodyEmitter emitter) {
        String runId = UUID.randomUUID().toString();
        emit(emitter, event("runId", "runId", runId));
        emit(emitter, event("start"));
        executor.submit(() -> runInstall(runId, emitter));
    }

    public boolean cancel(String runId) {
        return cancelRegistry.cancel(runId);
    }

    private void runInstall(String runId, ResponseBodyEmitter emitter) {
        // Two short commands. Marketplace-add is idempotent; install is the
        // mutation we actually care about. We bail early if the first one
        // fails so we don't try to install from an unregistered marketplace.
        int exit = -1;
        String terminalError = null;
        try {
            exit = runCommand(runId, emitter, List.of(
                    "claude", "plugin", "marketplace", "add", MARKETPLACE_REPO));
            if (exit != 0) {
                terminalError = "marketplace add failed (exit " + exit + ")";
            } else {
                exit = runCommand(runId, emitter, List.of(
                        "claude", "plugin", "install", PLUGIN_ID, "--scope", "user"));
            }
        } catch (Exception e) {
            terminalError = e.getMessage();
        } finally {
            cancelRegistry.unregister(runId);
            try {
                if (terminalError != null) {
                    emit(emitter, event("done", "exit", exit, "error", terminalError));
                } else {
                    emit(emitter, event("done", "exit", exit));
                }
            } finally {
                try { emitter.complete(); } catch (Exception ignored) {}
            }
        }
    }

    private int runCommand(String runId, ResponseBodyEmitter emitter, List<String> cmd)
            throws IOException, InterruptedException {
        emit(emitter, rawLine("$ " + String.join(" ", cmd)));
        ProcessBuilder pb = new ProcessBuilder(cmd)
                .redirectErrorStream(true)
                .redirectInput(new File("/dev/null"));
        Process process = pb.start();
        cancelRegistry.register(runId, process);
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8),
                1 << 16)) {
            String line;
            while ((line = reader.readLine()) != null) {
                emit(emitter, rawLine(line));
            }
        }
        return process.waitFor();
    }

    // ---- helpers ----

    private void emit(ResponseBodyEmitter emitter, String chunk) {
        try {
            emitter.send(chunk + "\n");
        } catch (IOException ignored) {
        }
    }

    private static String textOrNull(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) return null;
        return v.isString() ? v.asString() : v.toString();
    }
}
