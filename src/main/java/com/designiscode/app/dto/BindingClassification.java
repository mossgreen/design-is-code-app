package com.designiscode.app.dto;

/**
 * Stage B output: the binding-time classification of one variance
 * discriminator, decided by tracing its provenance through a {@link DerivedSlice}.
 *
 * <p>Core principle: <b>the code decides the binding time, the AC only
 * corroborates.</b> {@code discriminatorSource} is where the discriminator
 * roots — the entry method's input ({@code request}), a config property fixed
 * at startup ({@code environment}), an ops flag ({@code flag}), or
 * {@code unresolved} when the trace is inconclusive or ambiguous.
 * {@code bindingTime} follows: request→request-dynamic, environment→deploy-static,
 * flag→runtime-global, unresolved→unknown.
 *
 * <p>When the trace is ambiguous (roots in two anchors), inconclusive (roots in
 * none — the discriminator isn't wired), or conflicts with the AC,
 * {@code needsQuestion} is true and {@code question} carries the single sharp
 * question to put to the user. Phase 1 generates only {@code request-dynamic};
 * {@code deploy-static}/{@code runtime-global} are correctly classified so the
 * orchestrator parks them rather than forcing a wrong resolver.
 */
public record BindingClassification(
        String discriminator,
        String discriminatorSource,   // "request" | "environment" | "flag" | "unresolved"
        String bindingTime,           // "request-dynamic" | "deploy-static" | "runtime-global" | "unknown"
        boolean needsQuestion,
        String question,              // the one sharp question to ask, or null
        String rationale              // why this verdict — the provenance found
) {}
