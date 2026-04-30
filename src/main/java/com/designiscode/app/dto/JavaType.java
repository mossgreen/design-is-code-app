package com.designiscode.app.dto;

import java.util.List;

public record JavaType(
        String name,
        String packageName,
        String file,
        List<String> methods,
        boolean isJpaEntity
) {}
