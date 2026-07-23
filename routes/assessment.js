const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

const INTERVIEW_STATUSES = ['Pending', 'Shortlisted', 'Rejected', 'Interviewed', 'Selected'];

function clean(v) {
  const t = v === undefined || v === null ? '' : String(v).trim();
  return t || null;
}
function genToken() {
  return crypto.randomBytes(18).toString('hex'); // 36 chars
}

// ═══════════════════════════════════════════════════════════════
//  ADMIN ENDPOINTS (authenticated)
// ═══════════════════════════════════════════════════════════════

// List all tests with question + submission counts
router.get('/tests', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT t.id, t.title, t.description, t.duration_minutes, t.pass_percent,
              t.public_token, t.status, t.created_by, t.created_at,
              (SELECT COUNT(*) FROM assessment_questions q WHERE q.test_id = t.id)::int AS question_count,
              (SELECT COUNT(*) FROM assessment_submissions s WHERE s.test_id = t.id)::int AS submission_count
         FROM assessment_tests t
        ORDER BY t.created_at DESC`
    );
    res.json({ success: true, tests: r.rows });
  } catch (err) {
    console.error('[assessment tests]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Create a test
router.post('/tests', adminAuth, async (req, res) => {
  const title = clean(req.body.title);
  if (!title) return res.status(400).json({ success: false, message: 'Test title is required' });
  const duration = parseInt(req.body.duration_minutes, 10) || 0;
  const passPercent = Math.max(0, Math.min(100, parseInt(req.body.pass_percent, 10) || 0));
  try {
    const r = await db.query(
      `INSERT INTO assessment_tests (organization_id, title, description, duration_minutes, pass_percent, public_token, created_by)
       VALUES (current_organization_id(), $1, $2, $3, $4, $5, $6)
       RETURNING id, public_token`,
      [title, clean(req.body.description), duration, passPercent, genToken(), req.admin.name || 'Admin']
    );
    res.json({ success: true, message: 'Test created', id: r.rows[0].id, public_token: r.rows[0].public_token });
  } catch (err) {
    console.error('[assessment create test]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Update a test
router.put('/tests/:id', adminAuth, async (req, res) => {
  const { title, description, duration_minutes, pass_percent, status } = req.body;
  if (status && !['Active', 'Inactive'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status' });
  }
  try {
    const r = await db.query(
      `UPDATE assessment_tests
          SET title = COALESCE($1, title),
              description = $2,
              duration_minutes = COALESCE($3, duration_minutes),
              pass_percent = COALESCE($4, pass_percent),
              status = COALESCE($5, status),
              updated_at = NOW()
        WHERE id = $6
        RETURNING id`,
      [
        clean(title),
        clean(description),
        duration_minutes !== undefined ? (parseInt(duration_minutes, 10) || 0) : null,
        pass_percent !== undefined ? Math.max(0, Math.min(100, parseInt(pass_percent, 10) || 0)) : null,
        status || null,
        req.params.id,
      ]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Test not found' });
    res.json({ success: true, message: 'Test updated' });
  } catch (err) {
    console.error('[assessment update test]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Regenerate the public link token (invalidates the old link)
router.post('/tests/:id/regenerate-link', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE assessment_tests SET public_token = $1, updated_at = NOW() WHERE id = $2 RETURNING public_token`,
      [genToken(), req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Test not found' });
    res.json({ success: true, message: 'Link regenerated', public_token: r.rows[0].public_token });
  } catch (err) {
    console.error('[assessment regen link]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Delete a test (cascades questions + submissions)
router.delete('/tests/:id', adminAuth, async (req, res) => {
  try {
    await db.query(`DELETE FROM assessment_tests WHERE id = $1`, [req.params.id]);
    res.json({ success: true, message: 'Test deleted' });
  } catch (err) {
    console.error('[assessment delete test]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// List questions for a test (WITH correct answers — admin only)
router.get('/tests/:id/questions', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, sr_no, question_text, option_a, option_b, option_c, option_d, correct_option, marks
         FROM assessment_questions WHERE test_id = $1 ORDER BY sr_no, id`,
      [req.params.id]
    );
    res.json({ success: true, questions: r.rows });
  } catch (err) {
    console.error('[assessment questions]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Add a question
router.post('/tests/:id/questions', adminAuth, async (req, res) => {
  const q = clean(req.body.question_text);
  const correct = String(req.body.correct_option || '').toUpperCase();
  if (!q) return res.status(400).json({ success: false, message: 'Question text is required' });
  if (!['A', 'B', 'C', 'D'].includes(correct)) {
    return res.status(400).json({ success: false, message: 'Select the correct option (A/B/C/D)' });
  }
  try {
    const test = await db.query(`SELECT id FROM assessment_tests WHERE id = $1`, [req.params.id]);
    if (!test.rows.length) return res.status(404).json({ success: false, message: 'Test not found' });
    const nextSr = await db.query(
      `SELECT COALESCE(MAX(sr_no), 0) + 1 AS n FROM assessment_questions WHERE test_id = $1`,
      [req.params.id]
    );
    const r = await db.query(
      `INSERT INTO assessment_questions
         (organization_id, test_id, sr_no, question_text, option_a, option_b, option_c, option_d, correct_option, marks)
       VALUES (current_organization_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        req.params.id, nextSr.rows[0].n, q,
        clean(req.body.option_a) || '', clean(req.body.option_b) || '',
        clean(req.body.option_c) || '', clean(req.body.option_d) || '',
        correct, parseInt(req.body.marks, 10) || 1,
      ]
    );
    res.json({ success: true, message: 'Question added', id: r.rows[0].id });
  } catch (err) {
    console.error('[assessment add question]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Update a question
router.put('/questions/:qid', adminAuth, async (req, res) => {
  const correct = req.body.correct_option ? String(req.body.correct_option).toUpperCase() : null;
  if (correct && !['A', 'B', 'C', 'D'].includes(correct)) {
    return res.status(400).json({ success: false, message: 'Invalid correct option' });
  }
  try {
    const r = await db.query(
      `UPDATE assessment_questions
          SET question_text = COALESCE($1, question_text),
              option_a = COALESCE($2, option_a),
              option_b = COALESCE($3, option_b),
              option_c = COALESCE($4, option_c),
              option_d = COALESCE($5, option_d),
              correct_option = COALESCE($6, correct_option),
              marks = COALESCE($7, marks)
        WHERE id = $8
        RETURNING id`,
      [
        clean(req.body.question_text),
        req.body.option_a !== undefined ? (clean(req.body.option_a) || '') : null,
        req.body.option_b !== undefined ? (clean(req.body.option_b) || '') : null,
        req.body.option_c !== undefined ? (clean(req.body.option_c) || '') : null,
        req.body.option_d !== undefined ? (clean(req.body.option_d) || '') : null,
        correct,
        req.body.marks !== undefined ? (parseInt(req.body.marks, 10) || 1) : null,
        req.params.qid,
      ]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Question not found' });
    res.json({ success: true, message: 'Question updated' });
  } catch (err) {
    console.error('[assessment update question]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Delete a question
router.delete('/questions/:qid', adminAuth, async (req, res) => {
  try {
    await db.query(`DELETE FROM assessment_questions WHERE id = $1`, [req.params.qid]);
    res.json({ success: true, message: 'Question deleted' });
  } catch (err) {
    console.error('[assessment delete question]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Results (submissions) for a test
router.get('/tests/:id/results', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, candidate_name, mobile, email, position, total_questions, correct_count,
              total_marks, scored_marks, score_percent, passed, interview_status, remarks, submitted_at
         FROM assessment_submissions WHERE test_id = $1 ORDER BY submitted_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, submissions: r.rows });
  } catch (err) {
    console.error('[assessment results]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// One submission with full answer breakdown
router.get('/submissions/:sid', adminAuth, async (req, res) => {
  try {
    const s = await db.query(`SELECT * FROM assessment_submissions WHERE id = $1`, [req.params.sid]);
    if (!s.rows.length) return res.status(404).json({ success: false, message: 'Submission not found' });
    const sub = s.rows[0];
    const q = await db.query(
      `SELECT id, sr_no, question_text, option_a, option_b, option_c, option_d, correct_option, marks
         FROM assessment_questions WHERE test_id = $1 ORDER BY sr_no, id`,
      [sub.test_id]
    );
    res.json({ success: true, submission: sub, questions: q.rows });
  } catch (err) {
    console.error('[assessment submission detail]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Update interview status / remarks on a submission
router.put('/submissions/:sid', adminAuth, async (req, res) => {
  const { interview_status, remarks } = req.body;
  if (interview_status && !INTERVIEW_STATUSES.includes(interview_status)) {
    return res.status(400).json({ success: false, message: 'Invalid interview status' });
  }
  try {
    const r = await db.query(
      `UPDATE assessment_submissions
          SET interview_status = COALESCE($1, interview_status),
              remarks = $2
        WHERE id = $3 RETURNING id`,
      [interview_status || null, clean(remarks), req.params.sid]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Submission not found' });
    res.json({ success: true, message: 'Updated' });
  } catch (err) {
    console.error('[assessment update submission]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/submissions/:sid', adminAuth, async (req, res) => {
  try {
    await db.query(`DELETE FROM assessment_submissions WHERE id = $1`, [req.params.sid]);
    res.json({ success: true, message: 'Submission deleted' });
  } catch (err) {
    console.error('[assessment delete submission]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
//  PUBLIC ENDPOINTS (no auth — candidate link)
//  The unguessable token is the access boundary. We look up the test
//  under a bypass context, then scope every query to that test_id.
// ═══════════════════════════════════════════════════════════════

async function findTestByToken(token) {
  const r = await db.runWithTenant({ bypassTenant: true }, () => db.query(
    `SELECT id, organization_id, title, description, duration_minutes, pass_percent, status
       FROM assessment_tests WHERE public_token = $1`,
    [token]
  ));
  return r.rows[0] || null;
}

// Get test + questions (NO correct answers) for the candidate
router.get('/public/:token', async (req, res) => {
  try {
    const test = await findTestByToken(req.params.token);
    if (!test || test.status !== 'Active') {
      return res.status(404).json({ success: false, message: 'This assessment link is not available.' });
    }
    const q = await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `SELECT id, sr_no, question_text, option_a, option_b, option_c, option_d, marks
         FROM assessment_questions WHERE test_id = $1 ORDER BY sr_no, id`,
      [test.id]
    ));
    if (!q.rows.length) {
      return res.status(404).json({ success: false, message: 'This assessment has no questions yet.' });
    }
    res.json({
      success: true,
      test: {
        title: test.title,
        description: test.description,
        duration_minutes: test.duration_minutes,
        total_questions: q.rows.length,
      },
      questions: q.rows,
    });
  } catch (err) {
    console.error('[assessment public get]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Candidate submits answers → auto-score → store
router.post('/public/:token/submit', async (req, res) => {
  const name = clean(req.body.candidate_name);
  if (!name) return res.status(400).json({ success: false, message: 'Please enter your name.' });
  const answers = req.body.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
  try {
    const test = await findTestByToken(req.params.token);
    if (!test || test.status !== 'Active') {
      return res.status(404).json({ success: false, message: 'This assessment link is not available.' });
    }
    const qres = await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `SELECT id, question_text, correct_option, marks FROM assessment_questions WHERE test_id = $1`,
      [test.id]
    ));
    const questions = qres.rows;
    if (!questions.length) {
      return res.status(400).json({ success: false, message: 'This assessment has no questions.' });
    }

    let correctCount = 0, scoredMarks = 0, totalMarks = 0;
    const breakdown = questions.map(q => {
      totalMarks += q.marks;
      const selected = String(answers[q.id] || answers[String(q.id)] || '').toUpperCase();
      const isCorrect = selected && selected === q.correct_option;
      if (isCorrect) { correctCount += 1; scoredMarks += q.marks; }
      return { question_id: q.id, selected: selected || null, correct: q.correct_option, is_correct: !!isCorrect, marks: q.marks };
    });
    const scorePercent = totalMarks > 0 ? Math.round((scoredMarks / totalMarks) * 10000) / 100 : 0;
    const passed = test.pass_percent > 0 ? scorePercent >= test.pass_percent : false;
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();

    await db.runWithTenant({ organizationId: test.organization_id }, () => db.query(
      `INSERT INTO assessment_submissions
         (organization_id, test_id, candidate_name, mobile, email, position,
          total_questions, correct_count, total_marks, scored_marks, score_percent, passed,
          answers, ip_address, started_at, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())`,
      [
        test.organization_id, test.id, name, clean(req.body.mobile), clean(req.body.email), clean(req.body.position),
        questions.length, correctCount, totalMarks, scoredMarks, scorePercent, passed,
        JSON.stringify(breakdown), ip || null, req.body.started_at || null,
      ]
    ));
    // Candidate never sees the score — hiring flow.
    res.json({ success: true, message: 'Your assessment has been submitted successfully. Our team will contact you soon.' });
  } catch (err) {
    console.error('[assessment public submit]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
