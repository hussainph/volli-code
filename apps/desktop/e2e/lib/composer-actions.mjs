/**
 * The composer's selector configures what the PRIMARY commit starts; choosing a
 * row never submits. Plain creation is not in here — it is its own button.
 */
export async function selectCreationAction(page, name) {
  const composer = page.getByTestId("new-ticket-composer");
  await composer.getByRole("button", { name: "Choose what starts", exact: true }).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
}

/** One press: Create is a first-class button beside the primary, not a mode. */
export async function createOnlyTicket(page) {
  await page
    .getByTestId("new-ticket-composer")
    .getByRole("button", { name: "Create ticket", exact: true })
    .click();
}

export async function setComposerCreateMore(page, enabled) {
  await page
    .getByTestId("new-ticket-composer")
    .getByRole("button", { name: "Ticket options", exact: true })
    .click();
  await page.getByRole("switch", { name: "Create more", exact: true }).setChecked(enabled);
  await page.keyboard.press("Escape");
}
