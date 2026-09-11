# UK AQ Media coding-agent rules

Runtime work belongs in this repository. # UK AQ Media coding-agent rules

Runtime work belongs in this repository.

The authoritative UK AQ system documentation lives in the separate
`uk-aq-system-docs` repository. If a sibling checkout is already available,
read the relevant system docs before substantial implementation work.

A missing `uk-aq-system-docs` checkout MUST NOT block implementation.
Do not clone, authenticate to, or otherwise obtain that repository merely
to satisfy this instruction unless the current task explicitly asks you to.

When system docs are unavailable, use this repository's README, source code,
migrations, configuration, tests/checks, and existing implementation behaviour
as the working implementation boundary.

Do not invent or silently change architectural, policy, legal/permission,
publication, security, or cross-service contract decisions. If implementation
would require such a decision and the answer cannot be established from this
repository, stop that part of the change and report the required decision in
the handover.

If system docs are available, they remain authoritative over implementation
guidance in this repository. System docs are read-only to coding agents.
Report required documentation updates in the handover; do not edit the
documentation repository.

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
