package com.designiscode.app.service;

import com.designiscode.app.dto.DerivedSlice;
import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.EnumDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.AssignExpr;
import com.github.javaparser.ast.expr.ConditionalExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.LambdaExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.NormalAnnotationExpr;
import com.github.javaparser.ast.expr.SingleMemberAnnotationExpr;
import com.github.javaparser.ast.expr.SwitchExpr;
import com.github.javaparser.ast.expr.ThisExpr;
import com.github.javaparser.ast.nodeTypes.NodeWithAnnotations;
import com.github.javaparser.ast.stmt.DoStmt;
import com.github.javaparser.ast.stmt.ForEachStmt;
import com.github.javaparser.ast.stmt.ForStmt;
import com.github.javaparser.ast.stmt.IfStmt;
import com.github.javaparser.ast.stmt.SwitchStmt;
import com.github.javaparser.ast.stmt.TryStmt;
import com.github.javaparser.ast.stmt.WhileStmt;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * Stage A of the code→design diff pipeline. Derives a {@link DerivedSlice} —
 * the call sites, collaborator wiring, and config-loading anchor of one
 * entry method — from the user-provided source files.
 *
 * <p>Deliberately <b>lexical and scoped</b>: receiver types are resolved
 * against names declared in the provided sources (fields, constructor params,
 * method params, locals), not via a full symbol solver with the project's
 * classpath. This bounds derivation to "the related files the user provided"
 * (the agreed Stage A scope) and keeps it a fast, deterministic, unit-testable
 * transform with no model calls. Calls whose receiver cannot be resolved this
 * way (chained or static calls) are recorded with {@code calleeType == null}.
 *
 * <p>Sibling of {@link ScanService}: same JavaParser configuration, but it
 * walks method <i>bodies</i> (which ScanService never does) to recover the
 * call graph.
 */
@Service
public class CallGraphDeriver {

