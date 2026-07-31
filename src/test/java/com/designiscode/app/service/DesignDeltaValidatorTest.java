package com.designiscode.app.service;

import com.designiscode.app.dto.BindingClassification;
import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DesignDelta.Change;
import com.designiscode.app.dto.DesignDelta.MappingRow;
import com.designiscode.app.dto.VariantRequest;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Stage D — the gate that decides whether a delta may be applied at all. It had
 * no direct tests; it was only ever exercised incidentally through the pipeline,
 * which means its refusals were asserted by nobody.
 *
 * <p>This matters more than most gates because one of its rules is the only thing
 * standing between DisC and destroying code: {@code sutMode = regen} overwrites
 * an orchestrator <b>wholesale</b>, so if Stage A did not capture the whole body,
 * regeneration silently deletes whatever it could not see. That refusal is tested
 * first.
 *
 * <p>Method: derive a <i>real</i> slice and a <i>real</i> delta, assert the honest
 * pipeline output passes (precision — a gate that fires on correct input is
 * unusable), then mutate exactly one field per test to trip exactly one rule.
 * Hand-built DTOs would prove the rule fires on inputs the pipeline never
 * produces.
 */
class DesignDeltaValidatorTest {

    private final CallGraphDeriver deriver = new CallGraphDeriver();
    private final BindingTimeClassifier classifier = new BindingTimeClassifier();
    private final DesignDiffer differ = new DesignDiffer();

    private static final String ORDER = """
            package com.demo;
            public record Order(Money subtotal, String destination) {}
            """;
    private static final String MONEY = """
            package com.demo;
            public record Money(java.math.BigDecimal amount) {}
            """;
    private static final String TAX_IFACE = """
            package com.demo;
            public interface TaxCalculator { Money calculate(Order order); }
            """;
    private static final String DOMESTIC_TAX = """
            package com.demo;
            public class DomesticTax implements TaxCalculator {
                public Money calculate(Order order) { return order.subtotal(); }
            }
            """;
    private static final String CHECKOUT = """
            package com.demo;
            public class CheckoutService {
                private final TaxCalculator taxCalculator;
                public CheckoutService(TaxCalculator taxCalculator) { this.taxCalculator = taxCalculator; }
                public Money checkout(Order order) { return taxCalculator.calculate(order); }
            }
            """;

    /** A body Stage A cannot fully capture — a lambda hides call sites from the lexical walk. */
    private static final String CHECKOUT_WITH_GAP = """
            package com.demo;
            public class CheckoutService {
                private final TaxCalculator taxCalculator;
                public CheckoutService(TaxCalculator taxCalculator) { this.taxCalculator = taxCalculator; }
                public Money checkout(Order order) {
                    return java.util.Optional.of(order)
                        .map(o -> taxCalculator.calculate(o))
                        .orElseThrow();
                }
            }
            """;

    private static final List<MappingRow> MAPPING = List.of(
            new MappingRow("DOMESTIC", "DomesticTax"),
            new MappingRow("INTERNATIONAL", "InternationalTax"));

    private static final VariantRequest REQ =
            new VariantRequest("TaxCalculator", "InternationalTax", MAPPING, null);

    private record Case(DerivedSlice slice, DesignDelta delta) {}

