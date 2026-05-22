package com.designiscode.app.service;

import com.designiscode.app.dto.ScanCatalog;
import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Modifier;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.EnumDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.MemberValuePair;
import com.github.javaparser.ast.expr.NormalAnnotationExpr;
import com.github.javaparser.ast.expr.SingleMemberAnnotationExpr;
import com.github.javaparser.ast.nodeTypes.NodeWithAnnotations;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.javadoc.Javadoc;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Walks a Java/Spring project under {@code src/main/java} with JavaParser
 * and produces a {@link ScanCatalog} — a structured snapshot of the
 * public surface (types, signatures, annotations, Javadoc) enriched with
 * role inference (entity / repository / service / etc.), package roster,
 * domain glossary, and detected naming conventions.
 *
 * <p>The catalog is consumed by the AI analyser to ground proposed
 * abstractions in the user's existing code. It's also flat enough to
 * feed the Step 2 autocomplete <datalist> in the frontend.
 */
@Service
public class ScanService {

    private static final Set<String> SPRING_STEREOTYPES = Set.of(
            "Service", "Component", "Controller", "RestController",
            "Repository", "Configuration", "ControllerAdvice",
            "RestControllerAdvice", "SpringBootApplication"
    );

    private static final Set<String> DTO_NAME_SUFFIXES = Set.of(
            "Request", "Response", "Dto", "DTO", "View", "Payload"
    );

