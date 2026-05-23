package com.designiscode.app.service;

import com.designiscode.app.dto.GenerationOptions;
import com.designiscode.app.dto.GenerationStatus;
import com.designiscode.app.dto.PluginStatus;
import com.designiscode.app.dto.RunRequest;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;

/**
 * The default {@link CodeGenerator} implementation — the DisC Claude Code
 * plugin invoked via the local {@code claude} CLI. Wraps the existing
 * {@link RunService} (subprocess + NDJSON streaming) and {@link PluginService}
 * (install detection + install/update commands) so the wizard's controllers
 * never need to know either of those types exist.
 *
 * <p>All Claude-specific details — the marketplace id, the {@code claude
 * plugin install} command, the model allowlist — live in this file or in
 * the two helper services it composes. The {@link CodeGenerator} interface
 * is intentionally free of Claude-isms.
 */
@Service
public class ClaudeCodePluginGenerator implements CodeGenerator {

    private final RunService runService;
    private final PluginService pluginService;

    public ClaudeCodePluginGenerator(RunService runService, PluginService pluginService) {
        this.runService = runService;
        this.pluginService = pluginService;
    }

    @Override
    public GenerationStatus status() {
        PluginStatus s = pluginService.status();
        String cmd = installCommand();
        if (!s.installed()) {
            return GenerationStatus.notInstalled(cmd);
        }
        boolean outdated = s.latestVersion() != null
                && s.version() != null
                && !s.latestVersion().equals(s.version());
        GenerationStatus.State state = outdated
                ? GenerationStatus.State.OUTDATED
                : GenerationStatus.State.READY;
        return new GenerationStatus(state, s.version(), s.installPath(), s.latestVersion(), cmd);
    }

    @Override
    public void streamGenerate(GenerationOptions opts, ResponseBodyEmitter emitter) {
        runService.run(toRunRequest(opts), emitter);
    }

    @Override
    public Object plan(GenerationOptions opts) {
        try {
            return runService.plan(toRunRequest(opts));
        } catch (IllegalArgumentException e) {
            // Argument problems bubble up unchanged — GeneratorController
            // already maps these to 400.
            throw e;
        } catch (Exception e) {
            // Subprocess + parse failures are wrapped so the interface
            // stays free of Claude-specific checked types. Controller maps
            // RuntimeException to 500.
            throw new RuntimeException("Plan failed: " + e.getMessage(), e);
        }
    }

    @Override
    public void streamInstall(ResponseBodyEmitter emitter) {
        pluginService.install(emitter);
    }

    @Override
    public void streamUpdate(ResponseBodyEmitter emitter) {
        pluginService.update(emitter);
    }

    @Override
    public boolean cancel(String runId) {
        // Both helpers share the same CancelRegistry, so either delegation
        // resolves a registered run; try the run helper first, fall back to
        // the plugin helper for install/update cancels.
        if (runService.cancel(runId)) return true;
        return pluginService.cancel(runId);
    }

    private String installCommand() {
        return "claude plugin install " + PluginService.PLUGIN_ID + " --scope user";
    }

    private static RunRequest toRunRequest(GenerationOptions opts) {
        if (opts == null) return new RunRequest(null, null, null);
        return new RunRequest(opts.projectPath(), opts.filePath(), opts.model());
    }
}
