# REA deployment scripts

Bash scripts for deploying and maintaining the REA (Relative Ear-training)
Django app on a fresh Debian 13 VPS, with code shipped from GitHub and the
**large exercise data kept off GitHub** in a persistent on-server directory.

## What lives where

| Path on server         | Purpose                                              | In git? |
|------------------------|------------------------------------------------------|---------|
| `/opt/rea5`            | Git checkout — the app code                          | yes     |
| `/opt/rea5/.venv`      | Python virtualenv                                    | no      |
| `/opt/rea-data`        | Persistent data: `relative/`, `absolute/`, `db.sqlite3` | no  |
| `/opt/rea-backups`     | Backups produced by `backup.sh`                      | no      |
| `/opt/rea5/.env`       | Secret key + settings (generated)                    | no      |

The `relative/`, `absolute/` directories and `rea/db.sqlite3` are **symlinked**
from `/opt/rea-data` into the checkout, so `git pull` / `update.sh` can freely
overwrite the repo without ever touching the database or the JSON exercise
libraries. They are ignored by `.gitignore` and never committed.

## SSH access — root is *not* required

The server-side scripts (`init_vps.sh`, `deploy.sh`, …) need **root
privileges**, but you do **not** need to SSH in as `root` (many VPS providers
disable root SSH login). You can SSH as any normal user that can become root
via `sudo`. `bootstrap_local.sh` handles all three cases automatically:

| SSH user            | What happens                                                                 |
|---------------------|------------------------------------------------------------------------------|
| `root`              | Commands run directly, no sudo.                                              |
| a sudoer, already NOPASSWD | Commands run via `sudo`.                                               |
| a sudoer with a password | The script provisions passwordless sudo **once** (writes `/etc/sudoers.d/rea-bootstrap`), prompting for the password on your local terminal — or pass it with `--sudo-password`. The rest of the run is then non-interactive. |

So a typical first run with a non-root user is simply:

```bash
bash scripts/bootstrap_local.sh \
    --host youruser@203.0.113.10 \
    --domain rea.example.com \
    --repo https://github.com/narevent/REA.git
```

…enter the sudo password when prompted, and it does everything. To avoid the
prompt (e.g. in automation), add `--sudo-password 'your-sudo-password'`. If you
don't want the script touching sudoers, pass `--no-setup-sudo` (then the SSH
user must already have passwordless sudo).

## Scripts

| Script              | When to run            | What it does |
|---------------------|------------------------|--------------|
| `bootstrap_local.sh`| **once**, from *your* machine | Orchestrates the entire first-time setup over SSH: local pre-flight, runs `init_vps.sh` on the VPS, rsyncs the JSON data + optional DB, runs `deploy.sh`, optional Let's Encrypt HTTPS |
| `init_vps.sh`       | (called by bootstrap)  | Installs deps, creates service user, clones repo, builds venv, writes `.env`, sets up Gunicorn + Nginx, opens the firewall |
| `deploy.sh`    | after init / big changes | Pulls code, installs deps, migrates, collects static, **imports all JSON data**, restarts services |
| `update.sh`    | after each `git push`  | Pulls code, reinstalls deps only if `requirements.txt` changed, migrates, collects static, restarts (no re-import) |
| `backup.sh`    | cron / manually        | Tarballs the DB + both JSON data dirs + `.env` into `/opt/rea-backups`, rotates old copies |
| `restore.sh`   | disaster recovery      | Stops the app, restores a backup tarball, re-links, restarts |
| `config.sh`    | sourced by all of the above | Centralised, overridable settings |

## First-time setup

