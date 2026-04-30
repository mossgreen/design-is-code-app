package com.designiscode.app.service;

import com.designiscode.app.dto.DesignRequest;
import com.designiscode.app.dto.DesignResult;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

@Service
public class DesignService {

    private static final String DESIGN_DIR = "design";

    public DesignResult save(DesignRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("Request is required");
        }
        if (request.projectPath() == null || request.projectPath().isBlank()) {
            throw new IllegalArgumentException("Connect a project first — project path is required");
        }
        if (request.content() == null || request.content().isBlank()) {
            throw new IllegalArgumentException("Design content is empty");
        }

        Path projectRoot = Paths.get(request.projectPath()).toAbsolutePath().normalize();
        if (!Files.exists(projectRoot) || !Files.isDirectory(projectRoot)) {
            throw new IllegalArgumentException("Project path is not a directory: " + projectRoot);
        }

        String fileName = sanitizeFileName(request.fileName());
        Path designDir = projectRoot.resolve(DESIGN_DIR);
        Path target = designDir.resolve(fileName).normalize();

        if (!target.startsWith(designDir)) {
            throw new IllegalArgumentException("Invalid file name");
        }

        try {
            Files.createDirectories(designDir);
            Files.writeString(target, request.content());
        } catch (IOException e) {
            throw new RuntimeException("Failed to write design file: " + e.getMessage(), e);
        }

        String relativePath = projectRoot.relativize(target).toString();
        return new DesignResult(target.toString(), relativePath, fileName);
    }

    private String sanitizeFileName(String raw) {
        String name = (raw == null) ? "" : raw.trim();
        if (name.isEmpty()) {
            name = "design.puml";
        }
        if (name.contains("/") || name.contains("\\") || name.contains("..")) {
            throw new IllegalArgumentException("File name must not contain path separators");
        }
        if (!name.matches("[A-Za-z0-9._-]+")) {
            throw new IllegalArgumentException("File name may only contain letters, digits, '.', '_' and '-'");
        }
        if (!name.toLowerCase().endsWith(".puml")) {
            name = name + ".puml";
        }
        return name;
    }
}
