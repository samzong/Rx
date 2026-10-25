# Independent agent distribution

Rx installs and updates managed rx-agent binaries. The agent does not update itself.

## Releases

- The tag is `rx-agent-v<agent/package.json version>` in this repository.
- Each release has four Bun binaries in platform archives and `SHA256SUMS`.
- Agent releases use `--latest=false`. Rx releases explicitly become latest.
  Both workflows read back the latest release after publishing.
- Rx archives contain no agent binary. `make install` still installs both products from source.

## Installation

- Discovery order is PATH, the directory containing Rx, then the managed version.
  An external installation bypasses managed state and never triggers managed updates.
- When rx-agent is missing, a terminal launch asks `[y/N]`. Enter declines.
  A refusal hides later picker recommendations, but `rxa` still asks.
  `RX_NO_INSTALL` disables the prompt. Noninteractive launches, including ACP, fail and name `rxa`.
- Rx downloads the newest stable `rx-agent-v*` release from the first 100 releases.
  It checks the archive against `SHA256SUMS` and unpacks it into
  `~/.recall/rx-agent/versions/<version>/`.
  Then it records the version in `install.toml`.
  A failure before that record keeps the previous selection.
- `install.lock` serializes installation and updates. A busy lock fails without waiting.

## Background update

- When a launch uses the managed version and the last check is older than 24 hours,
  Rx starts a detached updater, then executes the already selected binary.
  Terminal and ACP launches use the same path, with no prompt and no download wait.
- The updater receives home, temporary-directory, system-root, and proxy variables, but no provider credentials.
- The new version takes effect at the next launch. `RX_NO_UPDATE` disables the check.
- After an install, Rx keeps the current and previous versions and makes one deletion
  attempt on other version directories. Rx ignores failures and does not detect versions still in use.
  Two updates can therefore remove a directory that an older running session still uses.

## Rx self-update

Rx self-update uses the same download and SHA-256 path and requires `SHA256SUMS`.
It skips noninteractive, print, help, and version launches.
