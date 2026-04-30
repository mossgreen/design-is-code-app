package com.designiscode.app.dto;

public record DesignRequest(
        String projectPath,
        String fileName,
        String content
) {}
