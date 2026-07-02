package com.designiscode.app.service;

import com.designiscode.app.dto.BindingClassification;
import com.designiscode.app.dto.DerivedSlice;
import com.designiscode.app.dto.DerivedSlice.CallSite;
import org.springframework.stereotype.Service;

import java.util.HashSet;
import java.util.Optional;
import java.util.Set;

/**
 * Stage B of the code→design diff pipeline: classify a variance discriminator's
 * <b>binding time</b> by tracing its provenance through a {@link DerivedSlice}.
 *
 * <p>The AC names the discriminator; the <b>code decides its binding</b>. The
 * discriminator is given as the code token/path the AC's selector maps to
 * (e.g. {@code order.destination} for a request field, or {@code tax.mode} for a
 * config property). Classification roots it in one of the two Stage-A anchors:
 *
 * <ul>
 *   <li><b>external-input</b> ({@link DerivedSlice#entryMethod}'s params) →
 *       {@code request} → {@code request-dynamic}</li>
 *   <li><b>config-loading</b> ({@link DerivedSlice#configFacts}) →
 *       {@code environment} → {@code deploy-static} (or {@code runtime-global}
 *       when an ops-flag signal is present)</li>
 * </ul>
 *
 * <p>Optional AC text only <i>corroborates</i> and resolves the cases code alone
 * cannot: the A/B-test trap (sounds config-y, is per-request), flag vs static
 * config, and code-vs-AC conflict. The classifier asks exactly one sharp
 * question only when the trace is ambiguous, inconclusive, or conflicts.
 */
@Service
public class BindingTimeClassifier {

    public static final String SRC_REQUEST = "request";
    public static final String SRC_ENVIRONMENT = "environment";
    public static final String SRC_FLAG = "flag";
    public static final String SRC_UNRESOLVED = "unresolved";

    public static final String BT_REQUEST_DYNAMIC = "request-dynamic";
    public static final String BT_DEPLOY_STATIC = "deploy-static";
    public static final String BT_RUNTIME_GLOBAL = "runtime-global";
    public static final String BT_UNKNOWN = "unknown";

    public BindingClassification classify(DerivedSlice slice, String discriminator) {
        return classify(slice, discriminator, null);
    }

    /**
     * @param slice         Stage A derivation of the SUT entry method
     * @param discriminator the code token/path the AC's selector maps to
     * @param acText        the acceptance criteria text (nullable) — corroboration only
     */
    public BindingClassification classify(DerivedSlice slice, String discriminator, String acText) {
        String d = discriminator == null ? "" : discriminator.trim();
        String root = rootOf(d);

        boolean fromRequest = matchesRequestInput(slice, d, root);
        boolean fromConfig = matchesConfigProperty(slice, d, root);

        String ac = acText == null ? "" : acText.toLowerCase();
        boolean trap = containsAny(ac, "a/b", "a-b", "ab test", "a/b test", "experiment", "cohort", "split test");
        boolean flagSignal = containsAny(ac, "kill switch", "kill-switch", "circuit breaker",
                "feature flag", "feature toggle", "toggle", "disable when", "under load");
        boolean deploySignal = containsAny(ac, "deployment", "on-prem", "on prem", "rollout",
                "profile", "environment variable", "per region deployment");

        // The trap: experiment/A-B/cohort sounds config-shaped but routes per user.
        if (trap) {
            return verdict(d, SRC_REQUEST, BT_REQUEST_DYNAMIC,
                    "AC names an experiment / A-B / cohort → per-user routing (request-dynamic), "
                            + "overriding any config-shaped wording");
        }

        if (fromRequest && fromConfig) {
            return ask(d, "`" + d + "` resolves to BOTH a request parameter and a config property "
                    + "in the provided files");
        }

        if (fromRequest) {
            // Code says request, but AC clearly describes deployment selection: the real config
            // origin may live outside the provided files. Don't trust the partial view — ask.
            if (deploySignal) {
                return ask(d, "the code roots `" + d + "` in the request input, but the AC describes "
                        + "per-deployment selection — the config origin may be outside the provided files");
            }
            return verdict(d, SRC_REQUEST, BT_REQUEST_DYNAMIC,
                    "`" + d + "` roots in the entry method's input (" + root + ") → per-request");
        }

        if (fromConfig) {
            if (flagSignal) {
                return verdict(d, SRC_FLAG, BT_RUNTIME_GLOBAL,
                        "`" + d + "` roots in config AND the AC names a runtime toggle → "
                                + "ops flag (dynamic, same for all requests)");
            }
            return verdict(d, SRC_ENVIRONMENT, BT_DEPLOY_STATIC,
                    "`" + d + "` roots in a config property fixed at startup → per-deployment");
        }

        // Neither anchor matched.
        if (flagSignal) {
            return ask(d, "the AC names a runtime toggle, but `" + d + "` is not wired to a flag "
                    + "source in the provided files");
        }
        return ask(d, "`" + d + "` does not resolve to a request parameter or a config property "
                + "in the provided files (not wired, or named as a concept rather than a code token)");
    }

    /** Locate the variation point: the call site whose callee type is being varied. */
    public static Optional<CallSite> locate(DerivedSlice slice, String calleeType) {
        return slice.callSites().stream()
                .filter(cs -> calleeType.equals(cs.calleeType()))
                .findFirst();
    }

    // --- provenance matching ---

    private boolean matchesRequestInput(DerivedSlice slice, String d, String root) {
        return slice.entryMethod().params().stream()
                .anyMatch(p -> p.name().equals(d) || p.name().equals(root));
    }

    private boolean matchesConfigProperty(DerivedSlice slice, String d, String root) {
        for (DerivedSlice.ConfigFact f : slice.configFacts()) {
            Set<String> tokens = tokensWithParts(f.detail());
            if (tokens.contains(d) || tokens.contains(root)) return true;
        }
        return false;
    }

    // --- helpers ---

    private BindingClassification verdict(String d, String source, String bindingTime, String rationale) {
        return new BindingClassification(d, source, bindingTime, false, null, rationale);
    }

    private BindingClassification ask(String d, String reason) {
        String q = "Does the variant selection for `" + d + "` vary per request (input data), "
                + "per deployment (fixed at startup), or via a runtime toggle? Code trace: " + reason + ".";
        return new BindingClassification(d, SRC_UNRESOLVED, BT_UNKNOWN, true, q, reason);
    }

    private static String rootOf(String d) {
        int dot = d.indexOf('.');
        return dot > 0 ? d.substring(0, dot) : d;
    }

    /** Identifier/dotted tokens in a string, plus the dot-split parts of each. */
    private static Set<String> tokensWithParts(String s) {
        Set<String> out = new HashSet<>();
        if (s == null) return out;
        for (String t : s.split("[^A-Za-z0-9_.]+")) {
            if (t.isBlank()) continue;
            out.add(t);
            if (t.contains(".")) {
                for (String part : t.split("\\.")) {
                    if (!part.isBlank()) out.add(part);
                }
            }
        }
        return out;
    }

    private static boolean containsAny(String haystack, String... needles) {
        for (String n : needles) {
            if (haystack.contains(n)) return true;
        }
        return false;
    }
}
