package safefs

import "fmt"

// Error contains only a stable machine code and an operator-safe explanation.
// Native paths, file contents and OS error strings never cross the wire.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string        { return fmt.Sprintf("%s: %s", e.Code, e.Message) }
func fail(code, message string) error { return &Error{code, message} }
func native(err error, code string) error {
	if err == nil {
		return nil
	}
	return fail(code, "native filesystem operation failed; inspect the trusted host")
}
