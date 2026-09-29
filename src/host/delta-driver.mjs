/** Applying an approved delta to staging, against a real repository.
 *
 * #8 decides what a delta is and what proves it was integrated; this performs
 * the integration. The rule that shapes every line here: the driver may
 * reference blobs that already exist and were approved, and may not produce
 * content. A conflict resolved by writing new content produces bytes nobody
 * reviewed, and no amount of care in choosing them makes them reviewed.
 *
 * The apply runs in a temporary index, so the operator's worktree and index are
 * not touched — an integration that requires a clean checkout is an integration
 * that cannot run while someone is working.
 *
 * The injected `git(args, { env } = {})` runs one command and returns
 * `{ code, stdout, stderr }`, applying `env` on top of its own. `realpath` is
 * injected for the same reason: the module resolves paths, it does not read the
 * filesystem itself. The staging ref is not written here at all: the apply
 * asks the ref-custody helper to advance it (`custody`, ADR-095).
 *
 * The apply keeps its identity across a crash (debt 12g, R8-9). Before the
 * helper is asked, the host records a recipe for the delta's commit — the tree,
 * the parent, the host identity and dates, the message and the commit's exact
 * bytes, hence its OID — in a durable journal (`recipes`, `recipeJournal` of
 * `staging-lineage.mjs`), under a scoped key (`applyKey`: the staging ref, the
 * operation id, the base and the delta digest, so two Epics or two bases that
 * name an operation alike share nothing), and the request carries the pair
 * derived from that key (`custodyIdentity`), so the daemon-side intent a retry
 * must find is the one already made. A retry that finds the staging ref at the
 * recipe's commit, written by the helper (its own reflog message), has found its
 * own apply already done: it completes the result, and so the receipt, from the
 * recipe and asks nothing. A ref at the recorded base whose reflog has moved
 * since the recipe was made was rewound after the helper committed: the helper
 * is not asked to move it forward again. A ref anywhere else is not this
 * operation's movement. All of these are one stop, `receipt_missing` at
 * `apply_staging` (`epic-staging.md` §7), refused before the helper is asked;
 * so is a journal or a recipe that cannot vouch for the apply, since without
 * it the receipt cannot be restored. A rebuild or a re-stage re-applies under a
 * fresh operation, with a recipe and a pair of its own.
 *
 * `git(args, { env, stdin })` takes a standard input for `hash-object`, which
 * writes a commit again from the bytes the recipe holds.
 *
 * Every refusal of the apply reaches the graph as a stop it carries at
 * `apply_staging` (debt 13a, R9-3, ADR-109). The approved delta's twelve
 * names (`approved-delta.md` §9) are the contract's vocabulary, and the graph
 * has four stops for this step that an apply can report: `delta_stale`,
 * `receipt_missing`, `environment_failure` and `planning_ref_capability_missing`.
 * `APPLY_STOPS` maps each name to its stop, once for a refusal raised before
 * the ref moves (`before`, thrown) and once for a proof that fails on the
 * result the apply returns (`after`, recorded in the receipt); `applyDelta`
 * throws the stop with the contract's name as `details.cause`, `applyOutcome`
 * names the stop of a receipt, and `applyWithOutcome` is what a step body calls:
 * a refusal comes back as `stop`, the value the graph's predicates read as
 * `apply_outcome`, and is never thrown into the daemon to become a park with no
 * reason, which the factory's `admit` lets re-enter the step. What is thrown
 * past it is a host invariant (`custody_request_invalid`, no task's state).
 */
import { createHash } from 'node:crypto';

import { FlowError, boundedText, demand, frozenCopy, immutable, oidFormat, safeDetails } from '../runtime/contracts.mjs';

import {
  collisionErrors,
  environmentErrors,
  integrationProof,
  revalidate,
  withinPathspec,
} from './approved-delta.mjs';
import { NO_REF_CUSTODY, askCustody, custodyIdentity } from './ref-custody.mjs';
import { assertStagingRef, readRef, reflogDepth, reflogNewest } from './staging-driver.mjs';

/**
 * Where each of the approved delta's twelve names (`approved-delta.md` §9) lands at `apply_staging`.
 *
 * `before`: the stop of a refusal raised before the staging ref moves, thrown by `applyDelta` with the contract's name as
 * `cause`. `after`: the stop of a proof that fails on the result the apply returns, which the receipt records as `prepared`
 * (`applyOutcome`). `null` is a phase the name is not raised in. A delta that no longer applies as approved is `delta_stale`;
 * the environment the apply runs in — an inherited Git variable, a temporary index inside the project, a file of the
 * operator's in the way — is `environment_failure`, no verdict on the delta, and a resume applies again once it is put
 * right; what the ref or the result shows after the helper was asked is `receipt_missing`, the line and the receipts no
 * longer agreeing. `dirty_worktree` is raised by nothing on this path (`worktreeErrors` has no caller and the apply runs
 * in a temporary index): its `before` is `null` and the test that says so is the proof.
 */
