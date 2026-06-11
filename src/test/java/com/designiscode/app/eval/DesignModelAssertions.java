package com.designiscode.app.eval;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Plain-Java assertions over the RAW analyzer design-model {@code Map} — no LLM
 * judge. {@code AnalyzeService.analyze()} returns parsed JDK collections, so the
 * eval navigates that map directly (no Jackson dependency here).
 *
 * <p>Field names are the RAW prompt-output names ({@code behaviors}/{@code returns}/
 * {@code args}/{@code isLeaf}), NOT the post-transform shape the app.js collectors
 * read ({@code methods}/{@code output}/{@code inputs}/{@code kind==='leaf'}). The
 * collector predicates are the semantic spec, translated to these names.
 */
final class DesignModelAssertions {

    private DesignModelAssertions() {}

    private static final Pattern REPO = Pattern.compile("(?i)repository");
    private static final Set<String> TOP_KEYS =
            Set.of("variancePlan", "sut", "participants", "story", "entities");

    // ---------- Map navigation helpers (null-safe; never NPE / CCE) ----------

    @SuppressWarnings("unchecked")
    static Map<String, Object> asMap(Object o) {
        return (o instanceof Map) ? (Map<String, Object>) o : Map.of();
    }

    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> asMapList(Object o) {
        if (!(o instanceof List<?> raw)) return List.of();
        List<Map<String, Object>> out = new ArrayList<>(raw.size());
        for (Object e : raw) if (e instanceof Map) out.add((Map<String, Object>) e);
        return out;
    }

    static List<Map<String, Object>> mapList(Map<String, Object> m, String key) {
        return asMapList(m.get(key));
    }

    static String str(Map<String, Object> m, String key) {
        Object v = m.get(key);
        return (v instanceof String s) ? s : null;
    }

    static boolean bool(Map<String, Object> m, String key) {
        return Boolean.TRUE.equals(m.get(key)); // null / absent -> false
    }

    /** Collapse any JSON number (Integer/Long/Double/BigDecimal…) to double. */
    static Double num(Object v) {
        return (v instanceof Number n) ? n.doubleValue() : null;
    }

    static List<Integer> intList(Object o) {
        if (!(o instanceof List<?> raw)) return List.of();
        List<Integer> out = new ArrayList<>(raw.size());
        for (Object e : raw) if (e instanceof Number n) out.add(n.intValue());
        return out;
    }

    static Set<String> fieldNames(Map<String, Object> entity) {
        Set<String> out = new LinkedHashSet<>();
        for (Map<String, Object> f : mapList(entity, "fields")) {
            String n = str(f, "name");
            if (n != null) out.add(n);
        }
        return out;
    }

    // ---------- Assertion 1: structural sanity ----------

    static void assertStructuralSanity(Map<String, Object> model, int run) {
        String at = ctx(run, "structural-sanity");
        assertTrue(model.keySet().containsAll(TOP_KEYS),
                at + " missing top-level keys; present=" + model.keySet());

        String sut = str(model, "sut");
        assertNotNull(sut, at + " sut is not a String");
        assertFalse(sut.isBlank(), at + " sut is blank");

        List<Map<String, Object>> participants = mapList(model, "participants");
        assertFalse(participants.isEmpty(), at + " participants is empty");
        boolean sutIsParticipant = participants.stream()
                .anyMatch(p -> sut.equals(str(p, "name")));
        assertTrue(sutIsParticipant,
                at + " sut '" + sut + "' not in participants[].name=" + names(participants));
    }

    // ---------- Assertion 2: variance understood + filled ----------

    /**
     * @param goldMapping key (CAT/DOG, upper-cased) -> expected sub-map of field->number.
     *                    Gold keys must be present with matching values (hard);
     *                    extra keys in the model are a soft warning, not a failure.
     */
    static void assertRuleTableVariance(Map<String, Object> model, int run,
                                        Map<String, Map<String, Object>> goldMapping) {
        String at = ctx(run, "rule-table-variance");

        List<Map<String, Object>> plan = mapList(model, "variancePlan");
        List<Map<String, Object>> ruleTables = plan.stream()
                .filter(e -> "rule-table".equals(str(e, "pattern")))
                .toList();
        assertEquals(1, ruleTables.size(),
                at + " expected exactly one rule-table variancePlan entry, got "
                        + ruleTables.size() + " (patterns="
                        + plan.stream().map(e -> str(e, "pattern")).toList() + ")");

        List<Map<String, Object>> mapping = mapList(ruleTables.get(0), "mapping");
        Map<String, Map<String, Object>> byKey = new HashMap<>();
        for (Map<String, Object> row : mapping) {
            String k = str(row, "key");
            if (k != null) byKey.put(k.trim().toUpperCase(Locale.ROOT), asMap(row.get("expected")));
        }

        // HARD: every gold key present with matching values.
        goldMapping.forEach((key, goldExpected) -> {
            Map<String, Object> actual = byKey.get(key);
            assertNotNull(actual, at + " no mapping row for key " + key
                    + " (keys present=" + byKey.keySet() + ")");
            goldExpected.forEach((field, goldVal) -> {
                Double a = num(actual.get(field));
                Double g = num(goldVal);
                assertNotNull(a, at + " key " + key + " field '" + field
                        + "' not a number: " + actual.get(field));
                assertEquals(g, a, 0.0001,
                        at + " key " + key + " field '" + field + "' expected " + g + " got " + a);
            });
        });

        // SOFT: extra mapping keys beyond the gold set (e.g. a DEFAULT/OTHER row).
        Set<String> extra = new HashSet<>(byKey.keySet());
        extra.removeAll(goldMapping.keySet());
        if (!extra.isEmpty()) {
            System.out.println("[" + at + "] SOFT WARNING: unexpected mapping keys beyond "
                    + goldMapping.keySet() + ": " + extra);
        }
    }

