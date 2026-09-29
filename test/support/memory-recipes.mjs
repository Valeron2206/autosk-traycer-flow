/**
 * An in-memory apply-recipe journal for the delta driver's tests (debt 12g).
 *
 * The product's journal is `recipeJournal` of `src/host/staging-lineage.mjs`,
 * an append-only file; this one holds the same `{ load, save }` contract in a
 * Map, so a test can read what the driver recorded before it asked the helper,
 * and can drop the process (keep the journal, forget everything else) to
 * stand for a crash.
 */
export function memoryRecipes() {
  const held = new Map();
  const order = [];
  return Object.freeze({
    held,
    /** What `save` was handed, in order, so a test can say what was recorded before what. */
    order,
    async load(applyKey) {
      return held.has(applyKey) ? structuredClone(held.get(applyKey)) : null;
    },
    async save(recipe) {
      order.push(recipe.apply_key);
      held.set(recipe.apply_key, structuredClone(recipe));
    },
  });
}
