package com.designiscode.app.eval;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Self-test of the eval's P0 tier with hand-written design models — no CLI,
 * runs in the normal suite. One fully-valid model, then one mutation per
 * violation class. This is what makes eval changes verifiable in seconds.
 */
class DesignContractValidatorTest {

    private static final int AC_COUNT = 2;

    // ---------- builders (mutable maps so tests can mutate) ----------

    private static Map<String, Object> validModel() {
        Map<String, Object> m = new HashMap<>();
        m.put("sut", "FeeCalculator");
        m.put("story", "The [FeeCalculator] asks the [RuleTable] for the rule and hands it to the [Applier].");
        m.put("variancePlan", new ArrayList<>(List.of(planEntry())));
        m.put("participants", new ArrayList<>(List.of(
                participant("FeeCalculator", false, null,
                        behavior("calculate", args("request", "FeeRequest"), "BigDecimal", null, null)),
                participant("RuleTable", true, null,
                        behavior("ruleFor", args("species", "Species"), "DiscountRule", null, null)),
                participant("Applier", true, null,
                        behavior("apply", args("rule", "DiscountRule"), "BigDecimal",
                                new ArrayList<>(List.of(
                                        caseRow(0, Map.of("rule", "new DiscountRule(20, 20)"), "new BigDecimal(\"40\")"),
                                        caseRow(1, Map.of("rule", "new DiscountRule(40, 10)"), "new BigDecimal(\"45\")"))),
                                null)))));
        m.put("entities", new ArrayList<>(List.of(
                entity("DiscountRule", "record", "RuleTable", fields("windowDays", "percentOff"), null, null),
                entity("Species", "enum", "RuleTable", null, List.of("CAT", "DOG"), null),
                entity("FeeRequest", "record", "FeeCalculator", fields("species", "daysSince"), null, null))));
        return m;
    }

    private static Map<String, Object> planEntry() {
        Map<String, Object> e = new HashMap<>();
        e.put("axis", "species -> DiscountRule");
        e.put("pattern", "rule-table");
        e.put("criterion", 1);
        e.put("rationale", "cases differ only in data values");
        e.put("mapping", new ArrayList<>(List.of(
                mappingRow("CAT", Map.of("windowDays", 20, "percentOff", 20)),
                mappingRow("DOG", Map.of("windowDays", 40, "percentOff", 10)))));
        return e;
    }

    @SafeVarargs
    private static Map<String, Object> participant(String name, boolean leaf, String fqn,
                                                   Map<String, Object>... behaviors) {
        Map<String, Object> p = new HashMap<>();
        p.put("name", name);
        p.put("isLeaf", leaf);
        if (fqn != null) p.put("existingFqn", fqn);
        p.put("purpose", "Serves a need.");
        p.put("acIndices", new ArrayList<>(List.of(0, 1)));
        p.put("behaviors", new ArrayList<>(List.of(behaviors)));
        return p;
    }

    private static Map<String, Object> behavior(String name, List<Map<String, Object>> args,
                                                String returns, List<Map<String, Object>> cases,
                                                Map<String, Object> boundaries) {
        Map<String, Object> b = new HashMap<>();
        b.put("name", name);
        b.put("args", args);
        b.put("returns", returns);
        if (cases != null) b.put("cases", cases);
        if (boundaries != null) b.put("boundaries", boundaries);
        return b;
    }

    private static List<Map<String, Object>> args(String name, String type) {
        Map<String, Object> a = new HashMap<>();
        a.put("name", name);
        a.put("type", type);
        return new ArrayList<>(List.of(a));
    }

    private static Map<String, Object> caseRow(Integer acIndex, Map<String, String> inputs, String expected) {
        Map<String, Object> c = new HashMap<>();
        c.put("acIndex", acIndex);
        c.put("description", "row");
        c.put("inputs", new HashMap<>(inputs));
        c.put("expected", expected);
        return c;
    }

    private static Map<String, Object> mappingRow(String key, Map<String, Object> expected) {
        Map<String, Object> r = new HashMap<>();
        r.put("key", key);
        r.put("expected", new HashMap<>(expected));
        return r;
    }

