package com.designiscode.app.service;

import com.designiscode.app.dto.BindingClassification;
import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DesignDelta.MappingRow;
import org.springframework.stereotype.Service;

import java.util.Set;
import java.util.stream.Collectors;

/**
 * The "why the new design is better" panel — deterministic markdown computed
 * from the delta, never an LLM call. Every number is derived (mapping size,
 * surrounding call count); every claim is bounded by what the pipeline actually
 * verified ({@code sutMode} decides whether the orchestrator claim is
 * "regenerated wholesale" or "wired by hand").
 */
@Service
public class WhyRenderer {

    public String renderMarkdown(DerivedSlice slice, DesignDelta delta, BindingClassification c) {
        int n = delta.mapping().size();
        Set<String> family = DesignDeltaEmitter.variantFamily(delta);
        long otherCalls = DesignDeltaEmitter.behavioralCallSites(slice).stream()
                .filter(cs -> !family.contains(cs.calleeType()))
                .count();
        String strategies = delta.mapping().stream()
                .map(MappingRow::strategy).collect(Collectors.joining(", "));

        StringBuilder md = new StringBuilder();
        md.append("## Why the new design\n\n");

        md.append("**The old way** — implement the ticket as an `").append(c.discriminator())
                .append("` branch inside `").append(slice.sut()).append("`:\n");
        md.append("- Every new `").append(c.discriminator()).append("` value edits `")
                .append(slice.sut()).append("` again: ").append(n).append(" branch")
                .append(n == 1 ? "" : "es").append(" today, ")
                .append(n + 1).append(" next time — the orchestrator never stops growing.\n");
        md.append("- `").append(slice.sut()).append("` knows every concrete strategy (")
                .append(strategies).append("); each branch multiplies its test cases — ");
        if (otherCalls > 0) {
            md.append(n).append(" branches × the ").append(otherCalls)
                    .append(" surrounding call").append(otherCalls == 1 ? "" : "s")
                    .append(" all re-verified per branch.\n");
        } else {
            md.append("every scenario of the method re-verified per branch.\n");
        }
        md.append("- The `").append(c.discriminator())
                .append("` decision is buried in a method body — invisible at review, ")
                .append("copy-paste bait at the next variation point.\n");

        md.append("\n**The new design** — the variance becomes a strategy family behind `")
                .append(delta.strategyInterface()).append("`:\n");
        md.append("- A new `").append(c.discriminator()).append("` value = 1 new class + 1 row in `")
                .append(delta.resolver()).append(".decision.md`. `").append(slice.sut())
                .append("` and its tests do not change.\n");
        md.append("- Each strategy is a leaf, testable alone against its own decision table.\n");
        md.append("- The mapping is a reviewable ").append(n)
                .append("-row table — totality is checkable, not buried in branches.\n");
        if (DesignDelta.SUT_REGEN.equals(delta.sutMode())) {
            md.append("- `").append(slice.sut())
                    .append("` stays linear (no branch at the orchestrator) — regenerated wholesale from the design.\n");
        } else {
            md.append("- Capture gaps block wholesale regeneration — the resolver call is wired into `")
                    .append(slice.sut()).append("` by hand (add-only UPDATE).\n");
        }

        md.append("\n**Test cost**: old way folds ").append(n).append(" branch")
                .append(n == 1 ? "" : "es").append(" into `").append(slice.sut())
                .append("`'s tests (every scenario re-run per branch); new way = ")
                .append(n).append(" leaf table").append(n == 1 ? "" : "s")
                .append(" + 1 resolver table (").append(n)
                .append(" rows), orchestrator tests unchanged.\n");
        return md.toString();
    }
}
