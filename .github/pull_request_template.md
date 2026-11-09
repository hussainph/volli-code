## Summary

What changed for the person using Volli, and why. Link the related issue, if any.

## Checks

Commands you ran and their results:

## Screenshots

For visual changes, attach screenshots or a recording here. Do not commit them to the repository.

<details>
<summary>Architecture checklist (for changes that add exports or cross-package seams)</summary>

- [ ] Every new export names its production caller or an explicit receiving-task wiring requirement. Tests and lab simulations do not count.
- [ ] Cross-task contracts are recorded before dependent implementation starts.
- [ ] Each required path is wired before the change is considered complete.
- [ ] Lab simulations visibly say **Simulated wiring**.

Caller evidence, and the exported-seam advisory (`node scripts/report-exported-seams.mjs`) if relevant:

</details>
