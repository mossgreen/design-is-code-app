package com.designiscode.app.eval;

import com.designiscode.app.dto.AcRow;

import java.util.List;
import java.util.Map;

/**
 * One analyzer-eval scenario: the input (story + acceptance criteria) and the
 * assertions that decide whether the analyzer's design-model is correct for it.
 *
 * <p>A fixture is a self-contained pair — the input we feed and the gold we
 * expect. Generic structural checks live in {@link DesignModelAssertions};
 * a fixture's {@link #assertDesignModel} adds the scenario-specific gold (e.g.
 * the CAT/DOG mapping values) on top.
 */
interface EvalFixture {

    /** Short label used in failure messages, e.g. {@code "pet-visit-fee"}. */
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
     * Assert the raw design-model {@code Map} is correct for THIS fixture.
     *
     * @param model parsed JSON returned by {@code AnalyzeService.analyze()}
     * @param run   1-based run index, surfaced in failure messages so a red
     *              eval names which of the N stability runs failed
     */
    void assertDesignModel(Map<String, Object> model, int run);
}
