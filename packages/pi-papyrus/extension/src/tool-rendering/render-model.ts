/**
 * Barrel re-exporting the typed, bounded Vehicle-result render details, one file per result-kind,
 * from ./render-model/. Kept as a real file (not relying on directory-index resolution) so every
 * existing `from "./render-model.ts"` / `from "../tool-rendering/render-model.ts"` import across
 * this package's 5 real consumers (tool-rendering/index.ts, tool-rendering/artifact-card.ts,
 * tool-rendering/artifact-list.ts, tools/vehicle-artifact-renderers.ts, index.ts) keeps resolving
 * unchanged -- this codebase's imports always carry an explicit `.ts` extension, which does not
 * implicitly resolve a bare specifier to a directory's own index file the way Node's CJS
 * `require()` does.
 *
 * The real implementation now lives in ./render-model/ (one file per result-kind, already
 * Strategy-shaped in spirit) instead of one 827-line file -- see Doc "Modularity playbook:
 * building-block-shaped TypeScript modules for papyrus/pi-papyrus" and the "pi-papyrus
 * render-model.ts split" child of "Epic: Modularize papyrus/pi-papyrus god-files into
 * building-block modules".
 */
export * from "./render-model/index.ts";
