/** Publishing a planning artefact to the planning ref, against a real repository.
 *
 * #5 owns the state machine; this owns the two things it cannot do for itself:
 * turning a repository into the observation the machine reads, and performing
 * the action it returns.
 *
 * The observation is the delicate half. `expected_parent` and `expected_commit`
 * are questions about a ref, and both can be true of a ref that was moved by
 * somebody else in between — which is why the reflog is read as well, and why a
 * ref whose reflog cannot be read is `unknown` rather than assumed.
 *
 * The injected `git(args, { env, stdin } = {})` runs one command and returns
 * `{ code, stdout, stderr }`.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

import { commitMessage } from './planning-publication.mjs';
import { readRef, reflogDepth } from './staging-driver.mjs';

/** One git invocation. A command that could not run says nothing about the product. */
async function ask(git, args, options = {}) {
  const result = await git(args, options);
  if (result.code !== 0) {
    demand(false, 'planning_publication_corrupt', `git ${args[0]} exited ${result.code}`,
      { args: immutable([...args]), stderr: (result.stderr ?? '').trim().slice(0, 200) });
  }
  return result;
}

/**
 * Where the planning ref is, and what its reflog says about how it got there.
 *
 * A ref that is back where it belongs is not evidence that nothing happened to
 * it, so the two are read together: the OID answers *where*, the reflog answers
 * *how many times*, and only both together answer whether this operation is the
 * one that moved it.
 */
export async function observeRef(git, { ref, expectedParent, expectedCommit, reflogBefore }) {
  const oid = await readRef(git, ref);
  const where = oid === expectedCommit ? 'expected_commit' : oid === expectedParent ? 'expected_parent' : 'other';
  if (reflogBefore === undefined) return Object.freeze({ ref: where, reflog: 'unknown', oid });

  const entries = await reflogEntries(git, ref);
  // A ref that keeps no reflog has a movement count of zero whatever was done
  // to it, so counting against it would read every foreign movement as
  // `checkpoint` — the ref looking untouched because nothing was recorded.
  if (entries.length === 0) return Object.freeze({ ref: where, reflog: 'unknown', oid });
  const added = entries.length - reflogBefore;
  let reflog = 'changed';
  if (added === 0) reflog = 'checkpoint';
  else if (added === 1 && entries[0] === expectedCommit) reflog = 'one_new_matching';
  return Object.freeze({ ref: where, reflog, oid });
}

/** The reflog, newest first. Empty when the ref keeps none. */
export async function reflogEntries(git, ref) {
  const result = await git(['reflog', 'show', '--format=%H', ref]);
  if (result.code !== 0) return immutable([]);
  return immutable(result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length === 40));
}

/**
 * Whether the publication object is there, and whether it is the recorded one.
 *
 * `absent` and `pruned` are different facts about the same emptiness: nothing
 * was ever written, or what was written is gone. Only the durable record can
 * tell them apart, and the difference decides whether the next step is to write
 * a commit or to reconstruct one.
 */
export async function observeObject(git, { recordedOid, expectedBytes }) {
  if (!recordedOid) return 'absent';
  const present = await git(['cat-file', '-e', `${recordedOid}^{commit}`]);
  if (present.code !== 0) return 'pruned';
  if (expectedBytes === undefined) return 'matching';
  const raw = await ask(git, ['cat-file', 'commit', recordedOid]);
  return raw.stdout === expectedBytes ? 'matching' : 'mismatch';
}

/**
 * Writes the publication commit.
 *
 * The identity and both dates are given rather than taken from the environment,
 * so the same publication produces the same object. That is what makes a
 * reconstruction after a prune possible at all: without it, rewriting the
 * "same" commit would produce a different OID and a different history.
 */
export async function writeCommitObject(git, { tree, parent, payloadKind, trailers, identity }) {
  const message = commitMessage(payloadKind, trailers);
  const env = {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_AUTHOR_DATE: identity.date,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_COMMITTER_DATE: identity.date,
  };
  const args = ['commit-tree', tree, '-m', message];
  if (parent) args.splice(2, 0, '-p', parent);
  const created = await ask(git, args, { env });
  const oid = created.stdout.trim();
  const raw = await ask(git, ['cat-file', 'commit', oid]);
  return Object.freeze({ oid, bytes: raw.stdout, message });
}

/**
 * Rewrites a pruned object from the bytes that were recorded.
 *
 * Reconstruction, not a new logical commit: the same bytes hash to the same
 * OID, and an OID that comes back different means the bytes are not the ones
 * that were published.
 */
export async function rewriteExactObject(git, { recordedOid, bytes }) {
  const written = await ask(git, ['hash-object', '-t', 'commit', '-w', '--stdin'], { stdin: bytes });
  const oid = written.stdout.trim();
  demand(oid === recordedOid, 'planning_publication_corrupt',
    'The reconstructed object is not the recorded one', { recorded: recordedOid, rewritten: oid });
  return Object.freeze({ oid, reconstructed: true });
}

/**
 * Advances the planning ref by compare-and-swap.
 *
 * `--create-reflog` because the state machine reads the reflog to tell this
 * operation's movement from somebody else's, and a ref outside `refs/heads`
 * keeps none by default.
 */
export async function advanceRef(git, { ref, expectedParent, commit }) {
  const before = await reflogDepth(git, ref);
  const result = await git(['update-ref', '--create-reflog', ref, commit, expectedParent ?? '']);
  const held = await readRef(git, ref);
  return Object.freeze({
    advanced: result.code === 0,
    ref,
    expected_parent: expectedParent ?? null,
    commit,
    observed: held,
    reflog_before: before,
  });
}

/** The trailers of a published commit, read back from the object. */
export async function publishedTrailers(git, oid) {
  const raw = await ask(git, ['cat-file', 'commit', oid]);
  const body = raw.stdout.split('\n\n').slice(1).join('\n\n');
  const trailers = {};
  for (const line of body.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9-]*)=(.*)$/u.exec(line);
    if (match) trailers[match[1]] = match[2];
  }
  return Object.freeze(trailers);
}
