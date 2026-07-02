package com.designiscode.app.service;

import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DerivedSlice.CallSite;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Stage A deterministic extraction — no model calls, inline source fixtures.
 * Proves we recover the call site `a → B`, B's interface/impl shape, the SUT
 * wiring, the external-input surface, and the config-loading anchor.
 */
class CallGraphDeriverTest {

    private final CallGraphDeriver deriver = new CallGraphDeriver();

    // --- shared fixture pieces ---

    private static final String ORDER = """
            package com.demo;
            public record Order(Money subtotal, String destination) {}
            """;
    private static final String MONEY = """
            package com.demo;
            public record Money(java.math.BigDecimal amount) {}
            """;
    private static final String RECEIPT = """
            package com.demo;
            public record Receipt(Order order, Money tax) {}
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
    private static final String ORDER_REPO = """
            package com.demo;
            public interface OrderRepository { void save(Order order); }
            """;

    private static CallSite siteOn(DerivedSlice slice, String receiver) {
        Optional<CallSite> cs = slice.callSites().stream()
                .filter(s -> receiver.equals(s.receiver())).findFirst();
        assertTrue(cs.isPresent(), "expected a call site on receiver '" + receiver + "'");
        return cs.get();
    }

    @Test
    void derivesInterfaceCallSiteWithImplsAndWiring() {
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

        assertEquals("CheckoutService", slice.sut());
        assertTrue(slice.orchestrator(), "calls a behavioral collaborator → orchestrator");

        // external-input anchor: the entry method exposes `order : Order`
        assertEquals("checkout", slice.entryMethod().name());
        assertTrue(slice.entryMethod().params().stream()
                        .anyMatch(p -> p.name().equals("order") && p.type().equals("Order")),
                "entry param order:Order is the request-discriminator candidate");

        // the variation point: taxCalculator.calculate(order)
        CallSite tax = siteOn(slice, "taxCalculator");
        assertEquals("TaxCalculator", tax.calleeType());
        assertEquals("interface", tax.calleeKind());
        assertEquals("calculate", tax.method());
        assertEquals(List.of("DomesticTax"), tax.calleeImpls());
        assertEquals(List.of("order"), tax.args());

        // wiring: both collaborators are constructor-injected
        assertTrue(slice.dependencies().stream().anyMatch(d ->
                d.name().equals("taxCalculator") && d.type().equals("TaxCalculator")
                        && d.injection().equals("constructor")));
        assertTrue(slice.dependencies().stream().anyMatch(d -> d.name().equals("orders")));

        // request-dynamic signal: nothing is bound at config-load time
        assertTrue(slice.configFacts().isEmpty(), "no config anchor → not deploy-static");

        // REGEN precondition: a straight-line body (calls + object construction, no
        // control flow, every receiver attributable) is captured completely
        assertTrue(slice.captureComplete(), () -> "expected complete capture; gaps: " + slice.captureGaps());
        // the result binding `Money tax = ...` gives the return-arrow label
        assertEquals("tax", tax.resultName());
        // the void collaborator call has no result binding
        assertNull(siteOn(slice, "orders").resultName());
    }

    @Test
    void flagsControlFlowAndSelfCallsAsCaptureGaps() {
        // a branch, a loop, and an unqualified self-call: none survive a flat, linear
        // call list — so the orchestrator must NOT be regenerated wholesale
        String checkout = """
                package com.demo;
                import java.util.List;
                public class CheckoutService {
                    private final TaxCalculator taxCalculator;
                    public CheckoutService(TaxCalculator taxCalculator) { this.taxCalculator = taxCalculator; }
                    public Money checkout(Order order, List<Order> more) {
                        if (order == null) { return audit(); }
                        for (Order o : more) { taxCalculator.calculate(o); }
                        return taxCalculator.calculate(order);
                    }
                    private Money audit() { return null; }
                }
                """;
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, checkout), "CheckoutService", "checkout");

        assertFalse(slice.captureComplete(), "control flow + self-call → not fully derivable");
        assertTrue(slice.captureGaps().stream().anyMatch(g -> g.contains("branch")), slice.captureGaps().toString());
        assertTrue(slice.captureGaps().stream().anyMatch(g -> g.contains("loop")), slice.captureGaps().toString());
        assertTrue(slice.captureGaps().stream().anyMatch(g -> g.contains("unattributable")), slice.captureGaps().toString());
    }

    @Test
    void flagsConcreteCalleeThatWouldNeedInterfaceExtraction() {
        // a → b where b's declared type is a concrete class, not an interface (DIP not yet applied)
        String checkout = """
                package com.demo;
                public class CheckoutService {
                    private final DomesticTax tax;
                    public CheckoutService(DomesticTax tax) { this.tax = tax; }
                    public Money checkout(Order order) { return tax.calculate(order); }
                }
                """;
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, checkout),
                "CheckoutService", "checkout");

        CallSite cs = siteOn(slice, "tax");
        assertEquals("DomesticTax", cs.calleeType());
        assertEquals("class", cs.calleeKind(),
                "concrete callee → Stage C must extract an interface (DIP)");
    }

    @Test
    void surfacesConfigLoadingAnchorForDeployStaticSelection() {
        String domesticConditional = """
                package com.demo;
                @ConditionalOnProperty(name = "tax.mode", havingValue = "domestic")
                public class DomesticTax implements TaxCalculator {
                    public Money calculate(Order order) { return order.subtotal(); }
                }
                """;
        String checkout = """
                package com.demo;
                public class CheckoutService {
                    private final TaxCalculator tax;
                    public CheckoutService(TaxCalculator tax) { this.tax = tax; }
                    public Money checkout(Order order) { return tax.calculate(order); }
                }
                """;
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, domesticConditional, checkout),
                "CheckoutService", "checkout");

        assertTrue(slice.configFacts().stream().anyMatch(f ->
                        f.type().equals("DomesticTax")
                                && f.kind().equals("conditional-on-property")
                                && f.detail().contains("tax.mode")),
                "an @ConditionalOnProperty impl is a deploy-static (bean) provenance signal");
    }

    @Test
    void leafEntryMethodIsNotAnOrchestrator() {
        // entry method only touches its data param (a record) — no behavioral collaborator calls
        String calc = """
                package com.demo;
                public class SubtotalCalculator {
                    public Money compute(Order order) { return order.subtotal(); }
                }
                """;
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, calc), "SubtotalCalculator", "compute");

        assertFalse(slice.orchestrator(), "calls only a record accessor → leaf, not orchestrator");
        assertTrue(slice.callSites().stream().noneMatch(cs -> "interface".equals(cs.calleeKind())));
    }

    @Test
    void throwsWhenEntryClassOrMethodIsMissing() {
        assertThrows(IllegalArgumentException.class,
                () -> deriver.derive(List.of(TAX_IFACE), "NoSuchClass", "x"));
        assertThrows(IllegalArgumentException.class,
                () -> deriver.derive(List.of(DOMESTIC_TAX), "DomesticTax", "noSuchMethod"));
    }

    @Test
    void capturesPackageFqnsAndCalleeSignatureForApply() {
        String checkout = """
                package com.demo;
                public class CheckoutService {
                    private final TaxCalculator taxCalculator;
                    public CheckoutService(TaxCalculator taxCalculator) { this.taxCalculator = taxCalculator; }
                    public Money checkout(Order order) { return taxCalculator.calculate(order); }
                }
                """;
        DerivedSlice slice = deriver.derive(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, checkout), "CheckoutService", "checkout");

        assertEquals("com.demo", slice.targetPackage());
        assertTrue(slice.knownTypes().stream().anyMatch(t ->
                t.name().equals("TaxCalculator") && t.fqn().equals("com.demo.TaxCalculator")
                        && t.kind().equals("interface")));

        // the variation point carries the callee's resolved signature, for Stage E emit
        CallSite vp = siteOn(slice, "taxCalculator");
        assertEquals("calculate", vp.calleeMethodSig().name());
        assertEquals("Money", vp.calleeMethodSig().returns());
        assertEquals("Order", vp.calleeMethodSig().params().get(0).type());
    }
}
