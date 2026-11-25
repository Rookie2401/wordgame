# Voting and scoring

Rooms choose one of two ways to play when they are created (the host can change it in the lobby):

- **Vote and score in the app** (default for new rooms): private ballots, automatic points, standings, a winner.
- **Traditional**: the original companion. Vote aloud, score on paper. Nothing below applies.

Rooms that existed before this feature, and rooms made by a not-yet-updated copy of the app, are traditional.

Everything here extends the existing engine: same tables, same anonymous sessions, same room lock, same
`get_state` snapshot, same realtime nudge. The additions are in
`supabase/migrations/20261125000001_voting_scoring.sql`.

## Round lifecycle

```
card_selection → collecting → adjudicating → reading → voting → voting_closed → reveal → results → done
```

| Step | Who | Function | Notes |
| --- | --- | --- | --- |
| collecting → adjudicating | automatic / reader | `submit_definition`, `reader_skip`, `close_submissions` | skipped when no other player wrote anything |
| mark a definition correct | reader | `adjudicate` | list has no names; not the reader's own; private until results |
| adjudicating → reading | reader | `finish_adjudication` | the one shuffle happens here; accepted definitions are left out |
| reading → voting | reader | `open_voting` | never automatic: the reader reads aloud first. Fixes who may vote |
| vote / change vote | voter | `cast_vote` | one row per voter per round |
| voting → voting_closed | automatic / reader | `cast_vote`, `close_voting` | automatic when every eligible voter has voted. Never reveals by itself |
| reveal one step | reader | `reveal_step` | per definition: who voted for it, then who wrote it and whether it is genuine |
| reveal the rest, settle | reader | `reveal_answers` | also happens when the last step is taken |
| results → next round or end | reader or host | `next_round` | ends the game at a rotation boundary if the winning condition is met |

The brief's three reveal steps (voters, author, correctness) are two here. Naming an author already says the
definition is false, and "no author" already says it is genuine, so author and correctness cannot be shown apart.

## Who votes

Fixed when voting opens (`round_voters`): everyone playing the round, except the reader, anyone who has been the
reader during this round (they have seen the answer), and anyone whose written definition was accepted as correct.
A player who joined mid-round is not playing it. If the reader is replaced during voting, the new reader's ballot
is discarded and they stop being a voter.

Enforced in `cast_vote`, not just in the interface: wrong state, not a voter, a definition from another round, or
your own definition are each refused.

## Points

| For | Points |
| --- | ---: |
| Voting for the genuine definition | 2 |
| Each vote your false definition receives | 1 |
| A written definition the reader accepts as correct | 3 |
| Reader bonus | 3 |

The reader bonus needs all of: at least one vote cast; no vote for the genuine definition; no eligible voter
abstaining; nobody's written definition accepted. Identical false definitions stay separate entries and score
separately. The values are stored on the room when the game starts (`rooms.ruleset`), so a later change to the
defaults cannot alter a game in progress.

## The reader's wording

The reader does not write a false definition. While the others write, the reader may put the real definition in
their own words (to hide the dictionary's style) or keep the card's wording. If they reword it, their text takes
the card definition's place: it is the entry that is read out, voted on and revealed as correct, and there is
still exactly one correct entry on the ballot. The reader earns nothing from votes for it; the reader's only
points are the bonus for fooling the whole table. At the reveal everyone is also shown the card's own wording.
This applies to traditional rooms too.

The brief's example B, where the reader earns points from a false definition of their own, no longer applies
under this rule.

If the reader changes before the definitions are shuffled, anything the outgoing reader wrote (a rewording of the
answer) and anything the incoming reader wrote (a guess made before they knew the answer) is discarded, so a
guess can never be read out as the correct definition. The new reader chooses a wording afresh.

## Settlement

`private.settle_round` runs inside the same transaction and room lock as the reveal that completes the round. It
writes one `score_events` row per award and marks the round settled.

- **Exactly once:** it returns at once if `rounds.settled_at` is set.
- **Safe to retry:** every award has a deterministic key (`<round>:CG:<voter>`, `<round>:SD:<voter>`,
  `<round>:CW:<player>`, `<round>:RB`) under a unique constraint, so a repeated or resumed run cannot add a point
  twice.
- **All or nothing:** it is one transaction; a failure leaves the round unsettled and unscored.

Standings are never stored. They are summed from the ledger each time, so they cannot drift from it. Because the
ledger has no rows for a round until it is settled, standings cannot leak a result during the reveal.

## What each person can see

| Stage | Reader | Voter | Anyone else |
| --- | --- | --- | --- |
| adjudicating | correct definition; others' texts without names | "the reader is looking over the definitions" | same |
| reading | shuffled list | nothing | nothing |
| voting | shuffled list; who has voted (not what) | the same list in the same order; own definition marked; own vote; a count of ballots cast | the count only |
| voting closed | as above | as above, locked | the count only |
| reveal | per definition, only what its stage allows | same | same |
| results | everything; own point breakdown; standings | same | same |

The host gets nothing the other players do not, unless the host is also the reader. Nobody can read or write
another player's ballot: no function accepts a voter id, and the tables grant nothing to clients.

## How the game ends

Chosen at creation, changeable in the lobby:

- **Target score** (default 25; 15/25/50/100 or custom): once anyone reaches it, a notice says the final rotation
  is under way, and the game ends when that rotation finishes.
- **Rotations** (1/2/3/5 or custom): ends after that many complete passes round the table.
- **Unlimited**: until the host ends it.

A rotation is one pass through the readers. Its members are the players in the game when it begins
(`rotation_members`). Someone who joins part-way plays and scores at once but first reads in the next rotation, so
a rotation cannot grow while it is being played. Members who leave or are removed are skipped; members who are
merely disconnected keep their turn (the host can skip or replace them).

The ending is checked when the reader moves on from a settled round, never mid-round. The host can still end the
game by hand at any moment; an unsettled round is then simply not scored.

The highest total wins. Equal highest totals share the win, and equal totals share a rank (1, 1, 3). There are no
tie-breakers.

## Score corrections

Host menu → tap a player → Correct score. Points (−100 to 100, not zero) and a reason are required. The correction
is its own ledger row (`MANUAL_ADJUSTMENT`, with who made it), is listed for everyone in the Scores dialog, and
counts toward totals and therefore toward the target. It never edits a vote or an earlier award and does not
affect the distinctions.

## Distinctions and rematch

At the end: Great Deceiver (most votes drawn), Lexicographer (most genuine definitions found), Master Reader (most
reader bonuses), Scholar (most correct written definitions), Most Convincing Bluff (single definition with most
votes), and the winner as Master of Deception. Each is left out if nobody earned it; ties are listed together.

**Play Again** (host) returns the same room to the lobby under a new game number: same players, same sessions, no
rescan. Scores, round numbers and rotations start again; the old game's rows stay under the old number and cannot
be counted. Words already played in the room are not dealt again.

## Limits to know about

- Voting in a room with only the reader and people excluded from voting closes at once; the round is still
  revealed and settled, with no points from votes.
- A finished room is deleted 30 minutes after its last activity, so Play Again must be pressed within that time.
- The distinctions count awards, not manual corrections.
