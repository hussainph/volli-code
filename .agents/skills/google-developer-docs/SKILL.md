---
name: google-developer-docs
description: Apply Google developer documentation guidance to technical product docs.
disable-model-invocation: true
---

# Google developer docs

Use this skill with `product-docs` when a developer-facing page needs a
reader-tested structure, procedure, or editing pass grounded in Google's style
guide.

## Reader path

A **reader path** is the smallest sequence that lets one reader reach the page's
outcome. Build the page around that path, not around the product's internal
architecture.

## Workflow

### 1. Lock the page contract

Record, before drafting:

- one primary reader;
- the reader's goal and prior knowledge;
- one page type: tutorial, how-to, explanation, or reference;
- the source of truth for each product claim and UI label.

**Complete when:** every section has a purpose on the reader path, and every
fact can be checked against the product, code, or an approved source.

### 2. Choose the page branch

**Tutorial**

- State the end state in the opening.
- Give one recommended path with ordered steps.
- Put prerequisites and decisions before the step that needs them.
- Keep alternatives in an `Optional:` section or link to a separate task page.

**How-to**

- Title the page with the reader's goal.
- Start with the shortest supported path to that goal.
- Include only the context needed to complete it.

**Explanation**

- Define unfamiliar concepts in reader language before product-specific terms.
- Connect the concepts to a real workflow and its tradeoffs.
- Link to the tutorial or reference that lets the reader act.

**Reference**

- Organize stable facts for scanning.
- Use tables, exact UI labels, flags, and copyable examples where useful.
- Keep workflow explanation on its own page.

**Complete when:** the page has one dominant shape rather than a tutorial,
reference, and product pitch mixed together.

### 3. Draft the reader path

- Address the reader as **you**. Use active voice and present tense.
- Use task headings that start with a base verb. Use noun-phrase headings for
  concepts.
- In a procedure, name the location first, then the action. Give one action per
  step where practical.
- State a result or reason only when it prepares the next action.
- Use the product's exact UI labels in bold and code syntax in code font.
- Define product terms on first use. Keep one name for one concept afterward.
- Write image alt text that states the information the screenshot adds.

**Complete when:** a new reader can follow the path without decoding an
unintroduced internal term or choosing among equivalent paths.

### 4. Run the review

Check the whole page against the checklist in [REFERENCE.md](REFERENCE.md).
Read that file before publishing a tutorial, a procedure, a terminology-heavy
page, or a substantive docs rewrite.

**Complete when:** all modified sections pass the relevant branch checklist and
no claim describes future or unverified product behavior.