    // ---------- Assertion 3: rule data has a fillable home (record + non-mock leaf) ----------

    static void assertRuleRecordHasFillableHome(Map<String, Object> model, int run,
                                                int expectedFieldCount) {
        String at = ctx(run, "rule-record-home");

        List<Map<String, Object>> records = mapList(model, "entities").stream()
                .filter(e -> "record".equals(str(e, "kind")))
                .filter(e -> fieldNames(e).size() == expectedFieldCount)
                .toList();
        assertFalse(records.isEmpty(),
                at + " no record entity with exactly " + expectedFieldCount
                        + " fields; entities=" + entitySummary(model));

        Set<String> recordNames = new HashSet<>();
        records.forEach(r -> recordNames.add(str(r, "name")));

        boolean homed = mapList(model, "participants").stream()
                .filter(p -> bool(p, "isLeaf"))
                .filter(p -> str(p, "existingFqn") == null)              // not a reuse
                .filter(p -> {                                           // not *Repository
                    String n = str(p, "name");
                    return n != null && !REPO.matcher(n).find();
                })
                .flatMap(p -> mapList(p, "behaviors").stream())
                .anyMatch(b -> recordNames.contains(str(b, "returns"))
                        && mapList(b, "args").size() == 1);
        assertTrue(homed,
                at + " no non-mock leaf has a 1-arg behavior returning one of the rule records "
                        + recordNames + "; participants=" + participantSummary(model));
    }

    // ---------- Assertion 4: applier cases coverage ----------

    static void assertApplierCasesCoverAllRows(Map<String, Object> model, int run, int acCount) {
        String at = ctx(run, "applier-cases");
        // One case per AC row index; boundary-bracketing rows (acIndex: null)
        // are allowed on top, so coverage is by acIndex set, not exact length.
        boolean filled = mapList(model, "participants").stream()
                .flatMap(p -> mapList(p, "behaviors").stream())
                .map(b -> mapList(b, "cases"))
                .anyMatch(cases -> {
                    if (cases.isEmpty()) return false;
                    Set<Integer> covered = cases.stream()
                            .map(c -> c.get("acIndex"))
                            .filter(v -> v instanceof Number)
                            .map(v -> ((Number) v).intValue())
                            .collect(Collectors.toSet());
                    for (int i = 0; i < acCount; i++) if (!covered.contains(i)) return false;
                    return true;
                });
        assertTrue(filled,
                at + " expected a behavior whose cases[] covers every AC row index 0.." + (acCount - 1)
                        + " (the varying pure-function leaf should be FILLED, not stubbed; "
                        + "boundary-bracketing rows with acIndex=null are allowed on top); "
                        + "case-lengths seen=" + caseLengths(model));
    }

    // ---------- Assertion 5: AC coverage (hard) + one-carrier (soft) ----------

    static void assertAcCoverage(Map<String, Object> model, int run, int acCount) {
        String at = ctx(run, "ac-coverage");

        int[] carriers = new int[acCount];
        for (Map<String, Object> p : mapList(model, "participants")) {
            for (int idx : intList(p.get("acIndices"))) {
                if (idx >= 0 && idx < acCount) carriers[idx]++;
            }
        }

        List<Integer> uncovered = new ArrayList<>();
        for (int i = 0; i < acCount; i++) if (carriers[i] == 0) uncovered.add(i);
        assertTrue(uncovered.isEmpty(),
                at + " AC rows not carried by any participant: " + uncovered
                        + " (acIndices per participant=" + acIndicesSummary(model) + ")");

        List<Integer> multi = new ArrayList<>();
        for (int i = 0; i < acCount; i++) if (carriers[i] > 1) multi.add(i);
        if (!multi.isEmpty()) {
            System.out.println("[" + at + "] SOFT WARNING: AC rows carried by >1 participant "
                    + "(exactly-one-carrier not held): " + multi
                    + "; per-participant acIndices=" + acIndicesSummary(model));
        }
    }

    // ---------- message helpers ----------

    private static String ctx(int run, String assertion) {
        return "run " + run + " / " + assertion;
    }

    private static List<String> names(List<Map<String, Object>> ps) {
        return ps.stream().map(p -> str(p, "name")).toList();
    }

    private static String entitySummary(Map<String, Object> m) {
        return mapList(m, "entities").stream()
                .map(e -> str(e, "name") + ":" + str(e, "kind") + fieldNames(e))
                .toList().toString();
    }

    private static String participantSummary(Map<String, Object> m) {
        return mapList(m, "participants").stream()
                .map(p -> str(p, "name") + "{leaf=" + bool(p, "isLeaf")
                        + ",fqn=" + str(p, "existingFqn")
                        + ",returns=" + mapList(p, "behaviors").stream()
                                .map(b -> str(b, "returns")).toList() + "}")
                .toList().toString();
    }

    private static List<Integer> caseLengths(Map<String, Object> m) {
        return mapList(m, "participants").stream()
                .flatMap(p -> mapList(p, "behaviors").stream())
                .map(b -> mapList(b, "cases").size()).toList();
    }

    private static String acIndicesSummary(Map<String, Object> m) {
        return mapList(m, "participants").stream()
                .map(p -> str(p, "name") + "=" + intList(p.get("acIndices")))
                .toList().toString();
    }
}