export const APPLY_STOPS = immutable({
  delta_stale: { before: 'delta_stale', after: null },
  scope_violation: { before: 'delta_stale', after: 'receipt_missing' },
  containment_mismatch: { before: 'delta_stale', after: 'receipt_missing' },
  unreviewed_bytes: { before: null, after: 'receipt_missing' },
  untracked_collision: { before: 'environment_failure', after: null },
  ignored_collision: { before: 'environment_failure', after: null },
  inherited_git_env: { before: 'environment_failure', after: null },
  state_identity_collision: { before: 'environment_failure', after: null },
  dirty_worktree: { before: null, after: null },
  foreign_ref_movement: { before: null, after: 'receipt_missing' },
  indeterminate_post_state: { before: null, after: 'receipt_missing' },
  reflog_ambiguous: { before: null, after: 'receipt_missing' },
});

/** The stops of the graph at `apply_staging` that an apply reports; the anchor's own stop, which an apply never raises, is not among them. */
export const APPLY_STOP_REASONS = immutable(['delta_stale', 'receipt_missing', 'environment_failure', 'planning_ref_capability_missing']);

/** Movement is named before content when a result fails on both: a ref nobody can vouch for outranks a byte mismatch. */
const MOVEMENT_NAMES = immutable(['foreign_ref_movement', 'indeterminate_post_state', 'reflog_ambiguous']);

/** A refusal raised inside the apply, made the stop the graph carries: the contract's name becomes the `cause`. */
function asStop(error) {
  if (!(error instanceof FlowError) || !Object.hasOwn(APPLY_STOPS, error.code) || APPLY_STOPS[error.code].before === null) return error;
  return new FlowError(APPLY_STOPS[error.code].before, error.message, { ...error.details, cause: error.code });
}

/** One git invocation. A command that could not run says nothing about the product. */
async function ask(git, args, options = {}) {
  const result = await git(args, options);
  if (result.code !== 0) {
    demand(false, 'environment_failure', `git ${args[0] === '-c' ? args[2] : args[0]} exited ${result.code}`,
      { args: frozenCopy([...args]), stderr: boundedText((result.stderr ?? '').trim(), 200) });
  }
  return result;
}

/**
 * The environment an apply may run in.
 *
 * Refused rather than cleaned in place: cleaning it would hide how it got
 * there, and an inherited variable silently redirects every command that
 * follows.
 */
export function assertCleanEnvironment(env) {
  const errors = environmentErrors(env);
  demand(errors.length === 0, 'inherited_git_env', 'The environment carries inherited Git variables',
    { names: immutable(errors.map((error) => error.detail)) });
}

/** What the worktree holds that is not committed, read rather than assumed. */
export async function worktreeState(git, options = {}) {
  // NUL-separated, so that a path git would quote is read as it is written; a rename or copy is followed by the path it came from.
  const status = await ask(git, ['status', '--porcelain', '-z', '--untracked-files=all'], options);
  const untracked = [];
  let dirty = false;
  const entries = status.stdout.split('\0');
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.startsWith('?? ')) untracked.push(entry.slice(3));
    else if (entry.trim().length > 0) dirty = true;
    if (/^[RC]/u.test(entry) || /^.[RC]/u.test(entry)) index += 1;
  }
  return Object.freeze({ untracked: frozenCopy(untracked), dirty });
}

/**
 * Where the temporary index may live.
 *
 * Not inside the project: a leftover index file there is untracked state that
 * looks like somebody's work, and the next apply refuses on the collision it
 * created itself.
 */
