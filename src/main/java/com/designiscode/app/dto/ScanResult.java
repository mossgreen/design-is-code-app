package com.designiscode.app.dto;

import java.util.List;

public record ScanResult(
        String path,
        int fileCount,
        int skippedCount,
        List<JavaType> classes,
        List<JavaType> interfaces,
        List<JavaType> dataTypes,
        List<String> methods
) {}
