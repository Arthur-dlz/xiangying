//go:build !windows

package outputpolicy

// RequireNTFSOutputDir is intentionally a no-op outside Windows to preserve
// the existing output behavior on other platforms.
func RequireNTFSOutputDir(string) error { return nil }
