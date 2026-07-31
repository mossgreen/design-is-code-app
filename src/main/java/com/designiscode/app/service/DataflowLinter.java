package com.designiscode.app.service;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Deterministic data-flow lint over an assembled {@code .puml} design.
 *
 * <p>Sibling of {@link DesignDeltaValidator}: that one asks <i>is this delta
 * minimal?</i>, this one asks <i>does the flow actually connect?</i> A sequence
 * diagram can be structurally perfect and still describe a feature that does
 * nothing — the 2026-07-24 run fetched a fee rule and never passed it to the
 * leaf that needed it (severed variance), and consumed an {@code hoursUntilVisit}
 * that no arrow produced. Both are invisible to arrow-parity checks and easy for
 * a human reviewer to miss; both are mechanical to catch here.
 *
 * <p>The rules are stated once, over a normalized {@link Flow}, and two adapters
 * build one: {@link #fromPuml} for an assembled diagram and {@link #lintSteps}
 * for the sequencer's raw step JSON. So the same property is enforceable the
 * moment a flow is composed — where the sequencer can still fix it — and again
 * at review, where the team can, without the rule existing twice.
 *
 * <p>Fragments ({@code alt} / {@code loop} / …) are flattened: values are
 * matched in file order. That over-approximates availability inside branches,
 * which is the safe direction — the lint never invents a violation because of a
 * branch, it only misses one.
 */
public final class DataflowLinter {

    /** Same shape as {@link DesignDeltaValidator.Report} — violations block, warnings inform. */
    public record Report(List<String> violations, List<String> warnings) {
        public boolean ok() {
            return violations.isEmpty();
        }
    }

    private static final String SYSTEM_CALLER = "[*]";

    /** {@code A -> B : label}, where a lifeline is an identifier or the {@code [*]} boundary. */
    private static final Pattern ARROW = Pattern.compile(
            "^\\s*(\\[\\*\\]|[A-Za-z_][\\w]*)\\s*(->|-->|<--|<-)\\s*(\\[\\*\\]|[A-Za-z_][\\w]*)\\s*:\\s*(.+?)\\s*$");

    /**
     * Type declarations: the {@code participant Foo <<…>>} / {@code class Foo <<…>>}
     * prelude, plus {@code create Foo} — the factory idiom declares its lifeline
     * mid-flow, and a value of a created type is exactly the kind that gets
     * fetched and dropped.
     */
    private static final Pattern DECLARATION = Pattern.compile(
            "^\\s*(?:participant|class|actor|entity|boundary|control|database|collections|queue|create)\\s+"
                    + "(\\[\\*\\]|[A-Za-z_][\\w]*)\\b.*$");

    private static final Pattern LITERAL = Pattern.compile(
            "^(?:-?\\d[\\w.]*|\".*\"|'.*'|true|false|null|this)$", Pattern.CASE_INSENSITIVE);

    private DataflowLinter() {
    }

    /**
     * A design reduced to what this lint needs: the declared type names and the
     * interactions in order. Two things can produce one — an assembled {@code .puml}
     * and the sequencer's raw step JSON — and both are then judged by identical
     * rules, so the property is defined once rather than per representation.
     */
    record Flow(Set<String> declared, List<Arrow> arrows, Map<String, Set<String>> knownTypes) {
    }

    /** Entry point for a design that already exists as a diagram. */
    public static Report lint(String puml) {
        return lint(puml, Map.of());
    }

    /**
     * As {@link #lint(String)}, plus the public methods of the types this design
     * reuses from an existing codebase, keyed by simple type name. Supplying them
     * enables the accessor rule; omitting them leaves it silent, so callers
     * without a scanned project are unaffected.
     */
    public static Report lint(String puml, Map<String, ? extends Collection<String>> knownTypes) {
        if (puml == null || puml.isBlank()) {
            return new Report(new ArrayList<>(), new ArrayList<>());
        }
        return lintFlow(fromPuml(puml, knownTypes));
    }

    static Flow fromPuml(String puml) {
        return fromPuml(puml, Map.of());
    }

    static Flow fromPuml(String puml, Map<String, ? extends Collection<String>> knownTypes) {
        Set<String> declared = new LinkedHashSet<>();     // participants + entities named in the prelude
        List<Arrow> arrows = new ArrayList<>();
        for (String raw : puml.split("\\R")) {
            String line = raw.strip();
            if (line.isEmpty() || line.startsWith("'") || line.startsWith("@")) continue;
            Matcher decl = DECLARATION.matcher(line);
            if (decl.matches()) {
                declared.add(decl.group(1));
                continue;
            }
            Matcher m = ARROW.matcher(line);
            if (m.matches()) arrows.add(Arrow.of(m.group(1), m.group(2), m.group(3), m.group(4), line));
        }
        return new Flow(declared, arrows, normalizeKnownTypes(knownTypes));
    }

    private static Map<String, Set<String>> normalizeKnownTypes(
            Map<String, ? extends Collection<String>> raw) {
        Map<String, Set<String>> out = new LinkedHashMap<>();
        if (raw == null) return out;
        raw.forEach((type, methods) -> {
            if (type == null || type.isBlank() || methods == null) return;
            out.put(type.trim(), new LinkedHashSet<>(methods));
        });
        return out;
    }

    /**
     * Entry point for the sequencer's output, before any diagram exists. Judging the
     * step list directly is what lets the sequencer be told to fix its own mistake
     * instead of the reviewer discovering it later.
     *
     * @param sut         the orchestrator's name — the caller of every entry-level step
     * @param entryMethod the entry method name, for readable messages
     * @param entryParams the parameters the orchestrator receives; the flow's only
     *                    values that need no producer
     * @param steps       ordered call steps: {@code caller}, {@code callee},
     *                    {@code method}, {@code args} (values), {@code resultName}
     */
    public static Report lintSteps(String sut, String entryMethod,
                                   List<String> entryParams, List<Map<String, Object>> steps) {
        List<Arrow> arrows = new ArrayList<>();
        Set<String> declared = new LinkedHashSet<>();
        if (blankToNull(sut) != null) declared.add(sut.trim());

        List<String> params = entryParams == null ? List.of() : entryParams;
        arrows.add(new Arrow(SYSTEM_CALLER, blankToNull(sut) == null ? "SUT" : sut.trim(),
                "", true, new ArrayList<>(params), "", null,
                "[*] -> " + sut + " : " + (entryMethod == null ? "entry" : entryMethod)
                        + "(" + String.join(", ", params) + ")"));

        for (Map<String, Object> step : steps == null ? List.<Map<String, Object>>of() : steps) {
            if (step == null) continue;
            String caller = text(step.get("caller"));
            String callee = text(step.get("callee"));
            String method = text(step.get("method"));
            if (callee.isEmpty() || method.isEmpty()) continue;   // shape errors are the caller's to report
            declared.add(callee);
            List<String> args = stringArgs(step.get("args"));
            String source = caller + " -> " + callee + " : " + method + "(" + String.join(", ", args) + ")";
            arrows.add(new Arrow(caller, callee, method, true, args, "", null, source));

            String resultName = text(step.get("resultName"));
            if (!resultName.isEmpty()) {
                arrows.add(new Arrow(caller, callee, resultName, false, List.of(),
                        resultName, text(step.get("returns")).isEmpty() ? null : text(step.get("returns")),
                        caller + " <-- " + callee + " : " + resultName));
            }
        }
        return lintFlow(new Flow(declared, arrows, Map.of()));
    }

    /** Only string arguments are bindings. An object here is a signature, which is not a value. */
    private static List<String> stringArgs(Object raw) {
        List<String> out = new ArrayList<>();
        if (raw instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof String s && !s.isBlank()) out.add(s.trim());
            }
        }
        return out;
    }

    private static String text(Object o) {
        return o == null ? "" : o.toString().trim();
    }

    /** The rules. Everything above this line only decides how a {@link Flow} is built. */
    static Report lintFlow(Flow flow) {
        List<String> violations = new ArrayList<>();
        List<String> warnings = new ArrayList<>();
        Set<String> declared = flow.declared();
        List<Arrow> arrows = flow.arrows();

        // --- producers: entry parameters, then every named return value ---
        // Keyed by name; the value records where it became available, so a
        // consumer above its producer is still caught.
        Map<String, Produced> produced = new LinkedHashMap<>();
        for (int i = 0; i < arrows.size(); i++) {
            Arrow a = arrows.get(i);
            if (a.isCall() && SYSTEM_CALLER.equals(a.caller())) {
                for (String arg : a.args()) {
                    String name = rootOf(argName(arg));
                    if (!name.isEmpty()) produced.putIfAbsent(name, new Produced(name, argType(arg), i, a, true));
                }
            } else if (!a.isCall() && !a.involvesSystemCaller()) {
                String name = a.returnName();
                if (name.isEmpty()) continue;
                if (a.returnType() == null && startsUpper(name)) {
                    warnings.add(a.source() + " — return label is a bare type, so nothing downstream can "
                            + "reference this value; the grammar is 'value : Type'");
                }
                produced.putIfAbsent(name, new Produced(name, a.returnType(), i, a, false));
            }
        }

        // --- rule 1: every consumed argument traces to something produced above it ---
        for (int i = 0; i < arrows.size(); i++) {
            Arrow a = arrows.get(i);
            if (!a.isCall() || SYSTEM_CALLER.equals(a.caller())) continue;
            for (String arg : a.args()) {
                String name = argName(arg);
                if (name.isEmpty() || LITERAL.matcher(name).matches()) continue;
                String root = rootOf(name);
                if (declared.contains(root)) continue;          // passing a collaborator/type by name
                Produced p = produced.get(root);
                if (p == null) {
                    violations.add(a.source() + " — nothing in this flow produces '" + root + "'");
                } else if (p.index() >= i) {
                    violations.add(a.source() + " — '" + root + "' is consumed before "
                            + p.arrow().source() + " produces it");
                }
            }
        }

        // --- rule 2: a design-declared value that is fetched and never used ---
        // Restricted to types the design itself declares (strategies, rules,
        // domain entities). A BigDecimal that feeds the returned object is not
        // interesting; a CancellationFeeRule that reaches no call is the
        // severed-variance signature.
        for (Produced p : produced.values()) {
            if (p.fromEntry()) continue;
            String type = p.type();
            if (type == null || !declared.contains(type)) continue;
            if (consumedLater(arrows, p)) continue;
            warnings.add(p.arrow().source() + " — '" + p.name() + "' is produced but never used: no later call "
                    + "passes it, calls it, or returns it");
        }

        // --- rule 3: an accessor called on a reused type must actually exist ---
        checkAccessors(arrows, produced, flow.knownTypes(), violations);

        return new Report(violations, warnings);
    }

    /**
     * Once arguments became real expressions rather than echoes of the callee's
     * parameter list, a design could invoke a method on a type it did not write —
     * observed in half of a set of live runs as {@code visit.hoursUntilVisit()} on
     * a reused {@code Visit} that has only {@code getDate}/{@code getPet}. Rules 1
     * and 2 cannot see it: the root {@code visit} is genuinely in scope. The
     * generated code simply would not compile.
     *
     * <p><b>Only types the scan can see are judged.</b> A type the design is
     * creating has no implementation yet, so it has no method list to check
     * against, and an opinion there would be noise. Silence on unknown types is
     * the point, not a limitation.
     *
     * <p>Scope is one hop and method calls only ({@code root.member(...)}).
     * Multi-hop chains and bare field access resolve through types this rule
     * cannot follow, and a wrong refusal costs more than a missed one.
     */
    private static void checkAccessors(List<Arrow> arrows, Map<String, Produced> produced,
                                       Map<String, Set<String>> knownTypes, List<String> violations) {
        if (knownTypes.isEmpty()) return;
        for (Arrow a : arrows) {
            if (!a.isCall() || SYSTEM_CALLER.equals(a.caller())) continue;
            for (String arg : a.args()) {
                String expr = argName(arg);
                Matcher m = ACCESSOR.matcher(expr);
                if (!m.matches()) continue;
                Produced p = produced.get(m.group(1));
                if (p == null || p.type() == null) continue;
                // A generic type is a container, and the call is against the
                // container's API (`visits.size()`), not the payload's. Unwrapping
                // to the payload and judging against that would refuse correct
                // designs, which costs more than the misses it prevents.
                if (p.type().indexOf('<') >= 0) continue;
                Set<String> methods = knownTypes.get(simpleTypeName(p.type()));
                if (methods == null || methods.isEmpty()) continue;   // not a scanned type
                String member = m.group(2);
                if (!methods.contains(member)) {
                    violations.add(a.source() + " — '" + expr + "' calls " + member + "() on "
                            + simpleTypeName(p.type()) + ", which has no such method. It has: "
                            + String.join(", ", methods));
                }
            }
        }
    }

    /**
     * {@code visit.hoursUntilVisit()} → root {@code visit}, member {@code hoursUntilVisit}.
     * Arguments inside the call are allowed ({@code owner.getPet(petId)}); a second
     * dot is not, because this rule only follows one hop.
     */
    private static final Pattern ACCESSOR =
            Pattern.compile("^([A-Za-z_][\\w]*)\\.([A-Za-z_][\\w]*)\\s*\\([^.]*\\)$");

    /** {@code Optional<Owner>} / {@code com.x.Owner} → {@code Owner}. */
    private static String simpleTypeName(String type) {
        String t = type.trim();
        int lt = t.indexOf('<');
        if (lt >= 0) {
            String inner = t.substring(lt + 1, Math.max(lt + 1, t.lastIndexOf('>')));
            if (!inner.isBlank() && !inner.contains(",")) t = inner.trim();
            else t = t.substring(0, lt).trim();
        }
        int dot = t.lastIndexOf('.');
        return (dot >= 0 ? t.substring(dot + 1) : t).trim();
    }

    /**
     * A produced value counts as used when a later call passes it as an argument,
     * when a later call targets it (the resolver idiom — {@code resolve() : strategy :
     * FeePolicy} followed by {@code -> FeePolicy}), or when the SUT hands it back
     * to the system caller.
     */
    private static boolean consumedLater(List<Arrow> arrows, Produced p) {
        for (int i = p.index() + 1; i < arrows.size(); i++) {
            Arrow a = arrows.get(i);
            if (a.isCall()) {
                if (a.callee().equals(p.name()) || a.callee().equals(p.type())) return true;
                for (String arg : a.args()) {
                    if (rootOf(argName(arg)).equals(p.name())) return true;
                }
            } else if (a.involvesSystemCaller() && a.returnName().equals(p.name())) {
                return true;
            }
        }
        return false;
    }

    /** {@code owner.getPet(petId)} → {@code owner}; the root is what must exist. */
    private static String rootOf(String expr) {
        int dot = expr.indexOf('.');
        String root = dot < 0 ? expr : expr.substring(0, dot);
        int paren = root.indexOf('(');
        return (paren < 0 ? root : root.substring(0, paren)).strip();
    }

    /** {@code ownerId: Integer} → {@code ownerId}; the wizard types its args, the derived slice does not. */
    private static String argName(String arg) {
        int colon = arg.indexOf(':');
        return (colon < 0 ? arg : arg.substring(0, colon)).strip();
    }

    private static String argType(String arg) {
        int colon = arg.indexOf(':');
        return colon < 0 ? null : blankToNull(arg.substring(colon + 1));
    }

    private static boolean startsUpper(String s) {
        return !s.isEmpty() && Character.isUpperCase(s.charAt(0));
    }

    private static String blankToNull(String s) {
        String t = s == null ? "" : s.strip();
        return t.isEmpty() ? null : t;
    }

    private record Produced(String name, String type, int index, Arrow arrow, boolean fromEntry) {
    }

    /**
     * One interaction line. Call vs return is decided by the label shape — a call
     * carries a method signature with parentheses, a return carries a value — which
     * is how {@code SKILL.md} defines it and is more robust than the arrow glyph
     * (the final return is written both {@code [*] <-- SUT} and {@code SUT --> [*]}).
     */
    private record Arrow(String caller, String callee, String label, boolean isCall,
                         List<String> args, String returnName, String returnType, String source) {

        static Arrow of(String left, String glyph, String right, String label, String source) {
            // "<--" / "<-" reverse the reading direction: the right lifeline is the sender.
            boolean rightIsSender = glyph.startsWith("<");
            String sender = rightIsSender ? right : left;
            String receiver = rightIsSender ? left : right;
            int open = label.indexOf('(');
            if (open >= 0 && label.lastIndexOf(')') > open) {
                // A call: the sender is the caller, the receiver is the callee.
                return new Arrow(sender, receiver, label, true,
                        splitArgs(label.substring(open + 1, label.lastIndexOf(')'))), "", null, source);
            }
            // A return: the value travels from the callee (sender) back to the caller.
            int colon = label.indexOf(':');
            String name = (colon < 0 ? label : label.substring(0, colon)).strip();
            String type = colon < 0 ? null : blankToNull(label.substring(colon + 1));
            return new Arrow(receiver, sender, label, false, List.of(), name, type, source);
        }

        boolean involvesSystemCaller() {
            return SYSTEM_CALLER.equals(caller) || SYSTEM_CALLER.equals(callee);
        }

        /** Split on top-level commas so {@code owner.getPet(petId), fee} stays two arguments. */
        static List<String> splitArgs(String inside) {
            List<String> out = new ArrayList<>();
            int depth = 0;
            StringBuilder cur = new StringBuilder();
            for (char c : inside.toCharArray()) {
                if (c == '(' || c == '<') depth++;
                else if (c == ')' || c == '>') depth--;
                if (c == ',' && depth == 0) {
                    addIfPresent(out, cur.toString());
                    cur.setLength(0);
                    continue;
                }
                cur.append(c);
            }
            addIfPresent(out, cur.toString());
            return out;
        }

        private static void addIfPresent(List<String> out, String s) {
            String t = s.strip();
            if (!t.isEmpty()) out.add(t);
        }
    }
}
