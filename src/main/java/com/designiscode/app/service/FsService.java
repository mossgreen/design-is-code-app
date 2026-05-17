package com.designiscode.app.service;

import com.designiscode.app.dto.FsListResult;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.NotDirectoryException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

@Service
public class FsService {

    private static final int MAX_ENTRIES = 500;
    private static final List<String> PROJECT_MARKERS = List.of(
            "pom.xml", "build.gradle", "build.gradle.kts"
    );

    public FsListResult list(String pathStr, boolean showHidden) throws IOException {
        Path raw = (pathStr == null || pathStr.isBlank())
                ? Paths.get(System.getProperty("user.home"))
                : Paths.get(pathStr);

        Path resolved;
        try {
            resolved = raw.toRealPath();
        } catch (NoSuchFileException e) {
            throw new IllegalArgumentException("Folder does not exist: " + raw);
        }
        if (!Files.isDirectory(resolved)) {
            throw new NotDirectoryException(resolved.toString());
        }

        List<FsListResult.Entry> entries = new ArrayList<>();
        boolean truncated = false;
        try (Stream<Path> stream = Files.list(resolved)) {
            List<Path> dirs = new ArrayList<>();
            for (Path child : (Iterable<Path>) stream::iterator) {
                String name = child.getFileName().toString();
                if (!showHidden && name.startsWith(".")) continue;
                try {
                    if (Files.isDirectory(child)) dirs.add(child);
                } catch (Exception ignored) {
                    // skip entries we can't stat
                }
            }
            dirs.sort(Comparator.comparing(p -> p.getFileName().toString(), String.CASE_INSENSITIVE_ORDER));
            for (Path child : dirs) {
                if (entries.size() >= MAX_ENTRIES) {
                    truncated = true;
                    break;
                }
                entries.add(new FsListResult.Entry(
                        child.getFileName().toString(),
                        detectProjectMarker(child)
                ));
            }
        }

        Path parent = resolved.getParent();
        return new FsListResult(
                resolved.toString(),
                parent == null ? null : parent.toString(),
                truncated,
                entries
        );
    }

    private String detectProjectMarker(Path dir) {
        for (String marker : PROJECT_MARKERS) {
            try {
                if (Files.isRegularFile(dir.resolve(marker))) return marker;
            } catch (Exception ignored) {
                // permission errors etc. — just skip the check
            }
        }
        return null;
    }
}
