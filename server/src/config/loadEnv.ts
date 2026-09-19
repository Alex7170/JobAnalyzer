import { config } from "dotenv";
import { fileURLToPath } from "node:url";

// Project root, resolved relative to this file (src/loadEnv.ts).
const ROOT = new URL("../../", import.meta.url);

// Same variable name docker-compose uses to pick a profile, so local
// runs and `docker compose run` behave the same way:
//   ENV_FILE=.env.frontend-jobs npm run scrape
const PROFILE_FILE = process.env.ENV_FILE ?? ".env.default";

// Load the rarely-changed secrets first...
config({ path: fileURLToPath(new URL(".env.secrets", ROOT)) });

// ...then the profile file, letting it override secrets for any key that
// happens to appear in both (mirrors docker-compose: later env_file wins).
config({
  path: fileURLToPath(new URL(PROFILE_FILE, ROOT)),
  override: true,
});
