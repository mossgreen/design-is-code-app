package com.designiscode.app.service;

import com.designiscode.app.dto.JavaType;
import com.designiscode.app.dto.ScanResult;
import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.nodeTypes.NodeWithAnnotations;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

@Service
public class ScanService {

    private static final Set<String> SPRING_STEREOTYPES = Set.of(
            "Service", "Component", "Controller", "RestController",
            "Repository", "Configuration", "ControllerAdvice",
            "RestControllerAdvice", "SpringBootApplication"
    );

    private final JavaParser parser = new JavaParser(
            new ParserConfiguration()
                    .setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21)
    );

    public ScanResult scan(String pathStr) {
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

        List<JavaType> classes = new ArrayList<>();
        List<JavaType> interfaces = new ArrayList<>();
        List<JavaType> dataTypes = new ArrayList<>();
        List<String> methods = new ArrayList<>();
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
                    String relative = root.relativize(file).toString();

                    cu.findAll(ClassOrInterfaceDeclaration.class).forEach(type -> {
                        String typeName = type.getNameAsString();
                        List<String> typeMethods = methodNames(type);
                        typeMethods.forEach(m -> methods.add(typeName + "." + m));

                        boolean isJpaEntity = hasEntityAnnotation(type);
                        JavaType jt = new JavaType(typeName, pkg, relative, typeMethods, isJpaEntity);

                        if (type.isInterface()) {
                            interfaces.add(jt);
                        } else if (hasSpringStereotype(type)) {
                            classes.add(jt);
                        } else {
                            dataTypes.add(jt);
                        }
                    });

                    cu.findAll(RecordDeclaration.class).forEach(rec -> {
                        String typeName = rec.getNameAsString();
                        List<String> typeMethods = rec.getMethods().stream()
                                .map(m -> m.getNameAsString())
                                .distinct()
                                .toList();
                        typeMethods.forEach(m -> methods.add(typeName + "." + m));

                        boolean isJpaEntity = hasEntityAnnotation(rec);
                        dataTypes.add(new JavaType(typeName, pkg, relative, typeMethods, isJpaEntity));
                    });
                } catch (Exception e) {
                    skippedCount++;
                }
            }
        } catch (IOException e) {
            throw new RuntimeException("Failed to walk path: " + root, e);
        }

        return new ScanResult(
                root.toString(),
                fileCount,
                skippedCount,
                classes,
                interfaces,
                dataTypes,
                methods
        );
    }

    private List<String> methodNames(ClassOrInterfaceDeclaration type) {
        return type.getMethods().stream()
                .map(m -> m.getNameAsString())
                .distinct()
                .toList();
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

    private boolean hasEntityAnnotation(NodeWithAnnotations<?> node) {
        return node.getAnnotations().stream().anyMatch(a -> {
            String name = simpleName(a.getNameAsString());
            return name.equals("Entity");
        });
    }

    private boolean hasSpringStereotype(NodeWithAnnotations<?> node) {
        return node.getAnnotations().stream().anyMatch(a ->
                SPRING_STEREOTYPES.contains(simpleName(a.getNameAsString())));
    }

    private String simpleName(String annotationName) {
        int lastDot = annotationName.lastIndexOf('.');
        return lastDot >= 0 ? annotationName.substring(lastDot + 1) : annotationName;
    }
}
