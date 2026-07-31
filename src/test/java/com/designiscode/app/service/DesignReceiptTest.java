package com.designiscode.app.service;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The "30-second audit" and the branch-placement claim, made mechanical.
 *
 * <p>DisC's honest position is that it never eliminates branching — it <b>places</b>
 * it. Orchestrator: none. Resolver: table rows. Leaf: pinned by a decision table.
 * "Every branch has an address and a receipt" is only worth saying if both halves
 * are checkable, so this asserts them against committed artifacts:
 *
 * <ul>
 *   <li><b>Address</b> — the same ticket, rendered two ways. The naive
 *       counterfactual branches inside the orchestrator; the DisC design has no
 *       fragment at all and names a resolver instead. The branch did not vanish,
 *       it moved somewhere with a name.</li>
 *   <li><b>Receipt</b> — the number of {@code verify()} calls a reviewer should
 *       expect is computable from the design <i>before any code exists</i>. That
 *       is what makes the audit possible in 30 seconds rather than a read-through.</li>
 * </ul>
 *
 * <p>Both goldens are byte-pinned by
 * {@link CodeDesignDiffPetclinicRoundTripTest}, so these assertions are about the
 * <i>shape</i> the emitter produces, not about a file someone could quietly edit.
 *
 * <p>What this cannot check for free: that the plugin then emits exactly that many
 * {@code verify()} calls. Only a generation run shows that — recorded for
 * petclinic Act 2 in about.md §10c and visible in
 * <a href="https://github.com/mossgreen/spring-petclinic/pull/2">PR #2</a>.
 * The expected count asserted here is the same 6.
 */
class DesignReceiptTest {

    private static final Path GOLDENS = Path.of("src", "test", "resources", "goldens", "petclinic");

    private static String golden(String name) {
        try {
            return Files.readString(GOLDENS.resolve(name));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** PlantUML fragment openers/closers — the syntactic form a branch takes in a design. */
    private static List<String> fragmentLines(String puml) {
        List<String> out = new ArrayList<>();
        for (String line : puml.split("\n")) {
            String t = line.trim();
            if (t.matches("^(alt|else|opt|loop|par|while|group|end)\\b.*")) out.add(t);
        }
        return out;
    }

    /**
     * Outgoing calls from the SUT to a collaborator: {@code A -> B : method(...)},
     * excluding the entry arrow from {@code [*]} and every return arrow. One such
     * arrow is one interaction the generated test must {@code verify()}.
     */
    private static List<String> collaboratorCalls(String puml) {
        List<String> out = new ArrayList<>();
        for (String line : puml.split("\n")) {
            String t = line.trim();
            if (t.startsWith("[*]")) continue;                 // entry, not a collaborator call
            if (t.contains("<--") || t.contains("-->")) continue; // returns
            if (t.contains("->") && t.contains(":")) out.add(t);
        }
        return out;
    }

    /** Data rows of the first markdown table, header and separator excluded. */
    private static int decisionRows(String sidecar) {
        int rows = 0;
        for (String line : sidecar.split("\n")) {
            String t = line.trim();
            if (!t.startsWith("|")) continue;
            String cells = t.replace("|", "").trim();
            if (cells.isEmpty()) continue;
            if (cells.chars().allMatch(c -> c == '-' || c == ':' || c == ' ')) continue; // separator
            rows++;
        }
        return Math.max(0, rows - 1); // drop the header
    }

    // --- address: the branch moved, it did not disappear ------------------------

    @Test
    void theDiscOrchestratorContainsNoBranchAtAll() {
        List<String> fragments = fragmentLines(golden("CancelVisitService.puml"));
        assertTrue(fragments.isEmpty(),
                () -> "the orchestrator must be linear — every branch belongs in a pattern host, "
                        + "but the design carries: " + fragments);
    }

    /**
     * The counterfactual is the same ticket implemented the ordinary way. If it did
     * NOT branch, DisC would be solving a problem nobody has, and the comparison in
     * every pitch would be dishonest.
     */
    @Test
    void theNaiveVersionOfTheSameTicketDoesBranchInTheOrchestrator() {
        List<String> fragments = fragmentLines(golden("oldway-act2.puml"));
        assertTrue(fragments.size() >= 3,
                () -> "the naive counterfactual should fold the variance into the orchestrator "
                        + "as alt/else/end; found: " + fragments);
        assertTrue(fragments.stream().anyMatch(f -> f.startsWith("alt")),
                () -> "expected an alt fragment in the naive shape: " + fragments);
    }

    /**
     * Branches are conserved. The naive design hosts the variance in a fragment;
     * the DisC design hosts it in a named resolver plus a table. Same variance,
     * different address — never "no if-else".
     */
    @Test
    void theVarianceTheNaiveVersionBranchesOnHasANamedHostInTheDiscDesign() {
        String disc = golden("CancelVisitService.puml");
        String naive = golden("oldway-act2.puml");

        assertTrue(naive.contains("initiator =="),
                "the naive version selects on the discriminator inline");
        assertTrue(disc.contains("CancellationFeePolicyResolver : resolve(initiator)"),
                () -> "the DisC design must hand the same discriminator to a named resolver: " + disc);
        assertTrue(fragmentLines(disc).isEmpty() && !fragmentLines(naive).isEmpty(),
                "the branch moved out of the orchestrator, it did not vanish");
    }

    // --- receipt: countable before any code exists ------------------------------

    /**
     * The audit rule is one {@code verify()} per call arrow. Six collaborator calls
     * here — the same 6 the real Act-2 generation produced (about.md §10c, PR #2),
     * which is what makes the count a receipt rather than a hope.
     */
    @Test
    void theExpectedVerifyCountIsReadableStraightOffTheDesign() {
        List<String> calls = collaboratorCalls(golden("CancelVisitService.puml"));
        assertEquals(6, calls.size(),
                () -> "expected 6 collaborator calls, matching the 6 verify() calls the Act-2 "
                        + "generation produced; found:\n  " + String.join("\n  ", calls));
    }

    /** One decision-table row is one leaf test. Two rows here; the run produced two resolver tests. */
    @Test
    void eachDecisionTableRowIsOneExpectedLeafTest() {
        assertEquals(2, decisionRows(golden("CancellationFeePolicyResolver.decision.md")),
                "the resolver table has two rows, and the Act-2 run generated two resolver tests");
    }

    /**
     * Guards the counters. If the parsing helpers silently matched nothing, every
     * assertion above would still pass while proving nothing.
     */
    @Test
    void theParsingHelpersActuallyMatchSomething() {
        assertTrue(collaboratorCalls(golden("oldway-act2.puml")).size() >= 6,
                "the call parser must find arrows in the naive design too");
        assertEquals(3, fragmentLines(golden("oldway-act2.puml")).size(),
                "the fragment parser must find exactly alt/else/end in the naive design");
        assertTrue(decisionRows(golden("CancellationFeePolicyResolver.decision.md")) > 0,
                "the row parser must find rows");
    }
}
