package com.designiscode.app.eval;

import com.designiscode.app.dto.AcRow;

import java.util.List;
import java.util.Map;

import static com.designiscode.app.eval.DesignModelAssertions.assertAcCoverage;
import static com.designiscode.app.eval.DesignModelAssertions.assertApplierCasesCoverAllRows;
import static com.designiscode.app.eval.DesignModelAssertions.assertRuleRecordHasFillableHome;
import static com.designiscode.app.eval.DesignModelAssertions.assertRuleTableVariance;
import static com.designiscode.app.eval.DesignModelAssertions.assertStructuralSanity;

/**
 * Pet-visit-fee discount fixture. Doubles as the regression test for the
 * "rule-table compiles-but-doesn't-run" bug: the rule data (cat=20d/20%,
 * dog=40d/10%) must land in a fillable pure-function leaf, and the applier
 * must carry {@code cases[]} — not ship as stubs.
 *
 * <p>Gold values for this fixture (CAT/DOG numbers) live here; the generic
 * structural/coverage checks are delegated to {@link DesignModelAssertions}.
 */
final class VisitFeeFixture implements EvalFixture {

    @Override
    public String name() {
        return "pet-visit-fee";
    }

    @Override
    public String story() {
        return """
                A veterinary clinic charges a $50 base visit fee. Loyal customers get a
                discount on the visit fee, but the discount depends on the pet's species:
                the discount percentage and the "recent visit" eligibility window (how many
                days since the last visit still counts as recent) differ per species.
                Cats get a larger discount with a shorter recency window; dogs get a smaller
                discount with a longer window. Compute the final visit fee for a pet given
                its species, the days since its last visit, and the base fee.
                """;
    }

    @Override
    public List<AcRow> acRows() {
        return List.of(
                new AcRow(
                        "a cat last visited 10 days ago",
                        "the visit fee is computed on a $50 base",
                        "the fee is $40 (20% off; recent-visit window is 20 days)"),
                new AcRow(
                        "a dog last visited 30 days ago",
                        "the visit fee is computed on a $50 base",
                        "the fee is $45 (10% off; recent-visit window is 40 days)"));
    }

    @Override
    public void assertDesignModel(Map<String, Object> model, int run) {
        int acCount = acRows().size(); // 2

        // 1. Structural sanity
        assertStructuralSanity(model, run);

        // 2. Variance understood + filled (CAT/DOG gold is fixture-specific)
        assertRuleTableVariance(model, run, Map.of(
                "CAT", Map.of("windowDays", 20, "percentOff", 20),
                "DOG", Map.of("windowDays", 40, "percentOff", 10)));

        // 3. Rule data has a fillable home: a 2-field record returned by a non-mock leaf
        assertRuleRecordHasFillableHome(model, run, /* expectedFieldCount= */ 2);

        // 4. Applier cases coverage == #AC rows
        assertApplierCasesCoverAllRows(model, run, acCount);

        // 5. AC coverage (hard) + one-carrier (soft)
        assertAcCoverage(model, run, acCount);
    }
}
