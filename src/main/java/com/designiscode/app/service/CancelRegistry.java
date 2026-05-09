package com.designiscode.app.service;

import org.springframework.stereotype.Component;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

@Component
public class CancelRegistry {

    private final ConcurrentMap<String, Process> processes = new ConcurrentHashMap<>();

    public void register(String runId, Process process) {
        processes.put(runId, process);
    }

    public void unregister(String runId) {
        processes.remove(runId);
    }

    /** Best-effort cancel. Returns true if a process was found and asked to stop. */
    public boolean cancel(String runId) {
        Process p = processes.remove(runId);
        if (p == null || !p.isAlive()) return false;
        p.destroy();
        // If still alive after a short grace, force-kill on a daemon thread so the
        // caller doesn't block. The reader loop sees EOF either way and tears down.
        Thread killer = new Thread(() -> {
            try {
                if (!p.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) {
                    p.destroyForcibly();
                }
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }, "disc-cancel-killer");
        killer.setDaemon(true);
        killer.start();
        return true;
    }
}
