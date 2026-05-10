package com.designiscode.app.service;

/**
 * Tiny helpers for building the NDJSON event lines the wizard streams back to
 * the browser. Hand-rolled (no Jackson) so the hot path stays allocation-light
 * and these helpers can be called from any service without DI.
 */
public final class JsonEvents {

    private JsonEvents() {}

    /** {@code {"event":"raw","text":"<text>"}} */
    public static String rawLine(String text) {
        return "{\"event\":\"raw\",\"text\":" + jsonString(text) + "}";
    }

    /**
     * Generic event builder. Pass alternating key/value pairs after the event
     * name. Numbers and booleans serialize as JSON literals; everything else
     * stringifies and escapes.
     *
     * <p>Example: {@code event("done", "exit", 0)} →
     * {@code {"event":"done","exit":0}}.
     */
    public static String event(String name, Object... kv) {
        StringBuilder sb = new StringBuilder("{\"event\":").append(jsonString(name));
        for (int i = 0; i + 1 < kv.length; i += 2) {
            sb.append(',').append(jsonString(String.valueOf(kv[i]))).append(':');
            Object v = kv[i + 1];
            if (v instanceof Number || v instanceof Boolean) sb.append(v);
            else if (v == null) sb.append("null");
            else sb.append(jsonString(String.valueOf(v)));
        }
        return sb.append('}').toString();
    }

    /** Escape and quote a string for JSON. Returns the literal {@code null} for nulls. */
    public static String jsonString(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.length() + 2);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        return sb.append('"').toString();
    }
}
