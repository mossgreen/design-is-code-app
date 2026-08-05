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

    // --- the .decision.md frontmatter contract ---
    //
    // The plugin refuses at Step 1 when a `required_decision` (rounding, scale,
    // nullHandling, exceptionType) is pinned by neither the rows nor `config:`.
    // Three emitters write sidecars and they had drifted apart; these pin the
    // contract per mode so they cannot drift again.

    private static JsonNode sidecar(String mode) {
        JsonNode all = cases.get("decisionFrontmatter");
        assertTrue(all != null, "decisionFrontmatter case missing from design-chain.js");
        JsonNode files = all.get(mode);
        assertEquals(1, files.size(), () -> mode + " should emit exactly one sidecar: " + files);
        return files.get(0);
    }

    /**
     * Resolver mode is exempt from {@code config:} — and that is not an omission.
     * Its generated body is {@code map.get(key)}, which contains no rounding,
     * scale or null decision to pin, and the plugin's documented resolver
     * frontmatter has none. Emitting one here would be noise at best.
     */
    @Test
    void aResolverSidecarCarriesNoConfigBlock() {
        String content = sidecar("resolver").get("content").asString();
        assertFalse(content.contains("config:"),
                "resolver mode has no required_decision to pin:\n" + content);
        assertTrue(content.contains("target: FeePolicyResolver.resolve"), content);
        assertTrue(content.contains("output: FeePolicy"), content);
    }

    /**
     * A rule-table lookup is not one of the plugin's special modes: it is a
     * pure-function leaf returning a record, so standard filled mode applies and
     * the null decision must be pinned. It does no arithmetic, so rounding and
     * scale must stay out — an inapplicable key is noise the reader must decode.
     */
    @Test
    void aRuleTableSidecarPinsTheNullDecisionButNotArithmetic() {
        String content = sidecar("ruleTable").get("content").asString();
        assertTrue(content.contains("nullHandling: throw"), content);
        assertTrue(content.contains("exceptionType: java.lang.IllegalArgumentException"), content);
        assertFalse(content.contains("rounding:"), "a Map lookup does no rounding:\n" + content);
        assertFalse(content.contains("scale:"), "a Map lookup has no scale:\n" + content);
    }

    /** A numeric pure-function leaf must pin every required_decision, arithmetic included. */
    @Test
    void aNumericLeafSidecarPinsEveryRequiredDecision() {
        String content = sidecar("leaf").get("content").asString();
        for (String key : new String[]{"rounding: HALF_UP", "scale: 2", "nullHandling: throw",
                "exceptionType: java.lang.IllegalArgumentException"}) {
            assertTrue(content.contains(key), () -> "missing " + key + " in:\n" + content);
        }
    }

    /**
     * Every pinned value the human did not choose is reported, not buried. These
     * are decisions the methodology assigns to a person — silently defaulting
     * them is how a table and an implementation agree with each other and are
     * both wrong. Emitting the default keeps the file generatable; recording it
     * is what lets sign-off show the reader which choices were never made.
     */
    @Test
    void defaultsAppliedOnTheHumansBehalfAreRecorded() {
        JsonNode applied = sidecar("leaf").get("appliedDefaults");
        assertTrue(applied != null && applied.size() == 4,
                () -> "an unattended leaf table defaults all four: " + applied);
        assertFalse(sidecar("resolver").has("appliedDefaults"),
                "resolver mode decides nothing, so it defaults nothing");
    }

    /**
     * The sign-off panel renders from this summary, so it has to name the file
     * and the specific keys. "Some defaults were applied" is not something a
     * reviewer can act on.
     */
    @Test
    void theSignoffSummaryNamesEveryFileThatTookADefault() {
        JsonNode untouched = cases.get("appliedDefaultsSummary").get("untouched");
        assertEquals(1, untouched.size(), () -> "only the leaf defaults anything: " + untouched);
        assertEquals("LateFeeCalculator.decision.md", untouched.get(0).get("fileName").asString());
        assertEquals(4, untouched.get(0).get("keys").size(),
                () -> "an unattended numeric leaf defaults all four: " + untouched);
        assertFalse(cases.get("appliedDefaultsSummary").get("resolverListed").asBoolean(),
                "resolver mode emits no config block, so it can default nothing");
    }

    /**
     * The case the disclosure exists for. A human who opened the decision-table
     * editor and set one key believes the config is theirs — while the wizard
     * quietly supplies the arithmetic. Stating one key must not suppress the
     * report of the keys they never stated.
     */
    @Test
    void statingOneConfigKeyDoesNotHideTheOthersStillDefaulted() {
        JsonNode authored = cases.get("appliedDefaultsSummary").get("authored");
        assertEquals(1, authored.size(), () -> "the leaf still defaults something: " + authored);
        String keys = authored.get(0).get("keys").toString();
        assertTrue(keys.contains("rounding") && keys.contains("scale"),
                () -> "arithmetic the human never chose stays reported: " + keys);
        assertFalse(keys.contains("nullHandling"),
                () -> "the key the human did state drops out: " + keys);
    }

    /**
     * The contract checks read the analyzer model; the wizard holds an edited
     * form with different names for the same things ({@code methods}/{@code
     * inputs} vs {@code behaviors}/{@code args}) and an id where the model wants
     * the SUT's name. {@code designModelForContract()} is that translation, and a
     * wrong translation is worse than no check: the panel would report violations
     * about a design nobody has.
     *
     * <p>So the projection is judged by the real validator, not by eye.
     */
    @Test
    void aGoodDesignProjectsToAModelTheContractValidatorAccepts() {
        JsonNode good = cases.get("contractProjection").get("good");
        DesignContractValidator.Report r =
                DesignContractValidator.validate(asModel(good), 1);

        assertTrue(r.ok(), () -> "the projection of a sound design was refused — the "
                + "translation is wrong, not the design: " + r.violations());
    }

    /**
     * The rule that broke this once: {@code ownedBy} is required by the contract
     * checks but is <em>analyzer</em> metadata — no entity the wizard builds has
     * it. {@code makeEntity()} has no such field and {@code mergeDerivedEntities()}
     * invents entities from signatures without one, so every hand-authored design
     * reported "entity X has no ownedBy", which then blocked sign-off and burned a
     * sequencer retry that could not have fixed it.
     *
     * <p>The fixture above builds its entities through those two functions, so
     * this asserts the derivation actually fires. Naming the rule explicitly
     * matters: the accept-test above would also pass if the entity list were
     * simply empty.
     */
    @Test
    void entitiesTheWizardInventedStillGetAnOwner() {
        JsonNode good = cases.get("contractProjection").get("good");
        JsonNode derived = cases.get("contractProjection").get("derivedNames");

        assertTrue(derived.size() > 0,
                () -> "fixture no longer derives an entity, so it cannot prove anything: " + derived);
        for (JsonNode e : good.get("entities")) {
            assertFalse(e.get("ownedBy").isNull(),
                    () -> "entity " + e.get("name").asString() + " reached the contract checks "
                            + "with no owner — this is what made every wizard-built design "
                            + "report a violation");
        }
    }

    /**
     * And the other direction: a projection that always returns something clean
     * would be a pre-filter that never fires. One broken rule — a sealed family
     * with a single permit, which the plugin refuses at Step 1 — must survive the
     * translation and be reported.
     */
    @Test
    void aBrokenRuleSurvivesTheProjectionAndIsReported() {
        JsonNode broken = cases.get("contractProjection").get("broken");
        DesignContractValidator.Report r =
                DesignContractValidator.validate(asModel(broken), 1);

        assertFalse(r.ok(), "a one-permit sealed family must be caught");
        assertTrue(r.violations().toString().contains("permits"),
                () -> "the violation must name the rule: " + r.violations());
    }

    @SuppressWarnings("unchecked")
    private static java.util.Map<String, Object> asModel(JsonNode node) {
        return JSON.convertValue(node, java.util.Map.class);
    }

    /**
     * Save writes one set of sidecars and the data-flow gate judges one set.
     * They must be the same set, or the reviewer is warned about files that
     * never land — the same drift that let four hand-rolled frontmatter blocks
     * disagree in the first place.
     */
    @Test
    void everyEmitterContributesToTheOneSetThatGetsWritten() {
        JsonNode all = cases.get("decisionFrontmatter").get("all");
        assertEquals(3, all.size(), () -> "resolver + rule-table + leaf: " + all);
        String names = all.toString();
        assertTrue(names.contains("FeePolicyResolver.decision.md"), names);
        assertTrue(names.contains("FeeRateTable.decision.md"), names);
        assertTrue(names.contains("LateFeeCalculator.decision.md"), names);
    }

    /**
     * A human who filled in a table answered the question the generator would
     * otherwise guess at. The synthesised table for the same participant must
     * not overwrite that answer.
     */
    @Test
    void aHumanAuthoredTableWinsOverTheSynthesisedOne() {
        JsonNode p = cases.get("decisionPrecedence");
        assertEquals(1, p.get("autoCount").asInt(), "the leaf synthesises one table on its own");
        assertEquals(1, p.get("authoredCount").asInt(),
                "attaching a human table must replace it, not add a second file");
        String content = p.get("authoredContent").asString();
        assertTrue(content.contains("| 12    | 99.99"), "the human's row must survive:\n" + content);
        assertTrue(content.contains("nullHandling: passThrough"),
                "the human's choice must survive:\n" + content);
        assertFalse(content.contains("exceptionType"),
                "exceptionType belongs to 'throw' only:\n" + content);
        // The human answered one question, not all of them; the rest still default.
        assertTrue(content.contains("rounding: HALF_UP"), content);
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