The easiest path is the local orchestrator — run it from your machine and it
does everything over SSH (steps 1–5 below). **You can SSH as root or any sudo
user** (see [SSH access](#ssh-access--root-is-not-required) above):

```bash
bash scripts/bootstrap_local.sh \
    --host youruser@203.0.113.10 \
    --domain rea.example.com \
    --repo https://github.com/narevent/REA.git
```

Add `--with-db` to also ship your local `rea/db.sqlite3`, and `--ssl` to
provision HTTPS with certbot. Run `bash scripts/bootstrap_local.sh --help` for
all flags (sudo password, custom data dir, branch, ssh key, etc.).

If you prefer to run the steps manually, here they are:

1. Push your code to GitHub (make sure `relative/`, `absolute/`, `rea/db.sqlite3`
   and `rea/static/` are **not** committed — `.gitignore` already excludes them).
2. On the fresh Debian 13 VPS, as root (or any sudoer — use `sudo`):

   ```bash
   sudo apt-get update && sudo apt-get install -y git
   git clone https://github.com/you/rea5.git /tmp/rea5
   cd /tmp/rea5
   sudo REA_REPO_URL=https://github.com/you/rea5.git \
        REA_DOMAIN=rea.example.com \
        bash scripts/init_vps.sh
   ```

3. Copy your exercise JSON onto the server into the persistent data dir
   (run as root, or as a sudoer with `sudo rsync`/`sudo scp`):

   ```bash
   # from your local machine, as root (or adjust paths + sudo on the server)
   rsync -av relative/ youruser@vps:/tmp/relative/
   rsync -av absolute/ youruser@vps:/tmp/absolute/
   # optionally ship an existing database
   scp rea/db.sqlite3 youruser@vps:/tmp/db.sqlite3
   # then on the server:
   sudo install -d -o rea -g rea /opt/rea-data && \
   sudo mv /tmp/relative /tmp/absolute /opt/rea-data/ && \
   sudo mv /tmp/db.sqlite3 /opt/rea-data/db.sqlite3 && \
   sudo chown -R rea:rea /opt/rea-data
   ```

4. Deploy (as root or a sudoer):

   ```bash
   sudo bash /opt/rea5/scripts/deploy.sh
   ```

5. (recommended) HTTPS via Let's Encrypt:

   ```bash
   sudo apt-get install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d rea.example.com
   ```

## Routine updates

After pushing to `main` on GitHub (run from your machine, as any sudo user):

```bash
ssh youruser@vps 'sudo bash /opt/rea5/scripts/update.sh'
```

## Backups

Run from your machine (as any sudo user), or directly on the server:

```bash
ssh youruser@vps 'sudo bash /opt/rea5/scripts/backup.sh'                                       # keep last 14
ssh youruser@vps 'sudo KEEP=30 bash /opt/rea5/scripts/backup.sh'                               # keep 30
ssh youruser@vps 'sudo bash /opt/rea5/scripts/restore.sh'                                      # restore latest
ssh youruser@vps 'sudo bash /opt/rea5/scripts/restore.sh /opt/rea-backups/rea-backup-20260717T120000Z.tar.gz'
```

A recommended cron entry (root's crontab — `sudo crontab -e`):

```cron
# daily 3am backup
0 3 * * * /opt/rea5/scripts/backup.sh >> /opt/rea5/rea/logs/backup.log 2>&1
```

## Configuration overrides

Every variable in `config.sh` can be overridden via the environment when you
invoke a script. The commonly-set ones:

| Variable        | Default                  | Notes |
|-----------------|--------------------------|-------|
| `REA_REPO_URL`  | *(required)*             | HTTPS URL recommended for init |
| `REA_DOMAIN`    | `localhost`              | Nginx `server_name` |
| `REA_BRANCH`    | `main`                   | branch/tag tracked by update.sh |
| `APP_ROOT`      | `/opt/rea5`              | git checkout path |
| `DATA_ROOT`     | `/opt/rea-data`          | persistent data path |
| `BACKUP_DIR`    | `/opt/rea-backups`       | backup destination |
| `REA_PORT`      | `8000`                   | gunicorn bind port |
| `GUNICORN_WORKERS` | `3`                   | gunicorn worker count |
| `KEEP`          | `14`                     | backup retention count |
| `SERVICE_USER`  | `rea`                    | system user running the app |