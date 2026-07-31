package com.designiscode.app.service;

import com.designiscode.app.dto.BindingClassification;
import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DesignDelta.Change;
import com.designiscode.app.dto.DesignDelta.MappingRow;
import com.designiscode.app.dto.VariantRequest;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Stage C, exercised over real Stage-A/B output (deterministic, no model calls).
 * Proves the resolver delta is minimal and leaves are sacred, that DIP kicks in
 * for a concrete callee, and that non-request-dynamic verdicts are parked.
 */
class DesignDifferTest {

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
    private static final String DOMESTIC_CONDITIONAL = """
            package com.demo;
            @ConditionalOnProperty(name = "tax.mode", havingValue = "domestic")
            public class DomesticTax implements TaxCalculator {
                public Money calculate(Order order) { return order.subtotal(); }
            }
            """;
    private static final String CHECKOUT_IFACE = """
            package com.demo;
            public class CheckoutService {
                private final TaxCalculator taxCalculator;
                public CheckoutService(TaxCalculator taxCalculator) { this.taxCalculator = taxCalculator; }
                public Money checkout(Order order) { return taxCalculator.calculate(order); }
            }
            """;
    private static final String CHECKOUT_CONCRETE = """
            package com.demo;
            public class CheckoutService {
                private final DomesticTax tax;
                public CheckoutService(DomesticTax tax) { this.tax = tax; }
                public Money checkout(Order order) { return tax.calculate(order); }
            }
            """;

    private static final List<MappingRow> MAPPING = List.of(
            new MappingRow("DOMESTIC", "DomesticTax"),
            new MappingRow("INTERNATIONAL", "InternationalTax"));

    private static Change change(DesignDelta d, String name) {
        return d.changes().stream().filter(c -> name.equals(c.name())).findFirst().orElseThrow();
    }

