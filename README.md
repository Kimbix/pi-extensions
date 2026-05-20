# Pi Extensions & Skills

A collection of custom extensions and skills for the [Pi coding agent](https://pi.dev).

## Contents

### Extensions

- **`pr-plan-workflow`** — A structured workflow extension that turns vague ideas into concrete, reviewable pull requests.

  | Command | Purpose |
  |---------|---------|
  | `/pr-plan` | Start a workflow: grill-me interview → locked plan → new branch → execute |
  | `/pr-done` | Mark work complete, generate summary, and open a PR via `gh` |
  | `/pr-cancel` | Cancel workflow, return to base branch, optionally delete the feature branch |
  | `/pr-resume` | Resume a previous workflow from an existing `pi/` branch |

  **Tools:**
  - `commit` — Stage and commit with conventional commit naming (`feat:`, `chore:`, `test:`, etc.)
  - `report_blocker` — Report an unblockable issue, create a GitHub issue, and pause the workflow

### Skills

- **`grill-me`** — Interview the user relentlessly about a plan or design until reaching shared understanding. Use when you want to stress-test a plan or get grilled on your design.

## Installation

Copy or symlink into your Pi project:

```bash
# From this repo into your project
cp -r .pi/extensions/* /path/to/your/project/.pi/extensions/
cp -r .pi/skills/* /path/to/your/project/.pi/skills/
```

Or use globally:

```bash
cp -r .pi/extensions/* ~/.pi/agent/extensions/
cp -r .pi/skills/* ~/.pi/agent/skills/
```

## Requirements

- `git`
- `gh` CLI (authenticated) — required by the PR-plan workflow extension
- A clean working tree to start `/pr-plan`
