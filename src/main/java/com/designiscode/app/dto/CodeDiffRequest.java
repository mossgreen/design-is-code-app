package com.designiscode.app.dto;

import java.util.List;

/**
 * Request body for the code→design diff endpoint: the user-provided related
 * files plus the ticket specifics. {@code sources} are file contents (the
 * client reads the related files); {@code discriminator} is the code token the
 * AC's selector maps to; {@code acText} is optional corroboration.
 */
public record CodeDiffRequest(
        List<String> sources,
        String entryClass,
        String entryMethod,
        String discriminator,
        String acText,
        VariantRequest request
) {}
