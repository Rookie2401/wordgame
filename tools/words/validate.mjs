#!/usr/bin/env node
// Validates tools/words/words.json + supabase/seed/words.sql against the raw source.
// Usage: node tools/words/validate.mjs   (exit code 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const rows = JSON.parse(fs.readFileSync(path.join(HERE, 'words.json'), 'utf8'));
const prov = JSON.parse(fs.readFileSync(path.join(HERE, 'provenance.json'), 'utf8'));
const rawBuf = fs.readFileSync(path.join(HERE, 'raw', 'pg29765.txt'));
const lines = rawBuf.toString('utf8').split(/\r?\n/);

const errors = [];
const err = (w, m) => { if (errors.length < 200) errors.push(`${w}: ${m}`); else if (errors.length === 200) errors.push('... more'); };

if (crypto.createHash('sha256').update(rawBuf).digest('hex') !== prov.sha256) err('provenance', 'raw file hash differs from provenance.json');
if (rows.length !== prov.final_rows) err('provenance', 'row count differs from provenance.json');

// blocklist is re-declared independently of import.mjs on purpose (a sanity net, not a copy)
const BLOCK = /(?<![a-z])(?:negro|nigger|savage|squaw|heathen|indian|jew|slave|sexual|prostitut|whore|harlot|bastard|rape|rapist|incest|penis|vagina|damn|fuck|shit|cunt|idiot|imbecile|lunatic|cripple|coolie|mulatto|hottentot|mohammedan|gipsy|gypsy)/i;

const REQUIRED = ['word', 'definition', 'part_of_speech', 'source', 'source_ref', 'license', 'verification', 'difficulty'];
const seen = new Set();
const norm = s => s.replace(/\s+/g, ' ').trim();

for (const r of rows) {
  const w = r.word;
  for (const k of REQUIRED) if (r[k] == null || r[k] === '') err(w, `missing ${k}`);
  if (!('pronunciation' in r)) err(w, 'missing pronunciation key');
  if (!/^[a-z]{5,16}$/.test(w || '')) err(w, 'word shape/length');
  if (seen.has((w || '').toLowerCase())) err(w, 'duplicate'); seen.add((w || '').toLowerCase());
  const d = r.definition || '';
  if (d.length < 30 || d.length > 220) err(w, `definition length ${d.length}`);
  if (!/[.!?]$/.test(d)) err(w, 'definition not terminated');
  if (!['obscure', 'very obscure'].includes(r.difficulty)) err(w, 'difficulty');
  if (r.license !== 'Public domain (US)') err(w, 'license');
  if (r.verification !== 'source-traced') err(w, 'verification');
  if (!/^(n\.|a\.|adv\.|v\. t\.|v\. i\.|v\. t\. & i\.|prep\.|conj\.|interj\.|pron\.)$/.test(r.part_of_speech || '')) err(w, 'part_of_speech ' + r.part_of_speech);
  if (BLOCK.test(w) || BLOCK.test(d)) err(w, 'blocklisted term');
  if (d.toLowerCase().includes(w.slice(0, 5))) err(w, 'definition contains headword stem');
  if (/[<>{}\[\]\\|#*=^~_`]/.test(d)) err(w, 'markup chars in definition');
  if (r.pronunciation != null && !/^[a-z·′ʹ]+$/.test(r.pronunciation)) err(w, 'pronunciation chars');

  // traceability
  const m = /^line (\d+)$/.exec(r.source_ref || '');
  if (!m) { err(w, 'source_ref format'); continue; }
  const n = +m[1];
  if (lines[n - 1] !== w.toUpperCase()) { err(w, `headword not at ${r.source_ref} (found "${lines[n - 1]}")`); continue; }
  // the entry body: until the next headword-looking line (caps line after a blank, followed by text)
  let j = n;
  const body = [];
  while (j < lines.length) {
    if (j > n && /^[A-Z][A-Z' -]*$/.test(lines[j]) && lines[j - 1].trim() === '' && lines[j + 1] && lines[j + 1].trim() !== '') break;
    body.push(lines[j]); j++;
  }
  const defnLines = body.map((l, i) => [l, i]).filter(([l]) => /^Defn:/.test(l));
  if (defnLines.length !== 1) { err(w, `entry has ${defnLines.length} Defn: lines`); continue; }
  if (body.some(l => /^\d+\.(\s|$)/.test(l))) err(w, 'entry has numbered senses');
  const para = [];
  for (let i = defnLines[0][1]; i < body.length && body[i].trim() !== ''; i++) para.push(body[i]);
  const text = norm(para.join(' ').replace(/^Defn:\s*/, ''));
  // definition must be the paragraph's leading text, only trimmed (a final ';,:' or period may differ)
  const core = d.replace(/[.]$/, '');
  if (!text.startsWith(core)) err(w, 'definition is not a prefix-trim of the source Defn paragraph');
  // headword occurs once in the whole file
  // (checked in bulk below)
}

// headword uniqueness in the raw file
const occ = new Map();
for (let i = 0; i < lines.length - 1; i++) {
  if (/^[A-Z][A-Z' -]*$/.test(lines[i]) && (i === 0 || lines[i - 1].trim() === '') && lines[i + 1].trim() !== '') occ.set(lines[i], (occ.get(lines[i]) || 0) + 1);
}
for (const r of rows) if (occ.get(r.word.toUpperCase()) !== 1) err(r.word, `headword appears ${occ.get(r.word.toUpperCase())}x in the source`);

// SQL files
for (const f of ['words.sql', 'words.sample.sql']) {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'seed', f), 'utf8');
  const stmts = sql.split(/\n(?=insert into)/).filter(s => s.startsWith('insert into') || /\ninsert into/.test(s));
  const inserts = (sql.match(/^insert into public\.words/gm) || []).length;
  if (!inserts) err(f, 'no insert statements');
  if ((sql.match(/on conflict \(word\) do nothing;/g) || []).length !== inserts) err(f, 'on conflict missing');
  for (const s of sql.split('insert into public.words').slice(1)) {
    const cnt = (s.match(/^  \('/gm) || []).length;
    if (cnt > 500) err(f, `batch of ${cnt} rows > 500`);
  }
  const total = (sql.match(/^  \('/gm) || []).length;
  const expect = f === 'words.sql' ? rows.length : Math.min(60, rows.length);
  if (total !== expect) err(f, `row count ${total} != ${expect}`);
  if (!/^-- Raw file SHA-256: [0-9a-f]{64}/m.test(sql) || !sql.includes(prov.sha256)) err(f, 'header missing hash');
  // every word in the sql is in words.json
  const words = new Set(rows.map(r => r.word));
  for (const m of sql.matchAll(/^  \('([a-z]+)', /gm)) if (!words.has(m[1])) err(f, `unknown word ${m[1]}`);
}

if (errors.length) {
  console.error(`VALIDATION FAILED (${errors.length}):\n` + errors.join('\n'));
  process.exit(1);
}
console.log(`OK: ${rows.length} rows validated (traceability, uniqueness, limits, blocklist, SQL batches).`);
