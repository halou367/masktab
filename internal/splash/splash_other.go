//go:build !windows

package splash

import "time"

func Show(text string)                               {}
func Progress(done, total int)                       {}
func Later(d time.Duration, text string)             {}
func Say(text string)                                {}
func Finish()                                        {}
func Close()                                         {}
func CloseSetup() bool                               { return false }
func SetupShowing() bool                             { return false }
func RunStandalone(text string, limit time.Duration) {}
func RunDemo(total int, step time.Duration)          {}
