package com.designiscode.app.service;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class VariancePlanValidatorTest {

    @Test
    void empty_rule_table_mapping_is_flagged() {
        Map<String, Object> response = Map.of(
                "variancePlan", List.of(Map.of(
                        "axis", "discount per species",
                        "pattern", "rule-table",
                        "mapping", List.of()
                )),
                "participants", List.of(),
                "entities", List.of()
        );

        List<String> errors = AnalyzeService.validateVariancePlan(response);

        assertEquals(1, errors.size());
        assertTrue(errors.get(0).contains("rule-table"));
        assertTrue(errors.get(0).contains("empty"));
    }

    @Test
    void empty_resolver_mapping_is_flagged() {
        Map<String, Object> response = Map.of(
                "variancePlan", List.of(Map.of(
                        "axis", "strategy per channel",
                        "pattern", "resolver"
                )),
                "participants", List.of(),
                "entities", List.of()
        );

        List<String> errors = AnalyzeService.validateVariancePlan(response);

        assertEquals(1, errors.size());
        assertTrue(errors.get(0).contains("resolver"));
    }

    @Test
    void populated_rule_table_is_clean() {
        Map<String, Object> response = Map.of(
                "variancePlan", List.of(Map.of(
                        "axis", "discount per species",
                        "pattern", "rule-table",
                        "mapping", List.of(
                                Map.of("key", "cat", "expected", Map.of("windowDays", 20, "percentOff", 20)),
                                Map.of("key", "dog", "expected", Map.of("windowDays", 30, "percentOff", 10))
                        )
                )),
                "participants", List.of(),
                "entities", List.of()
        );

        List<String> errors = AnalyzeService.validateVariancePlan(response);

        assertTrue(errors.isEmpty(), "expected no errors, got: " + errors);
    }

    @Test
    void sealed_polymorphism_does_not_require_mapping() {
        Map<String, Object> response = Map.of(
                "variancePlan", List.of(Map.of(
                        "axis", "renderer per node",
                        "pattern", "sealed-polymorphism"
                )),
                "participants", List.of(),
                "entities", List.of()
        );

        List<String> errors = AnalyzeService.validateVariancePlan(response);

        assertTrue(errors.isEmpty(), "expected no errors for sealed-polymorphism, got: " + errors);
    }

    @Test
    void cases_length_must_match_acIndices_length_on_leaf() {
        Map<String, Object> participant = Map.of(
                "name", "DiscountApplier",
                "isLeaf", true,
                "acIndices", List.of(0, 1, 2),
                "behaviors", List.of(Map.of(
                        "name", "apply",
                        "args", List.of(Map.of("name", "fee", "type", "BigDecimal")),
                        "returns", "BigDecimal",
                        "cases", List.of(
                                Map.of("acIndex", 0, "inputs", Map.of("fee", "100"), "expected", "80"),
                                Map.of("acIndex", 1, "inputs", Map.of("fee", "100"), "expected", "90")
                        )
                ))
        );
        Map<String, Object> response = Map.of(
                "participants", List.of(participant),
                "variancePlan", List.of(),
                "entities", List.of()
        );

        List<String> errors = AnalyzeService.validateVariancePlan(response);

        assertEquals(1, errors.size());
        assertTrue(errors.get(0).contains("DiscountApplier"));
        assertTrue(errors.get(0).contains("cases.length=2"));
        assertTrue(errors.get(0).contains("acIndices.length=3"));
    }

    @Test
    void cases_omitted_on_leaf_is_allowed() {
        Map<String, Object> participant = Map.of(
                "name", "DiscountApplier",
                "isLeaf", true,
                "acIndices", List.of(0, 1),
                "behaviors", List.of(Map.of(
                        "name", "apply",
                        "args", List.of(),
                        "returns", "BigDecimal"
                ))
        );
        Map<String, Object> response = Map.of(
                "participants", List.of(participant),
                "variancePlan", List.of(),
                "entities", List.of()
        );

        List<String> errors = AnalyzeService.validateVariancePlan(response);

        assertTrue(errors.isEmpty(), "cases is optional; omitting is fine");
    }

    @Test
    void nonleaf_participants_are_ignored_by_cases_check() {
        Map<String, Object> participant = Map.of(
                "name", "VisitFeeCalculator",
                "isLeaf", false,
                "acIndices", List.of(0, 1, 2),
                "behaviors", List.of()
        );
        Map<String, Object> response = Map.of(
                "participants", List.of(participant),
                "variancePlan", List.of(),
                "entities", List.of()
        );

        List<String> errors = AnalyzeService.validateVariancePlan(response);

        assertTrue(errors.isEmpty());
    }

    @Test
    void null_or_missing_variancePlan_is_clean() {
        List<String> errors = AnalyzeService.validateVariancePlan(Map.of());
        assertFalse(errors == null);
        assertTrue(errors.isEmpty());
    }
}
