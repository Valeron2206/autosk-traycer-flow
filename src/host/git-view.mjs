/** The handout for the Git view a model step and a check run in.
 *
 * A model process runs under the model account, which opens no Git directory
 * of the project (docs/contracts/platform-support.md §5b, ADR-102), so its own
 * `git` in a checkout found no repository, and a suite that calls `git`, the
 * repository's own among them, failed under the account (round 9 of #39,
 * R9-1). ADR-110 gives the account a repository of its own at the checkout's
 * root, which the launch builds under the account from what this hands over:
 * a pack of the handed commit and the line down to a base, written by autoskd,
 * as the installing user, into a directory it names.
 *
 * What this function is for is what leaves the project's Git directory. It
 * hands over the handed commit and its history down to a boundary and nothing
 * else — no ref, no reflog, no configuration, no object of another line — and
 * it refuses a commit outside the line the caller names, so what a model can
 * read is never more than the line it was given. It writes no ref into the
 * project either: a pack needs none, where a bundle asks for a ref name and
 * cannot be shallow (measured, ADR-110).
 *
 * autoskd never reads the view the launch builds from it, and this reads
 * nothing of a checkout: it asks the repository, where the caller's `git` runs.
 *
 * Injected: `git(args, { input } = {})`, returning `{ code, stdout, stderr }`,
 * with `input` written to the command's stdin.
 */
import path from 'node:path';

import { demand, immutable, oneObjectFormat } from '../runtime/contracts.mjs';

export const GIT_VIEW_FORMAT = 'autosk-git-view/v1';

/** Every command of this module reads the true objects, whatever replace refs the user wrote (§5a). */
const TRUE_OBJECTS = '--no-replace-objects';

async function ask(git, args, options) {
  const result = await git([TRUE_OBJECTS, ...args], options);
  demand(result.code === 0, 'git_view_git_failed', `git ${args[0]} exited ${result.code}`,
    { args: immutable([...args]), stderr: (result.stderr ?? '').trim().slice(0, 200) });
  return result;
}

/**
 * Whether `ancestor` is `descendant` or lies below it. Git answers 0 and 1 for
 * yes and no; anything else — a commit the repository does not have — is a
 * failure, and is not read as a no.
 */
async function reaches(git, ancestor, descendant) {
  const result = await git([TRUE_OBJECTS, 'merge-base', '--is-ancestor', ancestor, descendant]);
  demand(result.code === 0 || result.code === 1, 'git_view_git_failed', `git merge-base exited ${result.code}`,
    { stderr: (result.stderr ?? '').trim().slice(0, 200) });
  return result.code === 0;
}

/**
 * Writes the handout for a launch: the pack of `commit`, with its history down
 * to `since` — `since`'s own tree included, its parents not — into `dir`.
 *
 * `line` names the tips the commit must lie on or below, the Epic's staging
 * commit for a check and a model step's own base for a Ticket; a commit no tip
 * reaches is another line's, and is refused before anything is written.
 * `since` defaults to the commit itself: the handed commit alone, with no
 * history. It must lie on the commit's history, or the pack would carry
 * commits the boundary does not cut.
 *
 * `dir` is absolute and made by the caller: the installing user's, and closed
 * to a write by the model account's group (§5b). Returns the manifest the
 * launch reads — the commit, the boundary, the object format and the two file
 * names — and writes nothing else.
 */
export async function handOutGitView(git, { dir, commit, line, since }) {
  const boundary = since ?? commit;
  const tips = Array.isArray(line) ? line : [];
  const object_format = oneObjectFormat([commit, boundary, ...tips]);
  demand(object_format !== null && tips.length > 0, 'git_view_oid_invalid',
    'The handout names full object ids of one format: the commit, the boundary and at least one tip of the line');
  demand(typeof dir === 'string' && path.isAbsolute(dir), 'git_view_dir_invalid', 'The handout goes into an absolute directory the caller made');

  let onLine = false;
  for (const tip of tips) {
    if (await reaches(git, commit, tip)) {
      onLine = true;
      break;
    }
  }
  demand(onLine, 'git_view_commit_outside_line', 'The commit is on none of the line\'s tips, so its history is another line\'s',
    { commit, line: immutable([...tips]) });
  demand(await reaches(git, boundary, commit), 'git_view_boundary_invalid',
    'The boundary is not on the commit\'s history', { commit, since: boundary });

  // `--shallow` cuts the walk at the boundary, whose own commit and tree are kept.
  const packed = await ask(git, ['-c', 'pack.writeReverseIndex=false', 'pack-objects', '--revs', '--quiet', path.join(dir, 'view')],
    { input: `--shallow ${boundary}\n${commit}\n` });
  const name = packed.stdout.trim();
  demand(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/u.test(name), 'git_view_git_failed', 'git pack-objects named no pack', { stdout: packed.stdout.slice(0, 80) });
  return Object.freeze({
    format: GIT_VIEW_FORMAT,
    object_format,
    commit,
    since: boundary,
    pack: `view-${name}.pack`,
    idx: `view-${name}.idx`,
  });
}
