// A whole evening's play with five independent browser sessions, each its own
// browser context (own storage, own anonymous identity), on five screen sizes.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const VIEWPORTS = [
  { name: 'Daniel', width: 390, height: 844 }, // iPhone 14
  { name: 'Sarah', width: 412, height: 915 }, // Pixel 7
  { name: 'Matthew', width: 320, height: 568 }, // small iPhone
  { name: 'Elizabeth', width: 820, height: 1180 }, // tablet
  { name: 'Ruth', width: 1440, height: 900 }, // desktop
];

interface Seat {
  name: string;
  context: BrowserContext;
  page: Page;
}

async function seats(browser: Browser, n = 5): Promise<Seat[]> {
  const out: Seat[] = [];
  for (const v of VIEWPORTS.slice(0, n)) {
    const context = await browser.newContext({
      viewport: { width: v.width, height: v.height },
      hasTouch: v.width < 800,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    out.push({ name: v.name, context, page: await context.newPage() });
  }
  return out;
}

async function noSidewaysScroll(page: Page, where: string) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, `horizontal overflow at ${where} (${page.viewportSize()?.width}px)`).toBeLessThanOrEqual(0);
}

async function createRoom(host: Seat, mode: 'Digital cards' | 'Physical cards'): Promise<string> {
  await host.page.goto('./');
  await host.page.getByRole('button', { name: 'Create Game' }).click();
  await host.page.getByLabel('Your name').fill(host.name);
  await host.page.getByText(mode, { exact: true }).click();
  // These scenarios cover the original paper-and-voice game; scoring.spec.ts covers voting in the app.
  await host.page.getByText('Traditional', { exact: true }).click();
  await host.page.getByRole('button', { name: 'Create', exact: true }).click();
  const code = (await host.page.locator('.code').innerText()).trim();
  expect(code).toMatch(/^[A-Z2-9]{5}$/);
  return code;
}

async function joinByLink(seat: Seat, link: string) {
  await seat.page.goto(link);
  await seat.page.getByLabel('Your name').fill(seat.name);
  await seat.page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(seat.page.getByRole('heading', { name: 'The company assembles' })).toBeVisible();
}

const confirm = (page: Page, label: string) =>
  page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();

