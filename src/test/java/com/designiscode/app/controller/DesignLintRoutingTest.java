package com.designiscode.app.controller;

import com.designiscode.app.service.DesignService;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@code POST /api/design/lint} judges a design against two different rule
 * families, and this pins that it reports them <b>separately</b>.
 *
 * <p>The separation is not tidiness. A <em>flow</em> violation ("this call
 * consumes a value nothing produces") is something the sequencer can fix, and
 * {@code runSequence()} retries it by handing the sequencer exactly that
 * complaint. A <em>contract</em> violation ("this sealed family has one permit")
 * is grammar: the sequencer emits an ordered call list and nothing else, so it
 * cannot repair one. When both families shared a single {@code violations} list,
 * a grammar problem was fed to the sequencer wrapped in a prompt about arguments
 * — a complaint sent to the component that does not own the thing complained
 * about, describing a different problem than the one that occurred.
 *
 * <p>So: if these two lists ever merge again, this test fails.
 */
class DesignLintRoutingTest {

    private final DesignController controller = new DesignController(new DesignService());

    private static final String CLEAN_PUML = """
            @startuml
            participant CancelVisitService
            participant FeePolicy
            [*] -> CancelVisitService : cancel(ownerId : int) : Fee
            CancelVisitService -> FeePolicy : feeFor(ownerId : int) : Fee
            CancelVisitService <-- FeePolicy : fee : Fee
            CancelVisitService --> [*] : fee : Fee
            @enduml
            """;

    /** A design whose only fault is grammar: a sealed family with one permit. */
    private static Map<String, Object> oneWithAContractFault() {
        return Map.of(
                "story", "An owner cancels a visit.",
                "sut", "CancelVisitService",
                "participants", List.of(
                        Map.of("name", "CancelVisitService", "isLeaf", false, "behaviors", List.of(
                                Map.of("name", "cancel", "args", List.of(), "returns", "Fee"))),
                        Map.of("name", "FeePolicy", "isLeaf", true, "behaviors", List.of(
                                Map.of("name", "feeFor", "args", List.of(), "returns", "Fee")))),
                "entities", List.of(
                        Map.of("name", "Fee", "kind", "sealed-interface",
                                "ownedBy", "CancelVisitService", "permits", List.of("OnlyOne")),
                        Map.of("name", "OnlyOne", "kind", "record", "ownedBy", "CancelVisitService")),
                "variancePlan", List.of());
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> lint(Map<String, Object> request) {
        ResponseEntity<?> res = controller.lint(request);
        assertEquals(200, res.getStatusCode().value());
        return assertInstanceOf(Map.class, res.getBody());
    }

    @SuppressWarnings("unchecked")
    private static List<String> list(Map<String, Object> body, String key) {
        return (List<String>) body.get(key);
    }

    @Test
    void aContractFaultNeverLandsInTheFlowViolationsTheSequencerRetriesOn() {
        Map<String, Object> body = lint(Map.of(
                "puml", CLEAN_PUML,
                "model", oneWithAContractFault(),
                "acCount", 1));

        assertTrue(list(body, "contractViolations").stream().anyMatch(v -> v.contains("permits")),
                () -> "the one-permit family should be reported: " + body.get("contractViolations"));
        assertTrue(list(body, "violations").isEmpty(),
                () -> "a grammar fault reached the list that drives the sequencer retry — "
                        + "the sequencer cannot fix a sealed family: " + body.get("violations"));
    }

    /**
     * And the other direction, so the separation is not just "contract findings go
     * nowhere": a client that sends no model still gets the flow verdict, and gets
     * empty contract lists rather than a missing key.
     */
    @Test
    void aClientThatSendsNoModelGetsTheFlowVerdictAndNoContractNoise() {
        Map<String, Object> body = lint(Map.of("puml", CLEAN_PUML));

        assertTrue(list(body, "contractViolations").isEmpty(),
                () -> "no model was sent, so nothing can be said about the contract: "
                        + body.get("contractViolations"));
        assertTrue(list(body, "contractWarnings").isEmpty());
        assertTrue(body.containsKey("violations"), "the flow verdict must still be reported");
    }
}
