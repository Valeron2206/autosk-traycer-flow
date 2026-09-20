/**
 * fs read instrument for the design-input measurement.
 *
 * Loaded with `--import` (through NODE_OPTIONS) before the module under
 * measurement links its imports. It wraps every content-read entry point of
 * `node:fs` and `node:fs/promises` — the declared boundary below — and
 * appends every path argument to a per-process log in the directory
 * DESIGN_READS_LOG names.
 *
 * The declared boundary. Every export of `node:fs` and `node:fs/promises`
 * falls in exactly one of two sets — FS_CONTENT_READS / FSP_CONTENT_READS,
 * which are wrapped, or the ignored sets, which are deliberately not:
 *
 * - probes look at a name or its metadata, not at bytes: existsSync,
 *   statSync, realpathSync, access, readlink, glob and friends. glob yields
 *   names; a caller that reads one opens it and is recorded there;
 * - writers change bytes, they do not deliver them: writeFile, appendFile,
 *   truncate, mkdir, rename, rm, link, symlink, chmod, chown, utimes,
 *   createWriteStream and friends;
 * - fd-only calls — read, readSync, readv, close, fstat, fsync and the
 *   other f-prefixed forms — need a descriptor, and a read through a
 *   descriptor is recorded at the open that produced it;
 * - watch, watchFile and unwatchFile subscribe to events; they deliver no
 *   bytes;
 * - the stream and data classes are constructors, not entry points — a
 *   `new ReadStream` read surfaces through the wrapped `open` it performs;
 * - constants, promises and `_toUnixTimestamp` are objects or internals.
 *
 * Out of scope by declaration, not by oversight: `process.binding("fs")`
 * and other internal surfaces are not a public API and are not classified.
 *
 * Three properties make the wrap reliable where it has to be:
 *
 * - It patches the CommonJS exports object of the builtin, obtained through
 *   `createRequire`, and it never statically imports `node:fs`. An ESM
 *   `import { readFileSync } from "node:fs"` binds to a snapshot of the
 *   builtin's exports taken when the facade is first linked, so the exports
 *   must already be patched before any user module links it — importing
 *   node:fs here would create that facade early with unpatched values.
 * - It records when the operation has happened, not before it: a
 *   synchronous read is logged after the call returns, a callback or
 *   promise form in its success path, so a record exists only for an
 *   operation that actually opened the path. A failed read records
 *   nothing — no bytes were delivered. A copy is different: a failure
 *   can arrive after part of the source was already copied, so its
 *   mark is written whether the call succeeded or settled in error.
 * - It resolves the path argument against `process.cwd()` at call time
 *   and again at completion, folding each to its physical form — links
 *   and the on-disk spelling — so a read after `process.chdir`, in a
 *   child process with its own cwd, or through another name of the same
 *   directory lands on the file that was actually opened. If the two
 *   physical names differ — the name moved while the operation was in
 *   flight — the record is a `conflict` mark naming both sides, which
 *   the reduce refuses rather than guessing which file was read. The
 *   two observations bracket the operation; they do not prove which
 *   object the open itself resolved — a name that changed twice inside
 *   that window ends where it started while the bytes came from
 *   elsewhere.
 * - It never alters the caller's arguments. An earlier revision resolved
 *   the source and destination of `cp` to absolute names before calling
 *   it, which changed the arguments the caller's own filter received and
 *   made the measured run copy a different set than a normal run. Every
 *   value the program passes to `fs` now reaches it untouched.
 * - It fails closed. If a wrap does not take, the process exits nonzero
 *   before the measured code runs rather than measuring nothing.
 *
 * Copies are content reads the measurement does not model: which bytes a
 * copy reads depends on its filter, force, dereference and on partial
 * failure, and guessing them misrecorded in both directions. The copy
 * entry points therefore write a `copy` mark when the operation
 * settles — success or failure, since a copy that throws can already
 * have copied part of its source — naming the source's physical name
 * at the call and at completion plus the call site; the reduce refuses
 * when either resolution could be inside the repository or the two
 * differ, and ignores a source outside at both observations.
 *
 * Each record says what the operation produced: `file` for the
 * readFile/stream family, `dir` for readdir and opendir, and for
 * open/openSync/promises.open the kind is read off the descriptor the
 * call produced — a directory is a `dir` record, anything neither file
 * nor directory is `other`. The reduce trusts the kind — it never
 * re-derives what a recorded operation was from the path's later state.
 *
 * The log is a scratch directory outside the repository; each process writes
 * its own `<pid>.log` file, so several instrumented processes — including
 * child node processes, which inherit NODE_OPTIONS and DESIGN_READS_LOG —
 * can record at once without interleaving.
 */

