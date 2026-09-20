/**
 * Module-load log for the migration-seam driver.
 *
 * The wrapper spawns the driver as `bun --preload <this file> <driver>`, so
 * this module evaluates — and registers the resolve hook — before the entry
 * module's own resolution. Every import that follows, static or dynamic, is
 * recorded here as `{ specifier, importer }`, and the entry's own resolution
 * shows importer `bun:main`. `seam-engine-gate.mjs` reads the log before it
 * imports anything from the measured source tree: a `bun:main` entry proves
 * the hook was armed early enough that no load could escape it, and an entry
 * naming the source root proves engine code ran before the guard — a load
 * whose top-level evaluation could repair the surface the guard then checks.
 *
 * The exported array is shared state: the preload evaluation and the gate's
 * import resolve to the same module instance, so the gate reads the log the
 * hook is writing.
 */
export const moduleLoads = [];

if (typeof Bun !== "undefined" && typeof Bun.plugin === "function") {
  Bun.plugin({
    name: "autosk-seam-module-loads",
    setup(build) {
      build.onResolve({ filter: /.*/u }, (args) => {
        moduleLoads.push({ specifier: args.path, importer: args.importer });
        return undefined;
      });
    },
  });
}
