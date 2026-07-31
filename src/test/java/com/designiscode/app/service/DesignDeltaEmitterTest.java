package com.designiscode.app.service;

import com.designiscode.app.dto.ApplyArtifacts;
import com.designiscode.app.dto.BindingClassification;
import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DesignDelta.MappingRow;
import com.designiscode.app.dto.VariantRequest;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Stage E emission, over the real Stage A→B→C pipeline. Asserts the resolver
 * sidecar matches the plugin's expected format and the .puml carries the right
 * CREATE/REUSE stereotypes (leaves sacred).
 */
class DesignDeltaEmitterTest {

    private final CallGraphDeriver deriver = new CallGraphDeriver();
    private final BindingTimeClassifier classifier = new BindingTimeClassifier();
    private final DesignDiffer differ = new DesignDiffer();
    private final DesignDeltaEmitter emitter = new DesignDeltaEmitter();

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
    private static final String RECEIPT = """
            package com.demo;
            public record Receipt(Order order, Money tax) {}
            """;
    private static final String ORDER_REPO = """
            package com.demo;
            public interface OrderRepository { void save(Order order); }
            """;
    private static final List<MappingRow> MAPPING = List.of(
            new MappingRow("DOMESTIC", "DomesticTax"),
            new MappingRow("INTERNATIONAL", "InternationalTax"));

