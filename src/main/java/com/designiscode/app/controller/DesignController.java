package com.designiscode.app.controller;

import com.designiscode.app.dto.DesignRequest;
import com.designiscode.app.service.DataflowLinter;
import com.designiscode.app.service.DesignContractValidator;
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
     *
     * <p>Optional {@code model} (the design-model: participants, entities,
     * variancePlan, sut, story) adds the **contract** checks — the deterministic
     * subset of the plugin's Step-1 refusal rules the app can evaluate itself,
     * instantly and without a model call. Sending it turns this endpoint into the
     * one place a design is judged before generation; omitting it leaves the
     * previous behaviour untouched.
     *
     * <p><b>The two families are reported separately, and that separation is
     * load-bearing.</b> A flow violation says "this call consumes a value nothing
     * produces" — the sequencer authors call arguments, so it can fix one, and
     * {@code runSequence()} retries it with exactly that complaint. A contract
     * violation says "this sealed family has one permit" — grammar, which the
     * sequencer does not own and cannot repair. Merging them into one list (as
     * this endpoint briefly did) sends grammar complaints to the sequencer wrapped
     * in a description of a data-flow problem, and renders them in the Step-3
     * panel under a heading that is false for them. Same shape, different
     * destination: keep them apart.
     */
    @PostMapping("/design/lint")
    public ResponseEntity<?> lint(@RequestBody Map<String, Object> request) {
        Object raw = request.get("puml");
        String puml = raw == null ? null : raw.toString();

        DataflowLinter.Report flow = DataflowLinter.lint(puml, knownTypes(request.get("knownTypes")));
        // Optional `sidecars` (file name → .decision.md content). A client that
        // sends none gets the flow verdict alone, unchanged.
        DataflowLinter.Report decision = DataflowLinter.lintDecision(puml, sidecars(request.get("sidecars")));

        List<String> violations = new ArrayList<>(flow.violations());
        violations.addAll(decision.violations());
        List<String> warnings = new ArrayList<>(flow.warnings());
        warnings.addAll(decision.warnings());

        DesignContractValidator.Report contract = contract(request);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("violations", violations);
        body.put("warnings", warnings);
        body.put("contractViolations", contract == null ? List.of() : contract.violations());
        body.put("contractWarnings", contract == null ? List.of() : contract.warnings());
        return ResponseEntity.ok(body);
    }

    /**
     * Runs the contract checks when the client sent a design model. Returns null
     * when it did not — the checks are additive, so a client that omits the model
     * must not be told anything new.
     *
     * <p>The model is untrusted JSON. A malformed one is reported as a violation
     * rather than thrown: the caller is a reviewer looking at a panel, and a 500
     * teaches nothing.
     */
    private static DesignContractValidator.Report contract(Map<String, Object> request) {
        if (!(request.get("model") instanceof Map<?, ?> raw) || raw.isEmpty()) return null;
        Map<String, Object> model = new LinkedHashMap<>();
        raw.forEach((k, v) -> {
            if (k != null) model.put(k.toString(), v);
        });
        int acCount = request.get("acCount") instanceof Number n ? n.intValue() : 0;
        try {
            return DesignContractValidator.validate(model, acCount);
        } catch (RuntimeException e) {
            return new DesignContractValidator.Report(
                    List.of("the design model could not be checked: " + e), List.of());
        }
    }

    /** Coerce untrusted JSON: a malformed entry is ignored rather than thrown. */
    private static Map<String, String> sidecars(Object raw) {
        Map<String, String> out = new LinkedHashMap<>();
        if (!(raw instanceof Map<?, ?> map)) return out;
        map.forEach((k, v) -> {
            if (k != null && v != null) out.put(k.toString(), v.toString());
        });
        return out;
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
