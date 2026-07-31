package com.designiscode.app.service;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The wizard's design chain — sequencer JSON → {@code resolveSequence} →
 * {@code emitPlantUml} — exercised against the real {@code static/js/app.js}.
 *
 * <p>This is the frontend's first automated test, and it exists because the
 * frontend is where the 2026-07-30 defect lived: call arrows echoed the callee's
 * declared parameter names instead of the values the caller passes, so a design
 * could name a value nothing produced. That code had no tests, which is the
 * whole reason a notation-level defect survived to generated output.
 *
 * <p>Runs {@code node src/test/js/design-chain.js}, which prints one {@code .puml}
 * per case, then judges each with {@link DataflowLinter} — the same rule the
 * wizard and the CLI use. No model calls, no network, no browser.
 */
class FrontendChainTest {

    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final Path SCRIPT = Path.of("src", "test", "js", "design-chain.js");
    private static JsonNode cases;

    @BeforeAll
    static void runChain() throws IOException, InterruptedException {
        Assumptions.assumeTrue(Files.exists(SCRIPT), "design-chain.js missing");
        ProcessBuilder pb = new ProcessBuilder("node", SCRIPT.toString()).redirectErrorStream(true);
        Process p;
        try {
            p = pb.start();
        } catch (IOException e) {
            // A missing toolchain is not a broken build. Say so and skip.
            Assumptions.abort("node not on PATH — frontend chain test skipped");
            return;
        }
        String out = new String(p.getInputStream().readAllBytes());
        assertTrue(p.waitFor(60, TimeUnit.SECONDS), "design-chain.js timed out");
        assertEquals(0, p.exitValue(), () -> "design-chain.js failed:\n" + out);
        cases = JSON.readTree(out);
    }

    private static String puml(String caseName) {
        JsonNode c = cases.get(caseName);
        assertTrue(c != null && c.has("puml"), "case missing from design-chain.js output: " + caseName);
        assertEquals(0, c.get("warnings").size(),
                () -> caseName + " resolved with warnings: " + c.get("warnings"));
        return c.get("puml").asString();
    }

    /**
     * The defect, pinned. The callees declare {@code key} and {@code hours}; the
     * orchestrator holds {@code region} and {@code orderId}. The arrows must carry
     * the caller's values, because the plugin reads them as values — an arrow
     * showing {@code resolve(key)} generates a reference to nothing.
     */
    @Test
    void callArrowsCarryTheCallersValuesNotTheCalleesParameterNames() {
        String p = puml("bindingWinsOverDeclaration");
        assertTrue(p.contains("resolve(region)"), p);
        assertTrue(p.contains("calculate(orderId)"), p);
        assertFalse(p.contains("resolve(key)"), "the callee's parameter name leaked into the arrow:\n" + p);
        assertFalse(p.contains("calculate(hours)"), "the callee's parameter name leaked into the arrow:\n" + p);
    }

    /** A step with no binding still emits a usable arrow rather than an empty one. */
    @Test
    void aStepWithoutBindingsFallsBackToDeclaredNames() {
        assertTrue(puml("fallsBackToDeclaredNames").contains("load(orderId)"));
    }

    /**
     * Older sequencer responses put {@code {name,type}} objects in {@code args}.
     * That is a signature, not a binding, and must never be read as a value.
     */
    @Test
    void aSignatureShapedArgsListIsNotMistakenForValues() {
        String p = puml("oldShapeResponseStillResolves");
        assertTrue(p.contains("load(orderId)"), p);
        assertFalse(p.contains("{"), "an object leaked into an arrow label:\n" + p);
    }

    /**
     * The 07-24 failure in miniature: a value fetched and handed to nobody, and a
     * value consumed that nothing produced. Both look correct in a diagram.
     */
    @Test
    void aSeveredFlowIsReportedNotSilentlyAccepted() {
        DataflowLinter.Report r = DataflowLinter.lint(puml("severedFlowIsVisible"));
        assertFalse(r.ok(), "a value from nowhere must be a violation");
        assertTrue(r.violations().stream().anyMatch(v -> v.contains("'basket'")),
                () -> r.violations().toString());
        assertTrue(r.warnings().stream().anyMatch(w -> w.contains("'discount'")),
                () -> "a fetched-and-dropped value must at least warn: " + r.warnings());
    }

    /** An unnamed result is named from the consumer that needs it, so the chain still connects. */
    @Test
    void anUnnamedResultIsStillReferenceableDownstream() {
        String p = puml("unnamedResultStillChains");
        assertTrue(p.contains("order : Order"), p);
        assertTrue(DataflowLinter.lint(p).ok(),
                () -> DataflowLinter.lint(p).violations().toString());
    }

    /**
     * The accessor rule can only judge what the wizard tells it about. This pins
     * the other half of that contract: reused types arrive with their real
     * methods, a type the design is creating does not (it has none yet), and an
     * unconnected project sends nothing, leaving the rule silent by construction.
     */
    @Test
    void theWizardSendsMethodsForReusedTypesOnly() {
        JsonNode payload = cases.get("knownTypesPayload");
        assertTrue(payload != null, "knownTypesPayload case missing from design-chain.js");
        JsonNode bound = payload.get("bound");
        assertTrue(bound.has("Visit"), () -> "a reused type must be sent: " + bound);
        assertEquals(2, bound.get("Visit").size(), () -> bound.toString());
        assertFalse(bound.has("Fee"), () -> "a type being created has no methods to check: " + bound);
        assertEquals(0, payload.get("unconnected").size(),
                "with no scanned project there is nothing to judge against");
    }

    /** The whole point of the notation: a correct design passes the same gate the reviewer sees. */
    @Test
    void wellFormedDesignsLintClean() {
        for (String name : new String[]{"bindingWinsOverDeclaration", "fallsBackToDeclaredNames",
                "oldShapeResponseStillResolves", "unnamedResultStillChains"}) {
            DataflowLinter.Report r = DataflowLinter.lint(puml(name));
            assertTrue(r.ok(), () -> name + " should lint clean: " + r.violations());
        }
    }
}
