/** The safe project filesystem adapter (#22, and the cleanup plans that name it).
 *
 * Every other module here takes a filesystem by injection and says what it
 * needs from it. This is the one the product uses, and the properties it adds
 * to the raw one are the properties those modules assume:
 *
 * - every path is resolved and must land inside the project root;
 * - a symlink is never followed to write through it;
 * - a removal takes a file, never a directory or a link;
 * - a read of something that is not a regular file is a refusal, not bytes.
 *
 * `rm -rf` is deliberately absent. Recursive deletion is the operation that
 * cannot be undone, and no caller here needs it: the sweeper deletes named
 * files it planned, and the clean-room builds in a temporary directory the
 * operating system owns.
 *
 * Injected node primitives, so the adapter itself is testable: `lstat`,
 * `readFile`, `writeFile`, `mkdir`, `unlink`, `realpath`, `rename`.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

export const REFUSALS = immutable([
  'fs_outside_project',
  'fs_not_regular',
  'fs_symlink_refused',
  'fs_recursive_refused',
]);

/** The directory part, without pulling in a path module for one line. */
function parentOf(filePath) {
  const cut = filePath.lastIndexOf('/');
  return cut <= 0 ? '/' : filePath.slice(0, cut);
}

/**
 * Builds the adapter for one project root.
 *
 * The root is resolved once, at construction: resolving it per call would let a
 * root that became a symlink halfway through a run move where writes land.
 */
export async function projectFs(node, { root }) {
  const resolvedRoot = await node.realpath(root);
  // The filesystem root is not a project. Every containment check here is
  // "inside `<root>/`", and with `<root>` empty or `/` that reads as "inside
  // anything" — the one answer this adapter exists to never give.
  demand(resolvedRoot.length > 1 && resolvedRoot.startsWith('/'),
    'fs_outside_project', 'A project root is a directory, not the filesystem root',
    { root: resolvedRoot });

  /** Where a path really is, and a refusal when that is not inside the project. */
  async function resolveInside(target) {
    const parent = parentOf(target);
    let resolvedParent;
    try {
      resolvedParent = await node.realpath(parent);
    } catch {
      // The parent does not exist yet; it is created below, inside the project.
      resolvedParent = parent;
    }
    const resolved = `${resolvedParent}/${target.slice(target.lastIndexOf('/') + 1)}`;
    demand(resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}/`),
      'fs_outside_project', 'The path is not inside the project', { target, resolved, root: resolvedRoot });
    return resolved;
  }

  async function assertRegular(resolved, { forWriting }) {
    let stat;
    try {
      stat = await node.lstat(resolved);
    } catch {
      // Nothing there: a write creates it, a read has nothing to refuse about.
      return null;
    }
    demand(!stat.isSymbolicLink(), 'fs_symlink_refused',
      forWriting ? 'A write does not follow a symlink' : 'A read does not follow a symlink', { resolved });
    demand(stat.isFile(), 'fs_not_regular', 'Not a regular file', { resolved });
    return stat;
  }

  return Object.freeze({
    root: resolvedRoot,
    /** Named so a caller can record which adapter cleared a plan. */
    adapter: 'safe_project_fs',

    async realpath(target) {
      return node.realpath(target);
    },

    async lstat(target) {
      const stat = await node.lstat(target);
      return Object.freeze({
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymbolicLink: stat.isSymbolicLink(),
        size: stat.size,
        nlink: stat.nlink,
      });
    },

    async readFile(target) {
      const resolved = await resolveInside(target);
      await assertRegular(resolved, { forWriting: false });
      return node.readFile(resolved);
    },

    async writeFile(target, bytes) {
      const resolved = await resolveInside(target);
      await assertRegular(resolved, { forWriting: true });
      return node.writeFile(resolved, bytes);
    },

    async mkdir(target) {
      const resolved = await resolveInside(target);
      return node.mkdir(resolved);
    },

    /** One named file. A directory or a link is refused rather than removed. */
    async rm(target) {
      const resolved = await resolveInside(target);
      const stat = await assertRegular(resolved, { forWriting: true });
      demand(stat !== null, 'fs_not_regular', 'Nothing to remove at that path', { resolved });
      return node.unlink(resolved);
    },

    /** Recursive deletion is not offered, and saying so is the point. */
    async rmrf() {
      demand(false, 'fs_recursive_refused',
        'This adapter does not delete trees; delete the files a plan named', {});
    },
  });
}