    @Test
    void generatesMinimalResolverDeltaForRequestDynamicInterfaceCase() {
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, CHECKOUT_IFACE), "CheckoutService", "checkout");
        BindingClassification bc = classifier.classify(slice, "order.destination",
                "International orders should use the new tax calculator");
        VariantRequest req = new VariantRequest("TaxCalculator", "InternationalTax", MAPPING, null);

        DesignDelta d = differ.diff(slice, bc, req);

        assertEquals(DesignDelta.GENERATE, d.disposition());
        assertEquals("TaxCalculator", d.strategyInterface());
        assertEquals("TaxCalculatorResolver", d.resolver());
        assertEquals(List.of("DomesticTax", "InternationalTax"), d.permits());
        assertEquals(BindingTimeClassifier.BT_REQUEST_DYNAMIC, d.bindingTime());
        // single-dispatch body was fully captured → orchestrator regenerated wholesale
        assertEquals(DesignDelta.SUT_REGEN, d.sutMode());

        // leaves sacred: existing impl reused; new variant added; SUT rewired (not recreated)
        assertEquals("reuse", change(d, "DomesticTax").op());
        assertEquals("add", change(d, "InternationalTax").op());
        assertEquals("modify", change(d, "CheckoutService").op());

        DesignDeltaValidator.Report r = DesignDeltaValidator.validate(slice, req, d);
        assertTrue(r.ok(), () -> "expected a minimal, valid delta; violations: " + r.violations());
    }

    @Test
    void oneRowMappingWithExistingBehaviorAsksForTotality() {
        // Code already has DomesticTax, but the ticket maps only the new key —
        // the family is real, the TABLE is incomplete. Never generate; ask for
        // the missing row(s), citing the code evidence.
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, CHECKOUT_IFACE), "CheckoutService", "checkout");
        BindingClassification bc = classifier.classify(slice, "order.destination", null);
        VariantRequest req = new VariantRequest("TaxCalculator", "InternationalTax",
                List.of(new MappingRow("INTERNATIONAL", "InternationalTax")), null);

        DesignDelta d = differ.diff(slice, bc, req);

        assertEquals(DesignDelta.ASK, d.disposition());
        assertTrue(d.reason().contains("missing mapping row"), d.reason());
        assertTrue(d.reason().contains("DomesticTax"), d.reason());
    }

    @Test
    void oneRowMappingWithNoKnownVariantsAsksAdditiveOrMissingSources() {
        // No implementation of the interface anywhere in the sources: a
        // single-variant "family" has nothing to choose — either the ticket is
        // additive (plain call now; family arrives with the second variant's
        // ticket via REGEN) or the sources are incomplete. Never generate.
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, CHECKOUT_IFACE), "CheckoutService", "checkout");
        BindingClassification bc = classifier.classify(slice, "order.destination", null);
        VariantRequest req = new VariantRequest("TaxCalculator", "InternationalTax",
                List.of(new MappingRow("INTERNATIONAL", "InternationalTax")), null);

        DesignDelta d = differ.diff(slice, bc, req);

        assertEquals(DesignDelta.ASK, d.disposition());
        assertTrue(d.reason().contains("single-variant family"), d.reason());
        assertTrue(d.reason().contains("additive"), d.reason());
        assertTrue(d.reason().contains("missing from the provided sources"), d.reason());
    }

    @Test
    void fallsBackToAddOnlyUpdateWhenBodyNotFullyCaptured() {
        // a branch in the entry body → Stage A can't fully represent the flow → no regen
        String branching = """
                package com.demo;
                public class CheckoutService {
                    private final TaxCalculator taxCalculator;
                    public CheckoutService(TaxCalculator taxCalculator) { this.taxCalculator = taxCalculator; }
                    public Money checkout(Order order) {
                        if (order == null) { return null; }
                        return taxCalculator.calculate(order);
                    }
                }
                """;
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, branching), "CheckoutService", "checkout");
        BindingClassification bc = classifier.classify(slice, "order.destination", null);
        VariantRequest req = new VariantRequest("TaxCalculator", "InternationalTax", MAPPING, null);

        DesignDelta d = differ.diff(slice, bc, req);

        assertEquals(DesignDelta.GENERATE, d.disposition());  // still a valid, minimal delta
        assertEquals(DesignDelta.SUT_UPDATE, d.sutMode(), "incomplete capture must not regen");
        assertTrue(d.changes().stream().anyMatch(c -> "note".equals(c.op())
                && c.detail().contains("by hand")), "reviewer told to wire the resolver manually");

        // the delta is well-formed, but a non-blocking warning flags the manual step
        DesignDeltaValidator.Report r = DesignDeltaValidator.validate(slice, req, d);
        assertTrue(r.ok(), () -> "add-only fallback is still valid; violations: " + r.violations());
        assertTrue(r.warnings().stream().anyMatch(wn -> wn.contains("add-only UPDATE")),
                () -> "expected a manual-wiring warning; got: " + r.warnings());
    }

    @Test
    void extractsInterfaceForConcreteCalleeDIP() {
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, CHECKOUT_CONCRETE), "CheckoutService", "checkout");
        BindingClassification bc = classifier.classify(slice, "order.destination", null);
        VariantRequest req = new VariantRequest("DomesticTax", "InternationalTax", MAPPING, "TaxCalculator");

        DesignDelta d = differ.diff(slice, bc, req);

        assertEquals(DesignDelta.GENERATE, d.disposition());
        assertEquals("TaxCalculator", d.strategyInterface());
        assertEquals("extract-interface", change(d, "DomesticTax").op());
        assertEquals("add", change(d, "TaxCalculator").op());
        assertEquals(List.of("DomesticTax", "InternationalTax"), d.permits());

        DesignDeltaValidator.Report r = DesignDeltaValidator.validate(slice, req, d);
        assertTrue(r.ok(), () -> "DIP delta should be valid; violations: " + r.violations());
    }

    @Test
    void asksWhenConcreteCalleeHasNoAbstractionNamed() {
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, CHECKOUT_CONCRETE), "CheckoutService", "checkout");
        BindingClassification bc = classifier.classify(slice, "order.destination", null);
        VariantRequest req = new VariantRequest("DomesticTax", "InternationalTax", MAPPING, null);

        DesignDelta d = differ.diff(slice, bc, req);
        assertEquals(DesignDelta.ASK, d.disposition());
        assertTrue(d.reason().toLowerCase().contains("concrete"));
        assertTrue(DesignDeltaValidator.validate(slice, req, d).ok());
    }

    @Test
    void parksDeployStaticInsteadOfForcingAResolver() {
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_CONDITIONAL, CHECKOUT_IFACE), "CheckoutService", "checkout");
        BindingClassification bc = classifier.classify(slice, "tax.mode");  // → deploy-static
        VariantRequest req = new VariantRequest("TaxCalculator", "InternationalTax", MAPPING, null);

        DesignDelta d = differ.diff(slice, bc, req);
        assertEquals(DesignDelta.PARK, d.disposition());
        assertTrue(d.reason().contains("deploy-static"));
        assertEquals(null, d.resolver());  // safety: no resolver forced onto a deploy-time choice
        assertTrue(DesignDeltaValidator.validate(slice, req, d).ok());
    }

    @Test
    void parksRuntimeGlobal() {
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_CONDITIONAL, CHECKOUT_IFACE), "CheckoutService", "checkout");
        BindingClassification bc = classifier.classify(slice, "tax.mode",
                "Add a kill switch to disable the new calc under load");  // → runtime-global
        VariantRequest req = new VariantRequest("TaxCalculator", "InternationalTax", MAPPING, null);

        DesignDelta d = differ.diff(slice, bc, req);
        assertEquals(DesignDelta.PARK, d.disposition());
        assertTrue(d.reason().contains("runtime-global"));
    }

    @Test
    void passesThroughAskWhenClassificationNeedsQuestion() {
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, CHECKOUT_IFACE), "CheckoutService", "checkout");
        BindingClassification bc = classifier.classify(slice, "region");  // not wired → needsQuestion
        VariantRequest req = new VariantRequest("TaxCalculator", "InternationalTax", MAPPING, null);

        DesignDelta d = differ.diff(slice, bc, req);
        assertEquals(DesignDelta.ASK, d.disposition());
        assertEquals(bc.question(), d.reason());
    }

    @Test
    void validatorCatchesADeltaThatTouchesAnExistingLeaf() {
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, CHECKOUT_IFACE), "CheckoutService", "checkout");
        BindingClassification bc = classifier.classify(slice, "order.destination", null);
        VariantRequest req = new VariantRequest("TaxCalculator", "InternationalTax", MAPPING, null);
        DesignDelta good = differ.diff(slice, bc, req);

        // tamper: hand-edit the existing leaf instead of reusing it
        List<Change> tampered = good.changes().stream()
                .map(ch -> "DomesticTax".equals(ch.name())
                        ? new Change("modify", ch.element(), ch.name(), "hand-edited leaf body")
                        : ch)
                .toList();
        DesignDelta broken = new DesignDelta(good.disposition(), good.reason(), good.strategyInterface(),
                good.resolver(), good.permits(), good.mapping(), good.bindingTime(), good.discriminator(), good.sutMode(), tampered);

        DesignDeltaValidator.Report r = DesignDeltaValidator.validate(slice, req, broken);
        assertFalse(r.ok(), "validator must reject a delta that modifies an existing leaf");
        assertTrue(r.violations().stream().anyMatch(s -> s.contains("sacred")));
    }
}
