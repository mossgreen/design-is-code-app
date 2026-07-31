package com.designiscode.app.eval;

import com.designiscode.app.service.DesignContractValidator;

import com.designiscode.app.dto.ScanCatalog;
import com.designiscode.app.dto.SequenceRequest;
import com.designiscode.app.service.AnalyzeService;
import com.designiscode.app.service.CancelRegistry;
import com.designiscode.app.service.DataflowLinter;
import com.designiscode.app.service.ScanService;
import com.designiscode.app.service.SequenceService;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.TestFactory;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Eval of the <b>sequencer</b> prompt: analyzer (real call) → sequencer (real
 * call) → judge the raw step JSON.
 *
 * <p>Why this exists. {@code sequencer.md} was rewritten on 2026-07-30 so that a
 * step's {@code args} are the <i>values the caller passes</i> rather than the
 * callee's parameter list, and every non-void step names its result. That rewrite
 * is the fix for designs that referenced values nothing produced. A prompt rule
 * nobody measures is a wish, and this is the only thing that measures it.
 *
 * <p>It judges the step list rather than an assembled diagram, because the step
 * list is exactly what the prompt controls. {@link DataflowLinter#lintSteps} is
 * the same rule the wizard and the CLI apply — one property, two representations.
 *
 * <p>Opt-in and pass-rate gated like {@link AnalyzerEvalTest}: unset
 * {@code disc.eval.projectPath} means SKIP, and a fixture passes when at least
 * {@code ceil(passRate × runs)} runs are clean.
 */
@Tag("eval")
class SequencerEvalTest {

    private static final List<EvalFixture> FIXTURES = List.of(new VisitFeeFixture());
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    /** Names the pattern sketches use as stand-ins. Shipping one means the shape was copied. */
    private static final Set<String> PLACEHOLDERS = Set.of("key", "input", "value", "data");

    private record RunResult(int run, List<String> failures, String error) {
        boolean passed() {
            return error == null && failures.isEmpty();
        }
    }

    @TestFactory
    List<DynamicTest> sequencerBindsValuesThatExist() throws Exception {
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
        SequenceService sequenceService = new SequenceService(300L, "low", new CancelRegistry());
        ScanCatalog catalog = new ScanService().scan(projectDir.toString());

        Path evalRoot = Path.of("build", "eval", "sequencer");
        Files.createDirectories(evalRoot);

        List<DynamicTest> tests = new ArrayList<>(FIXTURES.size());
        for (EvalFixture fixture : FIXTURES) {
            tests.add(DynamicTest.dynamicTest(
                    fixture.name() + " (" + runs + " run(s), gate " + passRate + ")",
                    () -> runFixture(fixture, analyzeService, sequenceService, catalog,
                            model, runs, passRate, evalRoot.resolve(fixture.name()))));
        }
        return tests;
    }

    private void runFixture(EvalFixture fixture, AnalyzeService analyzeService,
                            SequenceService sequenceService, ScanCatalog catalog, String model,
                            int runs, double passRate, Path dir) throws IOException {
        Files.createDirectories(dir);
        List<RunResult> results = new ArrayList<>(runs);

        for (int run = 1; run <= runs; run++) {
            RunResult result;
            try {
                Map<String, Object> design = analyzeService.analyze(
                        fixture.story(), catalog, fixture.acRows(), model);
                Map<String, Object> sequence = sequenceService.compose(
                        toSequenceRequest(fixture, design, model));
                Files.writeString(dir.resolve("run-" + run + "-sequence.json"),
                        JSON.writeValueAsString(sequence));
                result = new RunResult(run, judge(design, sequence), null);
                System.out.println("[eval] sequencer " + fixture.name() + " run " + run + ": "
                        + DesignContractValidator.mapList(sequence, "steps").size() + " steps -> "
                        + (result.passed() ? "PASS" : "FAIL"));
            } catch (Exception e) {
                result = new RunResult(run, List.of(),
                        e.getClass().getSimpleName() + ": " + e.getMessage());
                System.out.println("[eval] sequencer " + fixture.name() + " run " + run
                        + ": ERROR " + result.error());
            }
            Files.writeString(dir.resolve("run-" + run + "-result.txt"), render(result));
            results.add(result);
        }

        long passed = results.stream().filter(RunResult::passed).count();
        int needed = Math.max(1, (int) Math.ceil(passRate * runs));
        assertTrue(passed >= needed, () -> failureMessage(fixture, results, passed, needed, dir));
    }

    /**
     * The prompt contract, as four checks. Each one is a way the old prompt's output
     * differed from the new one, so together they answer "did the rewrite land?".
     */
    private List<String> judge(Map<String, Object> design, Map<String, Object> sequence) {
        List<String> failures = new ArrayList<>();
        List<Map<String, Object>> steps = DesignContractValidator.mapList(sequence, "steps");
        if (steps.isEmpty()) {
            failures.add("sequencer returned no steps");
            return failures;
        }
        List<Map<String, Object>> flat = flatten(steps);

        for (Map<String, Object> step : flat) {
            String where = DesignContractValidator.str(step, "callee")
                    + "." + DesignContractValidator.str(step, "method");
            Object args = step.get("args");

            // 1. args must be VALUES. An object is a signature, which is the old shape.
            if (args instanceof List<?> list) {
                for (Object a : list) {
                    if (a instanceof Map) {
                        failures.add(where + " passes a signature object in args — args are values now");
                    } else if (a instanceof String s && PLACEHOLDERS.contains(s.trim())) {
                        failures.add(where + " passes the placeholder '" + s.trim()
                                + "' — a copied sketch name, not a value in scope");
                    }
                }
            } else if (args == null) {
                failures.add(where + " has no args — every call must state what it passes");
            }

            // 2. a non-void step must name its result, or nothing downstream can use it.
            String returns = DesignContractValidator.str(step, "returns");
            boolean voidish = returns != null && returns.trim().equalsIgnoreCase("void");
            if (!voidish && DesignContractValidator.str(step, "resultName") == null
                    && step.containsKey("returns")) {
                failures.add(where + " returns a value but does not name it (resultName)");
            }
        }

        // 3. the flow itself must connect — the same rule the wizard and CLI apply.
        String sut = DesignContractValidator.str(design, "sut");
        DataflowLinter.Report report = DataflowLinter.lintSteps(
                sut, entryMethodName(design, sut), entryParams(design, sut), flat);
        failures.addAll(report.violations());
        return failures;
    }

    /** Fragments nest; the data-flow rule reads the flow linearly, so flatten first. */
    private static List<Map<String, Object>> flatten(List<Map<String, Object>> steps) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> s : steps) {
            if (s == null) continue;
            if (s.containsKey("kind")) {
                out.addAll(flatten(DesignContractValidator.mapList(s, "steps")));
                out.addAll(flatten(DesignContractValidator.mapList(s, "elseSteps")));
            } else {
                out.add(s);
            }
        }
        return out;
    }

    private static Map<String, Object> sutBehavior(Map<String, Object> design, String sut) {
        for (Map<String, Object> p : DesignContractValidator.mapList(design, "participants")) {
            if (sut != null && sut.equals(DesignContractValidator.str(p, "name"))) {
                List<Map<String, Object>> behaviors = DesignContractValidator.mapList(p, "behaviors");
                return behaviors.isEmpty() ? Map.of() : behaviors.get(0);
            }
        }
        return Map.of();
    }

    private static String entryMethodName(Map<String, Object> design, String sut) {
        return DesignContractValidator.str(sutBehavior(design, sut), "name");
    }

    /** The orchestrator's inputs: the only values in the flow that need no producer. */
    private static List<String> entryParams(Map<String, Object> design, String sut) {
        Set<String> names = new LinkedHashSet<>();
        for (Map<String, Object> a : DesignContractValidator.mapList(sutBehavior(design, sut), "args")) {
            String n = DesignContractValidator.str(a, "name");
            if (n != null) names.add(n);
        }
        return new ArrayList<>(names);
    }

    @SuppressWarnings("unchecked")
    private static SequenceRequest toSequenceRequest(EvalFixture fixture,
                                                     Map<String, Object> design, String model) {
        return new SequenceRequest(
                fixture.story(),
                (List<Map<String, Object>>) (List<?>) DesignContractValidator.mapList(design, "participants"),
                (List<Map<String, Object>>) (List<?>) DesignContractValidator.mapList(design, "entities"),
                DesignContractValidator.str(design, "sut"),
                model, null, null);
    }

    private static String failureMessage(EvalFixture fixture, List<RunResult> results,
                                         long passed, int needed, Path dir) {
        StringBuilder sb = new StringBuilder();
        sb.append("sequencer/").append(fixture.name()).append(": ").append(passed)
                .append('/').append(results.size()).append(" runs passed; gate requires ")
                .append(needed).append(". Artifacts: ").append(dir.toAbsolutePath()).append('\n');
        for (RunResult r : results) {
            sb.append("  run ").append(r.run()).append(": ")
                    .append(r.passed() ? "PASS" : "FAIL").append('\n');
            if (r.error() != null) sb.append("    error: ").append(r.error()).append('\n');
            r.failures().forEach(x -> sb.append("    ").append(x).append('\n'));
        }
        return sb.toString();
    }

    private static String render(RunResult r) {
        StringBuilder sb = new StringBuilder();
        sb.append(r.passed() ? "PASS" : "FAIL").append('\n');
        if (r.error() != null) sb.append("error: ").append(r.error()).append('\n');
        r.failures().forEach(x -> sb.append("failure: ").append(x).append('\n'));
        return sb.toString();
    }
}
