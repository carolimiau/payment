const fs = require('fs');
const path = require('path');

function patchTsConfig(filePath, declarationPath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return false;
  }

  json.files = [declarationPath];
  if (json.include) {
    delete json.include;
  }

  try {
    fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function main() {
  const sdkRoot = path.join(process.cwd(), 'node_modules', 'transbank-sdk');
  const declarationPath = './dist/es5/index.d.ts';

  const targets = [
    path.join(sdkRoot, 'tsconfig.json'),
    path.join(sdkRoot, 'tsconfig.es5.json'),
  ];

  const results = targets.map((target) => patchTsConfig(target, declarationPath));

  if (results.some(Boolean)) {
    console.log('✅ transbank-sdk tsconfig patched successfully');
  } else {
    console.log('ℹ️ transbank-sdk not patched (file missing or already processed)');
  }
}

main();
