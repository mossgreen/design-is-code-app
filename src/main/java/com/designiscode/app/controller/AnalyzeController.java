package com.designiscode.app.controller;

import com.designiscode.app.dto.AnalyzeRequest;
import com.designiscode.app.service.AnalyzeService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api")
public class AnalyzeController {

    private final AnalyzeService analyzeService;
    private final com.designiscode.app.service.CancelRegistry cancelRegistry;

    public AnalyzeController(AnalyzeService analyzeService,
                             com.designiscode.app.service.CancelRegistry cancelRegistry) {
        this.analyzeService = analyzeService;
        this.cancelRegistry = cancelRegistry;
    }

    /** Kill an in-flight analyze/sequence subprocess by its client runId. */
    @PostMapping("/analyze/cancel")
    public ResponseEntity<?> cancel(@RequestBody Map<String, String> body) {
        boolean cancelled = cancelRegistry.cancel(body == null ? null : body.get("runId"));
        return ResponseEntity.ok(Map.of("cancelled", cancelled));
    }

    @PostMapping("/analyze")
    public ResponseEntity<?> analyze(@RequestBody AnalyzeRequest request) {
        try {
            return ResponseEntity.ok(analyzeService.analyze(
                    request.context(), request.catalog(), request.acceptanceCriteria(), request.model(),
                    request.runId(), request.currentFlows()));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return ResponseEntity.internalServerError().body(Map.of("error", "interrupted"));
        } catch (Exception e) {
            return ResponseEntity.internalServerError()
                    .body(Map.of("error", "Analyze failed: " + e.getMessage()));
        }
    }
}
