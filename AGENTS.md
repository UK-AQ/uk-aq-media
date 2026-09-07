# UK AQ Media coding-agent rules

Runtime work belongs in this repository. Before implementation read sibling
`../TEST-uk-aq-system-docs/system_docs/SYSTEM_OVERVIEW.md`, then
`system_docs/media/README.md` and its selected `media_contract.md` in that docs repo.
If the checkout is named differently, locate the available uk-aq-system-docs sibling.
Active contracts are authoritative; plans are implementation guidance only.
System docs are read-only to coding agents. Report required documentation updates
in a Chat-mode handover; do not edit the documentation repository.

Code implementation does not authorise Cloudflare deployment, resource creation,
remote migrations, settings changes, paid services or work in other repositories.
Keep changes scoped and leave them unstaged/uncommitted unless separately authorised.

After implementation and local validation, ask for a separate explicit confirmation
before commit, amend or push, even if the initial task requested those operations.
The confirming reply must name commit, push or both. Earlier-task approval does not
carry forward. Do not create/switch branches or PRs unless explicitly requested.

Use small structural local checks. Do not create speculative functional test suites;
validate functionality through authorised real standalone Media operation before
website integration. Never execute archive code. Before substantial changes to
existing runtime code, preserve each in-scope source once per day under
`archive/YYYY-MM-DD/` with relative paths; do not archive docs/generated files.
