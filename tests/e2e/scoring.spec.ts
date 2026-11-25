// Six independent browser sessions play a whole scored game: adjudication,
// private ballots, a changed vote, an abstention, staged reveal, automatic
// scoring, standings, the target-score ending and a rematch.
//
// The test keeps its own tally with the published scoring rules and checks
// every screen against it, so the app's arithmetic is verified independently.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const SEATS = [
  { name: 'Daniel', width: 390, height: 844 }, // iPhone 14
  { name: 'Sarah', width: 412, height: 915 }, // Pixel 7
  { name: 'Matthew', width: 320, height: 568 }, // small iPhone
  { name: 'Elizabeth', width: 820, height: 1180 }, // tablet
  { name: 'James', width: 1440, height: 900 }, // desktop
  { name: 'William', width: 360, height: 740 }, // small Android
];

interface Seat {
  name: string;
  context: BrowserContext;
  page: Page;
}

async function seats(browser: Browser): Promise<Seat[]> {
  const out: Seat[] = [];
  for (const v of SEATS) {
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

const confirm = (page: Page, label: string) =>
  page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();

const TRUE = 'TRUE';

interface RoundPlan {
  /** Whose written definition the reader accepts as correct, if anyone's. */
  scholar?: string;
  /** Does the reader add a bluff of their own? */
  readerBluffs?: boolean;
  /** voter name -> TRUE or the name of the player whose bluff they pick. */
  votes: Record<string, string>;
  /** A voter who first votes for something else, then changes to the planned vote. */
  changes?: { voter: string; first: string };
  /** A voter who never votes; the reader closes voting by hand. */
  absent?: string;
  /** Reveal step by step rather than all at once. */
  staged?: boolean;
  /** A voter who reloads the page after voting. */
  reloads?: string;
}

/** The published rules, applied by the test itself. */
function score(reader: string, plan: RoundPlan): Record<string, number> {
  const pts: Record<string, number> = {};
  const add = (who: string, n: number) => (pts[who] = (pts[who] ?? 0) + n);
  let anyCorrect = false;
  for (const [, target] of Object.entries(plan.votes)) {
    if (target === TRUE) anyCorrect = true;
    else add(target, 1);
  }
  for (const [voter, target] of Object.entries(plan.votes)) if (target === TRUE) add(voter, 2);
  if (plan.scholar) add(plan.scholar, 3);
  const cast = Object.keys(plan.votes).length;
  if (cast > 0 && !anyCorrect && !plan.absent && !plan.scholar) add(reader, 3);
  return pts;
}

test('six players play a scored game to the target, see the winner, and play again', async ({ browser }) => {
  test.setTimeout(420_000);
  const table = await seats(browser);
  const [host, ...others] = table;
  const names = table.map((t) => t.name);
  const seat = (n: string) => table.find((t) => t.name === n)!;

  // --- Create: voting and scoring in the app is the default; target of 5 points.
  await host.page.goto('./');
  await host.page.getByRole('button', { name: 'Create Game' }).click();
  await host.page.getByLabel('Your name').fill(host.name);
  await host.page.getByText('Physical cards', { exact: true }).click();
  await expect(host.page.getByRole('radio', { name: /Vote and score in the app/ })).toBeChecked();
  await expect(host.page.getByTestId('target')).toHaveValue('25');
  await host.page.getByTestId('target').selectOption('custom');
  await host.page.getByLabel('Custom target score').fill('5');
  await noSidewaysScroll(host.page, 'create');
  await host.page.getByRole('button', { name: 'Create', exact: true }).click();
  const code = (await host.page.locator('.code').innerText()).trim();
  await expect(host.page.getByTestId('rules')).toContainText('First to 5 points');

  // --- Everyone joins with the link the QR code carries.
  await host.page.getByRole('button', { name: 'Copy invitation link' }).click();
  const link = await host.page.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain(`?room=${code}`);
  // One after another, so the reading order is the order of the seats above.
  for (const s of others) {
    await s.page.goto(link);
    await s.page.getByLabel('Your name').fill(s.name);
    await s.page.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(s.page.getByRole('heading', { name: 'The company assembles' })).toBeVisible();
  }
  for (const s of table) await expect(s.page.getByTestId('player-count')).toHaveText('6 players');
  await host.page.getByRole('button', { name: 'Start Game' }).click();

  // --- Six rounds: one full rotation. Readers go in joining order.
  const plans: RoundPlan[] = [
    // 1. Reader Daniel adds a bluff. Staged reveal. Matthew changes his vote.
    {
      readerBluffs: true,
      staged: true,
      votes: { Sarah: TRUE, Matthew: 'Daniel', Elizabeth: 'Sarah', James: 'Sarah', William: TRUE },
      changes: { voter: 'Matthew', first: TRUE },
    },
    // 2. Reader Sarah accepts Elizabeth's written definition as correct.
    { scholar: 'Elizabeth', votes: { Daniel: TRUE, Matthew: 'Daniel', James: 'Daniel', William: 'Matthew' } },
    // 3. Reader Matthew. William never votes: closed by hand, an abstention.
    { absent: 'William', votes: { Daniel: 'Sarah', Sarah: TRUE, Elizabeth: 'Sarah', James: TRUE } },
    // 4. Reader Elizabeth fools the whole table: reader bonus.
    {
      votes: { Daniel: 'Sarah', Sarah: 'Daniel', Matthew: 'Sarah', James: 'Sarah', William: 'Daniel' },
      reloads: 'James',
    },
    // 5. Reader James.
    { votes: { Daniel: TRUE, Sarah: 'William', Matthew: 'William', Elizabeth: TRUE, William: 'Daniel' } },
    // 6. Reader William.
    { votes: { Daniel: 'James', Sarah: TRUE, Matthew: TRUE, Elizabeth: 'James', James: TRUE } },
  ];

  const totals: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));

  for (let k = 1; k <= plans.length; k++) {
    const plan = plans[k - 1];
    const reader = table[k - 1];
    const players = table.filter((s) => s !== reader);
    const truth = `The genuine meaning of word number ${k}.`;
    const bluff = (who: string) => `${who}'s invention for round ${k}`;
    const textOf = (target: string) => (target === TRUE ? truth : bluff(target));

    // Card (physical mode: the reader types it in).
    await expect(reader.page.getByTestId('reader-banner')).toBeVisible();
    await expect(reader.page.getByTestId('round-number')).toHaveText(`Round ${k}`);
    await reader.page.getByLabel('Word').fill(`word${k}`);
    await reader.page.getByLabel('Correct definition').fill(truth);
    await reader.page.getByRole('button', { name: 'Confirm card' }).click();

    // Definitions, all at once.
    await Promise.all(
      players.map(async (s) => {
        await s.page
          .getByLabel('What do you think this word means?')
          .fill(s.name === plan.scholar ? `the genuine meaning of word number ${k}` : bluff(s.name));
        await s.page.getByRole('button', { name: 'Submit Definition' }).click();
      }),
    );
    if (plan.readerBluffs) {
      await reader.page.getByLabel(/Your own false definition/).fill(bluff(reader.name));
      await reader.page.getByRole('button', { name: 'Submit Definition' }).click();
    } else {
      await reader.page.getByRole('button', { name: 'Skip', exact: true }).click();
    }

    // Adjudication: the reader sees the others' definitions without names.
    const adjudicables = reader.page.getByTestId('adjudicable');
    await expect(adjudicables).toHaveCount(5);
    const adjText = (await reader.page.locator('.adjudication').innerText()).toString();
    for (const n of names) expect(adjText).not.toContain(`${n} `);
    for (const s of players) {
      await expect(s.page.getByTestId('status')).toHaveText(`${reader.name} is looking over the definitions.`);
      expect(await s.page.content()).not.toContain(truth);
    }
    if (plan.scholar) {
      await adjudicables
        .filter({ hasText: `the genuine meaning of word number ${k}` })
        .getByRole('button', { name: 'This is correct' })
        .click();
      await confirm(reader.page, 'Accept as correct');
      await expect(reader.page.getByText('Accepted as correct.')).toBeVisible();
      await reader.page.getByRole('button', { name: 'Continue to reading' }).click();
    } else {
      await reader.page.getByRole('button', { name: 'None are correct — continue' }).click();
    }

    // Reading: shuffled once; the accepted definition is not read out.
    const expectedCount = 6 - (plan.scholar ? 1 : 0) + (plan.readerBluffs ? 1 : 0);
    await expect(reader.page.getByTestId('definition')).toHaveCount(expectedCount);
    const order = (await reader.page.getByTestId('definition').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    if (plan.scholar) expect(order.join('|')).not.toContain('the genuine meaning of word number');
    // Voting does not open by itself.
    for (const s of players) {
      await expect(s.page.getByTestId('status')).toHaveText('The reader is presenting the definitions.');
      await expect(s.page.getByTestId('ballot-option')).toHaveCount(0);
    }
    await reader.page.getByRole('button', { name: 'Open Voting' }).click();

    // Ballots: same list, same letters, same order as the reader read.
    const voters = players.filter((s) => s.name !== plan.scholar);
    for (const s of voters) {
      const options = s.page.getByTestId('ballot-option');
      await expect(options).toHaveCount(expectedCount);
      const mine = (await options.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
      mine.forEach((t, i) => expect(t.startsWith(order[i]), `ballot order for ${s.name}`).toBe(true));
      // Their own definition is marked and cannot be chosen.
      const own = options.filter({ hasText: bluff(s.name) });
      await expect(own).toContainText('Your definition');
      await expect(own.getByRole('radio')).toBeDisabled();
      await expect(s.page.getByText('Your definition')).toHaveCount(1);
      await expect(s.page.getByRole('button', { name: 'Cast Vote' })).toBeDisabled();
      await noSidewaysScroll(s.page, 'ballot');
    }
    if (plan.scholar) {
      await expect(seat(plan.scholar).page.getByTestId('status')).toContainText('You are not voting in this round.');
      await expect(seat(plan.scholar).page.getByTestId('ballot-option')).toHaveCount(0);
    }
    // The reader has no ballot, only a list of who has voted.
    await expect(reader.page.getByRole('heading', { name: 'Voting in Progress' })).toBeVisible();
    await expect(reader.page.getByTestId('voter')).toHaveCount(voters.length);
    await expect(reader.page.getByRole('button', { name: 'Cast Vote' })).toHaveCount(0);

    const vote = async (s: Seat, target: string) => {
      await s.page.getByTestId('ballot-option').filter({ hasText: textOf(target) }).click();
      await s.page.getByRole('button', { name: 'Cast Vote' }).click();
    };

    if (plan.changes) {
      const c = seat(plan.changes.voter);
      await vote(c, plan.changes.first);
      await expect(c.page.getByTestId('status')).toHaveText('Vote submitted.');
      await expect(reader.page.getByTestId('vote-progress')).toHaveText(`1 of ${voters.length} players have voted.`);
      await expect(reader.page.getByTestId('voter').filter({ hasText: c.name })).toHaveText(`${c.name} — Voted`);
      // Nothing about the choice reaches the reader or the other voters.
      expect(await reader.page.locator('main').innerText()).not.toMatch(/Voted for by|Your vote/);
      await c.page.getByRole('button', { name: 'Change my vote' }).click();
      await vote(c, plan.votes[c.name]);
      await expect(c.page.getByTestId('status')).toHaveText('Vote submitted.');
      await expect(reader.page.getByTestId('vote-progress')).toHaveText(`1 of ${voters.length} players have voted.`);
    }

    const absent = plan.absent ? seat(plan.absent) : null;
    if (absent) await absent.context.setOffline(true);
    const rest = voters.filter((s) => s !== absent && s.name !== plan.changes?.voter);
    // Everyone else votes at the same moment.
    await Promise.all(rest.map((s) => vote(s, plan.votes[s.name])));

    if (absent) {
      await expect(reader.page.getByTestId('vote-progress')).toHaveText(`${voters.length - 1} of ${voters.length} players have voted.`);
      await expect(reader.page.getByTestId('voter').filter({ hasText: absent.name })).toHaveText(`${absent.name} — Waiting`);
      await reader.page.getByRole('button', { name: 'Close Voting' }).click();
      await expect(reader.page.getByRole('dialog')).toContainText('1 player has not voted yet');
      await confirm(reader.page, 'Close Voting');
      await absent.context.setOffline(false);
      // Back online after the close: no ballot to cast any more.
      await expect(absent.page.getByText('Voting is closed.')).toBeVisible({ timeout: 20_000 });
      await expect(absent.page.getByRole('button', { name: 'Cast Vote' })).toHaveCount(0);
    }

    // Voting closes by itself when the last ballot arrives, and nothing is revealed yet.
    await expect(reader.page.getByTestId('status')).toHaveText('Voting is closed.');
    for (const s of voters.filter((v) => v !== absent)) {
      await expect(s.page.getByText('Voting is closed.')).toBeVisible();
      await expect(s.page.getByText('Your vote', { exact: true })).toHaveCount(1);
      const text = await s.page.locator('main').innerText();
      expect(text).not.toMatch(/Voted for by|Written by|Correct definition/);
      expect(await s.page.content()).not.toContain('data-correct="true"');
    }
    if (plan.reloads) {
      const r = seat(plan.reloads);
      await r.page.reload();
      await expect(r.page.getByText('Your vote', { exact: true })).toHaveCount(1);
      await expect(r.page.getByTestId('ballot-option').filter({ hasText: textOf(plan.votes[r.name]) })).toContainText('Your vote');
    }

    const before = { ...totals };
    const gained = score(reader.name, plan);

    if (plan.staged) {
      // One step: who voted for A. Everyone sees it; nothing else is given away.
      await reader.page.getByTestId('reveal-step').first().click();
      const firstVoters = Object.entries(plan.votes)
        .filter(([, t]) => order[0].endsWith(textOf(t)))
        .map(([v]) => v);
      for (const s of table) {
        const a = s.page.getByTestId('revealed').first();
        await expect(a).toHaveAttribute('data-stage', '1');
        if (firstVoters.length === 0) await expect(a.getByTestId('voted-by')).toHaveText('No votes.');
        else for (const v of firstVoters) await expect(a.getByTestId('voted-by')).toContainText(v);
        await expect(s.page.locator('[data-testid="revealed"][data-stage="0"]')).toHaveCount(expectedCount - 1);
        expect(await s.page.locator('main').innerText()).not.toMatch(/Written by|Correct definition/);
      }
      // Scores have not moved while the reveal is under way.
      await players[0].page.getByTestId('scores').click();
      for (const n of names) {
        await expect(
          players[0].page.getByRole('dialog').getByTestId('standing').filter({ hasText: n }).getByTestId('standing-total'),
        ).toHaveText(String(before[n]));
      }
      await players[0].page.getByRole('dialog').getByRole('button', { name: 'Back to the game' }).click();
      // Second step on A: its author, or that it is the genuine one.
      await reader.page.getByTestId('reveal-step').first().click();
      for (const s of table) {
        await expect(s.page.getByTestId('revealed').first()).toHaveAttribute('data-stage', '2');
        await expect(s.page.getByTestId('revealed').first()).toContainText(/Written by|Correct definition/);
      }
    }
    await reader.page.getByRole('button', { name: 'Reveal Answers' }).click();
    await confirm(reader.page, 'Reveal Answers');

    // Results: every screen shows the same list in the same order, the right
    // points for its owner, and the same standings.
    for (const n of names) totals[n] += gained[n] ?? 0;
    for (const s of table) {
      const revealed = s.page.getByTestId('revealed');
      await expect(revealed).toHaveCount(expectedCount);
      const texts = (await revealed.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
      texts.forEach((t, i) => expect(t.startsWith(order[i])).toBe(true));
      await expect(s.page.locator('[data-testid="revealed"][data-correct="true"]')).toHaveCount(1);
      await expect(s.page.locator('[data-correct="true"]')).toContainText(truth);
      const g = gained[s.name] ?? 0;
      await expect(s.page.getByTestId('round-points')).toHaveText(`${g > 0 ? '+' : ''}${g} ${g === 1 ? 'Point' : 'Points'}`);
      await expect(s.page.getByTestId('my-total')).toHaveText(String(totals[s.name]));
      for (const n of names) {
        await expect(
          s.page.locator('main').getByTestId('standing').filter({ hasText: n }).getByTestId('standing-total'),
        ).toHaveText(String(totals[n]));
      }
      await noSidewaysScroll(s.page, 'results');
    }
    // Explanations.
    for (const [voter, target] of Object.entries(plan.votes)) {
      if (target === TRUE) await expect(seat(voter).page.getByText('You identified the genuine definition.')).toBeVisible();
    }
    if (plan.scholar) {
      await expect(seat(plan.scholar).page.getByText('You wrote the correct definition yourself.')).toBeVisible();
      await expect(host.page.getByText(`${plan.scholar} wrote the correct definition and earns three points`)).toBeVisible();
    }
    if (plan.absent) await expect(host.page.getByText(`${plan.absent} did not vote.`)).toBeVisible();
    if (k === 4) {
      await expect(reader.page.getByText('Reader Bonus: +3')).toBeVisible();
      await expect(host.page.getByText(/earns the reader’s bonus of three points/)).toBeVisible();
    } else {
      await expect(reader.page.getByText('Reader Bonus: +3')).toHaveCount(0);
    }
    // The leader, or leaders, wear the crown; equal scores share a rank.
    const top = Math.max(...Object.values(totals));
    const leaders = names.filter((n) => totals[n] === top);
    await expect(host.page.locator('main .standing-lead')).toHaveCount(leaders.length);
    for (const n of leaders) await expect(host.page.locator('main .standing-lead').filter({ hasText: n })).toHaveCount(1);

    // Winning condition: the target is 5; the game still runs to the end of the rotation.
    const reached = top >= 5;
    if (k < plans.length) {
      await expect(reader.page.getByRole('button', { name: 'Next Round' })).toBeVisible();
      await expect(players[1].page.getByRole('button', { name: 'Next Round' })).toHaveCount(players[1] === host ? 1 : 0);
      await reader.page.getByRole('button', { name: 'Next Round' }).click();
      if (reached) {
        await expect(table[k].page.getByText('This is the final rotation')).toBeVisible();
      }
    } else {
      expect(reached).toBe(true);
      await expect(reader.page.getByRole('button', { name: 'Finish the Game' })).toBeVisible();
      await reader.page.getByRole('button', { name: 'Finish the Game' }).click();
    }
  }

  // --- Final results.
  const top = Math.max(...Object.values(totals));
  const winners = names.filter((n) => totals[n] === top);
  for (const s of table) {
    await expect(s.page.getByTestId('winners')).toBeVisible();
    for (const w of winners) await expect(s.page.getByTestId('winners')).toContainText(w);
    for (const n of names) {
      await expect(s.page.getByTestId('standing').filter({ hasText: n }).getByTestId('standing-total')).toHaveText(
        String(totals[n]),
      );
    }
    await expect(s.page.getByText('Final standings · 6 rounds')).toBeVisible();
    await noSidewaysScroll(s.page, 'final');
  }
  // Distinctions worked out from the game itself.
  await expect(host.page.locator('[data-award="scholar"]')).toContainText('Elizabeth');
  await expect(host.page.locator('[data-award="master_reader"]')).toContainText('Elizabeth');
  await expect(host.page.locator('[data-award="great_deceiver"]')).toBeVisible();
  await expect(host.page.locator('[data-award="lexicographer"]')).toBeVisible();
  await expect(host.page.locator('[data-award="convincing_bluff"]')).toContainText("Sarah's invention for round 4");
  await expect(others[0].page.getByRole('button', { name: 'Play Again' })).toHaveCount(0);

  // --- Rematch: same room, same people, nobody rejoins; scores start again.
  await host.page.getByRole('button', { name: 'Play Again' }).click();
  for (const s of table) {
    await expect(s.page.getByRole('heading', { name: 'The company assembles' })).toBeVisible();
    await expect(s.page.getByTestId('player-count')).toHaveText('6 players');
  }
  await expect(host.page.getByTestId('rules')).toContainText('First to 5 points');
  await host.page.getByRole('button', { name: 'Start Game' }).click();
  await expect(host.page.getByTestId('reader-banner')).toBeVisible();
  await expect(host.page.getByTestId('round-number')).toHaveText('Round 1');
  await others[2].page.getByTestId('scores').click();
  await expect(others[2].page.getByRole('dialog')).toContainText('No rounds scored yet');
  for (const total of await others[2].page.getByRole('dialog').getByTestId('standing-total').allInnerTexts()) {
    expect(total.trim()).toBe('0');
  }

  for (const s of table) await s.context.close();
});
