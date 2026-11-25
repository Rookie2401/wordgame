# Architecture

Guiding rule: digitise the paperwork, not the party game.

## Shape

```
phone browser ──rpc──▶ Postgres functions (SECURITY DEFINER) ──▶ tables (RLS on, no client access)
      ▲                         │
      └── "room changed" ◀── Realtime on public.rooms (version counter only)
```

- The client never reads or writes a game table. It calls about twenty database functions
  (`supabase/migrations/20261124000002_functions.sql`). Each one identifies the caller from the anonymous sign-in
  (`auth.uid()`), locks the room row, checks role and state, makes the change, and returns that caller's view.
- `get_state(room)` is the only way game data reaches a device. It builds a different answer per caller: the
  correct definition for the reader only, the shuffled list for the reader only while reading, authors for
  everyone only after the reveal. Nothing is sent and then hidden.
- Realtime carries only updates to the `rooms` row (code, status, a version number). On any nudge the client calls
  `get_state` again. A 4-second poll and a refetch on foreground/online cover missed nudges. Snapshots carry the
  room version; an older one never replaces a newer one, so late, repeated or out-of-order messages are harmless.
- Every mutation is one transaction holding the room's row lock, so two requests for the same room run one after
  the other. A step that has already happened is a no-op (second tap on Start, Reveal, Next Round, Close).

This is simpler than the usual per-table RLS policies plus per-table realtime subscriptions, and there is no
policy whose mistake could leak a definition: the tables grant nothing to clients at all. RLS is still enabled on
every table as a second barrier (tested by granting SELECT and confirming zero rows come back).

Voting, scoring, winning conditions and rematches are described in [SCORING.md](SCORING.md). They use the
same mechanisms as everything below.

## State machine

Room: `lobby → playing → ended` (and back to `lobby` for a rematch). Traditional round:
`card_selection → collecting → reading → reveal → done`. Scored round: see SCORING.md.
The brief's NEXT_ROUND is the `reveal → done` transition, which creates the next round in the same transaction.

| Transition | Who | Function |
| --- | --- | --- |
| lobby → playing (round 1) | host, ≥ 3 players | `start_game` |
| card_selection → collecting | reader | `confirm_card` |
| collecting → reading | automatic when all expected have submitted and the reader has submitted or skipped; or reader | `submit_definition` / `reader_skip` / `close_submissions` |
| reading → reveal | reader | `reveal_answers` |
| reveal → done + next round | reader (or host) | `next_round` |
| any → ended | host | `end_game` |

The shuffle (`private.close_round`) is Fisher–Yates over the submissions plus the correct definition, with random
integers taken from Postgres's cryptographic generator by rejection sampling. It runs once, inside the lock, and
writes the order to `shuffled_definitions`; the texts are copied, with new opaque ids. Correctness and authorship
go to `shuffled_private`.

## Data

`rooms`, `players`, `rounds`, `round_secrets` (correct definition), `round_eligible` (who is expected this round,
fixed at round start), `submissions` (unique per round and player), `shuffled_definitions` + `shuffled_private`,
`words`, `used_cards`, `rate_limits`, `app_config`. All cascade from `rooms`, so deleting a room deletes
everything.

## Identity and recovery

- Supabase anonymous sign-in; the session is kept in the browser's local storage and survives refresh, closing
  the browser, locking the phone and network changes. The app also remembers which room this device is in.
- A player's seat is bound to that anonymous user id. Entering someone's name only creates "Name (2)".
- If the session is lost entirely (storage cleared, new phone), the host opens the menu, taps the player, and
  reads out a six-character rejoin code, valid ten minutes, single use, stored hashed. Guesses are rate-limited.
- Presence is "seen in the last 15 seconds" from the poll. Away players keep their seat, role and submission.
- Host gone: the host can hand over; if the host has been silent a minute, any player can take over; a host who
  leaves passes hosting on automatically.

## Reader rotation

Circular by lobby order (host may reorder before starting). The host can skip a reader before the card is
confirmed (rotation continues from whoever takes the turn) or give the round to another player at any point
(word and submissions kept; the outgoing reader can no longer submit; next round continues from the originally
scheduled seat). In digital mode a reader change before confirmation draws a fresh card, since the old reader saw
the first one. The host is warned that the new reader will see the correct definition, and the new reader is told
on their own screen.

## Edge cases

| Case | Behaviour |
| --- | --- |
| Same display name twice | Second becomes "Name (2)" |
| QR scanned twice | Same seat; no duplicate |
| Refresh after submitting | "Definition submitted" with the text, from the server |
| Edit | Replaces the row (unique round + player) |
| Disconnect before submitting | Round waits; reader can close submissions by hand |
| Reconnect after close | Sees the current stage; late submission refused |
| Reader disconnects | Host reassigns the round, or the reader's leaving passes it on |
| Host disconnects | Any player may take over after a minute |
| Simultaneous submissions / submit during close | Serialised by the room lock; the late one gets "submissions closed" |
| Reader rewords the definition, or not | Their wording replaces the card's as the one correct entry; otherwise the card's wording is used |
| Player submits the true definition | Kept as their own entry, credited to them |
| Identical definitions | Kept as separate entries, each credited |
| Accidental Reveal | Confirmation dialog first |
| Join mid-round | Sits out until the next round; never blocks the current one |
| Next reader unavailable | Host skips or replaces |
| Words exhausted | Reader is asked to type a card by hand |
| Inactive room | Deleted after 6 hours; devices are told the game has expired |
| Expired invitation | "This invitation has expired" before any name is asked |
| Malicious client | No table access; functions check membership, role and state; see `tests/db/security.test.ts` |

## What is stored on the device

The anonymous session, the room this device is in, the player's own name, their own unsent draft, and a layout
preference. The service worker precaches interface files only and has no runtime caching, so no card or
definition is ever written to a cache. Multiplayer does not work offline and the app does not pretend to.

## Known limits

- The word list ships in this repository (`supabase/seed/words.sql`) so the database can be seeded. It is not in
  the web bundle and cannot be fetched through the app, but anyone can look a word up in the repo, exactly as they
  could in any dictionary.
- Local tests use one database connection, so true parallel requests are only proven by the lock design, not by
  a race test. The production check exercises real concurrency lightly.
- Supabase's own sign-in, PostgREST and Realtime are not exercised until the app is deployed.
