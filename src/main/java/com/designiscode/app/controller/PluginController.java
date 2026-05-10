package com.designiscode.app.controller;

import com.designiscode.app.dto.CancelRequest;
import com.designiscode.app.dto.PluginStatus;
import com.designiscode.app.service.PluginService;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;

import java.util.Map;

@RestController
@RequestMapping("/api")
public class PluginController {

    private final PluginService pluginService;

    public PluginController(PluginService pluginService) {
        this.pluginService = pluginService;
    }

    @GetMapping(value = "/disc-plugin-status", produces = MediaType.APPLICATION_JSON_VALUE)
    public PluginStatus discPluginStatus() {
        return pluginService.status();
    }

    @PostMapping(value = "/install-plugin", produces = MediaType.TEXT_PLAIN_VALUE)
    public ResponseBodyEmitter installPlugin() {
        // Plugin install should be quick (~10–30s). Pin a generous emitter
        // timeout so a slow network doesn't kill the stream.
        ResponseBodyEmitter emitter = new ResponseBodyEmitter(5L * 60L * 1000L);
        pluginService.install(emitter);
        return emitter;
    }

    @PostMapping(value = "/install-plugin/cancel", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> cancelInstall(@RequestBody CancelRequest request) {
        boolean cancelled = pluginService.cancel(request == null ? null : request.runId());
        return ResponseEntity.ok(Map.of("cancelled", cancelled));
    }

    @PostMapping(value = "/update-plugin", produces = MediaType.TEXT_PLAIN_VALUE)
    public ResponseBodyEmitter updatePlugin() {
        ResponseBodyEmitter emitter = new ResponseBodyEmitter(5L * 60L * 1000L);
        pluginService.update(emitter);
        return emitter;
    }

    @PostMapping(value = "/update-plugin/cancel", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> cancelUpdate(@RequestBody CancelRequest request) {
        boolean cancelled = pluginService.cancel(request == null ? null : request.runId());
        return ResponseEntity.ok(Map.of("cancelled", cancelled));
    }
}
