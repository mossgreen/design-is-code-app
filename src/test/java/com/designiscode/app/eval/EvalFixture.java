package com.designiscode.app.eval;

import com.designiscode.app.service.DesignContractValidator;

import com.designiscode.app.dto.AcRow;

import java.util.List;
import java.util.Map;

/**
 * One analyzer-eval scenario: the input (story + acceptance criteria) and the
 * scenario-specific gold checks for the analyzer's design-model.
 *
 * <p>Generic contract validity (shape, referential integrity, plugin-refusal
 * rules) is NOT a fixture concern — {@link DesignContractValidator} runs on
 * every model first. {@link #goldChecks} adds only this scenario's semantic
 * gold (e.g. the CAT/DOG values), and asserts by <b>values, not names</b>:
 * the model is free to name fields/types however it likes as long as the
 * data is internally consistent and lands somewhere that executes.
 *
 * <p>Checks return failure strings instead of throwing so the harness can
 * aggregate them into a per-run pass/fail matrix (pass-rate gating).
 */
interface EvalFixture {

    /** Short label used in test names and artifact paths, e.g. {@code "pet-visit-fee"}. */
    String name();

    /** Free-text requirement fed to the analyzer as {@code {CONTEXT}}. */
    String story();

    /**
     * Structured acceptance criteria. Index order defines the AC indices
     * (0..n-1) the design-model's {@code acIndices}/{@code cases[].acIndex}
     * refer to.
     */
    List<AcRow> acRows();

    /**
     * Scenario-specific gold checks over the raw design-model {@code Map}.
     * Empty list = pass. Each entry is one human-readable failure.
     */
    List<String> goldChecks(Map<String, Object> model);
}
