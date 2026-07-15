import { execFile } from "node:child_process";
import { promisify } from "node:util";

interface PackResult {
  id: string;
  files: Array<{ path: string }>;
}

const exec = promisify(execFile);
const workspaces = [
  "@loyalty-interchange/protocol",
  "@loyalty-interchange/reference",
  "@loyalty-interchange/storage",
  "@loyalty-interchange/storage-sqlite",
  "@loyalty-interchange/server",
  "@loyalty-interchange/cli",
  "@loyalty-interchange/sdk"
];

for (const workspace of workspaces) {
  const { stdout } = await exec("npm", [
    "pack",
    "--dry-run",
    "--workspace",
    workspace,
    "--json",
    "--ignore-scripts"
  ]);
  const result = (JSON.parse(stdout) as PackResult[])[0];
  if (!result) throw new Error(`npm pack returned no result for ${workspace}`);
  const files = result.files.map((file) => file.path);
  for (const required of ["package.json", "dist/index.js", "dist/index.d.ts"]) {
    if (!files.includes(required)) {
      throw new Error(`${result.id} package is missing ${required}`);
    }
  }
  if (files.some((path) => path.endsWith(".tsbuildinfo"))) {
    throw new Error(`${result.id} package contains TypeScript build metadata`);
  }
  console.log(`${result.id}: ${files.length} files`);
}
