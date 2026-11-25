#!/usr/bin/env node
// Webster's 1913 -> words table import. Deterministic: parse -> filter -> emit.
// Usage: node tools/words/import.mjs
// Raw inputs (not committed): tools/words/raw/pg29765.txt, tools/words/raw/count_1w.txt
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const RAW = path.join(HERE, 'raw', 'pg29765.txt');
const FREQ = path.join(HERE, 'raw', 'count_1w.txt');
const OUT_SQL = path.join(ROOT, 'supabase', 'seed', 'words.sql');
const OUT_SAMPLE = path.join(ROOT, 'supabase', 'seed', 'words.sample.sql');
const OUT_JSON = path.join(HERE, 'words.json');
const OUT_PROV = path.join(HERE, 'provenance.json');

export const PARAMS = {
  minLen: 5, maxLen: 16,
  defMin: 30, defMax: 220,
  freqTopN: 150000,        // words ranked inside this are "common" and dropped
  veryObscureIfAbsent: true,
  targetMax: 4000, subsetSize: 3000,
  prefDef: [50, 160], prefWord: [7, 12],
  sampleRows: 60, batchSize: 500,
};

export const SOURCE = "Webster's Revised Unabridged Dictionary (1913), Project Gutenberg #29765";
export const LICENSE = 'Public domain (US)';
export const VERIFICATION = 'source-traced';

// Raw text was fetched from this URL (the www.gutenberg.org host was returning a
// maintenance page; the pglaf.org mirror serves the same ebook, and the full text).
export const SOURCE_URL = 'https://gutenberg.pglaf.org/2/9/7/6/29765/29765-0.txt';
export const FREQ_URL = 'https://norvig.com/ngrams/count_1w.txt';

// ---- blocklists (word-boundary prefix match, case-insensitive) ----
const BLOCK_TERMS = [
  // era racial / ethnic / religious descriptors
  'negro', 'nigger', 'african', 'ethiopian', 'hottentot', 'caffre', 'kaffir', 'kafir', 'bushman', 'bushmen',
  'savage', 'barbarian', 'barbarous', 'heathen', 'pagan', 'infidel', 'squaw', 'papoose', 'redskin', 'indian',
  'eskimo', 'mongol', 'tartar', 'chinaman', 'chinese', 'hindoo', 'hindu', 'gipsy', 'gypsy', 'gypsies',
  'jew', 'jewish', 'saracen', 'moorish', 'moors', 'mohammedan', 'mahometan', 'mahomedan', 'moslem', 'coolie',
  'mulatto', 'quadroon', 'octoroon', 'sambo', 'mestizo', 'creole', 'half-breed', 'halfbreed', 'aborigin',
  'natives', 'native of', 'malay', 'arab', 'turk', 'hun', 'huns', 'papist', 'popish', 'idolat', 'pickaninn',
  'race', 'races', 'racial', 'slave', 'slavery', 'tribe', 'tribes', 'cannibal', 'oriental',
  // sexual / bodily / profane
  'sex', 'sexual', 'prostitut', 'whore', 'harlot', 'strumpet', 'bastard', 'bawd', 'concubin', 'adulter',
  'fornicat', 'lewd', 'lust', 'lecher', 'penis', 'vagina', 'genital', 'testicle', 'scrotum', 'vulva',
  'uterus', 'womb', 'copulat', 'coition', 'coitus', 'pudend', 'semen', 'seminal', 'rape', 'rapist', 'incest',
  'pederast', 'sodom', 'catamite', 'slut', 'bitch', 'damn', 'fuck', 'shit', 'piss', 'cunt', 'cock', 'erotic',
  'orgasm', 'masturbat', 'menstru', 'pregnan', 'nude', 'naked', 'obscen', 'seduc', 'ravish', 'cuckold',
  'paramour', 'mistress', 'eunuch', 'castrat', 'groin', 'buttock', 'anus', 'rectum', 'breast', 'nipple',
  'dugs', 'venereal', 'syphilis', 'gonorrh', 'bawdy', 'virgin', 'harem', 'courtesan', 'wench', 'trull',
  'defecat', 'excrement', 'dung', 'urine', 'urinat', 'fart', 'flatulen', 'privy', 'spittle',
  // demeaning disability terms
  'idiot', 'imbecile', 'lunatic', 'cripple', 'madman', 'moron', 'retard', 'dwarf',
];
const BLOCK_RE = new RegExp('(?<![a-z])(?:' + BLOCK_TERMS.map(t => t.replace(/[-]/g, '[- ]?')).join('|') + ')', 'i');

