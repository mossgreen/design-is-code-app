package com.designiscode.app.service;

/**
 * Renders a {@link CatalogFilter.FilteredCatalog} into the markdown blob that
 * gets injected into the analyzer prompt's {@code {CODEBASE_TYPES}} placeholder.
 *
 * <p>Two implementations today:
 * <ul>
 *   <li>{@code MarkdownRenderer} — the original per-type bullet form. Kept as
 *       a fallback via {@code disc.catalog.renderer=markdown}.</li>
 *   <li>{@code ElidedTreeRenderer} — Aider-inspired file-keyed signature tree
 *       with {@code ⋮...} ellipses. Default. Packs ~5–10× more types in the
 *       same byte budget.</li>
 * </ul>
 *
 * <p>The interface exists so tomorrow's richer per-type lines (e.g.
 * {@code Depends on:}, {@code Used by:}) slot in without touching
 * {@link AnalyzeService}.
 */
public interface CatalogRenderer {

    /** Sentinel when the filter found nothing relevant; matches the wording
     *  the old inline renderer emitted so the analyzer prompt reads identically. */
    String EMPTY_SENTINEL = "_No directly-relevant existing types in this codebase for this story._";

    /**
     * Render the filtered catalog within a soft byte budget. Implementations
     * may exceed the budget when even a single type doesn't fit, but should
     * drop optional content (Javadoc purpose, param names, fields) before
     * dropping types.
     */
    String render(CatalogFilter.FilteredCatalog filtered, int maxBytes);
}
