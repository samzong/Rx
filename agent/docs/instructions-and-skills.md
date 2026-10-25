## Instructions and skills

Rx resolves working-directory symlinks, then runs `git rev-parse --show-toplevel` there once per system prompt to find the nearest project root.
Git owns worktree, submodule, and nested-repository boundaries, unlike the simpler `.git` marker search.
Without Git or a containing root, project scope is the working directory alone.
Rx reads no project instructions or skills from ancestors outside that scope.
A missing directory or non-directory ancestor removes project scope.
Resume and ACP load keep the saved working directory and global context, without searching surviving ancestors or substituting the caller's directory.
Other path errors, including permission errors, stop context loading.

Local `@path` references occupy their own line outside fenced or indented code and expand in place.
Absolute, `~/`, `./`, and `../` paths permit spaces.
Unprefixed paths require a slash or dot, forbid whitespace, and expand only to regular files, including through symlinks.
Missing candidates, directories, and other file types stay literal, as do bare mentions, email addresses, URLs, and references within prose.
Thus `@types/node`, `@1.4.0`, and `@app.route` expand only if a matching file exists.
Relative paths use the resolved referring file's directory. `~/` uses the current home.
Rx loads each real file once across all instructions and references. Active-file cycles stop startup.
Missing top-level files are optional. Unreadable files, broken top-level symlinks, and missing explicit references stop startup with the source path.
Reference permission errors also include the source line.

Skill discovery follows directory symlinks and deduplicates real paths to stop cycles.
RX-SKILL-001 defines hidden-directory traversal, root priority, and collision reporting.
Names have deterministic ordering within each root.
A directory containing `SKILL.md` ends discovery below that directory.
Discovery skips `node_modules` and loose Markdown files.
Missing search directories are optional. Other discovery and metadata problems appear on stderr.
ACP stdout carries only protocol messages.

CLI and ACP build the complete system prompt before creating or opening a log.
Resume reads the saved directory without a lock before building context, then opens and repairs the session.
A failed build leaves no empty session ahead of the last real session in `--continue`.
Fixing the reference permits retry without cleanup. ACP errors include the source path and line when available.
Post-failure cleanup is the strongest alternative, but requires separate rollback for new logs, repairs, and locks.
Preflight avoids those writes and never silently drops missing references or cycles.

Rx supplies discovered files to the public pi-coding-agent 1.4.0 API through
`loadSkills({ includeDefaults: false, skillPaths: [...] })` and `formatSkillsForPrompt(skills, "read")`.
Upstream owns YAML metadata, validation, collision diagnostics, and prompt formatting.
Explicit `skillPaths` include hidden groups that upstream discovery skips, without upstream changes.
Rx retains its agent loop, tools, log, discovery boundary, and instruction expansion.
The simpler upstream default resource loader has different instruction paths and defaults from RX-CONTEXT-001 and RX-SKILL-001.
The `read` tool opens skill bodies by absolute path. References are relative to the skill directory.
Skills add no tools or permissions. Without a skill command, disabled skills require an ordinary user request supplying the file.
This contract adds no flags, environment variables, or hot reload.