const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

function sha256(file) {
  const buf = fs.readFileSync(file);
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

// ---- parsing ----
const HEAD_RE = /^[A-Z][A-Z' -]*$/;

export function parseEntries(lines) {
  const entries = [];
  const isHead = i =>
    i + 1 < lines.length && HEAD_RE.test(lines[i]) && lines[i].trim() !== '' &&
    lines[i + 1].trim() !== '' && (i === 0 || lines[i - 1].trim() === '');
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (isHead(i)) {
      if (cur) entries.push(cur);
      cur = { head: lines[i], line: i + 1, body: [] };
    } else if (cur) cur.body.push(lines[i]);
  }
  if (cur) entries.push(cur);
  return entries;
}

// returns {pos, pron, labels, defn} or {drop: reason}
function analyse(e) {
  const body = e.body;
  // header block = lines up to first blank line
  let h = 0;
  const hdr = [];
  while (h < body.length && body[h].trim() !== '') hdr.push(body[h++]);
  const header = hdr.join(' ').replace(/\s+/g, ' ').trim();

  const defnIdx = [];
  body.forEach((l, i) => { if (/^Defn:/.test(l)) defnIdx.push(i); });
  const numbered = body.some(l => /^\d+\.(\s|$)/.test(l));
  if (defnIdx.length !== 1 || numbered) return { drop: 'sense' };
  if (/\bEtym:\s/.test(body.slice(defnIdx[0]).join(' ')) && false) return { drop: 'sense' };
  // header must be the lines directly before Defn (no stray Defn inside header)
  if (hdr.some(l => /^Defn:/.test(l))) return { drop: 'sense' };

  // POS + pronunciation from the header
  const m = header.match(/^([^,]+),\s*(.*)$/);
  if (!m) return { drop: 'pos' };
  const formRaw = m[1];
  const rest = m[2];
  if (/\b(?:Prop|pr)\.\s*n\.|^n\.\s*pr\.|^Prop\./.test(rest) || /\((?:Geog|Anc\. ?Geog|Myth|Bib)\./.test(header)) return { drop: 'proper' };
  const pm = rest.match(/^(n\.|a\.|adv\.|v\. t\. (?:&|and) i\.|v\. t\.|v\. i\.|prep\.|conj\.|interj\.|pron\.)(?=$|[\s;,(])/);
  if (!pm) return { drop: 'pos' };
  const pos = pm[1];
  // pronunciation
  let pron = null;
  if (/^[A-Za-z*"'`]+$/.test(formRaw) && norm(formRaw) === norm(e.head)) {
    pron = formRaw.toLowerCase()
      .replace(/\*/g, '·')
      .replace(/["]/g, '′')
      .replace(/['`]/g, 'ʹ')
      .replace(/([′ʹ])(?=[a-z])/g, '$1·');
  }
  // definition paragraph: from the Defn line to next blank line
  const para = [];
  for (let i = defnIdx[0]; i < body.length && body[i].trim() !== ''; i++) para.push(body[i]);
  const text = para.join(' ').replace(/^Defn:\s*/, '').replace(/\s+/g, ' ').trim();
  return { pos, pron, header, text };
}

const BRACKET_TAIL = /\s*\[[^\[\]]*\]\.?\s*$/;
const CITE_TAIL = /(?<=[.!?;)])\s+(?:(?:Sir|Mrs?|Dr|Bp|Abp|Ld|Lord|Prof|St|Mr)\.?\s+)?(?:(?:[A-Z]\.|[A-Z][a-z]+\.?|&|and)\s*){1,5}\.?$/;

export function cleanDefinition(raw) {
  let t = raw;
  // cut at Note: / Syn.
  t = t.replace(/\s*\b(?:Note|Syn)[.:].*$/, '');
  // cut quoted/usage examples
  t = t.replace(/[;,.]?\s+as,\s.*$/, '.');
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(BRACKET_TAIL, '').trim();
    // trailing author citations: "... pavements. Fairholt."
    const c = t.match(CITE_TAIL);
    if (c && c.index >= 8) t = t.slice(0, c.index).trim();
    if (t === before) break;
  }
  // A trailing ; , : (left by cutting an example clause) becomes a period. A definition
  // that the source leaves unterminated is NOT completed; it fails the sentence rule later.
  if (/[;,:]$/.test(t)) t = t.slice(0, -1).trim() + '.';
  return t;
}

const TOO_DERIVABLE = /^(?:Of or pertaining to|Pertaining to|Relating to|Of or relating to|The quality or state of being|The state or quality of being|The quality of being|The state of being|In an? [^.]*manner|In the manner)\b/i;
const XREF = /(?:^|\s)(?:See|Same as|Alt\.|Cf\.|Syn\.)\b|^(?:Same|Alt|Altern|Obs|Variant|Written|Spelled|An? (?:old|obsolete|variant|erroneous|incorrect|common|corrupt|vulgar|dialectal|contracted)\b[^.]*\b(?:form|spelling|orthography)|Corrupted|Contracted|Imp\.|p\. ?p\.|Pl\.|Plural|Of\b|Third person)/i;
const INFL = /\b(?:(?:imperfect|preterit|preterite|participle|plural|past tense|third person|singular|comparative|superlative|variant|spelling|form|abbreviation|contraction|corruption)\s+(?:and\s+\w+\s+)?of\b)/i;
const TAXON = /^(?:An?|The)\s+(?:[\w-]+\s+){0,4}?(?:genus|genera|species|family|order|tribe|group|suborder|subfamily|class|division|section)\b|\b[A-Z][a-z]+ [a-z]{4,}(?:,| and| or)\s/;
const FORMULA = /[A-Z][a-z]?\d|\b[A-Z][a-z]?[A-Z][a-z]?\d?\b(?=[ ,.)])|\(CH|\bC\d|H\d|_/;
const MARKUP = /[<>{}\[\]\\|#*=^~_`@$%]|\s--\s|—|\.\.|\?\?/;
const ALLOWED = /^[A-Za-z0-9À-ɏ\s.,;:'()\-?!&/"]+$/;

function stemCommon(word, freq) {
  const sfx = ['s', 'es', 'ed', 'ing', 'ly', 'ness', 'er', 'ers', 'ment', 'ments', 'able', 'ity', 'ism', 'ist', 'less', 'ful', 'est', 'ish'];
  for (const s of sfx) {
    if (word.length - s.length < 4 || !word.endsWith(s)) continue;
    const stem = word.slice(0, -s.length);
    for (const c of [stem, stem + 'e', stem.slice(0, -1) /*doubled cons.*/]) {
      const r = freq.get(c);
      if (r !== undefined && r <= 50000) return true;
    }
  }
  return false;
}

function loadFreq() {
  const m = new Map();
  if (!fs.existsSync(FREQ)) return null;
  const rows = fs.readFileSync(FREQ, 'utf8').split(/\r?\n/);
  let rank = 0;
  for (const r of rows) {
    const w = r.split('\t')[0];
    if (!w) continue;
    rank++;
    if (!m.has(w)) m.set(w, rank);
  }
  return m;
}

const sq = s => "'" + s.replace(/'/g, "''") + "'";
function sqlFile(rows, header, params) {
  const cols = 'word, definition, part_of_speech, pronunciation, source, source_ref, license, verification, difficulty';
  let out = header;
  for (let i = 0; i < rows.length; i += params.batchSize) {
    const chunk = rows.slice(i, i + params.batchSize);
    out += `insert into public.words (${cols}) values\n` +
      chunk.map(r => '  (' + [r.word, r.definition, r.part_of_speech, r.pronunciation, r.source, r.source_ref, r.license, r.verification, r.difficulty]
        .map(v => (v == null ? 'null' : sq(v))).join(', ') + ')').join(',\n') +
      '\non conflict (word) do nothing;\n\n';
  }
  return out;
}

function main() {
  if (!fs.existsSync(RAW)) { console.error('Missing ' + RAW); process.exit(1); }
  const src = sha256(RAW);
  const lines = fs.readFileSync(RAW, 'utf8').split(/\r?\n/);
  const counts = {};
  const dropped = {};
  const stage = (k, n) => { counts[k] = n; };
  const drop = (r) => { dropped[r] = (dropped[r] || 0) + 1; };

  const entries = parseEntries(lines);
  stage('1_entries_parsed', entries.length);

  // headword occurrence counts (all headword lines, case-insensitive)
  const occ = new Map();
  for (const e of entries) { const k = e.head.toLowerCase(); occ.set(k, (occ.get(k) || 0) + 1); }

  let cand = [];
  for (const e of entries) {
    if (!/^[A-Z]+$/.test(e.head)) { drop('headword_not_single_letters_word'); continue; }
    if (e.head.length < PARAMS.minLen || e.head.length > PARAMS.maxLen) { drop('headword_length'); continue; }
    cand.push(e);
  }
  stage('2_headword_shape_and_length', cand.length);

  cand = cand.filter(e => occ.get(e.head.toLowerCase()) === 1 || (drop('homograph_or_repeated_headword'), false));
  stage('3_unique_headword', cand.length);

  let an = [];
  for (const e of cand) {
    const a = analyse(e);
    if (a.drop) { drop(a.drop); continue; }
    an.push({ e, a });
  }
  stage('4_single_sense_pos_ok_not_proper', an.length);

  let defs = [];
  for (const x of an) {
    const def = cleanDefinition(x.a.text);
    defs.push({ ...x, def });
  }
  const keep = [];
  for (const x of defs) {
    const { def, e } = x;
    const w = e.head.toLowerCase();
    if (def.length < PARAMS.defMin || def.length > PARAMS.defMax) { drop('def_length'); continue; }
    if (!/^[A-Z]/.test(def) || !/[.!?]$/.test(def)) { drop('def_not_sentence'); continue; }
    // an uncomma'd trailing author name, e.g. "... on the arc of the instrument Whewell."
    if (/[a-z] (?:[A-Z]. ?)*[A-Z][a-z]+.$/.test(def) && !/(?:of|in|to|from|by|the|a|an|and|or|with|at|on|for|as|into|near|than|called|named|is|are|esp.|chiefly|also|its|their|his|her|that|which) (?:[A-Z]. ?)*[A-Z][a-z]+.$/.test(def)) { drop('trailing_unpunctuated_name'); continue; }
    if (XREF.test(def) || INFL.test(def)) { drop('cross_reference_or_inflection'); continue; }
    if (def.toLowerCase().includes(w.slice(0, 5))) { drop('def_contains_headword_stem'); continue; }
    if (TOO_DERIVABLE.test(def)) { drop('derivable_from_morphology'); continue; }
    if (TAXON.test(def) || /\((?:Zoöl|Bot|Paleon|Min)\.\)/.test(x.a.header) && /\b(?:genus|species|family|order)\b/i.test(def)) { drop('taxonomic'); continue; }
    if (/\(Chem\.\)/.test(x.a.header) && FORMULA.test(def) || FORMULA.test(def)) { drop('formula'); continue; }
    if (MARKUP.test(def) || !ALLOWED.test(def) || /"/.test(def)) { drop('markup_or_odd_chars'); continue; }
    if ((def.match(/\(/g) || []).length !== (def.match(/\)/g) || []).length) { drop('markup_or_odd_chars'); continue; }
    keep.push(x);
  }
  stage('5_definition_rules', keep.length);

  const freq = loadFreq();
  const freqUsed = !!freq;
  const afterFreq = [];
  for (const x of keep) {
    const w = x.e.head.toLowerCase();
    let difficulty = 'very obscure';
    if (freq) {
      const r = freq.get(w);
      if (r !== undefined) {
        if (r <= PARAMS.freqTopN) { drop('common_word_in_top_150k'); continue; }
        difficulty = 'obscure';
      }
      if (stemCommon(w, freq)) { drop('inflection_of_common_word'); continue; }
    } else {
      difficulty = 'obscure';
    }
    afterFreq.push({ ...x, difficulty });
  }
  stage('6_frequency_filter', afterFreq.length);

  const afterBlock = afterFreq.filter(x => {
    if (BLOCK_RE.test(x.e.head) || BLOCK_RE.test(x.def) || BLOCK_RE.test(x.a.header)) { drop('blocklist'); return false; }
    return true;
  });
  stage('7_blocklist', afterBlock.length);

  let final = afterBlock;
  let subset = false;
  if (final.length > PARAMS.targetMax) {
    subset = true;
    const score = x => {
      const w = x.e.head.length, d = x.def.length;
      return (d >= PARAMS.prefDef[0] && d <= PARAMS.prefDef[1] ? 1 : 0) +
        (w >= PARAMS.prefWord[0] && w <= PARAMS.prefWord[1] ? 1 : 0) +
        (/[()\[\]]/.test(x.def) ? 0 : 1);
    };
    const h = x => crypto.createHash('sha1').update(x.e.head).digest('hex');
    final = [...final].sort((a, b) => score(b) - score(a) || (h(a) < h(b) ? -1 : 1)).slice(0, PARAMS.subsetSize);
  }
  stage('8_deterministic_subset', final.length);

  final.sort((a, b) => (a.e.head < b.e.head ? -1 : 1));
  const rows = final.map(x => ({
    word: x.e.head.toLowerCase(),
    definition: x.def,
    part_of_speech: x.a.pos,
    pronunciation: x.a.pron,
    source: SOURCE,
    source_ref: 'line ' + x.e.line,
    license: LICENSE,
    verification: VERIFICATION,
    difficulty: x.difficulty,
  }));

  const cmd = 'node tools/words/import.mjs';
  const header = `-- Seed data for public.words\n-- Source: ${SOURCE}\n--   ${SOURCE_URL}\n-- Raw file SHA-256: ${src.sha256} (${src.bytes} bytes)\n-- Rows: %ROWS%\n-- Generated by: ${cmd}  (do not edit by hand; see docs/WORDS.md)\n\n`;
  fs.mkdirSync(path.dirname(OUT_SQL), { recursive: true });
  fs.writeFileSync(OUT_SQL, sqlFile(rows, header.replace('%ROWS%', String(rows.length)), PARAMS));
  const sample = rows.slice(0, PARAMS.sampleRows);
  fs.writeFileSync(OUT_SAMPLE, sqlFile(sample, header.replace('%ROWS%', sample.length + ' (first rows of words.sql, for local tests)'), PARAMS));
  fs.writeFileSync(OUT_JSON, JSON.stringify(rows, null, 2) + '\n');
  const freqInfo = freq ? { used: true, url: FREQ_URL, ...sha256(FREQ), entries: freq.size, note: 'filter only; not redistributed' } : { used: false, note: 'frequency list unavailable; heuristics only' };
  fs.writeFileSync(OUT_PROV, JSON.stringify({
    source: SOURCE, source_url: SOURCE_URL, canonical_url: 'https://www.gutenberg.org/ebooks/29765',
    sha256: src.sha256, bytes: src.bytes, raw_file: 'tools/words/raw/pg29765.txt',
    frequency_list: freqInfo, filter_parameters: PARAMS, subset_applied: subset,
    blocklist_terms: BLOCK_TERMS.length, counts, dropped_by_reason: dropped, final_rows: rows.length,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ counts, dropped, freqUsed, subset }, null, 2));
}

main();
