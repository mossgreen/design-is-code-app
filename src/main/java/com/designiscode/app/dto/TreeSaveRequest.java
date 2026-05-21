package com.designiscode.app.dto;

public record TreeSaveRequest(
        String projectPath,
        String manifestFolder,
        Manifest manifest
) {}
