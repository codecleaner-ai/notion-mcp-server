# How to sync your fork, `fork-source`, and local repo with the original project

This guide explains—in detail—how three places relate to each other and how to pull **the latest improvements from the original repository** ([makenotion/notion-mcp-server](https://github.com/makenotion/notion-mcp-server)) into **your own code**.

It assumes:

- **Original repo (upstream):** `https://github.com/makenotion/notion-mcp-server`
- **Your fork on GitHub:** for example `https://github.com/codecleaner-ai/notion-mcp-server` (replace with your fork if different)
- **Your laptop:** a normal Git clone of your fork

If your URLs differ, substitute them everywhere below.

---

## 1. Three copies of the project (mental model)

You always have **three layers**:

| Layer | What it is | Typical name in Git |
| ----- | ---------- | ------------------- |
| **A — Original on GitHub** | Notion’s official repo | You contact it using the remote named **`upstream`** |
| **B — Your fork on GitHub** | Your copy under your account | You contact it using the remote named **`origin`** |
| **C — Your computer** | Files you edit day to day | **Local branches** (e.g. `main`, `fork-source`) |

Nothing syncs by itself. You run Git commands to **move commits** between these layers.

---

## 2. Git remotes: `origin` vs `upstream`

After proper setup:

- **`origin`** → points at **your fork** (fetch/push your work to GitHub).
- **`upstream`** → points at **Notion’s repo** (fetch official updates; you usually **do not push** here unless you are a maintainer).

Check:

```bash
git remote -v
```

You want something like:

```text
origin    git@github.com:YOUR_USER/notion-mcp-server.git (fetch/push)
upstream  https://github.com/makenotion/notion-mcp-server.git (fetch/push)
```

### One-time setup: add `upstream` (if missing)

```bash
git remote add upstream https://github.com/makenotion/notion-mcp-server.git
```

If Git says the remote already exists, skip this.

---

## 3. What the `fork-source` branch is for

**Purpose:** `fork-source` is a **snapshot branch** meant to match **Notion’s `main`** as closely as possible—useful as a **clean reference** and as a **merge/rebase base** for your custom work.

- **`upstream/main`** — Notion’s default branch on GitHub (after you `git fetch upstream`, Git stores this as `upstream/main` locally).
- **`fork-source` (local)** — your branch that you reset to match `upstream/main` when you want an exact copy.
- **`origin/fork-source`** — the same branch on **your** GitHub fork (after you push).

**Important:** Your everyday changes usually live on **`main`** (or feature branches), **not** on `fork-source`. Treat `fork-source` as “vanilla upstream,” refreshed periodically.

---

## 4. Two different goals (do not confuse them)

### Goal A — Refresh `fork-source` so it *equals* Notion `main`

Use when you want **`fork-source`** (local **and** GitHub) to be an **exact copy** of **upstream `main`** at a point in time.

### Goal B — Bring Notion’s improvements *into* your real work (`main`, etc.)

Use when you want **your custom branch** to **include** new commits from Notion while keeping **your** commits and resolving conflicts if needed.

Most people need **both**: periodically Goal A (optional but clear), and Goal B whenever they develop.

---

## 5. Commands you will use repeatedly

### `git fetch upstream`

- **Downloads** new commits and branches from Notion’s repo into **your local Git database**.
- **Does not** change your working files or your current branch’s pointer by itself.
- Safe to run often.

### `git status`

- Shows which branch you are on and whether you have uncommitted changes.
- Before any reset or merge, you usually want a **clean** working tree (commit or stash first).

### `git checkout BRANCH`

- Switches your working directory to another branch (older Git) or use:

```bash
git switch BRANCH
```

---

## 6. Goal A — Make `fork-source` match `upstream/main` (local + GitHub)

### Step A1 — Update your local knowledge of Notion’s repo

```bash
git fetch upstream
```

**Why:** Without this, `upstream/main` on your machine may be **old**.

### Step A2 — Move to `fork-source`

```bash
git checkout fork-source
```

(or `git switch fork-source`)

### Step A3 — Point `fork-source` at the same commit as Notion `main`

```bash
git reset --hard upstream/main
```

**What this does (precisely):**

- Moves the **`fork-source` branch label** to the **exact commit** that `upstream/main` points to.
- Updates **files on disk** to match that commit.
- **Removes** from `fork-source` any commits that were **only** on `fork-source` and not ancestors of `upstream/main` (they may still be recoverable via `git reflog` for a while—don’t rely on that for important work).

**Warning:** Uncommitted changes on `fork-source` can be **lost**. Run `git status` first; commit or stash if needed.

### Step A4 — Publish `fork-source` to **your** GitHub fork

**First time** (branch did not exist on GitHub):

```bash
git push -u origin fork-source
```

**Later times**, after you already rewrote history with `reset --hard` (remote `fork-source` exists but history differs):

```bash
git push origin fork-source --force-with-lease
```

**Why `--force-with-lease`:** After a hard reset, your local history may **not** sit “on top of” the old `origin/fork-source`. A normal push is rejected. `--force-with-lease` updates the remote branch **only if** nobody else pushed unexpected commits since your last fetch—safer than `--force`.

**Why not `--force-with-lease` the first time:** If the branch **does not exist** on GitHub yet, a normal `git push -u origin fork-source` is enough.

### Step A5 — Verify

```bash
git log -1 --oneline
git rev-parse HEAD
git rev-parse upstream/main
```

The **same commit hash** from `git rev-parse HEAD` and `git rev-parse upstream/main` means local `fork-source` matches Notion `main`.

On GitHub: open your fork → branch dropdown → `fork-source` → confirm recent commits match Notion’s `main`.

---

## 7. Goal B — Import upstream improvements into **your** code (`main`)

This is how **your modifications** actually gain **Notion’s latest fixes and features**.

### Step B1 — Save or stash local work

If you have uncommitted edits:

- **Commit** them, or
- **Stash:** `git stash push -m "wip"` (and later `git stash pop`)

### Step B2 — Fetch latest from Notion

```bash
git fetch upstream
```

### Step B3 — Switch to your development branch

Typically:

```bash
git checkout main
```

(Use your real branch name if different.)

### Step B4 — Merge Notion `main` into your branch

```bash
git merge upstream/main
```

**What happens:**

- Git creates a **merge commit** that combines your branch history with Notion’s **unless** your branch was simply behind with no divergence (fast-forward).

**If Git reports conflicts:**

- Git marks conflicted files in the working tree.
- You edit files to resolve `<<<<<<<`, `=======`, `>>>>>>>`.
- Then:

```bash
git add PATH_TO_FILES...
git merge --continue
```

(Or `git commit` if Git asks you to finalize the merge.)

### Step B5 — Push your updated branch to **your fork**

```bash
git push origin main
```

**Why:** Your GitHub fork’s `main` now reflects **your code + Notion’s updates** (after conflict resolution).

### Alternative: rebase instead of merge (optional, advanced)

Some teams prefer a linear history:

```bash
git checkout main
git fetch upstream
git rebase upstream/main
git push origin main --force-with-lease
```

Rebase **rewrites** commits that were only on your branch; coordinating with collaborators matters. If unsure, **merge** (`git merge upstream/main`) is simpler and safer for shared branches.

---

## 8. Recommended routine (simple schedule)

1. **Weekly or before big work:** `git fetch upstream`
2. **When you want a clean reference:** Goal A (`fork-source` ← `upstream/main`, push with lease if needed)
3. **When you want real integration:** Goal B (`merge upstream/main` into `main`, push `origin main`)

---

## 9. Common problems (quick fixes)

### “`fatal: refusing to merge unrelated histories`” or endless conflicts

Usually means the branches were created independently. That is rare in a normal fork; seek help with exact command output.

### Push rejected: “non-fast-forward”

Often means **history diverged**. On **`fork-source`** after `reset --hard`, use **`git push origin fork-source --force-with-lease`**. On **`main`**, prefer **merge** or coordinated **rebase**, not blind force.

### Wrong branch

Many mistakes come from running merge/reset on the wrong branch. Always:

```bash
git branch --show-current
```

before destructive commands.

---

## 10. Summary table

| I want to… | Branch | Commands (outline) |
| ---------- | ------ | ------------------ |
| Update Notion data locally | any | `git fetch upstream` |
| Make `fork-source` = Notion `main` | `fork-source` | `fetch` → `checkout fork-source` → `reset --hard upstream/main` → `push` (with `-u` first time or `--force-with-lease` later) |
| Put Notion’s changes into my work | `main` (or yours) | `fetch` → `checkout main` → `merge upstream/main` → resolve → `push origin main` |

---

## 11. Safety checklist (before `reset --hard` or `--force`)

- [ ] I am on the **correct** branch (`git branch --show-current`).
- [ ] I have **no uncommitted work** I care about on this branch—or it is committed/stashed.
- [ ] I understand **`fork-source`** may be **force-pushed** and should not be treated as a shared team branch unless everyone agrees.

Following this document keeps **your laptop**, **your GitHub fork**, and **`fork-source`** aligned with a clear, repeatable path for importing improvements from the **original** repository into **your** codebase.
