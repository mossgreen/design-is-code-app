package com.designiscode.app.controller;

import com.designiscode.app.service.FsService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.file.AccessDeniedException;
import java.nio.file.NotDirectoryException;
import java.util.Map;

@RestController
@RequestMapping("/api/fs")
public class FsController {

    private final FsService fsService;

    public FsController(FsService fsService) {
        this.fsService = fsService;
    }

    @GetMapping("/list")
    public ResponseEntity<?> list(
            @RequestParam(required = false) String path,
            @RequestParam(required = false, defaultValue = "false") boolean showHidden
    ) {
        try {
            return ResponseEntity.ok(fsService.list(path, showHidden));
        } catch (IllegalArgumentException | NotDirectoryException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (AccessDeniedException e) {
            return ResponseEntity.status(403).body(Map.of("error", "Permission denied: " + e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError()
                    .body(Map.of("error", "List failed: " + e.getMessage()));
        }
    }
}
