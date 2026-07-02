package com.designiscode.app.dto;

import java.util.List;

/**
 * Stage C output: the <i>minimal design delta</i> to introduce a new variant
 * behind an existing call site, computed from a {@link DerivedSlice} and a
 * {@link BindingClassification}.
 *
 * <p>{@code disposition} is the Phase-1 policy outcome:
 * <ul>
 *   <li>{@code generate} — a request-dynamic variant: the resolver delta below
 *       is populated.</li>
 *   <li>{@code park} — deploy-static / runtime-global: correctly classified but
 *       not generated in Phase 1; {@code reason} says why.</li>
 *   <li>{@code ask} — the classification needs a question, or the request is
 *       under-specified (e.g. a concrete callee with no abstraction named);
 *       {@code reason} carries the question.</li>
 * </ul>
 *
 * <p>For {@code generate}, the typed fields ({@code strategyInterface},
 * {@code resolver}, {@code permits}, {@code mapping}) drive validation and
 * downstream codegen, while {@code changes} is the ordered, human-readable list
 * for the Stage-D diff review and Stage-E apply. Existing variants appear as
 * {@code reuse} (leaves are sacred); the SUT's call site appears as
 * {@code modify} (orchestrators are regenerated artifacts).
 *
 * <p>{@code sutMode} records how the orchestrator itself is applied:
 * {@code regen} (the plugin overwrites its body wholesale from this design — only
 * when Stage A captured the entry body completely) or {@code update} (add-only;
 * the plugin regenerates the test but leaves the body, so a human wires the
 * resolver in — the safe fallback when the body could not be fully derived).
 * Null for park/ask.
 */
public record DesignDelta(
        String disposition,            // "generate" | "park" | "ask"
        String reason,                 // populated for park/ask; null for generate
        String strategyInterface,      // the abstraction (existing interface or extracted); null unless generate
        String resolver,               // the added resolver participant; null unless generate
        List<String> permits,          // strategy classes: existing impls + the new variant
        List<MappingRow> mapping,      // discriminator value → strategy
        String bindingTime,            // carried from the classification
        String sutMode,                // "regen" | "update"; null unless generate — how the orchestrator is applied
        List<Change> changes           // ordered, reviewable change list
) {
    public static final String GENERATE = "generate";
    public static final String PARK = "park";
    public static final String ASK = "ask";

    /** Orchestrator applied by wholesale overwrite from the design (Stage A capture complete). */
    public static final String SUT_REGEN = "regen";
    /** Orchestrator applied add-only; body left for a human to wire (capture incomplete). */
    public static final String SUT_UPDATE = "update";

    /** One discriminator value → strategy mapping row (the resolver's lookup). */
    public record MappingRow(String key, String strategy) {}

    /**
     * One reviewable change. {@code op} ∈ add | reuse | modify | extract-interface;
     * {@code element} ∈ entity | participant | arrow | sidecar | variance-axis.
     */
    public record Change(String op, String element, String name, String detail) {}
}
