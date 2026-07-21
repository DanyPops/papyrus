# CLI parity: shared command, output, and safety contract

The authoritative contract lives in Papyrus, not here — see Papyrus doc
`cli-parity-shared-command-output-and-safety-contract-mysd` for the full noun/action grammar,
structured-payload input conventions, `--json`/human output rules, exit-code taxonomy,
daemon-unavailable guidance, and security contract shared by Papyrus, Jittor, and future
`@danypops`-supervised daemon packages.

## Summary for contributors reading this repo

- `<package> <noun> <action> [options]`, kebab-case actions, plus a raw `<package> op <operation>
  [--input <json>]` escape hatch validated against that package's own operation list.
- Structured fields use per-field `--<name> <json>` flags; a single generic `--input <json>` is
  reserved for the raw escape hatch only.
- `--json` is the only stable machine channel; human output goes through purpose-built presenters
  and is never parsed back.
- Exit codes: `0` success, `1` daemon/operation failure, `2` usage error.
- CLIs call authenticated typed clients only; no command opens the daemon's store or a credential
  file directly, and no command ever prints the daemon bearer token or a provider credential.

This file intentionally does not restate the sourced rationale — read the Papyrus doc for that.