    private Case honest(String sut) {
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, sut), "CheckoutService", "checkout");
        BindingClassification bc = classifier.classify(slice, "order.destination",
                "International orders should use the new tax calculator");
        return new Case(slice, differ.diff(slice, bc, REQ));
    }

    private static DesignDeltaValidator.Report check(Case c, DesignDelta d) {
        return DesignDeltaValidator.validate(c.slice(), REQ, d);
    }

    private static String all(DesignDeltaValidator.Report r) {
        return r.violations() + " / warnings=" + r.warnings();
    }

    // --- precision: the honest pipeline output must pass -------------------------

    /**
     * The half that decides adoptability. A gate that refuses what the pipeline
     * itself produces is one people route around, and DisC has already shipped a
     * false refusal once (plugin v0.11.1).
     */
    @Test
    void theDeltaThePipelineActuallyProducesIsAccepted() {
        Case c = honest(CHECKOUT);
        DesignDeltaValidator.Report r = check(c, c.delta());
        assertTrue(r.ok(), () -> "Stage C's own output was refused by Stage D: " + all(r));
        assertTrue(r.warnings().isEmpty(),
                () -> "a fully-captured body should not warn: " + r.warnings());
    }

    // --- the safety-critical rule ----------------------------------------------

    /**
     * The rule that prevents data loss. {@code regen} overwrites the orchestrator
     * wholesale; if the body was not fully captured, everything Stage A missed is
     * deleted. The pipeline downgrades to add-only UPDATE by itself — this asserts
     * the gate still refuses if anything ever hands it {@code regen} anyway.
     */
    @Test
    void regenIsRefusedWhenTheBodyWasNotFullyCaptured() {
        Case c = honest(CHECKOUT_WITH_GAP);
        assertFalse(c.slice().captureComplete(),
                "fixture must have capture gaps or this test proves nothing");

        DesignDeltaValidator.Report r = check(c, withSutMode(c.delta(), DesignDelta.SUT_REGEN));

        assertFalse(r.ok(), "a wholesale overwrite of a partially-captured body must be refused");
        assertTrue(r.violations().toString().contains("complete Stage A capture"),
                () -> "the refusal must name the reason: " + r.violations());
    }

    /** The honest fallback is allowed, but must say out loud that a human has wiring to do. */
    @Test
    void theAddOnlyFallbackIsAllowedButWarns() {
        Case c = honest(CHECKOUT_WITH_GAP);
        DesignDeltaValidator.Report r = check(c, c.delta());

        assertTrue(r.ok(), () -> "add-only UPDATE is a legitimate outcome: " + all(r));
        assertTrue(r.warnings().toString().contains("by hand"),
                () -> "the reviewer must be told the resolver call needs manual wiring: " + r.warnings());
    }

    // --- minimality and leaves-sacred ------------------------------------------

    /** Leaves are sacred: an existing strategy may be reused, never rewritten. */
    @Test
    void rewritingAnExistingVariantIsRefused() {
        Case c = honest(CHECKOUT);
        List<Change> tampered = new ArrayList<>(c.delta().changes());
        tampered.replaceAll(ch -> "DomesticTax".equals(ch.name())
                ? new Change("modify", ch.element(), ch.name(), ch.detail()) : ch);

        DesignDeltaValidator.Report r = check(c, withChanges(c.delta(), tampered));

        assertFalse(r.ok(), "modifying an existing leaf must be refused");
        assertTrue(r.violations().toString().contains("leaves are sacred"),
                () -> r.violations().toString());
    }

    /** The SUT already exists; adding it would mean generating over a real file. */
    @Test
    void addingTheSutIsRefused() {
        Case c = honest(CHECKOUT);
        List<Change> tampered = new ArrayList<>(c.delta().changes());
        tampered.replaceAll(ch -> "CheckoutService".equals(ch.name())
                ? new Change("add", ch.element(), ch.name(), ch.detail()) : ch);

        DesignDeltaValidator.Report r = check(c, withChanges(c.delta(), tampered));

        assertFalse(r.ok(), "the SUT must never be added");
        assertTrue(r.violations().toString().contains("must not be added"),
                () -> r.violations().toString());
    }

    /** Permits must be exactly the existing implementations plus the new variant — no more. */
    @Test
    void aPermitSetWithAnInventedStrategyIsRefused() {
        Case c = honest(CHECKOUT);
        List<String> tampered = new ArrayList<>(c.delta().permits());
        tampered.add("StrategyNobodyAskedFor");

        DesignDeltaValidator.Report r = check(c, withPermits(c.delta(), tampered));

        assertFalse(r.ok(), "an extra permit is not minimal");
        assertTrue(r.violations().toString().contains("permits"), () -> r.violations().toString());
    }

    /** A resolver that maps no key to a declared strategy leaves that strategy unreachable. */
    @Test
    void aMappingThatDoesNotCoverEveryPermitIsRefused() {
        Case c = honest(CHECKOUT);
        DesignDeltaValidator.Report r = check(c,
                withMapping(c.delta(), List.of(new MappingRow("DOMESTIC", "DomesticTax"))));

        assertFalse(r.ok(), "a permit no key resolves to can never be selected");
        assertTrue(r.violations().toString().contains("do not cover permits"),
                () -> r.violations().toString());
    }

    /** A blank discriminator key would generate a resolver row matching nothing. */
    @Test
    void aBlankMappingKeyIsRefused() {
        Case c = honest(CHECKOUT);
        DesignDeltaValidator.Report r = check(c, withMapping(c.delta(),
                List.of(new MappingRow("", "DomesticTax"),
                        new MappingRow("INTERNATIONAL", "InternationalTax"))));

        assertFalse(r.ok(), "a blank key is not a discriminator value");
        assertTrue(r.violations().toString().contains("blank key"), () -> r.violations().toString());
    }

    // --- park / ask hygiene -----------------------------------------------------

    /**
     * A parked delta is a refusal to design, so it owes the reviewer a reason and
     * must not smuggle generative payload past the gate.
     */
    @Test
    void aParkedDeltaNeedsAReasonAndCarriesNoPayload() {
        Case c = honest(CHECKOUT);

        DesignDeltaValidator.Report noReason = check(c, new DesignDelta(
                DesignDelta.PARK, "  ", null, null, List.of(), List.of(), null, null, null, List.of()));
        assertFalse(noReason.ok(), "park without a reason tells the reviewer nothing");
        assertTrue(noReason.violations().toString().contains("must carry a reason"),
                () -> noReason.violations().toString());

        DesignDeltaValidator.Report smuggled = check(c, new DesignDelta(
                DesignDelta.PARK, "binding time unclear", "TaxCalculator", "TaxCalculatorResolver",
                List.of("DomesticTax"), MAPPING, null, null, null,
                List.of(new Change("add", "entity", "InternationalTax", null))));
        assertFalse(smuggled.ok(), "a parked delta must not carry changes to apply");
        assertTrue(smuggled.violations().toString().contains("must not carry generative changes"),
                () -> smuggled.violations().toString());
    }

    /** Phase 1 generates only request-dynamic variance; anything else is out of scope, not silently built. */
    @Test
    void aNonRequestDynamicBindingTimeIsRefusedForGeneration() {
        Case c = honest(CHECKOUT);
        DesignDeltaValidator.Report r = check(c,
                withBindingTime(c.delta(), BindingTimeClassifier.BT_DEPLOY_STATIC));

        assertFalse(r.ok(), "deploy-static variance is not Phase-1 generatable");
        assertTrue(r.violations().toString().contains("request-dynamic"),
                () -> r.violations().toString());
    }

    // --- minimal field-level withers (records have no copy syntax) --------------

    private static DesignDelta withSutMode(DesignDelta d, String sutMode) {
        return new DesignDelta(d.disposition(), d.reason(), d.strategyInterface(), d.resolver(),
                d.permits(), d.mapping(), d.bindingTime(), d.discriminator(), sutMode, d.changes());
    }

    private static DesignDelta withChanges(DesignDelta d, List<Change> changes) {
        return new DesignDelta(d.disposition(), d.reason(), d.strategyInterface(), d.resolver(),
                d.permits(), d.mapping(), d.bindingTime(), d.discriminator(), d.sutMode(), changes);
    }

    private static DesignDelta withPermits(DesignDelta d, List<String> permits) {
        return new DesignDelta(d.disposition(), d.reason(), d.strategyInterface(), d.resolver(),
                permits, d.mapping(), d.bindingTime(), d.discriminator(), d.sutMode(), d.changes());
    }

    private static DesignDelta withMapping(DesignDelta d, List<MappingRow> mapping) {
        return new DesignDelta(d.disposition(), d.reason(), d.strategyInterface(), d.resolver(),
                d.permits(), mapping, d.bindingTime(), d.discriminator(), d.sutMode(), d.changes());
    }

    private static DesignDelta withBindingTime(DesignDelta d, String bindingTime) {
        return new DesignDelta(d.disposition(), d.reason(), d.strategyInterface(), d.resolver(),
                d.permits(), d.mapping(), bindingTime, d.discriminator(), d.sutMode(), d.changes());
    }
}
