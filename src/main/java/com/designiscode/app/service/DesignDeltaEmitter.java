package com.designiscode.app.service;

import com.designiscode.app.dto.ApplyArtifacts;
import com.designiscode.app.dto.DecisionTableFile;
import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DerivedSlice.CallSite;
import com.designiscode.app.dto.DerivedSlice.MethodSig;
import com.designiscode.app.dto.DerivedSlice.Param;
import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DesignDelta.MappingRow;
import org.springframework.stereotype.Service;

import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Stage E of the code→design diff pipeline: compile a {@link DesignDelta} into
 * DisC grammar artifacts — a complete {@code .puml} plus the resolver
 * decision-table sidecar — so the plugin can apply it.
 *
 * <p>Grammar is grounded in the Java profile (java_spring.md): the resolver's
 * strategy family is the canonical {@code <<interface>> <<@permits:...>>} case,
 * with one permit class per variant. Existing variants are emitted REUSE
 * ({@code <<@class:fqn>>}, leaves sacred); the new variant is CREATE
 * ({@code <<class>>}, the plugin generates a skeleton impl + test to fill). The
 * resolver sidecar mirrors the wizard's existing emitter exactly, so Phase 1
 * needs no grammar/plugin change.
 *
 * <p><b>Orchestrator apply mode.</b> When Stage A captured the entry body
 * completely ({@code delta.sutMode() == regen}), the SUT is emitted
 * {@code <<@regen:fqn>>} and its <i>complete</i> flow is reproduced — every
 * behavioral collaborator call in order, with only the variation point rewritten
 * to resolve→dispatch — so the plugin's wholesale overwrite preserves the rest.
 * When capture was incomplete, the SUT is emitted as a bare participant
 * (add-only UPDATE): the plugin regenerates its <i>test</i> to the new flow but
 * leaves the body for a human to wire. The {@link DesignDiffer} decides which,
 * and {@link DesignDeltaValidator} refuses a {@code regen} that isn't backed by
 * complete capture.
 */
@Service
public class DesignDeltaEmitter {

