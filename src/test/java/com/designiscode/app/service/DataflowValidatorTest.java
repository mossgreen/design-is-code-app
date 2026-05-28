package com.designiscode.app.service;

import com.designiscode.app.dto.SequenceRequest;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DataflowValidatorTest {

    /** SUT carries petId+visitDate; sequencer calls findApplicable(petType, daysSinceLastVisit)
     *  without a prior lookup. The PetType arg flags (no PetType in scope) — surfacing
     *  one gap is enough to send the user back to add the missing lookup step, after
     *  which the int arg resolves naturally. The petclinic regression. */
    @Test
    void petclinic_missing_lookup_flags_unsourceable_object_arg() {
        Map<String, Object> visitFeeRequest = Map.of(
                "name", "VisitFeeRequest",
                "kind", "record",
                "fields", List.of(
                        Map.of("name", "petId", "type", "int"),
                        Map.of("name", "visitDate", "type", "LocalDate")
                )
        );
        Map<String, Object> sut = Map.of(
                "name", "VisitFeeCalculator",
                "behaviors", List.of(Map.of(
                        "name", "calculate",
                        "args", List.of(Map.of("name", "request", "type", "VisitFeeRequest")),
                        "returns", "BigDecimal"
                ))
        );
        Map<String, Object> repo = Map.of(
                "name", "DiscountRuleRepository",
                "behaviors", List.of(Map.of(
                        "name", "findApplicable",
                        "args", List.of(
                                Map.of("name", "petType", "type", "PetType"),
                                Map.of("name", "daysSinceLastVisit", "type", "int")
                        ),
                        "returns", "DiscountRule"
                ))
        );
        SequenceRequest req = new SequenceRequest(
                "compute the visit fee",
                List.of(sut, repo),
                List.of(visitFeeRequest),
                "VisitFeeCalculator",
                null,
                null
        );
        Map<String, Object> response = Map.of(
                "steps", List.of(Map.of(
                        "caller", "VisitFeeCalculator",
                        "callee", "DiscountRuleRepository",
                        "method", "findApplicable"
                ))
        );

        List<String> errors = SequenceService.validateDataflow(response, req);

        assertEquals(1, errors.size(), "petType (object type with no binding) must flag; daysSinceLastVisit "
                + "passes via type-match with request.petId:int — the LLM-driven fix for one is the fix for both. Got: " + errors);
        assertTrue(errors.get(0).contains("petType"));
    }

    /** Same call signature, but with a preceding PetRepository.findById(petId) that returns Pet.
     *  Pet's getType() exposes petType — both args now sourceable, zero errors. */
    @Test
    void petclinic_with_lookup_step_passes() {
        Map<String, Object> visitFeeRequest = Map.of(
                "name", "VisitFeeRequest",
                "kind", "record",
                "fields", List.of(
                        Map.of("name", "petId", "type", "int"),
                        Map.of("name", "visitDate", "type", "LocalDate"),
                        Map.of("name", "daysSinceLastVisit", "type", "int")
                )
        );
        Map<String, Object> petEntity = Map.of(
                "name", "Pet",
                "kind", "class",
                "behaviors", List.of(Map.of("name", "getType", "returns", "PetType"))
        );
        Map<String, Object> sut = Map.of(
                "name", "VisitFeeCalculator",
                "behaviors", List.of(Map.of(
                        "name", "calculate",
                        "args", List.of(Map.of("name", "request", "type", "VisitFeeRequest")),
                        "returns", "BigDecimal"
                ))
        );
        Map<String, Object> petRepo = Map.of(
                "name", "PetRepository",
                "behaviors", List.of(Map.of(
                        "name", "findById",
                        "args", List.of(Map.of("name", "id", "type", "int")),
                        "returns", "Pet"
                ))
        );
        Map<String, Object> ruleRepo = Map.of(
                "name", "DiscountRuleRepository",
                "behaviors", List.of(Map.of(
                        "name", "findApplicable",
                        "args", List.of(
                                Map.of("name", "petType", "type", "PetType"),
                                Map.of("name", "daysSinceLastVisit", "type", "int")
                        ),
                        "returns", "DiscountRule"
                ))
        );
        SequenceRequest req = new SequenceRequest(
                "compute the visit fee",
                List.of(sut, petRepo, ruleRepo),
                List.of(visitFeeRequest, petEntity),
                "VisitFeeCalculator",
                null,
                null
        );
        Map<String, Object> response = Map.of(
                "steps", List.of(
                        Map.of("caller", "VisitFeeCalculator", "callee", "PetRepository", "method", "findById"),
                        Map.of("caller", "VisitFeeCalculator", "callee", "DiscountRuleRepository", "method", "findApplicable")
                )
        );

        List<String> errors = SequenceService.validateDataflow(response, req);

        assertTrue(errors.isEmpty(), "expected zero errors with lookup, got: " + errors);
    }

    /** No SUT declared → validator is a no-op (couldn't build initial scope anyway). */
    @Test
    void empty_sut_is_a_noop() {
        SequenceRequest req = new SequenceRequest(
                "story", List.of(), List.of(), "", null, null);
        List<String> errors = SequenceService.validateDataflow(Map.of("steps", List.of()), req);
        assertTrue(errors.isEmpty());
    }

    /** Fragment with nested steps — validator must recurse and flag the inner gap. */
    @Test
    void fragment_recursion_finds_gap_in_loop_body() {
        Map<String, Object> sut = Map.of(
                "name", "OrderProcessor",
                "behaviors", List.of(Map.of(
                        "name", "process",
                        "args", List.of(Map.of("name", "orderId", "type", "int")),
                        "returns", "void"
                ))
        );
        Map<String, Object> shipper = Map.of(
                "name", "Shipper",
                "behaviors", List.of(Map.of(
                        "name", "ship",
                        "args", List.of(Map.of("name", "address", "type", "Address")),
                        "returns", "void"
                ))
        );
        SequenceRequest req = new SequenceRequest("ship", List.of(sut, shipper), List.of(), "OrderProcessor", null, null);
        Map<String, Object> response = Map.of(
                "steps", List.of(Map.of(
                        "kind", "loop",
                        "label", "for each item",
                        "steps", List.of(Map.of(
                                "caller", "OrderProcessor", "callee", "Shipper", "method", "ship"))
                ))
        );

        List<String> errors = SequenceService.validateDataflow(response, req);

        assertFalse(errors.isEmpty(), "expected gap inside the loop body");
        assertTrue(errors.get(0).contains("address"));
    }

    /** Explicit step args override the participant's declared method signature. */
    @Test
    void step_args_take_precedence_over_participant_signature() {
        Map<String, Object> sut = Map.of(
                "name", "Calc",
                "behaviors", List.of(Map.of(
                        "name", "run",
                        "args", List.of(Map.of("name", "x", "type", "int")),
                        "returns", "void"
                ))
        );
        SequenceRequest req = new SequenceRequest("run", List.of(sut), List.of(), "Calc", null, null);
        Map<String, Object> response = Map.of(
                "steps", List.of(Map.of(
                        "caller", "Calc", "callee", "Calc", "method", "newMethod",
                        "args", List.of(Map.of("name", "missing", "type", "String"))
                ))
        );

        List<String> errors = SequenceService.validateDataflow(response, req);

        assertEquals(1, errors.size());
        assertTrue(errors.get(0).contains("missing"));
    }
}
