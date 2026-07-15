import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface LipConfig {
  base_url: string;
  api_key_env: string;
  profile: "foodservice/1.0";
  program_id: string;
}

export const defaultConfig: LipConfig = {
  base_url: "http://127.0.0.1:3210",
  api_key_env: "LIP_API_KEY",
  profile: "foodservice/1.0",
  program_id: "demo-foodservice"
};

export async function readConfig(directory = process.cwd()): Promise<LipConfig | undefined> {
  try {
    const contents = await readFile(resolve(directory, "lip.config.json"), "utf8");
    const parsed = JSON.parse(contents) as Partial<LipConfig>;
    return { ...defaultConfig, ...parsed };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function initializeConfig(
  directory: string,
  options: { force?: boolean } = {}
): Promise<string> {
  const targetDirectory = resolve(directory);
  const target = resolve(targetDirectory, "lip.config.json");
  await mkdir(targetDirectory, { recursive: true });

  if (!options.force) {
    try {
      await readFile(target, "utf8");
      throw new Error(`Refusing to overwrite ${target}; pass --force to replace it`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  await writeFile(target, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
  return target;
}
