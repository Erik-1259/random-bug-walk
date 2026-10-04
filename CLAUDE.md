@AGENTS.md

## Claude Code

- `.claude/settings.json` holds the deny rules and the attribution settings that `AGENTS.md` describes. Commit attribution, PR attribution and the session link are off.
- Project allow rules apply only after the folder's workspace trust prompt has been accepted; a headless run never shows that prompt, so headless runs pass the tools they need with `--allowedTools`.
- `/permissions` shows the effective rules and the file each rule comes from.
- Headless sessions in this repository run with `--permission-mode dontAsk` and an explicit `--allowedTools` list, so that writes to `.claude/` are refused.
