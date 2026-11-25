# Word repository (seed data)

The `public.words` seed is machine-extracted from one public-domain dictionary. Nothing is reworded, completed, or modernised: definitions are the source text, only trimmed.

## Source and rights

- **Source:** Webster's Revised Unabridged Dictionary (1913), Project Gutenberg ebook #29765. Canonical page: https://www.gutenberg.org/ebooks/29765
- **Rights:** the 1913 text is in the US public domain (published before 1929), so `license = 'Public domain (US)'`. Project Gutenberg's own licence text is not part of the data; only dictionary text is used. This is rights reasoning for US use, not legal advice.
- **Fetch note:** on 2026-11-24 `www.gutenberg.org` served only a maintenance page, and its `cache/epub` copy seen earlier was truncated mid-dictionary. The full text was fetched from the Gutenberg mirror `https://gutenberg.pglaf.org/2/9/7/6/29765/29765-0.txt` (same ebook; 15,335,167 bytes). The SHA-256 is recorded in `tools/words/provenance.json` and in the header of `supabase/seed/words.sql`. If you re-download, the hash may differ if Gutenberg updated the file; the importer and validator use whatever is in `raw/`, and traceability is checked against that file.
- **Frequency list (filter only):** Peter Norvig's `count_1w.txt` (https://norvig.com/ngrams/count_1w.txt, derived from the Google Web Trillion Word Corpus, 333,333 words). It is used only to decide whether a word is common. It is kept in `tools/words/raw/`, is git-ignored, and is not redistributed. No other dictionary or modern definition source is used.
- The raw files are untrusted data and are only ever read as text.

## What goes in a row

`word, definition, part_of_speech, pronunciation, source, source_ref, license, verification, difficulty`

- `source_ref` is `line N`, the 1-based line of the headword (all caps) in the raw file. `validate.mjs` checks the headword sits on that line and that the definition is a leading trim of that entry's `Defn:` paragraph.
- `verification` is `source-traced`: it means traced to the source line by a script, not proofread by a person.
- `pronunciation` is the syllabified form from the entry: `*` becomes `·`, the primary stress mark `"` becomes `′`, secondary `'` becomes `ʹ`, with a `·` inserted after a stress mark that is followed by more letters (`Ab*ac"tor` becomes `ab·ac′·tor`). It is NULL when the form has non-plain characters or does not match the headword.
- `difficulty` is `very obscure` if the word is absent from the frequency list, `obscure` if ranked beyond 150,000.

## Filter rules (in order)

1. Parse headword entries (all-caps line preceded by a blank line).
2. Headword: letters only, single word, 5-16 letters (this drops hyphenated, multi-word, prefix/suffix and abbreviation entries). Proper-noun entries flagged by the entry header (`Prop.`, `n. pr.`, `(Geog.)`, `(Myth.)`, `(Bib.)`) are dropped.
3. Headword occurs once in the file (homographs, including same word with a different part of speech, are dropped).
4. Exactly one `Defn:` and no numbered senses. Part of speech must be `n.`, `a.`, `adv.`, `v. t.`, `v. i.`, `v. t. & i.`, `prep.`, `conj.`, `interj.` or `pron.` (this drops inflection entries such as `p. p.`, `imp.`, `pl.`).
5. Definition = the `Defn:` paragraph, wrapped lines joined with spaces, then trimmed only: cut at `Note:`/`Syn.`, cut an example clause starting `; as,`, strip trailing bracketed labels (`[Obs.]`, `[R.]`), strip trailing author citations (`Chaucer.`, `Sir T. Browne.`). A definition the source leaves unterminated is dropped, never completed.
6. Dropped: length outside 30-220; not a capitalised complete sentence; cross-references and inflection/variant entries (`See`, `Same as`, `Alt.`, `... of X`); definition contains the headword's first 5 letters; "Of or pertaining to", "Pertaining to", "Relating to", "The quality or state of being", "In a ... manner"; taxonomic "A genus/species/family of ..."; chemical formulas; markup or odd characters, quotation marks, unbalanced parentheses; an unpunctuated trailing capitalised name (a citation whose full stop was lost).
7. Frequency: dropped if ranked in the top 150,000, or if it is a simple suffixed form (`-s -ed -ing -ly -ness -er -ment -able ...`) of a word ranked in the top 50,000.
8. Blocklist (word, definition or entry header): slurs, sexual and bodily terms, and era racial/ethnic/religious descriptors (`negro`, `savage`, `squaw`, `heathen`, `indian`, `jew`, `race`, `tribe`, `slave` ...), plus demeaning disability terms. The list is in `import.mjs` (`BLOCK_TERMS`); it is deliberately broad and drops some innocent entries.
9. If more than 4,000 remain, a deterministic 3,000-row subset is kept, preferring definitions of 50-160 characters, words of 7-12 letters and no brackets/parentheses, tie-broken by SHA-1 of the word. Output is sorted alphabetically.

Per-stage counts and per-reason drop counts are in `tools/words/provenance.json`.

## Rerun

```
cd C:\Users\CJWal\dev\balderdash
# put the raw files in tools/words/raw/ (git-ignored):
#   pg29765.txt   <- https://gutenberg.pglaf.org/2/9/7/6/29765/29765-0.txt  (or www.gutenberg.org when it is up; use the full file)
#   count_1w.txt  <- https://norvig.com/ngrams/count_1w.txt
node tools/words/import.mjs     # writes supabase/seed/words.sql, words.sample.sql, tools/words/words.json, provenance.json
node tools/words/validate.mjs   # exits non-zero on any failure
```

If `count_1w.txt` is missing the importer falls back to heuristics only (every word is then `obscure`, and the frequency stage is skipped); the output will then contain many common words, so do not ship that.

Outputs are deterministic: the same raw inputs produce byte-identical files.

`supabase/seed/words.sample.sql` is the first 60 rows (alphabetical, so all early letters) for local tests.

## Honest limits

- **Machine-filtered, not human-proofread.** The `source-traced` label means the text matches the source, not that a person judged it a good game word.
- **1913 definitions can be dated or wrong by modern standards** (science, medicine, and social description especially), and the source contains OCR/typesetting errors that are kept verbatim (for example "goveror", "evacutions"). Spelling is not corrected.
- Some entries are not really obscure words but compounds or technical terms; some are proper-name entries the header did not flag; some definitions are fragments that make sense only with the part of speech.
- Many valid words are lost to the strict rules (single-sense, unique headword, no stem in the definition, no ethnic terms); the seed is a quality-first sample, not the dictionary.
- The blocklist cannot guarantee a general audience; review before shipping. The frequency list is web-derived and its tail contains typos, so "very obscure" is only a rough signal.
- The party game depends on players not knowing the true definition; nothing here checks that a word is absent from modern slang or other games.
