/**
 * Barrel re-exporting the typed, bounded Vehicle-result render details, one file per result-kind,
 * from ./render-model/. Kept as a real file (not relying on directory-index resolution) so every
 * existing `from "./render-model.ts"` import keeps resolving unchanged -- this codebase's imports
 * always carry an explicit `.ts` extension, which does not implicitly resolve a bare specifier to
 * a directory's own index file the way Node's CJS `require()` does.
 */
export * from "./render-model/index.ts";
