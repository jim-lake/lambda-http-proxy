import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'package.json');

// Bump the trailing integer of package.json's version, but only when
// `BUILD_BUMP` is set — `npm run build` sets it; `build:bundle` (used by the
// test scripts) does not, so running the suite against the bundle never churns
// the version. Returns the version the build should use (the new one when
// bumped, else the current one).
export function incrementBuildNumber() {
  const file_json = fs.readFileSync(FILE, { encoding: 'utf8' });
  const file_object = JSON.parse(file_json);
  const old_version = file_object.version;

  if (!process.env.BUILD_BUMP) {
    return old_version;
  }

  const new_version = old_version.replace(/\d+$/, (d) =>
    String(parseInt(d) + 1)
  );
  const new_json = file_json.replace(
    `"version": "${old_version}"`,
    `"version": "${new_version}"`
  );
  fs.writeFileSync(FILE, new_json);
  console.log('📤 Build Updated:', new_version);
  return new_version;
}
