package com.designiscode.app.service;

import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DesignDelta.MappingRow;
import com.designiscode.app.dto.DiffResult;
import com.designiscode.app.dto.VariantRequest;
import org.junit.jupiter.api.Test;

import java.util.List;

import static com.designiscode.app.service.Goldens.assertGolden;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The auto-generated PR body for the delta half (demo.md): a generate delta
 * renders the review tables; an ask renders the one sharp question and
 * nothing generative.
 */
class DeltaRendererTest {

    private final CodeDesignDiffService pipeline = new CodeDesignDiffService(
            new CallGraphDeriver(), new BindingTimeClassifier(), new DesignDiffer(),
            new DesignDeltaEmitter(), new DesignService(),
            new SliceRenderer(), new DeltaRenderer(),
            new CounterfactualRenderer(), new WhyRenderer());

    @Test
    void act2GenerateDeltaRendersReviewTables() {
        DiffResult result = pipeline.run(
                PetclinicFixtures.sources("act2"),
                "CancelVisitService", "cancel",
                "initiator", null,
                new VariantRequest("CancellationFeePolicy", "ClinicInitiatedFee",
                        List.of(new MappingRow("owner", "StandardCancellationFee"),
                                new MappingRow("clinic", "ClinicInitiatedFee")),
                        null));
        assertEquals(DesignDelta.GENERATE, result.disposition());
        assertGolden("delta-act2.md", result.deltaMarkdown());
    }

    @Test
    void askDeltaRendersTheOneSharpQuestion() {
        // "mode" is neither an entry param nor a config token in act1 → ask.
        DiffResult result = pipeline.run(
                PetclinicFixtures.sources("act1"),
                "VisitController", "processNewVisitForm",
                "mode", null,
                new VariantRequest("OwnerRepository", "CachingOwnerRepository",
                        List.of(new MappingRow("db", "OwnerRepository"),
                                new MappingRow("cache", "CachingOwnerRepository")),
                        null));
        assertEquals(DesignDelta.ASK, result.disposition());
        assertTrue(result.deltaMarkdown().contains("**Question:**"));
        assertGolden("delta-ask.md", result.deltaMarkdown());
    }
}
