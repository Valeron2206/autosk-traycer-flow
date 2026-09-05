//go:build flowfault

package safefs

import "os"

const BuildProfile = "fault-test"

// Deliberately absent from release builds. No runtime option can enable it.
func fault(phase string) {
	if os.Getenv("AUTOSK_HOSTFS_TEST_CRASH") == phase {
		os.Exit(86)
	}
}
