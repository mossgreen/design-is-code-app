package com.designiscode.app.service;

import com.designiscode.app.dto.BindingClassification;
import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DesignDelta.Change;
import com.designiscode.app.dto.DesignDelta.MappingRow;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * Renders a design delta for humans — the "what SHOULD change" half of a
 * design-first PR body. {@link DesignDelta#changes()} is already the ordered,
 * reviewable change list; this class only formats it (plus the classification
 * rationale and the validator's warnings — what the design does <i>not</i>
 * pin) into markdown a reviewer approves at design altitude.
 */
@Service
public class DeltaRenderer {

    public String renderMarkdown(DesignDelta d, BindingClassification c, List<String> warnings) {
        StringBuilder md = new StringBuilder();
        md.append("## Design delta — ").append(d.disposition()).append("\n\n");

        if (!DesignDelta.GENERATE.equals(d.disposition())) {
            // park / ask: the reason (or the one sharp question) IS the content.
            if (c.needsQuestion() && c.question() != null) {
                md.append("**Question:** ").append(c.question()).append('\n');
            } else if (d.reason() != null) {
                md.append(d.reason()).append('\n');
            }
            return md.toString();
        }

        md.append("- **Discriminator:** `").append(c.discriminator()).append("` — ")
                .append(c.bindingTime()).append(" (source: ").append(c.discriminatorSource()).append(")\n");
        md.append("- **Why:** ").append(c.rationale()).append('\n');
        md.append("- **Strategy interface:** `").append(d.strategyInterface())
                .append("` — resolver `").append(d.resolver()).append("`\n");
        md.append("- **Orchestrator apply mode:** ").append(d.sutMode());
        if (DesignDelta.SUT_REGEN.equals(d.sutMode())) {
            md.append(" — body capture complete; overwritten wholesale from the design");
        } else {
            md.append(" — add-only UPDATE; the resolver call is wired in by hand");
        }
        md.append('\n');

        md.append("\n### Changes\n");
        md.append("| op | element | name | detail |\n");
        md.append("| --- | --- | --- | --- |\n");
        for (Change ch : d.changes()) {
            md.append("| ").append(ch.op()).append(" | ").append(ch.element())
                    .append(" | `").append(ch.name()).append("` | ")
                    .append(ch.detail().replace("|", "\\|")).append(" |\n");
        }

        md.append("\n### Resolver mapping — `").append(c.discriminator()).append("` → strategy\n");
        md.append("| key | strategy |\n");
        md.append("| --- | --- |\n");
        for (MappingRow row : d.mapping()) {
            md.append("| ").append(row.key()).append(" | `").append(row.strategy()).append("` |\n");
        }

        md.append("\n### What this design does not pin\n");
        if (warnings.isEmpty()) {
            md.append("_No warnings — the delta is minimal and fully derivable._\n");
        } else {
            for (String w : warnings) {
                md.append("- ").append(w).append('\n');
            }
        }
        return md.toString();
    }
}
