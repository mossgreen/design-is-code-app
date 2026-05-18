package com.designiscode.app.service;

import com.designiscode.app.dto.ScanCatalog;
import org.springframework.stereotype.Service;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Shells out to the `claude` CLI to decompose a free-text requirement into
 * a tree of abstractions, then parses the model's JSON response.
 *
 * <p>The prompt lives in {@code /prompts/analyzer.md} on the classpath so it
 * stays diffable / reviewable. Three placeholders are substituted:
 * <ul>
 *   <li>{@code {CONTEXT}} — the user's story</li>
 *   <li>{@code {CODEBASE_SUMMARY}} — packages + glossary + conventions
 *       (empty when no project is connected)</li>
 *   <li>{@code {CODEBASE_TYPES}} — top-K lexically relevant existing
 *       types with their signatures (empty when no project is connected)</li>
 * </ul>
 *
 * <p>Returns a {@link Map} (parsed JSON) so the controller can re-serialize
 * it through Jackson — this also validates the model output before it leaves
 * the server, surfacing malformed responses as 5xx rather than as garbage
 * trees on the client.
 */
@Service
public class AnalyzeService {

    private static final String PROMPT_RESOURCE = "/prompts/analyzer.md";
    private static final String PH_CONTEXT = "{CONTEXT}";
    private static final String PH_CODEBASE_SUMMARY = "{CODEBASE_SUMMARY}";
    private static final String PH_CODEBASE_TYPES = "{CODEBASE_TYPES}";

    /** How many lexically-matched types to inject as grounding. Tuned to
     *  fit ~2 KB of prompt budget on a typical Spring sample. */
    private static final int TOP_K_TYPES = 20;

    /** Hard timeout for the subprocess. Claude calls usually return in
     *  ~10–30 s; anything past 2 min is almost certainly a hang. */
    private static final long TIMEOUT_SECONDS = 120;

    private final String promptTemplate;
    private final ObjectMapper json = JsonMapper.builder().build();

    public AnalyzeService() throws IOException {
        this.promptTemplate = loadResource(PROMPT_RESOURCE);
    }

    public Map<String, Object> analyze(String context, ScanCatalog catalog)
            throws IOException, InterruptedException {
        if (context == null || context.isBlank()) {
            throw new IllegalArgumentException("context is required");
        }

        CatalogFilter.FilteredCatalog filtered = CatalogFilter.filter(context, catalog, TOP_K_TYPES);
        String summaryMd = renderSummary(filtered);
        String typesMd = renderTypes(filtered);

        String prompt = promptTemplate
                .replace(PH_CONTEXT, context.trim())
                .replace(PH_CODEBASE_SUMMARY, summaryMd)
                .replace(PH_CODEBASE_TYPES, typesMd);

        ProcessBuilder pb = new ProcessBuilder(
                "claude",
                "--dangerously-skip-permissions",
                "-p", prompt
        )
                .redirectErrorStream(true)
                .redirectInput(new File("/dev/null"));

        Process process;
        try {
            process = pb.start();
        } catch (IOException e) {
            String msg = e.getMessage() == null ? "" : e.getMessage();
            if (msg.contains("No such file") || msg.contains("error=2")) {
                throw new IOException("`claude` CLI not found on PATH. Install Claude Code and try again.", e);
            }
            throw e;
        }

        String stdout = readAll(process.getInputStream());
        boolean exited = process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        if (!exited) {
            process.destroyForcibly();
            throw new IOException("claude analysis timed out after " + TIMEOUT_SECONDS + "s");
        }
        int exit = process.exitValue();
        if (exit != 0) {
            throw new IOException("claude exited " + exit + ": " + truncate(stdout, 500));
        }

        String body = stripFences(stdout);
        try {
            //noinspection unchecked
            return json.readValue(body, Map.class);
        } catch (JacksonException e) {
            throw new IOException("analyzer did not return valid JSON. First 500 chars: " + truncate(body, 500), e);
        }
    }

