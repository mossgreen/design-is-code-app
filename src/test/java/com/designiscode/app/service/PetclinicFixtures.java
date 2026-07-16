package com.designiscode.app.service;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

/**
 * Loads the vendored Spring PetClinic fixture sets (Apache-2.0; license headers
 * retained in the copied files). {@code act1} is real upstream code — foreign to
 * DisC, noise and all; {@code act2} is the hand-written EXPECTED Act-1 output
 * (REGEN-clean shape, see demo.md) the Act-2 variance ticket runs over.
 */
final class PetclinicFixtures {

    private PetclinicFixtures() {
    }

    /** All fixture sources under {@code fixtures/petclinic/<act>}, name-sorted for determinism. */
    static List<String> sources(String act) {
        Path dir = Path.of("src", "test", "resources", "fixtures", "petclinic", act);
        try (Stream<Path> files = Files.list(dir)) {
            return files.filter(p -> p.getFileName().toString().endsWith(".java"))
                    .sorted()
                    .map(PetclinicFixtures::read)
                    .toList();
        } catch (IOException e) {
            throw new UncheckedIOException("cannot list fixtures under " + dir, e);
        }
    }

    private static String read(Path p) {
        try {
            return Files.readString(p);
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read fixture " + p, e);
        }
    }
}
