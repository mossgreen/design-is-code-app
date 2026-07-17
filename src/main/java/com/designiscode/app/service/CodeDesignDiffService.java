package com.designiscode.app.service;

import com.designiscode.app.dto.ApplyArtifacts;
import com.designiscode.app.dto.BindingClassification;
import com.designiscode.app.dto.DeriveResult;
import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DesignRequest;
import com.designiscode.app.dto.DesignResult;
import com.designiscode.app.dto.DiagramModel;
import com.designiscode.app.dto.DiffResult;
import com.designiscode.app.dto.VariantRequest;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * Orchestrates the code→design diff pipeline end to end: Stage A (derive) →
 * Stage B (classify) → Stage C (diff) → delta validation → Stage E (emit).
 * This is the seam the HTTP endpoint and the round-trip eval golden both drive.
 *
 * <p>{@link #run} is pure (no I/O); {@link #derive} is the Stage-A-only path
 * for additive tickets (what-IS context, no variance delta); {@link #apply}
 * writes the emitted artifacts into {@code <project>/design/} by reusing
 * {@link DesignService}.
 */
@Service
public class CodeDesignDiffService {

    private final CallGraphDeriver deriver;
    private final BindingTimeClassifier classifier;
    private final DesignDiffer differ;
    private final DesignDeltaEmitter emitter;
    private final DesignService designService;
    private final SliceRenderer sliceRenderer;
    private final DeltaRenderer deltaRenderer;
    private final CounterfactualRenderer counterfactualRenderer;
    private final WhyRenderer whyRenderer;

    public CodeDesignDiffService(CallGraphDeriver deriver, BindingTimeClassifier classifier,
                                 DesignDiffer differ, DesignDeltaEmitter emitter, DesignService designService,
                                 SliceRenderer sliceRenderer, DeltaRenderer deltaRenderer,
                                 CounterfactualRenderer counterfactualRenderer, WhyRenderer whyRenderer) {
        this.deriver = deriver;
        this.classifier = classifier;
        this.differ = differ;
        this.emitter = emitter;
        this.designService = designService;
        this.sliceRenderer = sliceRenderer;
        this.deltaRenderer = deltaRenderer;
        this.counterfactualRenderer = counterfactualRenderer;
        this.whyRenderer = whyRenderer;
    }

    /** Stage A + rendering only: the what-IS view for an additive ticket. */
    public DeriveResult derive(List<String> sources, String entryClass, String entryMethod) {
        DerivedSlice slice = deriver.derive(sources, entryClass, entryMethod);
        return new DeriveResult(slice, sliceRenderer.renderMarkdown(slice),
                sliceRenderer.renderPuml(slice), sliceRenderer.renderModel(slice));
    }

    /**
     * {@link #derive} with sources read server-side: every {@code *.java} under
     * {@code <projectPath>/src/main/java} (the same convention as the scan and
     * the CLI scripts). For clients that hold a project path, not file contents
     * — the wizard's Step-3 "before" view.
     */
    public DeriveResult deriveByPath(String projectPath, String entryClass, String entryMethod) {
        if (projectPath == null || projectPath.isBlank()) {
            throw new IllegalArgumentException("projectPath is required");
        }
        java.nio.file.Path root = java.nio.file.Path.of(projectPath, "src", "main", "java");
        if (!java.nio.file.Files.isDirectory(root)) {
            throw new IllegalArgumentException("no src/main/java under " + projectPath);
        }
        List<String> sources;
        try (java.util.stream.Stream<java.nio.file.Path> paths = java.nio.file.Files.walk(root)) {
            sources = paths
                    .filter(p -> p.toString().endsWith(".java"))
                    .sorted()
                    .map(p -> {
                        try {
                            return java.nio.file.Files.readString(p);
                        } catch (java.io.IOException e) {
                            return null; // unreadable file: skip, don't kill the derive
                        }
                    })
                    .filter(java.util.Objects::nonNull)
                    .toList();
        } catch (java.io.IOException e) {
            throw new IllegalArgumentException("cannot read sources under " + projectPath + ": " + e.getMessage());
        }
        return derive(sources, entryClass, entryMethod);
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
        DiagramModel oldWayModel = null;
        String oldWayPuml = null;
        DiagramModel newWayModel = null;
        String whyMarkdown = null;
        if (DesignDelta.GENERATE.equals(delta.disposition()) && report.ok()) {
            artifacts = emitter.emit(slice, delta);
            oldWayModel = counterfactualRenderer.oldWayModel(slice, delta, classification);
            oldWayPuml = counterfactualRenderer.oldWayPuml(slice, delta, classification);
            newWayModel = counterfactualRenderer.newWayModel(slice, delta);
            whyMarkdown = whyRenderer.renderMarkdown(slice, delta, classification);
        }
        return new DiffResult(delta.disposition(), classification, delta,
                report.violations(), report.warnings(), artifacts,
                sliceRenderer.renderMarkdown(slice), sliceRenderer.renderPuml(slice),
                deltaRenderer.renderMarkdown(delta, classification, report.warnings()),
                oldWayModel, oldWayPuml, newWayModel, whyMarkdown);
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
