package com.designiscode.app.service;

import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DerivedSlice.CallSite;
import org.junit.jupiter.api.Test;

import static com.designiscode.app.service.Goldens.assertGolden;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The "readable slice" bar (demo.md): foreign-code noise classified and
 * collapsed, real arrows in flow order, gaps stated with their consequence.
 * Golden-pinned in both renderings; act1 = noisy foreign code, act2 =
 * DisC-shaped code (returns, capture-complete path).
 */
class SliceRendererTest {

    private final CallGraphDeriver deriver = new CallGraphDeriver();
    private final SliceRenderer renderer = new SliceRenderer();

    private DerivedSlice act1() {
        return deriver.derive(PetclinicFixtures.sources("act1"), "VisitController", "processNewVisitForm");
    }

    private DerivedSlice act2() {
        return deriver.derive(PetclinicFixtures.sources("act2"), "CancelVisitService", "cancel");
    }

    @Test
    void classifiesForDisplayOnly() {
        DerivedSlice slice = act1();
        assertEquals(SliceRenderer.SiteKind.COLLABORATOR, classify(slice, "owners", "save"));
        assertEquals(SliceRenderer.SiteKind.ENTITY, classify(slice, "owner", "addVisit"));
        assertEquals(SliceRenderer.SiteKind.ENTITY, classify(slice, "visit", "getDate"));
        assertEquals(SliceRenderer.SiteKind.UNRESOLVED, classify(slice, "result", "rejectValue"));
        assertEquals(SliceRenderer.SiteKind.UNRESOLVED, classify(slice, "LocalDate", "now"));
    }

    @Test
    void act1MarkdownIsReadable() {
        assertGolden("slice-act1.md", renderer.renderMarkdown(act1()));
    }

    @Test
    void act1PumlShowsFlowWithoutAccessorNoise() {
        String puml = renderer.renderPuml(act1());
        assertTrue(!puml.contains("getDate"), "bare accessors are reads, not flow");
        assertGolden("slice-act1.puml", puml);
    }

    @Test
    void act2MarkdownShowsCompleteCapture() {
        assertGolden("slice-act2.md", renderer.renderMarkdown(act2()));
    }

    @Test
    void act2PumlMirrorsEmitterStyle() {
        assertGolden("slice-act2.puml", renderer.renderPuml(act2()));
    }

    @Test
    void act2ModelMirrorsPumlArrows() {
        // The drawn diagram and the puml text must never disagree: same arrow
        // count, same order — entry first, final return last.
        DerivedSlice slice = act2();
        com.designiscode.app.dto.DiagramModel m = renderer.renderModel(slice);
        String puml = renderer.renderPuml(slice);

        long pumlArrows = puml.lines().filter(l -> l.contains(" -> ") || l.contains(" <-- ") || l.contains(" --> ")).count();
        assertEquals(pumlArrows, m.steps().size(), "model steps == puml arrows");

        var first = m.steps().get(0);
        assertEquals("call", first.kind());
        assertEquals("[*]", first.from());
        assertEquals("CancelVisitService", first.to());
        assertTrue(first.label().startsWith("cancel("));

        var last = m.steps().get(m.steps().size() - 1);
        assertEquals("return", last.kind());
        assertEquals("[*]", last.to());
        assertTrue(last.label().endsWith("CancellationResult"));

        assertTrue(m.participants().containsAll(
                java.util.List.of("[*]", "CancelVisitService", "OwnerLoader", "CancellationGuard")));
    }

    @Test
    void flattensMultilineArgsForDisplay() {
        // Anonymous-class args span lines in source (step-0 probe: RealWorld's
        // ResponseEntity.ok(new HashMap...)); display must be one bounded line.
        String sut = """
                package com.demo;
                public class Api {
                    public String go(String name) {
                        return Helper.wrap(new Object() {
                            public String toString() {
                                return name + name + name + name + name + name
                                        + name + name + name + name + name + name;
                            }
                        });
                    }
                }
                """;
        DerivedSlice slice = deriver.derive(java.util.List.of(sut), "Api", "go");
        String md = renderer.renderMarkdown(slice);

        String bullet = md.lines().filter(l -> l.contains("Helper.wrap(")).findFirst().orElseThrow();
        assertTrue(bullet.contains("…"), "long arg truncated: " + bullet);
        // 100-char arg cap + fixed bullet framing; anything near source length (~135+) means no flattening
        assertTrue(bullet.length() < 180, "bullet stays one bounded line, was " + bullet.length());
    }

    private SliceRenderer.SiteKind classify(DerivedSlice slice, String receiver, String method) {
        CallSite cs = slice.callSites().stream()
                .filter(s -> receiver.equals(s.receiver()) && method.equals(s.method()))
                .findFirst().orElseThrow();
        return renderer.classify(slice, cs);
    }
}
