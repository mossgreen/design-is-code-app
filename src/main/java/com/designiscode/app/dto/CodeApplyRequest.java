package com.designiscode.app.dto;

/**
 * Request body to apply previously-previewed artifacts: the project to write
 * into, plus the {@link ApplyArtifacts} returned by the diff endpoint (echoed
 * back after the user signs off the design diff).
 */
public record CodeApplyRequest(
        String projectPath,
        ApplyArtifacts artifacts
) {}
