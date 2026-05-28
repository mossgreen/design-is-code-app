package com.designiscode.app.service;

import com.designiscode.app.dto.SequenceRequest;
import org.springframework.stereotype.Service;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Shells out to the `claude` CLI to compose a call sequence from a story
 * and a finalised participant set. Returns the model's JSON output parsed
 * into a Map for the controller to re-serialise through Spring's Jackson.
 *
 * <p>Mirrors {@link AnalyzeService} — same {@link ProcessBuilder} pattern,
 * same Jackson-3 path ({@code tools.jackson.*}), same fence-tolerance,
 * same 120 s timeout. The only structural difference is the three-way
 * placeholder substitution ({STORY}/{PARTICIPANTS}/{SUT}) instead of one.
 *
 * <p>The prompt lives in {@code /prompts/sequencer.md} on the classpath
 * so it's diffable and reviewable.
 */
@Service
public class SequenceService {

    private static final String PROMPT_RESOURCE = "/prompts/sequencer.md";
    private static final String P_STORY = "{STORY}";
    private static final String P_PARTICIPANTS = "{PARTICIPANTS}";
    private static final String P_ENTITIES = "{ENTITIES}";
    private static final String P_SUT = "{SUT}";
    private static final String P_REFUSAL_FEEDBACK = "{REFUSAL_FEEDBACK}";

    /** Substituted in place of {@link #P_REFUSAL_FEEDBACK} on the first
     *  attempt. The prompt reads this as "no prior refusal to consider"
     *  and proceeds with a fresh composition. */
    private static final String FIRST_ATTEMPT_SENTINEL =
            "_First attempt — no prior refusal feedback to consider._";

    private static final long TIMEOUT_SECONDS = 120;

    private final String promptTemplate;
    private final ObjectMapper json = JsonMapper.builder().build();

    public SequenceService() throws IOException {
        this.promptTemplate = loadResource(PROMPT_RESOURCE);
    }

    public Map<String, Object> compose(SequenceRequest request) throws IOException, InterruptedException {
        if (request == null) {
            throw new IllegalArgumentException("request is required");
        }
        if (request.story() == null || request.story().isBlank()) {
            throw new IllegalArgumentException("story is required");
        }
        List<Map<String, Object>> participants = request.participants();
        if (participants == null || participants.isEmpty()) {
            throw new IllegalArgumentException("at least one participant is required");
        }

        String participantsJson = json.writeValueAsString(participants);
        String entitiesJson = json.writeValueAsString(filterPolyCallableEntities(request.entities()));
        String sut = request.sut() == null ? "" : request.sut().trim();
        String refusalFeedback = renderRefusalFeedback(request.refusalFeedback());

        String prompt = promptTemplate
                .replace(P_STORY, request.story().trim())
                .replace(P_PARTICIPANTS, participantsJson)
                .replace(P_ENTITIES, entitiesJson)
                .replace(P_SUT, sut)
                .replace(P_REFUSAL_FEEDBACK, refusalFeedback);

        List<String> args = new ArrayList<>(List.of(
                "claude",
                "--dangerously-skip-permissions"
        ));
        Models.appendIfValid(args, request.model());
        args.add("-p");
        args.add(prompt);

        ProcessBuilder pb = new ProcessBuilder(args)
                .redirectErrorStream(true)
                .redirectInput(new File("/dev/null"));

        Process process;
        try {
            process = pb.start();
        } catch (IOException e) {
            String msg = e.getMessage() == null ? "" : e.getMessage();
            if (msg.contains("No such file") || msg.contains("error=2")) {
                throw new IOException("`claude` CLI not found on PATH. Install Claude Code and try again.", e);
            }
            throw e;
        }

        String stdout = readAll(process.getInputStream());
        boolean exited = process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        if (!exited) {
            process.destroyForcibly();
            throw new IOException("claude sequence composition timed out after " + TIMEOUT_SECONDS + "s");
        }
        int exit = process.exitValue();
        if (exit != 0) {
            throw new IOException("claude exited " + exit + ": " + truncate(stdout, 500));
        }

        String body = stripFences(stdout);
        Map<String, Object> response;
        try {
            //noinspection unchecked
            response = json.readValue(body, Map.class);
        } catch (JacksonException e) {
            throw new IOException("sequencer did not return valid JSON. First 500 chars: " + truncate(body, 500), e);
        }

        List<String> errors = validateDataflow(response, request);
        if (!errors.isEmpty()) {
            response.put("errors", errors);
        }
        return response;
    }

