package com.designiscode.app.eval;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * P0 of the eval: deterministic, gold-free contract validation of a raw
 * analyzer design-model {@code Map}. Answers one question — <i>would the
 * wizard and the DisC plugin accept this design?</i> — via shape checks,
 * referential integrity, and the plugin's Step-1 refusal rules. No fixture
 * gold involved; applies identically to every fixture.
 *
 * <p>Returns a {@link Report}: {@code violations} fail the run; {@code
 * warnings} are recorded in artifacts but never fail (used where the check
 * is best-effort, e.g. parsing numbers out of Java-expression strings).
 */
final class DesignContractValidator {

    record Report(List<String> violations, List<String> warnings) {
        boolean ok() {
            return violations.isEmpty();
        }
    }

    private static final Set<String> TOP_KEYS =
            Set.of("variancePlan", "sut", "participants", "story", "entities");
    private static final Set<String> ENTITY_KINDS =
            Set.of("record", "enum", "class", "interface", "sealed-interface");
    private static final Set<String> PATTERNS =
            Set.of("rule-table", "resolver", "sealed-polymorphism", "pattern-matching");
    private static final Pattern NUMBER = Pattern.compile("-?\\d+(?:\\.\\d+)?");

    private DesignContractValidator() {}

    static Report validate(Map<String, Object> model, int acCount) {
        List<String> v = new ArrayList<>();
        List<String> w = new ArrayList<>();

        // --- top-level shape ---
        for (String k : TOP_KEYS) {
            if (!model.containsKey(k)) v.add("top-level key missing: " + k);
        }
        List<Map<String, Object>> participants = mapList(model, "participants");
        List<Map<String, Object>> entities = mapList(model, "entities");

        String sut = str(model, "sut");
        if (sut == null || sut.isBlank()) {
            v.add("sut is missing or blank");
        } else if (participants.stream().noneMatch(p -> sut.equals(str(p, "name")))) {
            v.add("sut '" + sut + "' is not in participants[].name");
        }

        // --- participants vs entities disjoint ---
        Set<String> participantNames = names(participants);
        Set<String> entityNames = names(entities);
        Set<String> overlap = new HashSet<>(participantNames);
        overlap.retainAll(entityNames);
        if (!overlap.isEmpty()) {
            v.add("names appear in BOTH participants[] and entities[]: " + overlap);
        }

        // --- per-participant checks ---
        for (Map<String, Object> p : participants) {
            String pn = str(p, "name");
            if (str(p, "existingFqn") != null && !bool(p, "isLeaf")) {
                v.add("participant " + pn + " has existingFqn but isLeaf!=true (reuse must be a leaf)");
            }
            for (Map<String, Object> b : mapList(p, "behaviors")) {
                String bn = pn + "." + str(b, "name");
                Set<String> argNames = new LinkedHashSet<>();
                for (Map<String, Object> a : mapList(b, "args")) {
                    String an = str(a, "name");
                    if (an != null) argNames.add(an);
                }
                List<Map<String, Object>> cases = mapList(b, "cases");
                for (Map<String, Object> c : cases) {
                    Set<String> inputKeys = asMap(c.get("inputs")).keySet();
                    if (!inputKeys.equals(argNames)) {
                        v.add(bn + " case inputs keys " + inputKeys + " != args names " + argNames);
                    }
                    Object idx = c.get("acIndex");
                    if (idx != null && (!(idx instanceof Number n)
                            || n.intValue() < 0 || n.intValue() >= acCount)) {
                        v.add(bn + " case acIndex out of range [0," + acCount + "): " + idx);
                    }
                }
                checkBoundaries(b, bn, cases, v, w);
            }
        }

        // --- per-entity checks ---
        for (Map<String, Object> e : entities) {
            String en = str(e, "name");
            String kind = str(e, "kind");
            boolean reuse = str(e, "existingFqn") != null;
            if (kind == null || !ENTITY_KINDS.contains(kind)) {
                v.add("entity " + en + " has invalid kind: " + kind);
            }
            List<String> permits = strList(e.get("permits"));
            for (String permit : permits) {
                Optional<Map<String, Object>> target = byName(entities, permit);
                if (target.isEmpty()) {
                    v.add("entity " + en + " permit '" + permit + "' does not resolve to an entity");
                } else {
                    String pk = str(target.get(), "kind");
                    if (!"record".equals(pk) && !"class".equals(pk)) {
                        v.add("entity " + en + " permit '" + permit + "' is kind " + pk + " (must be record/class)");
                    }
                }
            }
            if ("sealed-interface".equals(kind) && !reuse && permits.size() < 2) {
                v.add("sealed-interface " + en + " has " + permits.size() + " permits (plugin refuses < 2)");
            }
            if (str(e, "ownedBy") == null) {
                if (reuse) w.add("reused entity " + en + " has no ownedBy");
                else v.add("entity " + en + " has no ownedBy");
            }
        }

        // --- variancePlan checks ---
        for (Map<String, Object> entry : mapList(model, "variancePlan")) {
            String pattern = str(entry, "pattern");
            String axis = str(entry, "axis");
            if (pattern == null || !PATTERNS.contains(pattern)) {
                v.add("variancePlan axis '" + axis + "' has invalid pattern: " + pattern);
                continue;
            }
            List<Map<String, Object>> mapping = mapList(entry, "mapping");
            switch (pattern) {
                case "rule-table" -> checkRuleTableMapping(axis, mapping, entities, v);
                case "resolver" -> checkResolverMapping(axis, mapping, entities, v);
                default -> checkSealedFamily(axis, pattern, entities, v);
            }
        }

        return new Report(v, w);
    }

