package com.designiscode.app.service;

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
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Shells out to the `claude` CLI to decompose a free-text requirement into
 * a tree of abstractions, then parses the model's JSON response.
 *
 * <p>The prompt lives in {@code /prompts/analyzer.md} on the classpath so it
 * stays diffable / reviewable. The placeholder {@code {CONTEXT}} is replaced
 * with the user's input verbatim.
 *
 * <p>Returns a {@link Map} (parsed JSON) so the controller can re-serialize
 * it through Jackson — this also validates the model output before it leaves
 * the server, surfacing malformed responses as 5xx rather than as garbage
 * trees on the client.
 */
@Service
public class AnalyzeService {

    private static final String PROMPT_RESOURCE = "/prompts/analyzer.md";
    private static final String PLACEHOLDER = "{CONTEXT}";

    /** Hard timeout for the subprocess. Claude calls usually return in
     *  ~10–30 s; anything past 2 min is almost certainly a hang. */
    private static final long TIMEOUT_SECONDS = 120;

    private final String promptTemplate;
    private final ObjectMapper json = JsonMapper.builder().build();

    public AnalyzeService() throws IOException {
        this.promptTemplate = loadResource(PROMPT_RESOURCE);
    }

    public Map<String, Object> analyze(String context) throws IOException, InterruptedException {
        if (context == null || context.isBlank()) {
            throw new IllegalArgumentException("context is required");
        }

        String prompt = promptTemplate.replace(PLACEHOLDER, context.trim());

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
            throw new IOException("claude analysis timed out after " + TIMEOUT_SECONDS + "s");
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
            throw new IOException("analyzer did not return valid JSON. First 500 chars: " + truncate(body, 500), e);
        }
    }

    // --- helpers ---

    private static String loadResource(String path) throws IOException {
        try (InputStream in = AnalyzeService.class.getResourceAsStream(path)) {
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

    /** Tolerate ```json fenced output even though the prompt says no fences. */
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