    public ApplyArtifacts emit(DerivedSlice slice, DesignDelta delta) {
        if (!DesignDelta.GENERATE.equals(delta.disposition())) {
            throw new IllegalArgumentException(
                    "emit() requires a generate delta; got '" + delta.disposition() + "'");
        }
        String pkg = slice.targetPackage();
        String iface = delta.strategyInterface();
        String resolver = delta.resolver();
        MethodSig method = strategyMethod(slice, delta);

        StringBuilder p = new StringBuilder();
        p.append("@startuml\n");
        if (notBlank(pkg)) p.append("' @package ").append(pkg).append('\n');

        p.append("\n' @disc-entities resolver strategy family + reused domain types\n");
        for (String t : referencedDomainTypes(slice, delta, method)) {
            p.append("class ").append(t).append(" <<@class:").append(fqnOf(slice, t)).append(">>\n");
        }
        // strategy interface — the permit manifest the resolver mode requires
        p.append("class ").append(iface).append(" <<interface>> <<@permits:")
                .append(String.join(",", delta.permits())).append(">> {\n");
        p.append("  + ").append(renderMethod(method)).append('\n');
        p.append("}\n");
        // permit classes: existing → REUSE (sacred); new variant → CREATE
        for (String permit : delta.permits()) {
            String fqn = fqnOf(slice, permit);
            if (fqn != null) p.append("class ").append(permit).append(" <<@class:").append(fqn).append(">>\n");
            else p.append("class ").append(permit).append(" <<class>>\n");
        }

        boolean regen = DesignDelta.SUT_REGEN.equals(delta.sutMode());
        String sutFqn = fqnOf(slice, slice.sut());
        Set<String> family = variantFamily(delta);
        List<CallSite> flow = behavioralCallSites(slice);

        p.append("\n' @disc-classification CREATE (no stereotype), REUSE (@class), REGEN (@regen), UPDATE (@class + +methods)\n");
        if (regen && sutFqn != null) {
            // whole body captured → the plugin overwrites the orchestrator from this design
            p.append("participant ").append(slice.sut()).append(" <<@regen:").append(sutFqn).append(">>\n");
        } else {
            // capture incomplete → add-only UPDATE; a human wires the resolver into the body
            p.append("participant ").append(slice.sut()).append('\n');
        }
        p.append("participant ").append(resolver).append('\n');      // resolver — CREATE
        if (regen) {
            // the orchestrator's other (non-variance) collaborators, so a wholesale
            // overwrite preserves them; each already exists → REUSE
            for (CallSite cs : flow) {
                if (family.contains(cs.calleeType())) continue;
                String fqn = fqnOf(slice, cs.calleeType());
                if (fqn != null) p.append("participant ").append(cs.calleeType())
                        .append(" <<@class:").append(fqn).append(">>\n");
            }
        }

        p.append('\n');
        String entryArgs = slice.entryMethod().params().stream()
                .map(Param::name).collect(Collectors.joining(", "));
        p.append("[*] -> ").append(slice.sut()).append(" : ")
                .append(slice.entryMethod().name()).append('(').append(entryArgs).append(")\n");

        String dispatchName = method == null ? "apply" : method.name();
        String dispatchArgs = method == null ? ""
                : method.params().stream().map(Param::name).collect(Collectors.joining(", "));

        if (regen) {
            // reproduce the complete flow in order; rewrite only the variation point to resolve→dispatch
            boolean resolverEmitted = false;
            for (CallSite cs : flow) {
                if (family.contains(cs.calleeType())) {
                    if (!resolverEmitted) {
                        appendResolve(p, slice.sut(), resolver, iface);
                        resolverEmitted = true;
                    }
                    p.append(slice.sut()).append(" -> ").append(iface).append(" : ")
                            .append(dispatchName).append('(').append(dispatchArgs).append(")\n");
                    appendReturnArrow(p, slice.sut(), iface, cs.resultName(),
                            method == null ? null : method.returns());
                } else {
                    p.append(slice.sut()).append(" -> ").append(cs.calleeType()).append(" : ")
                            .append(cs.method()).append('(').append(String.join(", ", cs.args())).append(")\n");
                    appendReturnArrow(p, slice.sut(), cs.calleeType(), cs.resultName(),
                            cs.calleeMethodSig() == null ? null : cs.calleeMethodSig().returns());
                }
            }
            if (!resolverEmitted) {  // defensive: variation point wasn't among captured calls
                appendResolve(p, slice.sut(), resolver, iface);
                p.append(slice.sut()).append(" -> ").append(iface).append(" : ")
                        .append(dispatchName).append('(').append(dispatchArgs).append(")\n");
            }
        } else {
            // add-only UPDATE: only the resolver rewrite is specified; the body is not regenerated
            appendResolve(p, slice.sut(), resolver, iface);
            p.append(slice.sut()).append(" -> ").append(iface).append(" : ")
                    .append(dispatchName).append('(').append(dispatchArgs).append(")\n");
        }

        String ret = slice.entryMethod().returns();
        if (notBlank(ret) && !"void".equals(ret)) {
            p.append(slice.sut()).append(" --> [*] : result : ").append(simpleName(ret)).append('\n');
        }
        p.append("@enduml\n");

        DecisionTableFile sidecar = new DecisionTableFile(
                resolver + ".decision.md", resolverSidecar(pkg, resolver, iface, delta.mapping()));

        return new ApplyArtifacts(slice.sut() + ".puml", p.toString(), List.of(sidecar));
    }

    /** The resolver decision-table sidecar, byte-compatible with the wizard's emitter. */
    private String resolverSidecar(String pkg, String resolver, String iface, List<MappingRow> mapping) {
        StringBuilder s = new StringBuilder();
        s.append("---\n");
        s.append("target: ").append(resolver).append(".resolve\n");
        if (notBlank(pkg)) s.append("package: ").append(pkg).append('\n');
        s.append("input:\n");
        s.append("  key: String\n");
        s.append("output: ").append(iface).append('\n');
        s.append("---\n\n");
        s.append("| key | expected |\n");
        s.append("| --- | --- |\n");
        for (MappingRow r : mapping) {
            s.append("| ").append(r.key()).append(" | ").append(r.strategy()).append(" |\n");
        }
        return s.toString();
    }