    /** The created (non-reuse) record entity whose field-name set matches the
     *  rule-table mapping's expected keys — "the rule record". Empty when the
     *  model has no consistent rule-table axis. Shared with fixture gold. */
    static Optional<Map<String, Object>> findRuleRecord(Map<String, Object> model) {
        for (Map<String, Object> entry : mapList(model, "variancePlan")) {
            if (!"rule-table".equals(str(entry, "pattern"))) continue;
            List<Map<String, Object>> mapping = mapList(entry, "mapping");
            if (mapping.isEmpty()) continue;
            Set<String> expectedKeys = asMap(mapping.get(0).get("expected")).keySet();
            return mapList(model, "entities").stream()
                    .filter(e -> "record".equals(str(e, "kind")))
                    .filter(e -> str(e, "existingFqn") == null)
                    .filter(e -> fieldNames(e).equals(expectedKeys))
                    .findFirst();
        }
        return Optional.empty();
    }

    private static void checkRuleTableMapping(String axis, List<Map<String, Object>> mapping,
                                              List<Map<String, Object>> entities, List<String> v) {
        if (mapping.isEmpty()) {
            v.add("rule-table axis '" + axis + "' has empty mapping[] (sidecar would be skipped)");
            return;
        }
        Set<String> keySet = null;
        for (Map<String, Object> row : mapping) {
            if (str(row, "key") == null || str(row, "key").isBlank()) {
                v.add("rule-table axis '" + axis + "' has a mapping row with no key");
            }
            Set<String> rowKeys = asMap(row.get("expected")).keySet();
            if (keySet == null) keySet = rowKeys;
            else if (!keySet.equals(rowKeys)) {
                v.add("rule-table axis '" + axis + "' mapping rows disagree on expected keys: "
                        + keySet + " vs " + rowKeys);
                return;
            }
        }
        if (keySet == null || keySet.isEmpty()) {
            v.add("rule-table axis '" + axis + "' mapping rows have empty expected objects");
            return;
        }
        final Set<String> expectedKeys = keySet;
        boolean matched = entities.stream()
                .filter(e -> "record".equals(str(e, "kind")))
                .filter(e -> str(e, "existingFqn") == null)
                .anyMatch(e -> fieldNames(e).equals(expectedKeys));
        if (!matched) {
            v.add("rule-table axis '" + axis + "': no created record entity has fields == mapping "
                    + "expected keys " + expectedKeys + " (rule data has no consistent home)");
        }
    }

