const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

const LEVELS = ['Intern', 'Executive', 'Intermediate', 'Expert'];
const INTERVIEW_STATUSES = ['Pending', 'Shortlisted', 'Rejected', 'Interviewed', 'Selected'];
const DEFAULT_AREAS = ['Accounts', 'ROC', 'GST', 'Income Tax', 'Tally', 'Company Law', 'Trademark', 'Audit'];

function clean(v) {
  const t = v === undefined || v === null ? '' : String(v).trim();
  return t || null;
}
function genToken() { return crypto.randomBytes(18).toString('hex'); }

// Ensure a config row exists for the current org (lazy create).
async function ensureConfig(createdBy) {
  const r = await db.query(`SELECT * FROM assessment_config WHERE organization_id = current_organization_id()`);
  if (r.rows.length) return r.rows[0];
  const ins = await db.query(
    `INSERT INTO assessment_config (organization_id, public_token, created_by)
     VALUES (current_organization_id(), $1, $2)
     ON CONFLICT (organization_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [genToken(), createdBy || 'Admin']
  );
  return ins.rows[0];
}

// Ensure the org has a starter set of areas (only when it has none at all).
async function ensureAreas() {
  const c = await db.query(`SELECT COUNT(*)::int AS n FROM assessment_areas WHERE organization_id = current_organization_id()`);
  if (c.rows[0].n > 0) return;
  for (let i = 0; i < DEFAULT_AREAS.length; i++) {
    await db.query(
      `INSERT INTO assessment_areas (organization_id, name, sr_no)
       VALUES (current_organization_id(), $1, $2)
       ON CONFLICT DO NOTHING`,
      [DEFAULT_AREAS[i], i + 1]
    );
  }
}

// ═══════════════════════════════════════════════════════════════
//  ADMIN — CONFIG
// ═══════════════════════════════════════════════════════════════
router.get('/config', adminAuth, async (req, res) => {
  try {
    const cfg = await ensureConfig(req.admin.name);
    res.json({ success: true, config: cfg, levels: LEVELS });
  } catch (err) {
    console.error('[assessment config]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/config', adminAuth, async (req, res) => {
  const { total_questions, marks_per_question, duration_minutes, pass_percent, welcome_text, status } = req.body;
  if (status && !['Active', 'Inactive'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status' });
  }
  try {
    await ensureConfig(req.admin.name);
    await db.query(
      `UPDATE assessment_config SET
          total_questions = COALESCE($1, total_questions),
          marks_per_question = COALESCE($2, marks_per_question),
          duration_minutes = COALESCE($3, duration_minutes),
          pass_percent = COALESCE($4, pass_percent),
          welcome_text = $5,
          status = COALESCE($6, status),
          updated_at = NOW()
        WHERE organization_id = current_organization_id()`,
      [
        total_questions !== undefined ? Math.max(1, parseInt(total_questions, 10) || 1) : null,
        marks_per_question !== undefined ? Math.max(0.01, parseFloat(marks_per_question) || 1) : null,
        duration_minutes !== undefined ? Math.max(0, parseInt(duration_minutes, 10) || 0) : null,
        pass_percent !== undefined ? Math.max(0, Math.min(100, parseInt(pass_percent, 10) || 0)) : null,
        clean(welcome_text),
        status || null,
      ]
    );
    res.json({ success: true, message: 'Settings saved' });
  } catch (err) {
    console.error('[assessment update config]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/config/regenerate-link', adminAuth, async (req, res) => {
  try {
    await ensureConfig(req.admin.name);
    const r = await db.query(
      `UPDATE assessment_config SET public_token = $1, updated_at = NOW()
        WHERE organization_id = current_organization_id() RETURNING public_token`,
      [genToken()]
    );
    res.json({ success: true, message: 'Link regenerated', public_token: r.rows[0].public_token });
  } catch (err) {
    console.error('[assessment regen link]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ADMIN — AREAS
// ═══════════════════════════════════════════════════════════════
router.get('/areas', adminAuth, async (req, res) => {
  try {
    await ensureAreas();
    const r = await db.query(
      `SELECT a.id, a.name, a.sr_no, a.active,
              (SELECT COUNT(*) FROM assessment_questions q WHERE q.area_id = a.id)::int AS question_count
         FROM assessment_areas a
        WHERE a.organization_id = current_organization_id()
        ORDER BY a.sr_no, a.name`
    );
    res.json({ success: true, areas: r.rows, levels: LEVELS });
  } catch (err) {
    console.error('[assessment areas]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/areas', adminAuth, async (req, res) => {
  const name = clean(req.body.name);
  if (!name) return res.status(400).json({ success: false, message: 'Area name is required' });
  try {
    const sr = await db.query(`SELECT COALESCE(MAX(sr_no),0)+1 AS n FROM assessment_areas WHERE organization_id = current_organization_id()`);
    await db.query(
      `INSERT INTO assessment_areas (organization_id, name, sr_no)
       VALUES (current_organization_id(), $1, $2)`,
      [name, sr.rows[0].n]
    );
    res.json({ success: true, message: 'Area added' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'This area already exists' });
    console.error('[assessment add area]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/areas/:id', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE assessment_areas SET name = COALESCE($1, name), active = COALESCE($2, active)
        WHERE id = $3 RETURNING id`,
      [clean(req.body.name), req.body.active !== undefined ? !!req.body.active : null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Area not found' });
    res.json({ success: true, message: 'Area updated' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'This area name already exists' });
    console.error('[assessment update area]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/areas/:id', adminAuth, async (req, res) => {
  try {
    await db.query(`DELETE FROM assessment_areas WHERE id = $1`, [req.params.id]);
    res.json({ success: true, message: 'Area deleted (its questions removed too)' });
  } catch (err) {
    console.error('[assessment delete area]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ADMIN — QUESTION BANK
// ═══════════════════════════════════════════════════════════════
// Count matrix: questions per area x level
router.get('/questions/matrix', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT area_id, level, COUNT(*)::int AS n
         FROM assessment_questions WHERE organization_id = current_organization_id()
        GROUP BY area_id, level`
    );
    res.json({ success: true, matrix: r.rows, levels: LEVELS });
  } catch (err) {
    console.error('[assessment matrix]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/questions', adminAuth, async (req, res) => {
  const conds = ['q.organization_id = current_organization_id()'];
  const params = [];
  if (req.query.area_id) { params.push(req.query.area_id); conds.push(`q.area_id = $${params.length}`); }
  if (req.query.level) { params.push(req.query.level); conds.push(`q.level = $${params.length}`); }
  try {
    const r = await db.query(
      `SELECT q.id, q.area_id, a.name AS area_name, q.level, q.question_text,
              q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.marks, q.active
         FROM assessment_questions q
         JOIN assessment_areas a ON a.id = q.area_id
        WHERE ${conds.join(' AND ')}
        ORDER BY a.name, q.level, q.id`,
      params
    );
    res.json({ success: true, questions: r.rows });
  } catch (err) {
    console.error('[assessment questions]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/questions', adminAuth, async (req, res) => {
  const areaId = parseInt(req.body.area_id, 10);
  const level = String(req.body.level || '');
  const text = clean(req.body.question_text);
  const correct = String(req.body.correct_option || '').toUpperCase();
  if (!areaId) return res.status(400).json({ success: false, message: 'Select an area' });
  if (!LEVELS.includes(level)) return res.status(400).json({ success: false, message: 'Select a valid level' });
  if (!text) return res.status(400).json({ success: false, message: 'Question text is required' });
  if (!['A', 'B', 'C', 'D'].includes(correct)) return res.status(400).json({ success: false, message: 'Select the correct option' });
  try {
    const area = await db.query(`SELECT id FROM assessment_areas WHERE id = $1`, [areaId]);
    if (!area.rows.length) return res.status(404).json({ success: false, message: 'Area not found' });
    await db.query(
      `INSERT INTO assessment_questions
         (organization_id, area_id, level, question_text, option_a, option_b, option_c, option_d, correct_option, marks)
       VALUES (current_organization_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        areaId, level, text,
        clean(req.body.option_a) || '', clean(req.body.option_b) || '',
        clean(req.body.option_c) || '', clean(req.body.option_d) || '',
        correct, parseInt(req.body.marks, 10) || 1,
      ]
    );
    res.json({ success: true, message: 'Question added' });
  } catch (err) {
    console.error('[assessment add question]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/questions/:id', adminAuth, async (req, res) => {
  const correct = req.body.correct_option ? String(req.body.correct_option).toUpperCase() : null;
  if (correct && !['A', 'B', 'C', 'D'].includes(correct)) {
    return res.status(400).json({ success: false, message: 'Invalid correct option' });
  }
  if (req.body.level && !LEVELS.includes(req.body.level)) {
    return res.status(400).json({ success: false, message: 'Invalid level' });
  }
  try {
    const r = await db.query(
      `UPDATE assessment_questions SET
          area_id = COALESCE($1, area_id),
          level = COALESCE($2, level),
          question_text = COALESCE($3, question_text),
          option_a = COALESCE($4, option_a),
          option_b = COALESCE($5, option_b),
          option_c = COALESCE($6, option_c),
          option_d = COALESCE($7, option_d),
          correct_option = COALESCE($8, correct_option),
          marks = COALESCE($9, marks),
          active = COALESCE($10, active)
        WHERE id = $11 RETURNING id`,
      [
        req.body.area_id ? parseInt(req.body.area_id, 10) : null,
        req.body.level || null,
        clean(req.body.question_text),
        req.body.option_a !== undefined ? (clean(req.body.option_a) || '') : null,
        req.body.option_b !== undefined ? (clean(req.body.option_b) || '') : null,
        req.body.option_c !== undefined ? (clean(req.body.option_c) || '') : null,
        req.body.option_d !== undefined ? (clean(req.body.option_d) || '') : null,
        correct,
        req.body.marks !== undefined ? (parseInt(req.body.marks, 10) || 1) : null,
        req.body.active !== undefined ? !!req.body.active : null,
        req.params.id,
      ]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Question not found' });
    res.json({ success: true, message: 'Question updated' });
  } catch (err) {
    console.error('[assessment update question]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/questions/:id', adminAuth, async (req, res) => {
  try {
    await db.query(`DELETE FROM assessment_questions WHERE id = $1`, [req.params.id]);
    res.json({ success: true, message: 'Question deleted' });
  } catch (err) {
    console.error('[assessment delete question]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ADMIN — CANDIDATES / RESULTS
// ═══════════════════════════════════════════════════════════════
router.get('/candidates', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, name, mobile, email, position, level, areas, status,
              total_questions, correct_count, total_marks, scored_marks, score_percent, passed,
              area_breakdown, interview_status, remarks, submitted_at, started_at
         FROM assessment_candidates
        WHERE organization_id = current_organization_id()
        ORDER BY submitted_at DESC NULLS LAST, started_at DESC`
    );
    res.json({ success: true, candidates: r.rows });
  } catch (err) {
    console.error('[assessment candidates]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/candidates/:id', adminAuth, async (req, res) => {
  try {
    const s = await db.query(`SELECT * FROM assessment_candidates WHERE id = $1`, [req.params.id]);
    if (!s.rows.length) return res.status(404).json({ success: false, message: 'Candidate not found' });
    const cand = s.rows[0];
    const ids = (cand.served_question_ids || []).map(Number).filter(Boolean);
    let questions = [];
    if (ids.length) {
      const q = await db.query(
        `SELECT q.id, a.name AS area_name, q.level, q.question_text,
                q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.marks
           FROM assessment_questions q JOIN assessment_areas a ON a.id = q.area_id
          WHERE q.id = ANY($1::int[])`,
        [ids]
      );
      questions = q.rows;
    }
    res.json({ success: true, candidate: cand, questions });
  } catch (err) {
    console.error('[assessment candidate detail]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/candidates/:id', adminAuth, async (req, res) => {
  const { interview_status, remarks } = req.body;
  if (interview_status && !INTERVIEW_STATUSES.includes(interview_status)) {
    return res.status(400).json({ success: false, message: 'Invalid interview status' });
  }
  try {
    const r = await db.query(
      `UPDATE assessment_candidates SET interview_status = COALESCE($1, interview_status), remarks = $2
        WHERE id = $3 RETURNING id`,
      [interview_status || null, clean(remarks), req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Candidate not found' });
    res.json({ success: true, message: 'Updated' });
  } catch (err) {
    console.error('[assessment update candidate]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/candidates/:id', adminAuth, async (req, res) => {
  try {
    await db.query(`DELETE FROM assessment_candidates WHERE id = $1`, [req.params.id]);
    res.json({ success: true, message: 'Candidate removed' });
  } catch (err) {
    console.error('[assessment delete candidate]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
//  PUBLIC — candidate link (no auth). Token is the access boundary.
// ═══════════════════════════════════════════════════════════════
async function findConfigByToken(token) {
  const r = await db.runWithTenant({ bypassTenant: true }, () => db.query(
    `SELECT * FROM assessment_config WHERE public_token = $1`, [token]
  ));
  return r.rows[0] || null;
}

// Picks up to `limit` random active questions from an area (excluding ids
// already picked). Pass `level` to restrict to that level, or omit/null to
// pull from any level — used as the fallback when a specific area+level pool
// runs short, so the overall test total never falls short.
async function pickQuestions(orgId, areaId, limit, excludeIds, level) {
  if (limit <= 0) return [];
  const excludeArr = [...excludeIds];
  const params = level
    ? [orgId, areaId, level, excludeArr, limit]
    : [orgId, areaId, excludeArr, limit];
  const levelClause = level ? 'AND level = $3' : '';
  const excludeIdx = level ? 4 : 3;
  const limitIdx = level ? 5 : 4;
  const r = await db.runWithTenant({ bypassTenant: true }, () => db.query(
    `SELECT id, area_id, question_text, option_a, option_b, option_c, option_d, marks
       FROM assessment_questions
      WHERE organization_id = $1 AND area_id = $2 ${levelClause}
        AND active = true AND NOT (id = ANY($${excludeIdx}::int[]))
      ORDER BY random() LIMIT $${limitIdx}`,
    params
  ));
  return r.rows;
}

// Landing: welcome + levels + active areas
router.get('/public/:token', async (req, res) => {
  try {
    const cfg = await findConfigByToken(req.params.token);
    if (!cfg || cfg.status !== 'Active') {
      return res.status(404).json({ success: false, message: 'This assessment link is not available.' });
    }
    const areas = await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `SELECT id, name FROM assessment_areas WHERE organization_id = $1 AND active = true ORDER BY sr_no, name`,
      [cfg.organization_id]
    ));
    res.json({
      success: true,
      welcome_text: cfg.welcome_text || '',
      duration_minutes: cfg.duration_minutes,
      total_questions: cfg.total_questions,
      marks_per_question: Number(cfg.marks_per_question),
      levels: LEVELS,
      areas: areas.rows,
    });
  } catch (err) {
    console.error('[assessment public get]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Start: register candidate, pick questions for chosen level + areas
router.post('/public/:token/start', async (req, res) => {
  const name = clean(req.body.name);
  const mobile = clean(req.body.mobile);
  const level = String(req.body.level || '');
  const areaIds = Array.isArray(req.body.area_ids) ? req.body.area_ids.map(Number).filter(Boolean) : [];
  if (!name) return res.status(400).json({ success: false, message: 'Please enter your name.' });
  if (!mobile) return res.status(400).json({ success: false, message: 'Please enter your mobile number.' });
  if (!LEVELS.includes(level)) return res.status(400).json({ success: false, message: 'Please select your level.' });
  if (!areaIds.length) return res.status(400).json({ success: false, message: 'Please select at least one area.' });
  try {
    const cfg = await findConfigByToken(req.params.token);
    if (!cfg || cfg.status !== 'Active') {
      return res.status(404).json({ success: false, message: 'This assessment link is not available.' });
    }
    const orgId = cfg.organization_id;

    // one attempt per mobile
    const done = await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `SELECT id FROM assessment_candidates WHERE organization_id = $1 AND mobile = $2 AND status = 'Completed' LIMIT 1`,
      [orgId, mobile]
    ));
    if (done.rows.length) {
      return res.status(409).json({ success: false, already: true, message: 'You have already taken this assessment. Please use "Check My Status" with your mobile number.' });
    }

    // validate areas belong to org + active
    const validAreas = await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `SELECT id, name FROM assessment_areas WHERE organization_id = $1 AND active = true AND id = ANY($2::int[])`,
      [orgId, areaIds]
    ));
    if (!validAreas.rows.length) {
      return res.status(400).json({ success: false, message: 'Selected areas are not valid.' });
    }

    // Split the fixed total EXACTLY (never more, never less) across the
    // areas selected: floor-divide, then hand the remainder to a randomly
    // shuffled subset of areas so the sum of per-area targets == totalTarget.
    const totalTarget = cfg.total_questions || 40;
    const areasShuffled = [...validAreas.rows].sort(() => Math.random() - 0.5);
    const areaCount = areasShuffled.length;
    const base = Math.floor(totalTarget / areaCount);
    const remainder = totalTarget % areaCount;
    const areaTargets = areasShuffled.map((area, i) => ({ area, target: base + (i < remainder ? 1 : 0) }));

    let picked = [];
    const usedIds = new Set();
    let shortfall = 0;

    for (const { area, target } of areaTargets) {
      // 1) fill from this area at the candidate's chosen level first
      const atLevel = await pickQuestions(orgId, area.id, target, usedIds, level);
      atLevel.forEach(q => usedIds.add(q.id));
      picked.push(...atLevel.map(q => ({ ...q, area_name: area.name })));

      // 2) that area+level ran short — top up from OTHER levels in the same area
      let remaining = target - atLevel.length;
      if (remaining > 0) {
        const otherLevel = await pickQuestions(orgId, area.id, remaining, usedIds, null);
        otherLevel.forEach(q => usedIds.add(q.id));
        picked.push(...otherLevel.map(q => ({ ...q, area_name: area.name })));
        remaining -= otherLevel.length;
      }
      if (remaining > 0) shortfall += remaining;
    }

    // 3) some area(s) couldn't fill their share even across all levels —
    // move that shortfall onto other selected areas so the grand total still
    // lands on exactly totalTarget.
    if (shortfall > 0) {
      for (const { area } of areaTargets) {
        if (shortfall <= 0) break;
        const extra = await pickQuestions(orgId, area.id, shortfall, usedIds, null);
        extra.forEach(q => usedIds.add(q.id));
        picked.push(...extra.map(q => ({ ...q, area_name: area.name })));
        shortfall -= extra.length;
      }
    }

    if (picked.length < totalTarget) {
      return res.status(400).json({
        success: false,
        message: `Not enough questions are available yet for the selected level/areas to build a full ${totalTarget}-question test. Please contact the office.`,
      });
    }
    // Safety net: never send more than the configured total either.
    if (picked.length > totalTarget) picked = picked.slice(0, totalTarget);

    const submitToken = genToken();
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
    const areasJson = validAreas.rows.map(a => ({ id: a.id, name: a.name }));
    const servedIds = picked.map(q => q.id);

    const ins = await db.runWithTenant({ organizationId: orgId }, () => db.query(
      `INSERT INTO assessment_candidates
         (organization_id, name, mobile, email, position, level, areas, served_question_ids, submit_token, status, ip_address, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Registered',$10,NOW())
       RETURNING id`,
      [orgId, name, mobile, clean(req.body.email), clean(req.body.position), level,
       JSON.stringify(areasJson), JSON.stringify(servedIds), submitToken, ip || null]
    ));

    // questions to candidate — WITHOUT correct answers
    const clientQs = picked.map(q => ({
      id: q.id, area_name: q.area_name, question_text: q.question_text,
      option_a: q.option_a, option_b: q.option_b, option_c: q.option_c, option_d: q.option_d,
    }));
    res.json({
      success: true,
      candidate_id: ins.rows[0].id,
      submit_token: submitToken,
      duration_minutes: cfg.duration_minutes,
      questions: clientQs,
    });
  } catch (err) {
    console.error('[assessment public start]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Submit answers → auto-score (overall + area breakdown)
router.post('/public/:token/submit', async (req, res) => {
  const candidateId = parseInt(req.body.candidate_id, 10);
  const submitToken = clean(req.body.submit_token);
  const answers = req.body.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
  if (!candidateId || !submitToken) return res.status(400).json({ success: false, message: 'Invalid submission.' });
  try {
    const cfg = await findConfigByToken(req.params.token);
    if (!cfg) return res.status(404).json({ success: false, message: 'This assessment link is not available.' });
    const orgId = cfg.organization_id;

    const cres = await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `SELECT * FROM assessment_candidates WHERE id = $1 AND organization_id = $2`,
      [candidateId, orgId]
    ));
    const cand = cres.rows[0];
    if (!cand || cand.submit_token !== submitToken) {
      return res.status(403).json({ success: false, message: 'This assessment session is not valid.' });
    }
    if (cand.status === 'Completed') {
      return res.json({ success: true, message: 'Your assessment is already submitted.' });
    }

    const ids = (cand.served_question_ids || []).map(Number).filter(Boolean);
    const qres = await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `SELECT q.id, a.name AS area_name, q.correct_option, q.marks
         FROM assessment_questions q JOIN assessment_areas a ON a.id = q.area_id
        WHERE q.id = ANY($1::int[])`,
      [ids]
    ));
    const questions = qres.rows;

    // uniform marks per question from config (e.g. 2.5)
    const mpq = Number(cfg.marks_per_question) || 1;
    let correctCount = 0, scoredMarks = 0, totalMarks = 0;
    const areaAgg = {};
    const breakdown = questions.map(q => {
      totalMarks += mpq;
      const sel = String(answers[q.id] || answers[String(q.id)] || '').toUpperCase();
      const ok = sel && sel === q.correct_option;
      if (ok) { correctCount += 1; scoredMarks += mpq; }
      const a = areaAgg[q.area_name] || { area: q.area_name, total: 0, correct: 0, total_marks: 0, scored_marks: 0 };
      a.total += 1; a.total_marks += mpq;
      if (ok) { a.correct += 1; a.scored_marks += mpq; }
      areaAgg[q.area_name] = a;
      return { question_id: q.id, area: q.area_name, selected: sel || null, correct: q.correct_option, is_correct: !!ok, marks: mpq };
    });
    const scorePercent = totalMarks > 0 ? Math.round((scoredMarks / totalMarks) * 10000) / 100 : 0;
    const passed = cfg.pass_percent > 0 ? scorePercent >= cfg.pass_percent : false;

    await db.runWithTenant({ organizationId: orgId }, () => db.query(
      `UPDATE assessment_candidates SET
          status = 'Completed', total_questions = $1, correct_count = $2, total_marks = $3,
          scored_marks = $4, score_percent = $5, passed = $6, answers = $7, area_breakdown = $8,
          submitted_at = NOW()
        WHERE id = $9`,
      [
        questions.length, correctCount, totalMarks, scoredMarks, scorePercent, passed,
        JSON.stringify(breakdown), JSON.stringify(Object.values(areaAgg)), candidateId,
      ]
    ));
    res.json({ success: true, message: 'Your assessment has been submitted successfully. You can check your result and status anytime using your mobile number on this link.' });
  } catch (err) {
    console.error('[assessment public submit]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Candidate status lookup by mobile
router.post('/public/:token/status', async (req, res) => {
  const mobile = clean(req.body.mobile);
  if (!mobile) return res.status(400).json({ success: false, message: 'Please enter your mobile number.' });
  try {
    const cfg = await findConfigByToken(req.params.token);
    if (!cfg) return res.status(404).json({ success: false, message: 'This assessment link is not available.' });
    const r = await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `SELECT name, level, areas, status, total_questions, correct_count, total_marks, scored_marks,
              score_percent, passed, area_breakdown, interview_status, submitted_at
         FROM assessment_candidates
        WHERE organization_id = $1 AND mobile = $2 AND status = 'Completed'
        ORDER BY submitted_at DESC LIMIT 1`,
      [cfg.organization_id, mobile]
    ));
    if (!r.rows.length) {
      return res.json({ success: false, message: 'No completed assessment found for this mobile number.' });
    }
    const c = r.rows[0];
    // Map internal 'Pending' to a friendlier label for the candidate
    const label = c.interview_status === 'Pending' ? 'Under Review' : c.interview_status;
    res.json({
      success: true,
      result: {
        name: c.name, level: c.level, areas: c.areas,
        score_percent: c.score_percent, scored_marks: c.scored_marks, total_marks: c.total_marks,
        correct_count: c.correct_count, total_questions: c.total_questions,
        passed: c.passed, area_breakdown: c.area_breakdown,
        interview_status: label, submitted_at: c.submitted_at,
      },
    });
  } catch (err) {
    console.error('[assessment public status]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
