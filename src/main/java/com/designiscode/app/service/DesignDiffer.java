package com.designiscode.app.service;

import com.designiscode.app.dto.BindingClassification;
import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DerivedSlice.CallSite;
import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DesignDelta.Change;
import com.designiscode.app.dto.DesignDelta.MappingRow;
import com.designiscode.app.dto.VariantRequest;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * Stage C of the code→design diff pipeline: compute the <i>minimal design
 * delta</i> to introduce a new variant behind an existing call site.
 *
 * <p>Phase-1 policy is enforced first: only a <b>request-dynamic</b> verdict is
 * generated (as the resolver pattern); <b>deploy-static</b> and
 * <b>runtime-global</b> are correctly classified but <b>parked</b> (Phase 2/3),
 * never forced into a wrong resolver; an unresolved classification passes the
 * one sharp question straight through as an <b>ask</b>.
 *
 * <p>The generated delta honours the discipline: the choice is delegated to a
 * resolver (orchestrator stays linear), existing variants are reused (leaves are
 * sacred), and a concrete callee is first given an extracted interface (DIP).
 */
@Service
public class DesignDiffer {

    public DesignDelta diff(DerivedSlice slice, BindingClassification c, VariantRequest req) {
        if (c.needsQuestion()) {
            return parkOrAsk(DesignDelta.ASK, c.question());
        }
        String bt = c.bindingTime();
        if (BindingTimeClassifier.BT_DEPLOY_STATIC.equals(bt)) {
            return parkOrAsk(DesignDelta.PARK, "deploy-static: variant selected at startup via "
                    + "@ConditionalOnProperty/@Profile bean — Phase 2, not generated in Phase 1");
        }
        if (BindingTimeClassifier.BT_RUNTIME_GLOBAL.equals(bt)) {
            return parkOrAsk(DesignDelta.PARK, "runtime-global: ops-flag-keyed selection — "
                    + "Phase 3, not generated in Phase 1");
        }
        if (BindingTimeClassifier.BT_REQUEST_DYNAMIC.equals(bt)) {
            return generateResolver(slice, c, req);
        }
        return parkOrAsk(DesignDelta.ASK, "binding time unresolved: " + c.rationale());
    }

    private DesignDelta generateResolver(DerivedSlice slice, BindingClassification c, VariantRequest req) {
        Optional<CallSite> vpOpt = BindingTimeClassifier.locate(slice, req.calleeType());
        if (vpOpt.isEmpty()) {
            return parkOrAsk(DesignDelta.ASK, "variation point '" + req.calleeType()
                    + "' not found among " + slice.sut() + "'s call sites");
        }
        CallSite vp = vpOpt.get();

        // A one-row mapping is a single-variant "family" — nothing to choose,
        // so the abstraction is never generated. Which ask depends on evidence:
        // other behavior already in code → the mapping is not total (finish the
        // table); no known variants → the ticket is additive, or the sources
        // are incomplete. Anticipated variance is explicitly not grounds — the
        // future family arrives as a cheap REGEN diff when its ticket does.
        if (req.mapping().size() < 2) {
            List<String> known = "class".equals(vp.calleeKind())
                    ? List.of(vp.calleeType())
                    : vp.calleeImpls();
            if (!known.isEmpty()) {
                return parkOrAsk(DesignDelta.ASK, "mapping has a single row, but `" + req.calleeType()
                        + "` already has behavior in code (" + String.join(", ", known)
                        + ") — a " + c.bindingTime() + " discriminator selects among ALL values of `"
                        + c.discriminator() + "`; add the missing mapping row(s) for the value(s) "
                        + "the existing behavior handles");
            }
            return parkOrAsk(DesignDelta.ASK, "single-variant family: only `" + req.newVariant()
                    + "` is mapped, so there is nothing to resolve. Either this ticket is additive — "
                    + "keep a plain call and introduce the family when a second variant's ticket "
                    + "arrives (regeneration makes that a cheap design diff) — or the implementations "
                    + "of `" + req.calleeType() + "` are missing from the provided sources");
        }

        List<Change> changes = new ArrayList<>();
        String strategyInterface;
        List<String> existingImpls;

        if ("class".equals(vp.calleeKind())) {
            // DIP: the callee is concrete — extract the abstraction before adding a variant.
            if (isBlank(req.strategyInterfaceName())) {
                return parkOrAsk(DesignDelta.ASK, "`" + req.calleeType() + "` is a concrete class; "
                        + "name the abstraction to extract (DIP) before adding a variant");
            }
            strategyInterface = req.strategyInterfaceName();
            existingImpls = List.of(req.calleeType());  // the concrete becomes the first variant
            changes.add(new Change("add", "entity", strategyInterface,
                    "interface extracted for DIP (the strategy contract)"));
            changes.add(new Change("extract-interface", "entity", req.calleeType(),
                    "now implements " + strategyInterface + " (behavior-preserving)"));
        } else {
            // The call site is already on an interface — reuse it as the strategy contract.
            strategyInterface = vp.calleeType();
            existingImpls = vp.calleeImpls();
            changes.add(new Change("reuse", "entity", strategyInterface, "existing strategy interface"));
            for (String impl : existingImpls) {
                changes.add(new Change("reuse", "entity", impl, "existing variant — leaf untouched"));
            }
        }

        changes.add(new Change("add", "entity", req.newVariant(),
                "new strategy implementing " + strategyInterface));

        List<String> permits = new ArrayList<>(existingImpls);
        permits.add(req.newVariant());

        String resolver = strategyInterface + "Resolver";
        changes.add(new Change("add", "participant", resolver,
                "resolver (isLeaf): resolve(key) -> " + strategyInterface));
        changes.add(new Change("add", "variance-axis", strategyInterface,
                "resolver; bindingTime=" + c.bindingTime()
                        + "; discriminatorSource=" + c.discriminatorSource()
                        + "; mapping " + renderMapping(req.mapping())));
        changes.add(new Change("add", "sidecar", resolver + ".decision.md",
                req.mapping().size() + " rows: key -> strategy"));

        // How the orchestrator itself is applied. Regen (wholesale overwrite from
        // the design) is sound only when Stage A captured the whole entry body;
        // otherwise fall back to add-only UPDATE and tell the reviewer why.
        String sutMode = slice.captureComplete() ? DesignDelta.SUT_REGEN : DesignDelta.SUT_UPDATE;
        if (DesignDelta.SUT_REGEN.equals(sutMode)) {
            changes.add(new Change("modify", "arrow", slice.sut(),
                    slice.sut() + " -> " + resolver + ".resolve(key), then dispatch to "
                            + strategyInterface + " (regenerated wholesale; linear, no branch at the orchestrator)"));
        } else {
            changes.add(new Change("note", "arrow", slice.sut(),
                    slice.sut() + "'s body was not fully derivable (" + String.join("; ", slice.captureGaps())
                            + ") — emitted as add-only UPDATE: the plugin regenerates its test to the "
                            + "resolve→dispatch flow, but you wire the resolver call into the body by hand"));
        }

        return new DesignDelta(DesignDelta.GENERATE, null, strategyInterface, resolver,
                permits, req.mapping(), c.bindingTime(), c.discriminator(), sutMode, changes);
    }

    private DesignDelta parkOrAsk(String disposition, String reason) {
        return new DesignDelta(disposition, reason, null, null, List.of(), List.of(), null, null, null, List.of());
    }

    private static String renderMapping(List<MappingRow> mapping) {
        return mapping.stream().map(r -> r.key() + "->" + r.strategy()).collect(Collectors.joining(", "));
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }
}
