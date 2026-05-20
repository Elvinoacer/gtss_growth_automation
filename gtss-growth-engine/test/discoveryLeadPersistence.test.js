const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "gtss-discovery-persistence-"),
);
process.env.DB_PATH = path.join(tempDir, "discovery.sqlite");

const discoveryService = require("../src/services/discoveryService");
const { getDb } = require("../src/db/database");

function cleanup() {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

test("Instagram lead persistence keeps ig_* fields through mapping and insert", () => {
  const db = getDb();
  const rawLead = {
    platform: "instagram",
    username: "  @Correct_Instagram  ",
    display_name: "Correct Instagram",
    bio: "Founder at GTSS",
    follower_count: 1234,
    following_count: 321,
    post_count: 45,
    is_business: true,
    business_category: "Marketing",
    email: "hello@gtss.co",
    phone: "+254700000000",
    website: "https://gtss.co",
    profile_url: "",
  };

  const mappedLead = discoveryService.__private.mapInstagramLead(
    rawLead,
    "#gtss",
  );
  const duplicateLead = { ...mappedLead };
  const linkedInLead = {
    platform: "linkedin",
    name: "LinkedIn Prospect",
    role: "Founder",
    company: "GTSS",
    location: "Nairobi",
    profile_url: "https://www.linkedin.com/in/linkedin-prospect",
    website: "https://gtss.co",
    source_keyword: "gtss",
  };

  const result = discoveryService.__private.insertLeads([
    mappedLead,
    duplicateLead,
    linkedInLead,
  ]);

  assert.equal(result.total, 3);
  assert.equal(result.new, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.invalid, 0);

  const instagramRow = db
    .prepare(
      "SELECT * FROM leads WHERE platform = 'instagram' ORDER BY id DESC LIMIT 1",
    )
    .get();

  assert.ok(instagramRow);
  assert.equal(instagramRow.ig_username, "correct_instagram");
  assert.equal(instagramRow.ig_follower_count, 1234);
  assert.equal(instagramRow.ig_following_count, 321);
  assert.equal(instagramRow.ig_post_count, 45);
  assert.equal(instagramRow.ig_is_business, 1);
  assert.equal(instagramRow.ig_business_category, "Marketing");
  assert.equal(instagramRow.ig_has_email, 1);
  assert.equal(instagramRow.ig_has_phone, 1);
  assert.equal(instagramRow.ig_bio, "Founder at GTSS");

  const linkedInRow = db
    .prepare(
      "SELECT * FROM leads WHERE platform = 'linkedin' ORDER BY id DESC LIMIT 1",
    )
    .get();

  assert.ok(linkedInRow);
  assert.equal(linkedInRow.name, "LinkedIn Prospect");
  assert.equal(
    linkedInRow.profile_url,
    "https://www.linkedin.com/in/linkedin-prospect",
  );
  assert.equal(linkedInRow.ig_username, null);

  const campaignResult = db
    .prepare("INSERT INTO campaigns (name, platform, status) VALUES (?, ?, ?)")
    .run("Instagram queue trace", "instagram", "active");
  const campaignId = campaignResult.lastInsertRowid;

  db.prepare(
    "INSERT INTO connection_jobs (campaign_id, lead_id, status) VALUES (?, ?, ?)",
  ).run(campaignId, instagramRow.id, "pending");
  db.prepare(
    "INSERT INTO dm_jobs (campaign_id, lead_id, status) VALUES (?, ?, ?)",
  ).run(campaignId, instagramRow.id, "pending");

  const connectionQueueRow = db
    .prepare(
      `
    SELECT l.ig_username, l.profile_url
    FROM connection_jobs cj
    JOIN campaigns c ON cj.campaign_id = c.id
    JOIN leads l ON cj.lead_id = l.id
    WHERE cj.campaign_id = ? AND c.status = 'active'
  `,
    )
    .get(campaignId);

  const dmQueueRow = db
    .prepare(
      `
    SELECT l.ig_username, l.profile_url
    FROM dm_jobs dj
    JOIN campaigns c ON dj.campaign_id = c.id
    JOIN leads l ON dj.lead_id = l.id
    WHERE dj.campaign_id = ? AND c.status = 'active'
  `,
    )
    .get(campaignId);

  assert.equal(connectionQueueRow.ig_username, "correct_instagram");
  assert.equal(dmQueueRow.ig_username, "correct_instagram");
  assert.equal(connectionQueueRow.profile_url, instagramRow.profile_url);
  assert.equal(dmQueueRow.profile_url, instagramRow.profile_url);
});

test.after(() => {
  cleanup();
});
