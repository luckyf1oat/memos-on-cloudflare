// @ts-check
// Setup script: automatically create D1/R2 resources and update wrangler.toml
// Run in GitHub Actions or locally with: node scripts/setup-cloudflare-resources.mjs

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WRANGLER_TOML_PATH = join(ROOT, "wrangler.toml");

/**
 * @param {string} args
 * @returns {string}
 */
function wrangler(args) {
  const cmd = `npx wrangler ${args}`;
  console.log(`> ${cmd}`);
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "inherit"] });
}

/**
 * @param {string} args
 * @returns {any}
 */
function wranglerJSON(args) {
  const output = wrangler(`${args} --json`);
  return JSON.parse(output);
}

/** Generate a cryptographically strong random JWT secret (64 hex chars = 256 bits) */
function generateJwtSecret() {
  return randomBytes(32).toString("hex");
}

// ─── 1. D1 Database ───────────────────────────────────────────────
async function ensureD1Database() {
  // Check if D1 database already exists
  let d1List;
  try {
    d1List = wranglerJSON("d1 list");
  } catch {
    d1List = [];
  }

  const dbs = Array.isArray(d1List) ? d1List : (d1List.result || []);
  const existing = dbs.find(
    /** @param {any} db */ (db) => db.name === "cfmemos-db"
  );

  let databaseId;
  if (existing) {
    databaseId = existing.uuid;
    console.log(`✓ D1 database "cfmemos-db" already exists (${databaseId})`);
  } else {
    console.log('Creating D1 database "cfmemos-db"...');
    const result = wranglerJSON("d1 create cfmemos-db");
    databaseId = result.uuid || result.database_id;
    console.log(`✓ Created D1 database "cfmemos-db" (${databaseId})`);
  }

  // Update wrangler.toml with the database_id
  let toml = readFileSync(WRANGLER_TOML_PATH, "utf-8");
  toml = toml.replace(
    /database_id\s*=\s*"[^"]*"/,
    `database_id = "${databaseId}"`
  );
  writeFileSync(WRANGLER_TOML_PATH, toml, "utf-8");
  console.log("✓ Updated wrangler.toml with D1 database_id");
}

// ─── 2. R2 Bucket ─────────────────────────────────────────────────
async function ensureR2Bucket() {
  let r2List;
  try {
    r2List = wranglerJSON("r2 bucket list");
  } catch {
    r2List = { buckets: [] };
  }

  const buckets = r2List.buckets || [];
  const existing = buckets.find(/** @param {any} b */ (b) => b.name === "cfmemos");

  if (existing) {
    console.log(`✓ R2 bucket "cfmemos" already exists`);
  } else {
    console.log('Creating R2 bucket "cfmemos"...');
    wrangler("r2 bucket create cfmemos");
    console.log('✓ Created R2 bucket "cfmemos"');
  }
  // R2 uses bucket_name in wrangler.toml, no ID needed — already configured
}

// ─── 3. JWT Secret ────────────────────────────────────────────────
async function ensureJwtSecret() {
  // Check if JWT_SECRET is already set as a Worker secret
  let secretsList;
  try {
    secretsList = wranglerJSON("secret list");
  } catch {
    secretsList = [];
  }

  const secrets = Array.isArray(secretsList) ? secretsList : [];
  const hasJwtSecret = secrets.some(
    (s) => (s.name || s) === "JWT_SECRET"
  );

  if (hasJwtSecret) {
    console.log('✓ JWT_SECRET already set');
  } else {
    const secret = generateJwtSecret();
    console.log("Setting JWT_SECRET...");
    // wrangler secret put requires stdin piping
    execSync(`echo ${secret}`, {
      input: secret,
      stdio: ["pipe", "pipe", "inherit"],
    });
    // fallback: use a temp file approach
    try {
      execSync(`npx wrangler secret put JWT_SECRET`, {
        input: secret + "\n",
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "inherit"],
      });
    } catch {
      // If interactive prompt fails, write to temp file and use bulk
      const tmpPath = join(ROOT, ".secrets-tmp.json");
      writeFileSync(tmpPath, JSON.stringify([{
        name: "JWT_SECRET",
        text: secret,
        type: "secret_text"
      }]));
      wrangler(`secret bulk ${tmpPath}`);
      // Don't delete the temp file to avoid issues
    }
    console.log("✓ JWT_SECRET set (save this securely if needed for recovery)");
    console.log(`  JWT_SECRET = ${secret}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log("=== Setting up Cloudflare resources for cfmemos ===\n");

  // Verify authentication
  try {
    const whoami = wrangler("whoami");
    console.log(`Authenticated as: ${whoami.trim()}\n`);
  } catch {
    console.error(
      "❌ Not authenticated with Cloudflare. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID env vars."
    );
    process.exit(1);
  }

  await ensureD1Database();
  await ensureR2Bucket();
  await ensureJwtSecret();

  console.log("\n=== All resources ready! ===");
}

main().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});