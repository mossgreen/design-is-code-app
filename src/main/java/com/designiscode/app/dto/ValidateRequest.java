package com.designiscode.app.dto;

/**
 * Request payload for {@code POST /api/generator/validate} — Step-2 preflight
 * that asks the plugin if the in-progress design would be refused.
 *
 * <p>Unlike {@link GenerationOptions}, the design has not been saved to the
 * project yet — the frontend ships the rendered {@code .puml} text inline.
 * The service writes it to a temp file inside {@code projectPath} so the
 * plugin sees real project context (for FQN resolution) while validating.
 */
public record ValidateRequest(
        String projectPath,
        String puml,
        String model
) {}
