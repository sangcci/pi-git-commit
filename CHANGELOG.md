# Changelog

All notable changes to this project will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/). Release versions are managed with Git tags using the `vMAJOR.MINOR.PATCH` format.

## [v0.2.0] - 2026-06-27

### Added

- Added `model` config support to select a pi model specifically for `/commit` proposal generation.
- Added support for provider-qualified model references such as `openai-codex/gpt-5.4-mini`.
- Added retry flow for commitlint and commit-msg hook failures before any commit is created.
- Added failure-context regeneration so rejected commit messages can be regenerated with hook output.

### Changed

- `/commit` now documents and preserves the default behavior of using the current pi session model when no model override is configured.
- Proposal progress UI now shows the resolved model and model-resolution failure reason when fallback is used.

## [v0.1.1] - 2026-06-27

### Changed

- Updated usage guidance to clarify running `/commit` from a Git repository subdirectory.

## [v0.1.0] - 2026-06-15

### Added

- Initial `/commit` pi extension command.
- Git status, staged diff, unstaged diff, recent log, and optional `sem` collection.
- AI-first commit unit and commit message proposal generation.
- Heuristic commit proposal fallback when the AI model is unavailable.
- User approval flow with proceed, edit, regenerate, and cancel actions.
- Commit subject, body, and footer editing support.
- Staged-only and all-working-tree commit modes.
- Filename handling for Unicode, spaces, and other special characters.
- Progress UI for Git state collection, proposal generation, user approval, and commit execution.
- Config support through project and global `pi-git-commit.json` files.
- Commitlint-style hint support for generated messages.

[v0.2.0]: https://github.com/sangcci/pi-git-commit/releases/tag/v0.2.0
[v0.1.1]: https://github.com/sangcci/pi-git-commit/releases/tag/v0.1.1
[v0.1.0]: https://github.com/sangcci/pi-git-commit/releases/tag/v0.1.0