    /**
     * Post-LLM dataflow check (rule R-dataflow). Walks the emitted steps in
     * document order and flags any call whose declared argument is not
     * sourceable from the SUT's entry parameters, their fields/getters, or
     * the return of an earlier step. The classic gap this surfaces:
     * {@code findApplicable(petType, daysSinceLastVisit)} when the SUT was
     * given only {@code petId} — the sequencer skipped a {@code findById}
     * lookup.
     *
     * <p>Fail-open philosophy: when the method's args aren't declared in
     * either the explicit step body or the participants/entities catalog,
     * the validator stays silent. The rule of thumb is "only flag what we
     * can prove is broken" — false positives erode the user's trust in the
     * validator faster than a missed gap.
     */
    static List<String> validateDataflow(Map<String, Object> response, SequenceRequest request) {
        List<String> errors = new ArrayList<>();
        if (request == null) return errors;

        String sutName = request.sut() == null ? "" : request.sut().trim();
        if (sutName.isEmpty()) return errors;

        Map<String, Map<String, Object>> participantsByName = indexByName(request.participants());
        Map<String, Map<String, Object>> entitiesByName = indexByName(request.entities());

        Map<String, Object> sut = participantsByName.get(sutName);
        if (sut == null) return errors;

        Map<String, String> inScope = new LinkedHashMap<>();
        seedScopeFromSut(sut, request.entities(), inScope);

        Object steps = response.get("steps");
        if (steps instanceof List<?> stepsList) {
            walkSteps(stepsList, inScope, errors, participantsByName, entitiesByName, request.entities());
        }
        return errors;
    }

    private static void seedScopeFromSut(Map<String, Object> sut, List<Map<String, Object>> entities,
                                          Map<String, String> inScope) {
        Object behaviors = sut.get("behaviors");
        if (!(behaviors instanceof List<?> bl)) return;
        for (Object b : bl) {
            if (!(b instanceof Map<?, ?> bm)) continue;
            Object argsObj = bm.get("args");
            if (!(argsObj instanceof List<?> al)) continue;
            for (Object a : al) {
                if (!(a instanceof Map<?, ?> am)) continue;
                String n = am.get("name") instanceof String s ? s : null;
                String t = am.get("type") instanceof String s ? s : null;
                if (n == null || n.isEmpty()) continue;
                inScope.put(n, t == null ? "?" : t);
                expandFields(n, t, entities, inScope);
            }
        }
    }

    /** Expand record fields and getter-style behaviors of an in-scope binding's
     *  type into dotted scope entries ({@code request.petId} → in scope). Treats
     *  {@code getFoo()} as exposing the {@code foo} property — the wizard's
     *  generated orchestrator can call either form. */
    private static void expandFields(String binding, String typeName,
                                      List<Map<String, Object>> entities, Map<String, String> inScope) {
        if (typeName == null || entities == null) return;
        String simple = stripGenerics(typeName);
        for (Map<String, Object> e : entities) {
            if (e == null) continue;
            if (!simple.equals(e.get("name"))) continue;
            Object fields = e.get("fields");
            if (fields instanceof List<?> fl) {
                for (Object f : fl) {
                    if (!(f instanceof Map<?, ?> fm)) continue;
                    String fn = fm.get("name") instanceof String s ? s : null;
                    String ft = fm.get("type") instanceof String s ? s : null;
                    if (fn == null) continue;
                    inScope.put(binding + "." + fn, ft == null ? "?" : ft);
                }
            }
            Object behaviors = e.get("behaviors");
            if (behaviors instanceof List<?> bl) {
                for (Object b : bl) {
                    if (!(b instanceof Map<?, ?> bm)) continue;
                    String mn = bm.get("name") instanceof String s ? s : null;
                    String mt = bm.get("returns") instanceof String s ? s : null;
                    if (mn == null) continue;
                    if (mn.startsWith("get") && mn.length() > 3 && Character.isUpperCase(mn.charAt(3))) {
                        String prop = Character.toLowerCase(mn.charAt(3)) + mn.substring(4);
                        inScope.put(binding + "." + prop, mt == null ? "?" : mt);
                    }
                    inScope.put(binding + "." + mn + "()", mt == null ? "?" : mt);
                }
            }
        }
    }

