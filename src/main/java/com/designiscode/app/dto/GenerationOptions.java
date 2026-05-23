package com.designiscode.app.dto;

/**
 * Request payload for {@code POST /api/generator/run} (and {@code /plan}).
 *
 * <p>Loosely typed knobs for now — {@code model} is interpreted by the
 * concrete {@link com.designiscode.app.service.CodeGenerator}. Future
 * generators with structurally-different options can either reuse this
 * record (ignoring fields they don't need) or extend the schema. Keep
 * additions optional to preserve API compatibility.
 */
public record GenerationOptions(
        String projectPath,
        String filePath,
        String model
) {}
