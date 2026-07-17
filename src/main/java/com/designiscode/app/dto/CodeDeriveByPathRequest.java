package com.designiscode.app.dto;

/**
 * Request for {@code POST /api/code-derive-by-path}: derive the what-IS slice
 * of one entry method by reading the project's sources server-side (every
 * {@code *.java} under {@code <projectPath>/src/main/java}) — the wizard's
 * Step-3 "before" view, where the client has a path but not file contents.
 */
public record CodeDeriveByPathRequest(
        String projectPath,
        String entryClass,
        String entryMethod
) {}