    /**
     * The strategy operation: the method invoked at the variation point. Only a
     * call site in the variant family counts — never an unrelated collaborator's
     * signature. Null when the family method wasn't resolved (renderMethod then
     * falls back to the generic {@code apply(input: Object): Object}).
     */
    private MethodSig strategyMethod(DerivedSlice slice, DesignDelta delta) {
        Set<String> family = variantFamily(delta);
        return slice.callSites().stream()
                .filter(cs -> cs.calleeMethodSig() != null && family.contains(cs.calleeType()))
                .map(CallSite::calleeMethodSig)
                .findFirst()
                .orElse(null);
    }

    /** The variance family: the strategy interface plus every permit class. */
    private Set<String> variantFamily(DesignDelta delta) {
        Set<String> family = new HashSet<>(delta.permits());
        family.add(delta.strategyInterface());
        return family;
    }

    /** The orchestrator's behavioral collaborator calls, in body order (resolved only). */
    private List<CallSite> behavioralCallSites(DerivedSlice slice) {
        return slice.callSites().stream()
                .filter(cs -> "interface".equals(cs.calleeKind()) || "class".equals(cs.calleeKind()))
                .filter(cs -> cs.calleeType() != null)
                .toList();
    }

    /** The resolver rewrite: resolve the strategy, then the orchestrator holds the abstraction. */
    private void appendResolve(StringBuilder p, String sut, String resolver, String iface) {
        p.append(sut).append(" -> ").append(resolver).append(" : resolve(key)\n");
        p.append(resolver).append(" --> ").append(sut).append(" : strategy : ").append(iface).append('\n');
    }

    /** A typed return arrow {@code SUT <-- from : name : Type}, or nothing (void / unnamed result). */
    private void appendReturnArrow(StringBuilder p, String sut, String from, String resultName, String returns) {
        if (resultName == null || resultName.isBlank()) return;
        String t = simpleName(returns);
        if (t == null || t.isEmpty() || "void".equals(t)) return;
        p.append(sut).append(" <-- ").append(from).append(" : ").append(resultName).append(" : ").append(t).append('\n');
    }

    /** Strip generics and package from a type: {@code java.util.List<Order>} → {@code List}. */
    private static String simpleName(String type) {
        if (type == null) return null;
        String t = type;
        int lt = t.indexOf('<');
        if (lt >= 0) t = t.substring(0, lt);
        int dot = t.lastIndexOf('.');
        if (dot >= 0) t = t.substring(dot + 1);
        return t.trim();
    }

    private Set<String> referencedDomainTypes(DerivedSlice slice, DesignDelta delta, MethodSig method) {
        Set<String> out = new LinkedHashSet<>();
        addType(out, slice.entryMethod().returns());
        slice.entryMethod().params().forEach(pp -> addType(out, pp.type()));
        if (method != null) {
            addType(out, method.returns());
            method.params().forEach(pp -> addType(out, pp.type()));
        }
        Set<String> exclude = new HashSet<>(delta.permits());
        exclude.add(delta.strategyInterface());
        out.removeIf(t -> exclude.contains(t) || fqnOf(slice, t) == null);
        return out;
    }

    private void addType(Set<String> out, String type) {
        if (type == null) return;
        String t = type;
        int lt = t.indexOf('<');
        if (lt >= 0) t = t.substring(0, lt);
        int dot = t.lastIndexOf('.');
        if (dot >= 0) t = t.substring(dot + 1);
        t = t.trim();
        if (!t.isEmpty()) out.add(t);
    }

    private String fqnOf(DerivedSlice slice, String name) {
        return slice.knownTypes().stream()
                .filter(t -> t.name().equals(name))
                .map(DerivedSlice.TypeRef::fqn)
                .findFirst().orElse(null);
    }

    private static String renderMethod(MethodSig m) {
        if (m == null) return "apply(input: Object): Object";
        String params = m.params().stream()
                .map(pp -> pp.name() + ": " + pp.type())
                .collect(Collectors.joining(", "));
        return m.name() + "(" + params + "): " + m.returns();
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }
}
