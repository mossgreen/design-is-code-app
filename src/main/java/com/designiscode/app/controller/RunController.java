package com.designiscode.app.controller;

import com.designiscode.app.dto.CancelRequest;
import com.designiscode.app.dto.RunRequest;
import com.designiscode.app.dto.TreeLoadRequest;
import com.designiscode.app.dto.TreeSaveRequest;
import com.designiscode.app.service.RunService;
import com.designiscode.app.service.TreeService;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;

import java.util.Map;

@RestController
@RequestMapping("/api")
public class RunController {

    private final RunService runService;
    private final TreeService treeService;

    public RunController(RunService runService, TreeService treeService) {
        this.runService = runService;
        this.treeService = treeService;
    }

    @PostMapping(value = "/run-disc", produces = MediaType.TEXT_PLAIN_VALUE)
    public ResponseBodyEmitter runDisc(@RequestBody RunRequest request) {
        ResponseBodyEmitter emitter = new ResponseBodyEmitter(15L * 60L * 1000L);
        runService.run(request, emitter);
        return emitter;
    }

    @PostMapping(value = "/run-disc/cancel", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> cancelDisc(@RequestBody CancelRequest request) {
        boolean cancelled = runService.cancel(request == null ? null : request.runId());
        return ResponseEntity.ok(Map.of("cancelled", cancelled));
    }

    /**
     * Plan mode (dry-run). Spawns the DisC plugin with the `--plan` flag,
     * which executes Steps 1-6 internally and emits a single JSON envelope
     * of file actions to stdout WITHOUT writing any files. The response is
     * passed through to the client unchanged. See {@code SKILL.md}'s
     * "Plan mode" section for the envelope shape.
     */
    @PostMapping(value = "/plan-disc", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> planDisc(@RequestBody RunRequest request) {
        try {
            return ResponseEntity.ok(runService.plan(request));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError()
                    .body(Map.of("error", "Plan failed: " + e.getMessage()));
        }
    }

    /**
     * Walks a multi-level design tree bottom-up, spawning the DisC plugin
     * once per .puml. Streams the same NDJSON contract as {@link #runDisc},
     * with two additional envelopes: {@code node-start}/{@code node-done}
     * frame each plugin invocation, and {@code build-all-start}/
     * {@code build-all-done} bracket the entire walk. Pre-flight failures
     * (cycle, drift) terminate before any process is spawned.
     */
    @PostMapping(value = "/build-all", produces = MediaType.TEXT_PLAIN_VALUE)
    public ResponseBodyEmitter buildAll(@RequestBody RunRequest request) {
        ResponseBodyEmitter emitter = new ResponseBodyEmitter(60L * 60L * 1000L);
        treeService.buildAll(request, emitter);
        return emitter;
    }

    /** Loads every {@code _index.json} reachable from a root folder. Used
     *  by Studio to reconstruct the tree view on cold open. Returns a map
     *  keyed by manifest folder relative to the project root. */
    @PostMapping(value = "/tree/load", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> loadTree(@RequestBody TreeLoadRequest request) {
        try {
            if (request == null || request.projectPath() == null || request.projectPath().isBlank()) {
                return ResponseEntity.badRequest().body(Map.of("error", "projectPath is required"));
            }
            String rootFolder = request.rootFolder() == null ? "" : request.rootFolder();
            return ResponseEntity.ok(Map.of(
                    "rootFolder", rootFolder,
                    "manifests", treeService.loadTree(request.projectPath(), rootFolder)
            ));
        } catch (Exception e) {
            return ResponseEntity.internalServerError()
                    .body(Map.of("error", "Failed to load tree: " + e.getMessage()));
        }
    }

    /** Writes one {@code _index.json}. Studio calls this after Step 4 export
     *  (root manifest) and after each "Design this level" completes (child
     *  manifest, plus a follow-up call to update the parent's children list). */
    @PostMapping(value = "/tree/save", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> saveManifest(@RequestBody TreeSaveRequest request) {
        try {
            if (request == null || request.projectPath() == null || request.projectPath().isBlank()) {
                return ResponseEntity.badRequest().body(Map.of("error", "projectPath is required"));
            }
            if (request.manifest() == null) {
                return ResponseEntity.badRequest().body(Map.of("error", "manifest is required"));
            }
            String folder = request.manifestFolder() == null ? "" : request.manifestFolder();
            treeService.saveManifest(request.projectPath(), folder, request.manifest());
            return ResponseEntity.ok(Map.of("manifestFolder", folder));
        } catch (Exception e) {
            return ResponseEntity.internalServerError()
                    .body(Map.of("error", "Failed to save manifest: " + e.getMessage()));
        }
    }

    /** Computes the parent contract hash for a given child name in a parent .puml.
     *  Exposed so Studio's "Design this level" can record the hash on the new
     *  child manifest without re-implementing the hash algorithm in JS. */
    @PostMapping(value = "/tree/contract-hash", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> contractHash(@RequestBody Map<String, String> request) {
        try {
            String projectPath = request.get("projectPath");
            String parentPuml = request.get("parentPuml");
            String childName = request.get("childName");
            if (projectPath == null || parentPuml == null || childName == null) {
                return ResponseEntity.badRequest().body(Map.of(
                        "error", "projectPath, parentPuml, childName all required"));
            }
            java.nio.file.Path absParent = java.nio.file.Paths.get(projectPath)
                    .toAbsolutePath().normalize()
                    .resolve(parentPuml).normalize();
            String hash = treeService.hashContract(absParent, childName);
            return ResponseEntity.ok(Map.of("contractHash", hash));
        } catch (Exception e) {
            return ResponseEntity.internalServerError()
                    .body(Map.of("error", "Failed to compute hash: " + e.getMessage()));
        }
    }

}