    // --- prompt rendering ---

    /** Always-on, ultra-compact summary. Empty string when no catalog. */
    private String renderSummary(CatalogFilter.FilteredCatalog f) {
        if (f.conventions() == null && f.packages().isEmpty() && f.glossary().isEmpty()) {
            return "_No project connected. Propose abstractions from the story alone._";
        }
        StringBuilder sb = new StringBuilder();
        if (!f.packages().isEmpty()) {
            sb.append("- **Packages**: ");
            sb.append(f.packages().stream()
                    .limit(15)
                    .map(p -> p.name() + " (" + p.typeCount() + ")")
                    .reduce((a, b) -> a + ", " + b).orElse(""));
            sb.append('\n');
        }
        if (!f.glossary().isEmpty()) {
            sb.append("- **Domain glossary**: ");
            sb.append(f.glossary().stream()
                    .limit(30)
                    .map(g -> g.term() + " (" + g.kind() + ")")
                    .reduce((a, b) -> a + ", " + b).orElse(""));
            sb.append('\n');
        }
        if (f.conventions() != null) {
            ScanCatalog.Conventions c = f.conventions();
            sb.append("- **Conventions**: ");
            if (c.interfaceImplPattern() != null) sb.append("interface↔impl pair `").append(c.interfaceImplPattern()).append("`; ");
            sb.append("records ").append(c.recordUsage()).append("; ");
            if (!c.primaryStereotypes().isEmpty()) {
                sb.append("primary stereotypes ").append(String.join(", ", c.primaryStereotypes())).append('.');
            }
            sb.append('\n');
        }
        return sb.toString().trim();
    }

    /** Lexically top-K types with their signatures. Empty string when nothing matches. */
    private String renderTypes(CatalogFilter.FilteredCatalog f) {
        if (f.topTypes().isEmpty()) {
            return "_No directly-relevant existing types in this codebase for this story._";
        }
        StringBuilder sb = new StringBuilder();
        for (ScanCatalog.TypeRecord t : f.topTypes()) {
            sb.append("- `").append(t.fqn()).append("` (").append(t.role()).append(", ").append(t.kind()).append(")");
            if (t.purpose() != null && !t.purpose().isBlank()) {
                sb.append("\n    Purpose: ").append(t.purpose());
            }
            if (t.extendsType() != null) {
                sb.append("\n    Extends: ").append(t.extendsType());
            }
            if (!t.implementsTypes().isEmpty()) {
                sb.append("\n    Implements: ").append(String.join(", ", t.implementsTypes()));
            }
            if (!t.fields().isEmpty()) {
                sb.append("\n    Fields: ");
                sb.append(t.fields().stream()
                        .limit(8)
                        .map(fld -> fld.name() + ": " + fld.type())
                        .reduce((a, b) -> a + ", " + b).orElse(""));
            }
            List<ScanCatalog.MethodRecord> methods = t.publicMethods();
            if (!methods.isEmpty()) {
                sb.append("\n    Methods:");
                for (ScanCatalog.MethodRecord m : methods.stream().limit(8).toList()) {
                    sb.append("\n      - ").append(m.signature());
                    if (m.purpose() != null && !m.purpose().isBlank()) {
                        sb.append("  // ").append(m.purpose());
                    }
                }
            }
            sb.append("\n\n");
        }
        return sb.toString().trim();
    }

    // --- helpers ---

    private static String loadResource(String path) throws IOException {
        try (InputStream in = AnalyzeService.class.getResourceAsStream(path)) {
            if (in == null) throw new IOException("classpath resource not found: " + path);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String readAll(InputStream in) throws IOException {
        StringBuilder buf = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                buf.append(line).append('\n');
            }
        }
        return buf.toString();
    }

    /** Tolerate ```json fenced output even though the prompt says no fences. */
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
}
