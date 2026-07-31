package com.designiscode.app.service;

import com.designiscode.app.dto.DerivedSlice;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link DerivationStabilityTest} proves stability against a <b>hand-written,
 * DisC-shaped fixture</b> — code this project authored to be easy to derive from.
 * That is the weaker half of the claim. about.md §9 names the stronger one as the
 * load-bearing unproven claim of the whole thesis:
 *
 * <blockquote>derivation stability on repos DisC never wrote</blockquote>
 *
 * <p>This runs the same properties against arbitrary real code. It needs a
 * checkout but <b>no model calls</b> — Stages A–E are deterministic — so it is
 * cheap to run on any Java project and is the fastest way to find out whether the
 * thesis survives contact with code that was not written for it.
 *
 * <p>Opt-in, and skips cleanly when unconfigured so a bare {@code ./gradlew test}
 * never depends on what happens to be on the machine:
 *
 * <pre>
 * ./gradlew test --tests '*ForeignRepo*' \
 *     -Ddisc.stability.repo=/path/to/repo \
 *     -Ddisc.stability.entry=VisitController#processNewVisitForm
 * </pre>
 */
class DerivationStabilityForeignRepoTest {

    private static final String PROP_REPO = "disc.stability.repo";
    private static final String PROP_ENTRY = "disc.stability.entry";

    private final CallGraphDeriver deriver = new CallGraphDeriver();
    private final SliceRenderer renderer = new SliceRenderer();

    private record Target(List<String> sources, String entryClass, String entryMethod) {}

    private static Target target() {
        String repo = System.getProperty(PROP_REPO);
        String rawEntry = System.getProperty(PROP_ENTRY);
        Assumptions.assumeTrue(repo != null && !repo.isBlank(),
                "set -D" + PROP_REPO + "=<path> to run the foreign-repo stability check");
        Assumptions.assumeTrue(rawEntry != null && rawEntry.contains("#"),
                "set -D" + PROP_ENTRY + "=<Class>#<method>");
        // assumeTrue already aborted if null; the fallback only satisfies the compiler.
        String entry = rawEntry == null ? "" : rawEntry;

        Path main = Path.of(repo, "src", "main", "java");
        Assumptions.assumeTrue(Files.isDirectory(main), main + " is not a directory");

        List<String> sources = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(main)) {
            walk.filter(p -> p.toString().endsWith(".java")).sorted().forEach(p -> {
                try {
                    sources.add(Files.readString(p));
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
            });
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }

        return new Target(sources, entry.substring(0, entry.indexOf('#')),
                entry.substring(entry.indexOf('#') + 1));
    }

    /** Everything a reviewer reads about the derived slice. */
    private String observable(DerivedSlice slice) {
        return renderer.renderPuml(slice) + "\n---\n" + renderer.renderMarkdown(slice);
    }

    private DerivedSlice derive(Target t, List<String> sources) {
        return deriver.derive(sources, t.entryClass(), t.entryMethod());
    }

    @Test
    void derivingForeignCodeFiveTimesGivesTheSameDesign() {
        Target t = target();
        DerivedSlice first = derive(t, t.sources());
        assertFalse(renderer.renderPuml(first).isBlank(),
                "the entry method must actually derive — check -D" + PROP_ENTRY);

        String expected = observable(first);
        for (int run = 2; run <= 5; run++) {
            assertEquals(expected, observable(derive(t, t.sources())),
                    "run " + run + " differs — derivation of foreign code is not stable");
        }
    }

    /**
     * The property that decides whether design-altitude review survives on real
     * repositories: a change with no behaviour must produce no design change, or
     * every unrelated commit shows up as design churn.
     */
    @Test
    void aCommentInForeignCodeDoesNotMoveTheDesign() {
        Target t = target();
        String before = observable(derive(t, t.sources()));

        List<String> edited = new ArrayList<>(t.sources());
        int i = indexOfEntryClass(edited, t.entryClass());
        edited.set(i, "// a comment that changes nothing\n\n" + edited.get(i));

        assertEquals(before, observable(derive(t, edited)),
                "a leading comment changed the derived design of foreign code");
    }

    /** Records what the slice looks like, so a run leaves evidence rather than just a green tick. */
    @Test
    void reportTheDerivedShape() {
        Target t = target();
        DerivedSlice slice = derive(t, t.sources());
        String puml = renderer.renderPuml(slice);
        long arrows = puml.lines().filter(l -> l.contains("->") || l.contains("<--")).count();

        System.out.println("[foreign-repo derivation] entry=" + t.entryClass() + "#" + t.entryMethod()
                + " sources=" + t.sources().size()
                + " arrows=" + arrows
                + " captureComplete=" + slice.captureComplete()
                + " captureGaps=" + slice.captureGaps());
        assertTrue(arrows > 0, "a derived slice with no arrows is not evidence of anything");
    }

    private static int indexOfEntryClass(List<String> sources, String entryClass) {
        for (int i = 0; i < sources.size(); i++) {
            if (sources.get(i).contains("class " + entryClass)) return i;
        }
        throw new IllegalStateException("no source declares class " + entryClass);
    }
}
