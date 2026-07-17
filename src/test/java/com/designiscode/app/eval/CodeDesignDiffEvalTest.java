package com.designiscode.app.eval;

import com.designiscode.app.dto.DesignDelta;
import com.designiscode.app.dto.DesignDelta.MappingRow;
import com.designiscode.app.dto.DiffResult;
import com.designiscode.app.dto.VariantRequest;
import com.designiscode.app.service.BindingTimeClassifier;
import com.designiscode.app.service.CallGraphDeriver;
import com.designiscode.app.service.CodeDesignDiffService;
import com.designiscode.app.service.CounterfactualRenderer;
import com.designiscode.app.service.WhyRenderer;
import com.designiscode.app.service.DeltaRenderer;
import com.designiscode.app.service.DesignDeltaEmitter;
import com.designiscode.app.service.DesignDiffer;
import com.designiscode.app.service.DesignService;
import com.designiscode.app.service.SliceRenderer;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Round-trip golden for the code→design diff loop, against a REAL project on
 * disk. Opt-in and gated exactly like {@link AnalyzerEvalTest}: it SKIPs unless
 * the ticket is configured, so a plain {@code ./gradlew test} never fires it.
 *
 * <p>It reads the project's actual {@code src/main/java} sources (not inline
 * fixtures), runs the full pipeline (Stages A–E), and applies the artifacts into
 * {@code <project>/design/}. The final step — running the DisC plugin over those
 * artifacts and asserting the generated code compiles and tests pass — is the
 * operator's CI step (it costs model calls), the same way {@code AnalyzerEvalTest}
 * shells the {@code claude} CLI rather than baking it into the plain test task.
 *
 * <p>Config (first non-blank wins: {@code -D} system property, then env var):
 * <ul>
 *   <li>{@code disc.diff.projectPath} — project root to scan + write into</li>
 *   <li>{@code disc.diff.entryClass} / {@code disc.diff.entryMethod}</li>
 *   <li>{@code disc.diff.discriminator} — code token the AC selector maps to</li>
 *   <li>{@code disc.diff.calleeType} — the variation point being varied</li>
 *   <li>{@code disc.diff.newVariant} — the variant to introduce</li>
 *   <li>{@code disc.diff.mapping} — {@code KEY=Strategy,KEY2=Strategy2}</li>
 *   <li>{@code disc.diff.acText} — optional AC corroboration text</li>
 * </ul>
 */
@Tag("eval")
class CodeDesignDiffEvalTest {

    private final CodeDesignDiffService pipeline = new CodeDesignDiffService(
            new CallGraphDeriver(), new BindingTimeClassifier(), new DesignDiffer(),
            new DesignDeltaEmitter(), new DesignService(),
            new SliceRenderer(), new DeltaRenderer(),
            new CounterfactualRenderer(), new WhyRenderer());

    @Test
    void appliesRequestDynamicVariantToARealProject() throws Exception {
        String projectPath = cfg("disc.diff.projectPath");
        String entryClass = cfg("disc.diff.entryClass");
        String entryMethod = cfg("disc.diff.entryMethod");
        String discriminator = cfg("disc.diff.discriminator");
        String calleeType = cfg("disc.diff.calleeType");
        String newVariant = cfg("disc.diff.newVariant");
        String mappingSpec = cfg("disc.diff.mapping");

        Assumptions.assumeTrue(allPresent(projectPath, entryClass, entryMethod, discriminator,
                        calleeType, newVariant, mappingSpec),
                "SKIP: configure disc.diff.* (projectPath/entryClass/entryMethod/discriminator/"
                        + "calleeType/newVariant/mapping) to run the round-trip golden");

        Path root = Path.of(projectPath.trim());
        Assumptions.assumeTrue(Files.isDirectory(root), "SKIP: not a directory: " + root);

        List<String> sources = readJavaSources(root);
        VariantRequest request = new VariantRequest(calleeType, newVariant, parseMapping(mappingSpec), null);

        DiffResult result = pipeline.run(sources, entryClass, entryMethod, discriminator,
                cfg("disc.diff.acText"), request);

        System.out.println("[code-diff] disposition=" + result.disposition()
                + " classification=" + result.classification().bindingTime()
                + (result.delta().reason() != null ? " reason=" + result.delta().reason() : ""));

        if (!DesignDelta.GENERATE.equals(result.disposition())) {
            // park/ask are valid outcomes — the loop correctly declined to force a resolver.
            return;
        }
        assertTrue(result.validationViolations().isEmpty(),
                () -> "delta not minimal: " + result.validationViolations());
        assertNotNull(result.artifacts());

        pipeline.apply(root.toString(), result.artifacts());
        assertTrue(Files.exists(root.resolve("design").resolve(result.artifacts().pumlFileName())),
                "applied .puml exists");
        System.out.println("[code-diff] applied to " + root.resolve("design")
                + " — run the DisC plugin over it to generate + compile (operator/CI step).");
    }

    private static List<String> readJavaSources(Path root) throws Exception {
        List<String> out = new ArrayList<>();
        try (Stream<Path> paths = Files.walk(root)) {
            for (Path p : paths.filter(Files::isRegularFile)
                    .filter(f -> f.toString().endsWith(".java"))
                    .filter(f -> f.toString().contains("src/main/java"))
                    .toList()) {
                out.add(Files.readString(p));
            }
        }
        return out;
    }

    private static List<MappingRow> parseMapping(String spec) {
        List<MappingRow> rows = new ArrayList<>();
        for (String pair : spec.split(",")) {
            String[] kv = pair.split("=", 2);
            if (kv.length == 2) rows.add(new MappingRow(kv[0].trim(), kv[1].trim()));
        }
        return rows;
    }

    private static boolean allPresent(String... vals) {
        for (String v : vals) if (v == null || v.isBlank()) return false;
        return true;
    }

    private static String cfg(String key) {
        String sys = System.getProperty(key);
        if (sys != null && !sys.isBlank()) return sys;
        return System.getenv(key.replace('.', '_').toUpperCase());
    }
}