import { createRequire } from "node:module";

/**
 * node:fs exports that read bytes from a path argument — the wrapped set.
 * The copyFile/cp names are content reads too, but a copy is not modelled:
 * the mark they write on success names the source at the call and at
 * completion, and either side possibly inside the repository refuses the
 * measurement. open/openSync/promises.open record the kind their
 * descriptor reports unless the positional
 * flags open write-only; the readFile family honors `options.flag` and
 * createReadStream honors `options.flags`, each defaulting to read.
 * readdir, opendir and openAsBlob have no open flag; openAsBlob records
 * when its promise resolves because the blob reads the path lazily, and
 * createReadStream records nothing itself — its inner open is wrapped
 * and records at the real open.
 */
export const FS_CONTENT_READS = Object.freeze([
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "createReadStream",
  "open",
  "openAsBlob",
  "openSync",
  "opendir",
  "opendirSync",
  "readdir",
  "readdirSync",
  "readFile",
  "readFileSync",
]);

/** node:fs exports that deliberately record nothing, grouped by reason. */
export const FS_IGNORED = Object.freeze({
  probes: Object.freeze([
    "access",
    "accessSync",
    "exists",
    "existsSync",
    "glob",
    "globSync",
    "lstat",
    "lstatSync",
    "readlink",
    "readlinkSync",
    "realpath",
    "realpathSync",
    "stat",
    "statfs",
    "statfsSync",
    "statSync",
  ]),
  writers: Object.freeze([
    "appendFile",
    "appendFileSync",
    "chmod",
    "chmodSync",
    "chown",
    "chownSync",
    "createWriteStream",
    "lchmod",
    "lchmodSync",
    "lchown",
    "lchownSync",
    "link",
    "linkSync",
    "lutimes",
    "lutimesSync",
    "mkdir",
    "mkdirSync",
    "mkdtemp",
    "mkdtempDisposableSync",
    "mkdtempSync",
    "rename",
    "renameSync",
    "rm",
    "rmdir",
    "rmdirSync",
    "rmSync",
    "symlink",
    "symlinkSync",
    "truncate",
    "truncateSync",
    "unlink",
    "unlinkSync",
    "utimes",
    "utimesSync",
    "writeFile",
    "writeFileSync",
  ]),
  fdOnly: Object.freeze([
    "close",
    "closeSync",
    "fdatasync",
    "fdatasyncSync",
    "fchmod",
    "fchmodSync",
    "fchown",
    "fchownSync",
    "fstat",
    "fstatSync",
    "fsync",
    "fsyncSync",
    "ftruncate",
    "ftruncateSync",
    "futimes",
    "futimesSync",
    "read",
    "readSync",
    "readv",
    "readvSync",
    "write",
    "writeSync",
    "writev",
    "writevSync",
  ]),
  events: Object.freeze(["unwatchFile", "watch", "watchFile"]),
  constructors: Object.freeze([
    "Dir",
    "Dirent",
    "FileReadStream",
    "FileWriteStream",
    "ReadStream",
    "Stats",
    "Utf8Stream",
    "WriteStream",
  ]),
  internals: Object.freeze(["_toUnixTimestamp", "constants", "promises"]),
});

/** node:fs/promises exports that read bytes from a path argument. */
export const FSP_CONTENT_READS = Object.freeze([
  "copyFile",
  "cp",
  "open",
  "opendir",
  "readdir",
  "readFile",
]);

