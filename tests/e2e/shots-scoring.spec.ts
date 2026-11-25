// Screenshots of the voting and scoring screens, for design review. Skipped
// unless SHOTS is set to an output folder:  SHOTS=shots npx playwright test shots
import { test, type Page } from '@playwright/test';

const dir = process.env.SHOTS;
test.skip(!dir, 'set SHOTS=<folder> to take screenshots');

test('voting and scoring screens', async ({ browser }) => {
  const mk = async () =>
    (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })).newPage();
  const pages = [await mk(), await mk(), await mk(), await mk()];
  const [a, b, c, d] = pages;
  const names = ['Daniel', 'Sarah', 'Matthew', 'Elizabeth'];
  const shot = (p: Page, name: string) => p.screenshot({ path: `${dir}/${name}.png`, fullPage: true });

  await a.goto('./');
  await a.getByRole('button', { name: 'Create Game' }).click();
  await a.getByLabel('Your name').fill('Daniel');
  await a.getByText('Physical cards', { exact: true }).click();
  await a.getByTestId('win-type').selectOption('rotations');
  await a.getByTestId('rotations').selectOption('1');
  await shot(a, '20-create-options');
  await a.getByRole('button', { name: 'Create', exact: true }).click();
  const code = (await a.locator('.code').innerText()).trim();
  for (let i = 1; i < 4; i++) {
    await pages[i].goto(`./?room=${code}`);
    await pages[i].getByLabel('Your name').fill(names[i]);
    await pages[i].getByRole('button', { name: 'Join', exact: true }).click();
    await pages[i].getByText('The company assembles').waitFor();
  }
  await a.getByText('4 players').waitFor();
  await shot(a, '21-lobby-options');

  const bluffs = [
    '',
    'A small brass bell rung to summon the servants to prayer.',
    'The warmth of the sun in winter.',
    'The art of mending fishing nets by moonlight.',
  ];
  for (let k = 0; k < 4; k++) {
    const reader = pages[k];
    if (k === 0) await a.getByRole('button', { name: 'Start Game' }).click();
    await reader.getByLabel('Word').fill(k === 0 ? 'apricity' : `word${k}`);
    await reader.getByLabel('Correct definition').fill('The warmth of the sun in winter, felt on a cold day.');
    await reader.getByRole('button', { name: 'Confirm card' }).click();
    for (let i = 0; i < 4; i++) {
      if (i === k) continue;
      await pages[i].getByLabel('What do you think this word means?').fill(bluffs[i] || 'A tax once levied upon windows facing the street.');
      await pages[i].getByRole('button', { name: 'Submit Definition' }).click();
    }
    await reader.getByRole('button', { name: 'Use the Card’s Wording' }).click();
    await reader.getByTestId('adjudicable').first().waitFor();
    if (k === 0) {
      await shot(a, '22-adjudication');
      await a.getByTestId('adjudicable').filter({ hasText: 'The warmth of the sun in winter.' }).getByRole('button').click();
      await a.getByRole('dialog').getByRole('button', { name: 'Accept as correct' }).click();
      await a.getByRole('button', { name: 'Continue to reading' }).click();
    } else {
      await reader.getByRole('button', { name: /continue/i }).click();
    }
    await reader.getByRole('button', { name: 'Open Voting' }).click();
    const voters = pages.filter((_p, i) => i !== k && !(k === 0 && i === 2));
    await voters[0].getByTestId('ballot-option').first().waitFor();
    if (k === 0) {
      await voters[0].getByTestId('ballot-option').filter({ hasText: 'fishing nets' }).click();
      await shot(voters[0], '23-ballot');
      await voters[0].getByRole('button', { name: 'Cast Vote' }).click();
      await voters[0].getByText('Vote submitted.').waitFor();
      await shot(voters[0], '24-ballot-voted');
      await shot(a, '25-reader-voting');
      await shot(c, '26-not-voting');
      await voters[1].getByTestId('ballot-option').filter({ hasText: 'felt on a cold day' }).click();
      await voters[1].getByRole('button', { name: 'Cast Vote' }).click();
      await a.getByTestId('reveal-step').first().click();
      await a.getByTestId('reveal-step').first().click();
      await a.getByTestId('reveal-step').nth(1).click();
      await shot(a, '27-reveal-reader');
      await shot(b, '28-reveal-player');
    } else {
      for (const v of voters) {
        await v.getByTestId('ballot-option').filter({ hasText: 'felt on a cold day' }).click();
        await v.getByRole('button', { name: 'Cast Vote' }).click();
      }
    }
    await reader.getByRole('button', { name: 'Reveal Answers' }).click();
    await reader.getByRole('dialog').getByRole('button', { name: 'Reveal Answers' }).click();
    await d.getByTestId('round-points').waitFor();
    if (k === 0) {
      await shot(d, '29-results');
      await b.getByTestId('scores').click();
      await b.screenshot({ path: `${dir}/30-scores-dialog.png` });
      await b.getByRole('dialog').getByRole('button', { name: 'Back to the game' }).click();
    }
    await reader.getByRole('button', { name: k === 3 ? 'Finish the Game' : 'Next Round' }).click();
  }
  await a.getByTestId('winners').waitFor();
  await shot(a, '31-final');
});
