// Resolves (creating if needed) the Drive subfolder for one client/agent,
// nested inside the organisation's root Drive folder. Every upload feature
// (Update Log attachments, Client Documents, Document Collection) shares
// this, so a client/agent's files always land in the same place instead of
// one flat folder holding every party's files mixed together — and the
// organisation never needs extra storage of its own, since everything
// stays inside their own connected Google Drive account.
//
// The mapping is stored in our own database (party_drive_folders) rather
// than found by searching Drive by name each time — a client's display
// name can change later, which would silently create a second folder if we
// relied on name matching instead.
const db = require('../db');
const googleDrive = require('./googleDriveService');

async function getOrCreateClientFolder({ organizationId, accessToken, rootFolderId, partyType, partyId }) {
  const existing = await db.query(
    `SELECT folder_id FROM party_drive_folders WHERE organization_id=$1 AND party_type=$2 AND party_id=$3`,
    [organizationId, partyType, partyId]
  );
  if (existing.rows.length) return existing.rows[0].folder_id;

  const nameRes = partyType === 'client'
    ? await db.query(`SELECT legal_name, business_name FROM clients WHERE client_id=$1`, [partyId])
    : await db.query(`SELECT name FROM agents WHERE agent_id=$1`, [partyId]);
  const displayName = partyType === 'client'
    ? (nameRes.rows[0]?.legal_name || nameRes.rows[0]?.business_name || partyId)
    : (nameRes.rows[0]?.name || partyId);
  const folderName = `${partyId} - ${displayName}`.slice(0, 150);

  const folderId = await googleDrive.createFolder(accessToken, folderName, rootFolderId);
  await db.query(
    `INSERT INTO party_drive_folders (organization_id, party_type, party_id, folder_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (organization_id, party_type, party_id) DO UPDATE SET folder_id=EXCLUDED.folder_id`,
    [organizationId, partyType, partyId, folderId]
  );
  return folderId;
}

module.exports = { getOrCreateClientFolder };
