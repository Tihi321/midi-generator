# Changelog MDI-20

## 2026-11-22 MDI-20: seed no longer says to keep the nomic embedding model in LM Studio

- Repo midi-generator, branch `MDI-20_lm-studio-prose` (from master).
- `seed/config/providers.md` (Strata paragraph): last sentence now "no ComfyUI while it runs." (LM Studio advice removed).
- `ROADMAP.md`: new `## MDI-20` section after MDI-19.
- Deviations: none.
- Verification: grep for the old sentence prints nothing; `git diff master --stat` shows only ROADMAP.md and seed/config/providers.md; `yarn test` (82 files, 1198 tests), `yarn typecheck`, `yarn lint`, `yarn build` all exit 0.
- Not run: nothing runtime changes.
- Commit: see git log on the branch.
