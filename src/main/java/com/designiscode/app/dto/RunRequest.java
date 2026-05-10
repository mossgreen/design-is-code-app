package com.designiscode.app.dto;

public record RunRequest(
        String projectPath,
        String filePath,
        String model
) {}
