package com.designiscode.app.controller;

import com.designiscode.app.dto.CodeApplyRequest;
import com.designiscode.app.dto.CodeDiffRequest;
import com.designiscode.app.service.CodeDesignDiffService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * The code→design diff endpoint. {@code POST /api/code-diff} previews the design
 * diff for a ticket (Stages A–E, no writes — drives the Stage-D review);
 * {@code POST /api/code-diff/apply} writes the signed-off artifacts to disk.
 */
@RestController
@RequestMapping("/api")
public class CodeDesignDiffController {

    private final CodeDesignDiffService pipeline;

    public CodeDesignDiffController(CodeDesignDiffService pipeline) {
        this.pipeline = pipeline;
    }

    /** Stage A + rendering only — the what-IS view for an additive ticket (no variance delta). */
    @PostMapping("/code-derive")
    public ResponseEntity<?> derive(@RequestBody CodeDiffRequest r) {
        try {
            return ResponseEntity.ok(pipeline.derive(r.sources(), r.entryClass(), r.entryMethod()));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", "derive failed: " + e.getMessage()));
        }
    }

    @PostMapping("/code-diff")
    public ResponseEntity<?> diff(@RequestBody CodeDiffRequest r) {
        try {
            return ResponseEntity.ok(pipeline.run(
                    r.sources(), r.entryClass(), r.entryMethod(), r.discriminator(), r.acText(), r.request()));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", "diff failed: " + e.getMessage()));
        }
    }

    @PostMapping("/code-diff/apply")
    public ResponseEntity<?> apply(@RequestBody CodeApplyRequest r) {
        try {
            return ResponseEntity.ok(pipeline.apply(r.projectPath(), r.artifacts()));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", "apply failed: " + e.getMessage()));
        }
    }
}