    private static void walkSteps(List<?> steps, Map<String, String> inScope, List<String> errors,
                                   Map<String, Map<String, Object>> participants,
                                   Map<String, Map<String, Object>> entities,
                                   List<Map<String, Object>> entitiesList) {
        for (int i = 0; i < steps.size(); i++) {
            if (!(steps.get(i) instanceof Map<?, ?> step)) continue;
            Object kind = step.get("kind");
            if (kind instanceof String ks && !ks.isEmpty()) {
                Object inner = step.get("steps");
                if (inner instanceof List<?> il) walkSteps(il, inScope, errors, participants, entities, entitiesList);
                Object elseInner = step.get("elseSteps");
                if (elseInner instanceof List<?> el) walkSteps(el, inScope, errors, participants, entities, entitiesList);
                continue;
            }
            String caller = step.get("caller") instanceof String s ? s : "?";
            String callee = step.get("callee") instanceof String s ? s : "?";
            String method = step.get("method") instanceof String s ? s : "?";

            List<Map<String, Object>> declaredArgs = resolveDeclaredArgs(step, callee, method, participants, entities);
            if (declaredArgs != null) {
                for (Map<String, Object> arg : declaredArgs) {
                    String an = arg.get("name") instanceof String s ? s : null;
                    String at = arg.get("type") instanceof String s ? s : null;
                    if (an == null || an.isEmpty()) continue;
                    if (!isResolvable(an, at, inScope)) {
                        errors.add("Step " + (i + 1) + " (" + caller + " → " + callee + "." + method + "): "
                                + "argument '" + an + (at == null ? "" : ": " + at)
                                + "' is not sourceable from scope. "
                                + "In-scope bindings: " + summarizeScope(inScope)
                                + ". Insert a lookup step that produces this value, or change the SUT's entry signature to carry it.");
                    }
                }
            }

            String retType = resolveReturnType(step, callee, method, participants, entities);
            if (retType != null && !retType.isBlank() && !"void".equalsIgnoreCase(retType)) {
                String binding = lowercaseFirstLetter(stripGenerics(retType));
                if (!binding.isEmpty()) {
                    inScope.put(binding, retType);
                    expandFields(binding, retType, entitiesList, inScope);
                }
            }
        }
    }

