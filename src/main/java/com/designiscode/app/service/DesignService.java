package com.designiscode.app.service;

import com.designiscode.app.dto.DecisionTableFile;
import com.designiscode.app.dto.DesignRequest;
import com.designiscode.app.dto.DesignResult;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;

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

        String fileName = sanitizePumlFileName(request.fileName());
        Path containerDir = projectRoot.resolve(DESIGN_DIR);
        Path target = containerDir.resolve(fileName).normalize();
        if (!target.startsWith(containerDir)) {
            throw new IllegalArgumentException("Invalid file name");
        }
        String relPathForResult = projectRoot.relativize(target).toString();

        try {
            Files.createDirectories(containerDir);
            Files.writeString(target, request.content());
            // Belt-and-braces: any _index.json next to a freshly-written .puml
            // is a leftover from the parked multi-level mechanism. Delete it
            // so the DisC plugin doesn't read stale deferred-child entries.
            // See TODO.md "Multi-level design (parked for MVP — restore post-PMF)".
            Files.deleteIfExists(containerDir.resolve("_index.json"));
        } catch (IOException e) {
            throw new RuntimeException("Failed to write design file: " + e.getMessage(), e);
        }

        int sidecarCount = writeDecisionTables(containerDir, request.decisionTables());

        return new DesignResult(target.toString(), relPathForResult, fileName, sidecarCount);
    }

    private int writeDecisionTables(Path designDir, List<DecisionTableFile> tables) {
        if (tables == null || tables.isEmpty()) {
            return 0;
        }
        int count = 0;
        for (DecisionTableFile dt : tables) {
            if (dt == null) continue;
            if (dt.content() == null || dt.content().isBlank()) {
                throw new IllegalArgumentException("Decision-table content is empty");
            }
            String name = sanitizeDecisionFileName(dt.fileName());
            Path target = designDir.resolve(name).normalize();
            if (!target.startsWith(designDir)) {
                throw new IllegalArgumentException("Invalid decision-table file name");
            }
            try {
                Files.writeString(target, dt.content());
            } catch (IOException e) {
                throw new RuntimeException("Failed to write decision table " + name + ": " + e.getMessage(), e);
            }
            count++;
        }
        return count;
    }

    private String sanitizePumlFileName(String raw) {
        String name = (raw == null) ? "" : raw.trim();
        if (name.isEmpty()) {
            name = "design.puml";
        }
        rejectPathTraversal(name);
        if (!name.matches("[A-Za-z0-9._-]+")) {
            throw new IllegalArgumentException("File name may only contain letters, digits, '.', '_' and '-'");
        }
        if (!name.toLowerCase().endsWith(".puml")) {
            name = name + ".puml";
        }
        return name;
    }

    private String sanitizeDecisionFileName(String raw) {
        String name = (raw == null) ? "" : raw.trim();
        if (name.isEmpty()) {
            throw new IllegalArgumentException("Decision-table file name is required");
        }
        rejectPathTraversal(name);
        if (!name.matches("[A-Za-z0-9._-]+")) {
            throw new IllegalArgumentException("Decision-table file name may only contain letters, digits, '.', '_' and '-'");
        }
        if (!name.toLowerCase().endsWith(".decision.md")) {
            throw new IllegalArgumentException("Decision-table file name must end with .decision.md");
        }
        return name;
    }

    private void rejectPathTraversal(String name) {
        if (name.contains("/") || name.contains("\\") || name.contains("..")) {
            throw new IllegalArgumentException("File name must not contain path separators");
        }
    }
}
