package com.designiscode.app.controller;

import com.designiscode.app.dto.CancelRequest;
import com.designiscode.app.dto.GenerationOptions;
import com.designiscode.app.dto.GenerationStatus;
import com.designiscode.app.service.CodeGenerator;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;

import java.util.Map;

/**
 * The wizard's only HTTP surface for code generation. Routes through
 * {@link CodeGenerator}; Spring auto-wires the single available
 * implementation ({@link com.designiscode.app.service.ClaudeCodePluginGenerator}
 * today). Swapping in a different generator is a matter of providing a
 * second {@code @Service implements CodeGenerator} bean.
 */
@RestController
@RequestMapping("/api/generator")
public class GeneratorController {

    private final CodeGenerator generator;

    public GeneratorController(CodeGenerator generator) {
        this.generator = generator;
    }

    @GetMapping(value = "/status", produces = MediaType.APPLICATION_JSON_VALUE)
    public GenerationStatus status() {
        return generator.status();
    }

    @PostMapping(value = "/run", produces = MediaType.TEXT_PLAIN_VALUE)
    public ResponseBodyEmitter run(@RequestBody GenerationOptions opts) {
        ResponseBodyEmitter emitter = new ResponseBodyEmitter(15L * 60L * 1000L);
        generator.streamGenerate(opts, emitter);
        return emitter;
    }

    @PostMapping(value = "/plan", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> plan(@RequestBody GenerationOptions opts) {
        try {
            return ResponseEntity.ok(generator.plan(opts));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError()
                    .body(Map.of("error", "Plan failed: " + e.getMessage()));
        }
    }

    @PostMapping(value = "/install", produces = MediaType.TEXT_PLAIN_VALUE)
    public ResponseBodyEmitter install() {
        ResponseBodyEmitter emitter = new ResponseBodyEmitter(5L * 60L * 1000L);
        generator.streamInstall(emitter);
        return emitter;
    }

    @PostMapping(value = "/update", produces = MediaType.TEXT_PLAIN_VALUE)
    public ResponseBodyEmitter update() {
        ResponseBodyEmitter emitter = new ResponseBodyEmitter(5L * 60L * 1000L);
        generator.streamUpdate(emitter);
        return emitter;
    }

    @PostMapping(value = "/cancel", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> cancel(@RequestBody CancelRequest request) {
        boolean cancelled = generator.cancel(request == null ? null : request.runId());
        return ResponseEntity.ok(Map.of("cancelled", cancelled));
    }
}
