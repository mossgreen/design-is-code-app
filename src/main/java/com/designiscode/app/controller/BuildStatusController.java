package com.designiscode.app.controller;

import com.designiscode.app.dto.BuildStatusRequest;
import com.designiscode.app.service.BuildStatusService;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Read-only filesystem observation: for a list of participant names,
 * return whether each one has been built as a real implementation, only
 * as a Pending stub, or not generated at all.
 *
 * <p>Lives in its own controller (rather than bolting onto
 * {@code RunController}) because it is conceptually separate: not
 * running, not designing, not mutating tree state — just inspecting
 * what already exists on disk.
 */
@RestController
@RequestMapping("/api")
public class BuildStatusController {

    private final BuildStatusService buildStatusService;

    public BuildStatusController(BuildStatusService buildStatusService) {
        this.buildStatusService = buildStatusService;
    }

    @PostMapping(value = "/build-status", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> status(@RequestBody BuildStatusRequest request) {
        try {
            if (request == null || request.projectPath() == null || request.projectPath().isBlank()) {
                return ResponseEntity.badRequest().body(Map.of("error", "projectPath is required"));
            }
            return ResponseEntity.ok(Map.of(
                    "statusByName", buildStatusService.status(request.projectPath(), request.participantNames())
            ));
        } catch (Exception e) {
            return ResponseEntity.internalServerError()
                    .body(Map.of("error", "Failed to compute build status: " + e.getMessage()));
        }
    }
}
