package com.designiscode.app.dto;

import java.util.List;

public record DesignRequest(
        String projectPath,
        String fileName,
        String content,
        List<DecisionTableFile> decisionTables
) {}
