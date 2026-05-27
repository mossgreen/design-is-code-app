package com.designiscode.app.service;

import com.designiscode.app.dto.ScanCatalog;
import com.designiscode.app.dto.ScanCatalog.FieldRecord;
import com.designiscode.app.dto.ScanCatalog.MethodRecord;
import com.designiscode.app.dto.ScanCatalog.TypeRecord;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CatalogFilterTest {

    private static TypeRecord svc(String name, List<FieldRecord> fields, List<MethodRecord> methods) {
        return new TypeRecord(
                "com.demo." + name, name, "com.demo", "class", "service",
                List.of("@Service"), null, List.of(), "", methods, fields
        );
    }

    private static TypeRecord entity(String name) {
        return new TypeRecord(
                "com.demo." + name, name, "com.demo", "class", "entity",
                List.of("@Entity"), null, List.of(), "", List.of(), List.of()
        );
    }

    private static ScanCatalog catalog(List<TypeRecord> types) {
        return new ScanCatalog("/x", types.size(), 0, List.of(), types, List.of(), null);
    }

    @Test
    void neighborSurfacesEvenWhenNotLexicallyMatched() {
        // OrderService has a Cart field. Story says "order" (matches Service)
        // but never says "cart". Cart should surface via 1-hop expansion.
        TypeRecord cart = entity("Cart");
        TypeRecord orderService = svc("OrderService",
                List.of(new FieldRecord("cart", "Cart")),
                List.of());
        TypeRecord unrelated = entity("WeatherSensor");

        ScanCatalog cat = catalog(List.of(cart, orderService, unrelated));
        CatalogFilter.FilteredCatalog out = CatalogFilter.filter("order flow", cat, 20);

        assertTrue(out.topTypes().stream().anyMatch(t -> t.name().equals("OrderService")),
                "seed OrderService must appear");
        assertTrue(out.topTypes().stream().anyMatch(t -> t.name().equals("Cart")),
                "neighbor Cart must surface via field-type edge");
        assertFalse(out.topTypes().stream().anyMatch(t -> t.name().equals("WeatherSensor")),
                "unrelated WeatherSensor must NOT surface");
    }

    @Test
    void neighborhoodDoesNotBleedTwoHops() {
        // OrderService → Cart → Coupon. Coupon is reachable in 2 hops from a
        // seed, but expansion is genuinely 1-hop and must NOT include it.
        TypeRecord coupon = entity("Coupon");
        TypeRecord cart = new TypeRecord(
                "com.demo.Cart", "Cart", "com.demo", "class", "entity",
                List.of("@Entity"), null, List.of(), "",
                List.of(new MethodRecord("applyCoupon", "applyCoupon(c: Coupon) -> void",
                        List.of(new FieldRecord("c", "Coupon")), "void", "")),
                List.of()
        );
        TypeRecord orderService = svc("OrderService",
                List.of(new FieldRecord("cart", "Cart")),
                List.of());

        ScanCatalog cat = catalog(List.of(coupon, cart, orderService));
        CatalogFilter.FilteredCatalog out = CatalogFilter.filter("order flow", cat, 20);

        assertTrue(out.topTypes().stream().anyMatch(t -> t.name().equals("OrderService")));
        assertTrue(out.topTypes().stream().anyMatch(t -> t.name().equals("Cart")),
                "1-hop neighbor Cart must appear");
        assertFalse(out.topTypes().stream().anyMatch(t -> t.name().equals("Coupon")),
                "2-hop transitive Coupon must NOT appear (no transitive bleed)");
    }

    @Test
    void neighborhoodSeesGenericTypeArguments() {
        // OrderService returns List<Order>. The bare token "List" won't match
        // a catalog type, but the embedded "Order" identifier should.
        TypeRecord order = entity("Order");
        TypeRecord orderService = svc("OrderService", List.of(),
                List.of(new MethodRecord("findRecent", "findRecent() -> List<Order>",
                        List.of(), "List<Order>", "")));

        ScanCatalog cat = catalog(List.of(order, orderService));
        CatalogFilter.FilteredCatalog out = CatalogFilter.filter("order flow", cat, 20);

        assertTrue(out.topTypes().stream().anyMatch(t -> t.name().equals("Order")),
                "generic-wrapped Order must surface via method return type");
    }

    @Test
    void seedsAlonePreservedWhenNoNeighborsExist() {
        // Story matches OrderService by name; it has no edges. Result is just
        // the seed, no expansion noise.
        TypeRecord orderService = svc("OrderService", List.of(), List.of());
        TypeRecord unrelated = entity("WeatherSensor");

        ScanCatalog cat = catalog(List.of(orderService, unrelated));
        CatalogFilter.FilteredCatalog out = CatalogFilter.filter("order placement", cat, 20);

        assertTrue(out.topTypes().stream().anyMatch(t -> t.name().equals("OrderService")));
        assertFalse(out.topTypes().stream().anyMatch(t -> t.name().equals("WeatherSensor")));
    }

    @Test
    void emptyCatalogIsHandledGracefully() {
        CatalogFilter.FilteredCatalog out = CatalogFilter.filter("anything", catalog(List.of()), 20);
        assertTrue(out.topTypes().isEmpty());
    }
}
