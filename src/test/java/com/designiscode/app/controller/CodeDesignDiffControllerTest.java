package com.designiscode.app.controller;

import com.designiscode.app.dto.CodeDiffRequest;
import com.designiscode.app.dto.DeriveResult;
import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DiffResult;
import com.designiscode.app.dto.VariantRequest;
import com.designiscode.app.service.BindingTimeClassifier;
import com.designiscode.app.service.CallGraphDeriver;
import com.designiscode.app.service.CodeDesignDiffService;
import com.designiscode.app.service.DeltaRenderer;
import com.designiscode.app.service.DesignDeltaEmitter;
import com.designiscode.app.service.DesignDiffer;
import com.designiscode.app.service.DesignService;
import com.designiscode.app.service.SliceRenderer;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Controller wiring + error handling (no HTTP/Spring context needed). */
class CodeDesignDiffControllerTest {

    private final CodeDesignDiffController controller = new CodeDesignDiffController(
            new CodeDesignDiffService(new CallGraphDeriver(), new BindingTimeClassifier(),
                    new DesignDiffer(), new DesignDeltaEmitter(), new DesignService(),
                    new SliceRenderer(), new DeltaRenderer()));

    private static final List<String> SOURCES = List.of(
            "package com.demo; public record Order(Money subtotal, String destination) {}",
            "package com.demo; public record Money(java.math.BigDecimal amount) {}",
            "package com.demo; public interface TaxCalculator { Money calculate(Order order); }",
            "package com.demo; public class DomesticTax implements TaxCalculator { public Money calculate(Order order) { return order.subtotal(); } }",
            "package com.demo; public class CheckoutService { private final TaxCalculator taxCalculator;"
                    + " public CheckoutService(TaxCalculator taxCalculator) { this.taxCalculator = taxCalculator; }"
                    + " public Money checkout(Order order) { return taxCalculator.calculate(order); } }");
    private static final VariantRequest REQUEST = new VariantRequest("TaxCalculator", "InternationalTax",
            List.of(new DesignDelta.MappingRow("DOMESTIC", "DomesticTax"),
                    new DesignDelta.MappingRow("INTERNATIONAL", "InternationalTax")), null);

    @Test
    void diffReturnsGenerateResultForRequestDynamicTicket() {
        ResponseEntity<?> resp = controller.diff(new CodeDiffRequest(
                SOURCES, "CheckoutService", "checkout", "order.destination", null, REQUEST));

        assertEquals(200, resp.getStatusCode().value());
        DiffResult body = assertInstanceOf(DiffResult.class, resp.getBody());
        assertEquals(DesignDelta.GENERATE, body.disposition());
    }

    @Test
    void diffReturnsBadRequestWhenEntryClassMissing() {
        ResponseEntity<?> resp = controller.diff(new CodeDiffRequest(
                SOURCES, "NoSuchClass", "checkout", "order.destination", null, REQUEST));

        assertEquals(400, resp.getStatusCode().value());
    }

    @Test
    void deriveReturnsSliceAndRenders() {
        ResponseEntity<?> resp = controller.derive(new CodeDiffRequest(
                SOURCES, "CheckoutService", "checkout", null, null, null));

        assertEquals(200, resp.getStatusCode().value());
        DeriveResult body = assertInstanceOf(DeriveResult.class, resp.getBody());
        assertEquals("CheckoutService", body.slice().sut());
        assertTrue(body.sliceMarkdown().contains("### Flow"));
        assertTrue(body.slicePuml().startsWith("@startuml"));
    }

    @Test
    void deriveReturnsBadRequestWhenEntryClassMissing() {
        ResponseEntity<?> resp = controller.derive(new CodeDiffRequest(
                SOURCES, "NoSuchClass", "checkout", null, null, null));

        assertEquals(400, resp.getStatusCode().value());
    }
}
