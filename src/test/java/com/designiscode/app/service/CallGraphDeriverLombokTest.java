package com.designiscode.app.service;

import com.designiscode.app.dto.DerivedSlice;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Lombok wiring fallback (found by the step-0 probe on the RealWorld repo):
 * {@code @AllArgsConstructor}/{@code @RequiredArgsConstructor} generate the
 * constructor at compile time, so the source has none — without the fallback
 * the SUT's collaborators vanish from the wiring and the flow classification.
 */
class CallGraphDeriverLombokTest {

    private final CallGraphDeriver deriver = new CallGraphDeriver();

    private static final String SERVICE = """
            package com.demo;
            public interface GreetService { String greet(String name); }
            """;

    @Test
    void allArgsConstructorFieldsBecomeConstructorDeps() {
        String sut = """
                package com.demo;
                import lombok.AllArgsConstructor;
                @AllArgsConstructor
                public class GreetController {
                    private static final String PREFIX = "hi ";
                    private GreetService greetService;
                    public String hello(String name) {
                        String message = greetService.greet(name);
                        return message;
                    }
                }
                """;
        DerivedSlice slice = deriver.derive(List.of(SERVICE, sut), "GreetController", "hello");

        assertEquals(1, slice.dependencies().size(), "static fields excluded");
        assertEquals("greetService", slice.dependencies().get(0).name());
        assertEquals("constructor", slice.dependencies().get(0).injection());
        assertEquals("GreetService", slice.callSites().get(0).calleeType());
    }

    @Test
    void requiredArgsConstructorTakesOnlyFinalFields() {
        String sut = """
                package com.demo;
                import lombok.RequiredArgsConstructor;
                @RequiredArgsConstructor
                public class GreetController {
                    private final GreetService greetService;
                    private String cached;
                    public String hello(String name) {
                        return greetService.greet(name);
                    }
                }
                """;
        DerivedSlice slice = deriver.derive(List.of(SERVICE, sut), "GreetController", "hello");

        assertEquals(List.of("greetService"),
                slice.dependencies().stream().map(DerivedSlice.Dependency::name).toList());
    }
}
