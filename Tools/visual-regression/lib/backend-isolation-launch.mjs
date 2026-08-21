/**
 * @purpose The gated launch step for lanes whose page builds nothing until a launch control is pressed.
 * @status ACTIVE
 */
export async function launchLaneIfGated(page, launchSelector) {
  if (!launchSelector) {
    return;
  }

  await page.waitForSelector(launchSelector, { timeout: 10_000 });
  await page.click(launchSelector);
}
