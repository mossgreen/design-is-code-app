package com.designiscode.app.service;

import com.designiscode.app.dto.Manifest;
import com.designiscode.app.dto.RunRequest;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.SerializationFeature;
import tools.jackson.databind.json.JsonMapper;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

import static com.designiscode.app.service.JsonEvents.event;

/**
 * On-disk tree state for multi-level designs.
 *
 * <p>Each folder containing a {@code .puml} carries a sibling
 * {@code _index.json} {@link Manifest}. This service is the single
 * authority for reading, writing, walking, and validating that tree.
 *
 * <p>Three reasons it exists:
 * <ol>
 *   <li><b>Cold-open reconstruction.</b> Studio's wizard has no
 *       in-process persistence. When the user reopens the project,
 *       the tree must rebuild from disk.</li>
 *   <li><b>Drift detection.</b> Each child records a hash of its
 *       parent's contract slice. {@link #hashContract} re-derives the
 *       current hash; mismatch ⇒ child is stale, sub-design must be
 *       redone.</li>
 *   <li><b>Bottom-up build orchestration.</b> {@link #buildAll}
 *       topologically sorts the tree (leaves first), checks for
 *       cycles + drift, then spawns the plugin once per node,
 *       streaming all events through a single emitter tagged with
 *       the current puml path.</li>
 * </ol>
 */
@Service
public class TreeService {

    static final String MANIFEST_FILE = "_index.json";

    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final RunService runService;
    private final ObjectMapper json = JsonMapper.builder()
            .enable(SerializationFeature.INDENT_OUTPUT)
            .build();

    // Token-matches arrow lines and participant declarations involving a
    // given child name. Used to extract the parent's contract slice for a
    // child without hashing cosmetic changes elsewhere in the .puml.
    private static final Pattern WORD_BOUNDARY = Pattern.compile("\\b");

    public TreeService(RunService runService) {
        this.runService = runService;
    }

    // ---- Manifest read/write -----------------------------------------------

    /** Loads the manifest at {@code <projectPath>/<manifestFolder>/_index.json}.
     *  Returns {@code null} when none exists — caller decides how to treat that
     *  (typically: single-file design, no tree). */
    public Manifest loadManifest(String projectPath, String manifestFolder) throws IOException {
        Path file = resolveManifestPath(projectPath, manifestFolder);
        if (!Files.isRegularFile(file)) return null;
        return json.readValue(file.toFile(), Manifest.class);
    }

    /** Writes a manifest to {@code <projectPath>/<manifestFolder>/_index.json},
     *  creating parent folders as needed. */
    public void saveManifest(String projectPath, String manifestFolder, Manifest manifest) throws IOException {
        Path file = resolveManifestPath(projectPath, manifestFolder);
        Files.createDirectories(file.getParent());
        json.writeValue(file.toFile(), manifest);
    }

    /** Walks the tree starting at the manifest in {@code rootFolder}. Returns
     *  every manifest found, keyed by its folder path relative to the project.
     *  Used by Studio's tree view to render the whole structure at once. */
    public Map<String, Manifest> loadTree(String projectPath, String rootFolder) throws IOException {
        Map<String, Manifest> out = new LinkedHashMap<>();
        collect(projectPath, rootFolder, out, new HashSet<>());
        return out;
    }

    private void collect(String projectPath, String folder, Map<String, Manifest> out, Set<String> seen) throws IOException {
        if (seen.contains(folder)) return;          // defensive against bogus cycles in manifests
        seen.add(folder);
        Manifest m = loadManifest(projectPath, folder);
        if (m == null) return;
        out.put(folder, m);
        if (m.children() == null) return;
        for (Manifest.ChildRef child : m.children()) {
            // child.puml is relative to THIS manifest's folder; child manifest
            // lives in the same folder as child.puml.
            String childFolder = joinRel(folder, parentOf(child.puml()));
            collect(projectPath, childFolder, out, seen);
        }
    }

    // ---- Contract hashing -------------------------------------------------

