package com.designiscode.app.service;

import org.springframework.stereotype.Component;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Translates one line of `claude --output-format stream-json --verbose` output
 * into 0..N small NDJSON events the wizard understands.
 *
 * <p>Pure function (no IO, no state). Easy to unit-test.
 */
@Component
public class StreamJsonMapper {

    private static final int MAX_TEXT_BYTES = 8 * 1024;

    /**
     * Matches "Step N" inside assistant prose — used to advance the checklist.
     * Strict by design: the user wants no inference. Examples it accepts:
     *   "## Step 3: Resolve Targets"
     *   "Step 5"
     *   "### Step 7: Write Files"
     */
    private static final Pattern STEP_RE =
            Pattern.compile("(?m)^#{0,3}\\s*Step\\s+(\\d)\\b");

    private final ObjectMapper mapper = JsonMapper.builder().build();

    public List<String> mapLine(String rawLine) {
        if (rawLine == null) return List.of();
        String line = rawLine.trim();
        if (line.isEmpty()) return List.of();

        JsonNode node;
        try {
            node = mapper.readTree(line);
        } catch (JacksonException ex) {
            return List.of(serialize(event("raw").put("text", truncate(line))));
        }
        if (!node.isObject()) {
            return List.of(serialize(event("raw").put("text", truncate(line))));
        }

        String type = textOrEmpty(node, "type");
        return switch (type) {
            case "system" -> mapSystem(node);
            case "assistant" -> mapAssistant(node);
            case "result" -> mapResult(node);
            default -> List.of();   // rate_limit_event, user/tool_result, etc. -> drop silently
        };
    }

    // --- type-specific handlers ---

    private List<String> mapSystem(JsonNode node) {
        if ("init".equals(textOrEmpty(node, "subtype"))) {
            return List.of(serialize(event("start")));
        }
        return List.of();
    }

    private List<String> mapAssistant(JsonNode node) {
        JsonNode message = node.path("message");
        JsonNode content = message.path("content");
        if (!content.isArray()) return List.of();

        List<String> out = new ArrayList<>();
        for (JsonNode item : content) {
            String itemType = textOrEmpty(item, "type");
            switch (itemType) {
                case "tool_use" -> out.add(toolUseEvent(item));
                case "text" -> {
                    String text = textOrEmpty(item, "text");
                    if (text.isEmpty()) break;
                    out.add(serialize(event("text").put("text", truncate(text))));
                    Matcher m = STEP_RE.matcher(text);
                    while (m.find()) {
                        int n = Integer.parseInt(m.group(1));
                        if (n >= 1 && n <= 8) {
                            out.add(serialize(event("step").put("n", n)));
                        }
                    }
                }
                default -> { /* thinking / other -> drop */ }
            }
        }
        return out;
    }

    private List<String> mapResult(JsonNode node) {
        ObjectNode ev = event("done");
        ev.put("exit", 0);
        // result lines may include is_error or subtype; surface them lightly so
        // the UI can show ✗ Failed when the agent itself reports an error.
        if (node.path("is_error").asBoolean(false)) {
            ev.put("error", textOrEmpty(node, "subtype"));
        }
        return List.of(serialize(ev));
    }

    private String toolUseEvent(JsonNode item) {
        String name = textOrEmpty(item, "name");
        String summary = summarizeToolInput(name, item.path("input"));
        ObjectNode ev = event("tool")
                .put("tool", name)
                .put("summary", truncate(summary));
        return serialize(ev);
    }

    /** Pick the most useful single field from a tool's input as a one-liner. */
    private String summarizeToolInput(String tool, JsonNode input) {
        if (input == null || input.isMissingNode() || !input.isObject()) return "";
        return switch (tool) {
            case "Read", "Write", "Edit", "NotebookEdit" -> textOrEmpty(input, "file_path");
            case "Glob" -> textOrEmpty(input, "pattern");
            case "Grep" -> textOrEmpty(input, "pattern");
            case "Bash" -> textOrEmpty(input, "command");
            case "WebFetch" -> textOrEmpty(input, "url");
            default -> {
                // Fallback: just stringify the input compactly, capped.
                try {
                    yield mapper.writeValueAsString(input);
                } catch (JacksonException e) {
                    yield "";
                }
            }
        };
    }

    // --- helpers ---

    private ObjectNode event(String name) {
        return mapper.createObjectNode().put("event", name);
    }

    private String serialize(ObjectNode node) {
        try {
            return mapper.writeValueAsString(node);
        } catch (JacksonException e) {
            // Should never happen for an in-memory ObjectNode.
            return "{\"event\":\"raw\",\"text\":\"<serialization-failed>\"}";
        }
    }

    private static String textOrEmpty(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) return "";
        return v.isString() ? v.asString() : v.toString();
    }

    static String truncate(String s) {
        if (s == null) return "";
        if (s.length() <= MAX_TEXT_BYTES) return s;
        return s.substring(0, MAX_TEXT_BYTES) + "…[truncated]";
    }
}
