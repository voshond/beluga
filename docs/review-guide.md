# Review guide

A project's review guide holds the rules its reviewers keep sending back, written down so your agents follow them before anyone reviews their work. Beluga keeps it for you, per project, outside the repository: nothing is committed, and teammates don't get it unless you share it yourself.

## What it does

When a project has a guide:

- **Every run of yours there gets its brief** (a worktree, or a chat in the main folder). The brief is a short "how to work here" (under 30 lines) that names the guide, so the agent reads the parts for the area it changes. It's the **Review guide** entry in Settings › Skills & instructions › Built-in instructions. A friend's, a guest's or an outside agent's run never gets it.
- **Every pull request your agent opens there is checked against it first.** The PR prompt (`buildPrPrompt`) adds a step before the push: read the guide, go through the diff against its rules, its "AI pitfalls" table and "Checks before a pull request", fix and commit what breaks one, run its checks, and add a "## Checked" section to the description. This covers Create PR with Instructions…, pull requests for tasks and issues, and your agent opening one in chat.
- **Create PR goes through your agent.** Without a guide, Create PR (and Create Draft PR) commits and opens the pull request straight away, with no agent. With one, it asks your agent to check the work and then open it, so nothing reaches review unchecked. Create PR on the original and Open Your Own PR stay as they were.

## Managing it

Project Settings › **Review Guide** (⌘K › Project Settings…):

- **Generate** (Regenerate once there is one) starts a chat of its own, named "Review guide for <project>", with the prompt below. It runs in Beluga's folder for the guide, so it can write there. It reads the repository and its pull requests with `gh`, and changes nothing in the repository.
- **Open** opens the guide in your editor. Edits apply to the next run.
- **Remove** takes the guide and the brief out. The project's pull requests then open as before. Your prompt stays.
- **How it's written** is the prompt Generate uses. The built-in one reads every human review comment and reply thread, the PR conversations and the code, then writes the guide in a fixed structure (rules by area, AI pitfalls, patterns to copy, the checks before a pull request, open decisions, a glossary) and the brief. **Save** keeps your own for this project. **Use the Built-in Prompt** goes back to the built-in one. In a prompt, `{{project}}`, `{{root}}` (the main folder), `{{guide}}` and `{{brief}}` (where to write) are filled in. `{{guidePath}}` is left as it is: the brief keeps it, and Beluga puts the guide's path there for each run.

## Where it lives

`~/.beluga/review-guides/<folder name>-<8 hex>/`, one folder per project (by its main folder's path):

| File | What it is |
|---|---|
| `guide.md` | The guide. Agents read it from here. |
| `brief.md` | The brief every run there gets. Optional: without it, runs are only told where the guide is. |
| `prompt.md` | Your own prompt for Generate, when you saved one. |

The code is in `src/workspaces/review-guide.ts`. The project's state carries `scripts.reviewGuide` (when it was updated, its size, whether it has a brief).

## API and the phone

`workbench.reviewGuide`, `workbench.setReviewGuidePrompt`, `workbench.generateReviewGuide`, `workbench.openReviewGuide` and `workbench.removeReviewGuide` are `mac` in `src/companion/coverage.ts`: they are project settings, and the phone never gets settings. A pull request opened from the phone still goes through the check, because it runs in the daemon. An outside agent can't read or change the guide.