/** node:fs/promises exports that deliberately record nothing. */
export const FSP_IGNORED = Object.freeze({
  probes: Object.freeze([
    "access",
    "glob",
    "lstat",
    "readlink",
    "realpath",
    "stat",
    "statfs",
  ]),
  writers: Object.freeze([
    "appendFile",
    "chmod",
    "chown",
    "lchmod",
    "lchown",
    "link",
    "lutimes",
    "mkdir",
    "mkdtemp",
    "mkdtempDisposable",
    "rename",
    "rm",
    "rmdir",
    "symlink",
    "truncate",
    "unlink",
    "utimes",
    "writeFile",
  ]),
  events: Object.freeze(["watch"]),
  internals: Object.freeze(["constants"]),
});

const require = createRequire(import.meta.url);
const logDir = process.env.DESIGN_READS_LOG;

if (logDir) {
  const fs = require("node:fs");
  const fsp = require("node:fs/promises");
  const path = require("node:path");
  const { fileURLToPath } = require("node:url");

  // Captured before wrapping. realpathSync.native reports the on-disk
  // spelling — plain realpathSync keeps the caller's case, which would
  // leave a case-folded read of the repository looking outside it.
  const realpathNative = fs.realpathSync.native;
  const append = fs.appendFileSync.bind(fs);
  const logFile = path.join(logDir, `${process.pid}.log`);

  const toPathString = (target) => {
    if (target instanceof URL) return fileURLToPath(target);
    if (Buffer.isBuffer(target)) return target.toString("utf8");
    return typeof target === "string" ? target : undefined;
  };

  const resolveArg = (target) => {
    const text = toPathString(target);
    return text === undefined ? undefined : path.resolve(text);
  };

  const physicalForm = (absolute) => {
    try {
      return realpathNative(absolute);
    } catch {
      return undefined;
    }
  };

  // A record is written only when the operation has happened: the wrapper
  // captures the path's physical name at call time, `recordRead` resolves
  // `target` again in the success path — for a sync form right after the
  // call returned, for a callback or promise form in its completion. If
  // the two physical names differ, the name moved while the operation was
  // in flight: the `conflict` mark names both observations, `?` prefixing
  // a name that did not resolve, and the reduce refuses rather than guess
  // which file was read.
  const recordRead = (kind, target, callAbs, callPhysical) => {
    try {
      if (callAbs === undefined) return; // fd reads are recorded at the open
      const after = resolveArg(target);
      const donePhysical = physicalForm(after);
      if (callPhysical !== undefined && callPhysical === donePhysical) {
        append(logFile, `${kind}\t${callPhysical}\n`);
        return;
      }
      append(logFile, `conflict\t${callPhysical ?? `?${callAbs}`}\t${donePhysical ?? `?${after}`}\n`);
    } catch {
      // A logging failure must not change the run under measurement; a log
      // that cannot be written leaves an empty record, which the runner
      // refuses.
    }
  };

  const callSite = () => {
    const frames = (new Error().stack ?? "").split("\n").slice(1);
    const own = frames.find(
      (frame) => !frame.includes("design-reads-instrument") && !frame.includes("node:internal"),
    );
    return own === undefined ? "unknown call site" : own.trim().replace(/^at\s+/u, "");
  };

  // A copy is marked, not modelled, and the mark follows the same
  // two-observation rule as a read record: it carries the source's
  // physical name at the call and when the operation settles. Unlike a
  // read it is written on failure too — a copy that throws can already
  // have copied part of its source, and the instrument cannot say how
  // much, so the mark means "attempted, outcome indeterminate". The
  // caller's arguments and error pass through untouched; the reduce
  // refuses when either resolution could be inside the repository or
  // the two differ.
  const recordCopy = (source, callAbs, callPhysical, site) => {
    try {
      if (callAbs === undefined) return;
      const after = resolveArg(source);
      const donePhysical = after === undefined ? undefined : physicalForm(after);
      const callDesc = callPhysical ?? `?${callAbs}`;
      const doneDesc = donePhysical ?? `?${after ?? callAbs}`;
      append(logFile, `copy\t${callDesc}\t${doneDesc}\t${site}\n`);
    } catch {
      // Same rule as recordRead(): logging must never change the measured run.
    }
  };

  // open/openSync/promises.open succeed on a directory, so their kind is
  // read off the descriptor they produced — `file`, `dir`, or `other` for
  // anything neither (a fifo cannot be pinned; inside the repository the
  // reduce refuses it by name). fstatSync is in the ignored set, so it is
  // the unwrapped original here.
  const kindOfStat = (stat) => {
    try {
      if (stat?.isDirectory?.()) return "dir";
      if (stat?.isFile?.()) return "file";
    } catch {
      // fall through — an unreadable stat is undecidable, not a file
    }
    return "other";
  };
  const kindOfDescriptor = (fd) => {
    try {
      return kindOfStat(fs.fstatSync(fd));
    } catch {
      return "other";
    }
  };
  const kindOfHandle = (handle) => {
    try {
      return Promise.resolve(handle?.stat?.()).then(kindOfStat, () => "other");
    } catch {
      return Promise.resolve("other");
    }
  };

  // A write-only descriptor cannot read the file: "w", "wx", "a", "ax" and
  // "as" open without read access; the "+" forms and "r" reads record. The
  // numeric form is the POSIX access-mode mask — O_ACCMODE is 3 where
  // fs.constants does not export it.
  const O_ACCMODE = fs.constants.O_ACCMODE ?? 3;
  const O_WRONLY = fs.constants.O_WRONLY ?? 1;
  const isWriteOnly = (flags) => {
    if (typeof flags === "number") return (flags & O_ACCMODE) === O_WRONLY;
    if (typeof flags !== "string") return false; // omitted or a callback — "r"
    return /^[wa]/u.test(flags) && !flags.includes("+");
  };

  const assertWrapped = (object, label, name, original) => {
    if (typeof original !== "function" || object[name] === original) {
      process.stderr.write(`design-reads-instrument: could not wrap ${label}.${name}\n`);
      process.exit(1);
    }
  };

  // Option semantics are per-API: the readFile family honors `options.flag`
  // (default "r"), createReadStream honors `options.flags` (default "r"),
  // and readdir, opendir and openAsBlob take no open flag at all. A field
  // the API ignores must never suppress the record, and a form the
  // instrument does not understand records: a false member is a loud CI
  // failure, a missed read is a silent hole.
  const optionsObject = (arg) => (arg !== null && typeof arg === "object" ? arg : undefined);
  const flagOption = (rest) => optionsObject(rest[0])?.flag;
  const positionalFlag = (rest) => rest[0];

  // kind is "file", "dir" or a function of the operation's result — the
  // open family passes kindOfDescriptor/kindOfHandle so a directory the
  // call succeeded on is a `dir` record, not a file. Sync forms record
  // after the call returns; callback forms record in the wrapped
  // completion on success; promise forms in a .then on success. A
  // failed operation records nothing.
  const observedAtCall = (target) => {
    const callAbs = resolveArg(target);
    return callAbs === undefined
      ? undefined
      : { callAbs, callPhysical: physicalForm(callAbs) };
  };

  const wrapSync = (object, label, name, kind, flagOf) => {
    const original = object[name];
    object[name] = function (target, ...rest) {
      if (isWriteOnly(flagOf?.(rest))) return original.call(this, target, ...rest);
      const seen = observedAtCall(target);
      const result = original.call(this, target, ...rest);
      if (seen !== undefined) {
        recordRead(typeof kind === "function" ? kind(result) : kind, target, seen.callAbs, seen.callPhysical);
      }
      return result;
    };
    assertWrapped(object, label, name, original);
  };

  const wrapCallback = (object, label, name, kind, flagOf) => {
    const original = object[name];
    object[name] = function (target, ...rest) {
      if (isWriteOnly(flagOf?.(rest))) return original.call(this, target, ...rest);
      const seen = observedAtCall(target);
      const last = rest.length - 1;
      if (seen !== undefined && typeof rest[last] === "function") {
        const callback = rest[last];
        rest[last] = function (error, ...results) {
          if (error == null) {
            const resolved = typeof kind === "function" ? kind(results[0]) : kind;
            recordRead(resolved, target, seen.callAbs, seen.callPhysical);
          }
          return callback.call(this, error, ...results);
        };
      }
      return original.call(this, target, ...rest);
    };
    assertWrapped(object, label, name, original);
  };

  const wrapPromise = (object, label, name, kind, flagOf) => {
    const original = object[name];
    object[name] = function (target, ...rest) {
      if (isWriteOnly(flagOf?.(rest))) return original.call(this, target, ...rest);
      const seen = observedAtCall(target);
      const result = original.call(this, target, ...rest);
      return seen === undefined
        ? result
        : result.then((value) => {
            const done = (resolved) => {
              recordRead(resolved, target, seen.callAbs, seen.callPhysical);
              return value;
            };
            try {
              return Promise.resolve(typeof kind === "function" ? kind(value) : kind).then(done, () => done("other"));
            } catch {
              return done("other");
            }
          });
    };
    assertWrapped(object, label, name, original);
  };

  // createReadStream returns before its deferred open runs; the inner
  // open() call is itself wrapped and records at the real open, so there
  // is nothing proven to write at this level — the wrap exists so the
  // boundary holds every content-read export wrapped.
  const wrapStream = (object, label, name) => {
    const original = object[name];
    object[name] = function (target, ...rest) {
      return original.call(this, target, ...rest);
    };
    assertWrapped(object, label, name, original);
  };

  // copyFile/cp follow the same completion rule as reads, with one
  // difference: a failed copy can already have copied part of its source,
  // so the mark is written whether the call succeeded or settled in
  // error — the record says "attempted, outcome indeterminate". The
  // caller's error and rejection pass through unchanged, and every
  // argument, filter included, reaches fs as it was passed.
  const wrapCopySync = (object, label, name) => {
    const original = object[name];
    object[name] = function (source, ...rest) {
      const seen = observedAtCall(source);
      const site = callSite();
      try {
        return original.call(this, source, ...rest);
      } finally {
        if (seen !== undefined) recordCopy(source, seen.callAbs, seen.callPhysical, site);
      }
    };
    assertWrapped(object, label, name, original);
  };

  const wrapCopyCallback = (object, label, name) => {
    const original = object[name];
    object[name] = function (source, ...rest) {
      const seen = observedAtCall(source);
      const site = callSite();
      const last = rest.length - 1;
      if (seen !== undefined && typeof rest[last] === "function") {
        const callback = rest[last];
        rest[last] = function (error, ...results) {
          recordCopy(source, seen.callAbs, seen.callPhysical, site);
          return callback.call(this, error, ...results);
        };
      }
      return original.call(this, source, ...rest);
    };
    assertWrapped(object, label, name, original);
  };

  const wrapCopyPromise = (object, label, name) => {
    const original = object[name];
    object[name] = function (source, ...rest) {
      const seen = observedAtCall(source);
      const site = callSite();
      const result = original.call(this, source, ...rest);
      return seen === undefined
        ? result
        : result.then(
            (value) => {
              recordCopy(source, seen.callAbs, seen.callPhysical, site);
              return value;
            },
            (error) => {
              recordCopy(source, seen.callAbs, seen.callPhysical, site);
              throw error;
            },
          );
    };
    assertWrapped(object, label, name, original);
  };

  wrapSync(fs, "fs", "readFileSync", "file", flagOption);
  wrapCallback(fs, "fs", "readFile", "file", flagOption);
  wrapStream(fs, "fs", "createReadStream");
  wrapSync(fs, "fs", "readdirSync", "dir");
  wrapCallback(fs, "fs", "readdir", "dir");
  wrapSync(fs, "fs", "opendirSync", "dir");
  wrapCallback(fs, "fs", "opendir", "dir");
  wrapPromise(fs, "fs", "openAsBlob", "file");
  wrapSync(fs, "fs", "openSync", kindOfDescriptor, positionalFlag);
  wrapCallback(fs, "fs", "open", kindOfDescriptor, positionalFlag);
  wrapCopySync(fs, "fs", "copyFileSync");
  wrapCopySync(fs, "fs", "cpSync");
  wrapCopyCallback(fs, "fs", "copyFile");
  wrapCopyCallback(fs, "fs", "cp");

  for (const promises of new Set([fs.promises, fsp])) {
    wrapPromise(promises, "fs.promises", "readFile", "file", flagOption);
    wrapPromise(promises, "fs.promises", "readdir", "dir");
    wrapPromise(promises, "fs.promises", "opendir", "dir");
    wrapPromise(promises, "fs.promises", "open", kindOfHandle, positionalFlag);
    wrapCopyPromise(promises, "fs.promises", "copyFile");
    wrapCopyPromise(promises, "fs.promises", "cp");
  }
}
