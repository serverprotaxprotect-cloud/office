const express = require('express');
const XLSX = require('xlsx');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const complianceService = require('../services/complianceService');

const router = express.Router();

const STATUS_OPTIONS = complianceService.COMPLIANCE_STATUSES;
const templatesCache = new Map();
const TEMPLATES_CACHE_TTL_MS = 60 * 1000;

function orgCacheKey(req, suffix) {
  return `${req.user?.organization_id || req.user?.organizationId || 'default'}:${suffix}`;
}

function clearTemplatesCache(req) {
  if (!req) {
    templatesCache.clear();
    return;
  }
  const prefix = `${req.user?.organization_id || req.user?.organizationId || 'default'}:`;
  for (const key of templatesCache.keys()) {
    if (key.startsWith(prefix)) templatesCache.delete(key);
  }
}

const FY_OPTIONS = () => {
  const now = new Date(Date.now() + (5.5 * 60 * 60 * 1000)); // IST
  const curYear = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const out = [];
  for (let y = curYear - 4; y <= curYear + 4; y++) {
    out.push(`${y}-${String(y + 1).slice(-2)}`);
  }
  return out;
};

async function logActivity(p) {
  try {
    await db.query(
      `INSERT INTO compliance_activity_log (module,action,cin,company_name,din,director_name,financial_year,old_value,new_value,remarks,emp_id,emp_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [p.module||'',p.action||'',p.cin||'',p.company_name||'',p.din||null,p.director_name||null,
       p.financial_year||null,p.old_value||null,p.new_value||null,p.remarks||null,p.emp_id||'',p.emp_name||'']
    );
  } catch(e) { console.error('Log error:',e.message); }
}

function companyFilterWhere(query = {}) {
  const { search, status } = query;
  const conds = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    conds.push(`(cin ILIKE $${params.length} OR company_name ILIKE $${params.length} OR client_id ILIKE $${params.length} OR agent_name ILIKE $${params.length})`);
  }
  if (status) {
    params.push(status);
    conds.push(`company_status=$${params.length}`);
  }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

// ── COMPANIES ─────────────────────────────────────────────────

router.get('/companies', authMiddleware, async (req, res) => {
  try {
    const { where, params } = companyFilterWhere(req.query);
    const [r, counts, filtered] = await Promise.all([
      db.query(
        `SELECT id,cin,company_name,client_id,agent_name,company_type,incorporation_date,company_status,city,state,last_agm_date,pan_no,tan_no
         FROM companies ${where} ORDER BY company_name LIMIT 300`, params),
      db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE company_status='Active')::int AS active,
                COUNT(*) FILTER (WHERE company_status='Inactive')::int AS inactive
         FROM companies`),
      db.query(`SELECT COUNT(*)::int AS total FROM companies ${where}`, params),
    ]);
    res.json({
      success:true,
      companies:r.rows,
      counts: { ...counts.rows[0], filtered: filtered.rows[0]?.total || 0, showing: r.rows.length },
      fy_options:FY_OPTIONS(),
      status_options:STATUS_OPTIONS,
    });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

