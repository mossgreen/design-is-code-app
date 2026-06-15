package com.designiscode.app.service;

import java.util.List;
import java.util.Set;

/**
 * Shared model allowlist for every {@code claude} subprocess the studio
 * spawns ({@link AnalyzeService}, {@link SequenceService}, {@link RunService}).
 *
 * <p>One source of truth so adding a model to the wizard is a single-line
 * change here, not a hunt across three services.
 */
public final class Models {

    /** Model IDs the wizard is allowed to request. Anything else gets dropped
     *  and the CLI's configured default takes over — we never pass an
     *  unvalidated string to the subprocess. */
    public static final Set<String> ALLOWED = Set.of(
            "claude-sonnet-4-6",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-haiku-4-5"
    );

    private Models() {}

    /**
     * Append {@code --model <requested>} to {@code args} iff {@code requested}
     * is non-blank and on the allowlist. Otherwise leave {@code args} alone
     * (CLI default will be used).
     *
     * @return the model actually applied, or {@code null} when nothing was
     *         appended. Useful for log lines that want to record the resolved
     *         model without re-implementing the validation.
     */
    public static String appendIfValid(List<String> args, String requested) {
        if (requested == null) return null;
        String trimmed = requested.trim();
        if (trimmed.isEmpty() || !ALLOWED.contains(trimmed)) return null;
        args.add("--model");
        args.add(trimmed);
        return trimmed;
    }
}
