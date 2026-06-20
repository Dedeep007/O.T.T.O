import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import JavaScriptObfuscator from 'javascript-obfuscator';
import bytenode from 'bytenode';

const distDir = path.join(process.cwd(), 'dist');
const buildDir = path.join(process.cwd(), 'build');

if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir);
}

console.log('Compiling TypeScript...');
execSync('npx tsc', { stdio: 'inherit' });

console.log('Obfuscating output...');
// Note: In a real project you'd traverse dist/ recursively. For MVP, just bundle using tsup or esbuild first.
// It's much easier to obfuscate a bundled file. Let's build a bundle first using tsup.

console.log('Bundling with tsup...');
execSync('npx tsup src/index.tsx --format cjs --no-external --external better-sqlite3 --external sqlite-vec --external serialport --out-dir dist-bundle', { stdio: 'inherit' });

const bundledFile = path.join(process.cwd(), 'dist-bundle', 'index.cjs');
if (fs.existsSync(bundledFile)) {
  const code = fs.readFileSync(bundledFile, 'utf-8');
  
  const obfuscationResult = JavaScriptObfuscator.obfuscate(code, {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 1,
      numbersToExpressions: true,
      simplify: true,
      stringArrayShuffle: true,
      splitStrings: true,
      stringArrayThreshold: 1
  });

  const obfuscatedCode = obfuscationResult.getObfuscatedCode();
  const obfuscatedFile = path.join(buildDir, 'index.obf.js');
  fs.writeFileSync(obfuscatedFile, obfuscatedCode);

  console.log('Compiling to V8 Bytecode...');
  const jscFile = path.join(buildDir, 'index.jsc');
  bytenode.compileFile({
    filename: obfuscatedFile,
    output: jscFile
  });
  
  // Create a loader file for the bytecode
  const loaderContent = `require('bytenode');\nrequire('./index.jsc');`;
  fs.writeFileSync(path.join(buildDir, 'loader.js'), loaderContent);
  
  console.log('To run SEA packaging:');
  console.log('1. node --experimental-sea-config sea-config.json');
  console.log('2. cp $(command -v node) build/otto.exe');
  console.log('3. npx postject build/otto.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');

  console.log('Build completed!');
} else {
  console.error('Bundled file not found!');
}
