package com.designiscode.app.service;

import com.designiscode.app.dto.RunRequest;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@Service
public class RunService {

    private static final String DISC_SLASH_COMMAND = "/design-is-code:disc";

    private final ExecutorService executor = Executors.newCachedThreadPool();

    public void run(RunRequest request, ResponseBodyEmitter emitter) {
        if (request == null || request.projectPath() == null || request.projectPath().isBlank()) {
            completeWith(emitter, "ERROR: projectPath is required\n");
            return;
        }
        if (request.filePath() == null || request.filePath().isBlank()) {
            completeWith(emitter, "ERROR: filePath is required\n");
            return;
        }

        Path projectRoot = Paths.get(request.projectPath()).toAbsolutePath().normalize();
        if (!Files.isDirectory(projectRoot)) {
            completeWith(emitter, "ERROR: project path is not a directory: " + projectRoot + "\n");
            return;
        }

        String relPath = request.filePath().trim();
        Path resolved = projectRoot.resolve(relPath).normalize();
        if (!resolved.startsWith(projectRoot) || !Files.exists(resolved)) {
            completeWith(emitter, "ERROR: puml file not found at " + resolved + "\n");
            return;
        }

        String slashCommand = DISC_SLASH_COMMAND + " " + relPath;
        List<String> cmd = List.of(
                "claude",
                "--dangerously-skip-permissions",
                "-p", slashCommand
        );

        executor.submit(() -> runProcess(cmd, projectRoot.toFile(), emitter));
    }

    private void runProcess(List<String> cmd, File workingDir, ResponseBodyEmitter emitter) {
        try {
            emit(emitter, "$ cd " + workingDir.getAbsolutePath() + "\n");
            emit(emitter, "$ " + String.join(" ", cmd) + "\n\n");

            ProcessBuilder pb = new ProcessBuilder(cmd)
                    .directory(workingDir)
                    .redirectErrorStream(true)
                    .redirectInput(new File("/dev/null"));
            Process process = pb.start();

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    emit(emitter, line + "\n");
                }
            }

            int exit = process.waitFor();
            emit(emitter, "\n[exit " + exit + "]\n");
            emitter.complete();
        } catch (IOException e) {
            String hint = e.getMessage() != null && e.getMessage().contains("No such file")
                    ? " — is the `claude` CLI installed and on PATH?"
                    : "";
            completeWith(emitter, "ERROR: " + e.getMessage() + hint + "\n");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            completeWith(emitter, "ERROR: interrupted\n");
        } catch (Exception e) {
            completeWith(emitter, "ERROR: " + e.getMessage() + "\n");
        }
    }

    private void emit(ResponseBodyEmitter emitter, String chunk) {
        try {
            emitter.send(chunk);
        } catch (IOException ignored) {
        }
    }

    private void completeWith(ResponseBodyEmitter emitter, String message) {
        emit(emitter, message);
        emitter.complete();
    }
}
