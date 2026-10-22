# notion-mcp-windows

A least-privilege MCP server that lets Notion AI work on your own Windows PC — through a dedicated low-privilege account, an explicit folder allowlist enforced by Windows ACLs, token authentication, and an audit log.

> **Read the security model before you expose anything.** This server executes commands. Its safety does not come from the code being clever; it comes from the Windows account it runs as being able to touch almost nothing. If you run it as your own admin account, you have built a remote shell into your PC, not this project.

## Before you start — requirements and honest disclaimers

- **Windows only.** Windows 10/11, full stop. There is no macOS or Linux version and none is planned: the permission model is built on Windows user accounts and ACLs, and `run_command` is PowerShell. (See Limitations.)
- **You need the paid Notion tier that includes custom MCP connections.** At the time of writing (October 2026), [Notion's own help](https://www.notion.com/help/mcp-connections-for-custom-agents) states that MCP connections are available on **Business and Enterprise plans only**, and you need Notion AI / Agents on top of that. On a Free or Plus plan the option to add a connection like this one simply does not appear — check your plan page before you invest time here, because plan details change.
- **You need working network access to Notion and Tailscale.** Both are cloud services, and the AI side of this bridge lives on their servers, not on your PC. Service availability and connection quality vary by region: depending on where you are, reaching Notion or Tailscale reliably may require additional network tooling (for example a VPN). Arrange that yourself, and follow the laws and regulations that apply to you — this project cannot and does not provide it.
- **You also need** a Tailscale account and Node.js 18+ (details in Quick start).
- **Not affiliated, use at your own risk.** This is a personal project, not affiliated with or endorsed by Notion Labs or Tailscale. It lets a cloud AI run commands on your computer; if that sentence makes you uneasy, read the whole security model — and the section on expanding access — before deciding it is for you.

## Why this exists

Hosted AIs like Notion AI run in the cloud. They have their own computers, but those computers cannot reach yours: your PC sits behind your router on a private network, and a cloud service is a stranger to it.

MCP (Model Context Protocol) is the official way to bridge that gap: you run a small server on the machine you want the AI to work on, and the AI connects to it as an MCP client. I tried unofficial reverse-engineered integrations first — brittle, errors got swallowed, context was uncontrollable — and abandoned them in favour of this.

The interesting part is not the bridge itself (the server is ~300 lines with zero dependencies). The interesting part is doing the permissions properly, because most examples online quietly skip that step and hand the AI the keys to the whole disk.

## How it works

```
Notion AI (cloud)
    │  HTTPS, token in URL path or Bearer header
    ▼
Tailscale Funnel  ── public endpoint on your PC (see "the one lock" below)
    │
    ▼
server.mjs  ── listens on 127.0.0.1 only, Node.js, no dependencies
    │  runs as: a dedicated low-privilege Windows user (e.g. "pcagent")
    ▼
Your folders ── only the ones you explicitly granted that account.
               Everything else is denied by Windows, not by politeness.
```

The server exposes four tools:

| Tool | What it does | Notes |
|---|---|---|
| `run_command` | Run a PowerShell command as the service account | Default timeout 120 s, max 1800 s. Synchronous — the caller waits. |
| `list_dir` | List a directory | Read-only |
| `read_file` | Read a text file | Capped at 200 KB by default (`maxReadBytes`) |
| `write_file` | Write a text file (UTF-8, overwrites, creates parent folders) | Audited |

Every tool call — including reads — is appended to an audit log with a timestamp and its target path (file contents and command output are not logged).

## The security model

Five layers, in the order an attacker meets them:

1. **The endpoint is public, the token is the only lock.** A Tailscale Funnel URL is reachable from the whole internet, and its hostname can be discovered from public certificate records — do not treat "nobody knows the address" as protection. Requests without the token get a 401. The token is long and random, and comparison is timing-safe, but it is still a single factor: **if the token leaks, anyone who has it can run commands as the service account.** From there, only layer 2 saves you.
2. **A dedicated low-privilege account.** The server runs as its own standard user — not you, not an administrator. It cannot read your user profile, your browser data, or anything you did not grant it.
3. **Default-deny ACLs with an explicit allowlist.** Grant the service account access folder by folder. Anything you do not grant, it cannot read — including folders created later. Add explicit denies for the places that must stay closed even if a parent folder is granted: the server's own install folder (which holds the token), your other agents' workspaces, and anything holding keys or personal data.
4. **The server's own files get the strictest treatment you can give them — plus an honest caveat.** Never put the install folder on the allowlist, and set explicit denies on it for listing and browsing, like your other no-go folders. But be clear-eyed about the limit: the process must be able to read `token.txt` at startup, and the tools run as the same account as the process, so ACLs alone cannot fully hide that one file from a client that is deliberately pointed at its exact path. The practical defences are the other layers working together: the path is never granted or advertised to the client, every tool call (reads included) is written to the audit log, the behaviour rules forbid touching it, and you enable per-call confirmation in the client where offered. This is a known sharp edge of the design, listed again under Limitations — not a solved problem dressed up as one.
5. **Behaviour rules are the last layer, not the first.** Give the AI written instructions in its own memory (what it may touch, what needs your approval first — deletes, git commits, admin commands it must explain line by line before you run them). These rules are a gentleman's agreement — they guide an honest agent, they do not restrain a compromised one. That is what layers 2–4 are for.

What this model does **not** give you: no IP allowlist (the cloud client's addresses are not fixed), no rate limiting, no second factor. Treat the token like a password: never in screenshots, never in chat logs, never in git. If it has ever been somewhere it should not have been, rotate it (procedure below). And if you only need the connection sometimes, turn the Funnel off when you are not using it (`tailscale funnel --https=443 off`); a door that is not on the internet cannot be knocked on.

## Expanding access: what more permission buys — and what it costs

The default in this guide is deliberately small: one work folder, nothing else. Almost everyone will outgrow it — the author did within an evening — because the genuinely useful version of this setup is an AI that can see your actual documents and projects. That is fine. Expanding access is the whole point of the allowlist design. But do it as a series of conscious decisions, one folder at a time, because each grant buys capability with risk, and the exchange rate is not linear: read access is mostly a *privacy* decision, write access plus `run_command` is an *integrity* decision, and the two combined mean a misbehaving or manipulated AI can both see and change things.

Think of it in tiers:

| Tier | What you grant | What the AI can now do for you | What it costs you |
|---|---|---|---|
| **0 — Work folder only** (default) | Read/write on one dedicated folder | Draft, organise, and produce files in a sandbox you control | Almost nothing beyond that folder. This is the right starting point and the right fallback if anything feels off. |
| **1 — Read your content** | Read-only on document, coursework, notes, or reference folders | Search and summarise across your real material; answer questions grounded in your files instead of the open web | **Everything readable is content a cloud AI may process.** A read grant is not just a local permission — it is a decision to share that content with Notion's cloud. And folders hide things: the folder that looks like course materials may contain a financial dataset two levels down. Inventory before you grant. |
| **2 — Work on your projects** | Read/write on source-code and project folders | Edit documents and code in place, run builds and tests through `run_command`, do real multi-file chores | Now it can also break things: overwrite or delete work, follow a malicious instruction buried in a file (prompt injection), or run whatever scripts a project contains. Anything resembling a secret inside a project — `.env` files, keys, tokens in config — becomes readable too, unless you carve it out with an explicit deny. Version control stops being optional. |
| **3 — Broad read** | Read across most of a drive | Whole-disk "where did I put that" search | The blast radius of a leaked token is now most of your digital life: photos, ID scans, personal archives, and app/browser data folders that can contain live session tokens. The convenience is real; so is this paragraph. Most people should stop at tier 2. |
| **Admin** | Running the service as an administrator, or granting the account admin rights | Nothing you should want from an unattended cloud connection | Everything. This deletes the security model. If a specific task genuinely needs elevation, do that one task yourself — with the command explained to you line by line first (see the behaviour-rules layer above). Never bake it into the service. |

### Before you grant any folder — the confirmation checklist

Run through this for every single grant. It takes two minutes and it is the difference between this project and a cautionary tale:

1. **What is actually in here?** List the folder including subfolders and hidden items. Specifically hunt for `.env` files, key/token files, exported credentials, and anything financial, medical, or identity-related hiding under an innocent name.
2. **Is this content OK to leave my PC?** Assume anything granted read can be sent to and processed by a cloud AI. If the answer is "only most of it", carve out the rest with explicit denies *inside* the granted folder before granting.
3. **What is the worst case if the token leaked tonight?** For this folder alone: what could a stranger read, copy, change, or delete as the service account? If that answer keeps you up at night, the grant is too big.
4. **Read first, write later.** Grant read-only, use it for a few days, then upgrade to Modify only if the work actually needs it. Downgrading later is always allowed.
5. **Is it backed up or versioned?** Write grants go to folders that are in git or backed up. No exceptions for "I'll commit later".
6. **Deny the traps explicitly.** Secrets subfolders, the server's own install folder, and other agents' workspaces get explicit deny entries even when a parent folder is granted.
7. **Verify as the agent, not as yourself.** After granting, test through the MCP tools: the granted folder works, the denied subfolder fails, and one folder you did *not* grant still fails. Then glance at the audit log so you know the trail is being written.
8. **Write the grant down for the AI.** Update the AI's own instructions/memory with its new permission map and the rules for the new territory (what it may do freely, what needs your confirmation first). An agent that does not know its own boundaries will keep bumping into walls — or worse, will not notice when a wall is missing.

## Quick start

You will end up with this layout (paths are examples — yours can differ, the config file in step 4 is where you write them down):

```
C:\LocalMCP\            install folder (the service account must NOT be able to read this via the tools)
├─ server\server.mjs    this repo's server
├─ server\config.local.json   your paths (git-ignored, created in step 4)
├─ token.txt            your token (created in step 3)
└─ logs\audit.log       created automatically
D:\Work\                the folder the AI is allowed to work in (your allowlist starts here)
```

Prerequisites: everything listed in "Before you start" above — in particular a Notion plan that actually offers custom MCP connections (Business/Enterprise at the time of writing). Steps 1–3 and 5 need an administrator PowerShell; say so to yourself out loud before pasting anything — these are exactly the commands to read twice. Start at tier 0 (one work folder); expand later using the checklist in "Expanding access".

### 1. Create the service account

```powershell
net user pcagent * /add
Set-LocalUser -Name pcagent -PasswordNeverExpires $true
```

When prompted, give it a strong password and keep it somewhere safe — you will need it once for the Scheduled Task in step 7. This account is the blast radius of everything that follows.

### 2. Grant folder access (and set the denies)

Grant the account Modify on each folder it should work in:

```powershell
icacls "D:\Work" /grant "pcagent:(OI)(CI)M"
```

Then protect the install folder and any other no-go folders with an explicit deny, and re-read every ACL you changed (`icacls "D:\Work"`) instead of trusting that the command worked. Two warnings from experience: `icacls` on large folder trees can take well over 30 seconds — work folder by folder — and a trailing backslash inside quotes (`"D:\"`) breaks the parsing; write `D:\.` instead.

Final verification of this step happens in step 8, as the service account itself. Testing from your admin shell proves nothing.

### 3. Create the token

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save the output — that one line, nothing else — as `C:\LocalMCP\token.txt`. The server refuses to start without this file, never creates one itself, and refuses tokens shorter than 32 characters.

### 4. Configure

Copy `config\config.example.json` to `server\config.local.json` and edit the paths to yours:

```json
{
  "base": "C:\\LocalMCP",
  "root": "D:\\Work",
  "tokenFile": "C:\\LocalMCP\\token.txt",
  "port": 8787,
  "maxReadBytes": 204800
}
```

`config.local.json` is git-ignored. Environment variables (`MCP_ROOT`, `MCP_BASE`, `MCP_PORT`, `MCP_TOKEN_FILE`, `MCP_MAX_READ`, `MCP_CONFIG`) override it when set — you normally will not need them; they exist for debugging.

### 5. Test locally — do not skip this

```powershell
node C:\LocalMCP\server\server.mjs
```

The startup banner prints the effective config (never the token). Check that the working dir and token file paths are the ones you meant. Then, from a second PowerShell:

```powershell
# No token → must print 401
curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://127.0.0.1:8787/mcp -d "{}"

$token = (Get-Content C:\LocalMCP\token.txt -Raw).Trim()
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/mcp `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType application/json -Body $body
```

Expected: `401` from the first command, and a list of the four tools from the second. If both pass, stop the server (Ctrl+C) and continue.

### 6. Verify the identity end-to-end

Still locally, ask for a `whoami` through the tools themselves — replace `tools/list` above with:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run_command","arguments":{"command":"whoami"}}}
```

The answer must be your service account (e.g. `yourpc\pcagent`). If it answers with your own account name, stop — the process is running as you, and none of the permission layers exist yet.

### 7. Make it start at boot

Create a Scheduled Task that runs `node C:\LocalMCP\server\server.mjs` as `pcagent`, triggered *At startup* (Task Scheduler GUI is fine; there is nothing to configure beyond user, trigger, and the program path — configuration comes from `config.local.json`, so no environment variables are needed).

Classic gotcha: a standard user needs the **"Log on as a batch job"** right (`SeBatchLogonRight`, set via `secpol.msc` → Local Policies → User Rights Assignment) or the task fails to start with no useful error. If your task "ran" but nothing listens on the port, check this first, then check the token file path in the banner by running step 5 as that user.

### 8. Expose it (carefully) and connect Notion

```powershell
tailscale funnel --bg 8787
tailscale funnel status   # note the https://… hostname it prints
```

In Notion, add a custom MCP connection pointing at:

```
https://<your-funnel-hostname>/mcp/<your-token>
```

Refresh the tool list, set the tools to require your confirmation if the client offers that option (for `run_command` and `write_file` at minimum), and run the three acceptance checks in Notion itself:

1. `whoami` → the service account, again.
2. Ask it to list a granted folder → works; write a scratch file there and delete it → works.
3. Ask it to read a denied folder → must fail. Permission working as intended looks exactly like failure here. (Reading the token file is the known exception discussed in layer 4 — try it so you know which side of that line your setup is on, and check that the attempt shows up in the audit log.)

### Rotating the token

1. Generate a new token (step 3 command) and overwrite `token.txt`.
2. Restart the server (end the Scheduled Task and start it again).
3. Update the Notion connection URL — the old token stops working the moment the server restarts, so expect Notion to be disconnected until you paste the new URL.
4. Do not keep the old token anywhere "just in case". A kept old token is just a second key.

## Configuration reference

| Setting (config file) | Environment variable | Default | Meaning |
|---|---|---|---|
| `root` | `MCP_ROOT` | `server\work` | Default working directory; relative tool paths resolve against it |
| `base` | `MCP_BASE` | `server\` | Install folder: default token location lives here, `logs\` is created here |
| `tokenFile` | `MCP_TOKEN_FILE` | `<base>\token.txt` | Explicit path to the token file |
| `port` | `MCP_PORT` | `8787` | Listen port, bound to 127.0.0.1 only |
| `maxReadBytes` | `MCP_MAX_READ` | `204800` | Max bytes `read_file` will return |

Precedence: environment variable > `config.local.json` > default. `MCP_CONFIG` can point at a different config file. Invalid JSON or an invalid port stops the server at startup with the reason printed — that is deliberate.

## Troubleshooting

Work down this list in order; each step rules out one layer.

- **Server exits immediately** — the startup output says why. The usual three: token file not found at the printed path, token too short, config file JSON invalid.
- **Banner shows wrong paths** — you edited a different `config.local.json` than the server loaded. The banner prints which config file was used; believe the banner.
- **Scheduled task "runs" but nothing listens** — batch logon right (step 7), then the token path, then run step 5 manually as the service account.
- **401 in Notion right after it worked** — you rotated the token, or the URL lost its last characters when pasted. The path token and the Bearer token are the same value; either form works, but it must be complete.
- **ACL commands hang** — `icacls` is slow on big trees (see step 2). One folder per call, re-read after each.
- **Permissions "not taking effect"** — re-run the step 8 checks through the tools. An admin shell session is not evidence.
- **Notion cannot connect at all** — PC awake? Task running? Something listening on 8787 (`Get-NetTCPConnection -LocalPort 8787`)? Funnel on (`tailscale funnel status`)? URL token current?

## Limitations

- Windows only, by design: the permission model is Windows ACLs and `run_command` is PowerShell. The server will start on other platforms for protocol testing, but `run_command` refuses to run there — do not treat that as support.
- Token-only authentication, single factor — see the security model.
- `run_command` is synchronous. With a 30-minute ceiling it suits small jobs, not long builds or long agent runs.
- Relative paths resolve against `root`, absolute paths pass through. That is intentional — the account's ACLs, not path filtering in code, decide what is reachable.
- Restart recovery (task + Funnel + service all coming back after a reboot) works in my setup but deserves a deliberate reboot test on yours.
- No rate limiting and no request logging beyond the audit log and a one-line console entry per request. Do not put this behind anything other than the Funnel/token arrangement described here.
- Token custody has the sharp edge described in layer 4: the service account must be able to read `token.txt` at startup, and the tools run as that account. Audit, confirmations, behaviour rules, and rotation are mitigations, not a fix. A future version could move the token into a separate broker process running as a different account.

## Roadmap

- [ ] Helper scripts for account creation, folder grants/denies, and task installation (currently the manual steps above)
- [ ] A token rotation helper that also reminds you to update the Notion URL
- [ ] Let Notion delegate longer jobs to a local coding agent (e.g. Codex) installed separately under the service account — designed, not yet implemented
- [ ] A generic, fill-in-the-blanks version of the AI behaviour-rules template (the "agent instructions" layer described above)

## A note on the code

This is a sanitized rewrite of the server I actually run. The tools, protocol handling, and fail-closed token check match the original; what changed is packaging and two small hardenings: no hard-coded paths or machine names, configuration moved to a local config file (with environment-variable overrides), a minimum token length check, a startup banner that prints the effective configuration, and audit logging extended to read operations (the original audited only commands and writes). If you spot a divergence that matters, open an issue.

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — see the `LICENSE` file.

In plain terms: you may use, copy, modify, and share it for **personal and other noncommercial purposes**. Commercial use is **not** permitted. If you want to use it commercially, ask first — via a GitHub issue on this repository (that is the only contact channel; no email is published).

Note that this is a source-available license, not an OSI-approved "open source" license — that is deliberate. Copyright 2026 Ethan.
