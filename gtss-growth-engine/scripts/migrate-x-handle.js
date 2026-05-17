const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// 1. Resolve DB path and connect
const dbPath = path.resolve(process.env.DB_PATH || "./data/gtss.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

console.log(`[MIGRATION] Connecting to database at: ${dbPath}`);
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// 2. Validate table presence
const table = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'leads'")
  .get();

if (!table) {
  console.error("[ERROR] The 'leads' table does not exist. Initialize the application first to apply database schemas.");
  db.close();
  process.exit(1);
}

// 3. Ensure x_handle column exists
const columns = new Set(
  db.pragma("table_info(leads)").map((column) => column.name)
);

if (!columns.has("x_handle")) {
  console.log("[MIGRATION] Adding x_handle column to leads table...");
  db.exec("ALTER TABLE leads ADD COLUMN x_handle TEXT");
  console.log("[MIGRATION] Successfully added leads.x_handle column.");
} else {
  console.log("[MIGRATION] Column leads.x_handle already exists.");
}

// 4. Extract handles from profile_url and backfill in a safe transaction
function extractXHandle(url) {
  if (!url) return null;
  const match = url.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([a-zA-Z0-9_]{1,15})(?:\/|\?|$)/i);
  return match ? match[1] : null;
}

const XLeads = db
  .prepare(`
    SELECT id, profile_url, x_handle 
    FROM leads 
    WHERE platform = 'x' OR profile_url LIKE '%x.com%' OR profile_url LIKE '%twitter.com%'
  `)
  .all();

console.log(`[MIGRATION] Found ${XLeads.length} leads with potential X profiles to backfill.`);

let updatedCount = 0;
let skippedCount = 0;
let failedCount = 0;

const backfillTransaction = db.transaction((leadsList) => {
  const updateStmt = db.prepare("UPDATE leads SET x_handle = ? WHERE id = ?");
  
  for (const lead of leadsList) {
    const handle = extractXHandle(lead.profile_url);
    if (handle) {
      if (lead.x_handle === handle) {
        skippedCount++; // Already up to date
      } else {
        updateStmt.run(handle, lead.id);
        updatedCount++;
      }
    } else {
      failedCount++;
      console.warn(`[WARN] Could not parse a valid X handle from profile URL: "${lead.profile_url}" (Lead ID: ${lead.id})`);
    }
  }
});

try {
  backfillTransaction(XLeads);
  console.log("\n[MIGRATION] Migration and backfill transaction completed successfully!");
  console.log(`----------------------------------------------------------------`);
  console.log(`- Successfully updated/backfilled: ${updatedCount} leads`);
  console.log(`- Skipped (already backfilled or matching): ${skippedCount} leads`);
  console.log(`- Failed to parse (invalid/missing handle): ${failedCount} leads`);
  console.log(`----------------------------------------------------------------`);
} catch (err) {
  console.error("[ERROR] Migration backfill transaction failed and was rolled back:", err);
  db.close();
  process.exit(1);
}

db.close();
console.log("[MIGRATION] Database connection closed.");
process.exit(0);
