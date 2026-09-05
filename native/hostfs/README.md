# autosk-hostfs qualification helper

Closed private-stdio filesystem helper. No socket, task engine, model runner or
production activation. Read the development ADR and native boundary runtime guide
at `../../docs/development/adr-native-hostfs.md` and
`../../docs/runtime/native-host-boundary.md`.

Build through `node scripts/build-native-hostfs.mjs` from the repository root.
The dependency is pinned by `go.mod`, `go.sum` and `dependency-provenance.json`.
A local `vendor/` tree is optional for offline qualification; CI may download the
checksum-authenticated public module. No helper build or dependency download
installs or activates the binary.

The helper requires an inherited root directory FD, exact device/inode/UID and
project SHA-256. It emits a read-only versioned handshake first. Root binding is a
separate explicit initialization request. The five operations are initialize,
projection.read, projection.cas, evidence.put and evidence.read. Limits and closed
schema checks are enforced in the binary, not just the JavaScript client.

`npm run test:native:go` tests the native library/protocol with the optional local vendor tree or the pinned module checksum database. Compile
`-tags=flowfault` only for qualification fault tests; never install that binary.
`release` means test hooks are omitted, not that the build is release-qualified.
The binary always reports `release_qualified:false` in this development slice.
