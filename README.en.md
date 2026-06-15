# pi-git-commit

A Git commit extension.
It inspects the current changes and uses AI to propose commit units and commit messages.

Korean Version: [README.md](README.md)

## Features

- AI proposes commit units and messages from real Git changes.
- Approval step before creating commits.
- Direct editing for commit subject, body, and footer.
- Regenerate messages with an additional instruction.
- Uses commitlint-style hints and `sem` when configured.
- Choose priority between staged and unstaged changes.
- Heuristic message generation when the AI model is unavailable.
- On failure, print the error and stop the loop.

## Flow

```text
/git-commit
   |
   v
Collect Git state
(status, diff, staged diff, log, optional sem)
   |
   v
Choose commit scope
(staged only / all working tree changes)
   |
   v
Generate commit proposal
(AI first, heuristic fallback)
   |
   v
User decision
(proceed / edit messages / regenerate / cancel)
   |
   v
Run git add + git commit
   |
   v
Success: show commit summary
Failure: show error and stop
```

## Internal structure

```text
index.ts
  register /git-commit
  runCommitWizard()
    loadConfig()
    collectGitState()
    chooseCommitMode()
    buildProposal()
      buildProposalWithModel()
      buildHeuristicProposal()
    editCommitMessages()
    executeCommits()
    classifyCommitFailure()
```

Context is kept only inside a single `/git-commit` command run. Nothing is persisted after the command finishes.

## Usage

### Installation

1. clone

```bash
git clone <repository-url> ~/Tools/pi-git-commit
```

You can clone it anywhere. The examples below assume it was cloned to `~/Tools/pi-git-commit`.

2. register

```bash
pi -e ~/Tools/pi-git-commit/index.ts
```

Loading the extension file with `pi -e` makes the `/git-commit` command available inside the pi session. If you cloned the repository somewhere else, adjust the path to `index.ts`.

3. run

Move to the Git repository where you want to create commits, run pi, then enter the command:

```text
/git-commit
```

The command reads the current repository's Git status and diff, then builds a commit proposal based on the staged and unstaged changes.

## Feature details

### Proposal screen

The proposal screen provides these options:

- `Proceed as proposed` — execute the proposed commits as-is.
- `Edit commit messages` — directly edit the commit subject, body, and footer.
- `Regenerate with instruction` — add an instruction and ask AI to generate the proposal again.
- `Cancel` — stop without creating any commits.

### When staged and unstaged changes are mixed

If staged and unstaged changes both exist, you choose the scope first.

- `Use staged changes only`
- `Use all working tree changes`
- `Cancel`

When `Use all working tree changes` is selected, the extension stages whole files for each proposed commit unit. It does not do hunk-level staging.

### Editing body and footer

When editing commit messages, keep the `body: |` and `footer: |` lines. Write the content on the indented lines below them.

```text
Commit 1
message: feat(test): add dog module
body: |
  Add a new dog module used by the test repository.
  Keep animal behavior separate from math helpers.
footer: |
  Refs: TEST-123
```

The actual commit message becomes:

```text
feat(test): add dog module

Add a new dog module used by the test repository.
Keep animal behavior separate from math helpers.

Refs: TEST-123
```

Leave body or footer empty when not needed.

```text
body: |
footer: |
```

## Configuration

The config file is optional.

Project-specific config takes priority.

```text
<repo>/.pi/pi-git-commit.json
```

If no project-specific config file exists, the global config is used.

```text
~/.pi/agent/pi-git-commit.json
```

If neither file exists, the extension uses defaults. Project-specific and global configs are not merged; when the project-specific config file exists, the global config is not read.

Example:

```json
{
  "message": {
    "language": "ko"
  },
  "lint": {
    "conventional": true,
    "types": ["feat", "fix", "docs", "test", "refactor", "chore"],
    "scopes": ["test"],
    "requireScope": true,
    "maxHeaderLength": 72,
    "maxSubjectLength": 60,
    "allowBody": true,
    "allowFooter": true
  },
  "commands": {
    "sem": "sem --json"
  }
}
```

### Message language

`message.language` controls the language used for the commit subject, body, and footer. Conventional commit type and scope tokens remain in English.

For example, with `"language": "ko"`, you can expect a message like this:

```text
feat(test): 수학 헬퍼 import 갱신
```

You can use `"en"`, `"ko"`, or a custom instruction such as `"Korean, concise"`.

### Lint config

The `lint` config is a hint used when AI generates proposals. The final source of truth is the actual `git commit` result. Repository hooks or commitlint may apply stricter rules.

## Failure policy

Commits can fail for many reasons. `pi-git-commit` does not try to handle those errors automatically. It stops and lets you fix the repository state yourself.

It does not automatically retry, force-add ignored files, edit `.gitignore`, or modify hooks. Those decisions are project-specific, so it is safer for the user to handle them directly. After cleaning up the Git state, run `/git-commit` again.

## bug report