router.get('/companies/export', authMiddleware, async (req, res) => {
  try {
    const { where, params } = companyFilterWhere(req.query);
    const result = await db.query(
      `SELECT cin,company_name,client_id,agent_name,company_type,category,
              to_char(incorporation_date::date, 'DD Mon YYYY') AS incorporation_date,
              to_char(last_agm_date::date, 'DD Mon YYYY') AS last_agm_date,
              company_status,city,state,pan_no,tan_no
       FROM companies ${where}
       ORDER BY company_name`,
      params
    );
    const rows = result.rows.map((c, i) => ({
      'Sl No': i + 1,
      CIN: c.cin || '',
      'Company Name': c.company_name || '',
      'Client ID': c.client_id || '',
      Agent: c.agent_name || '',
      'Company Type': c.company_type || '',
      Category: c.category || '',
      'Incorporation Date': c.incorporation_date || '',
      'Last AGM': c.last_agm_date || '',
      Status: c.company_status || '',
      City: c.city || '',
      State: c.state || '',
      PAN: c.pan_no || '',
      TAN: c.tan_no || '',
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      { wch: 8 }, { wch: 24 }, { wch: 45 }, { wch: 14 }, { wch: 28 },
      { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 12 },
      { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 14 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Companies');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="companies-${stamp}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    console.error('[companies export]', err);
    res.status(500).json({ success:false, message:'Export failed' });
  }
});

router.get('/companies/workspace-list', authMiddleware, async (req, res) => {
  try {
    const data = await complianceService.workspaceCompanyList(req.query.financial_year);
    res.json({ success:true, ...data, fy_options:FY_OPTIONS() });
  } catch (err) { routeError(res, err, '[compliance workspace company list]'); }
});

router.post('/companies/bulk-generate', authMiddleware, async (req, res) => {
  try {
    if (!req.body.financial_year) return res.status(400).json({ success:false, message:'Financial Year required' });
    const result = await complianceService.bulkGenerateCompanyCompliances(req.body.financial_year, req.user);
    res.json({ success:true, message:`Bulk generate complete: ${result.created} records created`, ...result });
  } catch (err) { routeError(res, err, '[compliance bulk generate]'); }
});

router.get('/companies/:cin', authMiddleware, async (req, res) => {
  try {
    await complianceService.ensureSchema();
    const c = await db.query('SELECT * FROM companies WHERE UPPER(cin)=UPPER($1)', [req.params.cin]);
    if (!c.rows.length) return res.status(404).json({ success:false, message:'Company not found' });
    const [dirs, records, events] = await Promise.all([
      db.query('SELECT * FROM directors WHERE UPPER(cin)=UPPER($1) ORDER BY director_name', [req.params.cin]),
      complianceService.listRecords({ cin: req.params.cin }),
      complianceService.listEvents(req.params.cin),
    ]);
    res.json({ success:true, company:c.rows[0], directors:dirs.rows, compliance_records:records, events });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

router.post('/companies', authMiddleware, async (req, res) => {
  const { cin,company_name,client_id,agent_name,company_type,category,incorporation_date,
    registered_office,city,state,pin_code,email,mobile,authorized_capital,paid_up_capital,
    pan_no,tan_no,last_agm_date,last_balance_sheet_date,notes } = req.body;
  if (!cin||!company_name) return res.status(400).json({ success:false, message:'CIN and Company Name required' });
  try {
    await db.query(
      `INSERT INTO companies (cin,company_name,client_id,agent_name,company_type,category,
        incorporation_date,registered_office,city,state,pin_code,email,mobile,
        authorized_capital,paid_up_capital,pan_no,tan_no,last_agm_date,last_balance_sheet_date,notes,company_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'Active')
       ON CONFLICT (organization_id, upper(cin)) DO UPDATE SET
         company_name=EXCLUDED.company_name, client_id=EXCLUDED.client_id, agent_name=EXCLUDED.agent_name,
         company_type=EXCLUDED.company_type, city=EXCLUDED.city, state=EXCLUDED.state,
         email=EXCLUDED.email, mobile=EXCLUDED.mobile, pan_no=EXCLUDED.pan_no, tan_no=EXCLUDED.tan_no,
         incorporation_date=EXCLUDED.incorporation_date, last_agm_date=EXCLUDED.last_agm_date,
         notes=EXCLUDED.notes, updated_at=NOW()`,
      [cin,company_name,client_id||null,agent_name||null,company_type||null,category||null,
       incorporation_date||null,registered_office||null,city||null,state||null,pin_code||null,
       email||null,mobile||null,parseFloat(authorized_capital)||null,parseFloat(paid_up_capital)||null,
       pan_no||null,tan_no||null,last_agm_date||null,last_balance_sheet_date||null,notes||null]);
    let compliance_created = 0;
    try {
      const generated = await complianceService.autoGenerateForCompany(cin, req.user);
      compliance_created = generated.created || 0;
    } catch (genErr) {
      console.error('[company compliance auto-generate]', genErr.message);
    }
    res.json({ success:true, message:'Company saved!', compliance_created });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

router.put('/companies/:cin', authMiddleware, async (req, res) => {
  const { company_name,client_id,agent_name,company_type,incorporation_date,
    city,state,email,mobile,pan_no,tan_no,last_agm_date,notes } = req.body;
  try {
    const r = await db.query(
      `UPDATE companies SET
        company_name=COALESCE($1,company_name), client_id=COALESCE($2,client_id),
        agent_name=COALESCE($3,agent_name), company_type=COALESCE($4,company_type),
        incorporation_date=COALESCE($5::date,incorporation_date), city=COALESCE($6,city),
        state=COALESCE($7,state), email=COALESCE($8,email), mobile=COALESCE($9,mobile),
        pan_no=COALESCE($10,pan_no), tan_no=COALESCE($11,tan_no),
        last_agm_date=COALESCE($12::date,last_agm_date), notes=COALESCE($13,notes), updated_at=NOW()
       WHERE UPPER(cin)=UPPER($14)`,
      [company_name||null,client_id||null,agent_name||null,company_type||null,
       incorporation_date||null,city||null,state||null,email||null,mobile||null,
       pan_no||null,tan_no||null,last_agm_date||null,notes||null,req.params.cin]);
    if (!r.rowCount) return res.status(404).json({ success:false, message:'Company not found' });
    res.json({ success:true, message:'Company updated!' });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

router.put('/companies/:cin/status', authMiddleware, async (req, res) => {
  const { emp_id, name, formal_name } = req.user;
  const { status, remarks } = req.body;
  try {
    const old = await db.query('SELECT company_name,company_status FROM companies WHERE UPPER(cin)=UPPER($1)', [req.params.cin]);
    if (!old.rows.length) return res.status(404).json({ success:false, message:'Company not found' });
    await db.query(`UPDATE companies SET company_status=$1, updated_at=NOW() WHERE UPPER(cin)=UPPER($2)`, [status, req.params.cin]);
    await logActivity({ module:'Company', action:'StatusChange', cin:req.params.cin,
      company_name:old.rows[0].company_name, old_value:old.rows[0].company_status,
      new_value:status, remarks:remarks||null, emp_id, emp_name:formal_name||name });
    res.json({ success:true, message:`Company marked ${status}` });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

// ── DIRECTORS ─────────────────────────────────────────────────

function routeError(res, err, label) {
  console.error(label, err);
  res.status(err.statusCode || 500).json({ success:false, message:err.message || 'Server error' });
}

// Normalized company compliance engine
router.get('/templates', authMiddleware, async (req, res) => {
  try {
    const key = orgCacheKey(req, 'templates');
    const cached = templatesCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json(cached.payload);
    }
    const data = await complianceService.listTemplates();
    const payload = { success:true, templates:data.templates, employees:data.employees, status_options:STATUS_OPTIONS, fy_options:FY_OPTIONS(), template_types:complianceService.TEMPLATE_TYPES };
    templatesCache.set(key, { payload, expiresAt: Date.now() + TEMPLATES_CACHE_TTL_MS });
    res.json(payload);
  } catch (err) { routeError(res, err, '[compliance templates]'); }
});

router.post('/templates', authMiddleware, async (req, res) => {
  try {
    await complianceService.ensureSchema();
    const { code, name, template_type, event_type, due_rule, default_priority, enabled, sort_order } = req.body;
    if (!code || !name || !template_type) return res.status(400).json({ success:false, message:'Code, name and type required' });
    await db.query(
      `INSERT INTO compliance_templates
        (code,name,template_type,event_type,due_rule,default_priority,enabled,sort_order)
       VALUES (UPPER($1),$2,$3,$4,$5,$6,COALESCE($7,true),COALESCE($8,100))
       ON CONFLICT (organization_id, code) DO UPDATE SET
         name=EXCLUDED.name, template_type=EXCLUDED.template_type, event_type=EXCLUDED.event_type,
         due_rule=EXCLUDED.due_rule, default_priority=EXCLUDED.default_priority,
         enabled=EXCLUDED.enabled, sort_order=EXCLUDED.sort_order, updated_at=NOW()`,
      [code, name, template_type, event_type || null, due_rule || null, default_priority || 'Medium', typeof enabled === 'boolean' ? enabled : true, sort_order ? parseInt(sort_order,10) : 100]
    );
    clearTemplatesCache(req);
    res.json({ success:true, message:'Compliance template saved' });
  } catch (err) { routeError(res, err, '[compliance template create]'); }
});

router.put('/templates/:id', authMiddleware, async (req, res) => {
  try {
    const template = await complianceService.updateTemplate(parseInt(req.params.id, 10), req.body, req.user);
    clearTemplatesCache(req);
    res.json({ success:true, message:'Compliance template updated', template });
  } catch (err) { routeError(res, err, '[compliance template update]'); }
});

router.get('/summary', authMiddleware, async (req, res) => {
  try {
    const data = await complianceService.summary(req.query);
    res.json({ success:true, summary:data });
  } catch (err) { routeError(res, err, '[compliance summary]'); }
});

router.get('/dashboard', authMiddleware, async (req, res) => {
  try {
    const data = await complianceService.dashboard(req.query.financial_year);
    res.json({ success:true, dashboard:data, fy_options:FY_OPTIONS(), status_options:STATUS_OPTIONS });
  } catch (err) { routeError(res, err, '[compliance dashboard]'); }
});

router.get('/reports/fy', authMiddleware, async (req, res) => {
  try {
    const data = await complianceService.fyReport(req.query);
    res.json({ success:true, ...data, fy_options:FY_OPTIONS(), status_options:STATUS_OPTIONS });
  } catch (err) { routeError(res, err, '[compliance fy report]'); }
});

router.get('/companies/:cin/workspace', authMiddleware, async (req, res) => {
  try {
    const data = await complianceService.workspace(req.params.cin, req.query.financial_year);
    res.json({ success:true, ...data, fy_options:FY_OPTIONS() });
  } catch (err) { routeError(res, err, '[company compliance workspace]'); }
});

router.get('/companies/:cin/compliances', authMiddleware, async (req, res) => {
  try {
    const rows = await complianceService.listRecords({ ...req.query, cin:req.params.cin });
    res.json({ success:true, rows, status_options:STATUS_OPTIONS, fy_options:FY_OPTIONS() });
  } catch (err) { routeError(res, err, '[company compliances]'); }
});

router.post('/companies/:cin/compliances/generate', authMiddleware, async (req, res) => {
  try {
    const { financial_year } = req.body;
    if (!financial_year) return res.status(400).json({ success:false, message:'Financial Year required' });
    const result = await complianceService.generateCompanyCompliances(req.params.cin, financial_year, req.user);
    res.json({ success:true, message:`${result.created} compliance records generated`, ...result });
  } catch (err) { routeError(res, err, '[company compliance generate]'); }
});

router.get('/companies/:cin/events', authMiddleware, async (req, res) => {
  try {
    const events = await complianceService.listEvents(req.params.cin);
    res.json({ success:true, events });
  } catch (err) { routeError(res, err, '[company events]'); }
});

router.post('/companies/:cin/events', authMiddleware, async (req, res) => {
  try {
    if (!req.body.event_type) return res.status(400).json({ success:false, message:'Event type required' });
    const result = await complianceService.createEvent(req.params.cin, req.body, req.user);
    res.json({ success:true, message:`Event saved. ${result.created} compliance records created.`, ...result });
  } catch (err) { routeError(res, err, '[company event create]'); }
});

router.get('/compliance-records', authMiddleware, async (req, res) => {
  try {
    const rows = await complianceService.listRecords(req.query);
    res.json({ success:true, rows, status_options:STATUS_OPTIONS, fy_options:FY_OPTIONS() });
  } catch (err) { routeError(res, err, '[compliance records]'); }
});

router.put('/compliance-records/:id', authMiddleware, async (req, res) => {
  try {
    const record = await complianceService.updateRecord(parseInt(req.params.id, 10), req.body, req.user);
    res.json({ success:true, message:'Compliance record updated', record });
  } catch (err) { routeError(res, err, '[compliance record update]'); }
});

router.put('/compliance-records/:id/inline', authMiddleware, async (req, res) => {
  try {
    let record = await complianceService.updateRecord(parseInt(req.params.id, 10), req.body, req.user);
    if (req.body.assigned_to_id && req.body.assigned_to_id !== record.assigned_to_id) {
      record = await complianceService.assignRecord(parseInt(req.params.id, 10), req.body.assigned_to_id, req.user, req.body.remarks || null);
    }
    res.json({ success:true, message:'Compliance row saved', record });
  } catch (err) { routeError(res, err, '[compliance inline update]'); }
});

router.put('/compliance-records/:id/status', authMiddleware, async (req, res) => {
  try {
    const record = await complianceService.updateRecord(parseInt(req.params.id, 10), req.body, req.user);
    res.json({ success:true, message:'Compliance status updated', record });
  } catch (err) { routeError(res, err, '[compliance status update]'); }
});

router.put('/compliance-records/:id/assign', authMiddleware, async (req, res) => {
  try {
    if (!req.body.assigned_to_id) return res.status(400).json({ success:false, message:'Assignee required' });
    const record = await complianceService.assignRecord(parseInt(req.params.id, 10), req.body.assigned_to_id, req.user, req.body.remarks || null);
    res.json({ success:true, message:'Compliance assigned and task linked', record });
  } catch (err) { routeError(res, err, '[compliance assign]'); }
});

router.post('/compliance-records/:id/create-task', authMiddleware, async (req, res) => {
  try {
    const result = await complianceService.createTaskForRecordId(parseInt(req.params.id, 10), req.user);
    res.json({ success:true, message:result.existed ? 'Task already linked' : 'Task created', ...result });
  } catch (err) { routeError(res, err, '[compliance task create]'); }
});

router.get('/directors', authMiddleware, async (req, res) => {
  const { search, kyc_status, cin } = req.query;
  try {
    const conds = []; const params = [];
    if (cin) { params.push(cin); conds.push(`UPPER(cin)=UPPER($${params.length})`); }
    if (search) {
      params.push(`%${search}%`);
      conds.push(`(din ILIKE $${params.length} OR director_name ILIKE $${params.length} OR company_name ILIKE $${params.length} OR pan_no ILIKE $${params.length})`);
    }
    if (kyc_status) { params.push(kyc_status); conds.push(`kyc_status=$${params.length}`); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
    const r = await db.query(
      `SELECT id,cin,company_name,din,director_name,designation,date_of_appointment,
              date_of_cessation,kyc_status,dir_3_filed,dir_3_fy,director_status,mobile,email,pan_no,agent_name,client_id
       FROM directors ${where} ORDER BY director_name LIMIT 300`, params);
    res.json({ success:true, directors:r.rows });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

router.post('/directors', authMiddleware, async (req, res) => {
  const { cin,company_name,client_id,agent_name,din,director_name,designation,
    date_of_appointment,date_of_cessation,father_name,date_of_birth,nationality,
    mobile,email,pan_no,aadhaar_no,address,kyc_status,dir_3_filed,dir_3_fy,director_status,notes } = req.body;
  if (!din||!director_name) return res.status(400).json({ success:false, message:'DIN and Director Name required' });
  try {
    await db.query(
      `INSERT INTO directors (cin,company_name,client_id,agent_name,din,director_name,designation,
        date_of_appointment,date_of_cessation,father_name,date_of_birth,nationality,
        mobile,email,pan_no,aadhaar_no,address,kyc_status,dir_3_filed,dir_3_fy,director_status,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [cin||null,company_name||null,client_id||null,agent_name||null,din,director_name,
       designation||null,date_of_appointment||null,date_of_cessation||null,
       father_name||null,date_of_birth||null,nationality||'India',
       mobile||null,email||null,pan_no||null,aadhaar_no||null,address||null,
       kyc_status||'Pending',dir_3_filed||null,dir_3_fy||null,director_status||'Active',notes||null]);
    res.json({ success:true, message:'Director added!' });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

router.put('/directors/:id', authMiddleware, async (req, res) => {
  const { emp_id, name, formal_name } = req.user;
  const { kyc_status,dir_3_filed,dir_3_fy,director_status,mobile,email,pan_no,
    aadhaar_no,address,notes,designation,date_of_appointment,date_of_cessation } = req.body;
  try {
    const old = await db.query('SELECT din,director_name,company_name,cin,kyc_status FROM directors WHERE id=$1', [req.params.id]);
    if (!old.rows.length) return res.status(404).json({ success:false, message:'Director not found' });
    const d = old.rows[0];
    await db.query(
      `UPDATE directors SET
        kyc_status=COALESCE($1,kyc_status), dir_3_filed=COALESCE($2,dir_3_filed),
        dir_3_fy=COALESCE($3,dir_3_fy), director_status=COALESCE($4,director_status),
        mobile=COALESCE($5,mobile), email=COALESCE($6,email), pan_no=COALESCE($7,pan_no),
        aadhaar_no=COALESCE($8,aadhaar_no), address=COALESCE($9,address), notes=COALESCE($10,notes),
        designation=COALESCE($11,designation),
        date_of_appointment=COALESCE($12::date,date_of_appointment),
        date_of_cessation=COALESCE($13::date,date_of_cessation) WHERE id=$14`,
      [kyc_status||null,dir_3_filed||null,dir_3_fy||null,director_status||null,
       mobile||null,email||null,pan_no||null,aadhaar_no||null,address||null,notes||null,
       designation||null,date_of_appointment||null,date_of_cessation||null,req.params.id]);
    if (kyc_status && kyc_status !== d.kyc_status) {
      await logActivity({ module:'DirectorKYC', action:'StatusChange', cin:d.cin, company_name:d.company_name,
        din:d.din, director_name:d.director_name, old_value:d.kyc_status, new_value:kyc_status,
        emp_id, emp_name:formal_name||name });
    }
    res.json({ success:true, message:'Director updated!' });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

// ── COMPLIANCE TRACKING ───────────────────────────────────────

router.get('/tracking', authMiddleware, async (req, res) => {
  const { cin, financial_year, status, company_text, agent_name, client_id, company_status } = req.query;
  try {
    const conds = ['1=1']; const params = [];
    if (cin) { params.push(cin); conds.push(`UPPER(ct.cin)=UPPER($${params.length})`); }
    if (financial_year) { params.push(financial_year); conds.push(`ct.financial_year=$${params.length}`); }
    if (company_text) { params.push(`%${company_text}%`); conds.push(`(ct.company_name ILIKE $${params.length} OR ct.cin ILIKE $${params.length})`); }
    if (agent_name) { params.push(`%${agent_name}%`); conds.push(`ct.agent_name ILIKE $${params.length}`); }
    if (client_id) { params.push(`%${client_id}%`); conds.push(`ct.client_id ILIKE $${params.length}`); }
    if (company_status) { params.push(company_status); conds.push(`COALESCE(c.company_status,'Active')=$${params.length}`); }
    if (status) {
      params.push(status);
      conds.push(`(ct.inc20a=$${params.length} OR ct.adt1=$${params.length} OR ct.aoc4=$${params.length} OR ct.mgt7a=$${params.length} OR ct.itr=$${params.length} OR ct.documents_status=$${params.length} OR ct.financial_statement=$${params.length})`);
    }
    const r = await db.query(
      `SELECT ct.*, COALESCE(c.company_status,'Active') as company_status
       FROM compliance_tracking ct
       LEFT JOIN companies c ON UPPER(c.cin)=UPPER(ct.cin)
       WHERE ${conds.join(' AND ')}
       ORDER BY ct.company_name, ct.financial_year DESC LIMIT 500`, params);
    res.json({ success:true, rows:r.rows, fy_options:FY_OPTIONS(), status_options:STATUS_OPTIONS });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

router.post('/tracking/generate', authMiddleware, async (req, res) => {
  const { emp_id, name, formal_name } = req.user;
  const { cin, financial_year } = req.body;
  if (!cin||!financial_year) return res.status(400).json({ success:false, message:'CIN and Financial Year required' });
  try {
    const co = await db.query('SELECT * FROM companies WHERE UPPER(cin)=UPPER($1)', [cin]);
    if (!co.rows.length) return res.status(404).json({ success:false, message:'Company not found. Add company first.' });
    const c = co.rows[0];
    if (c.company_status==='Inactive') return res.status(400).json({ success:false, message:'Company is Inactive. Cannot generate compliance.' });
    const ex = await db.query('SELECT id FROM compliance_tracking WHERE UPPER(cin)=UPPER($1) AND financial_year=$2', [cin, financial_year]);
    if (ex.rows.length) return res.status(400).json({ success:false, message:`Compliance already generated for ${financial_year}` });
    await db.query(
      `INSERT INTO compliance_tracking (agent_name,client_id,cin,company_name,financial_year,
        inc20a,adt1,aoc4,mgt7a,itr,documents_status,financial_statement,updated_by_id,updated_by_name)
       VALUES ($1,$2,$3,$4,$5,'Pending','Pending','Pending','Pending','Pending','Pending','Pending',$6,$7)`,
      [c.agent_name||'',c.client_id||'',cin.toUpperCase(),c.company_name,financial_year,emp_id,formal_name||name]);
    await logActivity({ module:'Compliance', action:'Generate', cin:cin.toUpperCase(),
      company_name:c.company_name, financial_year, new_value:'Generated', emp_id, emp_name:formal_name||name });
    res.json({ success:true, message:`Compliance generated for ${c.company_name} (${financial_year})` });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

router.post('/tracking/bulk-generate', authMiddleware, async (req, res) => {
  const { emp_id, name, formal_name } = req.user;
  const { financial_year } = req.body;
  if (!financial_year) return res.status(400).json({ success:false, message:'Financial Year required' });
  try {
    const companies = await db.query(
      `SELECT cin,company_name,agent_name,client_id FROM companies
       WHERE company_status='Active'
         AND NOT EXISTS (SELECT 1 FROM compliance_tracking ct WHERE UPPER(ct.cin)=UPPER(companies.cin) AND ct.financial_year=$1)
       ORDER BY company_name`, [financial_year]);
    let created = 0;
    for (const c of companies.rows) {
      await db.query(
        `INSERT INTO compliance_tracking (agent_name,client_id,cin,company_name,financial_year,
          inc20a,adt1,aoc4,mgt7a,itr,documents_status,financial_statement,updated_by_id,updated_by_name)
         VALUES ($1,$2,$3,$4,$5,'Pending','Pending','Pending','Pending','Pending','Pending','Pending',$6,$7)`,
        [c.agent_name||'',c.client_id||'',c.cin.toUpperCase(),c.company_name,financial_year,emp_id,formal_name||name]);
      created++;
    }
    res.json({ success:true, message:`Bulk generated for ${created} companies for ${financial_year}.` });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

router.put('/tracking/:id', authMiddleware, async (req, res) => {
  const { emp_id, name, formal_name } = req.user;
  const { inc20a,srn_inc20a,adt1,srn_adt1,aoc4,srn_aoc4,mgt7a,srn_mgt7a,itr,documents_status,financial_statement,remarks } = req.body;
  try {
    const old = await db.query('SELECT cin,company_name,financial_year FROM compliance_tracking WHERE id=$1', [req.params.id]);
    if (!old.rows.length) return res.status(404).json({ success:false, message:'Record not found' });
    const r = old.rows[0];
    await db.query(
      `UPDATE compliance_tracking SET
        inc20a=COALESCE($1,inc20a), srn_inc20a=COALESCE($2,srn_inc20a),
        adt1=COALESCE($3,adt1), srn_adt1=COALESCE($4,srn_adt1),
        aoc4=COALESCE($5,aoc4), srn_aoc4=COALESCE($6,srn_aoc4),
        mgt7a=COALESCE($7,mgt7a), srn_mgt7a=COALESCE($8,srn_mgt7a),
        itr=COALESCE($9,itr), documents_status=COALESCE($10,documents_status),
        financial_statement=COALESCE($11,financial_statement), remarks=COALESCE($12,remarks),
        updated_by_id=$13, updated_by_name=$14, updated_at=NOW() WHERE id=$15`,
      [inc20a||null,srn_inc20a||null,adt1||null,srn_adt1||null,aoc4||null,srn_aoc4||null,
       mgt7a||null,srn_mgt7a||null,itr||null,documents_status||null,financial_statement||null,
       remarks||null,emp_id,formal_name||name,req.params.id]);
    await logActivity({ module:'Compliance', action:'UpdateStatus', cin:r.cin, company_name:r.company_name,
      financial_year:r.financial_year, new_value:JSON.stringify({inc20a,adt1,aoc4,mgt7a,itr,documents_status,financial_statement}),
      remarks:remarks||null, emp_id, emp_name:formal_name||name });
    res.json({ success:true, message:'Compliance updated!' });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

// ── DIRECTOR KYC TRACKING ─────────────────────────────────────

router.get('/kyc', authMiddleware, async (req, res) => {
  const { cin, din, financial_year, kyc_status, company_text, agent_name, company_status } = req.query;
  try {
    await complianceService.ensureKycCycleSchema();
    const conds = ['1=1']; const params = [];
    if (cin) { params.push(cin); conds.push(`UPPER(dk.cin)=UPPER($${params.length})`); }
    if (din) { params.push(`%${din}%`); conds.push(`dk.din ILIKE $${params.length}`); }
    if (financial_year) { params.push(financial_year); conds.push(`dk.financial_year=$${params.length}`); }
    if (kyc_status) { params.push(kyc_status); conds.push(`dk.kyc_status=$${params.length}`); }
    if (company_text) { params.push(`%${company_text}%`); conds.push(`(dk.company_name ILIKE $${params.length} OR dk.cin ILIKE $${params.length} OR dk.director_name ILIKE $${params.length})`); }
    if (agent_name) { params.push(`%${agent_name}%`); conds.push(`dk.agent_name ILIKE $${params.length}`); }
    if (company_status) { params.push(company_status); conds.push(`COALESCE(c.company_status,'Active')=$${params.length}`); }
    const r = await db.query(
      `SELECT dk.*, COALESCE(c.company_status,'Active') as company_status,
              d.last_kyc_financial_year, d.last_kyc_completed_date,
              d.next_kyc_due_date, d.kyc_cycle_status,
              COALESCE(dk.due_reason, d.kyc_due_reason) AS kyc_due_reason
       FROM director_kyc_tracking dk
       LEFT JOIN companies c ON UPPER(c.cin)=UPPER(dk.cin)
       LEFT JOIN directors d ON UPPER(d.cin)=UPPER(dk.cin) AND d.din=dk.din
       WHERE ${conds.join(' AND ')}
       ORDER BY dk.company_name, dk.director_name, dk.financial_year DESC LIMIT 500`, params);
    res.json({ success:true, rows:r.rows, fy_options:FY_OPTIONS(), status_options:STATUS_OPTIONS });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

router.post('/kyc/generate', authMiddleware, async (req, res) => {
  const { emp_id, name, formal_name } = req.user;
  const { cin, din, financial_year } = req.body;
  if (!cin||!din||!financial_year) return res.status(400).json({ success:false, message:'CIN, DIN and FY required' });
  try {
    const result = await complianceService.generateKycRecord(req.body, req.user);
    await logActivity({ module:'DirectorKYC', action:'Generate', cin:cin.toUpperCase(),
      company_name:result.row.company_name, din, director_name:result.row.director_name,
      financial_year, new_value:JSON.stringify(result.cycle), emp_id, emp_name:formal_name||name });
    res.json({ success:true, message:`KYC generated for ${result.row.director_name} (${financial_year})`, row: result.row, cycle: result.cycle });
  } catch(err) { routeError(res, err, '[kyc generate]'); }
});

router.post('/kyc/bulk-generate', authMiddleware, async (req, res) => {
  const { cin, financial_year } = req.body;
  if (!financial_year) return res.status(400).json({ success:false, message:'Financial Year required' });
  try {
    const counts = await complianceService.bulkGenerateKycRecords({ cin, financial_year }, req.user);
    res.json({
      success:true,
      counts,
      message:`DIR-3 KYC generation finished for ${financial_year}: ${counts.created} created, ${counts.already_exists} already existed, ${counts.not_due} not due, ${counts.missing_last_kyc} missing last KYC data.`
    });
  } catch(err) { routeError(res, err, '[kyc bulk generate]'); }
});

router.put('/kyc/:id', authMiddleware, async (req, res) => {
  const { emp_id, name, formal_name } = req.user;
  const { kyc_status, srn, remarks, active_flag, inactive_remarks } = req.body;
  try {
    await complianceService.ensureKycCycleSchema();
    const old = await db.query('SELECT din,director_name,cin,company_name,financial_year,kyc_status,linked_task_id FROM director_kyc_tracking WHERE id=$1', [req.params.id]);
    if (!old.rows.length) return res.status(404).json({ success:false, message:'KYC record not found' });
    const r = old.rows[0];
    await db.query(
      `UPDATE director_kyc_tracking SET
        kyc_status=COALESCE($1,kyc_status), srn=COALESCE($2,srn),
        remarks=COALESCE($3,remarks), active_flag=COALESCE($4,active_flag),
        inactive_remarks=COALESCE($5,inactive_remarks),
        updated_by_id=$6, updated_by_name=$7, updated_at=NOW() WHERE id=$8`,
      [kyc_status||null,srn||null,remarks||null,active_flag||null,inactive_remarks||null,
       emp_id,formal_name||name,req.params.id]);
    if (kyc_status && kyc_status!==r.kyc_status) {
      await complianceService.syncTaskForKycStatus(parseInt(req.params.id, 10), kyc_status, req.user, remarks || null);
      if (kyc_status === 'Filed' || kyc_status === 'Closed') {
        await complianceService.updateDirectorKycCycleAfterFiling(db, r, req.user);
      }
      await logActivity({ module:'DirectorKYC', action:'UpdateKYC', cin:r.cin, company_name:r.company_name,
        din:r.din, director_name:r.director_name, financial_year:r.financial_year,
        old_value:r.kyc_status, new_value:kyc_status, remarks:remarks||null, emp_id, emp_name:formal_name||name });
    }
    res.json({ success:true, message:'KYC updated!' });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

router.put('/kyc/:id/assign', authMiddleware, async (req, res) => {
  try {
    if (!req.body.assigned_to_id) return res.status(400).json({ success:false, message:'Assignee required' });
    const record = await complianceService.assignKycRecord(parseInt(req.params.id, 10), req.body.assigned_to_id, req.user, req.body.remarks || null);
    res.json({ success:true, message:'Director KYC assigned and task linked', record });
  } catch (err) { routeError(res, err, '[kyc assign]'); }
});

// ── COMPANY FULL VIEW (MCA style) ────────────────────────────
router.get('/company-full/:cin', authMiddleware, async (req, res) => {
  const cin = req.params.cin;
  try {
    const [master, dirs, charges, meetings, shareholders, tracking, normalized] = await Promise.all([
      db.query('SELECT * FROM master_data WHERE UPPER(cin)=UPPER($1) ORDER BY id DESC LIMIT 1', [cin]),
      db.query('SELECT * FROM director_details WHERE UPPER(cin)=UPPER($1) ORDER BY sr_no', [cin]),
      db.query('SELECT * FROM index_of_charges WHERE UPPER(cin)=UPPER($1) ORDER BY sr_no', [cin]),
      db.query('SELECT * FROM board_meetings WHERE UPPER(cin)=UPPER($1) ORDER BY date DESC LIMIT 20').catch(()=>({rows:[]})),
      db.query('SELECT * FROM shareholders WHERE UPPER(cin)=UPPER($1) ORDER BY sr_no LIMIT 100').catch(()=>({rows:[]})),
      db.query('SELECT * FROM compliance_tracking WHERE UPPER(cin)=UPPER($1) ORDER BY financial_year DESC', [cin]),
      complianceService.listRecords({ cin }),
    ]);
    if (!master.rows.length) return res.status(404).json({ success:false, message:'Company not found' });
    res.json({
      success:true,
      master: master.rows[0],
      directors: dirs.rows,
      charges: charges.rows,
      board_meetings: meetings.rows,
      shareholders: shareholders.rows,
      compliance_tracking: tracking.rows,
      compliance_records: normalized,
    });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

// ── DIRECTOR SEARCH (by DIN or name, shows all companies) ────
router.get('/director-search', authMiddleware, async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json({ success:true, directors:[] });
  try {
    const r = await db.query(
      `SELECT d.*, m.company_name as master_company_name, m.company_status as master_company_status
       FROM director_details d
       LEFT JOIN master_data m ON UPPER(m.cin)=UPPER(d.cin)
       WHERE d.din ILIKE $1 OR d.director_name ILIKE $1
       ORDER BY d.director_name, d.cin
       LIMIT 100`,
      [`%${q.trim()}%`]
    );
    // Group by DIN
    const grouped = {};
    r.rows.forEach(row => {
      const key = row.din || row.director_name;
      if (!grouped[key]) grouped[key] = { din: row.din, director_name: row.director_name, companies: [] };
      grouped[key].companies.push({
        cin: row.cin,
        company_name: row.master_company_name || '',
        client_id: row.client_id,
        designation: row.designation,
        category: row.category,
        appointment_date: row.appointment_date,
        resignation_date: row.resignation_date,
        company_status: row.master_company_status || 'Active',
      });
    });
    res.json({ success:true, directors: Object.values(grouped) });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

// ── MISC ──────────────────────────────────────────────────────
router.get('/records', authMiddleware, async (req, res) => {
  try {
    const rows = await complianceService.listRecords(req.query);
    res.json({ success:true, records:rows, rows, fy_options:FY_OPTIONS(), status_options:STATUS_OPTIONS });
  } catch (err) { routeError(res, err, '[compliance records legacy]'); }
});

router.get('/activity-log', authMiddleware, async (req, res) => {
  try {
    const r = await db.query(`SELECT * FROM compliance_activity_log ORDER BY log_at DESC LIMIT 200`);
    res.json({ success:true, logs:r.rows });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'Server error' }); }
});

module.exports = router;
