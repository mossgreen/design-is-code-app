package com.designiscode.app.dto;

/**
 * Snapshot of a {@link com.designiscode.app.service.CodeGenerator}'s runtime
 * state. Exposed to the frontend at {@code GET /api/generator/status}.
 *
 * <p>The {@code state} drives the wizard's install/update banner; the
 * {@code installCommand} is the literal shell command the user can copy to
 * provision the generator, surfaced ONLY when the generator is not READY.
 * Specifically not Claude-specific — alternate generators (no-install
 * built-ins, API-key-only setups, other agentic tools) populate the
 * fields they have and leave the rest null.
 */
public record GenerationStatus(
        State state,
        String version,
        String installPath,
        String latestVersion,
        String installCommand
) {
    public enum State { READY, NOT_INSTALLED, OUTDATED }

    public static GenerationStatus notInstalled(String installCommand) {
        return new GenerationStatus(State.NOT_INSTALLED, null, null, null, installCommand);
    }
}
