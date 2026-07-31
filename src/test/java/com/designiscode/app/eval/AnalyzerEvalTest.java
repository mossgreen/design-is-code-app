package com.designiscode.app.eval;

import com.designiscode.app.service.DesignContractValidator;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.TestFactory;

import com.designiscode.app.dto.ScanCatalog;
import com.designiscode.app.service.AnalyzeService;
import com.designiscode.app.service.CancelRegistry;
import com.designiscode.app.service.Models;
import com.designiscode.app.service.ScanService;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * End-to-end eval of the Step-2 analyzer prompt: scan a REAL project on disk →
 * run the analyzer (which shells out to the {@code claude} CLI) → judge the
 * returned design-model. No LLM judge; two deterministic tiers per run:
 *
 * <ol>
 *   <li><b>Contract validity</b> ({@link DesignContractValidator}) — gold-free:
 *       would the wizard + plugin accept this design at all?</li>
 *   <li><b>Fixture gold</b> ({@link EvalFixture#goldChecks}) — value-based,
 *       name-agnostic semantic checks for the scenario.</li>
 * </ol>
 *
 * <p><b>Pass-rate gating.</b> One dynamic test per fixture; the fixture runs
 * {@code disc.eval.runs} times and passes when at least
 * {@code ceil(disc.eval.passRate × runs)} runs are clean (default 2/3). A
 * single stochastic flake no longer reds the build; a consistent failure does.
 *
 * <p><b>Artifacts.</b> Every run writes its design JSON and its judgments to
 * {@code build/eval/<fixture>/}, and the factory stamps a prompt fingerprint
 * ({@code build/eval/prompt-fingerprint.txt}) so results are attributable to
 * a prompt version. Failure messages name the artifact directory.
 *
 * <p><b>Opt-in / manual.</b> {@code disc.eval.projectPath} is both config and
 * on-switch: unset → SKIP, so a normal {@code ./gradlew test} never fires it.
 * Config resolution (first non-blank wins): {@code -D} system property, env
 * var, then git-ignored {@code src/test/resources/eval.properties}.
 */
@Tag("eval")
class AnalyzerEvalTest {

    private static final List<EvalFixture> FIXTURES = List.of(
            new VisitFeeFixture());

    /** Prompt resources hashed into the fingerprint (mirrors AnalyzeService's set). */
    private static final List<String> PROMPT_RESOURCES = List.of(
            "/prompts/analyzer.md",
            "/prompts/rules/invariance.md",
            "/prompts/rules/R2-purpose-specificity.md",
            "/prompts/rules/leaf-freestandingness.md",
            "/prompts/rules/R4a-feature-envy.md",
            "/prompts/rules/composition-over-inheritance.md");

    private static final ObjectMapper JSON = JsonMapper.builder().build();

    private record RunResult(int run, List<String> contractViolations, List<String> goldFailures,
                             List<String> warnings, String error) {
        boolean passed() {
            return error == null && contractViolations.isEmpty() && goldFailures.isEmpty();
        }
    }

    @TestFactory
    List<DynamicTest> analyzerProducesAcceptableDesignModels() throws Exception {
        String pathStr = EvalConfig.cfg(EvalConfig.PROP_PATH, EvalConfig.ENV_PATH);
        Assumptions.assumeTrue(pathStr != null && !pathStr.isBlank(),
                "SKIP: set disc.eval.projectPath (eval.properties, -D, or env " + EvalConfig.ENV_PATH + ")");
        Path projectDir = Path.of(pathStr.trim());
        Assumptions.assumeTrue(Files.isDirectory(projectDir),
                "SKIP: project path is not a directory: " + projectDir);
        Assumptions.assumeTrue(EvalConfig.claudeOnPath(), "SKIP: `claude` CLI not found on PATH");

        String model = EvalConfig.model();
        int runs = EvalConfig.runs();
        double passRate = EvalConfig.passRate();
        AnalyzeService analyzeService = new AnalyzeService("elided", 300L, "low", new CancelRegistry());
        ScanCatalog catalog = new ScanService().scan(projectDir.toString());

        Path evalRoot = Path.of("build", "eval");
        Files.createDirectories(evalRoot);
        Files.writeString(evalRoot.resolve("prompt-fingerprint.txt"), promptFingerprint());

        List<DynamicTest> tests = new ArrayList<>(FIXTURES.size());
        for (EvalFixture fixture : FIXTURES) {
            tests.add(DynamicTest.dynamicTest(
                    fixture.name() + " (" + runs + " run(s), gate " + passRate + ")",
                    () -> runFixture(fixture, analyzeService, catalog, model, runs, passRate,
                            evalRoot.resolve(fixture.name()))));
        }
        return tests;
    }

    private void runFixture(EvalFixture fixture, AnalyzeService analyzeService, ScanCatalog catalog,
                            String model, int runs, double passRate, Path dir) throws IOException {
        Files.createDirectories(dir);
        List<RunResult> results = new ArrayList<>(runs);

        for (int run = 1; run <= runs; run++) {
            RunResult result;
            try {
                Map<String, Object> design = analyzeService.analyze(
                        fixture.story(), catalog, fixture.acRows(), model);
                Files.writeString(dir.resolve("run-" + run + "-design.json"),
                        JSON.writeValueAsString(design));
                DesignContractValidator.Report report =
                        DesignContractValidator.validate(design, fixture.acRows().size());
                result = new RunResult(run, report.violations(),
                        fixture.goldChecks(design), report.warnings(), null);
                System.out.println("[eval] " + fixture.name() + " run " + run + ": "
                        + summarize(design) + " -> " + (result.passed() ? "PASS" : "FAIL"));
            } catch (Exception e) {
                result = new RunResult(run, List.of(), List.of(), List.of(),
                        e.getClass().getSimpleName() + ": " + e.getMessage());
                System.out.println("[eval] " + fixture.name() + " run " + run + ": ERROR " + result.error());
            }
            Files.writeString(dir.resolve("run-" + run + "-result.txt"), render(result));
            results.add(result);
        }

        long passed = results.stream().filter(RunResult::passed).count();
        int needed = Math.max(1, (int) Math.ceil(passRate * runs));
        assertTrue(passed >= needed, () -> failureMessage(fixture, results, passed, needed, dir));
    }

    // ---------- reporting ----------

    private static String failureMessage(EvalFixture fixture, List<RunResult> results,
                                         long passed, int needed, Path dir) {
        StringBuilder sb = new StringBuilder();
        sb.append(fixture.name()).append(": ").append(passed).append('/').append(results.size())
                .append(" runs passed; gate requires ").append(needed)
                .append(". Artifacts: ").append(dir.toAbsolutePath()).append('\n');
        for (RunResult r : results) {
            sb.append("  run ").append(r.run()).append(": ")
                    .append(r.passed() ? "PASS" : "FAIL").append('\n');
            if (r.error() != null) sb.append("    error: ").append(r.error()).append('\n');
            r.contractViolations().forEach(x -> sb.append("    contract: ").append(x).append('\n'));
            r.goldFailures().forEach(x -> sb.append("    gold:     ").append(x).append('\n'));
        }
        return sb.toString();
    }

    private static String render(RunResult r) {
        StringBuilder sb = new StringBuilder();
        sb.append(r.passed() ? "PASS" : "FAIL").append('\n');
        if (r.error() != null) sb.append("error: ").append(r.error()).append('\n');
        r.contractViolations().forEach(x -> sb.append("contract-violation: ").append(x).append('\n'));
        r.goldFailures().forEach(x -> sb.append("gold-failure: ").append(x).append('\n'));
        r.warnings().forEach(x -> sb.append("warning: ").append(x).append('\n'));
        return sb.toString();
    }

    private static String summarize(Map<String, Object> design) {
        List<String> patterns = DesignContractValidator.mapList(design, "variancePlan").stream()
                .map(e -> DesignContractValidator.str(e, "pattern")).toList();
        List<Map<String, Object>> ps = DesignContractValidator.mapList(design, "participants");
        List<Integer> caseLengths = ps.stream()
                .flatMap(p -> DesignContractValidator.mapList(p, "behaviors").stream())
                .map(b -> DesignContractValidator.mapList(b, "cases").size())
                .toList();
        return "patterns=" + patterns + " participants=" + DesignContractValidator.names(ps)
                + " caseLengths=" + caseLengths;
    }

    private static String promptFingerprint() throws Exception {
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        StringBuilder sb = new StringBuilder();
        for (String res : PROMPT_RESOURCES) {
            try (InputStream in = AnalyzerEvalTest.class.getResourceAsStream(res)) {
                if (in == null) { sb.append(res).append(": MISSING\n"); continue; }
                byte[] bytes = in.readAllBytes();
                sb.append(res).append(": ")
                        .append(HexFormat.of().formatHex(sha.digest(bytes)), 0, 16).append('\n');
            }
        }
        return sb.toString();
    }

}
