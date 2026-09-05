//go:build linux

package safefs

import "golang.org/x/sys/unix"

func mountIdentity(fd int) (uint64, error) {
	var st unix.Statx_t
	if err := unix.Statx(fd, "", unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW, unix.STATX_MNT_ID, &st); err != nil {
		return 0, fail("mount_identity_unavailable", "statx mount identity is required")
	}
	if st.Mask&unix.STATX_MNT_ID == 0 {
		return 0, fail("mount_identity_unavailable", "kernel omitted mount identity")
	}
	return st.Mnt_id, nil
}
func fileFlush(fd int) error               { return unix.Fsync(fd) }
func afterDirectoryFlush(fileFD int) error { return nil }
func modifiedIdentity(s *unix.Stat_t) [4]int64 {
	return [4]int64{s.Mtim.Sec, s.Mtim.Nsec, s.Ctim.Sec, s.Ctim.Nsec}
}
func fileSystem(fd int) (string, error) {
	var st unix.Statfs_t
	if err := unix.Fstatfs(fd, &st); err != nil {
		return "", native(err, "filesystem_unavailable")
	}
	switch uint64(st.Type) {
	case 0xef53:
		return "ext4-family", nil
	case 0x58465342:
		return "xfs", nil
	case 0x9123683e:
		return "btrfs", nil
	case 0x794c7630:
		return "overlay-qualification-only", nil
	case 0x01021994:
		return "tmpfs-volatile", nil
	default:
		return "", fail("unsupported_filesystem", "filesystem has no qualified native protocol")
	}
}
