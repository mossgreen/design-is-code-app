package com.designiscode.app.service;

import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DesignResult;
import com.designiscode.app.dto.DiffResult;
import com.designiscode.app.dto.VariantRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** End-to-end pipeline (Stages A–E) + the disk apply, deterministic. */
class CodeDesignDiffServiceTest {

    private final CodeDesignDiffService pipeline = new CodeDesignDiffService(
            new CallGraphDeriver(), new BindingTimeClassifier(), new DesignDiffer(),
            new DesignDeltaEmitter(), new DesignService(),
            new SliceRenderer(), new DeltaRenderer(),
            new CounterfactualRenderer(), new WhyRenderer());

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
    private static final VariantRequest REQUEST = new VariantRequest("TaxCalculator", "InternationalTax",
            List.of(new DesignDelta.MappingRow("DOMESTIC", "DomesticTax"),
                    new DesignDelta.MappingRow("INTERNATIONAL", "InternationalTax")), null);

    @Test
    void runProducesValidArtifactsForRequestDynamic() {
        DiffResult r = pipeline.run(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, CHECKOUT),
                "CheckoutService", "checkout", "order.destination",
                "International orders should use the new tax calculator", REQUEST);

        assertEquals(DesignDelta.GENERATE, r.disposition());
        assertTrue(r.validationViolations().isEmpty(), () -> "violations: " + r.validationViolations());
        assertNotNull(r.artifacts());
        assertEquals(1, r.artifacts().sidecars().size());
    }

    @Test
    void runParksDeployStaticWithNoArtifacts() {
        DiffResult r = pipeline.run(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_CONDITIONAL, CHECKOUT),
                "CheckoutService", "checkout", "tax.mode", null, REQUEST);

        assertEquals(DesignDelta.PARK, r.disposition());
        assertNull(r.artifacts());
    }

    @Test
    void applyWritesPumlAndSidecarToDesignDir(@TempDir Path project) throws IOException {
        DiffResult r = pipeline.run(
                List.of(ORDER, MONEY, TAX_IFACE, DOMESTIC_TAX, CHECKOUT),
                "CheckoutService", "checkout", "order.destination", null, REQUEST);

        DesignResult saved = pipeline.apply(project.toString(), r.artifacts());

        Path puml = project.resolve("design/CheckoutService.puml");
        Path sidecar = project.resolve("design/TaxCalculatorResolver.decision.md");
        assertTrue(Files.exists(puml), "puml written");
        assertTrue(Files.exists(sidecar), "sidecar written");
        assertEquals(1, saved.decisionTableCount());
        assertTrue(Files.readString(puml).contains("<<@permits:DomesticTax,InternationalTax>>"));
        assertTrue(Files.readString(sidecar).contains("| INTERNATIONAL | InternationalTax |"));
    }
}
