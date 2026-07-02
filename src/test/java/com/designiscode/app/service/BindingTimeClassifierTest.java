package com.designiscode.app.service;

import com.designiscode.app.dto.BindingClassification;
import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DerivedSlice.CallSite;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Stage B classification, exercised end-to-end over real Stage-A derivations
 * (deterministic, no model calls). Covers each branch: request-dynamic,
 * deploy-static, runtime-global, the A/B trap, and the three ask-cases
 * (ambiguous, not-wired, code-vs-AC conflict).
 */
class BindingTimeClassifierTest {

    private final CallGraphDeriver deriver = new CallGraphDeriver();
    private final BindingTimeClassifier classifier = new BindingTimeClassifier();

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
    private static final String CHECKOUT = """
            package com.demo;
            public class CheckoutService {
                private final TaxCalculator taxCalculator;
                public CheckoutService(TaxCalculator taxCalculator) { this.taxCalculator = taxCalculator; }
                public Money checkout(Order order) { return taxCalculator.calculate(order); }
            }
            """;

    /** Slice with a clean request anchor and no config. */
    private DerivedSlice requestSlice() {
        return deriver.derive(List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, CHECKOUT),
                "CheckoutService", "checkout");
    }

    /** Slice whose impl is selected by @ConditionalOnProperty → a config anchor. */
    private DerivedSlice configSlice() {
        return deriver.derive(List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_CONDITIONAL, CHECKOUT),
                "CheckoutService", "checkout");
    }

    @Test
    void requestDynamicWhenDiscriminatorRootsInRequestInput() {
        DerivedSlice slice = requestSlice();
        BindingClassification bc = classifier.classify(slice, "order.destination",
                "International orders should use the new tax calculator");

        assertEquals(BindingTimeClassifier.SRC_REQUEST, bc.discriminatorSource());
        assertEquals(BindingTimeClassifier.BT_REQUEST_DYNAMIC, bc.bindingTime());
        assertFalse(bc.needsQuestion());

        // bare param name resolves too
        assertEquals(BindingTimeClassifier.BT_REQUEST_DYNAMIC,
                classifier.classify(slice, "order").bindingTime());
    }

    @Test
    void deployStaticWhenDiscriminatorRootsInConfigProperty() {
        BindingClassification bc = classifier.classify(configSlice(), "tax.mode");

        assertEquals(BindingTimeClassifier.SRC_ENVIRONMENT, bc.discriminatorSource());
        assertEquals(BindingTimeClassifier.BT_DEPLOY_STATIC, bc.bindingTime());
        assertFalse(bc.needsQuestion());
        // safety property: a config-bound choice is NOT misread as request-dynamic
        assertFalse(BindingTimeClassifier.BT_REQUEST_DYNAMIC.equals(bc.bindingTime()));
    }

    @Test
    void abTestTrapForcesRequestDynamicOverConfigShape() {
        // discriminator roots in config, but the AC says it's an A/B experiment per user
        BindingClassification bc = classifier.classify(configSlice(), "tax.mode",
                "We A/B test the new tax calc, placing each user in a cohort");

        assertEquals(BindingTimeClassifier.SRC_REQUEST, bc.discriminatorSource());
        assertEquals(BindingTimeClassifier.BT_REQUEST_DYNAMIC, bc.bindingTime());
        assertFalse(bc.needsQuestion());
    }

    @Test
    void runtimeGlobalWhenConfigPlusOpsFlagSignal() {
        BindingClassification bc = classifier.classify(configSlice(), "tax.mode",
                "Add a kill switch to disable the new calc under load");

        assertEquals(BindingTimeClassifier.SRC_FLAG, bc.discriminatorSource());
        assertEquals(BindingTimeClassifier.BT_RUNTIME_GLOBAL, bc.bindingTime());
        assertFalse(bc.needsQuestion());
    }

    @Test
    void asksWhenDiscriminatorMatchesBothAnchors() {
        // entry param `mode` AND a @Value("${tax.mode}") field named `mode` → ambiguous
        String featureSvc = """
                package com.demo;
                public class FeatureService {
                    @Value("${tax.mode}") String mode;
                    public Money run(String mode) { return null; }
                }
                """;
        DerivedSlice slice = deriver.derive(List.of(MONEY, featureSvc), "FeatureService", "run");

        BindingClassification bc = classifier.classify(slice, "mode");
        assertTrue(bc.needsQuestion());
        assertEquals(BindingTimeClassifier.SRC_UNRESOLVED, bc.discriminatorSource());
        assertNotNull(bc.question());
        assertTrue(bc.question().contains("mode"));
    }

    @Test
    void asksWhenDiscriminatorIsNotWired() {
        DerivedSlice slice = requestSlice();
        // a concept that resolves to neither a param nor a config property
        assertTrue(classifier.classify(slice, "region").needsQuestion());
        // a bare member name (not rooted at a known param) is also inconclusive
        assertTrue(classifier.classify(slice, "destination").needsQuestion());
    }

    @Test
    void asksWhenCodeSaysRequestButAcSaysDeployment() {
        // grill mitigation: the config origin may live outside the provided files
        DerivedSlice slice = requestSlice();
        BindingClassification bc = classifier.classify(slice, "order",
                "Enable the new tax calc for the EU deployment rollout");

        assertTrue(bc.needsQuestion(), "code-vs-AC conflict must not be silently resolved");
    }

    @Test
    void locatesVariationPointByCalleeType() {
        Optional<CallSite> vp = BindingTimeClassifier.locate(requestSlice(), "TaxCalculator");
        assertTrue(vp.isPresent());
        assertEquals("calculate", vp.get().method());
    }
}
