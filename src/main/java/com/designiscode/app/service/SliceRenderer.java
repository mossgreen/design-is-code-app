package com.designiscode.app.service;

import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DerivedSlice.CallSite;
import com.designiscode.app.dto.DerivedSlice.Param;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Renders a Stage-A {@link DerivedSlice} for humans — the "what IS" half of a
 * design-first PR body. Pure post-processing: Stage A stays honest and
 * unfiltered; this class only <i>classifies for display</i>:
 *
 * <ul>
 *   <li><b>COLLABORATOR</b> — a call on an injected dependency (the flow);</li>
 *   <li><b>ENTITY</b> — a call on a provided domain type (state changes are
 *       part of the flow; bare accessors are reads);</li>
 *   <li><b>UNRESOLVED</b> — framework, static, or chained receivers the
 *       lexical scope cannot attribute (collapsed, never hidden).</li>
 * </ul>
 *
 * <p>The puml view mirrors {@link DesignDeltaEmitter}'s arrow and typed-return
 * style so the what-IS diagram and the target design read alike.
 */
@Service
public class SliceRenderer {

    /** Display classification of one call site (rendering only — never fed back into the pipeline). */
    enum SiteKind {
        COLLABORATOR, ENTITY, UNRESOLVED
    }

    SiteKind classify(DerivedSlice slice, CallSite cs) {
        boolean onDependency = slice.dependencies().stream()
                .anyMatch(d -> d.name().equals(cs.receiver()));
        if (onDependency) return SiteKind.COLLABORATOR;
        if (cs.calleeType() != null && isKnownType(slice, cs.calleeType())) return SiteKind.ENTITY;
        return SiteKind.UNRESOLVED;
    }

    // --- markdown ---

    public String renderMarkdown(DerivedSlice slice) {
        StringBuilder md = new StringBuilder();
        md.append("## Derived design slice — ").append(slice.sut())
                .append('.').append(slice.entryMethod().name()).append("\n\n");
        md.append("- **Entry:** `").append(renderSig(slice.entryMethod())).append("`\n");
        md.append("- **Package:** `").append(slice.targetPackage()).append("`\n");
        for (DerivedSlice.Dependency d : slice.dependencies()) {
            md.append("- **Wiring:** `").append(d.name()).append(": ").append(d.type())
                    .append("` (").append(d.injection()).append(')').append('\n');
        }

        List<CallSite> flow = sitesOf(slice, SiteKind.COLLABORATOR);
        md.append("\n### Flow — calls on injected collaborators\n");
        if (flow.isEmpty()) {
            md.append("_None derived._\n");
        }
        int i = 0;
        for (CallSite cs : flow) {
            md.append(++i).append(". `").append(cs.receiver()).append('.').append(cs.method())
                    .append('(').append(flatArgs(cs)).append(")` → `")
                    .append(cs.calleeType()).append('.').append(cs.method()).append('`');
            appendResult(md, cs);
            md.append('\n');
        }

        List<CallSite> entity = sitesOf(slice, SiteKind.ENTITY);
        if (!entity.isEmpty()) {
            md.append("\n### Entity interactions — calls on provided domain types\n");
            Map<String, Map<String, Integer>> byType = new LinkedHashMap<>();
            for (CallSite cs : entity) {
                String call = cs.method() + "(" + flatArgs(cs) + ")";
                byType.computeIfAbsent(cs.calleeType(), k -> new LinkedHashMap<>())
                        .merge(call, 1, Integer::sum);
            }
            byType.forEach((type, calls) -> md.append("- `").append(type).append("`: ")
                    .append(calls.entrySet().stream()
                            .map(e -> "`" + e.getKey() + "`" + (e.getValue() > 1 ? " ×" + e.getValue() : ""))
                            .collect(Collectors.joining(", ")))
                    .append('\n'));
        }

        List<CallSite> unresolved = sitesOf(slice, SiteKind.UNRESOLVED);
        if (!unresolved.isEmpty()) {
            md.append("\n### Not derived — framework, static, or chained receivers\n");
            for (CallSite cs : unresolved) {
                md.append("- `").append(cs.receiver()).append('.').append(cs.method())
                        .append('(').append(flatArgs(cs)).append(")`");
                if (cs.calleeType() != null) {
                    md.append(" — `").append(cs.calleeType()).append("` not among the provided sources");
                } else {
                    md.append(" — receiver type unresolved (static or unprovided)");
                }
                md.append('\n');
            }
        }

        if (slice.captureComplete()) {
            md.append("\n### Capture complete — the orchestrator may be regenerated wholesale\n");
        } else {
            md.append("\n### Capture gaps — wholesale REGEN blocked; add-only UPDATE is the fallback\n");
            for (String gap : slice.captureGaps()) {
                md.append("- ").append(flatten(gap)).append('\n');
            }
        }
        return md.toString();
    }

