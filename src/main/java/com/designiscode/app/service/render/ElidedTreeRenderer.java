package com.designiscode.app.service.render;

import com.designiscode.app.dto.ScanCatalog;
import com.designiscode.app.service.CatalogFilter;
import com.designiscode.app.service.CatalogRenderer;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Aider-inspired file-keyed signature tree with {@code ⋮...} ellipses for
 * elided bodies. Packs ~5–10× more types in the same byte budget than
 * {@link MarkdownRenderer}.
 *
 * <p>Output shape per type:
 * <pre>{@code
 * com/order/Order.java:
 * ⋮...
 * │class Order:
 * │  id: UUID
 * │  cancel(reason: String) -> void
 * ⋮...
 * }</pre>
 *
 * <p><b>Budget degradation.</b> Renders all types at {@link Detail#FULL}; if
 * the output exceeds the byte cap, downshifts detail in order:
 * <ol>
 *   <li>drop Javadoc purpose lines</li>
 *   <li>drop fields</li>
 *   <li>elide method params ({@code name(...)})</li>
 * </ol>
 * If still over budget at minimum detail, drops types from the tail (preserving
 * the highest-ranked seeds). Types are <em>only</em> dropped after all per-type
 * detail has been stripped — the opposite of the old renderer's behavior, which
 * truncated at type count regardless of how much air each type used.
 */
public final class ElidedTreeRenderer implements CatalogRenderer {

    /** Default cap when caller passes ≤0. Matches the prior implicit ~2 KB budget. */
    private static final int DEFAULT_MAX_BYTES = 2048;

    private static final int MAX_FIELDS_PER_TYPE = 8;
    private static final int MAX_METHODS_PER_TYPE = 8;

    private enum Detail {
        /** Signatures + fields + Javadoc purpose comments. */
        FULL,
        /** Signatures + fields, no Javadoc purpose. */
        NO_JAVADOC,
        /** Signatures only, no fields, no Javadoc. */
        NO_FIELDS,
        /** Method names with {@code (...)}, no fields, no Javadoc. */
        MINIMAL
    }

    @Override
    public String render(CatalogFilter.FilteredCatalog f, int maxBytes) {
        if (f.topTypes().isEmpty()) {
            return EMPTY_SENTINEL;
        }
        int budget = maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;

        // Try each detail tier on the full type list first — degrading detail
        // costs less precision than dropping types entirely.
        for (Detail d : Detail.values()) {
            String out = renderAll(f.topTypes(), d);
            if (out.length() <= budget) return out;
        }

        // Still over at MINIMAL detail — drop tail types one at a time.
        List<ScanCatalog.TypeRecord> types = new ArrayList<>(f.topTypes());
        while (types.size() > 1) {
            types.remove(types.size() - 1);
            String out = renderAll(types, Detail.MINIMAL);
            if (out.length() <= budget) return out;
        }
        // One type at MINIMAL still doesn't fit — return it anyway; caller
        // configured an unreasonably tight budget.
        return renderAll(types, Detail.MINIMAL);
    }

    private String renderAll(List<ScanCatalog.TypeRecord> types, Detail d) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < types.size(); i++) {
            if (i > 0) sb.append('\n');
            sb.append(renderOne(types.get(i), d));
        }
        return sb.toString();
    }

    private String renderOne(ScanCatalog.TypeRecord t, Detail d) {
        StringBuilder sb = new StringBuilder();
        sb.append(fqnToPath(t.fqn())).append(":\n");
        sb.append("⋮...\n");

        // Emit FQN (not simple name) so the LLM can populate `existingFqn`
        // directly without inferring it from the file path.
        sb.append("│").append(t.kind()).append(' ').append(t.fqn());
        if (t.extendsType() != null) {
            sb.append(" extends ").append(simple(t.extendsType()));
        }
        if (!t.implementsTypes().isEmpty()) {
            sb.append(" implements ").append(t.implementsTypes().stream()
                    .map(ElidedTreeRenderer::simple).collect(Collectors.joining(", ")));
        }
        sb.append(":");
        if (d == Detail.FULL && t.purpose() != null && !t.purpose().isBlank()) {
            sb.append("  // ").append(t.purpose());
        }
        sb.append('\n');

        boolean includeFields = (d == Detail.FULL || d == Detail.NO_JAVADOC);
        if (includeFields) {
            for (ScanCatalog.FieldRecord fld : t.fields().stream().limit(MAX_FIELDS_PER_TYPE).toList()) {
                sb.append("│  ").append(fld.name()).append(": ").append(fld.type()).append('\n');
            }
        }

        for (ScanCatalog.MethodRecord m : t.publicMethods().stream().limit(MAX_METHODS_PER_TYPE).toList()) {
            sb.append("│  ");
            if (d == Detail.MINIMAL) {
                sb.append(m.name()).append("(...)");
                if (m.returnType() != null && !m.returnType().isBlank()) {
                    sb.append(" -> ").append(m.returnType());
                }
            } else {
                sb.append(m.signature());
            }
            if (d == Detail.FULL && m.purpose() != null && !m.purpose().isBlank()) {
                sb.append("  // ").append(m.purpose());
            }
            sb.append('\n');
        }

        sb.append("⋮...");
        return sb.toString();
    }

    /** {@code com.order.Order} → {@code com/order/Order.java} */
    private static String fqnToPath(String fqn) {
        if (fqn == null || fqn.isBlank()) return "Unknown.java";
        int dot = fqn.lastIndexOf('.');
        if (dot < 0) return fqn + ".java";
        return fqn.substring(0, dot).replace('.', '/') + '/' + fqn.substring(dot + 1) + ".java";
    }

    /** {@code java.util.List} → {@code List}; passthrough if already simple. */
    private static String simple(String typeName) {
        if (typeName == null) return "";
        int dot = typeName.lastIndexOf('.');
        return dot < 0 ? typeName : typeName.substring(dot + 1);
    }
}
