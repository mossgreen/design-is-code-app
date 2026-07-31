package com.designiscode.app.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The fix for the long-standing drift hole (TODO.md "P4"): {@code --validate-only}
 * used to receive the {@code .puml} alone, so Step 1 judged the design as if every
 * leaf were unspecified. A decision table could contradict the diagram — or pin a
 * call the design never makes — and validation still passed. The reviewer was
 * told the design was fine; the generator then read a different design.
 *
 * <p>Sidecar names come from the browser, so they are untrusted input pointed at
 * the user's own project directory. The traversal cases below matter as much as
 * the happy path.
 */
class RunServiceStageSidecarsTest {

    @Test
    void sidecarsLandBesideThePumlSoStep1CanPairThem(@TempDir Path tmp) throws IOException {
        Map<String, String> sidecars = new LinkedHashMap<>();
        sidecars.put("CancellationFeePolicyResolver.decision.md", "---\ntarget: X.resolve\n---\n");
        sidecars.put("StandardCancellationFee.decision.md", "---\ntarget: Y.feeFor\n---\n");

        List<Path> written = RunService.stageSidecars(tmp, sidecars);

        assertEquals(2, written.size(), () -> "both tables must be staged: " + written);
        for (Path p : written) {
            assertTrue(Files.exists(p), () -> p + " was reported written but is not there");
            assertEquals(tmp, p.getParent(), "a sidecar must sit next to the .puml");
        }
        assertEquals("---\ntarget: X.resolve\n---\n",
                Files.readString(tmp.resolve("CancellationFeePolicyResolver.decision.md")));
    }

    /** A client that sends none must behave exactly as before — the flow verdict alone. */
    @Test
    void noSidecarsWritesNothingAndIsNotAnError(@TempDir Path tmp) throws IOException {
        assertTrue(RunService.stageSidecars(tmp, null).isEmpty());
        assertTrue(RunService.stageSidecars(tmp, Map.of()).isEmpty());
        try (var entries = Files.list(tmp)) {
            assertEquals(0, entries.count(), "nothing should have been created");
        }
    }

    /**
     * The name is browser-supplied and the target is the user's project. A table
     * called {@code ../../.ssh/authorized_keys} must not be written, and must not
     * blow up the validate call either — it is dropped.
     */
    @Test
    void aNameThatTriesToEscapeTheTempDirectoryIsDropped(@TempDir Path tmp) throws IOException {
        Map<String, String> hostile = new LinkedHashMap<>();
        hostile.put("../escaped.md", "should not be written");
        hostile.put("nested/inner.md", "should not be written");
        hostile.put("..\\windows.md", "should not be written");
        hostile.put("legit.decision.md", "fine");

        List<Path> written = RunService.stageSidecars(tmp, hostile);

        assertEquals(1, written.size(), () -> "only the safe name may be staged: " + written);
        assertEquals("legit.decision.md", written.get(0).getFileName().toString());
        assertFalse(Files.exists(tmp.getParent().resolve("escaped.md")),
                "a sidecar escaped the staging directory");
    }

    /** Blank names and null bodies are skipped rather than producing junk files. */
    @Test
    void malformedEntriesAreSkippedNotWritten(@TempDir Path tmp) throws IOException {
        Map<String, String> messy = new LinkedHashMap<>();
        messy.put("  ", "no name");
        messy.put("nobody.decision.md", null);
        messy.put("good.decision.md", "content");

        List<Path> written = RunService.stageSidecars(tmp, messy);

        assertEquals(1, written.size(), () -> written.toString());
        assertEquals("good.decision.md", written.get(0).getFileName().toString());
    }
}
