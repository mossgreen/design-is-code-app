package com.designiscode.app.controller;

import com.designiscode.app.dto.DesignRequest;
import com.designiscode.app.service.DesignService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api")
public class DesignController {

    private final DesignService designService;

    public DesignController(DesignService designService) {
        this.designService = designService;
    }

    @PostMapping("/design")
    public ResponseEntity<?> save(@RequestBody DesignRequest request) {
        try {
            return ResponseEntity.ok(designService.save(request));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError()
                    .body(Map.of("error", "Save failed: " + e.getMessage()));
        }
    }
}
