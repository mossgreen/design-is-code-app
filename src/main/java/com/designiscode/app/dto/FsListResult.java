package com.designiscode.app.dto;

import java.util.List;

public record FsListResult(
        String path,
        String parent,
        boolean truncated,
        List<Entry> entries
) {
    public record Entry(String name, String projectMarker) {}
}
