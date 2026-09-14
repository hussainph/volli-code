/** The composer's selector configures a commit; choosing a row never submits. */
export async function selectCreationAction(page, name) {
  const composer = page.getByTestId("new-ticket-composer");
  await composer.getByRole("button", { name: "Choose creation action", exact: true }).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
}

export async function createOnlyTicket(page) {
  await selectCreationAction(page, "Create only");
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
