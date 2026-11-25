# Name and legal notes

"Balderdash" is used here as a working title. It is a registered trademark for the commercial board game (owned
by Mattel at the time of writing — confirm before relying on this). This note is not legal advice.

Before sharing the app beyond friends:

1. Decide on the name. The safest course is an original one. The name appears in one constant
   (`APP_NAME` in `src/game/logic.ts`), the web manifest in `vite.config.ts`, `index.html`, and the docs.
2. Keep the home-screen line saying the app is unofficial and unaffiliated.
3. Do not add card content, artwork, logos or rule text from the commercial game. None is included: Digital Card
   mode uses only entries from the public-domain 1913 Webster (see `docs/WORDS.md`), and Physical Card mode stores
   whatever the reader types for the length of the game and then deletes it.

Assets: the icon and ornaments are original SVG. The typeface is EB Garamond (SIL Open Font License), bundled
with the app rather than loaded from a third party.
