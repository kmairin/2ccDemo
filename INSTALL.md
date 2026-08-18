# INSTALL.md — first-boot setup

Read this **before writing any code** in a fresh clone. It gets the toolchain and
dependencies onto whatever machine you are on. If you are an AI agent, follow it
top to bottom, then continue from [AGENTS.md](AGENTS.md).

Delete this file once setup is done and committed — its job is finished, and a
stale install guide is worse than none.

## 0. Work out where you are first

Do not guess the operating system. Detect it, then follow **only** the matching
section:

```bash
uname -s     # Darwin = macOS, Linux = Linux (incl. WSL), MINGW*/MSYS* = Git Bash on Windows
```

If `uname` does not exist, you are on Windows PowerShell or cmd — use §3.

## 1. macOS

```bash
node --version    # need v22 or newer
```

If it is missing or older than v22:

```bash
# Homebrew is the usual route. If `brew` is missing, install it from https://brew.sh first.
brew install node@22
brew link --overwrite --force node@22
```

You also need **Postgres**, the database this project uses, and **Git LFS**, for
the large files in `design/assets/`:

```bash
brew install postgresql@16 git-lfs
brew services start postgresql@16
createdb loop_dev
git lfs install
```

Then jump to §4.

## 2. Linux (including WSL)

```bash
node --version    # need v22 or newer
```

If it is missing or older than v22, prefer a version manager over the distro
package — distro Node is usually years behind:

```bash
# nvm: works the same on every distro, no sudo needed
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
nvm install 22 && nvm use 22
```

You also need **Postgres**:

```bash
# Debian / Ubuntu / WSL
sudo apt update && sudo apt install -y postgresql
sudo service postgresql start

# Fedora / RHEL:  sudo dnf install -y postgresql-server && sudo postgresql-setup --initdb
# Arch:           sudo pacman -S postgresql

# Give the `postgres` user the password wrangler.toml expects, then create the DB
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
sudo -u postgres createdb loop_dev
```

And **Git LFS**, for the large files in `design/assets/`:

```bash
# Debian / Ubuntu / WSL
sudo apt install -y git-lfs

# Fedora / RHEL:  sudo dnf install -y git-lfs
# Arch:           sudo pacman -S git-lfs

git lfs install
```

Then jump to §4.

## 3. Windows

Use **PowerShell**. Two options, in order of preference:

```powershell
node --version    # need v22 or newer

# Option A — winget (built into Windows 11 / recent 10)
winget install OpenJS.NodeJS.LTS

# Option B — if winget is unavailable, download the LTS MSI from https://nodejs.org
```

You also need **Postgres**:

```powershell
winget install PostgreSQL.PostgreSQL.16
```

The installer asks for a password for the `postgres` user — enter `postgres`, so
it matches the `DATABASE_URL` already in `wrangler.toml`. If you choose a
different password, update that line to match. Then create the database:

```powershell
& "C:\Program Files\PostgreSQL\16\bin\createdb.exe" -U postgres loop_dev
```

And **Git LFS**, for the large files in `design/assets/`:

```powershell
winget install GitHub.GitLFS
git lfs install
```

Close and reopen the terminal after installing so `PATH` picks up `node`.

> **Strong recommendation:** develop inside **WSL2** instead, and follow §2. The
> toolchain (`wrangler`, its esbuild binary, file watching) is better tested on
> Unix, and paths behave predictably. If you hit odd native-module or path errors
> on native Windows, moving to WSL is usually faster than debugging them.

## 4. Project dependencies — every OS

From the repository root:

```bash
npm install
```

That installs `hono`, `drizzle-orm`, `postgres`, `wrangler`, `typescript` and
`vitest` locally. **Do not install wrangler globally** — the pinned local copy is
the one the build uses, and a mismatched global version is a common source of
"works for me" bugs.

Then create your database tables:

```bash
npm run db:migrate
```

A fresh database has no tables. Skip this and your first query fails with
`relation "posts" does not exist` — that error means "run the migration", not
"the code is wrong".

## 5. Verify before you write any code

All four must pass. If one fails, fix it before continuing — do not start
building on a broken toolchain.

```bash
node --version           # v22.x or newer
npx wrangler --version   # resolves the LOCAL wrangler from node_modules
npm run typecheck        # no TypeScript errors
npm test                 # the starter regression tests pass
```

Then start the local server and actually look at it:

```bash
npm run dev              # serves http://localhost:8787
```

Open that URL, or `curl -s http://localhost:8787/api/health`. You should get
`{"status":"ok"}`. Stop the server with Ctrl-C.

## 6. Now add your design

This is the step that makes the repo yours. Open [design/README.md](design/README.md)
— it walks through the two folders that were created for you:

- `design/reference/` — drop in mockups, a spec, screenshots, anything that
  shows what you're building. Nothing here is deployed; it's the brief.
- `design/assets/` — the images, video, audio your app actually serves. Add a
  file, run `npm run assets`, commit both, and push — it uploads automatically.

Once you've read it, delete this file (§8) and start building.

## 7. Common failures

| Symptom | Cause and fix |
| --- | --- |
| `command not found: npx` | Node did not install, or the terminal predates it. Reopen the terminal, re-check §1–3. |
| `Could not resolve "hono"` | `npm install` was never run, or was run in the wrong directory. Run it from the folder containing `package.json`. |
| `EACCES` / permission errors on install | You used `sudo npm install` at some point. Do not — fix ownership (`sudo chown -R $(whoami) ~/.npm`) and reinstall without sudo. |
| Port 8787 already in use | Another `wrangler dev` is running. Stop it, or `npx wrangler dev --port 8788`. |
| `npm ERR! peer dep` | Do not reach for `--force` or `--legacy-peer-deps`. Read which two packages disagree and align their versions. |
| `ECONNREFUSED ... 5432` | Postgres is not running. macOS: `brew services start postgresql@16`. Linux/WSL: `sudo service postgresql start`. Windows: check the PostgreSQL service is started. |
| `database "loop_dev" does not exist` | You installed Postgres but skipped `createdb loop_dev` in §1–3. |
| `password authentication failed for user "postgres"` | The password you set does not match `DATABASE_URL` in `wrangler.toml`. Change one to match the other. |
| `relation "posts" does not exist` | The database is empty. Run `npm run db:migrate`. |
| A file in `design/assets/` opens as a few lines of text like `version https://git-lfs.github.com/spec/v1` | Git LFS is not installed, or `git lfs install` was never run — see §1–3, then `git lfs pull`. |
| `npm run assets:check` fails with a size error | The named file (or the folder total) is over the limit. Compress it — see `design/README.md`. |

## 8. What you must NOT do

- **Do not run `npx wrangler deploy` or `wrangler login`.** This project has no
  cloud credentials and does not need them. Loop deploys for you when you
  push to `main`. See [AGENTS.md](AGENTS.md).
- **Do not commit `node_modules/`** or any `.env` file with real values.
- **Do not hand-edit `src/assets.ts`.** Run `npm run assets` instead — see
  `design/README.md`.
