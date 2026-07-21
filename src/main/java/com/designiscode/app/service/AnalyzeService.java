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
    private static final String PH_CURRENT_FLOWS = "{CURRENT_FLOWS}";
    private static final String PH_ACCEPTANCE_CRITERIA = "{ACCEPTANCE_CRITERIA}";
    private static final String PH_RULES = "{RULES}";
    private static final String PH_SELF_CHECK_RULES = "{SELF_CHECK_RULES}";

    /** How many lexically-matched types to inject as grounding. Tuned to
     *  fit ~2 KB of prompt budget on a typical Spring sample. */
    private static final int TOP_K_TYPES = 20;

    /** Soft byte cap passed to the renderer. ~2 KB matches the prior implicit
     *  budget of the markdown renderer; ElidedTreeRenderer degrades detail
     *  gracefully when it would exceed this. */
    private static final int CODEBASE_TYPES_MAX_BYTES = 2048;

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(AnalyzeService.class);

    /** Hard timeout for the subprocess, in seconds. Configurable via
     *  {@code disc.claude.timeout} (default 300). A bound still exists so a
     *  dead/stalled call fails instead of spinning forever. */
    private final long timeoutSeconds;

    /** Reasoning effort passed to the CLI via {@code --effort}; blank omits the
     *  flag. Configurable via {@code disc.claude.effort} (default "low" — less
     *  thinking, faster; Opus 4.8 in particular reasons heavily at medium/high
     *  and stalls the call, so low keeps latency bounded. Raise only if design
     *  quality suffers). */
    private final String effort;

    private final String promptTemplate;
    private final String rulesSection;
    private final String selfCheckRulesSection;
    private final CatalogRenderer renderer;
    private final ObjectMapper json = JsonMapper.builder().build();

    /** Client-cancellable runs: the subprocess registers under the request's
     *  runId so POST /api/analyze/cancel can kill it mid-flight. */
    private final CancelRegistry cancelRegistry;

    public AnalyzeService(
            @Value("${disc.catalog.renderer:elided}") String rendererName,
            @Value("${disc.claude.timeout:300}") long timeoutSeconds,
            @Value("${disc.claude.effort:low}") String effort,
            CancelRegistry cancelRegistry
    ) throws IOException {
        this.timeoutSeconds = timeoutSeconds;
        this.effort = effort;
        this.cancelRegistry = cancelRegistry;
        this.promptTemplate = loadResource(PROMPT_RESOURCE);
        List<Rule> rules = loadRules();
        this.rulesSection = renderGuidance(rules);
        this.selfCheckRulesSection = renderSelfChecks(rules);
        this.renderer = switch (rendererName == null ? "elided" : rendererName.toLowerCase()) {
            case "markdown" -> new MarkdownRenderer();
            default -> new ElidedTreeRenderer();
        };
    }

    public Map<String, Object> analyze(String context, ScanCatalog catalog, List<AcRow> acceptanceCriteria, String model)
            throws IOException, InterruptedException {
        return analyze(context, catalog, acceptanceCriteria, model, null, null);
    }

    public Map<String, Object> analyze(String context, ScanCatalog catalog, List<AcRow> acceptanceCriteria,
                                       String model, String runId, List<String> currentFlows)
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
                .replace(PH_CURRENT_FLOWS, renderCurrentFlows(currentFlows))
                .replace(PH_ACCEPTANCE_CRITERIA, acMd)
                .replace(PH_RULES, rulesSection)
                .replace(PH_SELF_CHECK_RULES, selfCheckRulesSection);

        // Pure prompt->JSON transform: run a SINGLE completion, not an agentic
        // session. --tools "" disables every tool (no multi-turn wandering);
        // --strict-mcp-config with no --mcp-config spawns zero MCP servers (the
        // repo's project config otherwise brings up the playwright browser on
        // every call). With no tools there is nothing to permit, so the old
        // --dangerously-skip-permissions is gone.
        List<String> args = new ArrayList<>(List.of(
                "claude",
                "--strict-mcp-config",
                "--tools", ""
        ));
        if (effort != null && !effort.isBlank()) {
            args.add("--effort");
            args.add(effort.trim());
        }
        Models.appendIfValid(args, model);
        args.add("-p");
        args.add(prompt);

        ProcessBuilder pb = new ProcessBuilder(args)
                .redirectErrorStream(true)
                .redirectInput(new File("/dev/null"));

        long startNanos = System.nanoTime();
        // Dump the fully-assembled prompt so we can eyeball its size + content
        // when diagnosing latency. Overwrites each run; ~4 chars/token heuristic.
        int approxTokens = prompt.length() / 4;
        try {
            java.nio.file.Path dump = java.nio.file.Path.of(
                    System.getProperty("java.io.tmpdir"), "disc-analyze-prompt.txt");
            java.nio.file.Files.writeString(dump, prompt);
            log.info("analyze start: model={}, effort={}, promptChars={} (~{} tokens), dumped to {}",
                    model, effort, prompt.length(), approxTokens, dump);
        } catch (IOException dumpErr) {
            log.info("analyze start: model={}, effort={}, promptChars={} (~{} tokens) [dump failed: {}]",
                    model, effort, prompt.length(), approxTokens, dumpErr.getMessage());
        }

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

        // Drain stdout on a daemon thread so the timeout below actually bounds
        // the call: a hung `claude` keeps the pipe open, and reading on THIS
        // thread would block in readAll() forever (past the timeout, which then
        // never fires). The background read also prevents a full ~64 KB pipe
        // buffer from dead-locking a chatty-but-healthy run.
        StringBuilder collected = new StringBuilder();
        Thread reader = new Thread(() -> {
            try {
                collected.append(readAll(process.getInputStream()));
            } catch (IOException ignored) {
                // stream closed by destroyForcibly, or normal EOF on exit
            }
        });
        reader.setDaemon(true);
        reader.start();

        if (runId != null && !runId.isBlank()) cancelRegistry.register(runId, process);
        boolean exited;
        try {
            exited = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
        } finally {
            if (runId != null && !runId.isBlank()) cancelRegistry.unregister(runId);
        }
        if (!exited) {
            process.destroyForcibly();
            log.warn("analyze TIMED OUT after {} ms (model={})",
                    (System.nanoTime() - startNanos) / 1_000_000, model);
            throw new IOException("claude analysis timed out after " + timeoutSeconds + "s");
        }
        reader.join(5_000); // process exited -> reader hits EOF promptly; join publishes the buffer
        String stdout = collected.toString();
        int exit = process.exitValue();
        log.info("analyze done: model={}, exit={}, {} ms, outChars={}",
                model, exit, (System.nanoTime() - startNanos) / 1_000_000, stdout.length());
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
    /** The derived what-IS flows for update-mode grounding; explicit "none"
     *  line when absent so the preservation rules visibly don't apply. */
    static String renderCurrentFlows(List<String> flows) {
        List<String> present = flows == null ? List.of()
                : flows.stream().filter(f -> f != null && !f.isBlank()).toList();
        if (present.isEmpty()) {
            return "_None — no existing flow was derived for this story "
                    + "(greenfield, or no catalog class is named as the thing being changed)._";
        }
        return String.join("\n\n---\n\n", present);
    }

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
     * A registered design rule, parsed from one {@code /prompts/rules/*.md}
     * file. The same object feeds two prompt placeholders — its full guidance
     * into {@code {RULES}} (see {@link #renderRule}) and its one-line
     * {@code assertion} into {@code {SELF_CHECK_RULES}} (see
     * {@link #renderSelfChecks}) — so a rule is authored once and enforced in
     * both places from a single source.
     */
    private record Rule(String id, String title, String why, String appliesWhen,
                        String severity, String assertion, String guidance) {}

    /** Build a {@link Rule} from one rule file's text; {@code null} when the
     *  guidance body is blank. Missing properties degrade to the file's id,
     *  then {@code fallbackId}. */
    private static Rule toRule(String md, String fallbackId) {
        String guidance = stripFrontmatter(md).trim();
        if (guidance.isBlank()) return null;
        java.util.Map<String, String> fm = parseFrontmatter(md);
        String id = orElse(fm.get("id"), fallbackId);
        return new Rule(id, orElse(fm.get("title"), id), fm.get("why"),
                fm.get("applies-when"), fm.get("severity"), fm.get("assertion"), guidance);
    }

    /**
     * Load every rule under {@code /prompts/rules/} once, in sorted-filename
     * order, so {@code {RULES}} and {@code {SELF_CHECK_RULES}} render in
     * lockstep. Falls back to a known filename list under jar packaging (where
     * the classpath isn't a walkable directory); returns empty when the dir is
     * missing so callers emit a sentinel rather than a literal placeholder.
     */
    private List<Rule> loadRules() {
        try {
            java.net.URL dirUrl = AnalyzeService.class.getResource(RULES_DIR_RESOURCE);
            if (dirUrl == null) return List.of();
            java.nio.file.Path dirPath;
            try {
                dirPath = java.nio.file.Paths.get(dirUrl.toURI());
            } catch (Exception jarOrOdd) {
                // Packaged jar: resources aren't a walkable Path. Fall back to
                // the known filename list (keep it in sync when adding rules),
                // or run from gradle bootRun which exposes the classpath as files.
                return loadRulesFromKnownList();
            }
            if (!java.nio.file.Files.isDirectory(dirPath)) return List.of();
            List<Rule> rules = new ArrayList<>();
            try (var stream = java.nio.file.Files.list(dirPath)) {
                List<java.nio.file.Path> files = stream
                        .filter(p -> p.toString().endsWith(".md"))
                        .filter(java.nio.file.Files::isRegularFile)
                        .sorted()
                        .toList();
                for (java.nio.file.Path p : files) {
                    String body = new String(java.nio.file.Files.readAllBytes(p), StandardCharsets.UTF_8);
                    Rule r = toRule(body, p.getFileName().toString());
                    if (r != null) rules.add(r);
                }
            }
            return rules;
        } catch (IOException e) {
            log.warn("failed to load rules: {}", e.getMessage());
            return List.of();
        }
    }

    /** Jar-mode fallback: the known rule filenames. Sorted to match
     *  {@link #loadRules}' {@code Files.list().sorted()} order so both packaging
     *  modes render rules identically. */
    private List<Rule> loadRulesFromKnownList() {
        String[] knownFiles = {
                "composition-over-inheritance.md",
                "invariance.md",
                "leaf-freestandingness.md",
                "R2-purpose-specificity.md",
                "R4a-feature-envy.md",
                "update-mode-binding.md"
        };
        java.util.Arrays.sort(knownFiles);
        List<Rule> rules = new ArrayList<>();
        for (String fname : knownFiles) {
            try (InputStream in = AnalyzeService.class.getResourceAsStream(RULES_DIR_RESOURCE + "/" + fname)) {
                if (in == null) continue;
                String body = new String(in.readAllBytes(), StandardCharsets.UTF_8);
                Rule r = toRule(body, fname);
                if (r != null) rules.add(r);
            } catch (IOException ignored) {
            }
        }
        return rules;
    }

    /** Render the full guidance block for {@code {RULES}}. Sentinel when empty
     *  so the placeholder is never left literal. */
    private static String renderGuidance(List<Rule> rules) {
        if (rules.isEmpty()) return "_No LLM-judged rules registered._";
        StringBuilder out = new StringBuilder();
        for (Rule r : rules) out.append(renderRule(r)).append("\n\n");
        return out.toString().trim();
    }

    /** Render the per-rule self-check lines for {@code {SELF_CHECK_RULES}} —
     *  one bullet per rule carrying an {@code assertion}, cross-referenced by
     *  id back to its full guidance in {@code {RULES}}. */
    private static String renderSelfChecks(List<Rule> rules) {
        StringBuilder out = new StringBuilder();
        for (Rule r : rules) {
            if (r.assertion() == null || r.assertion().isBlank()) continue;
            out.append("- **").append(r.title()).append("** — ")
               .append(r.assertion().trim())
               .append(" (rule `").append(r.id()).append("`).\n");
        }
        return out.length() == 0 ? "_No rule checks registered._" : out.toString().trim();
    }

    private static String stripFrontmatter(String md) {
        String t = md == null ? "" : md;
        if (!t.startsWith("---")) return t;
        int end = t.indexOf("\n---", 3);
        if (end < 0) return t;
        int next = t.indexOf('\n', end + 4);
        return next < 0 ? "" : t.substring(next + 1);
    }

    /**
     * Parse a leading {@code ---} front-matter block of flat {@code key: value}
     * lines into a map (insertion-ordered). Returns an empty map when the text
     * has no front-matter. The rule files are flat — no nested YAML — so a
     * line-by-line split is sufficient.
     */
    private static java.util.Map<String, String> parseFrontmatter(String md) {
        java.util.Map<String, String> out = new java.util.LinkedHashMap<>();
        if (md == null || !md.startsWith("---")) return out;
        int fmEnd = md.indexOf("\n---", 3);
        if (fmEnd < 0) return out;
        for (String line : md.substring(0, fmEnd).split("\n")) {
            String l = line.trim();
            int colon = l.indexOf(':');
            if (colon <= 0) continue;
            String key = l.substring(0, colon).trim();
            String val = l.substring(colon + 1).trim();
            if (!key.isEmpty()) out.put(key, val);
        }
        return out;
    }

    /**
     * Render one rule's guidance block for {@code {RULES}}: a header carrying
     * its properties (title, id, severity, appliesWhen) and a {@code Why} line,
     * above its guidance body.
     */
    private static String renderRule(Rule r) {
        StringBuilder sb = new StringBuilder();
        sb.append("## ").append(r.title()).append("  ·  id `").append(r.id()).append('`');
        if (r.severity() != null && !r.severity().isBlank()) sb.append(" · severity: ").append(r.severity().trim());
        if (r.appliesWhen() != null && !r.appliesWhen().isBlank()) sb.append(" · applies when: ").append(r.appliesWhen().trim());
        sb.append('\n');
        if (r.why() != null && !r.why().isBlank()) sb.append("_Why: ").append(r.why().trim()).append("_\n");
        sb.append('\n').append(r.guidance());
        return sb.toString();
    }

    private static String orElse(String v, String fallback) {
        return (v == null || v.isBlank()) ? fallback : v.trim();
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
