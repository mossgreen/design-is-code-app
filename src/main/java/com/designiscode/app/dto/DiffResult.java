package com.designiscode.app.dto;

import java.util.List;

/**
 * The end-to-end result of the code→design diff pipeline (Stages A–E) for one
 * ticket: the binding classification, the design delta, the delta-validation
 * verdict, and (when generated and valid) the emitted apply artifacts.
 *
 * <p>{@code validationViolations} block apply (the delta is malformed);
 * {@code warnings} do not (e.g. the orchestrator fell back to add-only UPDATE and
 * needs manual wiring) — they are surfaced at the Stage-D review so the reviewer
 * sees what the design does not fully pin.
 */
public record DiffResult(
        String disposition,                 // generate | park | ask (mirrors the delta)
        BindingClassification classification,
        DesignDelta delta,
        List<String> validationViolations,  // empty when the delta is well-formed/minimal
        List<String> warnings,              // non-blocking review notes (e.g. manual-wiring fallback)
        ApplyArtifacts artifacts,           // null unless disposition == generate and validation passed
        String sliceMarkdown,               // human-readable what-IS slice (PR body, Stage-D review)
        String slicePuml,                   // what-IS sequence diagram (read-only view, not a design artifact)
        String deltaMarkdown                // human-readable delta (PR body, Stage-D review)
) {}
