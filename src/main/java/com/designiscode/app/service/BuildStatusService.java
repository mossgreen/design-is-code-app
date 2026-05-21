package com.designiscode.app.service;

import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

/**
 * Filesystem observation only — given participant names, decide whether
 * each one has been built as a real implementation, materialised only
 * as a Pending stub, or not generated at all.
 *
 * <p>Three states, exhaustive:
 * <ul>
 *   <li>{@code "real"} — a {@code Default<Name>.java} exists anywhere
 *       under {@code <projectPath>/src/main/java}.</li>
 *   <li>{@code "stubbed"} — only {@code Pending<Name>.java} exists
 *       (defer-design participant whose own .puml hasn't been built).</li>
 *   <li>{@code "pending"} — neither file exists (plugin hasn't been
 *       run for this participant yet).</li>
 * </ul>
 *
 * <p>Detection is one walk of {@code src/main/java} regardless of how
 * many names the caller supplies; we index {@code Default*} and
 * {@code Pending*} files by simple name and resolve each query against
 * those sets. No Java parsing, no
 * `javac`, no Spring-context introspection — this is intentionally
 * just a filesystem signal.
 *
 * <p>False-positive: an unrelated {@code DefaultThing.java} (not from
 * DisC) plus a participant named {@code Thing} resolves to
 * {@code "real"}. Acceptable for v1 — collisions are rare in practice
 * and the user can spot the mismatch from the Studio's tree view.
 */
@Service
public class BuildStatusService {

    private static final String STATUS_REAL = "real";
    private static final String STATUS_STUBBED = "stubbed";
    private static final String STATUS_PENDING = "pending";

    private static final String DEFAULT_PREFIX = "Default";
    private static final String PENDING_PREFIX = "Pending";
    private static final String JAVA_SUFFIX = ".java";

    /** Resolves each participant name to a status string. Order of the
     *  returned map matches the input list. */
    public Map<String, String> status(String projectPath, List<String> participantNames) throws IOException {
        Map<String, String> out = new LinkedHashMap<>();
        if (participantNames == null || participantNames.isEmpty()) return out;

        if (projectPath == null || projectPath.isBlank()) {
            for (String name : participantNames) out.put(name, STATUS_PENDING);
            return out;
        }

        Path root = Paths.get(projectPath).toAbsolutePath().normalize().resolve("src/main/java");
        if (!Files.isDirectory(root)) {
            for (String name : participantNames) out.put(name, STATUS_PENDING);
            return out;
        }

        Set<String> defaults = new HashSet<>();
        Set<String> pendings = new HashSet<>();
        try (Stream<Path> stream = Files.walk(root)) {
            stream.filter(Files::isRegularFile)
                    .map(p -> p.getFileName().toString())
                    .forEach(name -> {
                        if (name.endsWith(JAVA_SUFFIX)) {
                            if (name.startsWith(DEFAULT_PREFIX)) {
                                defaults.add(stripPrefixSuffix(name, DEFAULT_PREFIX));
                            } else if (name.startsWith(PENDING_PREFIX)) {
                                pendings.add(stripPrefixSuffix(name, PENDING_PREFIX));
                            }
                        }
                    });
        }

        for (String name : participantNames) {
            if (defaults.contains(name)) out.put(name, STATUS_REAL);
            else if (pendings.contains(name)) out.put(name, STATUS_STUBBED);
            else out.put(name, STATUS_PENDING);
        }
        return out;
    }

    private static String stripPrefixSuffix(String filename, String prefix) {
        return filename.substring(prefix.length(), filename.length() - JAVA_SUFFIX.length());
    }
}
