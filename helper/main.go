//go:build windows

// Command title-helper sets the console title of the process that started it.
//
// Windows has no /dev/tty: the terminal title is the title of the console the
// Claude Code process runs in. The plugin writes the title text to a file and
// starts this helper once per session; the helper polls the file and, when
// the text changes, attaches to its parent's console only for the call that
// sets the title. It is a GUI-subsystem program, so it never gets a console
// (or a conhost) of its own, and it exits as soon as its parent does.
//
// The file holds the title followed by one "\n". Content without it is a
// write still in progress and is not shown.
//
// Errors go to stderr, one line each, and only when they differ from the
// previous one; the plugin reports them in the transcript.
package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"
	"syscall"
	"unsafe"
)

// pollMs is both the pause between reads of the title file and the wait for
// the parent to exit.
const pollMs = 40

var (
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	attachConsole    = kernel32.NewProc("AttachConsole")
	freeConsole      = kernel32.NewProc("FreeConsole")
	setConsoleTitleW = kernel32.NewProc("SetConsoleTitleW")
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: title-helper <title file>")
		os.Exit(2)
	}
	if err := run(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(path string) error {
	ppid := uint32(os.Getppid())
	parent, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, ppid)
	if err != nil {
		return fmt.Errorf("cannot open the parent process %d: %w", ppid, err)
	}
	defer syscall.CloseHandle(parent)

	var (
		shown   string
		isShown bool
		lastErr string
	)
	complain := func(err error) {
		if text := err.Error(); text != lastErr {
			lastErr = text
			fmt.Fprintln(os.Stderr, text)
		}
	}

	for {
		event, err := syscall.WaitForSingleObject(parent, pollMs)
		switch event {
		case syscall.WAIT_OBJECT_0:
			return nil
		case syscall.WAIT_TIMEOUT:
		default:
			return fmt.Errorf("cannot wait for the parent process %d: %w", ppid, err)
		}

		title, ok, err := readTitle(path)
		if err != nil {
			complain(err)
			continue
		}
		if !ok || (isShown && title == shown) {
			continue
		}
		if err := setTitle(ppid, title, !isShown); err != nil {
			complain(err)
			continue
		}
		shown, isShown, lastErr = title, true, ""
	}
}

// readTitle answers the title the file holds; ok is false while the file is
// not there yet or a write is still in progress.
func readTitle(path string) (title string, ok bool, err error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("cannot read the title file: %w", err)
	}
	text, complete := strings.CutSuffix(string(data), "\n")
	return text, complete, nil
}

// setTitle sets the title of the console the process pid runs in. The first
// title is set twice: on its own it does not reach the terminal.
func setTitle(pid uint32, title string, first bool) error {
	text, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		return fmt.Errorf("cannot encode the title: %w", err)
	}
	if ok, _, err := attachConsole.Call(uintptr(pid)); ok == 0 {
		return fmt.Errorf("cannot attach to the console of process %d: %w", pid, err)
	}
	defer freeConsole.Call()
	times := 1
	if first {
		times = 2
	}
	for range times {
		if ok, _, err := setConsoleTitleW.Call(uintptr(unsafe.Pointer(text))); ok == 0 {
			return fmt.Errorf("cannot set the console title: %w", err)
		}
	}
	return nil
}