    private final JavaParser parser = new JavaParser(
            new ParserConfiguration()
                    .setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21));

    /** A provided type's identity, used to classify and resolve receivers. */
    private record TypeInfo(String name, String fqn, String kind, List<String> implementsTypes,
                            List<DerivedSlice.MethodSig> methods) {}

    /**
     * @param sources     Java source file contents (the user's "related files")
     * @param entryClass  simple name of the system-under-test class
     * @param entryMethod method name on {@code entryClass} to derive from
     * @throws IllegalArgumentException if the class or method is not found
     */
    public DerivedSlice derive(List<String> sources, String entryClass, String entryMethod) {
        List<CompilationUnit> units = new ArrayList<>();
        for (String src : sources) {
            if (src == null || src.isBlank()) continue;
            ParseResult<CompilationUnit> r = parser.parse(src);
            if (r.isSuccessful() && r.getResult().isPresent()) units.add(r.getResult().get());
        }

        Map<String, TypeInfo> typeIndex = buildTypeIndex(units);

        // The entry name may denote an interface whose behavior lives in an
        // implementing class (DisC's own generated code is interface + impl).
        // Resolve to a declaration whose entry method HAS A BODY: first a
        // class implementing `entryClass`, then a bodied class named
        // `entryClass`, and only as a last resort the bodiless declaration —
        // a name-only match would derive an empty (misleading) slice.
        List<ClassOrInterfaceDeclaration> named = units.stream()
                .flatMap(u -> u.findAll(ClassOrInterfaceDeclaration.class).stream())
                .filter(c -> c.getNameAsString().equals(entryClass))
                .toList();
        if (named.isEmpty()) {
            throw new IllegalArgumentException("entry class not found in provided sources: " + entryClass);
        }
        List<ClassOrInterfaceDeclaration> implementors = units.stream()
                .flatMap(u -> u.findAll(ClassOrInterfaceDeclaration.class).stream())
                .filter(c -> !c.isInterface())
                .filter(c -> c.getImplementedTypes().stream()
                        .anyMatch(t -> t.getNameAsString().equals(entryClass)))
                .filter(c -> bodiedMethod(c, entryMethod).isPresent())
                .sorted(java.util.Comparator
                        .comparing((ClassOrInterfaceDeclaration c) ->
                                c.getNameAsString().contains(entryClass) ? 0 : 1)
                        .thenComparing(ClassOrInterfaceDeclaration::getNameAsString))
                .toList();
        List<String> resolutionNotes = new ArrayList<>();

        ClassOrInterfaceDeclaration sut = named.stream()
                .filter(c -> bodiedMethod(c, entryMethod).isPresent())
                .findFirst()
                .orElse(null);
        if (sut == null && !implementors.isEmpty()) {
            sut = implementors.get(0);
            if (implementors.size() > 1) {
                resolutionNotes.add("multiple implementations of " + entryClass + " ("
                        + implementors.stream().map(ClassOrInterfaceDeclaration::getNameAsString)
                                .collect(java.util.stream.Collectors.joining(", "))
                        + ") — derived from " + sut.getNameAsString());
            }
        }
        if (sut == null) sut = named.get(0); // bodiless fallback: honest empty slice

        MethodDeclaration entry = sut.getMethods().stream()
                .filter(m -> m.getNameAsString().equals(entryMethod))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException(
                        "entry method '" + entryMethod + "' not found on " + entryClass));

        DerivedSlice.MethodSig entrySig = new DerivedSlice.MethodSig(
                entry.getNameAsString(),
                entry.getParameters().stream()
                        .map(p -> new DerivedSlice.Param(p.getNameAsString(), p.getType().asString()))
                        .toList(),
                entry.getType().asString());

        List<DerivedSlice.Dependency> deps = collectDependencies(sut);
        Map<String, String> scope = buildScope(sut, entry);
        List<DerivedSlice.CallSite> callSites = collectCallSites(entry, scope, typeIndex);
        List<String> captureGaps = new ArrayList<>(resolutionNotes);
        captureGaps.addAll(detectCaptureGaps(entry));

        boolean orchestrator = callSites.stream()
                .anyMatch(cs -> "interface".equals(cs.calleeKind()) || "class".equals(cs.calleeKind()));

        List<DerivedSlice.ConfigFact> configFacts = collectConfigFacts(units);

        String targetPackage = sut.findCompilationUnit()
                .flatMap(CompilationUnit::getPackageDeclaration)
                .map(pd -> pd.getNameAsString())
                .orElse("");
        List<DerivedSlice.TypeRef> knownTypes = typeIndex.values().stream()
                .map(t -> new DerivedSlice.TypeRef(t.name(), t.fqn(), t.kind()))
                .toList();

        return new DerivedSlice(entryClass, entrySig, orchestrator, callSites, deps, configFacts,
                targetPackage, knownTypes, captureGaps);
    }

    /** The named method WITH an implementation body (absent on interfaces/abstract). */
    private static Optional<MethodDeclaration> bodiedMethod(ClassOrInterfaceDeclaration c, String name) {
        return c.getMethods().stream()
                .filter(m -> m.getNameAsString().equals(name))
                .filter(m -> m.getBody().isPresent())
                .findFirst();
    }

    // --- type index ---

    private Map<String, TypeInfo> buildTypeIndex(List<CompilationUnit> units) {
        Map<String, TypeInfo> index = new LinkedHashMap<>();
        for (CompilationUnit u : units) {
            String pkg = u.getPackageDeclaration().map(pd -> pd.getNameAsString()).orElse("");
            for (ClassOrInterfaceDeclaration c : u.findAll(ClassOrInterfaceDeclaration.class)) {
                String n = c.getNameAsString();
                index.put(n, new TypeInfo(n, fqn(pkg, n),
                        c.isInterface() ? "interface" : "class",
                        c.getImplementedTypes().stream().map(t -> simpleType(t.getNameAsString())).toList(),
                        methodsOf(c.getMethods())));
            }
            for (RecordDeclaration r : u.findAll(RecordDeclaration.class)) {
                String n = r.getNameAsString();
                index.put(n, new TypeInfo(n, fqn(pkg, n), "record",
                        r.getImplementedTypes().stream().map(t -> simpleType(t.getNameAsString())).toList(),
                        methodsOf(r.getMethods())));
            }
            for (EnumDeclaration e : u.findAll(EnumDeclaration.class)) {
                String n = e.getNameAsString();
                index.put(n, new TypeInfo(n, fqn(pkg, n), "enum", List.of(), List.of()));
            }
        }
        return index;
    }

    private static List<DerivedSlice.MethodSig> methodsOf(List<MethodDeclaration> methods) {
        return methods.stream()
                .map(m -> new DerivedSlice.MethodSig(
                        m.getNameAsString(),
                        m.getParameters().stream()
                                .map(p -> new DerivedSlice.Param(p.getNameAsString(), p.getType().asString()))
                                .toList(),
                        m.getType().asString()))
                .toList();
    }

    private static String fqn(String pkg, String name) {
        return pkg.isEmpty() ? name : pkg + "." + name;
    }

    // --- wiring ---

    private List<DerivedSlice.Dependency> collectDependencies(ClassOrInterfaceDeclaration sut) {
        List<DerivedSlice.Dependency> deps = new ArrayList<>();
        pickConstructor(sut).ifPresent(ctor -> ctor.getParameters().forEach(p ->
                deps.add(new DerivedSlice.Dependency(
                        p.getNameAsString(), p.getType().asString(), "constructor", qualifierOf(p)))));
        for (FieldDeclaration f : sut.getFields()) {
            if (f.getAnnotationByName("Autowired").isPresent() || f.getAnnotationByName("Inject").isPresent()) {
                String q = qualifierOf(f);
                f.getVariables().forEach(v -> deps.add(new DerivedSlice.Dependency(
                        v.getNameAsString(), v.getTypeAsString(), "field", q)));
            }
        }
        // Lombok wiring: @AllArgsConstructor/@RequiredArgsConstructor generate the
        // constructor at compile time, so the source has none — the fields ARE the
        // constructor parameters (all non-static, or the final ones respectively).
        boolean lombokAll = sut.getAnnotationByName("AllArgsConstructor").isPresent();
        boolean lombokRequired = sut.getAnnotationByName("RequiredArgsConstructor").isPresent();
        if (deps.isEmpty() && (lombokAll || lombokRequired)) {
            for (FieldDeclaration f : sut.getFields()) {
                if (f.isStatic()) continue;
                if (lombokRequired && !lombokAll && !f.isFinal()) continue;
                String q = qualifierOf(f);
                f.getVariables().forEach(v -> deps.add(new DerivedSlice.Dependency(
                        v.getNameAsString(), v.getTypeAsString(), "constructor", q)));
            }
        }
        return deps;
    }

    /** Spring injects the @Autowired constructor, else the single/widest constructor. */
    private Optional<ConstructorDeclaration> pickConstructor(ClassOrInterfaceDeclaration sut) {
        List<ConstructorDeclaration> ctors = sut.getConstructors();
        Optional<ConstructorDeclaration> annotated = ctors.stream()
                .filter(c -> c.getAnnotationByName("Autowired").isPresent())
                .findFirst();
        if (annotated.isPresent()) return annotated;
        return ctors.stream()
                .filter(c -> c.getParameters().isNonEmpty())
                .max(Comparator.comparingInt(c -> c.getParameters().size()));
    }

    // --- receiver type resolution ---

    /** name → declared type, with Java shadowing: fields < ctor params < method params < locals. */
    private Map<String, String> buildScope(ClassOrInterfaceDeclaration sut, MethodDeclaration entry) {
        Map<String, String> scope = new HashMap<>();
        for (FieldDeclaration f : sut.getFields()) {
            f.getVariables().forEach(v -> scope.put(v.getNameAsString(), v.getTypeAsString()));
        }
        pickConstructor(sut).ifPresent(ctor -> ctor.getParameters()
                .forEach(p -> scope.putIfAbsent(p.getNameAsString(), p.getType().asString())));
        entry.getParameters().forEach(p -> scope.put(p.getNameAsString(), p.getType().asString()));
        entry.findAll(VariableDeclarator.class)
                .forEach(v -> scope.put(v.getNameAsString(), v.getTypeAsString()));
        return scope;
    }

    private List<DerivedSlice.CallSite> collectCallSites(MethodDeclaration entry,
                                                         Map<String, String> scope,
                                                         Map<String, TypeInfo> typeIndex) {
        List<DerivedSlice.CallSite> sites = new ArrayList<>();
        for (MethodCallExpr call : entry.findAll(MethodCallExpr.class)) {
            String receiver = receiverName(call.getScope().orElse(null));
            if (receiver == null) continue;  // unqualified self-call, or chained/complex receiver
            String calleeType = scope.get(receiver);
            String kind = "unknown";
            List<String> impls = List.of();
            DerivedSlice.MethodSig calleeMethodSig = null;
            if (calleeType != null) {
                String simple = simpleType(calleeType);
                TypeInfo ti = typeIndex.get(simple);
                if (ti != null) {
                    kind = ti.kind();
                    impls = implementationsOf(simple, typeIndex);
                    calleeMethodSig = ti.methods().stream()
                            .filter(m -> m.name().equals(call.getNameAsString()))
                            .findFirst().orElse(null);
                }
            }
            List<String> args = call.getArguments().stream().map(Object::toString).toList();
            sites.add(new DerivedSlice.CallSite(receiver, calleeType, kind, impls,
                    call.getNameAsString(), args, calleeMethodSig, resultNameOf(call)));
        }
        return sites;
    }

    /** The receiver variable name for a call: a bare name, or {@code this.field}. */
    private String receiverName(Expression scope) {
        if (scope instanceof NameExpr n) return n.getNameAsString();
        if (scope instanceof FieldAccessExpr fa && fa.getScope() instanceof ThisExpr) {
            return fa.getNameAsString();
        }
        return null;
    }

    /** The local a call's result is bound to — the return-arrow label — or null (void/expr call). */
    private String resultNameOf(MethodCallExpr call) {
        Node parent = call.getParentNode().orElse(null);
        if (parent instanceof VariableDeclarator vd) return vd.getNameAsString();
        if (parent instanceof AssignExpr ae && ae.getTarget() instanceof NameExpr n) return n.getNameAsString();
        return null;
    }

    // --- REGEN completeness ---

    /**
     * Constructs in the entry body that a flat, linear call list cannot faithfully
     * represent — the reasons an orchestrator's design would be <i>incomplete</i>,
     * so it must not be regenerated wholesale (an omitted call is dropped from the
     * regenerated body). Empty ⇒ {@link DerivedSlice#captureComplete()}.
     *
     * <p>Two families: (1) control flow / lambdas, which the linear
     * resolve→dispatch shape flattens; (2) calls we could not attribute to a
     * provided collaborator — an unqualified self-call (private helper logic we
     * cannot see) or a chained/static receiver.
     */
    private List<String> detectCaptureGaps(MethodDeclaration entry) {
        List<String> gaps = new ArrayList<>();
        if (!entry.findAll(IfStmt.class).isEmpty() || !entry.findAll(ConditionalExpr.class).isEmpty()) {
            gaps.add("a branch (if / ternary) in the entry body");
        }
        if (!entry.findAll(ForStmt.class).isEmpty() || !entry.findAll(ForEachStmt.class).isEmpty()
                || !entry.findAll(WhileStmt.class).isEmpty() || !entry.findAll(DoStmt.class).isEmpty()) {
            gaps.add("a loop in the entry body");
        }
        if (!entry.findAll(SwitchStmt.class).isEmpty() || !entry.findAll(SwitchExpr.class).isEmpty()) {
            gaps.add("a switch in the entry body");
        }
        if (!entry.findAll(TryStmt.class).isEmpty()) gaps.add("a try/catch in the entry body");
        if (!entry.findAll(LambdaExpr.class).isEmpty()) gaps.add("a lambda in the entry body");
        for (MethodCallExpr call : entry.findAll(MethodCallExpr.class)) {
            if (receiverName(call.getScope().orElse(null)) == null) {
                gaps.add("an unattributable call: " + call + " (self, chained, or static receiver)");
            }
        }
        return gaps;
    }

    private List<String> implementationsOf(String iface, Map<String, TypeInfo> typeIndex) {
        return typeIndex.values().stream()
                .filter(t -> "class".equals(t.kind()) && t.implementsTypes().contains(iface))
                .map(TypeInfo::name)
                .sorted()
                .toList();
    }

    // --- config-loading anchor ---

    private List<DerivedSlice.ConfigFact> collectConfigFacts(List<CompilationUnit> units) {
        List<DerivedSlice.ConfigFact> facts = new ArrayList<>();
        for (CompilationUnit u : units) {
            for (ClassOrInterfaceDeclaration c : u.findAll(ClassOrInterfaceDeclaration.class)) {
                String tn = c.getNameAsString();
                c.getAnnotationByName("ConditionalOnProperty").ifPresent(a ->
                        facts.add(new DerivedSlice.ConfigFact(tn, "conditional-on-property", annoValue(a))));
                c.getAnnotationByName("Profile").ifPresent(a ->
                        facts.add(new DerivedSlice.ConfigFact(tn, "profile", annoValue(a))));
                for (FieldDeclaration f : c.getFields()) {
                    f.getAnnotationByName("Value").ifPresent(a -> {
                        String fn = f.getVariables().isNonEmpty() ? f.getVariable(0).getNameAsString() : "";
                        facts.add(new DerivedSlice.ConfigFact(tn, "value-field", (fn + " " + annoValue(a)).trim()));
                    });
                }
                for (MethodDeclaration m : c.getMethods()) {
                    if (m.getAnnotationByName("Bean").isEmpty()) continue;
                    StringBuilder detail = new StringBuilder("@Bean " + m.getNameAsString());
                    m.getAnnotationByName("ConditionalOnProperty")
                            .ifPresent(a -> detail.append(" conditional:").append(annoValue(a)));
                    m.getAnnotationByName("Profile")
                            .ifPresent(a -> detail.append(" profile:").append(annoValue(a)));
                    facts.add(new DerivedSlice.ConfigFact(
                            simpleType(m.getType().asString()), "bean-method", detail.toString()));
                }
            }
        }
        return facts;
    }

    // --- small helpers ---

    private String qualifierOf(NodeWithAnnotations<?> node) {
        return node.getAnnotationByName("Qualifier").map(CallGraphDeriver::annoValue).orElse(null);
    }

    /** Strip generics and package: {@code java.util.List<Order>} → {@code List}. */
    static String simpleType(String type) {
        if (type == null) return null;
        int lt = type.indexOf('<');
        if (lt >= 0) type = type.substring(0, lt);
        int dot = type.lastIndexOf('.');
        if (dot >= 0) type = type.substring(dot + 1);
        return type.trim();
    }

    /** Render an annotation's arguments to a flat string, quotes stripped. */
    static String annoValue(AnnotationExpr a) {
        if (a instanceof SingleMemberAnnotationExpr s) {
            return s.getMemberValue().toString().replace("\"", "");
        }
        if (a instanceof NormalAnnotationExpr n) {
            return n.getPairs().stream()
                    .map(p -> p.getNameAsString() + "=" + p.getValue().toString().replace("\"", ""))
                    .collect(Collectors.joining(", "));
        }
        return "";
    }
}