    private ApplyArtifacts emitInterfaceCase() {
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, CHECKOUT_IFACE), "CheckoutService", "checkout");
        BindingClassification bc = classifier.classify(slice, "order.destination", null);
        DesignDelta d = differ.diff(slice, bc, new VariantRequest("TaxCalculator", "InternationalTax", MAPPING, null));
        return emitter.emit(slice, d);
    }

    @Test
    void emitsResolverSidecarInPluginFormat() {
        ApplyArtifacts a = emitInterfaceCase();
        assertEquals(1, a.sidecars().size());
        assertEquals("TaxCalculatorResolver.decision.md", a.sidecars().get(0).fileName());

        String s = a.sidecars().get(0).content();
        assertTrue(s.contains("target: TaxCalculatorResolver.resolve"), s);
        assertTrue(s.contains("output: TaxCalculator"), s);
        assertTrue(s.contains("package: com.demo"), s);
        assertTrue(s.contains("| destination | expected |"), s);
        assertTrue(s.contains("| DOMESTIC | DomesticTax |"), s);
        assertTrue(s.contains("| INTERNATIONAL | InternationalTax |"), s);
    }

    @Test
    void emitsPumlWithPermitManifestReuseAndNewVariant() {
        ApplyArtifacts a = emitInterfaceCase();
        String puml = a.puml();

        assertEquals("CheckoutService.puml", a.pumlFileName());
        assertTrue(puml.contains("' @package com.demo"), puml);
        // strategy interface declares the full permit family + the strategy method
        assertTrue(puml.contains("class TaxCalculator <<interface>> <<@permits:DomesticTax,InternationalTax>>"), puml);
        assertTrue(puml.contains("+ calculate(order: Order): Money"), puml);
        // existing variant REUSE (sacred); new variant CREATE
        assertTrue(puml.contains("class DomesticTax <<@class:com.demo.DomesticTax>>"), puml);
        assertTrue(puml.contains("class InternationalTax <<class>>"), puml);
        // reused domain types resolve
        assertTrue(puml.contains("class Order <<@class:com.demo.Order>>"), puml);
        // resolver participant + linear dispatch (no branch at the orchestrator)
        assertTrue(puml.contains("participant TaxCalculatorResolver"), puml);
        assertTrue(puml.contains("CheckoutService -> TaxCalculatorResolver : resolve(order.destination)"), puml);
        assertTrue(puml.contains("TaxCalculatorResolver --> CheckoutService : strategy : TaxCalculator"), puml);
        assertTrue(puml.contains("CheckoutService -> TaxCalculator : calculate(order)"), puml);
        // single-dispatch body fully captured → orchestrator regenerated wholesale, typed return
        assertTrue(puml.contains("participant CheckoutService <<@regen:com.demo.CheckoutService>>"), puml);
        assertTrue(puml.contains("CheckoutService --> [*] : result : Money"), puml);
    }

    @Test
    void regenReproducesTheFullFlowSoOtherCollaboratorsSurvive() {
        // the orchestrator also calls orders.save(order); a wholesale overwrite must
        // preserve it, so it appears as a REUSE participant AND an ordered arrow
        String checkout = """
                package com.demo;
                public class CheckoutService {
                    private final TaxCalculator taxCalculator;
                    private final OrderRepository orders;
                    public CheckoutService(TaxCalculator taxCalculator, OrderRepository orders) {
                        this.taxCalculator = taxCalculator;
                        this.orders = orders;
                    }
                    public Receipt checkout(Order order) {
                        Money tax = taxCalculator.calculate(order);
                        orders.save(order);
                        return new Receipt(order, tax);
                    }
                }
                """;
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, RECEIPT, TAX_IFACE, DOMESTIC_TAX, ORDER_REPO, checkout),
                "CheckoutService", "checkout");
        BindingClassification bc = classifier.classify(slice, "order.destination", null);
        DesignDelta d = differ.diff(slice, bc, new VariantRequest("TaxCalculator", "InternationalTax", MAPPING, null));
        assertEquals(DesignDelta.SUT_REGEN, d.sutMode());

        String puml = emitter.emit(slice, d).puml();
        assertTrue(puml.contains("participant CheckoutService <<@regen:com.demo.CheckoutService>>"), puml);
        // the non-variance collaborator is preserved: declared REUSE + its call arrow, in order
        assertTrue(puml.contains("participant OrderRepository <<@class:com.demo.OrderRepository>>"), puml);
        assertTrue(puml.contains("CheckoutService -> OrderRepository : save(order)"), puml);
        // the variation-point call keeps its typed return (Money tax = ...)
        assertTrue(puml.contains("CheckoutService <-- TaxCalculator : tax : Money"), puml);
        assertTrue(puml.contains("CheckoutService --> [*] : result : Receipt"), puml);
    }

    @Test
    void incompleteCaptureEmitsBareParticipantNotRegen() {
        // a branch in the body → add-only UPDATE: no @regen stereotype, body left to a human
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
        DesignDelta d = differ.diff(slice, bc, new VariantRequest("TaxCalculator", "InternationalTax", MAPPING, null));
        assertEquals(DesignDelta.SUT_UPDATE, d.sutMode());

        String puml = emitter.emit(slice, d).puml();
        assertTrue(puml.contains("participant CheckoutService\n"), puml);
        assertFalse(puml.contains("<<@regen"), "must not regenerate an under-captured body: " + puml);
        // the resolver rewrite is still specified so the plugin regenerates the test
        assertTrue(puml.contains("CheckoutService -> TaxCalculatorResolver : resolve(order.destination)"), puml);
    }

    @Test
    void dipCaseEmitsExtractedInterfaceAndReusesConcrete() {
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, CHECKOUT_CONCRETE), "CheckoutService", "checkout");
        BindingClassification bc = classifier.classify(slice, "order.destination", null);
        DesignDelta d = differ.diff(slice, bc, new VariantRequest("DomesticTax", "InternationalTax", MAPPING, "TaxCalculator"));
        String puml = emitter.emit(slice, d).puml();

        assertTrue(puml.contains("class TaxCalculator <<interface>> <<@permits:DomesticTax,InternationalTax>>"), puml);
        assertTrue(puml.contains("class DomesticTax <<@class:com.demo.DomesticTax>>"), puml);  // concrete reused as a permit
        assertTrue(puml.contains("class InternationalTax <<class>>"), puml);
    }

    @Test
    void rejectsNonGenerateDelta() {
        DesignDelta parked = new DesignDelta(DesignDelta.PARK, "deploy-static", null, null,
                List.of(), List.of(), null, null, null, List.of());
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, CHECKOUT_IFACE), "CheckoutService", "checkout");
        assertThrows(IllegalArgumentException.class, () -> emitter.emit(slice, parked));
    }
}
