# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Labels are created on first use

Only `ready-for-agent` exists in the tracker today. **Create a missing label at the moment a
skill actually needs it — do not create the whole vocabulary up front.** A label with no
issue carrying it is dead weight that outlives the decision that created it.

`wontfix` deliberately reuses GitHub's own default label of the same name: its built-in
meaning ("This will not be worked on") already matches the role, so there is nothing to
reconcile.
