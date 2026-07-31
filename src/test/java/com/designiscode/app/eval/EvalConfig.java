package com.designiscode.app.eval;

import com.designiscode.app.service.Models;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;

/**
 * Shared opt-in configuration for every eval that shells out to the {@code claude}
 * CLI. Resolution order for each key: {@code -D} system property, then environment
 * variable, then the git-ignored {@code src/test/resources/eval.properties}.
 *
 * <p>{@code disc.eval.projectPath} is both config and on-switch: unset means every
 * eval skips, so a plain {@code ./gradlew test} never spends model calls by
 * accident.
 */
final class EvalConfig {

    static final String PROP_PATH = "disc.eval.projectPath";
    static final String ENV_PATH = "DISC_EVAL_PROJECT_PATH";
    static final String PROP_MODEL = "disc.eval.model";
    static final String PROP_RUNS = "disc.eval.runs";
    static final String PROP_PASS_RATE = "disc.eval.passRate";

    private static final Properties FILE_PROPS = load();

    private EvalConfig() {
    }

    static String cfg(String prop, String env) {
        return firstNonBlank(
                System.getProperty(prop),
                env == null ? null : System.getenv(env),
                FILE_PROPS.getProperty(prop));
    }

    /** How many times to run each fixture. Model output is stochastic; one run is an anecdote. */
    static int runs() {
        String raw = cfg(PROP_RUNS, null);
        if (raw == null || raw.isBlank()) return 1;
        try {
            return Math.max(1, Integer.parseInt(raw.trim()));
        } catch (NumberFormatException e) {
            return 1;
        }
    }

    /**
     * Fraction of runs that must pass; default 2/3, clamped to (0,1]. A single
     * stochastic flake should not red the build, but a consistent failure must.
     */
    static double passRate() {
        String raw = cfg(PROP_PASS_RATE, null);
        if (raw == null || raw.isBlank()) return 2.0 / 3.0;
        try {
            double d = Double.parseDouble(raw.trim());
            return (d > 0 && d <= 1) ? d : 2.0 / 3.0;
        } catch (NumberFormatException e) {
            return 2.0 / 3.0;
        }
    }

    /** Null means "let the service pick" — an unrecognised id is ignored rather than passed through. */
    static String model() {
        String requested = cfg(PROP_MODEL, null);
        if (requested == null || requested.isBlank()) return null;
        String trimmed = requested.trim();
        return Models.ALLOWED.contains(trimmed) ? trimmed : null;
    }

    static boolean claudeOnPath() {
        String path = System.getenv("PATH");
        if (path == null) return false;
        for (String dir : path.split(File.pathSeparator)) {
            if (dir.isBlank()) continue;
            File f = new File(dir, "claude");
            if (f.isFile() && f.canExecute()) return true;
        }
        return false;
    }

    private static String firstNonBlank(String... values) {
        for (String v : values) {
            if (v != null && !v.isBlank()) return v;
        }
        return null;
    }

    private static Properties load() {
        Properties p = new Properties();
        try (InputStream in = EvalConfig.class.getResourceAsStream("/eval.properties")) {
            if (in != null) p.load(in);
        } catch (IOException ignored) {
            // absent or unreadable -> rely on -D / env
        }
        return p;
    }
}
