export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

export async function createPullRequest(args: {
  remote: string;
  token: string;
  head: string;
  base: string;
  title: string;
  body: string;
}): Promise<string> {
  const gh = parseGithubRemote(args.remote);
  if (!gh) throw new Error(`Pull requests are supported for GitHub remotes only (origin is ${args.remote}).`);
  const res = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: args.title, head: args.head, base: args.base, body: args.body }),
  });
  const json = (await res.json().catch(() => ({}))) as { html_url?: string; message?: string; errors?: unknown };
  if (!res.ok || !json.html_url) {
    throw new Error(`GitHub refused to open the pull request (${res.status}): ${json.message ?? ''} ${json.errors ? JSON.stringify(json.errors) : ''}`.trim());
  }
  return json.html_url;
}
