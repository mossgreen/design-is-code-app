package com.designiscode.app.service;

import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DerivedSlice.CallSite;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Stage A against REAL foreign code — the vendored PetClinic act1 fixtures
 * (code DisC never wrote). This is the demo's go/no-go gate: the derived slice
 * must be structurally right on brownfield sources — real arrows recovered,
 * noise recorded honestly, gaps flagged — and derivation must be deterministic
 * and stable under unrelated edits. Readability of the noisy slice is the
 * renderer's job ({@link SliceRenderer}), not Stage A's.
 */
class CallGraphDeriverPetclinicTest {

    private final CallGraphDeriver deriver = new CallGraphDeriver();

    private DerivedSlice derive() {
        return deriver.derive(PetclinicFixtures.sources("act1"), "VisitController", "processNewVisitForm");
    }

    private static List<CallSite> sitesOn(DerivedSlice slice, String receiver) {
        return slice.callSites().stream().filter(cs -> receiver.equals(cs.receiver())).toList();
    }

    @Test
    void wiringAndEntrySurface() {
        DerivedSlice slice = derive();

        assertEquals("VisitController", slice.sut());
        assertEquals("org.springframework.samples.petclinic.owner", slice.targetPackage());
        assertTrue(slice.orchestrator());

        assertEquals(1, slice.dependencies().size());
        DerivedSlice.Dependency owners = slice.dependencies().get(0);
        assertEquals("owners", owners.name());
        assertEquals("OwnerRepository", owners.type());
        assertEquals("constructor", owners.injection());

        assertEquals("processNewVisitForm", slice.entryMethod().name());
        assertEquals("String", slice.entryMethod().returns());
        assertEquals(List.of("owner", "petId", "visit", "result", "redirectAttributes"),
                slice.entryMethod().params().stream().map(DerivedSlice.Param::name).toList());
    }

    @Test
    void realArrowsRecovered() {
        DerivedSlice slice = derive();

        List<CallSite> onOwner = sitesOn(slice, "owner");
        assertEquals(1, onOwner.size());
        CallSite addVisit = onOwner.get(0);
        assertEquals("addVisit", addVisit.method());
        assertEquals("Owner", addVisit.calleeType());
        assertEquals("class", addVisit.calleeKind());
        assertEquals(List.of("petId", "visit"), addVisit.args());
        assertEquals("void", addVisit.calleeMethodSig().returns());

        List<CallSite> onOwners = sitesOn(slice, "owners");
        assertEquals(1, onOwners.size());
        CallSite save = onOwners.get(0);
        assertEquals("save", save.method());
        assertEquals("OwnerRepository", save.calleeType());
        assertEquals("interface", save.calleeKind());
        // save() is inherited from JpaRepository, which is outside the provided
        // sources — the lexical resolver cannot see its signature. Documented limit.
        assertNull(save.calleeMethodSig());
        assertEquals(List.of(), save.calleeImpls());
    }

    @Test
    void noiseRecordedHonestly() {
        DerivedSlice slice = derive();

        // Entity getters in the validation condition surface as call sites on a
        // provided class — real but not flow: the renderer's classification problem.
        List<CallSite> onVisit = sitesOn(slice, "visit");
        assertEquals(2, onVisit.size());
        assertTrue(onVisit.stream().allMatch(cs -> "getDate".equals(cs.method())
                && "Visit".equals(cs.calleeType()) && "class".equals(cs.calleeKind())));

        // Framework types not in the provided sources: type known lexically, kind unknown.
        assertTrue(sitesOn(slice, "result").stream()
                .allMatch(cs -> "BindingResult".equals(cs.calleeType()) && "unknown".equals(cs.calleeKind())));
        assertEquals(List.of("rejectValue", "hasErrors"),
                sitesOn(slice, "result").stream().map(CallSite::method).toList());
        assertTrue(sitesOn(slice, "redirectAttributes").stream()
                .allMatch(cs -> "unknown".equals(cs.calleeKind())));

        // A static call's receiver is a bare class name that resolves to nothing.
        List<CallSite> onLocalDate = sitesOn(slice, "LocalDate");
        assertEquals(1, onLocalDate.size());
        assertEquals("now", onLocalDate.get(0).method());
        assertNull(onLocalDate.get(0).calleeType());
        assertEquals("unknown", onLocalDate.get(0).calleeKind());
    }

    @Test
    void captureGapsBlockRegen() {
        DerivedSlice slice = derive();

        assertFalse(slice.captureComplete());
        assertTrue(slice.captureGaps().stream().anyMatch(g -> g.contains("branch")),
                () -> "expected the if-statements to be flagged; gaps=" + slice.captureGaps());
        assertTrue(slice.captureGaps().stream().anyMatch(g -> g.contains("isAfter")),
                () -> "expected the chained isAfter call to be unattributable; gaps=" + slice.captureGaps());
    }

    @Test
    void derivationIsDeterministic() {
        assertEquals(derive(), derive());
    }

    @Test
    void unrelatedEditLeavesSliceUnchanged() {
        DerivedSlice before = derive();

        // (1) A new method elsewhere in the class must not move the slice.
        List<String> withExtraMethod = mutateVisitController(src -> src.replace(
                "\t@InitBinder",
                "\tpublic String ping() {\n\t\treturn \"pong\";\n\t}\n\n\t@InitBinder"));
        assertEquals(before, deriver.derive(withExtraMethod, "VisitController", "processNewVisitForm"));

        // (2) A call-free local inside the entry body must not move the slice either.
        List<String> withExtraLocal = mutateVisitController(src -> src.replace(
                "\t\towner.addVisit(petId, visit);",
                "\t\tint unused = 1;\n\t\towner.addVisit(petId, visit);"));
        assertEquals(before, deriver.derive(withExtraLocal, "VisitController", "processNewVisitForm"));
    }

    private static List<String> mutateVisitController(java.util.function.UnaryOperator<String> mutation) {
        List<String> mutated = PetclinicFixtures.sources("act1").stream()
                .map(src -> src.contains("class VisitController") ? mutation.apply(src) : src)
                .toList();
        assertTrue(mutated.stream().anyMatch(s -> s.contains("class VisitController")), "fixture present");
        return mutated;
    }
}
