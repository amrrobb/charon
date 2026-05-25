#!/usr/bin/env node
// Smoke test for (c) lesson governance + (b) daily summary.
// Uses ./charon_slim.sqlite (read source) and a temp DB for writes.

import fs from 'fs';
import Database from 'better-sqlite3';

const SRC = './charon_slim.sqlite';
const TMP = './tmp_governance_test.sqlite';
fs.rmSync(TMP, { force: true });
fs.copyFileSync(SRC, TMP);
process.env.DB_PATH = TMP;

const { initDb, db } = await import('../src/db/connection.js');
initDb();

// ───────── Test 1: lesson governance — small window stays 'pending' ─────────
const { storeLearningRun } = await import('../src/learning/lessons.js');
db.prepare("DELETE FROM learning_lessons").run();
db.prepare("DELETE FROM learning_runs").run();

const smallSummary = { positions: { closed: 5 } };
const smallLessons = [{ lesson: 'small-N lesson A', evidence: {} }, { lesson: 'small-N lesson B', evidence: {} }];
storeLearningRun(60000, smallSummary, smallLessons, {});

const pending = db.prepare("SELECT status, COUNT(*) c FROM learning_lessons GROUP BY status").all();
console.log('After small-N run:', pending);
const allPending = pending.every(r => r.status === 'pending');
if (!allPending) { console.error('FAIL: lessons from N=5 should be pending, got', pending); process.exit(1); }
console.log('[ok] small-N lessons stored as pending');

// ───────── Test 2: large window promotes to active + caps at MAX_ACTIVE ─────
const bigSummary = { positions: { closed: 35 } };
const bigLessons = Array.from({ length: 5 }, (_, i) => ({ lesson: `big-N lesson ${i}`, evidence: {} }));
storeLearningRun(60000, bigSummary, bigLessons, {});

const after = db.prepare("SELECT status, COUNT(*) c FROM learning_lessons GROUP BY status").all();
console.log('After big-N run:', after);
const active = (after.find(r => r.status === 'active') || {}).c || 0;
if (active !== 3) { console.error(`FAIL: expected 3 active (MAX_ACTIVE), got ${active}`); process.exit(1); }
console.log('[ok] big-N lessons promote to active, capped at MAX_ACTIVE=3');

// ───────── Test 3: re-running large window archives oldest actives ──────────
const moreLessons = [{ lesson: 'newer big-N lesson 1', evidence: {} }, { lesson: 'newer big-N lesson 2', evidence: {} }];
storeLearningRun(60000, bigSummary, moreLessons, {});
const after2 = db.prepare("SELECT status, COUNT(*) c FROM learning_lessons GROUP BY status").all();
console.log('After 2nd big-N run:', after2);
const active2 = (after2.find(r => r.status === 'active') || {}).c || 0;
if (active2 !== 3) { console.error(`FAIL: still expected 3 active after rotation, got ${active2}`); process.exit(1); }
const archived = (after2.find(r => r.status === 'archived') || {}).c || 0;
if (archived === 0) { console.error('FAIL: rotation did not archive any old actives'); process.exit(1); }
console.log(`[ok] rotation archived ${archived} old actives, still 3 active`);

// ───────── Test 4: daily summary builds without error ──────────────────────
const { buildDailySummary, formatDailySummary } = await import('../src/learning/dailySummary.js');
const sum = buildDailySummary(7 * 24 * 60 * 60 * 1000); // 7-day window so slim DB has data
console.log('\nbuildDailySummary returned strategies:', sum.strategies.length, 'rejection reasons:', Object.keys(sum.rejectionReasons).length);
if (!Array.isArray(sum.strategies)) { console.error('FAIL: strategies not an array'); process.exit(1); }
const text = formatDailySummary(sum);
console.log('\n--- Formatted summary ---');
console.log(text);
console.log('--- end ---');

fs.rmSync(TMP, { force: true });
console.log('\n[ok] all tests passed');
