package com.designiscode.app.dto;

import java.util.List;

/**
 * Request payload for writing a .puml + (optionally) its decision tables.
 * Writes to {@code <project>/design/<fileName>.puml}.
 */
public record DesignRequest(
        String projectPath,
        String fileName,
        String content,
        List<DecisionTableFile> decisionTables
) {}
