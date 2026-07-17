package com.designiscode.app.service;

import com.designiscode.app.dto.BindingClassification;
import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DerivedSlice.CallSite;
import com.designiscode.app.dto.DerivedSlice.MethodSig;
import com.designiscode.app.dto.DerivedSlice.Param;
import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DiagramModel;
import com.designiscode.app.dto.DiagramModel.Step;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Stage-D presentation: the before/after pair the reviewer compares.
 *
 * <p><b>Old way</b> — the naive-patch counterfactual: the derived flow with the
 * ticket implemented as a discriminator branch inside the orchestrator (one
 * {@code alt} branch per mapping key, each calling its concrete strategy
 * inline). Never generated — it exists to make the cost of the branchy path
 * visible per ticket.
 *
 * <p><b>New way</b> — the same flow with the variation point rewritten to
 * resolve→dispatch, mirroring {@link DesignDeltaEmitter}'s arrows exactly.
 *
 * <p>Both sides share the emitter's flow selection
 * ({@link DesignDeltaEmitter#behavioralCallSites}) so the two diagrams differ
 * <i>only</i> at the variation point — that is what makes the comparison honest.
 */
@Service
public class CounterfactualRenderer {

    /** The naive-patch counterfactual as renderable data. */
    public DiagramModel oldWayModel(DerivedSlice slice, DesignDelta delta, BindingClassification c) {
        List<Step> steps = new ArrayList<>();
        Set<String> participants = new LinkedHashSet<>();
        participants.add("[*]");
        participants.add(slice.sut());

        steps.add(Step.call("[*]", slice.sut(), entryLabel(slice)));

        MethodSig method = DesignDeltaEmitter.strategyMethod(slice, delta);
        Set<String> family = DesignDeltaEmitter.variantFamily(delta);
        String dispatchName = method == null ? "apply" : method.name();
        String dispatchArgs = method == null ? ""
                : method.params().stream().map(Param::name).collect(Collectors.joining(", "));
        String dispatchReturns = method == null ? null : method.returns();

        boolean branchEmitted = false;
        for (CallSite cs : DesignDeltaEmitter.behavioralCallSites(slice)) {
            if (family.contains(cs.calleeType())) {
                if (branchEmitted) continue; // defensive: one alt block per diagram
                branchEmitted = true;
                boolean first = true;
                for (DesignDelta.MappingRow row : delta.mapping()) {
                    String guard = c.discriminator() + " == " + row.key();
                    steps.add(first ? Step.altStart(guard) : Step.altElse(guard));
                    first = false;
                    participants.add(row.strategy());
                    steps.add(Step.call(slice.sut(), row.strategy(),
                            dispatchName + "(" + dispatchArgs + ")"));
                    addReturn(steps, slice.sut(), row.strategy(), cs.resultName(), dispatchReturns);
                }
                steps.add(Step.altEnd());
            } else {
                participants.add(cs.calleeType());
                steps.add(Step.call(slice.sut(), cs.calleeType(),
                        cs.method() + "(" + String.join(", ", cs.args()) + ")"));
                addReturn(steps, slice.sut(), cs.calleeType(), cs.resultName(),
                        cs.calleeMethodSig() == null ? null : cs.calleeMethodSig().returns());
            }
        }

        addFinalReturn(steps, slice);
        return new DiagramModel(List.copyOf(participants), steps);
    }

    /** The old-way counterfactual as puml — for the golden and the copy button. */
    public String oldWayPuml(DerivedSlice slice, DesignDelta delta, BindingClassification c) {
        DiagramModel m = oldWayModel(slice, delta, c);
        StringBuilder p = new StringBuilder();
        p.append("@startuml\n");
        p.append("' the old way — ").append(c.discriminator()).append(" as a branch in ")
                .append(slice.sut()).append(" (counterfactual for review; never generated)\n\n");
        m.participants().stream().filter(x -> !"[*]".equals(x))
                .forEach(x -> p.append("participant ").append(x).append('\n'));
        p.append('\n');
        for (Step s : m.steps()) {
            switch (s.kind()) {
                case "call" -> p.append(s.from()).append(" -> ").append(s.to())
                        .append(" : ").append(s.label()).append('\n');
                case "return" -> p.append(s.to()).append(" <-- ").append(s.from())
                        .append(" : ").append(s.label()).append('\n');
                case "alt-start" -> p.append("alt ").append(s.label()).append('\n');
                case "alt-else" -> p.append("else ").append(s.label()).append('\n');
                case "alt-end" -> p.append("end\n");
                default -> throw new IllegalStateException("unknown step kind: " + s.kind());
            }
        }
        p.append("@enduml\n");
        return p.toString();
    }

    /** The target design as renderable data — mirrors {@link DesignDeltaEmitter}'s flow arrows. */
    public DiagramModel newWayModel(DerivedSlice slice, DesignDelta delta) {
        List<Step> steps = new ArrayList<>();
        Set<String> participants = new LinkedHashSet<>();
        participants.add("[*]");
        participants.add(slice.sut());

        steps.add(Step.call("[*]", slice.sut(), entryLabel(slice)));

        MethodSig method = DesignDeltaEmitter.strategyMethod(slice, delta);
        Set<String> family = DesignDeltaEmitter.variantFamily(delta);
        String iface = delta.strategyInterface();
        String resolver = delta.resolver();
        String dispatchName = method == null ? "apply" : method.name();
        String dispatchArgs = method == null ? ""
                : method.params().stream().map(Param::name).collect(Collectors.joining(", "));

        boolean resolverEmitted = false;
        for (CallSite cs : DesignDeltaEmitter.behavioralCallSites(slice)) {
            if (family.contains(cs.calleeType())) {
                if (!resolverEmitted) {
                    participants.add(resolver);
                    steps.add(Step.call(slice.sut(), resolver, "resolve(key)"));
                    steps.add(Step.ret(resolver, slice.sut(), "strategy : " + iface));
                    resolverEmitted = true;
                }
                participants.add(iface);
                steps.add(Step.call(slice.sut(), iface, dispatchName + "(" + dispatchArgs + ")"));
                addReturn(steps, slice.sut(), iface, cs.resultName(),
                        method == null ? null : method.returns());
            } else {
                participants.add(cs.calleeType());
                steps.add(Step.call(slice.sut(), cs.calleeType(),
                        cs.method() + "(" + String.join(", ", cs.args()) + ")"));
                addReturn(steps, slice.sut(), cs.calleeType(), cs.resultName(),
                        cs.calleeMethodSig() == null ? null : cs.calleeMethodSig().returns());
            }
        }
        if (!resolverEmitted) { // defensive: variation point wasn't among captured calls
            participants.add(resolver);
            participants.add(iface);
            steps.add(Step.call(slice.sut(), resolver, "resolve(key)"));
            steps.add(Step.ret(resolver, slice.sut(), "strategy : " + iface));
            steps.add(Step.call(slice.sut(), iface, dispatchName + "(" + dispatchArgs + ")"));
        }

        addFinalReturn(steps, slice);
        return new DiagramModel(List.copyOf(participants), steps);
    }

    // --- helpers ---

    private static String entryLabel(DerivedSlice slice) {
        String args = slice.entryMethod().params().stream()
                .map(Param::name).collect(Collectors.joining(", "));
        return slice.entryMethod().name() + "(" + args + ")";
    }

    /** A typed return step, or nothing (void / unnamed result) — emitter parity. */
    private static void addReturn(List<Step> steps, String sut, String from, String resultName, String returns) {
        if (resultName == null || resultName.isBlank()) return;
        String t = DesignDeltaEmitter.simpleName(returns);
        if (t == null || t.isEmpty() || "void".equals(t)) return;
        steps.add(Step.ret(from, sut, resultName + " : " + t));
    }

    private static void addFinalReturn(List<Step> steps, DerivedSlice slice) {
        String ret = slice.entryMethod().returns();
        if (ret != null && !ret.isBlank() && !"void".equals(ret)) {
            steps.add(Step.ret(slice.sut(), "[*]", "result : " + DesignDeltaEmitter.simpleName(ret)));
        }
    }
}