    private static void checkResolverMapping(String axis, List<Map<String, Object>> mapping,
                                             List<Map<String, Object>> entities, List<String> v) {
        if (mapping.isEmpty()) {
            v.add("resolver axis '" + axis + "' has empty mapping[] (sidecar would be skipped)");
            return;
        }
        List<String> strategies = new ArrayList<>();
        for (Map<String, Object> row : mapping) {
            String s = str(row, "strategy");
            if (s == null) v.add("resolver axis '" + axis + "' has a mapping row with no strategy");
            else strategies.add(s);
        }
        boolean matched = entities.stream()
                .filter(e -> "interface".equals(str(e, "kind")))
                .anyMatch(e -> {
                    List<String> permits = strList(e.get("permits"));
                    return !permits.isEmpty()
                            && new HashSet<>(permits).equals(new HashSet<>(strategies))
                            && permits.size() == strategies.size();
                });
        if (!matched) {
            v.add("resolver axis '" + axis + "': mapping strategies " + strategies
                    + " do not cover some interface entity's permits[] exactly once each");
        }
    }

    private static void checkSealedFamily(String axis, String pattern,
                                          List<Map<String, Object>> entities, List<String> v) {
        boolean wantBehaviors = "sealed-polymorphism".equals(pattern);
        boolean matched = entities.stream()
                .filter(e -> "sealed-interface".equals(str(e, "kind")))
                .anyMatch(e -> mapList(e, "behaviors").isEmpty() != wantBehaviors
                        && strList(e.get("permits")).size() >= 2);
        if (!matched) {
            v.add(pattern + " axis '" + axis + "': no sealed-interface entity with "
                    + (wantBehaviors ? "non-empty" : "empty") + " behaviors[] and >=2 permits");
        }
    }

    /** Plugin refuses a declared boundary without its bracketing pair: one row
     *  at the boundary value and one strictly below, per bounded arg. Values are
     *  parsed best-effort out of the Java-expression strings; unparseable rows
     *  downgrade the check to a warning. */
    private static void checkBoundaries(Map<String, Object> behavior, String bn,
                                        List<Map<String, Object>> cases,
                                        List<String> v, List<String> w) {
        Map<String, Object> boundaries = asMap(behavior.get("boundaries"));
        for (Map.Entry<String, Object> e : boundaries.entrySet()) {
            String arg = e.getKey();
            if (!(e.getValue() instanceof List<?> raw)) continue;
            for (Object bv : raw) {
                Double boundary = num(bv);
                if (boundary == null) continue;
                boolean atBoundary = false, below = false, unparseable = false;
                for (Map<String, Object> c : cases) {
                    Object expr = asMap(c.get("inputs")).get(arg);
                    Double val = firstNumber(expr);
                    if (val == null) { unparseable = expr != null; continue; }
                    if (val == boundary.doubleValue()) atBoundary = true;
                    else if (val < boundary) below = true;
                }
                if (!atBoundary || !below) {
                    if (unparseable) {
                        w.add(bn + " boundary " + arg + "=" + bv
                                + ": could not verify bracketing pair (unparseable inputs)");
                    } else {
                        v.add(bn + " boundary " + arg + "=" + bv
                                + " lacks its bracketing pair (plugin refuses)");
                    }
                }
            }
        }
    }

    // ---------- null-safe map navigation (shared with fixtures/harness) ----------

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
        return Boolean.TRUE.equals(m.get(key));
    }

    static Double num(Object v) {
        return (v instanceof Number n) ? n.doubleValue() : null;
    }

    static List<String> strList(Object o) {
        if (!(o instanceof List<?> raw)) return List.of();
        List<String> out = new ArrayList<>(raw.size());
        for (Object e : raw) if (e instanceof String s) out.add(s);
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

    static Set<String> names(List<Map<String, Object>> items) {
        Set<String> out = new LinkedHashSet<>();
        for (Map<String, Object> i : items) {
            String n = str(i, "name");
            if (n != null) out.add(n);
        }
        return out;
    }

    static Optional<Map<String, Object>> byName(List<Map<String, Object>> items, String name) {
        return items.stream().filter(i -> name.equals(str(i, "name"))).findFirst();
    }

    /** First numeric literal inside a Java-expression string, or the number itself. */
    static Double firstNumber(Object exprOrNumber) {
        if (exprOrNumber instanceof Number n) return n.doubleValue();
        if (!(exprOrNumber instanceof String s)) return null;
        Matcher m = NUMBER.matcher(s);
        return m.find() ? Double.parseDouble(m.group()) : null;
    }
}
