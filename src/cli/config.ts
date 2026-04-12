import { loadConfig } from "../config/index.js";

export interface ConfigOptions {
  configFile?: string;
  cwd?: string;
}

export async function configCommand(options: ConfigOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const config = await loadConfig(cwd, options.configFile);
  process.stdout.write(JSON.stringify(config, null, 2) + "\n");
}
