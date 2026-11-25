// Screenshots of the main screens, for design review. Skipped unless SHOTS is
// set to an output folder:  SHOTS=shots npx playwright test shots
import { test, type Page } from '@playwright/test';

const dir = process.env.SHOTS;
test.skip(!dir, 'set SHOTS=<folder> to take screenshots');

test('screens', async ({ browser }) => {
  const mk = async () => (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
  const [a, b, c] = [await mk(), await mk(), await mk()];
  const shot = (p: Page, name: string) => p.screenshot({ path: `${dir}/${name}.png`, fullPage: true });

  await a.goto('./');
  await shot(a, '01-home');
  await a.getByRole('button', { name: 'Create Game' }).click();
  await a.getByLabel('Your name').fill('Daniel');
  await a.getByText('Traditional', { exact: true }).click();
  await shot(a, '02-create');
  await a.getByRole('button', { name: 'Create', exact: true }).click();
  const code = (await a.locator('.code').innerText()).trim();
  for (const [p, n] of [[b, 'Sarah'], [c, 'Matthew']] as const) {
    await p.goto(`./?room=${code}`);
    await p.getByLabel('Your name').fill(n);
    if (n === 'Sarah') await shot(p, '03-join');
    await p.getByRole('button', { name: 'Join', exact: true }).click();
  }
  await a.getByText('3 players').waitFor();
  await shot(a, '04-lobby');
  await a.getByRole('button', { name: 'Start Game' }).click();
  await a.getByTestId('reader-banner').waitFor();
  await shot(a, '05-card');
  await shot(b, '06-card-waiting');
  await a.getByRole('button', { name: 'Use this card' }).click();
  await b.getByLabel('What do you think this word means?').fill('A small brass bell rung to summon the servants to prayer.');
  await shot(b, '07-submit');
  await b.getByRole('button', { name: 'Submit Definition' }).click();
  await b.getByText('Definition submitted.').waitFor();
  await shot(b, '08-waiting');
  await shot(a, '09-reader-submit');
  await c.getByLabel('What do you think this word means?').fill('The art of mending fishing nets by moonlight.');
  await c.getByRole('button', { name: 'Submit Definition' }).click();
  await a.getByLabel(/Your own false definition/).fill('A tax once levied upon windows facing the street.');
  await a.getByRole('button', { name: 'Submit Definition' }).click();
  await a.getByTestId('definition').first().waitFor();
  await shot(a, '10-reading');
  await shot(b, '11-reading-waiting');
  await a.getByRole('button', { name: 'Reveal Answers' }).click();
  await a.getByRole('dialog').getByRole('button', { name: 'Reveal Answers' }).click();
  await b.getByTestId('revealed').first().waitFor();
  await shot(b, '12-reveal');
  await a.getByTestId('menu').click();
  await a.getByRole('button', { name: /^Sarah/ }).click();
  await a.screenshot({ path: `${dir}/13-host-menu.png` });
});
