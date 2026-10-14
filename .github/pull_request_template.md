## Summary

Describe the behavior changed and link the related issue or ticket, if any.

## Wiring review

- [ ] Every new export names its production caller or an explicit receiving-task wiring requirement. Tests and lab simulations do not count.
- [ ] Cross-task contracts are recorded before dependent implementation starts.
- [ ] Each required path is wired before the change is considered complete.
- [ ] Lab simulations visibly say **Simulated wiring**.

Caller evidence (or not applicable):

## Checks

Commands and results:

Exported-seam advisory (`node scripts/report-exported-seams.mjs`, collapsed output if relevant):

## Decisions to confirm

None.
