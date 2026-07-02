package com.designiscode.app.service;

import com.designiscode.app.dto.ApplyArtifacts;
import com.designiscode.app.dto.BindingClassification;
import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DesignRequest;
import com.designiscode.app.dto.DesignResult;
import com.designiscode.app.dto.DiffResult;
import com.designiscode.app.dto.VariantRequest;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * Orchestrates the code→design diff pipeline end to end: Stage A (derive) →
 * Stage B (classify) → Stage C (diff) → delta validation → Stage E (emit).
 * This is the seam the HTTP endpoint and the round-trip eval golden both drive.
 *
 * <p>{@link #run} is pure (no I/O); {@link #apply} writes the emitted artifacts
 * into {@code <project>/design/} by reusing {@link DesignService}.
 */
@Service
public class CodeDesignDiffService {

    private final CallGraphDeriver deriver;
    private final BindingTimeClassifier classifier;
    private final DesignDiffer differ;
    private final DesignDeltaEmitter emitter;
    private final DesignService designService;

    public CodeDesignDiffService(CallGraphDeriver deriver, BindingTimeClassifier classifier,
                                 DesignDiffer differ, DesignDeltaEmitter emitter, DesignService designService) {
        this.deriver = deriver;
        this.classifier = classifier;
        this.differ = differ;
        this.emitter = emitter;
        this.designService = designService;
    }

    /**
     * Run the pipeline for one ticket. Emits apply artifacts only when the delta
     * is a valid, minimal request-dynamic generate; otherwise returns the
     * classification + delta with its reason (park) or question (ask).
     */
    public DiffResult run(List<String> sources, String entryClass, String entryMethod,
                          String discriminator, String acText, VariantRequest request) {
        DerivedSlice slice = deriver.derive(sources, entryClass, entryMethod);
        BindingClassification classification = classifier.classify(slice, discriminator, acText);
        DesignDelta delta = differ.diff(slice, classification, request);
        DesignDeltaValidator.Report report = DesignDeltaValidator.validate(slice, request, delta);

        ApplyArtifacts artifacts = null;
        if (DesignDelta.GENERATE.equals(delta.disposition()) && report.ok()) {
            artifacts = emitter.emit(slice, delta);
        }
        return new DiffResult(delta.disposition(), classification, delta,
                report.violations(), report.warnings(), artifacts);
    }

    /** Write the emitted .puml + sidecars into {@code <projectPath>/design/}. */
    public DesignResult apply(String projectPath, ApplyArtifacts artifacts) {
        if (artifacts == null) {
            throw new IllegalArgumentException("no artifacts to apply (delta was parked or ask)");
        }
        DesignRequest req = new DesignRequest(
                projectPath, artifacts.pumlFileName(), artifacts.puml(), artifacts.sidecars());
        return designService.save(req);
    }
}
