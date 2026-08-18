# Integration tests

Package tests are colocated with each workspace package. `electron-smoke`
contains a hidden-window fixture that verifies a real context-isolated renderer
can connect, receive a snapshot, and observe a canonical main-originated
Commit through the narrow preload bridge.