export async function assertIndexOutsideProject(git, { indexFile, realpath }) {
  const top = await git(['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return;
  const root = top.stdout.trim();
  if (root.length === 0) return;
  // Both sides resolved, because git answers with the real path and a caller
  // holding a path through a symlink would compare two spellings of the same
  // directory and conclude they are different ones.
  const [resolvedRoot, resolvedDir] = await Promise.all([realpath(root), realpath(dirname(indexFile))]);
  demand(resolvedDir !== resolvedRoot && !resolvedDir.startsWith(`${resolvedRoot}/`),
    'state_identity_collision', 'The temporary index would sit inside the project',
    { indexFile, root: resolvedRoot });
}

/** The directory part of a path, without pulling in a path module for one line. */
function dirname(filePath) {
  const cut = filePath.lastIndexOf('/');
  return cut <= 0 ? '/' : filePath.slice(0, cut);
}

/**
 * Composes the tree an approved delta produces, in a temporary index.
 *
 * Every entry names a blob that already exists in the repository, so this is
 * assembly, not authorship: `update-index --cacheinfo` refuses an object that
 * is not there, and there is no path by which the driver could invent one.
 */
export async function composeTree(git, { delta, base, indexFile, realpath }) {
  await assertIndexOutsideProject(git, { indexFile, realpath });
  const env = { GIT_INDEX_FILE: indexFile };
  await ask(git, ['read-tree', base], { env });
  for (const entry of delta.entries) {
    if (entry.status === 'D') {
      await ask(git, ['update-index', '--force-remove', '--', entry.path], { env });
      continue;
    }
    if (entry.status === 'R') {
      // A rename is the old path leaving and the new one arriving. Recording it
      // as one operation is what makes the old path's disappearance reviewed.
      await ask(git, ['update-index', '--force-remove', '--', entry.from_path], { env });
    }
    await ask(git, [
      'update-index', '--add', '--cacheinfo', `${entry.new_mode},${entry.new_blob},${entry.path}`,
    ], { env });
  }
  const tree = await ask(git, ['write-tree'], { env });
  return tree.stdout.trim();
}

/**
 * What the written tree actually holds, for the paths this delta claims.
 *
 * Read back from the tree rather than echoed from the request: an apply that
 * reports what it was asked to do proves nothing about what it did.
 *
 * Compared against the base tree, because *introduced* means introduced by this
 * apply. A file another Ticket already integrated is in scope and was not
 * introduced here, and reporting it as unapproved is the full-tree false
 * negative this issue exists to remove.
 */
export async function appliedEntries(git, { tree, baseTree, delta, options = {} }) {
  const [now, before] = await Promise.all([
    listTree(git, tree, options),
    baseTree ? listTree(git, baseTree, options) : Promise.resolve(new Map()),
  ]);
  const applied = [];
  for (const path of new Set(delta.entries.map((entry) => entry.path))) {
    const held = now.get(path);
    if (held) applied.push(Object.freeze({ path, ...held }));
  }
  // Anything else in scope that this apply changed is reported too, so
  // introducing an unapproved path is visible to the proof rather than filtered
  // out here.
  for (const [path, held] of now) {
    if (applied.some((entry) => entry.path === path)) continue;
    if (!withinPathspec(delta.pathspec, path)) continue;
    const was = before.get(path);
    if (!was || was.new_blob !== held.new_blob || was.new_mode !== held.new_mode) {
      applied.push(Object.freeze({ path, ...held }));
    }
  }
  return frozenCopy(applied.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

/** One tree, as path → blob and mode; a blob OID in either object format (ADR-098). */
async function listTree(git, tree, options) {
  // NUL-separated, so that a path git would quote (a name that is not ASCII, or has a tab or a newline) is read as it is written.
  const listing = await ask(git, ['ls-tree', '-r', '-z', '--full-tree', tree], options);
  const held = new Map();
  for (const line of listing.stdout.split('\0')) {
    // A gitlink is a `commit` entry of mode 160000 (a submodule), as much an entry of the tree as a blob (P1).
    const match = /^(\d{6}) (?:blob|commit) ([0-9a-f]+)\t([\s\S]*)$/u.exec(line);
    if (match && oidFormat(match[2]) !== null) held.set(match[3], { new_mode: match[1], new_blob: match[2] });
  }
  return held;
}

/**
 * What this apply removed, inside the Ticket's scope.
 *
 * A removal is invisible to a check that only inspects the paths still there,
 * so it is reported rather than left to be inferred from an absence.
 */
export async function removedPaths(git, { tree, baseTree, delta, options = {} }) {
  if (!baseTree) return frozenCopy([]);
  const [now, before] = await Promise.all([
    listTree(git, tree, options),
    listTree(git, baseTree, options),
  ]);
  const gone = [];
  for (const path of before.keys()) {
    if (!now.has(path) && withinPathspec(delta.pathspec, path)) gone.push(path);
  }
  return frozenCopy(gone.sort());
}

/** Whether paths another Ticket integrated are still in the tree. */
export async function preservedPaths(git, { tree, paths, options = {} }) {
  if (paths.length === 0) return frozenCopy([]);
  const listing = await ask(git, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', tree], options);
  const present = new Set(listing.stdout.split('\0').filter(Boolean));
  return frozenCopy(paths.map((path) => Object.freeze({ path, present: present.has(path) })));
}


const RECIPE_SCHEMA = 1;
// Git takes a date of nine digits or more: a shorter one is another format, and its own exit 128.
const DATE = /^\d{9,12} [+-]\d{4}$/u;
const SAFE_NAME = /^[^<>\n\0]+$/u;
const SAFE_EMAIL = /^[^<>\n\0@\s]+@[^<>\n\0@\s]+$/u;

/** The host's commit identity, checked: it goes into the commit's bytes, so it may not carry a delimiter. */
function assertAuthor(author) {
  demand(author !== null && typeof author === 'object' && typeof author.name === 'string' && SAFE_NAME.test(author.name)
    && typeof author.email === 'string' && SAFE_EMAIL.test(author.email)
    && typeof author.date === 'string' && DATE.test(author.date), 'custody_request_invalid',
  'The apply commits under a host identity: a name, an email and a "<seconds> <zone>" date', {});
  return Object.freeze({ name: author.name, email: author.email, date: author.date });
}

/** The recipe journal: something that can say what it holds and hold what it is given. */
function assertRecipes(recipes) {
  demand(recipes !== null && typeof recipes === 'object' && typeof recipes.load === 'function' && typeof recipes.save === 'function',
    'custody_request_invalid', 'An apply is journaled before it asks the helper, and no recipe journal was given', {});
  return recipes;
}

/** The environment that fixes a commit's author, committer and both dates. */
function identityEnv(author) {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: author.date,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_COMMITTER_DATE: author.date,
  };
}

/**
 * The scoped key an apply's recipe and request pair rest on: the staging ref
 * (which names the project and the Epic), the operation id, the base commit and
 * the delta digest. The operation id alone is a free string the plan's author
 * chose, so two Epics, two projects or two bases could name one alike and would
 * have shared a recipe and the pair of a request that already committed.
 */
export function applyKey({ ref, delta, base }) {
  return createHash('sha256')
    .update(`autosk-flow/staging-apply-key/v1\0${ref}\0${delta.operation_id}\0${base.commit_oid}\0${delta.delta_digest}`, 'utf8')
    .digest('hex');
}

/**
 * The commit a recipe describes, made once from its fields. `commit-tree` takes
 * the repository's configuration into account — `i18n.commitEncoding` re-encodes
 * the message and adds a header — so the encoding is pinned; `commit.gpgsign`
 * and hooks do not apply to `commit-tree`.
 */
async function makeRecipeCommit(git, recipe, options = {}) {
  const env = { ...(options.env ?? {}), ...identityEnv(recipe.author) };
  const commit = await ask(git, ['-c', 'i18n.commitEncoding=UTF-8', 'commit-tree', recipe.tree_oid, '-p', recipe.base_commit_oid, '-m', recipe.message],
    { ...options, env });
  return commit.stdout.trim();
}

/** A commit object written again from the exact bytes the recipe recorded: whatever the configuration says now. */
async function rewriteRecipeCommit(git, recipe, options = {}) {
  const bytes = Buffer.from(recipe.commit_object_bytes_base64, 'base64').toString('utf8');
  const written = await ask(git, ['hash-object', '-t', 'commit', '-w', '--stdin'], { ...options, stdin: bytes });
  return written.stdout.trim();
}

/**
 * The newest reflog entry of a ref, as a digest of what identifies it: the OID it moved the ref to, its selector with
 * the time it was made, who made it, and its message. Null when the ref keeps no reflog. A ref deleted and made again
 * at the same commit has the same reflog depth as when a recipe was made and another newest entry. The entry is read
 * as `reflogNewest` reads it — marked, with a repository's display options (a signature report) switched off — and a
 * read that fails is an environment failure, never the absence of an entry a recipe would then record.
 */
async function reflogHead(git, ref) {
  const entry = await reflogNewest(git, ref, '%H%x1f%gd%x1f%gn%x1f%ge%x1f%gs');
  return entry === null ? null : createHash('sha256').update(entry, 'utf8').digest('hex');
}

/** The message of the newest reflog entry of a ref, or null when it keeps none. */
async function newestReflogMessage(git, ref) {
  return reflogNewest(git, ref, '%gs');
}

/**
 * Where a ref that is not the base and not the recipe's commit went, from where it is:
 * `behind` the base (a rewind, to a commit the receipts may cover), `beyond` it (a
 * commit on top that no receipt covers), or `unrelated` to it.
 */
async function movementOf(git, held, base) {
  if (held === null) return 'unrelated';
  if (await isAncestor(git, held, base)) return 'behind';
  if (await isAncestor(git, base, held)) return 'beyond';
  return 'unrelated';
}

/**
 * Whether `older` is an ancestor of `newer`. `merge-base --is-ancestor` answers with its exit: 0 is yes and 1 is no, and
 * any other exit is git failing — a locked repository, a missing object — which says nothing about where the ref went and
 * is an environment failure with the command and a bounded stderr (#280 carry, the rule F4 of 12g gave the reflog reads).
 */
async function isAncestor(git, older, newer) {
  const args = ['merge-base', '--is-ancestor', older, newer];
  const result = await git(args);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  return demand(false, 'environment_failure', `git merge-base exited ${result.code}`,
    { args: frozenCopy([...args]), stderr: boundedText((result.stderr ?? '').trim(), 200) });
}

/**
 * The refusal for a staging ref that is not where this operation left it — and for a journal or a recipe that cannot
 * say where that was: the line and the receipts no longer agree, and nothing restores them by itself. `receipt_missing`
 * is the one stop the graph has at `apply_staging` for it; `cause` says which.
 */
async function refuseMovement(git, { ref, held, expected, base, cause = 'movement', movement = null }) {
  demand(false, 'receipt_missing', 'The staging ref is not where this apply left it: the receipts and the staging line no longer agree',
    { ref, expected: immutable([...expected]), held, movement: movement ?? await movementOf(git, held, base), cause });
}

/** A recipe that cannot vouch for the apply, refused by the same name as the movement that would follow from trusting it. */
function refuseRecipe(cause, details) {
  demand(false, 'receipt_missing', 'The recorded recipe cannot vouch for this apply: the receipts cannot be restored from it', { cause, ...details });
}

/**
 * The failure of something the apply was handed — a git runner, a `realpath`, a journal — as the environment's, with the errno as its
 * cause. Cause and message are bounded, because they are whatever the dependency said.
 */
function dependencyFailure(what, error) {
  const code = typeof error?.code === 'string' && error.code.length > 0 ? boundedText(error.code, 64) : null;
  const said = typeof error?.message === 'string' && error.message.length > 0 ? `: ${boundedText(error.message, 200)}` : '';
  // A journal that fails raw is the journal's own I/O, as `recipeJournal` names it.
  return new FlowError('environment_failure', `The apply's ${what} failed${said}`,
    { cause: what === 'journal' ? 'journal_io' : (code ?? 'dependency_failed'), errno: code, dependency: what });
}

/**
 * Runs an injected function and keeps its failure inside the apply: what it throws — a raw error, or a FlowError that is not one of the
 * stops the apply reports — is that dependency's failure, and what it hands back has to have the shape the apply reads, or that is its
 * failure too (`bad_result`). A stop the dependency raises itself (a journal that cannot vouch) passes as it is. Anything else thrown
 * out of the apply would fail the step, and the daemon would park it with no reason.
 */
function guarded(what, fn, shaped = () => true) {
  return async (...args) => {
    let answer;
    try {
      answer = await fn(...args);
    } catch (error) {
      if (error instanceof FlowError && APPLY_STOP_REASONS.includes(error.code)) throw error;
      if (error instanceof FlowError) {
        throw new FlowError('environment_failure', `The apply's ${what} failed: ${boundedText(error.message, 200)}`,
          { cause: boundedText(error.code, 64), errno: null, dependency: what });
      }
      throw dependencyFailure(what, error);
    }
    if (!shaped(answer)) throw dependencyFailure(what, { code: 'bad_result', message: `answered ${answer === null ? 'null' : typeof answer}` });
    return answer;
  };
}

/** What the apply reads of one command: an exit code and the text on both streams. */
const commandAnswered = (answer) => answer !== null && typeof answer === 'object' && Number.isInteger(answer.code)
  && typeof answer.stdout === 'string' && (answer.stderr === undefined || typeof answer.stderr === 'string');
const pathResolved = (answer) => typeof answer === 'string' && answer.length > 0;

/**
 * The objects a delta names are blobs that are in the repository, or the delta cannot be assembled as approved: that is the delta's, not
 * the machine's (P2). A path that names a tree or a commit is no file — the tree it made would fail `git fsck` — so the type is read too (N9).
 */
async function assertApprovedObjects(git, delta, options = {}) {
  // A gitlink names a commit of another repository, which need not be here.
  const wanted = [...new Set(delta.entries.filter((entry) => entry.status !== 'D' && entry.new_mode !== '160000').map((entry) => entry.new_blob))];
  if (wanted.length === 0) return;
  const answer = await ask(git, ['cat-file', '--batch-check'], { ...options, stdin: `${wanted.join('\n')}\n` });
  const seen = new Map();
  for (const line of answer.stdout.split('\n')) {
    const [name, type] = line.split(' ');
    if (name) seen.set(name, type);
  }
  const wrong = wanted.find((name) => seen.get(name) !== 'blob');
  demand(wrong === undefined, 'containment_mismatch',
    seen.get(wrong) === 'missing' || seen.get(wrong) === undefined ? 'An approved blob is not in the repository' : 'An approved blob is not a blob',
    { detail: `${wrong}: ${seen.get(wrong) === 'missing' || seen.get(wrong) === undefined ? 'no such object' : `is a ${seen.get(wrong)}, not a blob`}` });
}

/** The apply itself: refusals leave it under the contract's names or as stops; `applyDelta` makes every one a stop. */
async function applyInside(rawGit, {
  custody = NO_REF_CUSTODY,
  recipes,
  author,
  delta,
  ref,
  base,
  indexFile,
  env = {},
  message,
  realpath: rawRealpath,
  worktree,
  otherTicketPaths = [],
  options = {},
}) {
  const git = guarded('git runner', rawGit, commandAnswered);
  const realpath = guarded('realpath', rawRealpath, pathResolved);
  // The apply asks for the private staging ref and nothing else: a target ref
  // is the daemon's integrateApproved's to move (ADR-088), and the helper
  // writes every ref under refs/autosk/** (ADR-095).
  assertStagingRef(ref);
  assertCleanEnvironment(env);
  const checked = assertRecipes(recipes);
  const loadRecipe = guarded('journal', checked.load.bind(checked));
  const journal = {
    // A journal answers with the recipe it holds or with nothing (`null`); anything else cannot vouch for the apply.
    load: async (name) => {
      const held = await loadRecipe(name);
      if (held !== null && (typeof held !== 'object' || Array.isArray(held))) refuseRecipe('journal', { operation_id: delta.operation_id });
      return held;
    },
    save: guarded('journal', checked.save.bind(checked)),
  };
  const hostIdentity = assertAuthor(author);
  // Revalidated immediately before the apply, not when it was approved: the
  // staging base moves as other Tickets integrate, and `revalidate` validates
  // the delta as well as its base — a separate `validateDelta` call here would
  // be a second check with the same answer.
  const stale = revalidate(delta, base);
  demand(stale.length === 0, stale[0]?.reason ?? 'delta_stale', 'The delta does not validate against this base',
    { detail: stale[0]?.detail });
  if (worktree) {
    // Fail-closed, and the file stays where it is. Clearing it would destroy
    // work nobody has reviewed to make room for work that was.
    const collisions = collisionErrors(delta, worktree);
    demand(collisions.length === 0, collisions[0]?.reason ?? 'untracked_collision',
      'A file is in the way at an approved path', { detail: collisions[0]?.detail });
  }

  // The recipe under this apply's scoped key is this apply's by construction; one that says otherwise is a journal
  // that cannot vouch for it (a line edited, or read back wrong), and the receipt cannot be restored from it.
  const key = applyKey({ ref, delta, base });
  // The pair the request is made under is derived once, from the key: a recipe found in the journal is checked against it
  // and the request never reads it back from the recipe (#280 carry).
  const identity = custodyIdentity(key, 'advance_staging');
  const recorded = await journal.load(key);
  if (recorded !== null) {
    if (!(recorded.schema === RECIPE_SCHEMA && recorded.apply_key === key && recorded.delta_digest === delta.delta_digest
      && recorded.ref === ref && recorded.base_commit_oid === base.commit_oid && recorded.base_tree_oid === base.tree_oid
      && recorded.owner_operation_id === identity.owner_operation_id && recorded.request_id === identity.request_id)) {
      refuseRecipe('recipe', { operation_id: delta.operation_id });
    }
  }

  // Where the ref is decides what this call is: the apply not yet made, or the one this operation already made.
  const held = await readRef(git, ref);
  const own = recorded?.expected_commit_oid ?? null;
  const expected = own === null ? [base.commit_oid] : [base.commit_oid, own];
  if (held !== base.commit_oid && held !== own) {
    await refuseMovement(git, { ref, held, expected, base: base.commit_oid });
  }
  // At the base, after the recipe: the reflog says whether the helper moved the ref since and somebody moved it back —
  // or deleted it and made it again, which starts the reflog over at the same depth and another newest entry. It is not
  // asked to move it forward over that (ADR-102: a protected ref moved by the user's tool is never overwritten), and
  // never again under the pair of a request that already committed.
  if (recorded !== null && held === base.commit_oid
    && ((await reflogDepth(git, ref)) !== recorded.reflog_before || (await reflogHead(git, ref)) !== recorded.reflog_head)) {
    await refuseMovement(git, { ref, held, expected, base: base.commit_oid, cause: 'reflog', movement: 'behind' });
  }

  await assertApprovedObjects(git, delta, options);
  const tree = await composeTree(git, { delta, base: base.commit_oid, indexFile, realpath });
  let recipe = recorded;
  if (recipe === null) {
    const draft = {
      schema: RECIPE_SCHEMA,
      apply_key: key,
      operation_id: delta.operation_id,
      delta_digest: delta.delta_digest,
      ref,
      base_commit_oid: base.commit_oid,
      base_tree_oid: base.tree_oid,
      tree_oid: tree,
      message,
      author: hostIdentity,
      ...identity,
      reflog_before: await reflogDepth(git, ref),
      reflog_head: await reflogHead(git, ref),
    };
    // The commit is made once, from the recipe's own fields; its OID and its exact bytes are what the recipe records.
    const oid = await makeRecipeCommit(git, draft, options);
    const raw = await ask(git, ['cat-file', 'commit', oid], options);
    recipe = Object.freeze({ ...draft, commit_object_bytes_base64: Buffer.from(raw.stdout, 'utf8').toString('base64'), expected_commit_oid: oid });
    await journal.save(recipe);
  } else if (recipe.tree_oid !== tree) {
    refuseRecipe('recipe', { operation_id: delta.operation_id, recorded: recipe.tree_oid, composed: tree });
  }
  const commit = recipe.expected_commit_oid;
  // What the helper writes when it moves the staging ref (`epic-planning-ref.md`): a ref at this operation's commit
  // whose newest reflog entry is somebody else's is bytes written by another hand, and is not adopted.
  const helperSaid = `autosk-flow staging ${identity.owner_operation_id}`;

  let swapped = held === commit;
  let recovered = swapped;
  let refused = null;
  if (!swapped) {
    // The object is the recipe's: written again, from its recorded bytes, if a prune took it; and never another.
    if ((await git(['cat-file', '-e', `${commit}^{commit}`])).code !== 0 && await rewriteRecipeCommit(git, recipe, options) !== commit) {
      refuseRecipe('recipe_bytes', { operation_id: delta.operation_id, commit });
    }
    // The helper's refusal is the swap not happening; what the ref held instead
    // is its observation, reported rather than taken as the reason. A refusal that
    // observed this operation's own commit is the swap already done.
    const movement = await askCustody(custody, 'advance_staging',
      [{ operation: 'update', ref, expected_old_oid: base.commit_oid, new_oid: commit }],
      identity);
    swapped = movement.status === 'committed';
    if (!swapped) {
      refused = movement.ref_observations[0].observed_old_oid;
      recovered = refused === commit;
      swapped = recovered;
    }
  }
  const observed = await readRef(git, ref);
  // A helper that committed says the ref is at the commit: anywhere else is not this apply's.
  if (swapped && observed !== commit) {
    await refuseMovement(git, { ref, held: observed, expected: [commit], base: base.commit_oid });
  }
  if (recovered && await newestReflogMessage(git, ref) !== helperSaid) {
    await refuseMovement(git, { ref, held: observed, expected: [commit], base: base.commit_oid, cause: 'reflog' });
  }

  return Object.freeze({
    operation_id: delta.operation_id,
    base_commit_oid: delta.base_commit_oid,
    tree_oid: tree,
    commit_oid: commit,
    applied: swapped,
    recovered_from_recipe: recovered,
    applied_entries: await appliedEntries(git, { tree, baseTree: base.tree_oid, delta, options }),
    removed_paths: await removedPaths(git, { tree, baseTree: base.tree_oid, delta, options }),
    preserved_from_other_tickets: await preservedPaths(git, { tree, paths: otherTicketPaths, options }),
    conflicts_resolved_by_new_content: false,
    ref_movement: Object.freeze({
      ref,
      expected_old_oid: base.commit_oid,
      observed_old_oid: swapped ? base.commit_oid : refused,
      post_state: observed === null ? 'unknown' : 'known',
      reflog_entries: (await reflogDepth(git, ref)) - recipe.reflog_before,
    }),
  });
}

/**
 * Applies one approved delta to the staging ref.
 *
 * The order is the one the contract requires: revalidate against the exact
 * base, refuse a collision rather than clear it, read where the staging ref is
 * (a ref that is neither the base nor this operation's own commit is refused
 * before anything is written), compose, record the recipe of the commit,
 * ask the helper to advance the ref by compare-and-swap under the operation's
 * identity, and read back what the tree holds. Nothing here resolves a
 * conflict; a conflict is a refusal.
 *
 * `author` is the host identity the commit is made under — a name, an email and
 * a git date — recorded in the recipe with the message, so it is used once, when
 * the recipe is made: a retry regenerating either changes nothing (no post-crash
 * call regenerates author data, dates or the message; `epic-planning-ref.md` §8).
 * `base` is the recorded staging base, the same one on a retry.
 */
export async function applyDelta(git, options) {
  try {
    return await applyInside(git, options);
  } catch (error) {
    throw asStop(error);
  }
}

/**
 * The integration receipt: the result, and what #8's guards make of it.
 *
 * Durable on purpose. A receipt that exists only while the process does cannot
 * tell a resumed run which phase it is in.
 */
export function integrationReceipt(delta, result) {
  const errors = integrationProof(delta, result);
  return Object.freeze({
    operation_id: result.operation_id,
    delta_digest: delta.delta_digest,
    base_commit_oid: result.base_commit_oid,
    staging_commit_oid: result.commit_oid,
    staging_tree_oid: result.tree_oid,
    phase: errors.length === 0 && result.applied ? 'ref_advanced' : 'prepared',
    errors: frozenCopy(errors),
  });
}

/**
 * The stop a receipt stops the apply at, or null when its proof holds (debt 13a, R9-3).
 *
 * The receipt records the errors of `integrationProof`, and a receipt with any is `prepared`, not `ref_advanced`: the line
 * and the receipts do not agree, and the name the graph carries for that is `receipt_missing`, the contract's name for the
 * failure its `cause`. Movement is named before content. A name the map has no `after` for is still that stop: an error in
 * a receipt never leaves the apply without one.
 */
export function applyOutcome(receipt) {
  const names = [...new Set(receipt.errors.map((error) => error.reason))];
  if (names.length === 0) return null;
  const cause = MOVEMENT_NAMES.find((name) => names.includes(name)) ?? names[0];
  return Object.freeze({
    reason: Object.hasOwn(APPLY_STOPS, cause) ? (APPLY_STOPS[cause].after ?? 'receipt_missing') : 'receipt_missing',
    cause,
    causes: frozenCopy(names),
  });
}

/**
 * The apply as a step body runs it: the outcome it reports to the graph, whatever the refusal.
 *
 * A stop the apply raises, or one its receipt records, comes back as `stop` — `{ reason, cause }`, whose `reason` is the
 * fact `apply_outcome` that the predicates of the `apply_staging` edges read — and the step ends normally, so the flow
 * parks with that reason. A refusal thrown out of the step instead would fail it, and the daemon would park with no
 * reason at all, which `admit` lets re-enter the same step: a retry, forbidden for foreign or indeterminate movement
 * (`approved-delta.md` §6). What is kept inside the apply is what its dependencies do: a git runner, `realpath`, the recipe journal and the
 * custody client that throw, or hand back an answer of another shape than the apply reads, are the environment's (or the helper's) failure,
 * with the errno or `bad_result` as the cause; a FlowError of theirs that is not one of the four stops is their failure too. What is thrown
 * past it is a host invariant (`custody_request_invalid`, a fault of the caller's own arguments — it can follow the recipe's save, so it is
 * not "before anything is written") and an error no dependency raised, a defect of the host. A dependency that fails in a way this does not
 * look at — a custody client that never returns, a git runner that hangs — is not covered.
 */
export async function applyWithOutcome(git, options) {
  try {
    const result = await applyDelta(git, options);
    const receipt = integrationReceipt(options.delta, result);
    return Object.freeze({ result, receipt, stop: applyOutcome(receipt) });
  } catch (error) {
    if (error instanceof FlowError && APPLY_STOP_REASONS.includes(error.code)) {
      const said = error.details?.cause;
      const cause = typeof said === 'string' ? boundedText(said, 64) : null;
      return Object.freeze({
        result: null,
        receipt: null,
        stop: Object.freeze({ reason: error.code, cause, causes: frozenCopy(cause === null ? [] : [cause]), details: safeDetails(error.details ?? {}) }),
      });
    }
    throw error;
  }
}
