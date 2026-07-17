package com.designiscode.app.service;

import com.designiscode.app.dto.DiagramModel;
import com.designiscode.app.dto.DiagramModel.Step;
import com.designiscode.app.dto.DesignDelta.MappingRow;
import com.designiscode.app.dto.DiffResult;
import com.designiscode.app.dto.VariantRequest;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The before/after pair for the act2 variance ticket: the old-way
 * counterfactual carries one alt branch per mapping key with the concrete
 * strategies inline; the new-way model rewrites only the variation point to
 * resolve→dispatch. Everything around the variation point must be identical
 * on both sides — that is what makes the comparison honest.
 */
class CounterfactualRendererTest {

    private final CodeDesignDiffService pipeline = new CodeDesignDiffService(
            new CallGraphDeriver(), new BindingTimeClassifier(), new DesignDiffer(),
            new DesignDeltaEmitter(), new DesignService(),
            new SliceRenderer(), new DeltaRenderer(),
            new CounterfactualRenderer(), new WhyRenderer());

    private DiffResult act2() {
        return pipeline.run(
                PetclinicFixtures.sources("act2"),
                "CancelVisitService", "cancel",
                "initiator", null,
                new VariantRequest("CancellationFeePolicy", "ClinicInitiatedFee",
                        List.of(new MappingRow("owner", "StandardCancellationFee"),
                                new MappingRow("clinic", "ClinicInitiatedFee")),
                        null));
    }

    @Test
    void oldWayBranchesPerMappingKeyWithConcreteStrategies() {
        DiagramModel m = act2().oldWayModel();
        assertNotNull(m);

        List<Step> alts = m.steps().stream()
                .filter(s -> s.kind().startsWith("alt-")).toList();
        assertEquals(List.of("alt-start", "alt-else", "alt-end"),
                alts.stream().map(Step::kind).toList());
        assertEquals("initiator == owner", alts.get(0).label());
        assertEquals("initiator == clinic", alts.get(1).label());

        // the orchestrator calls each concrete strategy inline — that IS the pain
        assertTrue(m.participants().contains("StandardCancellationFee"));
        assertTrue(m.participants().contains("ClinicInitiatedFee"));
        assertTrue(m.steps().stream().anyMatch(s -> "call".equals(s.kind())
                && "StandardCancellationFee".equals(s.to()) && s.label().startsWith("feeFor(")));
        assertTrue(m.steps().stream().anyMatch(s -> "call".equals(s.kind())
                && "ClinicInitiatedFee".equals(s.to()) && s.label().startsWith("feeFor(")));
    }

    @Test
    void nonVariationCallsIdenticalOnBothSides() {
        DiffResult r = act2();
        List<Step> oldOther = withoutVariation(r.oldWayModel(),
                List.of("StandardCancellationFee", "ClinicInitiatedFee"));
        List<Step> newOther = withoutVariation(r.newWayModel(),
                List.of("CancellationFeePolicyResolver", "CancellationFeePolicy"));
        assertEquals(oldOther, newOther,
                "the two diagrams must differ only at the variation point");
        assertTrue(oldOther.stream().anyMatch(s -> "OwnerLoader".equals(s.to())));
        assertTrue(oldOther.stream().anyMatch(s -> "CancellationGuard".equals(s.to())));
        assertTrue(oldOther.stream().anyMatch(s -> "OwnerRepository".equals(s.to())));
    }

    @Test
    void newWayResolvesThenDispatchesOnTheAbstraction() {
        DiagramModel m = act2().newWayModel();
        assertNotNull(m);
        assertTrue(m.participants().contains("CancellationFeePolicyResolver"));
        assertTrue(m.participants().contains("CancellationFeePolicy"));

        List<Step> steps = m.steps();
        int resolve = indexOfCall(steps, "CancellationFeePolicyResolver");
        int dispatch = indexOfCall(steps, "CancellationFeePolicy");
        assertTrue(resolve >= 0 && dispatch > resolve, "resolve precedes dispatch");
        assertTrue(steps.stream().noneMatch(s -> s.kind().startsWith("alt-")),
                "no branch at the orchestrator in the new design");
    }

    @Test
    void oldWayPumlRendersAltBlock() {
        String puml = act2().oldWayPuml();
        assertNotNull(puml);
        assertTrue(puml.contains("alt initiator == owner"));
        assertTrue(puml.contains("else initiator == clinic"));
        assertTrue(puml.contains("end\n"));
        assertTrue(puml.contains("[*] -> CancelVisitService : cancel("));
    }

    // steps not touching the variation-point participants, alt markers dropped
    private static List<Step> withoutVariation(DiagramModel m, List<String> variationParticipants) {
        return m.steps().stream()
                .filter(s -> !s.kind().startsWith("alt-"))
                .filter(s -> !variationParticipants.contains(s.from())
                        && !variationParticipants.contains(s.to()))
                .toList();
    }

    private static int indexOfCall(List<Step> steps, String to) {
        for (int i = 0; i < steps.size(); i++) {
            if ("call".equals(steps.get(i).kind()) && to.equals(steps.get(i).to())) return i;
        }
        return -1;
    }
}
