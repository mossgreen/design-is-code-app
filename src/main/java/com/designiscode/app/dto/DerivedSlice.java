package com.designiscode.app.dto;

import java.util.List;

/**
 * Stage A output of the code→design diff pipeline: a <i>scoped, structural</i>
 * view of one system-under-test entry method, derived from the user-provided
 * source files (NOT a whole-repo reverse-engineering).
 *
 * <p>Where {@link ScanCatalog} captures the public <i>surface</i> (signatures,
 * annotations, extends/implements), this captures what the surface omits and
 * the diff needs: the entry method's <b>call sites</b> (the candidate variation
 * points), how the SUT <b>receives its collaborators</b> (wiring), and the
 * <b>config-loading anchor</b> (conditional beans / profiles / {@code @Value}).
 *
 * <p>It feeds Stage B's binding-time classification, which decides a
 * discriminator's binding by tracing its provenance to one of two anchors:
 * the <b>external-input</b> anchor ({@link #entryMethod}'s params → a request
 * parameter) or the <b>config-loading</b> anchor ({@link #configFacts} → a
 * bean). Stage A only extracts the evidence; it makes no binding decision.
 */
public record DerivedSlice(
        String sut,                       // entry class simple name
        MethodSig entryMethod,            // external-input anchor: params are request-discriminator candidates
        boolean orchestrator,             // SUT has >=1 outgoing call to a behavioral collaborator
        List<CallSite> callSites,         // resolved outgoing calls in the entry method body
        List<Dependency> dependencies,    // how the SUT receives collaborators (constructor / field)
        List<ConfigFact> configFacts,     // config-loading anchor across the provided sources
        String targetPackage,             // the SUT's package — where Stage E writes new code / the .puml @package
        List<TypeRef> knownTypes,         // every provided type, with its FQN + kind (for REUSE stereotypes)
        List<String> captureGaps          // every reason this slice may be incomplete (see captureComplete)
) {
    /**
     * True when the derived call sites describe the entry method's <b>complete</b>
     * flow — no control flow, object creation, self/chained/static calls, or
     * unprovided callee types. This is the REGEN precondition: an orchestrator may
     * be regenerated wholesale only from a design that shows its whole body,
     * because an omitted call is dropped from the regenerated implementation.
     *
     * <p>{@link #captureGaps} holds two families, and both must block REGEN
     * equally: constructs in the entry body a linear flow cannot represent, and
     * facts that make the <i>derivable world smaller than the real one</i> — a
     * source that would not parse, a file that could not be read, two provided
     * types sharing a simple name. The second family is the dangerous one,
     * because a slice missing it looks exactly as confident as a complete slice.
     */
    public boolean captureComplete() {
        return captureGaps.isEmpty();
    }

    /** A method signature. The entry method's params are the external-input surface. */
    public record MethodSig(String name, List<Param> params, String returns) {}

    /** A provided type: its simple name, fully-qualified name, and kind. */
    public record TypeRef(String name, String fqn, String kind) {}

    public record Param(String name, String type) {}

    /**
     * One resolved method invocation in the entry method body — a candidate
     * variation point. {@code calleeType} is the declared type of the receiver
     * resolved lexically against the provided sources (null when unresolvable,
     * e.g. a chained or static call).
     */
    public record CallSite(
            String receiver,            // the variable/field the call is on, e.g. "taxCalculator"
            String calleeType,          // declared type of the receiver, e.g. "TaxCalculator"; null if unresolved
            String calleeKind,          // "interface" | "class" | "record" | "enum" | "unknown"
            List<String> calleeImpls,   // provided classes implementing calleeType (existing variants, e.g. ["DomesticTax"])
            String method,              // invoked method name
            List<String> args,          // argument expressions as source text (for later data-flow/provenance)
            MethodSig calleeMethodSig,  // resolved signature of `method` on calleeType (for Stage E emit), or null
            String resultName           // local the result is assigned to (→ return arrow name), or null
    ) {}

    /** How the SUT receives a collaborator. */
    public record Dependency(
            String name,                // field/param name, e.g. "taxCalculator"
            String type,                // declared type, e.g. "TaxCalculator"
            String injection,           // "constructor" | "field"
            String qualifier            // @Qualifier value if present, else null
    ) {}

    /**
     * A config-loading provenance signal across the provided sources — the
     * evidence that a selection is bound at startup rather than per request.
     */
    public record ConfigFact(
            String type,                // the type this fact concerns, e.g. "DomesticTax"
            String kind,                // "conditional-on-property" | "profile" | "value-field" | "bean-method"
            String detail               // rendered annotation args / field name, e.g. "name=tax.mode, havingValue=domestic"
    ) {}
}
