package com.designiscode.app.service;

import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DesignDelta.MappingRow;
import com.designiscode.app.dto.DiffResult;
import com.designiscode.app.dto.VariantRequest;
import org.junit.jupiter.api.Test;

import java.util.List;

import static com.designiscode.app.service.Goldens.assertGolden;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * The Act-2 round trip (demo.md): the variance ticket "clinic-initiated
 * cancellations are free" runs the full A–E pipeline over the act2 fixtures —
 * the expected Act-1 output, which is DisC-shaped, so capture is complete and
 * the orchestrator is emitted {@code <<@regen:...>>} for wholesale overwrite.
 *
 * <p>Artifacts are pinned <b>byte-equal</b> against goldens under
 * {@code src/test/resources/goldens/petclinic/}. To regenerate after an
 * intentional emitter change: run once with {@code DISC_UPDATE_GOLDENS=true},
 * eyeball the diff, commit.
 */
class CodeDesignDiffPetclinicRoundTripTest {

    private final CodeDesignDiffService pipeline = new CodeDesignDiffService(
            new CallGraphDeriver(), new BindingTimeClassifier(), new DesignDiffer(),
            new DesignDeltaEmitter(), new DesignService(),
            new SliceRenderer(), new DeltaRenderer(),
            new CounterfactualRenderer(), new WhyRenderer());

    @Test
    void act2VarianceTicketGeneratesRegenArtifacts() {
        DiffResult result = pipeline.run(
                PetclinicFixtures.sources("act2"),
                "CancelVisitService", "cancel",
                "initiator",
                "The cancellation form records who initiated the cancellation. "
                        + "Clinic-initiated cancellations are always free; "
                        + "owner-initiated cancellations keep the 48-hour rule.",
                new VariantRequest("CancellationFeePolicy", "ClinicInitiatedFee",
                        List.of(new MappingRow("owner", "StandardCancellationFee"),
                                new MappingRow("clinic", "ClinicInitiatedFee")),
                        null));

        assertEquals(DesignDelta.GENERATE, result.disposition());
        assertEquals(BindingTimeClassifier.BT_REQUEST_DYNAMIC, result.classification().bindingTime());
        assertEquals(BindingTimeClassifier.SRC_REQUEST, result.classification().discriminatorSource());
        assertEquals(DesignDelta.SUT_REGEN, result.delta().sutMode(),
                () -> "act2 fixtures must be REGEN-clean; gaps would mean the fixture broke: "
                        + result.warnings());
        assertEquals(List.of(), result.validationViolations());
        assertEquals(List.of(), result.warnings());

        assertEquals("CancellationFeePolicyResolver", result.delta().resolver());
        assertEquals(List.of("StandardCancellationFee", "ClinicInitiatedFee"), result.delta().permits());

        assertNotNull(result.artifacts());
        assertEquals("CancelVisitService.puml", result.artifacts().pumlFileName());
        assertEquals(1, result.artifacts().sidecars().size());
        assertEquals("CancellationFeePolicyResolver.decision.md",
                result.artifacts().sidecars().get(0).fileName());

        assertGolden("CancelVisitService.puml", result.artifacts().puml());
        assertGolden("CancellationFeePolicyResolver.decision.md",
                result.artifacts().sidecars().get(0).content());

        // Stage-D before/after review pair
        assertNotNull(result.oldWayModel());
        assertNotNull(result.newWayModel());
        assertGolden("oldway-act2.puml", result.oldWayPuml());
        assertGolden("why-act2.md", result.whyMarkdown());
    }
}
