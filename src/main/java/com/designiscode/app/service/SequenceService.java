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
    private static final String P_SUT = "{SUT}";

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
        String sut = request.sut() == null ? "" : request.sut().trim();

        String prompt = promptTemplate
                .replace(P_STORY, request.story().trim())
                .replace(P_PARTICIPANTS, participantsJson)
                .replace(P_SUT, sut);

        ProcessBuilder pb = new ProcessBuilder(
                "claude",
                "--dangerously-skip-permissions",
                "-p", prompt
        )
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
        try {
            //noinspection unchecked
            return json.readValue(body, Map.class);
        } catch (JacksonException e) {
            throw new IOException("sequencer did not return valid JSON. First 500 chars: " + truncate(body, 500), e);
        }
    }

    // --- helpers (copied from AnalyzeService) ---

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
