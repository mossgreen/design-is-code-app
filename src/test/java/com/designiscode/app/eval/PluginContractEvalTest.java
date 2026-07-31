package com.designiscode.app.eval;

import com.designiscode.app.dto.ValidateRequest;
import com.designiscode.app.service.CancelRegistry;
import com.designiscode.app.service.RunService;
import com.designiscode.app.service.StreamJsonMapper;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.TestFactory;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The drift guard on the plugin's Step-1 behaviour.
 *
 * <p>The app keeps a deterministic copy of part of the plugin's refusal rules
 * ({@code DesignContractValidator}) so the wizard can answer instantly instead of
 * spending a model call on every Analyze. Two implementations of one grammar can
 * disagree, and the plugin is versioned separately — so the duplication needs a
 * guard, and the guard has to test <b>behaviour</b>, not wording. Grepping
 * {@code SKILL.md} for phrases would fail on a reword and pass on a behaviour
 * change: exactly backwards.
 *
 * <p>Costs model calls (each case is a real {@code --validate-only} run), so it
 * is {@code @Tag("eval")} and never fires from {@code ./gradlew test}. Run it
 * when the plugin version changes — {@code RELEASE.md} says so.
 *
 * <p>Use a capable model: {@code -Ddisc.eval.model=claude-sonnet-4-6}. Haiku
 * reaches the right verdict inconsistently here, which shows up as a skipped
 * case rather than a wrong one, but a guard that skips is not guarding.
 *
 * <p>The most valuable assertion is the first: <b>a valid design must stay
 * valid.</b> A plugin update that starts refusing well-formed designs reaches
 * users as a failed generation; this is the cheapest place to find out instead.
 */
@Tag("eval")
class PluginContractEvalTest {

    private final RunService runService =
            new RunService(new StreamJsonMapper(), new CancelRegistry());

    /**
     * A minimal design that breaks no rule: entities declared in the prelude, a
     * linear orchestrator, every value sourced, no binding to any type outside
     * itself. It exists to catch the failure that reaches users first — a plugin
     * update that starts refusing designs that were always valid.
     */
    private static String wellFormed() {
        return """
                @startuml
                ' @package com.demo

                ' @disc-entities
                class Order <<record>> {
                  + subtotal: BigDecimal
                }
                class Money <<record>> {
                  + amount: BigDecimal
                }

                participant Checkout
                participant TaxCalculator
                [*] -> Checkout : checkout(order)
                Checkout -> TaxCalculator : calculate(order)
                Checkout <-- TaxCalculator : tax : Money
                Checkout --> [*] : tax : Money
                @enduml
                """;
    }

    /** One corpus entry: a design, whether the plugin must refuse it, and why it exists. */
    private record Case(String name, String puml, Map<String, String> sidecars,
                        boolean mustRefuse, String rule) {}

    private static Path projectDir() {
        String raw = EvalConfig.cfg(EvalConfig.PROP_PATH, EvalConfig.ENV_PATH);
        Assumptions.assumeTrue(raw != null && !raw.isBlank(),
                "SKIP: set disc.eval.projectPath (eval.properties, -D, or env " + EvalConfig.ENV_PATH + ")");
        // assumeTrue already aborted if null; the fallback only satisfies the compiler.
        Path dir = Path.of((raw == null ? "" : raw).trim());
        Assumptions.assumeTrue(Files.isDirectory(dir), "SKIP: not a directory: " + dir);
        Assumptions.assumeTrue(EvalConfig.claudeOnPath(), "SKIP: `claude` CLI not on PATH");
        return dir;
    }

    /**
     * Known-good first, then one malformed design per Step-1 rule the app relies
     * on. Each bad case breaks exactly one thing, so a refusal identifies the rule
     * rather than just meaning "something is wrong".
     */
    private static List<Case> corpus() {
        List<Case> cases = new ArrayList<>();

        // Every case must be SELF-CONTAINED — it may not reference types from the
        // project it is validated against. The first draft of this corpus used the
        // shipped golden, which carries six `@class:` bindings to Act-1 output; run
        // against a vanilla clone the plugin refused it, correctly, and the test
        // read that as plugin drift. The corpus has to be valid on its own terms or
        // it measures the project, not the plugin.
        cases.add(new Case("a well-formed design", wellFormed(), Map.of(), false,
                "must be accepted — a valid design must stay valid"));

        // <<interface>> is NOT a sealed family; the rule keys on <<sealed-interface>>
        // paired with <<@permits:...>> inside the entity prelude (java_spring.md:174).
        // Getting this wrong made the first draft report drift that did not exist.
        cases.add(new Case("sealed family with one permit", """
                @startuml
                ' @package com.demo

                ' @disc-entities
                class Fee <<sealed-interface>> <<@permits:OnlyOne>> {
                  + feeFor(hours: long): BigDecimal
                }
                class OnlyOne <<record>>

                participant Svc
                participant Fee
                [*] -> Svc : go(hours)
                Svc -> Fee : feeFor(hours)
                Svc <-- Fee : fee : BigDecimal
                Svc --> [*] : fee : BigDecimal
                @enduml
                """, Map.of(), true, "a sealed-interface needs >= 2 permits"));

        // NOT in the corpus yet: "a declared boundary with no bracketing pair".
        // Three attempts failed to express it — `boundary:` vs `boundaries:`, the
        // list form, and a frontmatter `target_placement` the profile requires
        // (java_spring.md:838; SKILL.md:76) — and each time the plugin accepted,
        // which reads identically to the rule having been dropped. A corpus entry
        // that cannot reliably state its own rule is worse than no entry: it
        // reports drift that is really an authoring mistake. Registered in TODO.md.

        // NOT in the corpus: "a type nothing declares". Observed 2026-08-01 —
        // same design, same plugin, same day: haiku REFUSED it, sonnet ACCEPTED
        // it. A model-dependent verdict cannot serve as a fixed expectation, and
        // the instability is itself the finding: Step 1 is deterministic
        // rule-checking written as prose and executed by a model, so its answers
        // vary with the model. This corpus therefore holds only rules observed to
        // verdict stably. See TODO.md and WHY.md's caveat on claim 2.

        return cases;
    }

    @TestFactory
    List<DynamicTest> pluginStillRefusesWhatWeThinkItRefuses() {
        Path project = projectDir();
        String model = EvalConfig.model();

        List<DynamicTest> tests = new ArrayList<>();
        for (Case c : corpus()) {
            tests.add(DynamicTest.dynamicTest(c.name(), () -> {
                Map<String, Object> result = runService.validate(
                        new ValidateRequest(project.toString(), c.puml(), c.sidecars(), model));

                Object error = result.get("error");
                Assumptions.assumeTrue(error == null,
                        "SKIP: validate transport failure, not a verdict: " + error);
                boolean refused = Boolean.TRUE.equals(result.get("refused"));

                System.out.println("[plugin-contract] " + (refused ? "REFUSED " : "accepted")
                        + " — " + c.name() + "  (" + c.rule() + ")");

                if (c.mustRefuse()) {
                    assertTrue(refused, () -> "the plugin no longer refuses this — the app's local "
                            + "copy of the rule is now stricter than the plugin, so the wizard "
                            + "would block a design the plugin would accept. Rule: " + c.rule()
                            + "\n" + result.get("message"));
                } else {
                    assertFalse(refused, () -> "the plugin now refuses a design DisC itself "
                            + "produces. This reaches users as a failed generation. Rule: "
                            + c.rule() + "\n" + result.get("message"));
                }
            }));
        }
        return tests;
    }
}