    private static List<Map<String, Object>> resolveDeclaredArgs(Map<?, ?> step, String callee, String method,
                                                                   Map<String, Map<String, Object>> participants,
                                                                   Map<String, Map<String, Object>> entities) {
        Object stepArgs = step.get("args");
        if (stepArgs instanceof List<?> sl) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Object a : sl) if (a instanceof Map<?, ?> am) out.add(castStringObjectMap(am));
            return out;
        }
        Map<String, Object> target = participants.get(callee);
        if (target == null) target = entities.get(callee);
        if (target == null) return null;
        Object behaviors = target.get("behaviors");
        if (!(behaviors instanceof List<?> bl)) return null;
        for (Object b : bl) {
            if (!(b instanceof Map<?, ?> bm)) continue;
            if (!method.equals(bm.get("name"))) continue;
            Object args = bm.get("args");
            if (args instanceof List<?> al) {
                List<Map<String, Object>> out = new ArrayList<>();
                for (Object a : al) if (a instanceof Map<?, ?> am) out.add(castStringObjectMap(am));
                return out;
            }
            return List.of();
        }
        return null;
    }

    private static String resolveReturnType(Map<?, ?> step, String callee, String method,
                                              Map<String, Map<String, Object>> participants,
                                              Map<String, Map<String, Object>> entities) {
        Object stepReturns = step.get("returns");
        if (stepReturns instanceof String s && !s.isBlank()) return s;
        Map<String, Object> target = participants.get(callee);
        if (target == null) target = entities.get(callee);
        if (target == null) return null;
        Object behaviors = target.get("behaviors");
        if (!(behaviors instanceof List<?> bl)) return null;
        for (Object b : bl) {
            if (!(b instanceof Map<?, ?> bm)) continue;
            if (!method.equals(bm.get("name"))) continue;
            return bm.get("returns") instanceof String s ? s : null;
        }
        return null;
    }

    /** True when the declared parameter is sourceable from the current scope.
     *  Match strategy:
     *  <ol>
     *    <li>Exact name match (parameter is a direct binding).</li>
     *    <li>Dotted-suffix name match: any in-scope key ends with
     *        {@code "." + argName} — covers field/getter access like
     *        {@code order.carrier} satisfying a {@code carrier} parameter.</li>
     *    <li>Type-equality match against any binding's value type.</li>
     *  </ol>
     *  The petclinic regression {@code findApplicable(petType: PetType, ...)}
     *  flags because no PetType is in scope when the entry only carries
     *  {@code petId: int}. Once the user adds {@code PetRepository.findById(petId)
     *  → Pet}, {@code Pet.getType()} expansion puts {@code pet.type: PetType}
     *  in scope and the call resolves.
     */
    private static boolean isResolvable(String argName, String argType, Map<String, String> inScope) {
        if (inScope.containsKey(argName)) return true;
        String dotted = "." + argName;
        for (String k : inScope.keySet()) {
            if (k.endsWith(dotted)) return true;
        }
        if (argType == null || argType.isBlank()) return false;
        String simple = stripGenerics(argType);
        for (String v : inScope.values()) {
            if (v == null) continue;
            if (simple.equals(stripGenerics(v))) return true;
        }
        return false;
    }

    private static String summarizeScope(Map<String, String> inScope) {
        if (inScope.isEmpty()) return "(empty)";
        StringBuilder sb = new StringBuilder("[");
        int n = 0;
        for (Map.Entry<String, String> e : inScope.entrySet()) {
            if (n++ > 0) sb.append(", ");
            sb.append(e.getKey()).append(": ").append(e.getValue());
        }
        sb.append("]");
        return sb.toString();
    }

    private static Map<String, Map<String, Object>> indexByName(List<Map<String, Object>> items) {
        Map<String, Map<String, Object>> out = new LinkedHashMap<>();
        if (items == null) return out;
        for (Map<String, Object> item : items) {
            if (item == null) continue;
            if (item.get("name") instanceof String s && !s.isBlank()) out.put(s, item);
        }
        return out;
    }

    private static String stripGenerics(String type) {
        if (type == null) return "";
        int lt = type.indexOf('<');
        return lt < 0 ? type.trim() : type.substring(0, lt).trim();
    }

    private static String lowercaseFirstLetter(String s) {
        if (s == null || s.isEmpty()) return "";
        return Character.toLowerCase(s.charAt(0)) + s.substring(1);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castStringObjectMap(Map<?, ?> raw) {
        return (Map<String, Object>) raw;
    }

    // --- helpers (copied from AnalyzeService) ---

    /** Keep only entities the sequencer can dispatch into: {@code kind} is
     *  {@code "interface"} or {@code "sealed-interface"} AND
     *  {@code behaviors} is a non-empty list. Pure sum types (sealed with
     *  empty behaviors), records, enums, and classes have no callable
     *  surface from a sequence arrow, so they're dropped to keep the
     *  prompt slim. Null/empty input returns an empty list. */
    private static List<Map<String, Object>> filterPolyCallableEntities(List<Map<String, Object>> entities) {
        if (entities == null || entities.isEmpty()) return List.of();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> e : entities) {
            if (e == null) continue;
            Object kind = e.get("kind");
            if (!"interface".equals(kind) && !"sealed-interface".equals(kind)) continue;
            Object behaviors = e.get("behaviors");
            if (!(behaviors instanceof List<?> list) || list.isEmpty()) continue;
            out.add(e);
        }
        return out;
    }

    /** Render the substitution for {@link #P_REFUSAL_FEEDBACK}. Null or
     *  blank → first-attempt sentinel; otherwise the trimmed feedback
     *  framed for the model so it understands this is a corrective
     *  retry, not a fresh request. */
    private static String renderRefusalFeedback(String feedback) {
        if (feedback == null || feedback.isBlank()) return FIRST_ATTEMPT_SENTINEL;
        return "The codegen tool rejected your previous attempt with this refusal:\n\n"
                + feedback.trim()
                + "\n\nProduce a corrected sequence that addresses the cited problem. "
                + "Do not reproduce the same shape — the fix must visibly change "
                + "something the refusal called out. Stay within the existing "
                + "participant cast; don't invent new participants. The story, "
                + "participants, and SUT are unchanged from your previous attempt.";
    }

    private static String loadResource(String path) throws IOException {
        try (InputStream in = SequenceService.class.getResourceAsStream(path)) {
            if (in == null) throw new IOException("classpath resource not found: " + path);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String readAll(InputStream in) throws IOException {
        StringBuilder buf = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                buf.append(line).append('\n');
            }
        }
        return buf.toString();
    }

    private static String stripFences(String text) {
        String t = text.trim();
        if (t.startsWith("```")) {
            int firstNewline = t.indexOf('\n');
            if (firstNewline > 0) t = t.substring(firstNewline + 1);
            int endFence = t.lastIndexOf("```");
            if (endFence >= 0) t = t.substring(0, endFence);
        }
        return t.trim();
    }

    private static String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }
}