test('five players play several rounds, reconnect, and the host ends the game', async ({ browser }) => {
  const table = await seats(browser);
  const [host, ...others] = table;
  const all = table.map((s) => s.page);

  // 1. The host creates a room. The QR code encodes the invitation link.
  const code = await createRoom(host, 'Digital cards');
  await host.page.getByRole('button', { name: 'Copy invitation link' }).click();
  const link = await host.page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(new RegExp(`\\?room=${code}$`));
  await expect(host.page.getByRole('img', { name: /QR code/ }).locator('svg')).toBeVisible();

  // 2. Four more join: three by the link the QR code carries, one by typing the code.
  for (const s of others.slice(0, 3)) await joinByLink(s, link);
  const typed = others[3];
  await typed.page.goto('./');
  await typed.page.getByRole('button', { name: 'Join Game' }).click();
  await typed.page.getByLabel('Room code').fill(code.toLowerCase());
  await typed.page.getByLabel('Your name').fill(typed.name);
  await typed.page.getByRole('button', { name: 'Join', exact: true }).click();

  for (const p of all) {
    await expect(p.getByTestId('player-count')).toHaveText('5 players');
    await noSidewaysScroll(p, 'lobby');
  }
  // Scanning the code a second time lands back in the same seat, not a new one.
  await others[0].page.goto(link);
  await expect(others[0].page.getByTestId('player-count')).toHaveText('5 players');
  // Only the host can start.
  await expect(others[0].page.getByRole('button', { name: 'Start Game' })).toHaveCount(0);

  // 3. The host begins the game.
  await host.page.getByRole('button', { name: 'Start Game' }).click();

  const orders: string[][] = [];
  for (let round = 1; round <= 3; round++) {
    // 4. Readers go in joining order.
    const reader = table[(round - 1) % 5];
    const players = table.filter((s) => s !== reader);
    await expect(reader.page.getByTestId('reader-banner')).toHaveText('You are the Reader.');
    await expect(reader.page.getByTestId('round-number')).toHaveText(`Round ${round}`);
    const word = (await reader.page.getByTestId('word').innerText()).trim();
    const truth = (await reader.page.getByTestId('correct-definition').innerText()).trim();
    expect(word.length).toBeGreaterThan(2);
    expect(truth.length).toBeGreaterThan(10);

    // 5. Everyone else is told who is reading and sees no card.
    for (const s of players) {
      await expect(s.page.getByTestId('status')).toHaveText(`${reader.name} is preparing the next card.`);
      await expect(s.page.getByTestId('word')).toHaveCount(0);
    }
    if (round === 1) {
      // The reader may swap an unsuitable card; nobody else learns of it.
      await reader.page.getByRole('button', { name: 'Draw a different card' }).click();
      await expect(reader.page.getByTestId('word')).not.toHaveText(word);
    }
    const finalWord = (await reader.page.getByTestId('word').innerText()).trim();
    const finalTruth = (await reader.page.getByTestId('correct-definition').innerText()).trim();
    await reader.page.getByRole('button', { name: 'Use this card' }).click();

    // 6. Players get the word and nothing else, and submit.
    const absent = round === 3 ? players[3] : null;
    for (const s of players) {
      await expect(s.page.getByTestId('word')).toHaveText(finalWord);
      await expect(s.page.getByLabel('What do you think this word means?')).toBeVisible();
      expect(await s.page.content()).not.toContain(finalTruth);
      await noSidewaysScroll(s.page, 'submission');
    }
    // A blank definition is refused before it is sent.
    await players[0].page.getByRole('button', { name: 'Submit Definition' }).click();
    await expect(players[0].page.getByRole('alert')).toContainText('Please write a definition');

    for (const s of players) {
      if (s === absent) continue;
      await s.page.getByLabel('What do you think this word means?').fill(`${s.name}'s guess for round ${round}`);
      await s.page.getByRole('button', { name: 'Submit Definition' }).click();
      await expect(s.page.getByTestId('status')).toHaveText('Definition submitted.');
    }

    // 7. One player edits; the edit replaces the original.
    const editor = players[1];
    await editor.page.getByRole('button', { name: 'Edit Submission' }).click();
    await editor.page.getByLabel('What do you think this word means?').fill(`${editor.name} thought again (${round})`);
    await editor.page.getByRole('button', { name: 'Save Definition' }).click();
    await expect(editor.page.getByTestId('my-submission')).toHaveText(`${editor.name} thought again (${round})`);

    if (round === 2) {
      // 14. A player loses the connection, then closes the tab entirely; both times they come back in place.
      const flaky = players[2];
      await flaky.context.setOffline(true);
      await expect(flaky.page.getByText('Connection lost. Trying to reconnect…')).toBeVisible({ timeout: 15_000 });
      await flaky.context.setOffline(false);
      await expect(flaky.page.getByText('Connection lost. Trying to reconnect…')).toHaveCount(0, { timeout: 15_000 });
      await flaky.page.close();
      flaky.page = await flaky.context.newPage();
      await flaky.page.goto('./');
      await expect(flaky.page.getByTestId('status')).toHaveText('Definition submitted.');
      await expect(flaky.page.getByTestId('my-submission')).toHaveText(`${flaky.name}'s guess for round 2`);
    }

    // 8. The reader sees progress but no texts, and adds a bluff (round 1), skips (round 2),
    //    or closes by hand while someone is missing (round 3).
    const expectedTotal = 5;
    await expect(reader.page.getByTestId('progress')).toHaveText(`${absent ? 3 : 4} of ${expectedTotal} players ready.`);
    expect(await reader.page.content()).not.toContain('guess for round');
    await noSidewaysScroll(reader.page, 'reader submission');
    let count: number;
    if (round === 1) {
      await reader.page.getByLabel(/Your own false definition/).fill(`${reader.name} bluffs`);
      await reader.page.getByRole('button', { name: 'Submit Definition' }).click();
      count = 6;
    } else if (round === 2) {
      await reader.page.getByRole('button', { name: 'Skip', exact: true }).click();
      count = 5;
    } else {
      await reader.page.getByRole('button', { name: 'Skip', exact: true }).click();
      await reader.page.getByRole('button', { name: 'Close Submissions' }).click();
      await confirm(reader.page, 'Close Submissions');
      count = 4;
    }

    // 9–10. Collected and shuffled; only the reader receives the anonymous list.
    const items = reader.page.getByTestId('definition');
    await expect(items).toHaveCount(count);
    const order = (await items.allInnerTexts()).map((t) => t.trim());
    orders.push(order);
    expect(order.filter((t) => t.endsWith(finalTruth))).toHaveLength(1);
    expect(order[0]).toMatch(/^A\./);
    expect(await reader.page.locator('.reading-list').innerText()).not.toMatch(/Submitted by|Correct Definition/);
    for (const s of players) {
      await expect(s.page.getByTestId('status')).toHaveText('The reader is presenting the definitions.');
      await expect(s.page.getByTestId('definition')).toHaveCount(0);
      expect(await s.page.content()).not.toContain(finalTruth);
    }
    if (absent) {
      // Too late: the absent player's screen has moved on with everyone else's.
      await expect(absent.page.getByLabel('What do you think this word means?')).toHaveCount(0);
    }
    // Refreshing does not reshuffle; one-at-a-time shows the same order.
    await reader.page.reload();
    await expect(reader.page.getByTestId('definition')).toHaveCount(count);
    expect((await reader.page.getByTestId('definition').allInnerTexts()).map((t) => t.trim())).toEqual(order);
    await reader.page.getByRole('button', { name: 'One at a time' }).click();
    for (let i = 0; i < count; i++) {
      await expect(reader.page.getByTestId('definition')).toHaveText(order[i]);
      if (i < count - 1) await reader.page.getByRole('button', { name: 'Next', exact: true }).click();
    }
    await noSidewaysScroll(reader.page, 'reading');
    await reader.page.getByRole('button', { name: 'All together' }).click();

    // 11. Reveal needs a confirmation; cancelling reveals nothing.
    await reader.page.getByRole('button', { name: 'Reveal Answers' }).click();
    await reader.page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(players[0].page.getByTestId('revealed')).toHaveCount(0);
    await reader.page.getByRole('button', { name: 'Reveal Answers' }).click();
    await confirm(reader.page, 'Reveal Answers');

    for (const s of table) {
      const revealed = s.page.getByTestId('revealed');
      await expect(revealed).toHaveCount(count);
      const texts = (await revealed.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
      // Same order as it was read.
      texts.forEach((t, i) => expect(t.startsWith(order[i].replace(/\s+/g, ' '))).toBe(true));
      await expect(s.page.locator('[data-testid="revealed"][data-correct="true"]')).toHaveCount(1);
      await expect(s.page.locator('[data-correct="true"]')).toContainText(finalTruth);
      await expect(s.page.locator('[data-correct="true"]')).toContainText('Correct Definition.');
      await expect(s.page.getByText(`Submitted by ${editor.name}.`)).toBeVisible();
      await expect(s.page.getByText(`${editor.name} thought again (${round})`)).toBeVisible();
      await expect(s.page.getByText(`${editor.name}'s guess for round ${round}`)).toHaveCount(0);
      if (round === 1) await expect(s.page.getByText('Submitted by the Reader.')).toBeVisible();
      await noSidewaysScroll(s.page, 'reveal');
    }

    // 12. Next round: the next reader is assigned without anyone rejoining.
    await expect(players[2].page.getByRole('button', { name: 'Next Round' })).toHaveCount(0);
    await reader.page.getByRole('button', { name: 'Next Round' }).click();
  }

  // 13. Three rounds played, three different words, round four waiting.
  await expect(table[3].page.getByTestId('reader-banner')).toBeVisible();
  await expect(table[3].page.getByTestId('round-number')).toHaveText('Round 4');

  // 15. The host ends the game for everyone.
  await host.page.getByTestId('menu').click();
  await host.page.getByRole('button', { name: 'End Game' }).click();
  await confirm(host.page, 'End Game');
  for (const s of table) {
    await expect(s.page.getByRole('heading', { name: 'The game is ended' })).toBeVisible();
  }
  await table[1].page.getByRole('button', { name: 'Return Home' }).click();
  await expect(table[1].page.getByRole('button', { name: 'Create Game' })).toBeVisible();

  for (const s of table) await s.context.close();
});

test('physical cards, a late joiner, a replaced reader, a lost session and an expired link', async ({ browser }) => {
  test.skip(!!process.env.E2E_BASE_URL, 'uses the local test server to expire the room');
  const table = await seats(browser, 4);
  const [host, b, c, late] = table;
  const code = await createRoom(host, 'Physical cards');
  const link = `./?room=${code}`;
  await joinByLink(b, link);
  await joinByLink(c, link);
  await host.page.getByRole('button', { name: 'Start Game' }).click();

  // The reader types in the card from the box.
  await host.page.getByLabel('Word').fill('quire');
  await host.page.getByLabel('Correct definition').fill('Twenty-four sheets of paper.');
  await host.page.getByRole('button', { name: 'Confirm card' }).click();
  await expect(b.page.getByTestId('word')).toHaveText('quire');
  expect(await b.page.content()).not.toContain('Twenty-four sheets');

  // Someone arrives mid-round: they wait for the next one.
  await joinByLink(late, link).catch(() => undefined);
  await expect(late.page.getByTestId('status')).toContainText('You will join in from the next one.');

  // A draft survives a refresh.
  await b.page.getByLabel('What do you think this word means?').fill('A choir that cannot sing');
  await b.page.reload();
  await expect(b.page.getByLabel('What do you think this word means?')).toHaveValue('A choir that cannot sing');
  await b.page.getByRole('button', { name: 'Submit Definition' }).click();
  await expect(b.page.getByTestId('status')).toHaveText('Definition submitted.');

  // The host hands the reader's role to C mid-round; word and submissions are kept.
  await host.page.getByTestId('menu').click();
  await host.page.getByRole('button', { name: /^Sarah/ }).click();
  await host.page.getByRole('button', { name: 'Make reader' }).click();
  await expect(host.page.getByRole('dialog')).toContainText('will be shown the correct definition');
  await confirm(host.page, 'Make reader');
  await host.page.getByRole('button', { name: 'Back to the game' }).click();
  // Sarah is seat b here (second viewport name).
  await expect(b.page.getByText('You are now the Reader for this round')).toBeVisible();
  await expect(b.page.getByTestId('correct-definition')).toHaveText('Twenty-four sheets of paper.');
  await expect(host.page.getByTestId('correct-definition')).toHaveCount(0);

  // C loses their session completely; the host issues a rejoin code.
  await c.page.getByLabel('What do you think this word means?').fill('A kind of inquiry');
  await c.page.getByRole('button', { name: 'Submit Definition' }).click();
  // Everyone still expected has now submitted (the new reader's earlier guess counts as
  // the reader's own), so the round moves on by itself.
  await expect(c.page.getByTestId('status')).toHaveText('The reader is presenting the definitions.');
  await expect(b.page.getByTestId('definition')).toHaveCount(3);
  await host.page.getByTestId('menu').click();
  await host.page.getByRole('button', { name: /^Matthew/ }).click();
  await host.page.getByRole('button', { name: 'Rejoin code' }).click();
  const rejoin = (await host.page.locator('.notice .code-inline').innerText()).trim();
  expect(rejoin).toMatch(/^[A-Z2-9]{6}$/);
  await host.page.getByRole('button', { name: 'Back to the game' }).click();
  await c.context.clearCookies();
  await c.page.evaluate(() => localStorage.clear());
  await c.page.goto(link);
  await c.page.getByRole('button', { name: /Lost your place/ }).click();
  await c.page.getByLabel('Rejoin code from the host').fill(rejoin);
  await c.page.getByRole('button', { name: 'Rejoin', exact: true }).click();
  await expect(c.page.getByTestId('status')).toHaveText('The reader is presenting the definitions.');
  await expect(c.page.locator('.foot')).toContainText('Matthew');
  await expect(host.page.getByTestId('player-count')).toHaveCount(0);

  // The room expires; old links and old sessions say so plainly.
  const res = await host.page.request.post('http://127.0.0.1:5197/admin/expire-rooms');
  expect(res.ok()).toBe(true);
  await expect(host.page.getByTestId('fatal')).toContainText('ended or expired', { timeout: 15_000 });
  const stranger = await browser.newContext();
  const sp = await stranger.newPage();
  await sp.goto(link);
  await expect(sp.getByRole('heading', { name: 'This invitation has expired' })).toBeVisible();
  await stranger.close();
  for (const s of table) await s.context.close();
});
