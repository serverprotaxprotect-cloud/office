const express = require('express');
const authMiddleware = require('../middleware/auth');
const mca = require('../services/mcaService');

const router = express.Router();

function routeError(res, err, label) {
  console.error(label, err);
  res.status(err.statusCode || 500).json({ success: false, message: err.statusCode ? err.message : 'Server error' });
}

function safeName(value) {
  return String(value || 'document').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'document';
}

router.get('/meta', authMiddleware, async (req, res) => {
  res.json({ success: true, doc_types: Object.entries(mca.DOCS).map(([key, doc]) => ({ key, label: doc.label })) });
});

router.get('/companies', authMiddleware, async (req, res) => {
  try {
    const companies = await mca.listCompanies(req.query);
    res.json({ success: true, companies });
  } catch (err) { routeError(res, err, '[mca companies]'); }
});

router.get('/companies/:cin', authMiddleware, async (req, res) => {
  try {
    const company = await mca.getCompany(req.params.cin);
    res.json({ success: true, company });
  } catch (err) { routeError(res, err, '[mca company]'); }
});

router.put('/companies/:cin/settings', authMiddleware, async (req, res) => {
  try {
    const settings = await mca.saveSettings(req.params.cin, req.body, req.user);
    res.json({ success: true, message: 'MCA report settings saved', settings });
  } catch (err) { routeError(res, err, '[mca settings]'); }
});

router.get('/companies/:cin/auditors', authMiddleware, async (req, res) => {
  try {
    const auditors = await mca.getAuditors(req.params.cin);
    res.json({ success: true, auditors });
  } catch (err) { routeError(res, err, '[mca auditors]'); }
});

router.put('/companies/:cin/auditors', authMiddleware, async (req, res) => {
  try {
    const auditors = await mca.saveAuditors(req.params.cin, req.body, req.user);
    res.json({ success: true, message: 'Auditor details saved', auditors });
  } catch (err) { routeError(res, err, '[mca auditors save]'); }
});

router.get('/firm-auditors', authMiddleware, async (req, res) => {
  try {
    const auditors = await mca.listFirmAuditors();
    res.json({ success: true, auditors });
  } catch (err) { routeError(res, err, '[mca firm auditors]'); }
});

router.post('/firm-auditors', authMiddleware, async (req, res) => {
  try {
    const auditor = await mca.createFirmAuditor(req.body, req.user);
    res.json({ success: true, message: 'Firm auditor saved', auditor });
  } catch (err) { routeError(res, err, '[mca firm auditor create]'); }
});

router.put('/firm-auditors/:id', authMiddleware, async (req, res) => {
  try {
    const auditor = await mca.updateFirmAuditor(parseInt(req.params.id, 10), req.body, req.user);
    res.json({ success: true, message: 'Firm auditor updated', auditor });
  } catch (err) { routeError(res, err, '[mca firm auditor update]'); }
});

router.delete('/firm-auditors/:id', authMiddleware, async (req, res) => {
  try {
    await mca.deleteFirmAuditor(parseInt(req.params.id, 10));
    res.json({ success: true, message: 'Firm auditor deleted' });
  } catch (err) { routeError(res, err, '[mca firm auditor delete]'); }
});

router.post('/generate/html', authMiddleware, async (req, res) => {
  try {
    const { cin, docType } = req.body;
    if (!cin || !docType) return res.status(400).json({ success: false, message: 'CIN and document type required' });
    const result = await mca.generateHtml(cin, docType);
    res.json({ success: true, html: result.html, doc: result.doc, company_name: result.company.companyName });
  } catch (err) { routeError(res, err, '[mca html]'); }
});

router.post('/generate/docx', authMiddleware, async (req, res) => {
  try {
    const { cin, docType } = req.body;
    if (!cin || !docType) return res.status(400).json({ success: false, message: 'CIN and document type required' });
    const result = await mca.generateDocx(cin, docType);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName(docType)}_${safeName(result.company.companyName)}.docx"`);
    res.send(result.buffer);
  } catch (err) { routeError(res, err, '[mca docx]'); }
});

router.post('/generate/excel', authMiddleware, async (req, res) => {
  try {
    const { cin, docType } = req.body;
    if (!cin || !docType) return res.status(400).json({ success: false, message: 'CIN and document type required' });
    const result = await mca.generateExcel(cin, docType);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName(docType)}_${safeName(result.company.companyName)}.xlsx"`);
    res.send(result.buffer);
  } catch (err) { routeError(res, err, '[mca excel]'); }
});

module.exports = router;
