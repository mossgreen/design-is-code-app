package com.designiscode.app.dto;

import java.util.List;

/**
 * Structured snapshot of a Java/Spring project's public surface — the
 * grounding the AI analyser uses to propose abstractions that fit the
 * user's existing code instead of inventing parallel names.
 *
 * <p>Three layers of granularity, each useful for a different consumer:
 * <ul>
 *   <li>{@code glossary} + {@code packages} + {@code conventions} —
 *       ultra-compact "what is this codebase about" snapshot
 *       (~few hundred tokens). Always sent to the analyser.</li>
 *   <li>{@code types} — full per-type detail. Filtered to a top-K
 *       lexically relevant slice before reaching the analyser
 *       (token-budget guard for large codebases).</li>
 *   <li>{@code fileCount} / {@code skippedCount} — scan diagnostics
 *       shown in the Step 1 status line.</li>
 * </ul>
 *
 * <p>{@code pkg} is named that rather than {@code package} because
 * {@code package} is a reserved word in Java. Serialised as {@code pkg}
 * in JSON; the analyser-prompt formatter re-labels it as
 * "package" in the rendered markdown.
 */
public record ScanCatalog(
        String path,
        int fileCount,
        int skippedCount,
        List<PackageRecord> packages,
        List<TypeRecord> types,
        List<GlossaryEntry> glossary,
        Conventions conventions
) {
    public record PackageRecord(String name, int typeCount) {}

    public record TypeRecord(
            String fqn,
            String name,
            String pkg,
            String kind,          // class | interface | record | enum
            String role,          // entity | repository | service | dto | value-object | controller | config | domain-primitive | exception | mapper | other
            List<String> annotations,
            String extendsType,   // FQN or simple name, null if none
            List<String> implementsTypes,
            String purpose,       // first Javadoc sentence; empty if absent
            List<MethodRecord> publicMethods,
            List<FieldRecord> fields
    ) {}

    public record MethodRecord(
            String name,
            String signature,     // "name(p1: T1, p2: T2) -> Ret" — rendered form for the analyser prompt
            List<FieldRecord> params,
            String returnType,
            String purpose        // first Javadoc sentence; empty if absent
    ) {}

    public record FieldRecord(String name, String type) {}

    public record GlossaryEntry(String term, String kind, String fqn) {}

    public record Conventions(
            String interfaceImplPattern,    // "*Impl" / "Default*" / null
            String recordUsage,             // "common" | "rare"
            List<String> primaryStereotypes // [@Service, @Repository, ...]
    ) {}
}
