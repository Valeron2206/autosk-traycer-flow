# Local upstream prerequisite patch

`host-projections.patch` adds a schema-scoped, native-backed projection port to the
actual autoskd Store. It does not add a replacement engine, relax task custody or
implement the whole typed SDK/atomic child-creation feature. It has not been
published as an upstream PR, installed on a user machine, or activated in production.

`host-projections.lock.json` pins the exact upstream source archive, patch and
66 TypeScript code preimages/postimages. Run the read-only verifier before and
after applying to a disposable checkout; instructions and test boundaries are in
`../../docs/runtime/native-host-boundary.md`.

Upstream source retains its MIT license (wierdbytes/autosk). The native helper's
separately vendored syscall package retains its included BSD-3-Clause license.
