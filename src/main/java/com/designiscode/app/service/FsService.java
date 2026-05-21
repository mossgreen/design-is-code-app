package com.designiscode.app.service;

import com.designiscode.app.dto.FsListResult;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.NotDirectoryException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
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

    /** Hard ceiling on how long we wait for the user to interact with the
     *  OS folder dialog. The picker is modal-ish on each platform so the
     *  user may take a while — five minutes is generous but bounded so a
     *  forgotten dialog can't hold a request thread forever. */
    private static final long PICK_TIMEOUT_SECONDS = 300;

    /**
     * Pop the OS-native folder picker on the same machine the server is
     * running on, and return the absolute path the user chose. Designed for
     * the localhost-tool use case — only safe because DisC Studio runs on
     * the developer's own machine.
     *
     * <p>Result keys:
     * <ul>
     *   <li>{@code path} — chosen absolute path (only when {@code canceled} is false)</li>
     *   <li>{@code canceled} — true when the user dismissed the dialog or no path was returned</li>
     *   <li>{@code platform} — "mac" / "linux" / "windows", for client-side messaging</li>
     * </ul>
     *
     * @param seedPath optional starting folder; passed to the OS dialog as the
     *                 default location. Ignored when the platform's picker
     *                 doesn't support it or the path is blank.
     */
    public Map<String, Object> pickFolder(String seedPath) throws IOException, InterruptedException {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        String platform;
        ProcessBuilder pb;
        if (os.contains("mac") || os.contains("darwin")) {
            platform = "mac";
            pb = buildMacOsPicker(seedPath);
        } else if (os.contains("win")) {
            platform = "windows";
            pb = buildWindowsPicker(seedPath);
        } else {
            platform = "linux";
            pb = buildLinuxPicker(seedPath);
        }

        Process process;
        try {
            process = pb.start();
        } catch (IOException e) {
            // zenity / osascript / powershell not installed
            String msg = e.getMessage() == null ? "" : e.getMessage();
            if (msg.contains("No such file") || msg.contains("error=2") || msg.contains("Cannot run")) {
                throw new IOException("Folder picker is not available on this system: " + msg, e);
            }
            throw e;
        }

        String stdout = readAll(process.getInputStream());
        boolean exited = process.waitFor(PICK_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        if (!exited) {
            process.destroyForcibly();
            throw new IOException("Folder picker timed out after " + PICK_TIMEOUT_SECONDS + "s");
        }
        int exit = process.exitValue();
        String trimmed = stdout.trim();
        // User cancel: most pickers exit non-zero or print nothing.
        if (exit != 0 || trimmed.isEmpty()) {
            return Map.of("canceled", true, "platform", platform);
        }
        // osascript returns POSIX paths with a trailing slash; trim it so
        // downstream code that compares to user-typed paths matches.
        if (trimmed.length() > 1 && trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return Map.of("path", trimmed, "canceled", false, "platform", platform);
    }

    private ProcessBuilder buildMacOsPicker(String seedPath) {
        // AppleScript `choose folder` with optional default location. Quote
        // the seed so spaces/special chars don't break the script. If the
        // seed doesn't exist, AppleScript falls back to the user's default.
        String seedClause = "";
        if (seedPath != null && !seedPath.isBlank()) {
            Path p = Paths.get(seedPath);
            if (Files.isDirectory(p)) {
                seedClause = " default location (POSIX file \"" + p.toAbsolutePath() + "\")";
            }
        }
        String script = "POSIX path of (choose folder with prompt \"Choose your Spring/Java project folder\"" + seedClause + ")";
        return new ProcessBuilder("osascript", "-e", script);
    }

    private ProcessBuilder buildLinuxPicker(String seedPath) {
        // Prefer zenity; users on most desktops have it. If missing, the
        // process spawn fails with a useful error message that the controller
        // surfaces verbatim.
        List<String> argv = new ArrayList<>();
        argv.add("zenity");
        argv.add("--file-selection");
        argv.add("--directory");
        argv.add("--title=Choose your Spring/Java project folder");
        if (seedPath != null && !seedPath.isBlank()) {
            argv.add("--filename=" + seedPath);
        }
        return new ProcessBuilder(argv);
    }

    private ProcessBuilder buildWindowsPicker(String seedPath) {
        // PowerShell + System.Windows.Forms.FolderBrowserDialog. Newer
        // Windows uses the modern Vista-style picker by default. The script
        // prints the chosen path to stdout, nothing on cancel.
        String seedAssign = "";
        if (seedPath != null && !seedPath.isBlank()) {
            String escaped = seedPath.replace("'", "''");
            seedAssign = "$f.SelectedPath = '" + escaped + "'; ";
        }
        String script = "Add-Type -AssemblyName System.Windows.Forms;" +
                "$f = New-Object System.Windows.Forms.FolderBrowserDialog;" +
                "$f.Description = 'Choose your Spring/Java project folder';" +
                seedAssign +
                "if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath };";
        return new ProcessBuilder("powershell", "-NoProfile", "-Command", script);
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
}
