import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function composeUp(cwd: string): Promise<void> {
  await execFileAsync("docker", ["compose", "up", "-d", "--build", "--wait"], { cwd, timeout: 300_000 });
}

export async function composeDown(cwd: string): Promise<void> {
  await execFileAsync("docker", ["compose", "down", "-v"], { cwd, timeout: 60_000 });
}

export async function composeExec(cwd: string, service: string, command: string[]): Promise<string> {
  const result = await execFileAsync("docker", ["compose", "exec", "-T", service, ...command], { cwd, timeout: 60_000 });
  return result.stdout;
}
