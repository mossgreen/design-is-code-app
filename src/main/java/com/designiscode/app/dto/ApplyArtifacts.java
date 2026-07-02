package com.designiscode.app.dto;

import java.util.List;

/**
 * Stage E output: the DisC grammar artifacts a {@link DesignDelta} compiles to —
 * a complete {@code .puml} plus its resolver decision-table sidecar(s). These are
 * exactly what the DisC plugin consumes; writing them (via {@code DesignService})
 * and running the plugin is the final apply.
 */
public record ApplyArtifacts(
        String pumlFileName,
        String puml,
        List<DecisionTableFile> sidecars
) {}