    private final JavaParser parser = new JavaParser(
            new ParserConfiguration()
                    .setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21)
    );

    public ScanCatalog scan(String pathStr) {
        if (pathStr == null || pathStr.isBlank()) {
            throw new IllegalArgumentException("Path is required");
        }

        Path root = Paths.get(pathStr).toAbsolutePath().normalize();
        if (!Files.exists(root)) {
            throw new IllegalArgumentException("Path does not exist: " + root);
        }
        if (!Files.isDirectory(root)) {
            throw new IllegalArgumentException("Path is not a directory: " + root);
        }

        List<ScanCatalog.TypeRecord> types = new ArrayList<>();
        int fileCount = 0;
        int skippedCount = 0;

        try (Stream<Path> paths = Files.walk(root)) {
            List<Path> javaFiles = paths
                    .filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().endsWith(".java"))
                    .filter(p -> isUnderMainJava(root, p))
                    .toList();

            for (Path file : javaFiles) {
                fileCount++;
                try {
                    ParseResult<CompilationUnit> result = parser.parse(file);
                    if (!result.isSuccessful() || result.getResult().isEmpty()) {
                        skippedCount++;
                        continue;
                    }
                    CompilationUnit cu = result.getResult().get();
                    String pkg = cu.getPackageDeclaration()
                            .map(pd -> pd.getNameAsString())
                            .orElse("");

                    cu.findAll(ClassOrInterfaceDeclaration.class).forEach(decl -> {
                        if (!decl.isPublic() && !decl.getModifiers().isEmpty()) return;
                        types.add(buildClassOrInterface(decl, pkg));
                    });
                    cu.findAll(RecordDeclaration.class).forEach(decl -> {
                        types.add(buildRecord(decl, pkg));
                    });
                    cu.findAll(EnumDeclaration.class).forEach(decl -> {
                        types.add(buildEnum(decl, pkg));
                    });
                } catch (Exception e) {
                    skippedCount++;
                }
            }
        } catch (IOException e) {
            throw new RuntimeException("Failed to walk path: " + root, e);
        }

        types.sort(Comparator.comparing(ScanCatalog.TypeRecord::fqn, String.CASE_INSENSITIVE_ORDER));

        List<ScanCatalog.PackageRecord> packages = computePackages(types);
        List<ScanCatalog.GlossaryEntry> glossary = computeGlossary(types);
        ScanCatalog.Conventions conventions = computeConventions(types);

        return new ScanCatalog(
                root.toString(),
                fileCount,
                skippedCount,
                packages,
                types,
                glossary,
                conventions
        );
    }

    // --- builders ---

    private ScanCatalog.TypeRecord buildClassOrInterface(ClassOrInterfaceDeclaration decl, String pkg) {
        String name = decl.getNameAsString();
        String fqn = pkg.isEmpty() ? name : pkg + "." + name;
        String kind = decl.isInterface() ? "interface" : "class";

        List<String> annotations = renderAnnotations(decl);
        String purpose = firstJavadocSentence(decl.getJavadoc().orElse(null));
        String extendsType = decl.getExtendedTypes().isNonEmpty()
                ? decl.getExtendedTypes(0).getNameAsString()
                : null;
        List<String> implementsTypes = decl.getImplementedTypes().stream()
                .map(ClassOrInterfaceType::getNameAsString)
                .toList();

        List<ScanCatalog.MethodRecord> methods = decl.getMethods().stream()
                .filter(m -> decl.isInterface() || isPublic(m))
                .map(this::buildMethod)
                .toList();

        // Fields only meaningful for entities/value objects; skip for plain services.
        String role = inferClassRole(decl, name, annotations);
        List<ScanCatalog.FieldRecord> fields = isFieldBearingRole(role)
                ? decl.getFields().stream()
                    .filter(f -> isPublic(f) || hasJpaFieldAnnotation(f))
                    .flatMap(f -> f.getVariables().stream()
                            .map(v -> new ScanCatalog.FieldRecord(v.getNameAsString(), v.getTypeAsString())))
                    .toList()
                : List.of();

        return new ScanCatalog.TypeRecord(
                fqn, name, pkg, kind, role,
                annotations, extendsType, implementsTypes,
                purpose, methods, fields
        );
    }

    private ScanCatalog.TypeRecord buildRecord(RecordDeclaration decl, String pkg) {
        String name = decl.getNameAsString();
        String fqn = pkg.isEmpty() ? name : pkg + "." + name;

        List<String> annotations = renderAnnotations(decl);
        String purpose = firstJavadocSentence(decl.getJavadoc().orElse(null));
        List<String> implementsTypes = decl.getImplementedTypes().stream()
                .map(ClassOrInterfaceType::getNameAsString)
                .toList();

        // Record components are the canonical "fields".
        List<ScanCatalog.FieldRecord> fields = decl.getParameters().stream()
                .map(p -> new ScanCatalog.FieldRecord(p.getNameAsString(), p.getTypeAsString()))
                .toList();

        // Records often have additional methods (factory, validation, derived data).
        List<ScanCatalog.MethodRecord> methods = decl.getMethods().stream()
                .filter(this::isPublic)
                .map(this::buildMethod)
                .toList();

        String role = inferRecordRole(name, annotations, fields);

        return new ScanCatalog.TypeRecord(
                fqn, name, pkg, "record", role,
                annotations, null, implementsTypes,
                purpose, methods, fields
        );
    }

    private ScanCatalog.TypeRecord buildEnum(EnumDeclaration decl, String pkg) {
        String name = decl.getNameAsString();
        String fqn = pkg.isEmpty() ? name : pkg + "." + name;

        List<String> annotations = renderAnnotations(decl);
        String purpose = firstJavadocSentence(decl.getJavadoc().orElse(null));
        List<String> implementsTypes = decl.getImplementedTypes().stream()
                .map(ClassOrInterfaceType::getNameAsString)
                .toList();

        // Enum constants surface as "fields" — they're the vocabulary the enum encodes.
        List<ScanCatalog.FieldRecord> fields = decl.getEntries().stream()
                .map(e -> new ScanCatalog.FieldRecord(e.getNameAsString(), name))
                .toList();

        return new ScanCatalog.TypeRecord(
                fqn, name, pkg, "enum", "enum",
                annotations, null, implementsTypes,
                purpose, List.of(), fields
        );
    }

    private ScanCatalog.MethodRecord buildMethod(MethodDeclaration m) {
        String name = m.getNameAsString();
        List<ScanCatalog.FieldRecord> params = m.getParameters().stream()
                .map(p -> new ScanCatalog.FieldRecord(p.getNameAsString(), p.getType().asString()))
                .toList();
        String returns = m.getType().asString();
        String paramsRendered = params.stream()
                .map(p -> p.name() + ": " + p.type())
                .collect(Collectors.joining(", "));
        String signature = name + "(" + paramsRendered + ") -> " + returns;
        String purpose = firstJavadocSentence(m.getJavadoc().orElse(null));
        return new ScanCatalog.MethodRecord(name, signature, params, returns, purpose);
    }

    // --- role inference ---

    private String inferClassRole(ClassOrInterfaceDeclaration decl, String name, List<String> annotations) {
        if (hasSimpleAnnotation(annotations, "Entity")) return "entity";
        if (hasSimpleAnnotation(annotations, "Repository") || (decl.isInterface() && name.endsWith("Repository"))) return "repository";
        if (hasSimpleAnnotation(annotations, "Service")) return "service";
        if (hasSimpleAnnotation(annotations, "RestController") || hasSimpleAnnotation(annotations, "ControllerAdvice")
                || hasSimpleAnnotation(annotations, "RestControllerAdvice") || hasSimpleAnnotation(annotations, "Controller")) return "controller";
        if (hasSimpleAnnotation(annotations, "Configuration") || hasSimpleAnnotation(annotations, "SpringBootApplication")) return "config";
        if (hasSimpleAnnotation(annotations, "Component")) return "service";  // generic Spring component → service-ish
        if (extendsExceptionType(decl)) return "exception";
        for (String suffix : DTO_NAME_SUFFIXES) {
            if (name.endsWith(suffix)) return "dto";
        }
        if (name.endsWith("Mapper") || name.endsWith("Converter")) return "mapper";
        return "other";
    }

    private String inferRecordRole(String name, List<String> annotations, List<ScanCatalog.FieldRecord> fields) {
        if (hasSimpleAnnotation(annotations, "Entity")) return "entity";
        for (String suffix : DTO_NAME_SUFFIXES) {
            if (name.endsWith(suffix)) return "dto";
        }
        // Single-field wrapper around a primitive-ish type → domain primitive (e.g. record OrderId(UUID value)).
        if (fields.size() == 1) return "domain-primitive";
        return "value-object";
    }

    private boolean extendsExceptionType(ClassOrInterfaceDeclaration decl) {
        if (decl.isInterface()) return false;
        return decl.getExtendedTypes().stream().anyMatch(t -> {
            String n = t.getNameAsString();
            return n.endsWith("Exception") || n.endsWith("Error") || n.equals("Throwable");
        });
    }

    private boolean isFieldBearingRole(String role) {
        return role.equals("entity") || role.equals("dto") || role.equals("value-object") || role.equals("domain-primitive");
    }

    // --- annotations / javadoc helpers ---

    private List<String> renderAnnotations(NodeWithAnnotations<?> node) {
        return node.getAnnotations().stream()
                .map(this::renderAnnotation)
                .toList();
    }

    private String renderAnnotation(AnnotationExpr a) {
        String name = "@" + simpleName(a.getNameAsString());
        if (a instanceof SingleMemberAnnotationExpr s) {
            String value = s.getMemberValue().toString().replace("\"", "");
            return name + "(" + value + ")";
        }
        if (a instanceof NormalAnnotationExpr n && !n.getPairs().isEmpty()) {
            String pairs = n.getPairs().stream()
                    .map(this::renderPair)
                    .limit(3)  // cap noise for annotations with many attributes
                    .collect(Collectors.joining(", "));
            return name + "(" + pairs + ")";
        }
        return name;
    }

    private String renderPair(MemberValuePair p) {
        String v = p.getValue().toString().replace("\"", "");
        return p.getNameAsString() + "=" + v;
    }

    private boolean hasSimpleAnnotation(List<String> annotations, String simpleName) {
        String marker = "@" + simpleName;
        return annotations.stream().anyMatch(a -> a.equals(marker) || a.startsWith(marker + "("));
    }

    private boolean hasJpaFieldAnnotation(NodeWithAnnotations<?> node) {
        return node.getAnnotations().stream().anyMatch(a -> {
            String n = simpleName(a.getNameAsString());
            return n.equals("Id") || n.equals("Column") || n.equals("EmbeddedId")
                    || n.equals("OneToMany") || n.equals("ManyToOne") || n.equals("OneToOne") || n.equals("ManyToMany");
        });
    }

    private String firstJavadocSentence(Javadoc doc) {
        if (doc == null) return "";
        String text = doc.getDescription().toText().trim();
        if (text.isEmpty()) return "";
        // Strip inline HTML tags Javadoc allows (<code>, <p>, <br>, <a>, etc.) so the
        // raw text reads cleanly when rendered by the frontend (which escapes < and >).
        text = text.replaceAll("<[^>]+>", "");
        // First sentence — up to first period that ends a sentence, else first 140 chars.
        int dot = text.indexOf('.');
        String first = (dot > 0) ? text.substring(0, dot + 1) : text;
        first = first.replaceAll("\\s+", " ").trim();
        if (first.length() > 140) first = first.substring(0, 140) + "…";
        return first;
    }

    private boolean isPublic(MethodDeclaration m) {
        return m.getModifiers().stream().anyMatch(mod -> mod.getKeyword() == Modifier.Keyword.PUBLIC)
                || m.getModifiers().isEmpty();  // package-private treated as public for interface methods
    }

    private boolean isPublic(FieldDeclaration f) {
        return f.getModifiers().stream().anyMatch(mod -> mod.getKeyword() == Modifier.Keyword.PUBLIC);
    }

    private String simpleName(String n) {
        int lastDot = n.lastIndexOf('.');
        return lastDot >= 0 ? n.substring(lastDot + 1) : n;
    }

    private boolean isUnderMainJava(Path root, Path file) {
        Path rel = root.relativize(file);
        int count = rel.getNameCount();
        for (int i = 0; i <= count - 4; i++) {
            if (rel.getName(i).toString().equals("src")
                    && rel.getName(i + 1).toString().equals("main")
                    && rel.getName(i + 2).toString().equals("java")) {
                return true;
            }
        }
        return false;
    }

    // --- aggregate computations ---

    private List<ScanCatalog.PackageRecord> computePackages(List<ScanCatalog.TypeRecord> types) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (var t : types) counts.merge(t.pkg(), 1, Integer::sum);
        return counts.entrySet().stream()
                .map(e -> new ScanCatalog.PackageRecord(e.getKey(), e.getValue()))
                .sorted(Comparator.comparing(ScanCatalog.PackageRecord::name, String.CASE_INSENSITIVE_ORDER))
                .toList();
    }

    private List<ScanCatalog.GlossaryEntry> computeGlossary(List<ScanCatalog.TypeRecord> types) {
        // The glossary is the domain vocabulary: entities, value objects, domain primitives, records.
        // We deliberately exclude controllers/configs/exceptions — those are infrastructure, not domain.
        Set<String> domainRoles = Set.of("entity", "value-object", "domain-primitive", "enum");
        return types.stream()
                .filter(t -> domainRoles.contains(t.role()))
                .map(t -> new ScanCatalog.GlossaryEntry(t.name(), t.role(), t.fqn()))
                .toList();
    }

    private ScanCatalog.Conventions computeConventions(List<ScanCatalog.TypeRecord> types) {
        // Interface ↔ impl pairing: detect if a majority of `*Impl` classes have a matching interface.
        long implCount = types.stream().filter(t -> t.kind().equals("class") && t.name().endsWith("Impl")).count();
        long pairedImpls = types.stream()
                .filter(t -> t.kind().equals("class") && t.name().endsWith("Impl"))
                .filter(impl -> {
                    String ifaceName = impl.name().substring(0, impl.name().length() - 4);
                    return types.stream().anyMatch(t -> t.kind().equals("interface") && t.name().equals(ifaceName));
                })
                .count();
        String pattern = (implCount >= 3 && pairedImpls * 2 >= implCount) ? "*Impl" : null;

        long recordCount = types.stream().filter(t -> t.kind().equals("record")).count();
        String recordUsage = (recordCount >= Math.max(3, types.size() / 10)) ? "common" : "rare";

        List<String> primaryStereotypes = types.stream()
                .flatMap(t -> t.annotations().stream())
                .filter(a -> {
                    String simple = a.startsWith("@") ? a.substring(1).split("\\(")[0] : a;
                    return SPRING_STEREOTYPES.contains(simple);
                })
                .collect(Collectors.groupingBy(a -> a.split("\\(")[0], LinkedHashMap::new, Collectors.counting()))
                .entrySet().stream()
                .sorted(Map.Entry.<String, Long>comparingByValue().reversed())
                .limit(3)
                .map(Map.Entry::getKey)
                .toList();

        return new ScanCatalog.Conventions(pattern, recordUsage, primaryStereotypes);
    }
}
