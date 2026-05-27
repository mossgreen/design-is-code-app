package com.designiscode.app.service;

import com.designiscode.app.dto.AcRow;
import com.designiscode.app.dto.ScanCatalog;
import com.designiscode.app.service.render.ElidedTreeRenderer;
import com.designiscode.app.service.render.MarkdownRenderer;
import org.springframework.beans.factory.annotation.Value;
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
import java.util.ArrayList;
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
    private static final String RULES_DIR_RESOURCE = "/prompts/rules";
    private static final String PH_CONTEXT = "{CONTEXT}";
    private static final String PH_CODEBASE_SUMMARY = "{CODEBASE_SUMMARY}";
    private static final String PH_CODEBASE_TYPES = "{CODEBASE_TYPES}";
    private static final String PH_ACCEPTANCE_CRITERIA = "{ACCEPTANCE_CRITERIA}";
    private static final String PH_RULES = "{RULES}";

    /** How many lexically-matched types to inject as grounding. Tuned to
     *  fit ~2 KB of prompt budget on a typical Spring sample. */
    private static final int TOP_K_TYPES = 20;

    /** Soft byte cap passed to the renderer. ~2 KB matches the prior implicit
     *  budget of the markdown renderer; ElidedTreeRenderer degrades detail
     *  gracefully when it would exceed this. */
    private static final int CODEBASE_TYPES_MAX_BYTES = 2048;

    /** Hard timeout for the subprocess. Claude calls usually return in
     *  ~10–30 s; anything past 2 min is almost certainly a hang. */
    private static final long TIMEOUT_SECONDS = 120;

    private final String promptTemplate;
    private final String rulesSection;
    private final CatalogRenderer renderer;
    private final ObjectMapper json = JsonMapper.builder().build();

    public AnalyzeService(
            @Value("${disc.catalog.renderer:elided}") String rendererName
    ) throws IOException {
        this.promptTemplate = loadResource(PROMPT_RESOURCE);
        this.rulesSection = loadRulesSection();
        this.renderer = switch (rendererName == null ? "elided" : rendererName.toLowerCase()) {
            case "markdown" -> new MarkdownRenderer();
            default -> new ElidedTreeRenderer();
        };
    }

    public Map<String, Object> analyze(String context, ScanCatalog catalog, List<AcRow> acceptanceCriteria, String model)
            throws IOException, InterruptedException {
        if (context == null || context.isBlank()) {
            throw new IllegalArgumentException("context is required");
        }

        CatalogFilter.FilteredCatalog filtered = CatalogFilter.filter(context, catalog, TOP_K_TYPES);
        String summaryMd = renderSummary(filtered);
        String typesMd = renderer.render(filtered, CODEBASE_TYPES_MAX_BYTES);
        String acMd = renderAcceptanceCriteria(acceptanceCriteria);

        String prompt = promptTemplate
                .replace(PH_CONTEXT, context.trim())
                .replace(PH_CODEBASE_SUMMARY, summaryMd)
                .replace(PH_CODEBASE_TYPES, typesMd)
                .replace(PH_ACCEPTANCE_CRITERIA, acMd)
                .replace(PH_RULES, rulesSection);

        List<String> args = new ArrayList<>(List.of(
                "claude",
                "--dangerously-skip-permissions"
        ));
        Models.appendIfValid(args, model);
        args.add("-p");
        args.add(prompt);

        ProcessBuilder pb = new ProcessBuilder(args)
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

    /** Acceptance criteria rendered as a Markdown bullet list of
     *  "Given …, when …, then …" sentences. Empty rows are skipped; when
     *  no usable rows remain, returns a sentinel string that the prompt
     *  template substitutes into the placeholder so the section reads
     *  cleanly. */
    private String renderAcceptanceCriteria(List<AcRow> rows) {
        if (rows == null || rows.isEmpty()) {
            return "_No acceptance criteria supplied — design from the story alone._";
        }
        StringBuilder sb = new StringBuilder();
        int written = 0;
        for (AcRow r : rows) {
            if (r == null) continue;
            String given = r.given() == null ? "" : r.given().trim();
            String when = r.when() == null ? "" : r.when().trim();
            String then = r.then() == null ? "" : r.then().trim();
            if (given.isEmpty() && when.isEmpty() && then.isEmpty()) continue;
            sb.append("- **Given** ").append(given.isEmpty() ? "—" : given)
                    .append(", **when** ").append(when.isEmpty() ? "—" : when)
                    .append(", **then** ").append(then.isEmpty() ? "—" : then).append('\n');
            written++;
        }
        if (written == 0) {
            return "_No acceptance criteria supplied — design from the story alone._";
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

    /**
     * Concatenate every rule under {@code /prompts/rules/} into a single
     * block. Each rule's frontmatter is stripped — only the body reaches
     * the model, headed with the rule id from the frontmatter so the
     * model can reference it from the "Self-check before returning"
     * section of {@code analyzer.md}.
     *
     * <p>Falls back to a sentinel string when the rules dir is missing so
     * the {@code {RULES}} placeholder is never left literal in the prompt.
     */
    private String loadRulesSection() {
        try {
            java.net.URL dirUrl = AnalyzeService.class.getResource(RULES_DIR_RESOURCE);
            if (dirUrl == null) return "_No LLM-judged rules registered._";
            java.nio.file.Path dirPath;
            try {
                dirPath = java.nio.file.Paths.get(dirUrl.toURI());
            } catch (Exception jarOrOdd) {
                // When running from a packaged jar the resources aren't a
                // walkable Path. We fall back to a hard-coded list of known
                // rule files at the top level. Add new rule files here OR
                // run from gradle bootRun (which exposes classpath as files).
                return loadRulesFromKnownList();
            }
            if (!java.nio.file.Files.isDirectory(dirPath)) return "_No LLM-judged rules registered._";

            StringBuilder out = new StringBuilder();
            try (var stream = java.nio.file.Files.list(dirPath)) {
                java.util.List<java.nio.file.Path> files = stream
                        .filter(p -> p.toString().endsWith(".md"))
                        .filter(java.nio.file.Files::isRegularFile)
                        .sorted()
                        .toList();
                for (java.nio.file.Path p : files) {
                    String body = new String(java.nio.file.Files.readAllBytes(p), StandardCharsets.UTF_8);
                    String stripped = stripFrontmatter(body);
                    String id = extractFrontmatterId(body);
                    if (stripped.isBlank()) continue;
                    out.append("## Rule ").append(id == null ? p.getFileName().toString() : id).append("\n\n");
                    out.append(stripped.trim()).append("\n\n");
                }
            }
            return out.length() == 0 ? "_No LLM-judged rules registered._" : out.toString().trim();
        } catch (IOException e) {
            return "_Failed to load rules: " + e.getMessage() + "_";
        }
    }

    /** Jar-mode fallback: the known rule filenames. Mirrors the
     *  Files.list() result when running from the IDE / gradle bootRun. */
    private String loadRulesFromKnownList() {
        String[] knownFiles = {
                "composition-over-inheritance.md",
                "invariance.md",
                "leaf-freestandingness.md",
                "R2-purpose-specificity.md",
                "R4a-feature-envy.md"
        };
        StringBuilder out = new StringBuilder();
        for (String fname : knownFiles) {
            try (InputStream in = AnalyzeService.class.getResourceAsStream(RULES_DIR_RESOURCE + "/" + fname)) {
                if (in == null) continue;
                String body = new String(in.readAllBytes(), StandardCharsets.UTF_8);
                String stripped = stripFrontmatter(body);
                String id = extractFrontmatterId(body);
                if (stripped.isBlank()) continue;
                out.append("## Rule ").append(id == null ? fname : id).append("\n\n");
                out.append(stripped.trim()).append("\n\n");
            } catch (IOException ignored) {
            }
        }
        return out.length() == 0 ? "_No LLM-judged rules registered._" : out.toString().trim();
    }

    private static String stripFrontmatter(String md) {
        String t = md == null ? "" : md;
        if (!t.startsWith("---")) return t;
        int end = t.indexOf("\n---", 3);
        if (end < 0) return t;
        int next = t.indexOf('\n', end + 4);
        return next < 0 ? "" : t.substring(next + 1);
    }

    private static String extractFrontmatterId(String md) {
        if (md == null || !md.startsWith("---")) return null;
        int fmEnd = md.indexOf("\n---", 3);
        if (fmEnd < 0) return null;
        String fm = md.substring(0, fmEnd);
        for (String line : fm.split("\n")) {
            String l = line.trim();
            if (l.startsWith("id:")) return l.substring(3).trim();
        }
        return null;
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
