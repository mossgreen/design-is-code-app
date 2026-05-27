package com.designiscode.app.service.render;

import com.designiscode.app.dto.ScanCatalog.FieldRecord;
import com.designiscode.app.dto.ScanCatalog.MethodRecord;
import com.designiscode.app.dto.ScanCatalog.TypeRecord;
import com.designiscode.app.service.CatalogFilter;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ElidedTreeRendererTest {

    private static TypeRecord type(String pkg, String name, int methodCount, int fieldCount, String purpose) {
        List<FieldRecord> fields = new java.util.ArrayList<>();
        for (int i = 0; i < fieldCount; i++) fields.add(new FieldRecord("field" + i, "String"));
        List<MethodRecord> methods = new java.util.ArrayList<>();
        for (int i = 0; i < methodCount; i++) {
            methods.add(new MethodRecord(
                    "method" + i,
                    "method" + i + "(arg: String) -> void",
                    List.of(new FieldRecord("arg", "String")),
                    "void",
                    "Documents method " + i + " purpose."
            ));
        }
        return new TypeRecord(
                pkg + "." + name, name, pkg, "class", "service",
                List.of("@Service"), null, List.of(), purpose, methods, fields
        );
    }

    private static CatalogFilter.FilteredCatalog catalog(List<TypeRecord> types) {
        return new CatalogFilter.FilteredCatalog(List.of(), List.of(), null, types);
    }

    @Test
    void elidedRespectsByteBudgetWhileMarkdownIgnoresIt() {
        // The real density win: under budget pressure, elided degrades and
        // still fits all types, while markdown ignores the cap (preserves
        // old behavior — type-count truncation, not byte-cap).
        List<TypeRecord> types = new java.util.ArrayList<>();
        for (int i = 0; i < 20; i++) {
            types.add(type("com.demo", "Type" + i, 4, 3, "Purpose for type " + i + " explained."));
        }
        CatalogFilter.FilteredCatalog f = catalog(types);

        int tightBudget = 1500;
        String elided = new ElidedTreeRenderer().render(f, tightBudget);
        String md     = new MarkdownRenderer().render(f, tightBudget);

        assertTrue(elided.length() <= tightBudget,
                "elided must respect budget, was " + elided.length() + " / " + tightBudget);
        assertTrue(md.length() > tightBudget,
                "markdown is expected to ignore budget (documents legacy behavior); " +
                        "if this fails the legacy contract changed: " + md.length());
    }

    @Test
    void elidedFitsAllSmallTypesAtTwoKbBudget() {
        // 10 medium types comfortably fit a 2 KB budget after degradation —
        // verifies the renderer doesn't drop types when stripping detail
        // alone is enough to satisfy the cap.
        List<TypeRecord> types = new java.util.ArrayList<>();
        for (int i = 0; i < 10; i++) {
            types.add(type("com.demo", "Type" + i, 4, 3, "Purpose for type " + i + " explained."));
        }
        String elided = new ElidedTreeRenderer().render(catalog(types), 2048);

        for (int i = 0; i < 10; i++) {
            assertTrue(elided.contains("│class com.demo.Type" + i + ":"),
                    "Type" + i + " missing from elided output at 2 KB budget");
        }
        assertTrue(elided.length() <= 2048, "actual=" + elided.length());
    }

    @Test
    void elidedPreservesEarlyTypesWhenForcedToDropTail() {
        // 20 types into a budget too tight even for MINIMAL detail —
        // verifies the renderer drops from the TAIL (preserving the highest-
        // ranked seeds the filter already ordered).
        List<TypeRecord> types = new java.util.ArrayList<>();
        for (int i = 0; i < 20; i++) {
            types.add(type("com.demo", "Type" + i, 4, 3, "Purpose " + i));
        }
        String elided = new ElidedTreeRenderer().render(catalog(types), 1024);

        assertTrue(elided.length() <= 1024, "actual=" + elided.length());
        assertTrue(elided.contains("│class com.demo.Type0:"), "first type must survive");
        // Last few types should have been dropped.
        assertFalse(elided.contains("│class com.demo.Type19:"), "tail type Type19 should drop");
    }

    @Test
    void elidedRendererDropsJavadocBeforeDroppingTypes() {
        // Five types, each with javadoc. Cap tight enough to force javadoc
        // drop but not type drop.
        List<TypeRecord> types = List.of(
                type("com.demo", "Alpha",   3, 2, "Long javadoc purpose Alpha sentence here."),
                type("com.demo", "Beta",    3, 2, "Long javadoc purpose Beta sentence here."),
                type("com.demo", "Gamma",   3, 2, "Long javadoc purpose Gamma sentence here."),
                type("com.demo", "Delta",   3, 2, "Long javadoc purpose Delta sentence here."),
                type("com.demo", "Epsilon", 3, 2, "Long javadoc purpose Epsilon sentence here.")
        );
        CatalogFilter.FilteredCatalog f = catalog(types);

        String full = new ElidedTreeRenderer().render(f, 1 << 20);
        String tight = new ElidedTreeRenderer().render(f, full.length() - 200);

        // All five type names still present.
        for (String name : List.of("Alpha", "Beta", "Gamma", "Delta", "Epsilon")) {
            assertTrue(tight.contains("│class com.demo." + name + ":"),
                    "type " + name + " missing under tight budget");
        }
        // Javadoc comments stripped.
        assertFalse(tight.contains("Long javadoc purpose"),
                "javadoc should be dropped before types");
    }

    @Test
    void elidedRendererDropsTailTypesOnlyAfterAllDetailStripped() {
        // 10 types. Cap so small that even MINIMAL detail on all 10 doesn't fit
        // — should drop tail types.
        List<TypeRecord> types = new java.util.ArrayList<>();
        for (int i = 0; i < 10; i++) {
            types.add(type("com.demo", "Type" + i, 4, 3, "Purpose " + i));
        }
        String out = new ElidedTreeRenderer().render(catalog(types), 200);

        // First type kept, last definitely dropped under that budget.
        assertTrue(out.contains("│class com.demo.Type0:"), "first type must survive");
        assertFalse(out.contains("│class com.demo.Type9:"), "tail type should drop under tight budget");
    }

    @Test
    void elidedRendererEmitsAiderShapedHeaderAndFooter() {
        TypeRecord t = type("com.order", "Order", 1, 0, "Order root.");
        String out = new ElidedTreeRenderer().render(catalog(List.of(t)), 1 << 20);
        // Path conversion: com.order.Order → com/order/Order.java
        assertTrue(out.startsWith("com/order/Order.java:"), "header: " + out);
        assertTrue(out.contains("⋮..."), "ellipsis missing");
        assertTrue(out.contains("│class com.order.Order:"), "class line missing");
    }

    @Test
    void emptyFilteredCatalogReturnsSentinel() {
        String out = new ElidedTreeRenderer().render(catalog(List.of()), 1 << 20);
        assertEquals("_No directly-relevant existing types in this codebase for this story._", out);
    }
}
