package com.designiscode.app.controller;

import com.designiscode.app.dto.DesignRequest;
import com.designiscode.app.service.DataflowLinter;
import com.designiscode.app.service.DesignService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class DesignController {

    private final DesignService designService;

    public DesignController(DesignService designService) {
        this.designService = designService;
    }

    /**
     * Data-flow lint over a proposed design, for the Step-3 review gate. Takes the
     * assembled {@code .puml} so any client with a design — wizard, CLI, CI — gets
     * the same verdict from the same rules.
     *
     * <p>Optional {@code knownTypes} (simple type name → public method names) lets
     * the lint also judge accessors called on types reused from a scanned project.
     * A client without a scanned project simply omits it.
     */
    @PostMapping("/design/lint")
    public ResponseEntity<?> lint(@RequestBody Map<String, Object> request) {
        Object puml = request.get("puml");
        return ResponseEntity.ok(DataflowLinter.lint(
                puml == null ? null : puml.toString(), knownTypes(request.get("knownTypes"))));
    }

    /**
     * Coerce the request's {@code knownTypes} rather than casting it: this is
     * untrusted JSON, and a malformed entry should be ignored rather than throw.
     */
    private static Map<String, Collection<String>> knownTypes(Object raw) {
        Map<String, Collection<String>> out = new LinkedHashMap<>();
        if (!(raw instanceof Map<?, ?> map)) return out;
        map.forEach((k, v) -> {
            if (k == null || !(v instanceof Collection<?> methods)) return;
            List<String> names = new ArrayList<>();
            methods.forEach(m -> { if (m != null) names.add(m.toString()); });
            out.put(k.toString(), names);
        });
        return out;
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
