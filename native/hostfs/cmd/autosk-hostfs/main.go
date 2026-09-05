//go:build linux || darwin

package main

import (
	"autosk.local/hostfs/internal/safefs"
	"autosk.local/hostfs/internal/wire"
	"context"
	"encoding/json"
	"flag"
	"os"

	"golang.org/x/sys/unix"
)

func main() {
	// This is a dedicated helper process: do not inherit a caller umask that
	// would create unreadable or unexpectedly permissive state entries.
	unix.Umask(0077)
	flags := flag.NewFlagSet("autosk-hostfs", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	fd := flags.Int("root-fd", 3, "inherited private directory capability")
	project := flags.String("project", "", "pinned project root SHA-256")
	device := flags.Uint64("device", 0, "pinned root device")
	inode := flags.Uint64("inode", 0, "pinned root inode")
	uid := flags.Uint("uid", 0, "pinned root owner UID")
	if flags.Parse(os.Args[1:]) != nil || flags.NArg() != 0 || *fd < 3 || *fd > 64 || *uid > 4294967295 || *inode == 0 {
		os.Exit(2)
	}
	root, err := safefs.Open(*fd, *project, safefs.Identity{Device: *device, Inode: *inode, UID: uint32(*uid)})
	if err != nil {
		code := "unsafe_root"
		if e, ok := err.(*safefs.Error); ok {
			code = e.Code
		}
		json.NewEncoder(os.Stdout).Encode(map[string]any{"id": "", "ok": false, "result": nil, "error": map[string]string{"code": code, "message": "native root preflight failed"}})
		os.Exit(2)
	}
	defer root.Close()
	if err = wire.Serve(context.Background(), root, os.Stdin, os.Stdout); err != nil {
		os.Exit(2)
	}
}
