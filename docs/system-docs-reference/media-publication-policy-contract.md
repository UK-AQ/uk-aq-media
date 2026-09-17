# UK AQ Media publication policy contract

**Status:** Current narrow authority for source-wide and author-specific publication-state decisions. This contract supplements `media_contract.md` and `media-author-rules-contract.md` and supersedes any older wording that treats source-wide auto-approval as intrinsically limited to Air Quality News.

## 1. Source publication policy

Source `publication_policy` is authoritative and operator-editable for future otherwise-new, otherwise-eligible discoveries.

It MUST support at least:

```text
manual
auto_approve
```

For a source configured `auto_approve`, a future otherwise-new eligible article is Approved with:

```text
approval_method = trusted_source_auto
approval_author_rule_key = null
```

unless an explicit enabled author rule takes precedence under section 2.

For a source configured `manual`, a future otherwise-new eligible article enters Pending unless an explicit enabled author rule takes precedence.

Source-wide `auto_approve` is a general policy capability. It is not hard-coded to one source identity.

## 2. Author-rule precedence

For a positively matched, enabled author rule, publication precedence MUST be:

1. author `publication_policy=auto_approve` -> Approved with `approval_method=trusted_author_auto` and that author-rule key;
2. author `publication_policy=pending` -> Pending with no approval provenance;
3. author `publication_policy=inherit_source` -> apply the source's current publication policy;
4. if no enabled author rule matches -> apply the source's current publication policy.

Therefore an explicit author `pending` rule overrides source-wide `auto_approve`. An explicit author `auto_approve` retains `trusted_author_auto` provenance even when the source itself is also configured `auto_approve`.

## 3. Current/default configuration

The current/default source configuration remains distinct from the general policy semantics above.

- Air Quality News is currently configured `auto_approve`, so its future otherwise-new eligible articles use `trusted_source_auto`.
- The Guardian is currently configured `manual` / `standard`.
- BBC News, Sky News, The Independent, Carbon Brief, OpenAQ, Phys.org and DSAWSP are configured `manual` / `standard` where their direct discovery adapters are enabled.
- Communities Against Woodsmoke is an approved next direct source addition and MUST be configured `manual` / `standard` when implemented. Its direct-feed discoveries therefore enter Pending unless an explicit later policy change says otherwise.
- Gary Fuller's explicit Guardian author rule remains `auto_approve` and records `trusted_author_auto`.
- Damian Carrington and Fiona Harvey remain explicit `pending` author rules.

If an operator deliberately changes The Guardian source to `auto_approve`, Gary Fuller still records `trusted_author_auto`, Damian Carrington and Fiona Harvey remain Pending, and other otherwise-eligible Guardian authors inherit source-wide `auto_approve` and record `trusted_source_auto`.

The Communities Against Woodsmoke policy above is source-wide and prospective. Adding the source MUST NOT auto-approve its existing or newly discovered blog posts. A later deliberate change to `auto_approve`, if ever made, would apply only under the prospective-change rules in section 4.

## 4. Prospective-only changes

Changing a source or author publication rule affects future discovery/publication decisions only.

A rule change MUST NOT by itself:

- bulk-approve existing Pending rows;
- alter existing Approved rows;
- restore Rejected rows;
- restore Hidden rows;
- rewrite historical approval provenance;
- reclassify an already-known article merely because it is rediscovered after the policy change.

A deliberate later backfill/reclassification operation MAY be designed separately, but it must be explicit and preserve article/event provenance.

Existing rejected/hidden precedence over rediscovery remains unchanged.

## 5. Policy separation

Publication policy changes publication state only.

Changing a source to `auto_approve` MUST NOT broaden:

- discovery routes or supported adapters;
- deterministic relevance rules;
- source-content fetching permissions;
- AI permissions;
- image permissions;
- licensing assumptions.

A deterministic relevance/topic match decides whether an article is in scope. It does not itself bypass the applicable source/author publication policy.

## 6. Dashboard/admin behaviour

The Media dev dashboard MAY edit source-wide publication policy and explicit author rules through authenticated `media-admin` routes against authoritative D1/configuration state.

The dashboard MUST preserve the precedence in section 2 and MUST communicate that rule changes are prospective rather than silently rewriting existing articles.

Source-wide and author-specific auto-approval provenance MUST remain distinguishable.

## 7. Validation

After deployment, real TEST operation SHOULD confirm that:

- AQN remains source-auto-approved under its current configured policy;
- Guardian remains manual until deliberately changed;
- Communities Against Woodsmoke direct-feed discoveries enter Pending under `manual` / `standard` and do not receive trusted-source auto-approval provenance;
- a supported source changed to `auto_approve` auto-approves a different future otherwise-new eligible article with `trusted_source_auto`;
- an explicit author `pending` rule still produces Pending under a source-wide `auto_approve` policy;
- an explicit author `auto_approve` rule still produces `trusted_author_auto` under either source policy;
- existing Pending, Approved, Rejected and Hidden rows do not change merely because a source/author rule changes.