    // --- puml (what-IS view) ---

    /**
     * A minimal sequence diagram of the derived flow: collaborator calls plus
     * entity interactions, excluding bare accessors ({@code get*}/{@code is*}
     * with no arguments) — reads are slice detail, not flow. Read-only view;
     * NOT a DisC design artifact (no classification prelude).
     */
    public String renderPuml(DerivedSlice slice) {
        List<CallSite> arrows = slice.callSites().stream()
                .filter(cs -> {
                    SiteKind k = classify(slice, cs);
                    if (k == SiteKind.UNRESOLVED) return false;
                    return k == SiteKind.COLLABORATOR || !isBareAccessor(cs);
                })
                .toList();

        StringBuilder p = new StringBuilder();
        p.append("@startuml\n");
        p.append("' @package ").append(slice.targetPackage()).append('\n');
        p.append("' derived what-IS slice of ").append(slice.sut()).append('.')
                .append(slice.entryMethod().name()).append(" — read-only view, not a design artifact\n\n");
        p.append("participant ").append(slice.sut()).append('\n');
        arrows.stream().map(CallSite::calleeType).distinct()
                .forEach(t -> p.append("participant ").append(t).append('\n'));

        p.append('\n');
        String entryArgs = slice.entryMethod().params().stream()
                .map(Param::name).collect(Collectors.joining(", "));
        p.append("[*] -> ").append(slice.sut()).append(" : ")
                .append(slice.entryMethod().name()).append('(').append(entryArgs).append(")\n");
        for (CallSite cs : arrows) {
            p.append(slice.sut()).append(" -> ").append(cs.calleeType()).append(" : ")
                    .append(cs.method()).append('(').append(flatArgs(cs)).append(")\n");
            String returns = cs.calleeMethodSig() == null ? null : cs.calleeMethodSig().returns();
            if (cs.resultName() != null && returns != null && !"void".equals(returns)) {
                p.append(slice.sut()).append(" <-- ").append(cs.calleeType()).append(" : ")
                        .append(cs.resultName()).append(" : ").append(CallGraphDeriver.simpleType(returns)).append('\n');
            }
        }
        String ret = slice.entryMethod().returns();
        if (ret != null && !ret.isBlank() && !"void".equals(ret)) {
            p.append(slice.sut()).append(" --> [*] : result : ").append(CallGraphDeriver.simpleType(ret)).append('\n');
        }
        p.append("@enduml\n");
        return p.toString();
    }

    // --- helpers ---

    private List<CallSite> sitesOf(DerivedSlice slice, SiteKind kind) {
        return slice.callSites().stream().filter(cs -> classify(slice, cs) == kind).toList();
    }

    private void appendResult(StringBuilder md, CallSite cs) {
        String returns = cs.calleeMethodSig() == null ? null : cs.calleeMethodSig().returns();
        if (cs.resultName() != null && returns != null && !"void".equals(returns)) {
            md.append(" ⇒ `").append(cs.resultName()).append(" : ")
                    .append(CallGraphDeriver.simpleType(returns)).append('`');
        }
    }

    private static boolean isBareAccessor(CallSite cs) {
        return cs.args().isEmpty()
                && (cs.method().matches("get[A-Z].*") || cs.method().matches("is[A-Z].*"));
    }

    /**
     * Args and gap texts are raw source expressions — anonymous classes and
     * lambdas span lines. Collapse whitespace and cap length for display; the
     * full expression stays in the slice JSON.
     */
    private static String flatten(String s) {
        String flat = s.replaceAll("\\s+", " ").trim();
        return flat.length() <= 100 ? flat : flat.substring(0, 99) + "…";
    }

    private static String flatArgs(CallSite cs) {
        return flatten(String.join(", ", cs.args()));
    }

    private static boolean isKnownType(DerivedSlice slice, String simpleName) {
        return slice.knownTypes().stream().anyMatch(t -> t.name().equals(simpleName));
    }

    private static String renderSig(DerivedSlice.MethodSig m) {
        String params = m.params().stream()
                .map(p -> p.name() + ": " + p.type())
                .collect(Collectors.joining(", "));
        return m.name() + "(" + params + "): " + m.returns();
    }
}
