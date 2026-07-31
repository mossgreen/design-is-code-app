package com.designiscode.app.eval;

import com.designiscode.app.service.DesignContractValidator;

import com.designiscode.app.dto.AcRow;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import static com.designiscode.app.service.DesignContractValidator.asMap;
import static com.designiscode.app.service.DesignContractValidator.bool;
import static com.designiscode.app.service.DesignContractValidator.mapList;
import static com.designiscode.app.service.DesignContractValidator.num;
import static com.designiscode.app.service.DesignContractValidator.str;

/**
 * Pet-visit-fee discount fixture. Doubles as the regression test for the
 * "rule-table compiles-but-doesn't-run" bug: the rule data (cat=20d/20%,
 * dog=40d/10%) must land in a fillable pure-function leaf, and the applier
 * must carry {@code cases[]} — not ship as stubs.
 *
 * <p>All gold is <b>value-based and name-agnostic</b>: the model may call the
 * rule record's fields anything ({@code windowDays} / {@code recencyDays} /
 * …); what is asserted is that the CAT row carries the value set {20, 20},
 * the DOG row {40, 10}, the record is returned by a non-mocked leaf, and the
 * cases produce $40 / $45. (The old eval failed correct designs on exact
 * field names — see the run that died on "field 'percentOff' not a number".)
 */
final class VisitFeeFixture implements EvalFixture {

    private static final Pattern REPO = Pattern.compile("(?i)repository");

    @Override
    public String name() {
        return "pet-visit-fee";
    }

    @Override
    public String story() {
        return """
                A veterinary clinic charges a $50 base visit fee. Loyal customers get a
                discount on the visit fee, but the discount depends on the pet's species:
                the discount percentage and the "recent visit" eligibility window (how many
                days since the last visit still counts as recent) differ per species.
                Cats get a larger discount with a shorter recency window; dogs get a smaller
                discount with a longer window. Compute the final visit fee for a pet given
                its species, the days since its last visit, and the base fee.
                """;
    }

    @Override
    public List<AcRow> acRows() {
        return List.of(
                new AcRow(
                        "a cat last visited 10 days ago",
                        "the visit fee is computed on a $50 base",
                        "the fee is $40 (20% off; recent-visit window is 20 days)"),
                new AcRow(
                        "a dog last visited 30 days ago",
                        "the visit fee is computed on a $50 base",
                        "the fee is $45 (10% off; recent-visit window is 40 days)"));
    }

    @Override
    public List<String> goldChecks(Map<String, Object> model) {
        List<String> f = new ArrayList<>();
        int acCount = acRows().size(); // 2

        // 1. Exactly one rule-table axis.
        List<Map<String, Object>> ruleTables = mapList(model, "variancePlan").stream()
                .filter(e -> "rule-table".equals(str(e, "pattern")))
                .toList();
        if (ruleTables.size() != 1) {
            f.add("expected exactly one rule-table variancePlan entry, got " + ruleTables.size()
                    + " (patterns=" + mapList(model, "variancePlan").stream()
                            .map(e -> str(e, "pattern")).toList() + ")");
            return f; // downstream gold depends on the mapping
        }

        // 2. Mapping covers CAT and DOG with the right VALUES (names ignored).
        Map<String, List<Double>> valuesByKey = new HashMap<>();
        for (Map<String, Object> row : mapList(ruleTables.get(0), "mapping")) {
            String key = str(row, "key");
            if (key == null) continue;
            List<Double> values = asMap(row.get("expected")).values().stream()
                    .map(DesignContractValidator::num)
                    .filter(java.util.Objects::nonNull)
                    .sorted()
                    .toList();
            valuesByKey.put(key.trim().toUpperCase(Locale.ROOT), values);
        }
        checkValues(f, valuesByKey, "CAT", List.of(20.0, 20.0));
        checkValues(f, valuesByKey, "DOG", List.of(10.0, 40.0));

        // 3. The rule record (identified name-agnostically by the contract
        //    validator) is returned by a behavior on a non-mocked leaf.
        Optional<Map<String, Object>> ruleRecord = DesignContractValidator.findRuleRecord(model);
        if (ruleRecord.isEmpty()) {
            f.add("no created record entity matches the mapping's expected keys (no rule record)");
        } else {
            String recordName = str(ruleRecord.get(), "name");
            boolean homed = mapList(model, "participants").stream()
                    .filter(p -> bool(p, "isLeaf"))
                    .filter(p -> str(p, "existingFqn") == null)
                    .filter(p -> {
                        String n = str(p, "name");
                        return n != null && !REPO.matcher(n).find();
                    })
                    .flatMap(p -> mapList(p, "behaviors").stream())
                    .anyMatch(b -> recordName.equals(str(b, "returns")));
            if (!homed) {
                f.add("rule record " + recordName + " is not returned by any behavior on a "
                        + "non-reuse, non-*Repository leaf (rule data would be mocked, not run)");
            }
        }

        // 4. Some leaf behavior's cases cover both AC rows with the right fees.
        Map<Integer, String> expectedDigits = Map.of(0, "40", 1, "45");
        boolean covered = mapList(model, "participants").stream()
                .filter(p -> bool(p, "isLeaf"))
                .flatMap(p -> mapList(p, "behaviors").stream())
                .anyMatch(b -> {
                    Map<Integer, String> byIndex = new HashMap<>();
                    for (Map<String, Object> c : mapList(b, "cases")) {
                        Double idx = num(c.get("acIndex"));
                        Object expected = c.get("expected");
                        if (idx != null && expected != null) {
                            byIndex.put(idx.intValue(), String.valueOf(expected));
                        }
                    }
                    return expectedDigits.entrySet().stream().allMatch(e ->
                            byIndex.containsKey(e.getKey())
                                    && byIndex.get(e.getKey()).contains(e.getValue()));
                });
        if (!covered) {
            f.add("no leaf behavior carries cases[] covering acIndex 0 (expected containing \"40\") "
                    + "and acIndex 1 (expected containing \"45\") — the varying leaf would ship as a stub; "
                    + "case-lengths seen=" + caseLengths(model));
        }

        // 5. AC coverage: every row carried by at least one participant.
        for (int i = 0; i < acCount; i++) {
            final int idx = i;
            boolean carried = mapList(model, "participants").stream()
                    .anyMatch(p -> p.get("acIndices") instanceof List<?> l
                            && l.stream().anyMatch(o -> o instanceof Number n && n.intValue() == idx));
            if (!carried) f.add("AC row " + idx + " is not carried by any participant (acIndices)");
        }

        return f;
    }

    private static void checkValues(List<String> f, Map<String, List<Double>> valuesByKey,
                                    String key, List<Double> gold) {
        List<Double> actual = valuesByKey.get(key);
        if (actual == null) {
            f.add("no mapping row for key " + key + " (keys present=" + valuesByKey.keySet() + ")");
        } else if (!actual.equals(gold)) {
            f.add("mapping row " + key + " expected values " + gold + " (any field names), got " + actual);
        }
    }

    private static List<Integer> caseLengths(Map<String, Object> model) {
        return mapList(model, "participants").stream()
                .flatMap(p -> mapList(p, "behaviors").stream())
                .map(b -> mapList(b, "cases").size())
                .collect(Collectors.toList());
    }
}
