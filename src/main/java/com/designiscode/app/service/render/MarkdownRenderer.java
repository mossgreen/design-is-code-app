package com.designiscode.app.service.render;

import com.designiscode.app.dto.ScanCatalog;
import com.designiscode.app.service.CatalogFilter;
import com.designiscode.app.service.CatalogRenderer;

import java.util.List;

/**
 * Original per-type markdown bullet renderer. Body lifted verbatim from
 * {@code AnalyzeService.renderTypes()} as it stood before the renderer split,
 * so the LLM sees byte-identical output when this renderer is selected.
 *
 * <p>Kept as the {@code disc.catalog.renderer=markdown} fallback. Ignores
 * {@code maxBytes} — old behavior was type-count truncation, not byte-cap.
 */
public final class MarkdownRenderer implements CatalogRenderer {

    @Override
    public String render(CatalogFilter.FilteredCatalog f, int maxBytes) {
        if (f.topTypes().isEmpty()) {
            return EMPTY_SENTINEL;
        }
        StringBuilder sb = new StringBuilder();
        for (ScanCatalog.TypeRecord t : f.topTypes()) {
            sb.append("- `").append(t.fqn()).append("` (").append(t.role()).append(", ").append(t.kind()).append(")");
            if (t.purpose() != null && !t.purpose().isBlank()) {
                sb.append("\n    Purpose: ").append(t.purpose());
            }
            if (t.extendsType() != null) {
                sb.append("\n    Extends: ").append(t.extendsType());
            }
            if (!t.implementsTypes().isEmpty()) {
                sb.append("\n    Implements: ").append(String.join(", ", t.implementsTypes()));
            }
            if (!t.fields().isEmpty()) {
                sb.append("\n    Fields: ");
                sb.append(t.fields().stream()
                        .limit(8)
                        .map(fld -> fld.name() + ": " + fld.type())
                        .reduce((a, b) -> a + ", " + b).orElse(""));
            }
            List<ScanCatalog.MethodRecord> methods = t.publicMethods();
            if (!methods.isEmpty()) {
                sb.append("\n    Methods:");
                for (ScanCatalog.MethodRecord m : methods.stream().limit(8).toList()) {
                    sb.append("\n      - ").append(m.signature());
                    if (m.purpose() != null && !m.purpose().isBlank()) {
                        sb.append("  // ").append(m.purpose());
                    }
                }
            }
            sb.append("\n\n");
        }
        return sb.toString().trim();
    }
}
