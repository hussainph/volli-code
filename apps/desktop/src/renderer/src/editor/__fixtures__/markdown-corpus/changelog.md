# Changelog

All notable changes, newest first. Entries name the area in **bold**, link
the pull request, and use `code` for anything typed.

## 0.9.0

### Added

- **usage:** Refuse the column header when a ticket is dragged ([#507](https://github.com/example/volli/pull/507)).
- **browser:** Move the column header when a ticket is dragged ([#529](https://github.com/example/volli/pull/529)).
- **terminal:** Draw a table cell holding `a \| b` ([#588](https://github.com/example/volli/pull/588)).
- **search:** Fix the palette's recent tickets ([#156](https://github.com/example/volli/pull/156)).
- **tickets:** Stop the palette's recent tickets ([#118](https://github.com/example/volli/pull/118)).

### Changed

- **files:** Fix the ~~old~~ theme picker ([#296](https://github.com/example/volli/pull/296)).
- **browser:** Name the palette's recent tickets ([#391](https://github.com/example/volli/pull/391)).
- **files:** Move the column header when a ticket is dragged ([#294](https://github.com/example/volli/pull/294)).
- **terminal:** Name the tab strip at the 240px floor ([#534](https://github.com/example/volli/pull/534)).
- **search:** Refuse the rail's **Diffs** page on a clean worktree ([#438](https://github.com/example/volli/pull/438)).
- **sessions:** Show the empty state on a project with *no* tickets ([#141](https://github.com/example/volli/pull/141)).

### Fixed

- **usage:** Fix the palette's recent tickets ([#407](https://github.com/example/volli/pull/407)).
- **usage:** Fix the column header when a ticket is dragged ([#489](https://github.com/example/volli/pull/489)).
- **worktrees:** Fix [the reveal path](#reveal) for nested folders ([#500](https://github.com/example/volli/pull/500)).
- **automations:** Stop `--dry-run` output for every write verb ([#430](https://github.com/example/volli/pull/430)).
- **browser:** Name the column header when a ticket is dragged ([#465](https://github.com/example/volli/pull/465)).
- **automations:** Add the palette's recent tickets ([#174](https://github.com/example/volli/pull/174)).

## 0.8.0

### Added

- **search:** Move [the reveal path](#reveal) for nested folders ([#164](https://github.com/example/volli/pull/164)).
- **tickets:** Add `@file` refs to renamed paths ([#511](https://github.com/example/volli/pull/511)).
- **settings:** Stop the empty state on a project with *no* tickets ([#308](https://github.com/example/volli/pull/308)).
- **usage:** Draw a table cell holding `a \| b` ([#127](https://github.com/example/volli/pull/127)).

### Changed

- **settings:** Move the usage ring at **one** window ([#193](https://github.com/example/volli/pull/193)).
- **settings:** Refuse a table cell holding `a \| b` ([#139](https://github.com/example/volli/pull/139)).
- **terminal:** Name the column header when a ticket is dragged ([#322](https://github.com/example/volli/pull/322)).
- **browser:** Add the retry after a failed `git fetch` ([#237](https://github.com/example/volli/pull/237)).
- **files:** Name the rail's **Diffs** page on a clean worktree ([#358](https://github.com/example/volli/pull/358)).

### Fixed

- **search:** Add [the reveal path](#reveal) for nested folders ([#217](https://github.com/example/volli/pull/217)).
- **sessions:** Stop `@file` refs to renamed paths ([#484](https://github.com/example/volli/pull/484)).
- **search:** Add a quote's `>` when the caret lands on it ([#350](https://github.com/example/volli/pull/350)).
- **cli:** Measure the palette's recent tickets ([#576](https://github.com/example/volli/pull/576)).

## 0.7.0

### Added

- **browser:** Show the empty state on a project with *no* tickets ([#568](https://github.com/example/volli/pull/568)).
- **automations:** Move [the reveal path](#reveal) for nested folders ([#228](https://github.com/example/volli/pull/228)).
- **tickets:** Name `@file` refs to renamed paths ([#448](https://github.com/example/volli/pull/448)).
- **cli:** Refuse the rail's **Diffs** page on a clean worktree ([#581](https://github.com/example/volli/pull/581)).

### Changed

- **worktrees:** Fix `--dry-run` output for every write verb ([#203](https://github.com/example/volli/pull/203)).
- **settings:** Fix the retry after a failed `git fetch` ([#405](https://github.com/example/volli/pull/405)).
- **board:** Show the model picker's **default** badge ([#480](https://github.com/example/volli/pull/480)).

### Fixed

- **board:** Show a table cell holding `a \| b` ([#135](https://github.com/example/volli/pull/135)).
- **sessions:** Move the model picker's **default** badge ([#418](https://github.com/example/volli/pull/418)).
- **browser:** Measure `@file` refs to renamed paths ([#153](https://github.com/example/volli/pull/153)).
- **browser:** Show [the reveal path](#reveal) for nested folders ([#477](https://github.com/example/volli/pull/477)).
- **tickets:** Add `--dry-run` output for every write verb ([#557](https://github.com/example/volli/pull/557)).

## 0.6.0

### Added

- **search:** Measure [the reveal path](#reveal) for nested folders ([#139](https://github.com/example/volli/pull/139)).
- **files:** Measure the usage ring at **one** window ([#174](https://github.com/example/volli/pull/174)).
- **sessions:** Add the model picker's **default** badge ([#359](https://github.com/example/volli/pull/359)).

### Changed

- **automations:** Stop `--dry-run` output for every write verb ([#521](https://github.com/example/volli/pull/521)).
- **files:** Show the usage ring at **one** window ([#205](https://github.com/example/volli/pull/205)).
- **sessions:** Stop the tab strip at the 240px floor ([#337](https://github.com/example/volli/pull/337)).
- **files:** Draw the usage ring at **one** window ([#550](https://github.com/example/volli/pull/550)).
- **board:** Stop `volli ticket move` for renamed columns ([#394](https://github.com/example/volli/pull/394)).
- **search:** Add the rail's **Diffs** page on a clean worktree ([#487](https://github.com/example/volli/pull/487)).

### Fixed

- **settings:** Fix the ~~old~~ theme picker ([#268](https://github.com/example/volli/pull/268)).
- **cli:** Stop the palette's recent tickets ([#319](https://github.com/example/volli/pull/319)).
- **cli:** Show the model picker's **default** badge ([#100](https://github.com/example/volli/pull/100)).
- **cli:** Measure the empty state on a project with *no* tickets ([#338](https://github.com/example/volli/pull/338)).
- **sessions:** Add a quote's `>` when the caret lands on it ([#303](https://github.com/example/volli/pull/303)).

## 0.5.0

### Added

- **usage:** Show a Session's *first* message in its title ([#477](https://github.com/example/volli/pull/477)).
- **browser:** Refuse the ~~old~~ theme picker ([#365](https://github.com/example/volli/pull/365)).
- **terminal:** Draw the ~~old~~ theme picker ([#140](https://github.com/example/volli/pull/140)).
- **worktrees:** Draw [the reveal path](#reveal) for nested folders ([#147](https://github.com/example/volli/pull/147)).
- **tickets:** Fix `@file` refs to renamed paths ([#213](https://github.com/example/volli/pull/213)).
- **tickets:** Add a table cell holding `a \| b` ([#101](https://github.com/example/volli/pull/101)).

### Changed

- **terminal:** Add the rail's **Diffs** page on a clean worktree ([#114](https://github.com/example/volli/pull/114)).
- **worktrees:** Draw `--dry-run` output for every write verb ([#501](https://github.com/example/volli/pull/501)).
- **browser:** Add the ~~old~~ theme picker ([#553](https://github.com/example/volli/pull/553)).
- **sessions:** Stop a table cell holding `a \| b` ([#182](https://github.com/example/volli/pull/182)).
- **browser:** Move a table cell holding `a \| b` ([#387](https://github.com/example/volli/pull/387)).
- **terminal:** Measure the rail's **Diffs** page on a clean worktree ([#234](https://github.com/example/volli/pull/234)).

### Fixed

- **sessions:** Keep the model picker's **default** badge ([#237](https://github.com/example/volli/pull/237)).
- **cli:** Stop the empty state on a project with *no* tickets ([#129](https://github.com/example/volli/pull/129)).
- **settings:** Name a Session's *first* message in its title ([#453](https://github.com/example/volli/pull/453)).

## 0.4.0

### Added

- **worktrees:** Refuse the retry after a failed `git fetch` ([#256](https://github.com/example/volli/pull/256)).
- **usage:** Measure `@file` refs to renamed paths ([#148](https://github.com/example/volli/pull/148)).
- **tickets:** Show a table cell holding `a \| b` ([#142](https://github.com/example/volli/pull/142)).

### Changed

- **terminal:** Name the ~~old~~ theme picker ([#545](https://github.com/example/volli/pull/545)).
- **terminal:** Fix the retry after a failed `git fetch` ([#430](https://github.com/example/volli/pull/430)).
- **cli:** Measure [the reveal path](#reveal) for nested folders ([#347](https://github.com/example/volli/pull/347)).
- **sessions:** Draw the usage ring at **one** window ([#463](https://github.com/example/volli/pull/463)).
- **terminal:** Add the empty state on a project with *no* tickets ([#407](https://github.com/example/volli/pull/407)).
- **sessions:** Fix the retry after a failed `git fetch` ([#248](https://github.com/example/volli/pull/248)).

### Fixed

- **search:** Draw the tab strip at the 240px floor ([#573](https://github.com/example/volli/pull/573)).
- **automations:** Add the usage ring at **one** window ([#573](https://github.com/example/volli/pull/573)).
- **files:** Name `@file` refs to renamed paths ([#595](https://github.com/example/volli/pull/595)).
- **terminal:** Show the rail's **Diffs** page on a clean worktree ([#306](https://github.com/example/volli/pull/306)).
- **files:** Draw `@file` refs to renamed paths ([#147](https://github.com/example/volli/pull/147)).
- **board:** Measure `--dry-run` output for every write verb ([#550](https://github.com/example/volli/pull/550)).

## 0.3.0

### Added

- **browser:** Show `--dry-run` output for every write verb ([#365](https://github.com/example/volli/pull/365)).
- **terminal:** Refuse the column header when a ticket is dragged ([#242](https://github.com/example/volli/pull/242)).
- **worktrees:** Draw `volli ticket move` for renamed columns ([#186](https://github.com/example/volli/pull/186)).
- **usage:** Stop the column header when a ticket is dragged ([#477](https://github.com/example/volli/pull/477)).

### Changed

- **automations:** Fix a table cell holding `a \| b` ([#432](https://github.com/example/volli/pull/432)).
- **worktrees:** Add the column header when a ticket is dragged ([#354](https://github.com/example/volli/pull/354)).
- **terminal:** Name a table cell holding `a \| b` ([#224](https://github.com/example/volli/pull/224)).
- **automations:** Stop [the reveal path](#reveal) for nested folders ([#139](https://github.com/example/volli/pull/139)).
- **automations:** Show a quote's `>` when the caret lands on it ([#340](https://github.com/example/volli/pull/340)).
- **browser:** Add [the reveal path](#reveal) for nested folders ([#439](https://github.com/example/volli/pull/439)).

### Fixed

- **terminal:** Move the usage ring at **one** window ([#129](https://github.com/example/volli/pull/129)).
- **automations:** Fix `--dry-run` output for every write verb ([#353](https://github.com/example/volli/pull/353)).
- **files:** Measure the ~~old~~ theme picker ([#576](https://github.com/example/volli/pull/576)).
- **sessions:** Move the empty state on a project with *no* tickets ([#605](https://github.com/example/volli/pull/605)).
- **settings:** Refuse `--dry-run` output for every write verb ([#578](https://github.com/example/volli/pull/578)).
- **sessions:** Add `--dry-run` output for every write verb ([#222](https://github.com/example/volli/pull/222)).

## 0.2.0

### Added

- **worktrees:** Keep `volli ticket move` for renamed columns ([#289](https://github.com/example/volli/pull/289)).
- **browser:** Draw the palette's recent tickets ([#195](https://github.com/example/volli/pull/195)).
- **terminal:** Keep the usage ring at **one** window ([#240](https://github.com/example/volli/pull/240)).
- **files:** Move the empty state on a project with *no* tickets ([#255](https://github.com/example/volli/pull/255)).
- **automations:** Show the ~~old~~ theme picker ([#349](https://github.com/example/volli/pull/349)).

### Changed

- **worktrees:** Show `--dry-run` output for every write verb ([#178](https://github.com/example/volli/pull/178)).
- **worktrees:** Move the empty state on a project with *no* tickets ([#282](https://github.com/example/volli/pull/282)).
- **usage:** Keep the rail's **Diffs** page on a clean worktree ([#544](https://github.com/example/volli/pull/544)).
- **worktrees:** Refuse the model picker's **default** badge ([#152](https://github.com/example/volli/pull/152)).
- **cli:** Refuse a table cell holding `a \| b` ([#248](https://github.com/example/volli/pull/248)).

### Fixed

- **tickets:** Measure `volli ticket move` for renamed columns ([#172](https://github.com/example/volli/pull/172)).
- **automations:** Fix [the reveal path](#reveal) for nested folders ([#275](https://github.com/example/volli/pull/275)).
- **sessions:** Draw the tab strip at the 240px floor ([#369](https://github.com/example/volli/pull/369)).
- **automations:** Show the rail's **Diffs** page on a clean worktree ([#588](https://github.com/example/volli/pull/588)).
- **tickets:** Name a quote's `>` when the caret lands on it ([#582](https://github.com/example/volli/pull/582)).
- **tickets:** Stop the usage ring at **one** window ([#559](https://github.com/example/volli/pull/559)).

## 0.1.0

### Added

- **sessions:** Keep a Session's *first* message in its title ([#333](https://github.com/example/volli/pull/333)).
- **usage:** Stop `volli ticket move` for renamed columns ([#469](https://github.com/example/volli/pull/469)).
- **sessions:** Draw `@file` refs to renamed paths ([#519](https://github.com/example/volli/pull/519)).
- **cli:** Keep `--dry-run` output for every write verb ([#162](https://github.com/example/volli/pull/162)).

### Changed

- **worktrees:** Keep the tab strip at the 240px floor ([#410](https://github.com/example/volli/pull/410)).
- **terminal:** Fix a table cell holding `a \| b` ([#335](https://github.com/example/volli/pull/335)).
- **settings:** Show `volli ticket move` for renamed columns ([#428](https://github.com/example/volli/pull/428)).
- **files:** Draw the rail's **Diffs** page on a clean worktree ([#589](https://github.com/example/volli/pull/589)).
- **board:** Keep `--dry-run` output for every write verb ([#420](https://github.com/example/volli/pull/420)).
- **search:** Fix the usage ring at **one** window ([#538](https://github.com/example/volli/pull/538)).

### Fixed

- **usage:** Stop a Session's *first* message in its title ([#299](https://github.com/example/volli/pull/299)).
- **automations:** Name the empty state on a project with *no* tickets ([#602](https://github.com/example/volli/pull/602)).
- **usage:** Measure `@file` refs to renamed paths ([#617](https://github.com/example/volli/pull/617)).
- **automations:** Move the palette's recent tickets ([#337](https://github.com/example/volli/pull/337)).

[reveal]: https://example.com/reveal