    /**
     * Hash the subset of a parent {@code .puml} that constitutes the contract
     * with a named child participant. Stable across cosmetic edits elsewhere
     * in the parent file, but sensitive to signature changes on the child.
     *
     * <p>Selection rule: a line is part of the contract if it contains the
     * child name as a whole word AND is either a {@code participant} declaration
     * or an arrow ({@code ->}, {@code <--}, {@code -->}, {@code <-}). Lines are
     * normalised (whitespace collapsed, lowercased) and sorted for determinism.
     */
    public String hashContract(Path parentPumlPath, String childName) throws IOException {
        List<String> lines = Files.readAllLines(parentPumlPath, StandardCharsets.UTF_8);
        List<String> normalised = new ArrayList<>();
        for (String raw : lines) {
            String line = raw.trim();
            if (line.isEmpty() || line.startsWith("'") || line.startsWith("@")) continue;
            if (!containsWord(line, childName)) continue;
            if (!(line.startsWith("participant") || line.contains("->") || line.contains("<--")
                    || line.contains("-->") || line.contains("<-"))) {
                continue;
            }
            normalised.add(line.replaceAll("\\s+", " ").toLowerCase());
        }
        normalised.sort(String::compareTo);
        return sha256(String.join("\n", normalised));
    }

    private static boolean containsWord(String haystack, String word) {
        String[] tokens = WORD_BOUNDARY.split(haystack);
        for (String t : tokens) if (t.equals(word)) return true;
        return false;
    }

