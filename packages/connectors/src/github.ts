// Minimal GitHub REST client for Crash Triage (read files) and the executor (open fix PRs).
import { httpJson, missingEnv, notConfigured, type Connector, type ConnectorContext } from "./types";

export class GitHub {
  constructor(private token: string, private repo: string) {}
  private h() {
    return { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  }
  private url(p: string) {
    return `https://api.github.com/repos/${this.repo}${p}`;
  }
  async defaultBranch(): Promise<string> {
    return (await httpJson<{ default_branch: string }>(this.url(""), { headers: this.h() })).default_branch;
  }
  async getFile(path: string, ref?: string): Promise<{ content: string; sha: string } | null> {
    try {
      const r = await httpJson<{ content: string; sha: string }>(this.url(`/contents/${encodeURI(path)}${ref ? `?ref=${ref}` : ""}`), { headers: this.h() });
      return { content: Buffer.from(r.content, "base64").toString("utf8"), sha: r.sha };
    } catch {
      return null;
    }
  }
  async createBranch(name: string, from: string) {
    const ref = await httpJson<{ object: { sha: string } }>(this.url(`/git/ref/heads/${from}`), { headers: this.h() });
    await httpJson(this.url("/git/refs"), { method: "POST", headers: this.h(), body: JSON.stringify({ ref: `refs/heads/${name}`, sha: ref.object.sha }) });
  }
  async putFile(path: string, content: string, branch: string, message: string) {
    const cur = await this.getFile(path, branch);
    await httpJson(this.url(`/contents/${encodeURI(path)}`), {
      method: "PUT", headers: this.h(),
      body: JSON.stringify({ message, branch, content: Buffer.from(content).toString("base64"), sha: cur?.sha }),
    });
  }
  async openPr(head: string, base: string, title: string, body: string): Promise<{ number: number; html_url: string }> {
    return httpJson(this.url("/pulls"), { method: "POST", headers: this.h(), body: JSON.stringify({ head, base, title, body, draft: true }) });
  }
}

export const githubFromEnv = (env: ConnectorContext["env"]) =>
  env.GITHUB_TOKEN && env.APP_REPO ? new GitHub(env.GITHUB_TOKEN, env.APP_REPO) : null;

export function githubConnector(ctx: ConnectorContext): Connector {
  const req = ["GITHUB_TOKEN", "APP_REPO"];
  return {
    id: "github", label: "GitHub (app repo)", requiredEnv: req, implemented: true,
    async test() {
      const miss = missingEnv(ctx.env, req);
      if (miss.length) return notConfigured(miss);
      await githubFromEnv(ctx.env)!.defaultBranch();
      return { status: "connected" };
    },
    async sync() {},
  };
}
