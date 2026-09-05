//go:build darwin

package safefs

import (
	"bytes"
	"golang.org/x/sys/unix"
)

func mountIdentity(fd int) (uint64, error) {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return 0, native(err, "mount_identity_unavailable")
	}
	return uint64(st.Dev), nil
}
func fileFlush(fd int) error {
	if err := unix.Fsync(fd); err != nil {
		return err
	}
	_, err := unix.FcntlInt(uintptr(fd), unix.F_FULLFSYNC, 0)
	return err
}

// Flush after the directory entry has been fsynced as well; Darwin qualification
// must demonstrate this sequence on actual APFS hardware before release.
func afterDirectoryFlush(fileFD int) error {
	_, err := unix.FcntlInt(uintptr(fileFD), unix.F_FULLFSYNC, 0)
	return err
}
func modifiedIdentity(s *unix.Stat_t) [4]int64 {
	return [4]int64{s.Mtim.Sec, s.Mtim.Nsec, s.Ctim.Sec, s.Ctim.Nsec}
}
func fileSystem(fd int) (string, error) {
	var st unix.Statfs_t
	if err := unix.Fstatfs(fd, &st); err != nil {
		return "", native(err, "filesystem_unavailable")
	}
	b := make([]byte, len(st.Fstypename))
	for i, v := range st.Fstypename {
		b[i] = byte(v)
	}
	name := string(bytes.TrimRight(b, "\x00"))
	if name != "apfs" && name != "hfs" {
		return "", fail("unsupported_filesystem", "only local APFS/HFS is a qualification target")
	}
	return name + "-qualification-only", nil
}