    private static String sha256(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder("sha256:");
            for (byte b : digest) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable on this JVM", e);
        }
    }

    // ---- Build-all walker -------------------------------------------------

    /**
     * Walk the tree rooted at {@code rootPumlRelPath} bottom-up, spawning the
     * DisC plugin once per {@code .puml} in topological order. Streams all
     * plugin events through {@code emitter}, tagged with {@code node-start}
     * and {@code node-done} envelopes so the client can route events to
     * per-node panels.
     *
     * <p>Pre-flight checks (any failure halts before spawning):
     * <ul>
     *   <li>Cycle detection (Kahn's). Refuses with explanatory error.</li>
     *   <li>Drift detection for every non-root: re-hash parent's contract for
     *       this child, compare to stored. Refuses with the stale child's
     *       path so the user knows which sub-design to redo.</li>
     * </ul>
     */
    public void buildAll(RunRequest request, ResponseBodyEmitter emitter) {
        executor.submit(() -> runBuildAll(request, emitter));
    }

    private void runBuildAll(RunRequest request, ResponseBodyEmitter emitter) {
        String terminalError = null;
        int succeeded = 0;
        int total = 0;
        try {
            if (request == null || request.projectPath() == null || request.projectPath().isBlank()) {
                throw new IllegalArgumentException("projectPath is required");
            }
            if (request.filePath() == null || request.filePath().isBlank()) {
                throw new IllegalArgumentException("filePath (root .puml) is required");
            }
            Path projectRoot = Paths.get(request.projectPath()).toAbsolutePath().normalize();
            if (!Files.isDirectory(projectRoot)) {
                throw new IllegalArgumentException("project path is not a directory: " + projectRoot);
            }
            Path rootPuml = projectRoot.resolve(request.filePath()).normalize();
            if (!rootPuml.startsWith(projectRoot) || !Files.exists(rootPuml)) {
                throw new IllegalArgumentException("root .puml not found: " + rootPuml);
            }

            String rootFolder = projectRoot.relativize(rootPuml.getParent()).toString();
            Map<String, Manifest> tree = loadTree(projectRoot.toString(), rootFolder);
            List<String> order = topoOrLeavesFirst(tree, rootFolder);
            checkDrift(projectRoot, tree);

            total = order.size();
            emit(emitter, event("build-all-start", "nodes", total));

            for (String folder : order) {
                Manifest m = tree.get(folder);
                String relPuml = joinRel(folder, m.puml());
                emit(emitter, event("node-start", "puml", relPuml));

                String runId = UUID.randomUUID().toString();
                emit(emitter, "{\"event\":\"runId\",\"runId\":\"" + runId + "\"}");

                List<String> cmd = runService.buildDiscCommand(relPuml, request.model());
                RunService.ProcessResult result = runService.streamProcess(runId, cmd, projectRoot.toFile(), emitter);

                int exit = result.exit();
                String err = result.terminalError();
                emit(emitter, event("node-done", "puml", relPuml, "exit", exit, "error", err));

                if (err != null || exit != 0) {
                    terminalError = "node " + relPuml + " failed (exit=" + exit
                            + (err == null ? "" : ", error=" + err) + ")";
                    break;
                }
                succeeded++;
            }
        } catch (Exception e) {
            terminalError = e.getMessage();
        } finally {
            try {
                emit(emitter, event("build-all-done",
                        "total", total,
                        "succeeded", succeeded,
                        "error", terminalError));
            } finally {
                try { emitter.complete(); } catch (Exception ignored) { /* terminal */ }
            }
        }
    }

    /** Topological sort with leaves first. Throws if a cycle exists,
     *  naming the participating folders. Implemented as iterative
     *  post-order DFS from the root. */
    private List<String> topoOrLeavesFirst(Map<String, Manifest> tree, String root) {
        if (!tree.containsKey(root)) {
            throw new IllegalArgumentException("no manifest at root folder: " + root);
        }
        List<String> out = new ArrayList<>();
        Set<String> visited = new HashSet<>();
        Set<String> onStack = new HashSet<>();
        Deque<DfsFrame> stack = new ArrayDeque<>();
        stack.push(new DfsFrame(root));
        onStack.add(root);

        while (!stack.isEmpty()) {
            DfsFrame top = stack.peek();
            Manifest m = tree.get(top.folder);
            List<Manifest.ChildRef> children = m == null || m.children() == null
                    ? List.of() : m.children();

            if (top.idx >= children.size()) {
                visited.add(top.folder);
                onStack.remove(top.folder);
                out.add(top.folder);
                stack.pop();
                continue;
            }

            Manifest.ChildRef child = children.get(top.idx++);
            String childFolder = joinRel(top.folder, parentOf(child.puml()));

            if (onStack.contains(childFolder)) {
                throw new IllegalStateException(
                        "cycle in design tree: " + top.folder + " ↔ " + childFolder);
            }
            if (!visited.contains(childFolder) && tree.containsKey(childFolder)) {
                stack.push(new DfsFrame(childFolder));
                onStack.add(childFolder);
            }
        }
        return out;
    }

    /** DFS frame for the iterative topological walk. Mutable {@code idx} —
     *  not a record because each frame's child cursor advances as we descend. */
    private static final class DfsFrame {
        final String folder;
        int idx;
        DfsFrame(String folder) { this.folder = folder; this.idx = 0; }
    }

    private void checkDrift(Path projectRoot, Map<String, Manifest> tree) throws IOException {
        for (Map.Entry<String, Manifest> e : tree.entrySet()) {
            Manifest m = e.getValue();
            if (m.parent() == null) continue;        // root
            String parentRel = m.parent().puml();    // e.g. "../CreateSale.puml"
            Path parentAbs = projectRoot.resolve(e.getKey()).resolve(parentRel).normalize();
            if (!Files.isRegularFile(parentAbs)) {
                throw new IllegalStateException("parent .puml missing for " + e.getKey() + ": " + parentAbs);
            }
            // The child name is its own folder's last segment (sibling-folder convention).
            String childName = childNameFromFolder(e.getKey());
            String currentHash = hashContract(parentAbs, childName);
            String storedHash = m.parent().contractHash();
            if (storedHash != null && !storedHash.equals(currentHash)) {
                throw new IllegalStateException(
                        "parent " + parentAbs.getFileName() + " has changed since "
                                + e.getKey() + " was designed — redesign at "
                                + joinRel(e.getKey(), m.puml()));
            }
        }
    }

    private static String childNameFromFolder(String folder) {
        int slash = folder.lastIndexOf('/');
        return slash < 0 ? folder : folder.substring(slash + 1);
    }

    // ---- Path helpers -----------------------------------------------------

    private Path resolveManifestPath(String projectPath, String manifestFolder) {
        Path root = Paths.get(projectPath).toAbsolutePath().normalize();
        Path file = root.resolve(manifestFolder == null ? "" : manifestFolder)
                .resolve(MANIFEST_FILE).normalize();
        if (!file.startsWith(root)) {
            throw new IllegalArgumentException("manifest path escapes project: " + manifestFolder);
        }
        return file;
    }

    private static String joinRel(String base, String add) {
        if (add == null || add.isEmpty() || add.equals(".")) return base;
        if (base == null || base.isEmpty()) return add;
        // Use POSIX path semantics; .puml paths are always written with '/'.
        return Paths.get(base).resolve(add).normalize().toString().replace(File.separatorChar, '/');
    }

    private static String parentOf(String relPath) {
        int slash = relPath.lastIndexOf('/');
        return slash < 0 ? "" : relPath.substring(0, slash);
    }

    private void emit(ResponseBodyEmitter emitter, String chunk) {
        try {
            emitter.send(chunk + "\n");
        } catch (IOException ignored) {
            // Client disconnected; the loop will see exit-side cancellation eventually.
        }
    }
}
