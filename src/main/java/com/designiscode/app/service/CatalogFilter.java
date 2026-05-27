package com.designiscode.app.service;

import com.designiscode.app.dto.ScanCatalog;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure utility — given a user story and a full {@link ScanCatalog}, return
 * the types most relevant to the story (lexical seeds + 1-hop structural
 * neighbors) plus the always-compact summary slices (packages, glossary,
 * conventions).
 *
 * <p>Pipeline: {@code score → seeds (top K/2) → expand 1-hop → merge → truncate}.
 * The neighborhood expansion uses edges already extracted by ScanService
 * ({@code extends}, {@code implements}, field types, method param/return
 * types), so a relevant type whose <em>name</em> doesn't appear in the story
 * still surfaces if a name-matched type points at it.
 *
 * <p>Why lexical not embeddings? Embeddings need a model call or a local
 * model bundle; lexical seeds + structural expansion are good enough to
 * ground "the codebase has Cart, CartRepository, CartItem" when the story
 * mentions "cart", and to surface {@code Cart} when the story says
 * "checkout" but {@code CheckoutService} has a {@code Cart} field —
 * embeddings is a v2 upgrade if accuracy stalls.
 *
 * <p>Scoring (per type, used for seed selection):
 * <ul>
 *   <li>type-name token matches story token → +5 (camelCase-split)</li>
 *   <li>method-name token matches story token → +2</li>
 *   <li>purpose word matches story token → +1</li>
 *   <li>role boost: entity / service / repository / value-object × 1.3;
 *       dto / controller / config / exception × 0.7</li>
 * </ul>
 * Types scoring 0 are dropped as seed candidates but can still surface as
 * structural neighbors of a higher-scoring seed.
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

        // Split budget: half for high-scoring lexical seeds, half for 1-hop
        // neighbors of those seeds. This keeps a lexical-noise-heavy story
        // (many name matches) from crowding out structural neighbors entirely,
        // while still letting an all-structural story fall back to seeds.
        int safeK   = Math.max(0, topK);
        int seedCap = Math.max(1, safeK / 2);
        List<ScanCatalog.TypeRecord> seeds = scored.stream()
                .limit(seedCap)
                .map(Scored::type)
                .toList();

        List<ScanCatalog.TypeRecord> neighbors = expandNeighborhood(seeds, catalog.types());
        List<ScanCatalog.TypeRecord> top = mergeRespectingOrder(seeds, neighbors, safeK);

        return new FilteredCatalog(
                catalog.packages(),
                catalog.glossary(),
                catalog.conventions(),
                top
        );
    }

    // --- neighborhood expansion ---

    /** Generics + arrays + nested-generic separators. Captures every
     *  PascalCase identifier from a rendered type string like
     *  {@code Map<String, List<Order>>}. */
    private static final Pattern TYPE_IDENT = Pattern.compile("([A-Z][A-Za-z0-9_]*)");

    /**
     * For each seed, walk one hop along edges already extracted by ScanService —
     * {@code extends}, {@code implements}, field types, method param types,
     * method return types — and collect every catalog type whose FQN or simple
     * name appears as an edge target. The result excludes the seeds themselves
     * and de-duplicates across seeds.
     *
     * <p>Match policy: an edge token (often a simple name like "Order" or a
     * generic-wrapped string like "List&lt;Order&gt;") matches a catalog type
     * if either (a) the token equals the type's FQN, or (b) one of the
     * PascalCase identifiers inside the token equals the type's simple name.
     * Simple-name collisions across packages will over-include, but at our
     * scale that's a feature (more candidates) not a bug.
     */
    static List<ScanCatalog.TypeRecord> expandNeighborhood(
            List<ScanCatalog.TypeRecord> seeds,
            List<ScanCatalog.TypeRecord> allTypes
    ) {
        if (seeds.isEmpty() || allTypes.isEmpty()) return List.of();

        Set<String> seedFqns = new HashSet<>();
        for (ScanCatalog.TypeRecord s : seeds) seedFqns.add(s.fqn());

        // Collect all edge tokens emitted by any seed.
        Set<String> edgeIdents = new HashSet<>();
        Set<String> edgeFqns   = new HashSet<>();
        for (ScanCatalog.TypeRecord s : seeds) {
            addEdge(edgeIdents, edgeFqns, s.extendsType());
            for (String impl : s.implementsTypes()) addEdge(edgeIdents, edgeFqns, impl);
            for (ScanCatalog.FieldRecord f : s.fields()) addEdge(edgeIdents, edgeFqns, f.type());
            for (ScanCatalog.MethodRecord m : s.publicMethods()) {
                addEdge(edgeIdents, edgeFqns, m.returnType());
                for (ScanCatalog.FieldRecord p : m.params()) addEdge(edgeIdents, edgeFqns, p.type());
            }
        }

        // Index catalog by simple name; preserve insertion order for stable output.
        Map<String, List<ScanCatalog.TypeRecord>> bySimple = new LinkedHashMap<>();
        for (ScanCatalog.TypeRecord t : allTypes) {
            bySimple.computeIfAbsent(t.name(), k -> new ArrayList<>()).add(t);
        }

        LinkedHashSet<ScanCatalog.TypeRecord> out = new LinkedHashSet<>();
        for (ScanCatalog.TypeRecord t : allTypes) {
            if (seedFqns.contains(t.fqn())) continue;
            if (edgeFqns.contains(t.fqn())) { out.add(t); continue; }
            if (edgeIdents.contains(t.name())) out.add(t);
        }
        return new ArrayList<>(out);
    }

    /** Pull every PascalCase identifier out of a possibly-generic type string
     *  ("Map&lt;String, Order&gt;" → {Map, String, Order}) and also record
     *  the raw token in case it's already an FQN. */
    private static void addEdge(Set<String> idents, Set<String> fqns, String raw) {
        if (raw == null || raw.isBlank()) return;
        String trimmed = raw.trim();
        if (trimmed.contains(".")) fqns.add(trimmed);
        Matcher m = TYPE_IDENT.matcher(trimmed);
        while (m.find()) idents.add(m.group(1));
    }

    /** Concatenate seeds (in score order) with neighbors (in catalog order),
     *  de-duplicated by FQN, truncated to {@code cap}. */
    static List<ScanCatalog.TypeRecord> mergeRespectingOrder(
            List<ScanCatalog.TypeRecord> seeds,
            List<ScanCatalog.TypeRecord> neighbors,
            int cap
    ) {
        LinkedHashSet<ScanCatalog.TypeRecord> merged = new LinkedHashSet<>(seeds);
        merged.addAll(neighbors);
        return merged.stream().limit(Math.max(0, cap)).toList();
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
