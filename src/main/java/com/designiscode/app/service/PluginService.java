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
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import static com.designiscode.app.service.JsonEvents.event;
import static com.designiscode.app.service.JsonEvents.rawLine;

/**
 * Detects whether the design-is-code Claude Code plugin is installed, looks
 * up the latest upstream version, and on request drives install/update via
 * the {@code claude plugin …} CLI subcommands.
 *
 * <p>Source of truth for install status is
 * {@code ~/.claude/plugins/installed_plugins.json}, schema v2 — keyed by
 * {@code <plugin>@<owner>-<repo>} with installPath/version/timestamp.
 *
 * <p>Source of truth for upstream version is
 * {@code raw.githubusercontent.com/.../main/.claude-plugin/plugin.json}.
 * GitHub's Releases API returns 404 for this repo (no Releases published,
 * only tags), so we read the canonical {@code version} field from the
 * plugin's own manifest. Cached in-memory for 15 minutes to keep page
 * reloads from hammering GitHub.
 */
@Service
public class PluginService {

    /** Canonical install key for the design-is-code plugin. */
    public static final String PLUGIN_KEY = "design-is-code@mossgreen-design-is-code";

    /** GitHub repo for the marketplace ({@code claude plugin marketplace add <this>}). */
    public static final String MARKETPLACE_REPO = "mossgreen/design-is-code-plugin";

    /** Plugin-id form Claude expects for {@code claude plugin install/update <this>}. */
    public static final String PLUGIN_ID = "design-is-code@mossgreen-design-is-code";

    private static final Path INSTALLED_PLUGINS_JSON =
            Paths.get(System.getProperty("user.home"), ".claude", "plugins", "installed_plugins.json");

    private static final URI UPSTREAM_PLUGIN_JSON = URI.create(
            "https://raw.githubusercontent.com/mossgreen/design-is-code-plugin/main/.claude-plugin/plugin.json");

    private static final Duration LATEST_VERSION_CACHE_TTL = Duration.ofMinutes(15);
    private static final Duration HTTP_TIMEOUT = Duration.ofSeconds(5);

    private final ObjectMapper mapper = JsonMapper.builder().build();
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(HTTP_TIMEOUT).build();
    private final CancelRegistry cancelRegistry;

    // In-memory cache of the upstream-version lookup. Volatile so reads from
    // multiple request threads see the most recent write without locking.
    private volatile String cachedLatestVersion;
    private volatile Instant cachedLatestAt;

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
            String latest = latestVersionCachedOrFetch();
            String latestAt = (cachedLatestAt != null) ? cachedLatestAt.toString() : null;
            return new PluginStatus(true, version, installPath, latest, latestAt);
        } catch (JacksonException e) {
            return PluginStatus.missing();
        }
    }

    /**
     * Returns the cached upstream version if it's fresh; otherwise fetches it.
     * On any fetch failure (timeout, 4xx/5xx, parse), returns null and does
     * NOT crash — the wizard degrades to "no update available" rather than
     * showing a broken state. Failure does not poison the cache; we'll retry
     * on the next request.
     */
    private String latestVersionCachedOrFetch() {
        Instant now = Instant.now();
        if (cachedLatestVersion != null && cachedLatestAt != null
                && Duration.between(cachedLatestAt, now).compareTo(LATEST_VERSION_CACHE_TTL) < 0) {
            return cachedLatestVersion;
        }
        try {
            HttpRequest req = HttpRequest.newBuilder(UPSTREAM_PLUGIN_JSON)
                    .timeout(HTTP_TIMEOUT)
                    .GET()
                    .build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() / 100 != 2) return null;
            JsonNode body = mapper.readTree(res.body());
            String v = textOrNull(body, "version");
            if (v == null || v.isBlank()) return null;
            cachedLatestVersion = v;
            cachedLatestAt = now;
            return v;
        } catch (Exception ignored) {
            return null;
        }
    }

    // ---- install + update ----

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

    /**
     * Streams a {@code claude plugin update} over the supplied emitter. Same
     * event shape as {@link #install(ResponseBodyEmitter)}; on success a final
     * text event surfaces the "restart Claude Code" requirement that the CLI
     * itself notes.
     */
    public void update(ResponseBodyEmitter emitter) {
        String runId = UUID.randomUUID().toString();
        emit(emitter, event("runId", "runId", runId));
        emit(emitter, event("start"));
        executor.submit(() -> runUpdate(runId, emitter));
    }

    public boolean cancel(String runId) {
        return cancelRegistry.cancel(runId);
    }

    private void runInstall(String runId, ResponseBodyEmitter emitter) {
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
            // Bust the cache so the post-install status() call sees fresh data
            // (in case the user updates from the same machine that pinned).
            cachedLatestVersion = null;
            cachedLatestAt = null;
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

    private void runUpdate(String runId, ResponseBodyEmitter emitter) {
        int exit = -1;
        String terminalError = null;
        try {
            exit = runCommand(runId, emitter, List.of(
                    "claude", "plugin", "update", PLUGIN_ID));
            if (exit == 0) {
                // The CLI's `--help` text on `plugin update` says "(restart
                // required to apply)" — surface that to the user explicitly so
                // they don't wonder why the new behavior didn't kick in.
                emit(emitter, event("text", "text",
                        "⚠ Restart Claude Code for the new plugin to take effect."));
            }
        } catch (Exception e) {
            terminalError = e.getMessage();
        } finally {
            cachedLatestVersion = null;
            cachedLatestAt = null;
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
