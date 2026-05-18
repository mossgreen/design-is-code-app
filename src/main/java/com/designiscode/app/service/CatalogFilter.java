package com.designiscode.app.service;

import com.designiscode.app.dto.ScanCatalog;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Pure utility — given a user story and a full {@link ScanCatalog}, return
 * the top-K types most lexically relevant to the story plus the always-
 * compact summary slices (packages, glossary, conventions).
 *
 * <p>Why lexical not embeddings? Embeddings need a model call or a local
 * model bundle; lexical is good enough to ground "the codebase has Cart,
 * CartRepository, CartItem" when the story mentions "cart". For synonym
 * misses (story says "basket", codebase has "ShoppingBag") the user can
 * still rename in Step 2 — embeddings is a v2 upgrade if accuracy stalls.
 *
 * <p>Scoring (per type):
 * <ul>
 *   <li>type-name token matches story token → +5 (camelCase-split)</li>
 *   <li>method-name token matches story token → +2</li>
 *   <li>purpose word matches story token → +1</li>
 *   <li>role boost: entity / service / repository / value-object × 1.3;
 *       dto / controller / config / exception × 0.7</li>
 * </ul>
 * Types scoring 0 are dropped; the survivors are sorted high-to-low and
 * truncated at {@code topK}.
 */
public final class CatalogFilter {

    /** Common English words + DisC-irrelevant verbs/pronouns. Excluding from token matching. */
    private static final Set<String> STOPWORDS = Set.of(
            "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "for", "with", "as", "at",
            "is", "are", "be", "been", "was", "were", "by", "from", "into", "out", "up", "down",
            "it", "its", "this", "that", "these", "those", "they", "them", "their",
            "i", "we", "you", "your", "my", "me", "us", "our", "he", "she", "his", "her",
            "want", "wants", "need", "needs", "would", "should", "could", "can", "may", "might",
            "so", "if", "when", "then", "than", "because", "use", "uses", "using", "used",
            "story", "user", "shopper", "customer", "system",
            "make", "makes", "made", "do", "does", "done", "have", "has", "had", "get", "gets",
            "via", "etc", "such"
    );

    private CatalogFilter() {}

    public record FilteredCatalog(
            List<ScanCatalog.PackageRecord> packages,
            List<ScanCatalog.GlossaryEntry> glossary,
            ScanCatalog.Conventions conventions,
            List<ScanCatalog.TypeRecord> topTypes
    ) {}

    public static FilteredCatalog filter(String story, ScanCatalog catalog, int topK) {
        if (catalog == null || catalog.types() == null || catalog.types().isEmpty()) {
            return new FilteredCatalog(List.of(), List.of(), null, List.of());
        }

        Set<String> tokens = tokenise(story);
        List<Scored> scored = new ArrayList<>();
        for (ScanCatalog.TypeRecord t : catalog.types()) {
            double s = score(t, tokens);
            if (s > 0) scored.add(new Scored(t, s));
        }
        scored.sort(Comparator.comparingDouble(Scored::score).reversed());
        List<ScanCatalog.TypeRecord> top = scored.stream()
                .limit(Math.max(0, topK))
                .map(Scored::type)
                .toList();

        return new FilteredCatalog(
                catalog.packages(),
                catalog.glossary(),
                catalog.conventions(),
                top
        );
    }

    // --- internals ---

    private record Scored(ScanCatalog.TypeRecord type, double score) {}

    private static double score(ScanCatalog.TypeRecord t, Set<String> storyTokens) {
        if (storyTokens.isEmpty()) return 0.0;

        double raw = 0.0;
        // Type-name tokens (camelCase split).
        for (String tok : splitCamel(t.name())) {
            if (storyTokens.contains(tok)) raw += 5.0;
        }
        // Method-name tokens.
        for (ScanCatalog.MethodRecord m : t.publicMethods()) {
            for (String tok : splitCamel(m.name())) {
                if (storyTokens.contains(tok)) raw += 2.0;
            }
        }
        // Purpose / Javadoc word overlap.
        for (String tok : tokeniseRaw(t.purpose())) {
            if (storyTokens.contains(tok)) raw += 1.0;
        }
        // Role weighting.
        double mult = switch (t.role()) {
            case "entity", "service", "repository", "value-object" -> 1.3;
            case "dto", "controller", "config", "exception" -> 0.7;
            default -> 1.0;
        };
        return raw * mult;
    }

    /** Story → lowercase, alphanumeric word tokens with stopwords removed and length ≥ 3. */
    static Set<String> tokenise(String story) {
        if (story == null || story.isBlank()) return Set.of();
        Set<String> out = new LinkedHashSet<>();
        for (String w : story.toLowerCase().split("[^a-z0-9]+")) {
            if (w.length() < 3) continue;
            if (STOPWORDS.contains(w)) continue;
            out.add(w);
        }
        return out;
    }

    /** Lower-case lexical tokens from arbitrary text (purpose/javadoc) — no stopword filter. */
    private static Set<String> tokeniseRaw(String text) {
        if (text == null || text.isBlank()) return Set.of();
        Set<String> out = new HashSet<>();
        for (String w : text.toLowerCase().split("[^a-z0-9]+")) {
            if (w.length() >= 3) out.add(w);
        }
        return out;
    }

    /** Split an identifier on camelCase boundaries → lowercase tokens. "OrderRepository" → [order, repository]. */
    static List<String> splitCamel(String ident) {
        if (ident == null || ident.isBlank()) return List.of();
        // Insert spaces at camelCase boundaries, then lowercase + split.
        String spaced = ident.replaceAll("([a-z0-9])([A-Z])", "$1 $2")
                .replaceAll("([A-Z]+)([A-Z][a-z])", "$1 $2");
        List<String> out = new ArrayList<>();
        for (String w : spaced.toLowerCase().split("\\s+")) {
            if (w.length() >= 2) out.add(w);
        }
        return out;
    }
}
