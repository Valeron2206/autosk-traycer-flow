//go:build !flowfault

package safefs

const BuildProfile = "release"

func fault(phase string) {}
