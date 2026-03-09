//go:build mage

package main

import (
	"os"
	"os/exec"

	"github.com/magefile/mage/sh"
)

// Build compiles the Go backend binary.
func Build() error {
	return sh.RunV("go", "build", "-o", "dist/gpx_aacyn-datasource", ".")
}

// Test runs the Go test suite.
func Test() error {
	return sh.RunV("go", "test", "-v", "./pkg/...")
}

// BuildAll builds both the Go backend and the frontend.
func BuildAll() error {
	if err := Build(); err != nil {
		return err
	}

	cmd := exec.Command("npm", "run", "build")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// Clean removes build artifacts.
func Clean() error {
	return sh.Rm("dist")
}
