package com.designiscode.app.service;

import com.designiscode.app.dto.GenerationOptions;
import com.designiscode.app.dto.GenerationStatus;
import com.designiscode.app.dto.ValidateRequest;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;

/**
 * The wizard's only contract with whatever turns a {@code .puml} into Java.
 *
 * <p>Implementations choose any runtime — a CLI-driven agentic tool, a
 * direct LLM API call, a bundled JAR, anything that can read a {@code .puml}
 * and write Java. The wizard depends on this interface alone.
 *
 * <p>The wizard's own design discipline applied to its own code: abstraction
 * goes first, runtime-specific implementation lives behind it. Adding a
 * second generator is a single new {@code @Service} implementing this
 * interface; nothing else in the wizard moves.
 */
public interface CodeGenerator {

    /** Snapshot of the generator's runtime state. */
    GenerationStatus status();

    /** Stream a generation run (NDJSON) over the supplied emitter. */
    void streamGenerate(GenerationOptions opts, ResponseBodyEmitter emitter);

    /** Plan mode (dry-run): synchronous JSON envelope of what generation would do. */
    Object plan(GenerationOptions opts);

    /** Validate mode (preflight): synchronous Step-1-only contract check on an
     *  unsaved design. Returns {@code {refused: false}} on pass, or
     *  {@code {refused: true, message: <plugin's refusal markdown>}} when the
     *  plugin would refuse to generate. Transport failures return
     *  {@code {refused: false, error: ...}} — treated as soft pass; the eventual
     *  Run at Step 4 will surface real generator errors. */
    Object validate(ValidateRequest req);

    /** Stream the generator's install / first-time setup over the emitter. */
    void streamInstall(ResponseBodyEmitter emitter);

    /** Stream the generator's self-update over the emitter. */
    void streamUpdate(ResponseBodyEmitter emitter);

    /** Cancel an in-flight operation identified by its {@code runId}. */
    boolean cancel(String runId);
}
