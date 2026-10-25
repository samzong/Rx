# Independent agent distribution

Rx owns installation and updates of managed rx-agent binaries that the user accepts in a terminal.
The agent keeps its package version, existing `--version`, provider handoff, sessions, and ACP identity.
The launcher owns installation state and detached updates. The agent does not update itself.
The release tag is `rx-agent-v<agent/package.json version>` in this repository.
Each release contains four Bun binaries in platform archives and `SHA256SUMS`.
Agent releases always use `--latest=false`. Rx releases explicitly become latest.
Both workflows read back the repository latest release after publication.
Rx archives contain no agent binary. `make install` continues to install both products from source.

## Installation and selection

When rx-agent is missing, the picker and `rxa` offer installation with `[y/N]`.
Enter declines. A recorded refusal hides later picker recommendations.
An explicit missing-agent terminal launch still asks, including after a refusal.
`RX_NO_INSTALL` disables installation prompts.
There is no separate installation or agent-update command. `rx update` updates only Rx.

Managed files live under `~/.recall/rx-agent/versions/<version>/`.
`install.toml` records the installed version and installation refusal.
`rx-agent/update.toml` records only the last update check time, separately from Rx's update state.
A malformed check record is due for maintenance. The helper rewrites it while holding the check lock.
A malformed installation record suppresses picker recommendations but does not block other harnesses.
Explicit managed-agent launches still reject that record.
Discovery order is PATH, the directory containing Rx, then the verified managed version.
An external installation bypasses managed state and never triggers managed updates.
This keeps source installations from `make install` visible without a management command.
Managed-first selection would hide later source builds and require an extra command to undo it.
Rx never overwrites PATH, Homebrew, source installations, or the Rx directory to install an agent.

The installer locks, downloads, checks SHA-256, probes `--version`, and atomically selects the verified directory.
Failures preserve the old selection. Conflicting installers do not wait for the writer.
After atomic selection succeeds, Rx retains the current and previous versions.
Rx attempts to delete every other version directory once while it holds the installation lock.
Deletion failures are silent and do not trigger retries. Windows file locks can leave extra versions.
Rx does not detect versions that running processes still use.
After two updates, cleanup can remove the directory used by an older session.
The owner accepts this risk because updates are infrequent and checks run at most once per 24 hours.
The macOS probes exercise the unlinked process. They do not establish safety on Linux or Windows.
Each version occupies approximately 67–99 MB, based on the current four Bun artifacts.
SHA-256 detects asset corruption and mismatch. It does not provide an independent publisher signature.
Rx self-update uses the same checksum function and requires `SHA256SUMS`.

## Startup behavior

Only the picker recommends installation. Missing noninteractive launches fail without a prompt.
For a missing agent, ACP stderr directs the user to run `rxa` once in a terminal.
During ACP startup, the launcher never reads protocol input or writes stdout.
Rx self-update skips ACP, noninteractive launches, print, help, and version requests before network access.

Every launch that uses a managed agent checks its independent 24-hour timestamp.
If due, the launcher fixes the selected absolute path, spawns a detached updater, then executes that path.
Terminal and ACP use this same path. Neither waits for an agent update or asks for update approval.
The helper uses a five-second release check timeout and 60-second download timeout.
`RX_NO_UPDATE` disables both startup updaters.
The new version applies to subsequent launches. Existing processes keep their selected executable.
After two updates, cleanup can remove that executable directory while its process still runs.
Unix uses `setsid` and a second fork. Windows uses detached process creation.
The helper receives home, system-root, temporary-directory, and HTTP proxy variables, with no provider credentials.
It preserves `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, and their lowercase forms.
The current ureq configuration uses rustls with built-in webpki roots, not platform certificates.
It does not read `SSL_CERT_FILE` or `SSL_CERT_DIR`, so the helper does not pass them.
Its three stdio streams are null. It takes nonblocking locks before networking and never enters the ordinary launch path.

The strongest simpler alternative is no automatic maintenance or check state.
It fails the accepted background-update requirement.
One helper path removes terminal approval branches and update preferences.
Overwriting the resolved PATH binary avoids a separate selection, but violates the external-installation ownership boundary.
Version directories preserve that boundary and avoid replacement of a running Windows executable.
An independent distribution repository isolates GitHub latest more strongly, but adds a repository and publication credentials.
The accepted same-repository workflow instead enforces and reads back latest selection.

## Verification

Lody requires `rxa acp`, pure NDJSON, quick initialize, and the existing sessions and model options.
Lody does not require an installation API.
Acceptance uses temporary homes, local release fixtures, actual launcher aliases, and real Bun agent binaries.
The checks include bad hashes, concurrent writers, permission failures, detached offline startup, and old/new sessions.
They also cover terminal activation at the next launch and external-agent priority without managed maintenance.
After A→B→C, the probe requires only B and C on disk and initialize/list from the unlinked process A.
The native fixture uses Unix PTYs and locks. It does not prove Windows behavior.
With `--live-model provider/model`, the probe also requires a real model and read-tool round after unlink.
Supply the matching `PROVIDER_API_KEY` only through the probe environment.

```sh
make agent
cargo build --release --target-dir /tmp/rx-dist-fixture --config 'build.rustflags=["--cfg", "rx_release_fixture"]'
python3 scripts/test-agent-distribution.py --rx /tmp/rx-dist-fixture/release/rx --agent target/rx-agent --output /tmp/rx-dist-evidence.json
python3 -B scripts/test-release.py
```

The release-source injection exists only in a binary compiled with `rx_release_fixture`.
Normal builds have no release-source environment override.
The command above remains the native fixture entrypoint.
Its modules under `scripts/agent_distribution/` separate fixtures, installation, state repair, updates, retention, proxies, and external selection.
