package com.designiscode.app.service;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Byte-equal golden-file assertion for the PetClinic demo tests. Regenerate
 * after an intentional change: run once with {@code DISC_UPDATE_GOLDENS=true},
 * eyeball the diff, commit.
 */
final class Goldens {

    private static final Path DIR = Path.of("src", "test", "resources", "goldens", "petclinic");

    private Goldens() {
    }

    static void assertGolden(String name, String actual) {
        Path golden = DIR.resolve(name);
        try {
            if ("true".equals(System.getenv("DISC_UPDATE_GOLDENS"))) {
                Files.createDirectories(DIR);
                Files.writeString(golden, actual);
                return;
            }
            assertTrue(Files.exists(golden),
                    "golden missing: " + golden + " — run once with DISC_UPDATE_GOLDENS=true, eyeball, commit");
            assertEquals(Files.readString(golden), actual, "byte-diff vs golden " + name);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
