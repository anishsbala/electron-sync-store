# Integration tests

Package tests are colocated with each workspace package. `electron-smoke`
contains a hidden-window fixture that verifies a real context-isolated renderer
can connect, receive a snapshot, and observe a canonical main-originated
Commit through the narrow preload bridge.

The production demo has a separate deterministic smoke command, and
`e2e/demo.e2e.spec.ts` uses Playwright's Electron support for user-facing
Controller, Observer, Inspector, close/reopen, main-mutation, and flush flows.
