/**
 * Barrel re-exporting Papyrus's own Vehicle-projected result renderers from ./renderers/. Kept as
 * a real file (not relying on directory-index resolution) so every existing
 * `from "./vehicle-artifact-renderers.ts"` / `from "../extension/src/tools/vehicle-artifact-renderers.ts"`
 * import (vehicle-notes-client.ts plus 3 test files) keeps resolving unchanged -- this codebase's
 * imports always carry an explicit `.ts` extension, which does not implicitly resolve a bare
 * specifier to a directory's own index file the way Node's CJS `require()` does.
 *
 * The real implementation now lives in ./renderers/ (one file per result-kind, plus index.ts as
 * the Registry assembly point) instead of one 670-line file -- see Doc "Modularity playbook:
 * building-block-shaped TypeScript modules for papyrus/pi-papyrus" and the "pi-papyrus
 * vehicle-artifact-renderers.ts split" child of "Epic: Modularize papyrus/pi-papyrus god-files
 * into building-block modules".
 */
export { papyrusVehiclePresentations, papyrusVehicleRenderers } from "./renderers/index.ts";
