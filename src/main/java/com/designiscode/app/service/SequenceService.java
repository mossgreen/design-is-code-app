package com.designiscode.app.service;

import com.designiscode.app.dto.SequenceRequest;
import org.springframework.beans.factory.annotation.Value;
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
 * same configurable timeout (default 300 s). The only structural difference is the three-way
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

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(SequenceService.class);

    /** Subprocess timeout (s) and CLI reasoning effort — see AnalyzeService.
     *  Configurable via {@code disc.claude.timeout} / {@code disc.claude.effort}. */
    private final long timeoutSeconds;
    private final String effort;

    private final String promptTemplate;
    private final ObjectMapper json = JsonMapper.builder().build();
    private final CancelRegistry cancelRegistry;

    public SequenceService(
            @Value("${disc.claude.timeout:300}") long timeoutSeconds,
            @Value("${disc.claude.effort:low}") String effort,
            CancelRegistry cancelRegistry
    ) throws IOException {
        this.timeoutSeconds = timeoutSeconds;
        this.effort = effort;
        this.cancelRegistry = cancelRegistry;
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

        // Single-completion transform — see AnalyzeService for the rationale.
        List<String> args = new ArrayList<>(List.of(
                "claude",
                "--strict-mcp-config",
                "--tools", ""
        ));
        if (effort != null && !effort.isBlank()) {
            args.add("--effort");
            args.add(effort.trim());
        }
        Models.appendIfValid(args, request.model());
        args.add("-p");
        args.add(prompt);

        ProcessBuilder pb = new ProcessBuilder(args)
                .redirectErrorStream(true)
                .redirectInput(new File("/dev/null"));

        long startNanos = System.nanoTime();
        log.info("sequence start: model={}, promptChars={}", request.model(), prompt.length());

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

        // Drain stdout on a daemon thread so the timeout below actually bounds
        // the call: a hung `claude` keeps the pipe open, and reading on THIS
        // thread would block in readAll() forever (past the timeout, which then
        // never fires). The background read also prevents a full ~64 KB pipe
        // buffer from dead-locking a chatty-but-healthy run.
        StringBuilder collected = new StringBuilder();
        Thread reader = new Thread(() -> {
            try {
                collected.append(readAll(process.getInputStream()));
            } catch (IOException ignored) {
                // stream closed by destroyForcibly, or normal EOF on exit
            }
        });
        reader.setDaemon(true);
        reader.start();

        String runId = request.runId();
        if (runId != null && !runId.isBlank()) cancelRegistry.register(runId, process);
        boolean exited;
        try {
            exited = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
        } finally {
            if (runId != null && !runId.isBlank()) cancelRegistry.unregister(runId);
        }
        if (!exited) {
            process.destroyForcibly();
            log.warn("sequence composition TIMED OUT after {} ms (model={})",
                    (System.nanoTime() - startNanos) / 1_000_000, request.model());
            throw new IOException("claude sequence composition timed out after " + timeoutSeconds + "s");
        }
        reader.join(5_000); // process exited -> reader hits EOF promptly; join publishes the buffer
        String stdout = collected.toString();
        int exit = process.exitValue();
        log.info("sequence done: model={}, exit={}, {} ms, outChars={}",
                request.model(), exit, (System.nanoTime() - startNanos) / 1_000_000, stdout.length());
        if (exit != 0) {
            throw new IOException("claude exited " + exit + ": " + truncate(stdout, 500));
        }

        String body = stripFences(stdout);
        try {
            //noinspection unchecked
            return json.readValue(body, Map.class);
        } catch (JacksonException e) {
            throw new IOException("sequencer did not return valid JSON. First 500 chars: " + truncate(body, 500), e);
        }
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
