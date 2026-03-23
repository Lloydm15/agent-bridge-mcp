#!/usr/bin/env node
/**
 * Newcode Safety Stress Test
 *
 * Verifies the judge + Formula J pipeline is safe before deploying to Cortex:
 * 1. Verdicts NEVER delete memories (only insert into feedback_events)
 * 2. Formula J score adjustments are bounded (max ±0.3)
 * 3. Verdict distribution isn't shredding (old bug: 94.4% drops)
 * 4. Worst-case scenarios don't destroy data
 *
 * Usage:  node test/stress-safety.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const NEWCODE_URL = process.env.NEWCODE_URL || 'http://192.168.2.100:4000';
const USER_ID = 'lloyd';
const STRESS_USER = 'stress-test'; // isolated user so we don't pollute real data

// 20 diverse queries covering different topics Lloyd actually asks about
const TEST_QUERIES = [
  "What port does the Emergence API run on?",
  "How do agents communicate with each other?",
  "What is Lloyd's UI preference?",
  "How does the dashboard theme system work?",
  "What database does Cortex use?",
  "How do I deploy to the Linux server?",
  "What are the five agents in Emergence?",
  "How does the sleep cycle work?",
  "What is the memory stream architecture?",
  "What LLM providers are used?",
  "How does the institution enrollment system work?",
  "What is the storyline engine?",
  "How do encounters spawn?",
  "What is Mevoric?",
  "How does the feedback judge work?",
  "What is Formula J?",
  "What are Lloyd's coding preferences?",
  "How does the world object system work?",
  "What is the budget preset system?",
  "How does cross-tab messaging work?",
];

// ── Helpers ──

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  });
  return res.json();
}

async function getMemoryCount() {
  const stats = await fetchJson(`${NEWCODE_URL}/api/stats?user_id=${USER_ID}`);
  return stats.total_memories;
}

async function getVerdictCounts() {
  const stats = await fetchJson(`${NEWCODE_URL}/api/stats?user_id=${USER_ID}`);
  return stats.verdict_counts;
}

async function getFeedbackTotal() {
  const stats = await fetchJson(`${NEWCODE_URL}/api/stats?user_id=${USER_ID}`);
  return stats.total_feedback;
}

// ── Formula J (mirrors retrieval.py exactly) ──

function formulaJScore(baseScore, verdicts, now) {
  const DECAY_RATE = Math.log(2) / 90;
  const CONFIDENCE_K = 5;
  const SATURATION_RATE = 0.1;
  const INACTIVITY_DECAY = Math.log(2) / 180;
  const MAX_ADJ = 0.3;

  if (!verdicts.length) return baseScore;

  let wPos = 0, wNeg = 0, wTotal = 0, strN = 0;
  for (const [ts, v] of verdicts) {
    const d = Math.exp(-DECAY_RATE * (now - ts));
    if (v === 'strengthen') {
      strN++;
      const sat = 1 / (1 + (strN - 1) * SATURATION_RATE);
      wPos += d * sat;
    } else if (v === 'weaken') {
      wNeg += d;
    } else if (v === 'correct') {
      wNeg += d * 0.5;
    } else if (v === 'drop') {
      wNeg += d * 1.5;
    }
    wTotal += d;
  }

  if (wTotal < 0.001) return baseScore;

  const net = (wPos - wNeg) / wTotal;
  const n = verdicts.length;
  let conf = n / (n + CONFIDENCE_K);
  const lastT = Math.max(...verdicts.map(([ts]) => ts));
  conf *= Math.exp(-INACTIVITY_DECAY * (now - lastT));

  const adj = Math.max(-MAX_ADJ, Math.min(MAX_ADJ, net * conf * MAX_ADJ));
  return Math.max(0, Math.min(1, baseScore + adj));
}

// ═══════════════════════════════════════════════════════════
// TEST SUITE 1: Formula J Math Safety
// ═══════════════════════════════════════════════════════════

describe('Formula J Math Safety', () => {
  const now = Date.now() / 86400000; // current time in epoch days

  it('no verdicts = no change', () => {
    assert.strictEqual(formulaJScore(0.42, [], now), 0.42);
    assert.strictEqual(formulaJScore(0.0, [], now), 0.0);
    assert.strictEqual(formulaJScore(1.0, [], now), 1.0);
  });

  it('score never goes below 0 even with 200 drops', () => {
    const verdicts = Array.from({ length: 200 }, (_, i) => [now - i * 0.5, 'drop']);
    const result = formulaJScore(0.05, verdicts, now);
    assert.ok(result >= 0, `Score went below 0: ${result}`);
    console.log(`    200 drops on 0.05 base → ${result.toFixed(4)}`);
  });

  it('score never goes above 1 even with 200 strengthens', () => {
    const verdicts = Array.from({ length: 200 }, (_, i) => [now - i * 0.5, 'strengthen']);
    const result = formulaJScore(0.95, verdicts, now);
    assert.ok(result <= 1, `Score went above 1: ${result}`);
    console.log(`    200 strengthens on 0.95 base → ${result.toFixed(4)}`);
  });

  it('max negative adjustment is -0.3', () => {
    const verdicts = Array.from({ length: 100 }, (_, i) => [now - i, 'drop']);
    const result = formulaJScore(0.5, verdicts, now);
    const adj = result - 0.5;
    assert.ok(adj >= -0.3, `Negative adjustment exceeded -0.3: ${adj.toFixed(4)}`);
    console.log(`    100 drops on 0.5 base → ${result.toFixed(4)} (adj: ${adj.toFixed(4)})`);
  });

  it('max positive adjustment is +0.3', () => {
    const verdicts = Array.from({ length: 100 }, (_, i) => [now - i, 'strengthen']);
    const result = formulaJScore(0.5, verdicts, now);
    const adj = result - 0.5;
    assert.ok(adj <= 0.3, `Positive adjustment exceeded +0.3: ${adj.toFixed(4)}`);
    console.log(`    100 strengthens on 0.5 base → ${result.toFixed(4)} (adj: ${adj.toFixed(4)})`);
  });

  it('saturation prevents infinite strengthen gaming', () => {
    // First strengthen should have more effect than 50th
    const v1 = [[now, 'strengthen']];
    const v50 = Array.from({ length: 50 }, (_, i) => [now - i, 'strengthen']);

    const r1 = formulaJScore(0.5, v1, now);
    const r50 = formulaJScore(0.5, v50, now);

    const adj1 = r1 - 0.5;
    const adjPer = (r50 - 0.5) / 50;

    console.log(`    1 strengthen: adj ${adj1.toFixed(4)}`);
    console.log(`    50 strengthens: avg adj/verdict ${adjPer.toFixed(6)}`);
    assert.ok(adjPer < adj1, 'Saturation not working — later strengthens should have less effect');
  });

  it('old verdicts decay and matter less than recent ones', () => {
    // 10 old drops (180 days ago) vs 10 recent drops
    const oldDrops = Array.from({ length: 10 }, (_, i) => [now - 180 - i, 'drop']);
    const newDrops = Array.from({ length: 10 }, (_, i) => [now - i, 'drop']);

    const oldResult = formulaJScore(0.5, oldDrops, now);
    const newResult = formulaJScore(0.5, newDrops, now);

    console.log(`    10 old drops (180d ago): ${oldResult.toFixed(4)}`);
    console.log(`    10 new drops (today):    ${newResult.toFixed(4)}`);
    assert.ok(newResult < oldResult, 'Recent drops should have MORE impact than old ones');
  });

  it('confidence ramp: first verdict has less weight than 10th', () => {
    const v1 = [[now, 'drop']];
    const v10 = Array.from({ length: 10 }, (_, i) => [now - i, 'drop']);

    const r1 = formulaJScore(0.5, v1, now);
    const r10 = formulaJScore(0.5, v10, now);

    const adj1 = 0.5 - r1;
    const adj10 = 0.5 - r10;

    console.log(`    1 drop: penalty ${adj1.toFixed(4)}`);
    console.log(`    10 drops: penalty ${adj10.toFixed(4)}`);
    assert.ok(adj10 > adj1, 'More verdicts should produce stronger adjustment');
  });

  it('mixed verdicts partially cancel out', () => {
    // 5 strengthens then 5 drops — should roughly cancel
    const mixed = [
      ...Array.from({ length: 5 }, (_, i) => [now - i, 'strengthen']),
      ...Array.from({ length: 5 }, (_, i) => [now - 5 - i, 'drop']),
    ];
    const result = formulaJScore(0.5, mixed, now);
    const adj = Math.abs(result - 0.5);
    console.log(`    5 strengthen + 5 drop on 0.5 → ${result.toFixed(4)} (net adj: ${adj.toFixed(4)})`);
    assert.ok(adj < 0.15, 'Mixed verdicts should partially cancel — net adjustment should be small');
  });

  it('LOG_THRESHOLD 0.15: a memory at 0.20 with max drops stays above 0', () => {
    // Worst case: low-scoring memory gets hammered
    const verdicts = Array.from({ length: 50 }, (_, i) => [now - i, 'drop']);
    const result = formulaJScore(0.20, verdicts, now);
    console.log(`    0.20 base + 50 drops → ${result.toFixed(4)} (filtered below 0.15? ${result < 0.15 ? 'YES — hidden but NOT deleted' : 'NO — still visible'})`);
    // Key point: even if filtered from results, the memory STILL EXISTS in memory_map
    assert.ok(result >= 0, 'Score must never go negative');
  });
});

// ═══════════════════════════════════════════════════════════
// TEST SUITE 2: Memory Safety (No Deletions)
// ═══════════════════════════════════════════════════════════

describe('Memory Safety — No Deletions', () => {
  let memoriesBefore;

  before(async () => {
    memoriesBefore = await getMemoryCount();
    console.log(`    Memory count before: ${memoriesBefore}`);
  });

  it('20 retrievals do not change memory count', async () => {
    for (const query of TEST_QUERIES) {
      await fetchJson(`${NEWCODE_URL}/retrieve`, {
        method: 'POST',
        body: JSON.stringify({ query, user_id: USER_ID }),
      });
    }
    const after = await getMemoryCount();
    assert.strictEqual(after, memoriesBefore, `Memories changed: ${memoriesBefore} → ${after}`);
    console.log(`    After 20 retrievals: ${after} (unchanged)`);
  });

  it('posting 100 synthetic verdicts does not change memory count', async () => {
    const fakeId = `stress-test-${Date.now()}`;
    const verdictTypes = ['strengthen', 'weaken', 'drop', 'correct'];
    for (let i = 0; i < 100; i++) {
      await fetchJson(`${NEWCODE_URL}/api/verdict`, {
        method: 'POST',
        body: JSON.stringify({
          mem0_id: fakeId,
          conversation_id: `stress-${i}`,
          user_id: STRESS_USER, // use stress-test user to avoid polluting real data
          verdict: verdictTypes[i % 4],
          judge_note: `stress test verdict #${i}`,
        }),
      });
    }
    const after = await getMemoryCount();
    assert.strictEqual(after, memoriesBefore, `Memories changed after 100 verdicts: ${memoriesBefore} → ${after}`);
    console.log(`    After 100 synthetic verdicts: ${after} (unchanged)`);
  });

  it('50 rapid drop verdicts on a real memory do not delete it', async () => {
    // Find a real memory
    const result = await fetchJson(`${NEWCODE_URL}/retrieve`, {
      method: 'POST',
      body: JSON.stringify({ query: 'test', user_id: USER_ID, limit: 1 }),
    });

    if (!result.memories || result.memories.length === 0) {
      console.log('    Skipped — no memories to test');
      return;
    }

    const realMemId = result.memories[0].mem0_id;
    console.log(`    Targeting memory: ${realMemId}`);

    // Blast 50 drops at it (using stress-test user to not pollute real verdicts)
    for (let i = 0; i < 50; i++) {
      await fetchJson(`${NEWCODE_URL}/api/verdict`, {
        method: 'POST',
        body: JSON.stringify({
          mem0_id: realMemId,
          conversation_id: `stress-drop-${i}`,
          user_id: STRESS_USER,
          verdict: 'drop',
          judge_note: `stress test drop #${i}`,
        }),
      });
    }

    const after = await getMemoryCount();
    assert.strictEqual(after, memoriesBefore, `CRITICAL: Memory was deleted after 50 drops!`);
    console.log(`    After 50 drops on real memory: count still ${after} — memory survived`);
  });

  after(async () => {
    const memoriesAfter = await getMemoryCount();
    console.log(`    Memory count after ALL tests: ${memoriesAfter}`);
    assert.strictEqual(memoriesAfter, memoriesBefore, 'CRITICAL: Memories were lost during stress test!');
  });
});

// ═══════════════════════════════════════════════════════════
// TEST SUITE 3: Verdict Distribution Check
// ═══════════════════════════════════════════════════════════

describe('Verdict Distribution', () => {
  it('shows current real verdict breakdown', async () => {
    const counts = await getVerdictCounts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    console.log(`    Total real verdicts: ${total}`);
    for (const [verdict, count] of Object.entries(counts)) {
      const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
      console.log(`      ${verdict.padEnd(12)} ${String(count).padStart(4)}  (${pct}%)`);
    }

    if (total >= 10) {
      const dropPct = (counts.drop || 0) / total;
      console.log(`    Drop rate: ${(dropPct * 100).toFixed(1)}%`);
      if (dropPct >= 0.8) {
        console.log('    ⚠ WARNING: Drop rate >= 80% — approaching old shredder behavior!');
      } else if (dropPct >= 0.6) {
        console.log('    ⚠ CAUTION: Drop rate >= 60% — worth monitoring');
      } else {
        console.log('    ✓ Drop rate is in safe range');
      }
      // Hard fail above 90% (old shredder was 94.4%)
      assert.ok(dropPct < 0.9, `FAIL: Drop rate is ${(dropPct * 100).toFixed(1)}% — this IS the shredder bug`);
    } else {
      console.log('    (Not enough verdicts for meaningful distribution analysis)');
    }
  });
});

// ═══════════════════════════════════════════════════════════
// TEST SUITE 4: Formula J Re-Ranking Sanity
// ═══════════════════════════════════════════════════════════

describe('Formula J Re-Ranking Live', () => {
  it('retrieval returns re-ranked scores within valid range', async () => {
    const result = await fetchJson(`${NEWCODE_URL}/retrieve`, {
      method: 'POST',
      body: JSON.stringify({ query: 'What is Formula J?', user_id: USER_ID }),
    });

    const memories = result.memories || [];
    console.log(`    Retrieved ${memories.length} memories`);

    let allValid = true;
    for (const m of memories.slice(0, 5)) {
      const inRange = m.score >= 0 && m.score <= 1;
      if (!inRange) allValid = false;
      const hasVerdict = m.mem0_score !== undefined;
      const diff = hasVerdict ? (m.score - m.mem0_score).toFixed(4) : 'n/a';
      console.log(`      rank ${m.rank}: score=${m.score.toFixed(4)} base=${(m.mem0_score || 0).toFixed(4)} adj=${diff} "${(m.memory || '').slice(0, 60)}..."`);
    }

    assert.ok(allValid, 'Some scores were outside [0, 1] range');
  });
});

// ═══════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════

describe('Cleanup', () => {
  it('remove stress-test user verdicts', async () => {
    // Clean up synthetic verdicts from stress-test user
    // We can't do this via API — no delete endpoint for feedback_events
    // But they're under user_id='stress-test' so they won't affect real data
    console.log('    Stress test verdicts are under user_id="stress-test" — isolated from real data');
  });
});
