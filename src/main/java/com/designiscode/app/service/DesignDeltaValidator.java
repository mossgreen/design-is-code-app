package com.designiscode.app.service;

import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DerivedSlice.CallSite;
import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DesignDelta.Change;
import com.designiscode.app.dto.DesignDelta.MappingRow;
import com.designiscode.app.dto.VariantRequest;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Deterministic, gold-free validation of a Stage-C {@link DesignDelta} against
 * the {@link DerivedSlice} and {@link VariantRequest} it came from. Sibling of
 * the analyzer's {@code DesignContractValidator}; answers one question — <i>is
 * this delta well-formed and minimal?</i>
 *
 * <p>The load-bearing checks: existing variants are <b>reused</b>, never
 * recreated or hand-modified (leaves are sacred); the SUT is rewired, never
 * recreated; the resolver's {@code mapping} covers the permit set
 * (existing impls + the new variant) exactly once; and Phase 1 only ever
 * generates {@code request-dynamic} (park otherwise).
 */
public final class DesignDeltaValidator {

    public record Report(List<String> violations, List<String> warnings) {
        public boolean ok() {
            return violations.isEmpty();
        }
    }

    private DesignDeltaValidator() {}

    public static Report validate(DerivedSlice slice, VariantRequest req, DesignDelta d) {
        List<String> v = new ArrayList<>();
        List<String> w = new ArrayList<>();

        // --- park / ask: must carry a reason and no generative payload ---
        if (!DesignDelta.GENERATE.equals(d.disposition())) {
            if (isBlank(d.reason())) v.add(d.disposition() + " delta must carry a reason");
            if (d.resolver() != null || !d.changes().isEmpty()) {
                v.add(d.disposition() + " delta must not carry generative changes");
            }
            return new Report(v, w);
        }

        // --- generate: shape ---
        if (isBlank(d.strategyInterface())) v.add("generate delta has no strategy interface");
        if (isBlank(d.resolver())) v.add("generate delta adds no resolver");
        if (!BindingTimeClassifier.BT_REQUEST_DYNAMIC.equals(d.bindingTime())) {
            v.add("Phase 1 generates only request-dynamic; got " + d.bindingTime());
        }

        // --- SUT apply mode: regen is sound only when the whole body was captured ---
        if (DesignDelta.SUT_REGEN.equals(d.sutMode())) {
            if (!slice.captureComplete()) {
                v.add("regenerate requires complete Stage A capture, but the entry body has gaps: "
                        + slice.captureGaps() + " — a wholesale overwrite would drop them");
            }
        } else if (DesignDelta.SUT_UPDATE.equals(d.sutMode())) {
            w.add("orchestrator emitted as add-only UPDATE (body not fully derivable: "
                    + slice.captureGaps() + ") — the resolver call must be wired into "
                    + slice.sut() + " by hand after the plugin runs");
        } else {
            v.add("generate delta must set sutMode to regen or update; got " + d.sutMode());
        }

        // --- the existing variant set, and the expected permit set ---
        CallSite vp = BindingTimeClassifier.locate(slice, req.calleeType()).orElse(null);
        Set<String> existing = new LinkedHashSet<>();
        if (vp != null) {
            if ("class".equals(vp.calleeKind())) existing.add(req.calleeType()); // DIP: concrete is the first variant
            else existing.addAll(vp.calleeImpls());
        } else {
            w.add("variation point '" + req.calleeType() + "' not found in slice — cannot check minimality fully");
        }
        Set<String> expectedPermits = new LinkedHashSet<>(existing);
        expectedPermits.add(req.newVariant());
        if (!new LinkedHashSet<>(d.permits()).equals(expectedPermits)) {
            v.add("permits " + d.permits() + " != existing impls + new variant " + expectedPermits);
        }

        // --- resolver mapping covers the permits exactly once ---
        List<String> strategies = d.mapping().stream().map(MappingRow::strategy).toList();
        if (!new HashSet<>(strategies).equals(new HashSet<>(d.permits())) || strategies.size() != d.permits().size()) {
            v.add("mapping strategies " + strategies + " do not cover permits " + d.permits() + " exactly once");
        }
        for (MappingRow r : d.mapping()) {
            if (isBlank(r.key())) v.add("mapping row with blank key");
        }

        // --- minimality / leaves sacred ---
        for (Change ch : d.changes()) {
            if ("entity".equals(ch.element()) && existing.contains(ch.name())
                    && !"reuse".equals(ch.op()) && !"extract-interface".equals(ch.op())) {
                v.add("existing variant " + ch.name() + " must be reused (or extract-interface), not "
                        + ch.op() + " — leaves are sacred");
            }
            if ("participant".equals(ch.element()) && ch.name().equals(slice.sut()) && "add".equals(ch.op())) {
                v.add("SUT " + slice.sut() + " must not be added — it already exists");
            }
        }

        // --- required additions are present and singular ---
        if (changesMatching(d, "add", "entity", req.newVariant()) != 1) {
            v.add("the new variant " + req.newVariant() + " must be added exactly once as an entity");
        }
        if (countOp(d, "add", "participant") < 1) v.add("no resolver participant added");
        if (countElement(d, "variance-axis") != 1) v.add("expected exactly one variance-axis change");
        if (countElement(d, "sidecar") < 1) v.add("expected a mapping sidecar");

        return new Report(v, w);
    }

    private static long changesMatching(DesignDelta d, String op, String element, String name) {
        return d.changes().stream()
                .filter(c -> op.equals(c.op()) && element.equals(c.element()) && name.equals(c.name()))
                .count();
    }

    private static long countOp(DesignDelta d, String op, String element) {
        return d.changes().stream().filter(c -> op.equals(c.op()) && element.equals(c.element())).count();
    }

    private static long countElement(DesignDelta d, String element) {
        return d.changes().stream().filter(c -> element.equals(c.element())).count();
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }
}
