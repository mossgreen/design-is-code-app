package com.designiscode.app.eval;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.TestFactory;

import com.designiscode.app.dto.ScanCatalog;
import com.designiscode.app.service.AnalyzeService;
import com.designiscode.app.service.Models;
import com.designiscode.app.service.ScanService;

/**
 * End-to-end eval of the Step-2 analyzer prompt: scan a REAL project on disk →
 * run the analyzer (which shells out to the {@code claude} CLI) → assert the
 * returned design-model with plain Java assertions (no LLM judge). Every
 * fixture in {@link #FIXTURES} runs {@code disc.eval.runs} times for stability.
 *
 * <p><b>Shape.</b> A {@code @TestFactory} emits one dynamic test per
 * fixture × run, so fixtures and the run count are both data — add a fixture to
 * {@link #FIXTURES}, set {@code disc.eval.runs}, no annotation changes. Config
 * resolution, skip gates, and the scan happen once in the factory.
 *
 * <p><b>Opt-in / manual.</b> The {@code disc.eval.projectPath} value is both the
 * config and the on-switch: when it is unset the factory SKIPS, so a normal
 * {@code ./gradlew test} never fires it and no build.gradle change is needed.
 *
 * <p><b>Config sources</b> (first non-blank wins): {@code -D} system property,
 * then environment variable, then a {@code eval.properties} file on the test
 * classpath ({@code src/test/resources/eval.properties}, git-ignored — copy it
 * from {@code eval.properties.example}). Keys: {@code disc.eval.projectPath}
 * (required), {@code disc.eval.model} (optional; must be in
 * {@link Models#ALLOWED}), {@code disc.eval.runs} (optional; default 1).
 *
 * <p>Configure the file once, or override per-run. The Gate-0a stability gate is:
 * <pre>
 *   ./gradlew test --tests '*AnalyzerEvalTest' -Ddisc.eval.runs=5
 * </pre>
 */
@Tag("eval")
class AnalyzerEvalTest {

    private static final String PROP_PATH = "disc.eval.projectPath";
    private static final String ENV_PATH = "DISC_EVAL_PROJECT_PATH";
    private static final String PROP_MODEL = "disc.eval.model";
    private static final String PROP_RUNS = "disc.eval.runs";

    /** Every eval scenario; one dynamic test per fixture × run. */
    private static final List<EvalFixture> FIXTURES = List.of(
            new VisitFeeFixture());

    /** Optional git-ignored config file on the test classpath; empty if absent. */
    private static final Properties EVAL_PROPS = loadEvalProps();

    @TestFactory
    List<DynamicTest> analyzerProducesCorrectDesignModel() throws Exception {
        // --- skip gate 1: project path present & is a directory ---
        String pathStr = cfg(PROP_PATH, ENV_PATH);
        Assumptions.assumeTrue(pathStr != null && !pathStr.isBlank(),
                "SKIP: set disc.eval.projectPath (in src/test/resources/eval.properties, "
                        + "-D" + PROP_PATH + "=<dir>, or env " + ENV_PATH + ")");
        Path projectDir = Path.of(pathStr.trim());
        Assumptions.assumeTrue(Files.isDirectory(projectDir),
                "SKIP: project path is not a directory: " + projectDir);

        // --- skip gate 2: claude CLI on PATH ---
        Assumptions.assumeTrue(claudeOnPath(), "SKIP: `claude` CLI not found on PATH");

        String model = resolveModel(); // validated against allow-list, else null (CLI default)
        int runs = resolveRuns();
        AnalyzeService analyzeService = new AnalyzeService("elided");
        ScanCatalog catalog = new ScanService().scan(projectDir.toString());

        List<DynamicTest> tests = new ArrayList<>(FIXTURES.size() * runs);
        for (EvalFixture fixture : FIXTURES) {
            for (int run = 1; run <= runs; run++) {
                final int r = run;
                tests.add(DynamicTest.dynamicTest(
                        fixture.name() + " run " + r + " of " + runs,
                        () -> {
                            Map<String, Object> design = analyzeService.analyze(
                                    fixture.story(), catalog, fixture.acRows(), model);
                            fixture.assertDesignModel(design, r);
                        }));
            }
        }
        return tests;
    }

    // --- config resolution: -D system property > env var > eval.properties ---

    /** Run count per fixture; default 1, floor 1 (bad values fall back, never fail). */
    private static int resolveRuns() {
        String raw = cfg(PROP_RUNS, null);
        if (raw == null || raw.isBlank()) return 1;
        try {
            return Math.max(1, Integer.parseInt(raw.trim()));
        } catch (NumberFormatException e) {
            return 1;
        }
    }

    private static String resolveModel() {
        String requested = cfg(PROP_MODEL, null);
        if (requested == null || requested.isBlank()) return null;
        String trimmed = requested.trim();
        return Models.ALLOWED.contains(trimmed) ? trimmed : null;
    }

    /** First non-blank of: {@code -D} system property, env var (if named), eval.properties. */
    private static String cfg(String prop, String env) {
        return firstNonBlank(
                System.getProperty(prop),
                env == null ? null : System.getenv(env),
                EVAL_PROPS.getProperty(prop));
    }

    private static Properties loadEvalProps() {
        Properties p = new Properties();
        try (InputStream in = AnalyzerEvalTest.class.getResourceAsStream("/eval.properties")) {
            if (in != null) p.load(in);
        } catch (IOException ignored) {
            // absent or unreadable -> rely on -D / env
        }
        return p;
    }

    private static boolean claudeOnPath() {
        String path = System.getenv("PATH");
        if (path == null) return false;
        for (String dir : path.split(File.pathSeparator)) {
            if (dir.isBlank()) continue;
            File f = new File(dir, "claude");
            if (f.isFile() && f.canExecute()) return true;
        }
        return false;
    }

    private static String firstNonBlank(String... vals) {
        for (String v : vals) {
            if (v != null && !v.isBlank()) return v;
        }
        return null;
    }
}
