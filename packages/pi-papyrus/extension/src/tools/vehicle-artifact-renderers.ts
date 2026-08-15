/**
 * Barrel re-exporting Papyrus's own Vehicle-projected result renderers from ./renderers/. Kept as
 * a real file (not relying on directory-index resolution) so every existing
 * `from "./vehicle-artifact-renderers.ts"` import keeps resolving unchanged -- this codebase's
 * imports always carry an explicit `.ts` extension, which does not implicitly resolve a bare
 * specifier to a directory's own index file the way Node's CJS `require()` does.
 */
export { papyrusVehiclePresentations, papyrusVehicleRenderers } from "./renderers/index.ts";
