package com.designiscode.app.dto;

import java.util.List;

/**
 * The {@code _index.json} sidecar that lives next to every {@code .puml}
 * in a multi-level design. Authoritative source for tree shape, parent
 * contract drift detection, and cycle detection.
 *
 * <p>Three jobs:
 * <ul>
 *   <li><b>Reconstruct UI state on cold open.</b> Studio has no
 *       in-process persistence; the manifest is the only way to know
 *       which {@code defer-design} children exist and where their
 *       sub-designs live.</li>
 *   <li><b>Drift check.</b> Each child records its parent's
 *       {@code contractHash} (a normalised hash of the parent's
 *       call signatures to this child). At build-walk time we
 *       re-hash and compare. Mismatch ⇒ refuse to build until the
 *       child is redesigned.</li>
 *   <li><b>Cycle detection.</b> The children references form a DAG;
 *       Kahn's algorithm flags any cycle before invoking the plugin.</li>
 * </ul>
 *
 * <p>Path conventions are sibling-folder: a parent at
 * {@code design/05_sale/CreateSale.puml} has children under
 * {@code design/05_sale/CreateSale/} and each child's manifest
 * records its parent as {@code "../CreateSale.puml"}.
 */
public record Manifest(
        String puml,
        ParentRef parent,
        List<ChildRef> children,
        String contractHash
) {
    public record ParentRef(String puml, String contractHash) {}

    public record ChildRef(String name, String puml, String kind) {}
}
