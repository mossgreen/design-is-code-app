package com.designiscode.app.dto;

/**
 * Request payload for {@code POST /api/generator/validate} — Step-2 preflight
 * that asks the plugin if the in-progress design would be refused.
 *
 * <p>Unlike {@link GenerationOptions}, the design has not been saved to the
 * project yet — the frontend ships the rendered {@code .puml} text inline.
 * The service writes it to a temp file inside {@code projectPath} so the
 * plugin sees real project context (for FQN resolution) while validating.
 *
 * <p>{@code sidecars} (file name -> {@code .decision.md} content) are written
 * beside it. Step 1 pairs a table to its leaf by filename, so omitting them made
 * validate judge the design as if every leaf were unspecified — a sidecar could
 * contradict the diagram and still pass.
 */
public record ValidateRequest(
        String projectPath,
        String puml,
        java.util.Map<String, String> sidecars,
        String model
) {}
