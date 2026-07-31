package com.designiscode.app.service;

import com.designiscode.app.dto.DesignDelta.MappingRow;
import com.designiscode.app.dto.DiffResult;
import com.designiscode.app.dto.VariantRequest;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Proves the derivation claim DisC's whole thesis rests on: <b>design is a
 * deterministic projection of code</b>. If the same code can yield two different
 * diagrams, "derived, never stored" buys nothing — a reviewer could not tell a
 * real change from noise, and drift returns through the back door.
 *
 * <p>Three separate properties, weakest first. The existing golden tests pin
 * output against a <i>recorded</i> file, which is a different and weaker claim:
 * it catches a changed emitter, not an unstable one.
 *
 * <ol>
 *   <li><b>No leaked state.</b> Running the pipeline repeatedly must give the
 *       same answer. The collaborators are Spring singletons, so anything they
 *       accumulate would make request 2 differ from request 1. Note honestly what
 *       this does <i>not</i> prove: within one JVM, hash iteration order is
 *       already stable, so repetition cannot catch an ordering bug.</li>
 *   <li><b>A no-op edit changes nothing.</b> Comments and blank lines must not
 *       move the design. This is the sharpest of the three and the easiest to
 *       fail — any line-number or offset leaking into the output breaks it.</li>
 *   <li><b>A one-line edit changes one thing.</b> "Small edit → small diagram
 *       change" (about.md §8b) is what makes review at design altitude tractable
 *       at all. Adding one call must add one arrow and disturb nothing else.</li>
 * </ol>
 *
 * <p>Deterministic and free: Stages A–E make no model calls.
 */
class DerivationStabilityTest {

    private final CodeDesignDiffService pipeline = new CodeDesignDiffService(
            new CallGraphDeriver(), new BindingTimeClassifier(), new DesignDiffer(),
            new DesignDeltaEmitter(), new DesignService(),
            new SliceRenderer(), new DeltaRenderer(),
            new CounterfactualRenderer(), new WhyRenderer());

    private static final String AC =
            "The cancellation form records who initiated the cancellation. "
                    + "Clinic-initiated cancellations are always free; "
                    + "owner-initiated cancellations keep the 48-hour rule.";

    private static final VariantRequest REQUEST = new VariantRequest(
            "CancellationFeePolicy", "ClinicInitiatedFee",
            List.of(new MappingRow("owner", "StandardCancellationFee"),
                    new MappingRow("clinic", "ClinicInitiatedFee")),
            null);

    private DiffResult derive(List<String> sources) {
        return pipeline.run(sources, "CancelVisitService", "cancel", "initiator", AC, REQUEST);
    }

    /** Everything a reviewer or the plugin reads, as one comparable blob. */
    private static String observable(DiffResult r) {
        return String.join("\n---\n",
                String.valueOf(r.disposition()),
                String.valueOf(r.artifacts() == null ? "" : r.artifacts().puml()),
                String.valueOf(r.artifacts() == null ? "" : r.artifacts().sidecars()),
                String.valueOf(r.slicePuml()),
                String.valueOf(r.sliceMarkdown()),
                String.valueOf(r.deltaMarkdown()),
                String.valueOf(r.whyMarkdown()),
                String.valueOf(r.oldWayPuml()),
                String.valueOf(r.validationViolations()),
                String.valueOf(r.warnings()));
    }

    /** Arrow lines only — the part of a design a reviewer actually reads. */
    private static List<String> arrows(String puml) {
        List<String> out = new ArrayList<>();
        for (String line : puml.split("\n")) {
            String t = line.trim();
            if (t.contains("->") || t.contains("<--")) out.add(t);
        }
        return out;
    }

    @Test
    void repeatedDerivationOfUnchangedCodeIsByteIdentical() {
        List<String> sources = PetclinicFixtures.sources("act2");
        String first = observable(derive(sources));

        for (int run = 2; run <= 5; run++) {
            String again = observable(derive(sources));
            assertEquals(first, again,
                    "run " + run + " differs from run 1 — a collaborator is holding state "
                            + "across calls, so the same code would derive two designs");
        }
    }

    /**
     * The strongest form of "design is a projection of code": a change that
     * carries no behaviour must produce no design change at all. If a comment can
     * move the diagram, every unrelated commit looks like a design change and
     * review at design altitude stops working.
     */
    @Test
    void aCommentAndABlankLineDoNotMoveTheDesign() {
        List<String> sources = PetclinicFixtures.sources("act2");
        String before = observable(derive(sources));

        List<String> edited = new ArrayList<>(sources);
        int sut = indexOfSut(edited);
        edited.set(sut, edited.get(sut).replace(
                "public CancellationResult cancel(",
                "// a comment that changes nothing\n\n\tpublic CancellationResult cancel("));

        assertEquals(before, observable(derive(edited)),
                "a comment and a blank line changed the derived design — something "
                        + "positional is leaking into the projection");
    }

    /**
     * Edit locality. One added call must move exactly one arrow: the reviewer's
     * cost of reading a change has to be proportional to the change.
     */
    @Test
    void oneAddedCallAddsExactlyOneArrow() {
        List<String> sources = PetclinicFixtures.sources("act2");
        DiffResult before = derive(sources);
        assertNotNull(before.slicePuml(), "baseline slice must derive");

        List<String> edited = new ArrayList<>(sources);
        int sut = indexOfSut(edited);
        // A second save on the same repository: one more real call site, on a
        // collaborator the slice already knows, so nothing else can shift.
        edited.set(sut, edited.get(sut).replace(
                "\t\tthis.owners.save(owner);",
                "\t\tthis.owners.save(owner);\n\t\tthis.owners.save(owner);"));

        List<String> was = arrows(before.slicePuml());
        List<String> now = arrows(derive(edited).slicePuml());

        assertEquals(was.size() + 1, now.size(),
                () -> "expected exactly one more arrow.\nbefore:\n  " + String.join("\n  ", was)
                        + "\nafter:\n  " + String.join("\n  ", now));

        // Locality is the real claim: removing the one added line must give back
        // the original arrow list exactly, in order. Anything else means the edit
        // rippled.
        assertTrue(removingOneLineRecovers(was, now),
                () -> "one arrow was added but others moved too — the edit was not local.\nbefore:\n  "
                        + String.join("\n  ", was) + "\nafter:\n  " + String.join("\n  ", now));
    }

    /** True when {@code now} is {@code was} with exactly one line inserted. */
    private static boolean removingOneLineRecovers(List<String> was, List<String> now) {
        for (int i = 0; i < now.size(); i++) {
            List<String> candidate = new ArrayList<>(now);
            candidate.remove(i);
            if (candidate.equals(was)) return true;
        }
        return false;
    }

    private static int indexOfSut(List<String> sources) {
        for (int i = 0; i < sources.size(); i++) {
            if (sources.get(i).contains("class CancelVisitService")) return i;
        }
        throw new IllegalStateException("act2 fixtures must contain CancelVisitService");
    }

    /** Guards the two edit tests above: if the anchors stop matching, they silently test nothing. */
    @Test
    void theEditAnchorsThisTestReliesOnStillExistInTheFixture() {
        String sut = PetclinicFixtures.sources("act2").get(indexOfSut(PetclinicFixtures.sources("act2")));
        assertTrue(sut.contains("public CancellationResult cancel("),
                "the no-op-edit anchor is gone; that test would become a no-op");
        assertTrue(sut.contains("\t\tthis.owners.save(owner);"),
                "the added-call anchor is gone; the locality test would become a no-op");
    }
}
