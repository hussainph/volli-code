# Google developer docs reference

## Primary sources

- [Highlights](https://developers.google.com/style/highlights)
- [Headings and titles](https://developers.google.com/style/headings)
- [Second person and first person](https://developers.google.com/style/person)
- [Procedures](https://developers.google.com/style/procedures)
- [Prescriptive documentation](https://developers.google.com/style/prescriptive-documentation)
- [Voice and tone](https://developers.google.com/style/tone)

## Editorial rules

### Audience and voice

- Address one identified reader as **you**. Use third person only for actions
  performed by the software or that reader's users.
- Use active voice, present tense, concise sentences, and a conversational,
  professional tone.
- Prefer plain words and stable terminology. Define domain-specific terms when
  they first affect the reader's action.
- Write facts and supported outcomes. Product plans belong in planning or
  release material, not user instructions.

### Headings and structure

- Use sentence case, one unique H1, and a complete hierarchy without skipped or
  empty levels.
- Use a base verb for a task heading: `Create a project`, not `Creating a
  project`.
- Use a noun phrase for a concept heading: `Project settings`.
- Match the heading to the section's actual content. A heading is navigation,
  not decoration.

### Procedures

- Give the reader the shortest supported path for the documented goal.
- State preconditions before the action that depends on them.
- Start each numbered step with an imperative verb.
- Establish the UI or tool location before the action: `In Settings, select
  **Model Access**.`
- Keep an action and the result that enables the next action in the same step.
- Mark an optional step or section with `Optional:`.
- Use ordered lists for sequences and bullets for unordered facts.

### Formatting and media

- Bold UI labels. Use code font for commands, file names, flags, values, and
  code-related text.
- Use descriptive link text.
- Write alt text for screenshots. State the screen, the relevant control or
  state, and the information it contributes; do not repeat nearby prose.
- Avoid directional references such as `above`, `below`, or `right-hand side`.
  Name the UI control or use a screenshot when location matters.

## Review checklist

### Every page

- [ ] One reader, one goal, one dominant page type
- [ ] Opening establishes the outcome or concept without a generic warm-up
- [ ] Every claim matches product truth
- [ ] Product terms appear only after a useful definition or UI encounter
- [ ] Active voice, second person, sentence case, and stable terminology
- [ ] Exact UI labels and code formatting are correct
- [ ] Headings describe their content and form a valid hierarchy
- [ ] Links and screenshots add an actionable next step or information

### Tutorial or how-to

- [ ] End state and prerequisites appear before the procedure
- [ ] One recommended path, in reader order
- [ ] Each step has a clear action and only the necessary context
- [ ] Optional paths are explicitly marked or linked separately
- [ ] The final state and next action are clear

### Explanation or reference

- [ ] Explanation connects a concept to a reader decision or workflow
- [ ] Reference is scannable and avoids a procedural narrative
- [ ] Terminology is consistent with the product UI and related pages

## Related skill

Use `product-docs` for the broader documentation workflow, audience selection,
Diátaxis guidance, and anti-slop pass. This skill supplies the Google-specific
structure and procedure gate.