    private static Map<String, Object> entity(String name, String kind, String ownedBy,
                                              List<Map<String, Object>> fields,
                                              List<String> values, List<String> permits) {
        Map<String, Object> e = new HashMap<>();
        e.put("name", name);
        e.put("kind", kind);
        e.put("ownedBy", ownedBy);
        if (fields != null) e.put("fields", fields);
        if (values != null) e.put("values", new ArrayList<>(values));
        if (permits != null) e.put("permits", new ArrayList<>(permits));
        return e;
    }

    private static List<Map<String, Object>> fields(String... names) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (String n : names) {
            Map<String, Object> f = new HashMap<>();
            f.put("name", n);
            f.put("type", "int");
            out.add(f);
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(Map<String, Object> m, String key) {
        return (List<Map<String, Object>>) m.get(key);
    }

    private static List<String> violations(Map<String, Object> model) {
        return DesignContractValidator.validate(model, AC_COUNT).violations();
    }

    private static void assertViolationContaining(Map<String, Object> model, String fragment) {
        List<String> v = violations(model);
        assertTrue(v.stream().anyMatch(s -> s.contains(fragment)),
                "expected a violation containing '" + fragment + "', got " + v);
    }

    // ---------- the one valid model ----------

    @Test
    void validModelHasNoViolations() {
        assertEquals(List.of(), violations(validModel()));
    }

    @Test
    void validModelGoldChecksPass() {
        assertEquals(List.of(), new VisitFeeFixture().goldChecks(validModel()));
    }

    // ---------- one mutation per violation class ----------

    @Test
    void missingSutIsViolation() {
        Map<String, Object> m = validModel();
        m.put("sut", "Nobody");
        assertViolationContaining(m, "sut 'Nobody'");
    }

    @Test
    void participantEntityNameOverlapIsViolation() {
        Map<String, Object> m = validModel();
        list(m, "entities").add(entity("RuleTable", "record", "RuleTable", fields("x"), null, null));
        assertViolationContaining(m, "BOTH participants[] and entities[]");
    }

    @Test
    void reusedNonLeafIsViolation() {
        Map<String, Object> m = validModel();
        list(m, "participants").get(0).put("existingFqn", "com.foo.FeeCalculator");
        assertViolationContaining(m, "existingFqn but isLeaf!=true");
    }

    @Test
    void caseInputsArgsMismatchIsViolation() {
        Map<String, Object> m = validModel();
        Map<String, Object> applier = list(m, "participants").get(2);
        Map<String, Object> apply = list(applier, "behaviors").get(0);
        list(apply, "cases").get(0).put("inputs", new HashMap<>(Map.of("wrongArg", "1")));
        assertViolationContaining(m, "inputs keys");
    }

    @Test
    void acIndexOutOfRangeIsViolation() {
        Map<String, Object> m = validModel();
        Map<String, Object> applier = list(m, "participants").get(2);
        Map<String, Object> apply = list(applier, "behaviors").get(0);
        list(apply, "cases").get(0).put("acIndex", 7);
        assertViolationContaining(m, "acIndex out of range");
    }

    @Test
    void danglingPermitIsViolation() {
        Map<String, Object> m = validModel();
        list(m, "entities").add(entity("Channel", "sealed-interface", "FeeCalculator",
                null, null, List.of("Email", "Sms")));
        list(m, "entities").add(entity("Email", "record", "FeeCalculator", fields("addr"), null, null));
        // "Sms" is never declared
        assertViolationContaining(m, "permit 'Sms' does not resolve");
    }

    @Test
    void singlePermitSealedFamilyIsViolation() {
        Map<String, Object> m = validModel();
        list(m, "entities").add(entity("Channel", "sealed-interface", "FeeCalculator",
                null, null, List.of("Email")));
        list(m, "entities").add(entity("Email", "record", "FeeCalculator", fields("addr"), null, null));
        assertViolationContaining(m, "plugin refuses < 2");
    }

    @Test
    void missingOwnerIsViolation() {
        Map<String, Object> m = validModel();
        list(m, "entities").get(0).remove("ownedBy");
        assertViolationContaining(m, "no ownedBy");
    }

    @Test
    void emptyRuleTableMappingIsViolation() {
        Map<String, Object> m = validModel();
        list(m, "variancePlan").get(0).put("mapping", new ArrayList<>());
        assertViolationContaining(m, "empty mapping[]");
    }

    @Test
    void mappingKeysWithoutMatchingRecordIsViolation() {
        Map<String, Object> m = validModel();
        // rename one record field so no entity matches the mapping's expected keys
        list(m, "entities").get(0).put("fields", fields("windowDays", "discountPct"));
        assertViolationContaining(m, "no created record entity has fields == mapping");
    }

    @Test
    void renamedFieldsStayValidWhenConsistent() {
        // The point of name-agnostic gold: rename fields EVERYWHERE consistently -> still valid.
        Map<String, Object> m = validModel();
        list(m, "entities").get(0).put("fields", fields("recencyDays", "discountPct"));
        List<Map<String, Object>> mapping = list(list(m, "variancePlan").get(0), "mapping");
        mapping.get(0).put("expected", new HashMap<>(Map.of("recencyDays", 20, "discountPct", 20)));
        mapping.get(1).put("expected", new HashMap<>(Map.of("recencyDays", 40, "discountPct", 10)));
        assertEquals(List.of(), violations(m));
        assertEquals(List.of(), new VisitFeeFixture().goldChecks(m));
    }

    @Test
    void invalidPatternIsViolation() {
        Map<String, Object> m = validModel();
        list(m, "variancePlan").get(0).put("pattern", "strategy-factory");
        assertViolationContaining(m, "invalid pattern");
    }

    @Test
    void unbracketedBoundaryIsViolation() {
        Map<String, Object> m = validModel();
        Map<String, Object> applier = list(m, "participants").get(2);
        Map<String, Object> apply = list(applier, "behaviors").get(0);
        apply.put("boundaries", new HashMap<>(Map.of("rule", List.of(99))));
        assertViolationContaining(m, "lacks its bracketing pair");
    }

    @Test
    void bracketedBoundaryPasses() {
        Map<String, Object> m = validModel();
        Map<String, Object> applier = list(m, "participants").get(2);
        Map<String, Object> apply = list(applier, "behaviors").get(0);
        list(apply, "cases").add(caseRow(null, Map.of("rule", "19"), "new BigDecimal(\"40\")"));
        list(apply, "cases").add(caseRow(null, Map.of("rule", "20"), "new BigDecimal(\"50\")"));
        apply.put("boundaries", new HashMap<>(Map.of("rule", List.of(20))));
        assertEquals(List.of(), violations(m));
    }

    @Test
    void resolverMappingMustCoverInterfacePermits() {
        Map<String, Object> m = validModel();
        Map<String, Object> entry = new HashMap<>();
        entry.put("axis", "channel -> Sender");
        entry.put("pattern", "resolver");
        entry.put("criterion", 2);
        entry.put("mapping", new ArrayList<>(List.of(
                mappingRowStrategy("EMAIL", "EmailSender"))));
        list(m, "variancePlan").add(entry);
        list(m, "entities").add(entity("Sender", "interface", "FeeCalculator",
                null, null, List.of("EmailSender", "SmsSender")));
        list(m, "entities").add(entity("EmailSender", "class", "FeeCalculator", fields(), null, null));
        list(m, "entities").add(entity("SmsSender", "class", "FeeCalculator", fields(), null, null));
        assertViolationContaining(m, "do not cover some interface entity's permits");

        // complete the mapping -> valid
        list(entry, "mapping").add(mappingRowStrategy("SMS", "SmsSender"));
        assertEquals(List.of(), violations(m));
    }

    private static Map<String, Object> mappingRowStrategy(String key, String strategy) {
        Map<String, Object> r = new HashMap<>();
        r.put("key", key);
        r.put("strategy", strategy);
        return r;
    }
}
