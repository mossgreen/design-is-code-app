package com.designiscode.app.controller;

import com.designiscode.app.dto.CancelRequest;
import com.designiscode.app.dto.RunRequest;
import com.designiscode.app.service.RunService;
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

    public RunController(RunService runService) {
        this.runService = runService;
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
}
