import { execFile, spawn } from "node:child_process";
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

/**
 * Write a string to a file inside a docker compose container using stdin piping.
 */
export async function writeFileToContainer(
  cwd: string,
  service: string,
  targetPath: string,
  content: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "docker",
      ["compose", "exec", "-T", service, "bash", "-c", `cat > ${targetPath}`],
      { cwd }
    );
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`writeFileToContainer exited ${code}`));
    });
    proc.stdin.write(content);
    proc.stdin.end();
  });
}
