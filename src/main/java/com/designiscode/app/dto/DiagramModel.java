package com.designiscode.app.dto;

import java.util.List;

/**
 * A renderable sequence diagram as data — the shape the Stage-D review page
 * draws its before/after SVGs from, so the frontend never parses puml.
 *
 * <p>{@code participants} are lifelines in left-to-right order; the literal
 * {@code [*]} names the system_caller boundary. Steps are drawn top-down:
 * <ul>
 *   <li>{@code call} — solid arrow {@code from → to}, {@code label} is the
 *       method call text;</li>
 *   <li>{@code return} — dashed arrow {@code from → to}, {@code label} is the
 *       typed result;</li>
 *   <li>{@code alt-start} / {@code alt-else} / {@code alt-end} — branch frame
 *       markers; {@code label} carries the guard, {@code from}/{@code to} are
 *       null.</li>
 * </ul>
 */
public record DiagramModel(List<String> participants, List<Step> steps) {

    public record Step(String kind, String from, String to, String label) {

        public static Step call(String from, String to, String label) {
            return new Step("call", from, to, label);
        }

        public static Step ret(String from, String to, String label) {
            return new Step("return", from, to, label);
        }

        public static Step altStart(String guard) {
            return new Step("alt-start", null, null, guard);
        }

        public static Step altElse(String guard) {
            return new Step("alt-else", null, null, guard);
        }

        public static Step altEnd() {
            return new Step("alt-end", null, null, null);
        }
    }
}
